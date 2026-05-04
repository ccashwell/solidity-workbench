import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const execFileAsync = promisify(execFile);
import {
  parseTraceJson,
  TraceCursor,
  type TraceStep,
  parseSourceMap,
  buildPcToInstructionIndex,
  resolveSourcePosition,
  type SourceMapEntry,
  parseForgeArtifact,
  type ForgeArtifact,
  LineIndex,
  parseStorageLayout,
  lookupSlot,
  type StorageLayout,
  disassemble,
  opcodeMnemonic,
  type Instruction,
  extractFunctions,
  findEnclosingFunction,
  type AstFunction,
} from "@solidity-workbench/common";

/**
 * Solidity Workbench Debug Adapter Protocol (DAP) adapter.
 *
 * Implementation notes:
 *
 * - This is an *inline* DAP — the adapter runs in the extension
 *   host's own process via `DebugAdapterInlineImplementation`. We
 *   speak the DAP wire format directly through the `handleMessage`
 *   / `onDidSendMessage` channel rather than spawning a child
 *   process and tunneling stdio. Inline keeps cold-start fast and
 *   sidesteps a packaging dependency on `@vscode/debugadapter`.
 *
 * - DAP is a request/response protocol. Each incoming message
 *   carries a `seq`; each response we send back carries a
 *   `request_seq` that echoes it. We assign our own outgoing `seq`
 *   from a monotonic counter.
 *
 * - For unimplemented commands we send a `success: false` response
 *   with a clear "not yet implemented" message instead of silently
 *   dropping the request — VSCode otherwise blocks waiting on
 *   responses that never arrive.
 *
 * Delivery stages (see PRODUCTION_GAPS.md > "DAP debugger"):
 *
 * - Stage 1 — scaffold (DONE).
 * - Stage 2 — trace ingestion (DONE).
 * - Stage 3 — source-position resolution + step semantics +
 *   setBreakpoints (DONE).
 * - Stage 4 — internal call stack + Stack / Memory / Storage scopes (DONE).
 * - Stage 5 — disassembly + storage pretty-print + evaluate
 *   (THIS REVISION). The adapter now:
 *     * Loads the artifact's `storageLayout` and pretty-prints
 *       storage entries with their declared names (`count` instead
 *       of just `slot 0x00`), respecting packed-slot offsets.
 *     * Disassembles the deployed bytecode at load time and
 *       answers DAP `disassemble` requests by slicing windows out
 *       of the linear listing.
 *     * Evaluates simple expressions on hover: `stack[N]`,
 *       `memory[0xN]`, `storage[0xN]`, and bare state-variable
 *       names that resolve through the storage layout.
 *
 * Local variable decoding (mapping AST identifiers to stack
 * positions) requires the solc AST and is intentionally left for
 * a follow-up — the present adapter is functional without it.
 */
export class SolidityDapAdapter implements vscode.DebugAdapter {
  private readonly _onDidSendMessage = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  readonly onDidSendMessage = this._onDidSendMessage.event;

  private seq = 0;
  /** Loaded once during `launch` when the config supplies a `traceFile`. */
  private cursor: TraceCursor | null = null;
  /**
   * The entry contract — the one the user is debugging directly,
   * whose deployment runs at trace depth 1. Loaded from the
   * launch config's `artifact` field.
   */
  private entryContext: ContractContext | null = null;
  /**
   * Auxiliary contracts loaded from the launch config's `contracts`
   * array. Keyed by lowercased 0x-prefixed address so trace CALL
   * targets (which solc / Anvil emit as 32-byte zero-padded hex)
   * can be matched after a `lower()`.
   */
  private auxContexts = new Map<string, ContractContext>();
  /**
   * Per-step active context, indexed by cursor step index. Entry
   * `[i]` is the contract whose bytecode is executing at step `i`,
   * or `null` when the inner-call address didn't match any loaded
   * contract. Computed once after both `cursor` and contract
   * contexts are loaded.
   */
  private contextStream: (ContractContext | null)[] = [];
  /**
   * Active breakpoints, keyed by normalised absolute file path. The
   * inner `Set<number>` holds 0-based line indexes (DAP's 1-based
   * lines are converted at the request boundary).
   */
  private breakpoints = new Map<string, Set<number>>();
  /**
   * Variables-reference allocation table. Each scope (and any nested
   * structured variable) is assigned an integer ID via
   * `allocateVariableRef`; VSCode echoes that ID back in subsequent
   * `variables` requests, which we resolve through this map. Cleared
   * on every step so stale references can't leak across cursor
   * positions (the data they describe — stack / memory / storage —
   * has changed).
   */
  private variableRefs = new Map<number, () => DapVariable[]>();
  private nextVariableRef = 1000;

  handleMessage(message: vscode.DebugProtocolMessage): void {
    const msg = message as DapRequest;
    if (msg.type !== "request") return;

    switch (msg.command) {
      case "initialize":
        return this.handleInitialize(msg);
      case "launch":
        // `handleLaunch` is async — fire-and-forget; it sends its
        // own response/events.
        void this.handleLaunch(msg);
        return;
      case "configurationDone":
        return this.respond(msg, true);
      case "threads":
        return this.handleThreads(msg);
      case "stackTrace":
        return this.handleStackTrace(msg);
      case "scopes":
        return this.handleScopes(msg);
      case "variables":
        return this.handleVariables(msg);
      case "setBreakpoints":
        return this.handleSetBreakpoints(msg);
      case "loadedSources":
        return this.handleLoadedSources(msg);
      case "continue":
        return this.handleContinue(msg);
      case "next":
      case "stepIn":
        return this.handleStep(msg);
      case "stepOut":
        return this.handleStepOut(msg);
      case "pause":
        return this.respond(msg, true);
      case "evaluate":
        return this.handleEvaluate(msg);
      case "disassemble":
        return this.handleDisassemble(msg);
      case "disconnect":
      case "terminate":
        return this.handleTerminate(msg);
      default:
        return this.respond(msg, false, undefined, `Not yet implemented: ${msg.command}`);
    }
  }

  // ── DAP request handlers ──────────────────────────────────────────

  private handleInitialize(msg: DapRequest): void {
    this.respond(msg, true, {
      supportsConfigurationDoneRequest: true,
      supportsTerminateRequest: true,
      supportsRestartRequest: false,
      supportsStepBack: false,
      supportsBreakpointLocationsRequest: false,
      supportsConditionalBreakpoints: false,
      supportsHitConditionalBreakpoints: false,
      supportsEvaluateForHovers: true,
      supportsSetVariable: false,
      supportsExceptionInfoRequest: false,
      supportsValueFormattingOptions: false,
      supportsModulesRequest: false,
      // Stage 3 lights this up — we enumerate the artifact's
      // source list under `loadedSources`.
      supportsLoadedSourcesRequest: true,
      supportsLogPoints: false,
      supportsTerminateThreadsRequest: false,
      supportsSetExpression: false,
      supportsDataBreakpoints: false,
      supportsReadMemoryRequest: false,
      supportsWriteMemoryRequest: false,
      supportsDisassembleRequest: true,
      supportsCancelRequest: false,
      supportsSteppingGranularity: false,
      supportsInstructionBreakpoints: false,
      supportsExceptionFilterOptions: false,
    });
    // `initialized` lets VSCode flush queued setBreakpoints /
    // setExceptionBreakpoints requests, then issue
    // `configurationDone`.
    this.fireEvent("initialized");
  }

  private async handleLaunch(msg: DapRequest): Promise<void> {
    const args = (msg.arguments ?? {}) as LaunchArguments;

    if (args.artifact) {
      const error = this.loadArtifact(args.artifact, args.projectRoot);
      if (error) {
        this.respond(msg, true);
        this.fireEvent("output", {
          category: "stderr",
          output: `Failed to load artifact '${args.artifact}': ${error}\n`,
        });
        this.fireEvent("terminated");
        return;
      }
    }

    if (Array.isArray(args.contracts)) {
      for (const entry of args.contracts) {
        const error = this.loadAuxContract(entry, args.projectRoot);
        if (error) {
          // Aux contract failures are non-fatal — the entry contract
          // alone still gives a useful debug session. Surface the
          // error in the output channel so the user knows.
          this.fireEvent("output", {
            category: "stderr",
            output: `Failed to load aux contract '${entry.address}': ${error}\n`,
          });
        }
      }
    }

    // Trace source: prefer `traceFile` when set; otherwise fetch live
    // via `cast run --json` if `txHash` (+ optional `rpcUrl`) is set.
    if (args.traceFile) {
      const error = this.loadTraceFile(args.traceFile);
      if (error) {
        this.respond(msg, true);
        this.fireEvent("output", {
          category: "stderr",
          output: `Failed to load trace from '${args.traceFile}': ${error}\n`,
        });
        this.fireEvent("terminated");
        return;
      }
    } else if (args.txHash) {
      const error = await this.loadTraceFromCastRun(args);
      if (error) {
        this.respond(msg, true);
        this.fireEvent("output", {
          category: "stderr",
          output: `Failed to fetch trace via cast run: ${error}\n`,
        });
        this.fireEvent("terminated");
        return;
      }
    }

    // Now that both trace + contracts are settled, precompute the
    // per-step active context so subsequent `stackTrace` /
    // `scopes` requests are O(1) lookups.
    this.rebuildContextStream();

    this.respond(msg, true);
    this.fireEvent("stopped", {
      reason: "entry",
      threadId: 1,
      allThreadsStopped: true,
      description: this.summariseLoadState(),
    });
  }

  /**
   * Walk the trace once, tracking call depth and the contract
   * address active at each depth, to produce a per-step
   * `(ContractContext | null)[]`. Caller-side details:
   *
   * - The entry contract is always at depth 1 (treated as `null`
   *   address since we don't know what the test deployed it as).
   * - On CALL / STATICCALL / DELEGATECALL we capture the target
   *   address from the stack just before the opcode runs (the
   *   step's `stack` is the EVM stack BEFORE `op` executes). The
   *   address is at `stack[length - 2]` per the EVM convention
   *   that operands are popped from the top.
   * - On CREATE / CREATE2, the new contract's address isn't
   *   known until after deployment; we record `null` for that
   *   depth (frame falls back to label-only).
   * - On RETURN / REVERT / STOP at a deeper depth, the stack
   *   snaps back to the caller's depth — the per-depth
   *   ContractContext is dropped naturally.
   */
  private rebuildContextStream(): void {
    if (!this.cursor) {
      this.contextStream = [];
      return;
    }
    const steps = this.cursor.steps;
    const result: (ContractContext | null)[] = new Array(steps.length).fill(null);
    const stack: (ContractContext | null)[] = [this.entryContext];
    let pendingCallContext: ContractContext | null = null;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      while (stack.length > step.depth) stack.pop();
      while (stack.length < step.depth) {
        stack.push(pendingCallContext);
        pendingCallContext = null;
      }
      result[i] = stack[stack.length - 1];

      if (
        step.op === "CALL" ||
        step.op === "STATICCALL" ||
        step.op === "DELEGATECALL" ||
        step.op === "CALLCODE"
      ) {
        const addr = readAddressFromStack(step);
        pendingCallContext = addr ? this.auxContexts.get(addr) ?? null : null;
      } else if (step.op === "CREATE" || step.op === "CREATE2") {
        // Address not known yet; the next depth gets null.
        pendingCallContext = null;
      }
    }
    this.contextStream = result;
  }

  /** Active contract for the cursor's current step (or the entry contract as fallback). */
  private activeContext(): ContractContext | null {
    if (!this.cursor) return this.entryContext;
    const idx = this.cursor.index;
    if (idx >= 0 && idx < this.contextStream.length) {
      return this.contextStream[idx] ?? null;
    }
    return this.entryContext;
  }

  private handleThreads(msg: DapRequest): void {
    this.respond(msg, true, { threads: [{ id: 1, name: "EVM" }] });
  }

  private handleStackTrace(msg: DapRequest): void {
    const step = this.cursor?.current;
    if (!step) {
      this.respond(msg, true, {
        stackFrames: [
          {
            id: 0,
            name: "(no trace loaded — supply `traceFile` in launch.json)",
            line: 0,
            column: 0,
            presentationHint: "label",
          },
        ],
        totalFrames: 1,
      });
      return;
    }

    const cursor = this.cursor!;
    const frameLabel = `${step.op} @ pc=${step.pc} (depth ${step.depth}, gas ${step.gas})`;

    // Stage 4: build the internal Solidity call stack from
    // `jump: "i"` / `jump: "o"` markers on every step up to and
    // including the cursor. The DAP convention is topmost-first —
    // so the current frame is index 0.
    const internalFrames = this.buildCallStack();
    if (internalFrames.length > 0) {
      const dapFrames = internalFrames.map((f, i) => ({
        id: i,
        name: f.name,
        line: f.line + 1,
        column: f.character + 1,
        source: { path: f.filePath, name: path.basename(f.filePath) },
      }));
      // Top frame's label gets the opcode context appended so the
      // user can read PC + opcode without leaving the panel.
      dapFrames[0].name += `  [${frameLabel}]`;
      this.respond(msg, true, {
        stackFrames: dapFrames,
        totalFrames: dapFrames.length,
      });
      void internalFrames[0];
      return;
    }

    // No source frames — either no contract context loaded, or the
    // current step is at depth > 1 / on a generated opcode. Return
    // a label-only frame so the panel isn't blank.
    this.respond(msg, true, {
      stackFrames: [
        {
          id: cursor.index,
          name: frameLabel + (this.entryContext ? " — no source for this depth/opcode" : ""),
          line: 0,
          column: 0,
          presentationHint: "label",
        },
      ],
      totalFrames: 1,
    });
  }

  private handleScopes(msg: DapRequest): void {
    this.variableRefs.clear();
    const step = this.cursor?.current;
    if (!step) {
      this.respond(msg, true, { scopes: [] });
      return;
    }
    const stackRef = this.allocateVariableRef(() => this.evmStackVariables(step));
    const memoryRef = this.allocateVariableRef(() => this.evmMemoryVariables(step));
    const storageRef = this.allocateVariableRef(() => this.evmStorageVariables(step));

    const scopes: Record<string, unknown>[] = [];

    // Source-level locals scope (stretch-2). Only emitted when we
    // can map the current step back to a function in the AST.
    const enclosing = this.currentEnclosingFunction(step);
    if (enclosing) {
      // Find the topmost call-stack frame that matches this
      // function so the locals scope can read live values from
      // its `entryStackLen` and `localStackPositions`.
      const callStack = this.buildCallStack();
      const frame = callStack.find((f) => f.fn === enclosing.fn) ?? null;
      const localsRef = this.allocateVariableRef(() =>
        this.sourceLocalsVariables(enclosing.fn, enclosing.byteOffset, step, frame),
      );
      scopes.push({
        name: `Source-level locals (${enclosing.fn.name || "<anonymous>"})`,
        variablesReference: localsRef,
        expensive: false,
        presentationHint: "locals",
      });
    }

    scopes.push(
      {
        name: `Stack (${step.stack.length} item${step.stack.length === 1 ? "" : "s"})`,
        variablesReference: stackRef,
        expensive: false,
        presentationHint: "registers",
      },
      {
        name: `Memory (${step.memory.length} word${step.memory.length === 1 ? "" : "s"})`,
        variablesReference: memoryRef,
        expensive: false,
      },
      {
        name: `Storage (${Object.keys(step.storage).length} entries)`,
        variablesReference: storageRef,
        expensive: false,
      },
    );

    this.respond(msg, true, { scopes });
  }

  private handleVariables(msg: DapRequest): void {
    const args = msg.arguments as { variablesReference?: number } | undefined;
    if (!args || typeof args.variablesReference !== "number") {
      this.respond(msg, true, { variables: [] });
      return;
    }
    const getter = this.variableRefs.get(args.variablesReference);
    if (!getter) {
      this.respond(msg, true, { variables: [] });
      return;
    }
    this.respond(msg, true, { variables: getter() });
  }

  private handleSetBreakpoints(msg: DapRequest): void {
    const args = msg.arguments as SetBreakpointsArgs | undefined;
    const requestedBps = args?.breakpoints ?? [];
    if (!args?.source.path) {
      this.respond(msg, true, { breakpoints: [] });
      return;
    }
    const normalisedPath = path.normalize(args.source.path);
    const lines = new Set<number>(requestedBps.map((bp) => bp.line - 1)); // DAP -> 0-based
    if (lines.size === 0) {
      this.breakpoints.delete(normalisedPath);
    } else {
      this.breakpoints.set(normalisedPath, lines);
    }
    this.respond(msg, true, {
      breakpoints: requestedBps.map((bp) => ({ verified: true, line: bp.line })),
    });
  }

  private handleLoadedSources(msg: DapRequest): void {
    // Union the entry contract's sources with all aux contracts'
    // so the user sees every loaded contract's source files.
    const seen = new Set<string>();
    const sources: { name: string; path: string }[] = [];
    const collect = (ctx: ContractContext | null): void => {
      if (!ctx) return;
      for (const s of ctx.sources) {
        if (seen.has(s.absolutePath)) continue;
        seen.add(s.absolutePath);
        sources.push({ name: path.basename(s.absolutePath), path: s.absolutePath });
      }
    };
    collect(this.entryContext);
    for (const ctx of this.auxContexts.values()) collect(ctx);
    this.respond(msg, true, { sources });
  }

  private handleContinue(msg: DapRequest): void {
    if (!this.cursor) {
      this.respond(msg, true, { allThreadsContinued: true });
      this.fireEvent("terminated");
      return;
    }

    while (this.cursor.next()) {
      const source = this.currentLine();
      if (source && this.matchesBreakpoint(source)) {
        this.respond(msg, true, { allThreadsContinued: true });
        this.fireEvent("stopped", {
          reason: "breakpoint",
          threadId: 1,
          allThreadsStopped: true,
        });
        return;
      }
    }
    // Trace exhausted without hitting a breakpoint.
    this.respond(msg, true, { allThreadsContinued: true });
    this.fireEvent("terminated");
  }

  private handleStep(msg: DapRequest): void {
    if (!this.cursor) {
      this.respond(msg, true);
      this.fireEvent("terminated");
      return;
    }
    // Source-aware step: advance until the source position changes
    // OR we hit a breakpoint OR the trace ends. When no contract
    // context is loaded at all, fall back to single-step behaviour
    // from stage 2 so the user can still walk opcode-by-opcode.
    if (!this.entryContext && this.auxContexts.size === 0) {
      if (!this.cursor.next() || this.cursor.isAtEnd) {
        this.respond(msg, true);
        this.fireEvent("terminated");
        return;
      }
      this.respond(msg, true);
      this.fireEvent("stopped", { reason: "step", threadId: 1, allThreadsStopped: true });
      return;
    }

    const initial = this.currentLine();
    while (this.cursor.next()) {
      const here = this.currentLine();
      if (!here) continue; // generated opcodes — keep walking
      if (this.matchesBreakpoint(here)) {
        this.respond(msg, true);
        this.fireEvent("stopped", { reason: "breakpoint", threadId: 1, allThreadsStopped: true });
        return;
      }
      const lineChanged =
        !initial || here.filePath !== initial.filePath || here.line !== initial.line;
      if (lineChanged) {
        this.respond(msg, true);
        this.fireEvent("stopped", { reason: "step", threadId: 1, allThreadsStopped: true });
        return;
      }
    }
    this.respond(msg, true);
    this.fireEvent("terminated");
  }

  private handleStepOut(msg: DapRequest): void {
    if (!this.cursor || !this.cursor.current) {
      this.respond(msg, true);
      this.fireEvent("terminated");
      return;
    }
    // Step-out: run forward until the call depth drops below the
    // current frame's depth. Falls back to "continue" semantics
    // when the cursor is already at the top frame.
    const targetDepth = this.cursor.current.depth - 1;
    if (targetDepth <= 0) {
      this.handleContinue(msg);
      return;
    }
    while (this.cursor.next()) {
      const cur = this.cursor.current;
      if (!cur) break;
      if (cur.depth <= targetDepth) {
        this.respond(msg, true);
        this.fireEvent("stopped", { reason: "step", threadId: 1, allThreadsStopped: true });
        return;
      }
    }
    this.respond(msg, true);
    this.fireEvent("terminated");
  }

  private handleEvaluate(msg: DapRequest): void {
    const args = msg.arguments as EvaluateArgs | undefined;
    const expression = args?.expression?.trim();
    if (!expression) {
      this.respond(msg, false, undefined, "Empty expression");
      return;
    }
    const step = this.cursor?.current;
    if (!step) {
      this.respond(msg, false, undefined, "No active trace step");
      return;
    }
    const result = this.evaluateExpression(expression, step);
    if (result === null) {
      this.respond(msg, false, undefined, `Cannot evaluate '${expression}'`);
      return;
    }
    this.respond(msg, true, { result, variablesReference: 0 });
  }

  /**
   * Resolve a tiny expression language used by hover / Watch:
   *
   *   - `stack[N]`            — Nth entry from the top of the EVM stack
   *   - `memory[0xN]`         — 32-byte word starting at byte offset N
   *   - `storage[<slot>]`     — value at the given storage slot
   *   - `<identifier>`        — bare state-variable name resolved
   *                             through the contract's storage layout
   *
   * Returns the formatted value as a hex string, or `null` when the
   * expression doesn't match any supported form. We intentionally
   * keep this narrow — broader expression evaluation needs a
   * Solidity expression parser, which is out of scope for the DAP.
   */
  private evaluateExpression(expression: string, step: TraceStep): string | null {
    const indexMatch = /^(stack|memory|storage)\[\s*(.+?)\s*\]$/.exec(expression);
    if (indexMatch) {
      const kind = indexMatch[1] as "stack" | "memory" | "storage";
      const indexExpr = indexMatch[2];
      const idx = parseExpressionNumber(indexExpr);
      if (idx === null) return null;
      if (kind === "stack") {
        const reversed = [...step.stack].reverse();
        return reversed[Number(idx)] ? prefixHex(reversed[Number(idx)]) : null;
      }
      if (kind === "memory") {
        const wordIdx = Number(idx) >> 5; // / 32
        const word = step.memory[wordIdx];
        return word ? prefixHex(word) : null;
      }
      // storage
      const slotKey = idx.toString();
      const value = step.storage[slotKey] ?? step.storage[`0x${idx.toString(16)}`];
      return value ? prefixHex(value) : null;
    }
    // Bare identifier: try the in-scope locals / parameters first,
    // then the active contract's storage layout. This ordering
    // matches Solidity's lexical resolution — a parameter named
    // `count` shadows a state variable of the same name.
    if (/^[A-Za-z_]\w*$/.test(expression)) {
      // 1. In-scope parameter or local on the topmost call frame.
      const frame = this.buildCallStack().find((f) => !!f.fn) ?? null;
      if (frame?.fn) {
        const paramIdx = frame.fn.parameters.findIndex((p) => p.name === expression);
        if (paramIdx >= 0) {
          const slot = frame.entryStackLen - frame.fn.parameters.length + paramIdx;
          if (slot >= 0 && slot < step.stack.length) {
            return prefixHex(step.stack[slot]);
          }
          return "(parameter consumed by callee)";
        }
        const localSlot = frame.localStackPositions.get(expression);
        if (localSlot !== undefined) {
          if (localSlot < step.stack.length) return prefixHex(step.stack[localSlot]);
          return "(local consumed)";
        }
      }
      // 2. State variable via the active contract's storage layout.
      const ctx = this.activeContext();
      if (ctx?.storageLayout) {
        const match = ctx.storageLayout.entries.find((e) => e.label === expression);
        if (match) {
          const slotKey = match.slot.toString();
          const value =
            step.storage[slotKey] ?? step.storage[`0x${match.slot.toString(16)}`];
          if (value !== undefined) return prefixHex(value);
          return "(slot has no observed write — value unchanged from before this trace)";
        }
      }
    }
    return null;
  }

  private handleDisassemble(msg: DapRequest): void {
    const args = msg.arguments as DisassembleArgs | undefined;
    const ctx = this.activeContext();
    if (!args || !ctx) {
      this.respond(msg, false, undefined, "No contract loaded — supply `artifact` in launch.json");
      return;
    }
    const all = ctx.disassembly;
    if (all.length === 0) {
      this.respond(msg, true, { instructions: [] });
      return;
    }
    // VSCode hands us `memoryReference` (typically the deployed
    // bytecode origin "0x" or a section anchor we never set) plus
    // an `offset` byte count and a target instructionCount. The
    // simplest correct mapping for an inline EVM is "treat
    // memoryReference as the deployed bytecode and offset as PC".
    const startPc = (args.offset ?? 0) + parseAddress(args.memoryReference ?? "0x0");
    const want = args.instructionCount ?? 16;

    let startIdx = all.findIndex((i) => i.pc >= startPc);
    if (startIdx < 0) startIdx = all.length;
    let endIdx = startIdx + want;
    if (endIdx > all.length) endIdx = all.length;

    const window = all.slice(startIdx, endIdx);
    this.respond(msg, true, {
      instructions: window.map((inst) => ({
        address: `0x${inst.pc.toString(16).padStart(4, "0")}`,
        instruction: formatInstruction(inst),
        instructionBytes: instructionBytes(inst),
      })),
    });
  }

  private handleTerminate(msg: DapRequest): void {
    this.respond(msg, true);
    this.fireEvent("terminated");
    this.fireEvent("exited", { exitCode: 0 });
  }

  // ── Call stack & scopes ──────────────────────────────────────────

  /**
   * Walk the trace from index 0 through the cursor's current step
   * to build a full multi-depth call stack. For each EVM call
   * depth, an independent internal-frame stack is tracked: pushed
   * on `jump: "i"`, popped on `jump: "o"`. When the trace crosses
   * an EVM CALL / STATICCALL / DELEGATECALL / CREATE boundary, the
   * outer depth's frame stack is "paused" and a fresh stack starts
   * at the inner depth, using the inner contract's
   * `ContractContext` if loaded.
   *
   * The flattened result is ordered topmost-first per the DAP
   * convention — index 0 is the innermost function at the deepest
   * active depth, then walking up through internal frames at the
   * same depth, then over to the outer depth's topmost-internal
   * frame, and so on. Each frame additionally carries the trace
   * step index and stack length at function entry, which the
   * Source-level locals scope uses to read live parameter values.
   *
   * Defensive against unbalanced `jump: "o"` (which an exception
   * unwind can produce): the bottom frame of each depth's stack
   * is never popped.
   */
  private buildCallStack(): CallStackFrame[] {
    if (!this.cursor) return [];
    const cur = this.cursor.current;
    if (!cur) return [];
    const cursorIndex = this.cursor.index;

    // depthStack[d-1] is the internal-frame stack at EVM depth d.
    const depthStack: CallStackFrame[][] = [];
    const ensureDepth = (depth: number, ctx: ContractContext | null, step: TraceStep): void => {
      while (depthStack.length > depth) depthStack.pop();
      while (depthStack.length < depth) {
        // New depth: seed with a synthetic "(entry)" frame so the
        // stack always has at least one item per active depth.
        const seed: CallStackFrame = {
          name: depthStack.length === 0 ? "(entry)" : `(depth ${depthStack.length + 1} entry)`,
          filePath: "",
          line: 0,
          character: 0,
          entryStepIdx: step ? this.cursor!.steps.indexOf(step) : -1,
          entryStackLen: step?.stack.length ?? 0,
          fn: null,
          ctx,
          localStackPositions: new Map(),
        };
        depthStack.push([seed]);
      }
    };

    for (let i = 0; i <= cursorIndex && i < this.cursor.length; i++) {
      const step = this.cursor.steps[i];
      ensureDepth(step.depth, this.contextStream[i] ?? null, step);

      const ctx = this.contextStream[i] ?? null;
      const frames = depthStack[depthStack.length - 1];
      if (!ctx) continue;

      const entry = resolveSourcePosition(step.pc, ctx.pcMap, ctx.sourceMap);
      if (!entry) continue;
      const source = ctx.sources[entry.fileIndex];
      if (!source?.lineIndex) continue;
      const pos = source.lineIndex.positionAt(entry.start);

      if (frames.length === 1 && frames[0].filePath === "") {
        // Seed the depth's first frame with the first resolvable
        // source position. Gives the "(entry)" / "(depth N entry)"
        // frame a real source pointer and — when the AST resolves
        // the enclosing function — a real Solidity name to show
        // in the Call Stack panel.
        frames[0].filePath = source.absolutePath;
        frames[0].line = pos.line;
        frames[0].character = pos.character;
        frames[0].fn = findEnclosingFunction(ctx.functions, entry.fileIndex, entry.start);
        frames[0].entryStackLen = step.stack.length;
        frames[0].entryStepIdx = i;
        if (frames[0].fn?.name) {
          frames[0].name = frames[0].fn.name;
        }
      }

      if (entry.jump === "i") {
        const enclosing = findEnclosingFunction(ctx.functions, entry.fileIndex, entry.start);
        const frameName = enclosing?.name
          ? enclosing.name
          : `function@${path.basename(source.absolutePath)}:${pos.line + 1}`;
        frames.push({
          name: frameName,
          filePath: source.absolutePath,
          line: pos.line,
          character: pos.character,
          entryStepIdx: i,
          entryStackLen: step.stack.length,
          fn: enclosing,
          ctx,
          localStackPositions: new Map(),
        });
      } else if (entry.jump === "o" && frames.length > 1) {
        frames.pop();
      }

      // The topmost frame's source position tracks the current
      // step so the user sees where execution is right now, not
      // where the function was entered.
      const top = frames[frames.length - 1];
      top.filePath = source.absolutePath;
      top.line = pos.line;
      top.character = pos.character;

      // Live-local tracking: walk this frame's function locals and,
      // for each one we haven't recorded yet, check whether the
      // current step's source position has moved PAST the
      // declaration statement's end. If so, the initializer's
      // result is on the stack and the local sits at
      // `step.stack.length - 1`. Doesn't fire for tuple
      // destructuring (multiple decls per statement) or for
      // declarations skipped by control flow — left as known
      // limitations rather than wrong values.
      if (top.fn) {
        for (const local of top.fn.locals) {
          if (top.localStackPositions.has(local.name)) continue;
          if (entry.start < local.statementEndByte) continue;
          if (entry.start === local.declaredAtByte) continue;
          // Heuristic: only record when the source position is now
          // past the declaration's full statement range AND the
          // stack has grown beyond entry. We additionally require
          // entry.fileIndex matches (declaration is in the same
          // source as the function) so a different file's source
          // map entry doesn't incorrectly trigger.
          if (entry.fileIndex !== this.localFileIndexFor(top.fn, ctx)) continue;
          if (step.stack.length <= top.entryStackLen) continue;
          top.localStackPositions.set(local.name, step.stack.length - 1);
        }
      }
    }

    // Flatten outermost-first internally, then reverse so the
    // returned array is topmost-first per the DAP convention.
    const flat: CallStackFrame[] = [];
    for (const d of depthStack) flat.push(...d);
    return flat.reverse();
  }

  /**
   * Determine the source-map fileIndex the function lives in by
   * scanning the contract's sources for a path match. Used by
   * local-tracking so that source-map entries from imported files
   * can't accidentally trigger a "this local is now declared"
   * recording inside an outer function.
   */
  private localFileIndexFor(fn: AstFunction, _ctx: ContractContext): number {
    return fn.fileIndex;
  }

  private allocateVariableRef(getter: () => DapVariable[]): number {
    const ref = ++this.nextVariableRef;
    this.variableRefs.set(ref, getter);
    return ref;
  }

  /** EVM stack contents at the current step, top-of-stack first. */
  private evmStackVariables(step: TraceStep): DapVariable[] {
    if (step.stack.length === 0) {
      return [{ name: "(empty)", value: "", variablesReference: 0 }];
    }
    // EVM convention is top-of-stack last in the structLogs output
    // (some emitters use first; we display in canonical "top first"
    // order with index 0 = top).
    const total = step.stack.length;
    return step.stack
      .slice()
      .reverse()
      .map((value, idx) => ({
        name: `[${idx}]${idx === 0 ? " (top)" : idx === total - 1 ? " (bottom)" : ""}`,
        value: prefixHex(value),
        variablesReference: 0,
        type: "uint256",
      }));
  }

  /** EVM memory laid out as 32-byte words, addressed by their start offset. */
  private evmMemoryVariables(step: TraceStep): DapVariable[] {
    if (step.memory.length === 0) {
      return [{ name: "(empty)", value: "", variablesReference: 0 }];
    }
    return step.memory.map((value, idx) => ({
      name: `0x${(idx * 32).toString(16).padStart(4, "0")}`,
      value: prefixHex(value),
      variablesReference: 0,
      type: "bytes32",
    }));
  }

  /**
   * Source-level locals scope. Lists the parameters and the
   * in-scope local variables of the function that encloses the
   * cursor's current source position, with **live values** read
   * out of the trace's EVM stack:
   *
   *   - Parameters live at `[entryStackLen - paramCount,
   *     entryStackLen)` of the trace's bottom-first stack array
   *     (Solidity calling convention pushes them in declaration
   *     order). Values are read from those slots at every step.
   *   - Locals are tracked incrementally by the call-stack
   *     walker: as the trace's source position passes each
   *     `VariableDeclarationStatement`'s end byte, the slot at
   *     the top of the EVM stack is recorded. Values are read
   *     from that slot at every subsequent step.
   *
   * Both render `(consumed)` when the EVM stack has shrunk
   * below the recorded position — the compiler popped the value
   * before this point. Tuple destructuring (`(a, b) = foo()`)
   * is not yet supported and lands as a name-only entry; ditto
   * locals skipped by control flow (declared but never reached).
   */
  private sourceLocalsVariables(
    fn: AstFunction,
    byteOffset: number,
    step: TraceStep,
    frame: CallStackFrame | null,
  ): DapVariable[] {
    const out: DapVariable[] = [];
    const stackLen = step.stack.length;
    const paramCount = fn.parameters.length;

    for (let i = 0; i < fn.parameters.length; i++) {
      const p = fn.parameters[i];
      let value = "(value not available — no active frame)";
      if (frame && frame.fn === fn) {
        const slot = frame.entryStackLen - paramCount + i;
        if (slot >= 0 && slot < stackLen) {
          value = prefixHex(step.stack[slot]);
        } else {
          value = "(consumed by callee)";
        }
      }
      out.push({
        name: p.name,
        value,
        variablesReference: 0,
        type: p.type,
      });
    }

    for (const local of fn.locals) {
      if (local.declaredAtByte > byteOffset) continue;
      let value = "(local — stack-slot mapping pending)";
      if (frame && frame.fn === fn) {
        const slot = frame.localStackPositions.get(local.name);
        if (slot !== undefined) {
          if (slot < stackLen) {
            value = prefixHex(step.stack[slot]);
          } else {
            value = "(consumed)";
          }
        } else if (byteOffset < local.statementEndByte) {
          value = "(initializer running)";
        } else {
          value = "(unsupported declaration form)";
        }
      }
      out.push({
        name: local.name,
        value,
        variablesReference: 0,
        type: local.type,
      });
    }

    if (out.length === 0) {
      return [{ name: "(no parameters / locals in scope)", value: "", variablesReference: 0 }];
    }
    return out;
  }

  /**
   * Storage diff for the active contract. structLogs only show
   * storage *changes* observed during execution — not the entire
   * storage tree — so this list is small. When the artifact's
   * `storageLayout` is loaded, each slot is pretty-printed with
   * its declared variable name(s) and Solidity type instead of
   * the raw hex slot. Packed slots surface every entry that
   * occupies them.
   */
  private evmStorageVariables(step: TraceStep): DapVariable[] {
    const entries = Object.entries(step.storage);
    if (entries.length === 0) {
      return [{ name: "(no observed writes)", value: "", variablesReference: 0 }];
    }
    const layout = this.activeContext()?.storageLayout;
    return entries.flatMap(([slot, value]) => {
      const named = layout ? lookupSlot(layout, slot) : [];
      if (named.length === 0) {
        return [
          {
            name: prefixHex(slot),
            value: prefixHex(value),
            variablesReference: 0,
            type: "bytes32",
          },
        ];
      }
      return named.map((entry) => ({
        name: `${entry.label} (slot ${prefixHex(slot)}${entry.offset > 0 ? ` +${entry.offset}` : ""})`,
        value: prefixHex(value),
        variablesReference: 0,
        type: entry.type,
      }));
    });
  }

  // ── Source resolution ────────────────────────────────────────────

  /**
   * Map a single trace step to a source position via the loaded
   * contract context. Returns `null` for generated opcodes
   * (`fileIndex === -1`) and for steps in inner call frames whose
   * source we don't have loaded — single-contract stage-3 caveat.
   */
  private resolveStepSource(
    step: TraceStep,
  ): { filePath: string; line: number; character: number } | null {
    // Use the active context for this step (entry contract at
    // depth 1, or one of the aux contracts when a CALL crossed a
    // boundary into known territory). When no context applies
    // (inner call into an unknown address, or the cursor is on a
    // generated helper opcode), bail with `null`.
    const ctx = this.activeContext();
    if (!ctx) return null;
    const entry = resolveSourcePosition(step.pc, ctx.pcMap, ctx.sourceMap);
    if (!entry) return null;
    const source = ctx.sources[entry.fileIndex];
    if (!source || !source.lineIndex) return null;
    const pos = source.lineIndex.positionAt(entry.start);
    return { filePath: source.absolutePath, line: pos.line, character: pos.character };
  }

  /**
   * Map the cursor's current step back to its enclosing AST
   * function (if any). Combines source-position resolution
   * (PC → source byte offset) with the AST walker's
   * `findEnclosingFunction`. Returns `null` for generated
   * opcodes, inner-call frames, or contracts whose AST we don't
   * have loaded.
   */
  private currentEnclosingFunction(
    step: TraceStep,
  ): { fn: AstFunction; byteOffset: number } | null {
    const ctx = this.activeContext();
    if (!ctx || ctx.functions.length === 0) return null;
    void step;
    const entry = resolveSourcePosition(step.pc, ctx.pcMap, ctx.sourceMap);
    if (!entry) return null;
    const fn = findEnclosingFunction(ctx.functions, entry.fileIndex, entry.start);
    if (!fn) return null;
    return { fn, byteOffset: entry.start };
  }

  /** Convenience for the step / continue loops. */
  private currentLine(): { filePath: string; line: number } | null {
    const step = this.cursor?.current;
    if (!step) return null;
    const src = this.resolveStepSource(step);
    if (!src) return null;
    return { filePath: src.filePath, line: src.line };
  }

  private matchesBreakpoint(line: { filePath: string; line: number }): boolean {
    const lines = this.breakpoints.get(path.normalize(line.filePath));
    return !!lines && lines.has(line.line);
  }

  // ── Loading ─────────────────────────────────────────────────────

  /**
   * Spawn `cast run --json <txHash> [--rpc-url <url>]` to fetch a
   * structLogs trace from a live Anvil / RPC endpoint. Avoids the
   * "save to file, point launch.json at it" two-step. Returns a
   * human-readable error on failure (timeout, cast not on PATH,
   * unparseable output).
   *
   * Stretch goal: a fully-automated `forge test --debug` driver
   * would launch the test, capture the tx hash, and call this with
   * it. For now, the user supplies the tx hash directly — they
   * either know it from a prior `forge test -vvvv` run or got it
   * from a fork.
   */
  private async loadTraceFromCastRun(args: LaunchArguments): Promise<string | null> {
    if (!args.txHash) return "Missing `txHash` in launch configuration.";
    const config = vscode.workspace.getConfiguration("solidity-workbench");
    const castPath = config.get<string>("castPath") || "cast";
    const argv = ["run", "--json", args.txHash];
    if (args.rpcUrl) argv.push("--rpc-url", args.rpcUrl);

    const cwd =
      args.projectRoot ??
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
      process.cwd();

    let stdout = "";
    try {
      const result = await execFileAsync(castPath, argv, {
        cwd,
        maxBuffer: 256 * 1024 * 1024,
        timeout: 10 * 60 * 1000,
      });
      stdout = result.stdout;
    } catch (err: unknown) {
      // Some cast versions exit non-zero when the trace contains
      // a revert; the JSON is still on stdout, so try it before
      // declaring the run a failure.
      const e = err as { stdout?: string; stderr?: string; message?: string };
      stdout = e.stdout ?? "";
      if (!stdout) {
        return e.stderr?.trim() || e.message || String(err);
      }
    }

    const trace = parseTraceJson(stdout);
    if (!trace) {
      return "cast run output didn't match an expected structLogs shape — make sure you're using a recent Foundry release.";
    }
    this.cursor = new TraceCursor(trace.steps);
    return null;
  }

  /**
   * Read and parse a `cast run --json` (or `debug_traceTransaction`)
   * dump from disk. Returns a human-readable error string on
   * failure rather than throwing, so the launch handler can surface
   * it via `output` events.
   */
  private loadTraceFile(p: string): string | null {
    let raw: string;
    try {
      raw = readFileSync(p, "utf-8");
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    const trace = parseTraceJson(raw);
    if (!trace) {
      return "Trace JSON did not match an expected structLogs shape (geth / anvil / cast run --json).";
    }
    this.cursor = new TraceCursor(trace.steps);
    return null;
  }

  /**
   * Load a forge artifact and build a `ContractContext`. Source
   * paths are resolved against `projectRoot` (the launch config or
   * the workspace folder). Each source file is read once and
   * indexed for fast byte-offset → line conversion.
   */
  private loadArtifact(artifactPath: string, projectRoot: string | undefined): string | null {
    let raw: string;
    try {
      raw = readFileSync(artifactPath, "utf-8");
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    const artifact = parseForgeArtifact(raw);
    if (!artifact) {
      return "Artifact JSON did not match an expected forge / solc shape (missing deployedBytecode).";
    }
    const root =
      projectRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? path.dirname(artifactPath);
    this.entryContext = this.buildContractContext(artifact, root);
    return null;
  }

  /**
   * Load one entry from the launch config's `contracts` array — a
   * `{ address, artifact }` pairing — into the auxContexts map.
   * Returns a human-readable error string on failure (file
   * unreadable, JSON unparseable, missing deployedBytecode).
   *
   * Address normalisation: stored lowercased + `0x`-prefixed so
   * lookups against trace stack reads match without extra work.
   */
  private loadAuxContract(
    entry: { address?: string; artifact?: string; projectRoot?: string },
    fallbackRoot: string | undefined,
  ): string | null {
    if (!entry.address || !entry.artifact) {
      return "`contracts[]` entries require both `address` and `artifact`";
    }
    let raw: string;
    try {
      raw = readFileSync(entry.artifact, "utf-8");
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    const artifact = parseForgeArtifact(raw);
    if (!artifact) {
      return `Artifact '${entry.artifact}' did not match an expected forge / solc shape.`;
    }
    const root =
      entry.projectRoot ??
      fallbackRoot ??
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
      path.dirname(entry.artifact);
    const ctx = this.buildContractContext(artifact, root);
    this.auxContexts.set(normaliseAddress(entry.address), ctx);
    return null;
  }

  private buildContractContext(artifact: ForgeArtifact, projectRoot: string): ContractContext {
    const sourceMap = parseSourceMap(artifact.deployedSourceMap);
    const pcMap = artifact.deployedBytecode
      ? buildPcToInstructionIndex(artifact.deployedBytecode)
      : [];
    const sources = artifact.sources.map((relPath) => {
      const absolutePath = path.isAbsolute(relPath) ? relPath : path.resolve(projectRoot, relPath);
      let lineIndex: LineIndex | null = null;
      try {
        lineIndex = LineIndex.fromText(readFileSync(absolutePath, "utf-8"));
      } catch {
        lineIndex = null;
      }
      return { absolutePath, lineIndex };
    });
    // Storage layout is optional — older / minimal artifacts may
    // omit it and the adapter degrades to "raw hex slots" naming.
    // We re-parse the artifact JSON since `parseForgeArtifact`
    // doesn't currently surface this block; doing it here keeps
    // the common helper's surface narrow.
    const storageLayout = parseStorageLayout(artifact.raw);
    // Disassembly is computed once at load and reused for every
    // `disassemble` request via array slicing.
    let disassembly: Instruction[] = [];
    try {
      disassembly = artifact.deployedBytecode ? disassemble(artifact.deployedBytecode) : [];
    } catch {
      disassembly = [];
    }
    const functions = extractFunctions(artifact.raw.ast);
    return {
      sourceMap,
      pcMap,
      sources,
      storageLayout,
      disassembly,
      functions,
    };
  }

  // ── Wire helpers ─────────────────────────────────────────────────

  private summariseLoadState(): string {
    const parts: string[] = [];
    if (this.cursor) parts.push(`${this.cursor.length} trace steps`);
    if (this.entryContext) {
      const sourcesWithIndex = this.entryContext.sources.filter((s) => s.lineIndex).length;
      parts.push(`${sourcesWithIndex} source file${sourcesWithIndex === 1 ? "" : "s"} indexed`);
    }
    if (this.auxContexts.size > 0) {
      parts.push(`${this.auxContexts.size} aux contract${this.auxContexts.size === 1 ? "" : "s"} loaded`);
    }
    if (parts.length === 0) {
      return "Live execution path not yet wired (stage 4) — supply `traceFile` and `artifact` for stage-3 stepping.";
    }
    return `Loaded: ${parts.join(", ")}`;
  }

  private respond(
    request: DapRequest,
    success: boolean,
    body?: Record<string, unknown>,
    message?: string,
  ): void {
    this.send({
      type: "response",
      request_seq: request.seq,
      success,
      command: request.command,
      ...(body !== undefined ? { body } : {}),
      ...(message !== undefined ? { message } : {}),
    });
  }

  private fireEvent(event: string, body?: Record<string, unknown>): void {
    this.send({
      type: "event",
      event,
      ...(body !== undefined ? { body } : {}),
    });
  }

  private send(message: Record<string, unknown>): void {
    this.seq += 1;
    this._onDidSendMessage.fire({ ...message, seq: this.seq } as vscode.DebugProtocolMessage);
  }

  dispose(): void {
    this._onDidSendMessage.dispose();
  }
}

/**
 * Factory wired into `vscode.debug.registerDebugAdapterDescriptorFactory`.
 * One adapter instance per debug session.
 */
export class SolidityDapAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  createDebugAdapterDescriptor(
    _session: vscode.DebugSession,
  ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    return new vscode.DebugAdapterInlineImplementation(new SolidityDapAdapter());
  }
}

/**
 * Configuration provider that fills in sensible defaults when the
 * user runs F5 without a `launch.json`. Picks up the active editor's
 * `.t.sol` test file and a placeholder test name; once trace
 * ingestion lands the placeholder will be replaced with a quick-pick
 * over discovered tests.
 */
export class SolidityDapConfigurationProvider implements vscode.DebugConfigurationProvider {
  resolveDebugConfiguration(
    _folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
  ): vscode.ProviderResult<vscode.DebugConfiguration> {
    if (!config.type && !config.request && !config.name) {
      const editor = vscode.window.activeTextEditor;
      if (editor?.document.languageId !== "solidity") return undefined;
      return {
        type: "solidity-workbench",
        request: "launch",
        name: "Debug Solidity test",
        program: editor.document.uri.fsPath,
        stopOnEntry: true,
      };
    }
    return config;
  }
}

// ── Internal types ──────────────────────────────────────────────────

/**
 * One loaded contract's debug context: the parsed source map, the
 * pre-computed PC → instruction-index table, and the source-file
 * line indexes the source map references via `fileIndex`.
 *
 * `depth` is the call-stack depth at which this context's bytecode
 * is executing. Stage 3 supports a single context at the entry
 * depth (1); stage 4 will track a stack of contexts as the trace
 * crosses CALL / CREATE boundaries.
 */
interface ContractContext {
  sourceMap: SourceMapEntry[];
  pcMap: number[];
  sources: { absolutePath: string; lineIndex: LineIndex | null }[];
  /** Storage layout from the artifact, or `null` when unavailable. */
  storageLayout: StorageLayout | null;
  /** Pre-disassembled deployed bytecode, computed at load time. */
  disassembly: Instruction[];
  /**
   * Solc AST function definitions. Used to surface in-scope
   * parameters and locals as a "Source-level locals" scope.
   * Empty when the artifact lacked an `ast` block (older
   * compilers or stripped builds).
   */
  functions: AstFunction[];
}

interface DapRequest {
  seq: number;
  type: "request";
  command: string;
  arguments?: unknown;
}

/**
 * One Solidity-level call frame, computed by walking the trace's
 * source-map `i` / `o` jump markers and EVM depth transitions.
 *
 * `entryStackLen` and `localStackPositions` exist so the
 * Source-level locals scope can read live parameter / local values
 * out of the current step's EVM stack — a function's parameters
 * are at indices `[entryStackLen - paramCount, entryStackLen)` in
 * the trace's bottom-first stack array, and locals occupy slots
 * tracked incrementally as their declarations execute.
 */
interface CallStackFrame {
  name: string;
  filePath: string;
  /** 0-based line number; `+1`'d before sending over DAP. */
  line: number;
  /** 0-based character offset; `+1`'d before sending over DAP. */
  character: number;
  /** Trace step index where this frame was entered (synthetic "(entry)" frame at depth 1 uses `0`). */
  entryStepIdx: number;
  /** EVM stack length at function entry — bottom of this frame. */
  entryStackLen: number;
  /** AST function record this frame represents, when resolvable. */
  fn: AstFunction | null;
  /** ContractContext active for this frame's depth (may be `null` for unknown inner contracts). */
  ctx: ContractContext | null;
  /**
   * Map from local-variable name to its absolute index in the
   * trace's stack array (bottom-first). Populated incrementally
   * as the trace passes each `VariableDeclarationStatement`'s
   * declaration byte range. Used by the Source-level locals
   * scope to read the local's current value.
   */
  localStackPositions: Map<string, number>;
}

/**
 * A single entry in a `variables` response. Keeps the surface narrow
 * — fields beyond `name` / `value` / `variablesReference` are added
 * as the adapter learns to decode richer types in stage 5.
 */
interface DapVariable {
  name: string;
  value: string;
  variablesReference: number;
  type?: string;
}

/** Prefix `value` with `0x` if it isn't already. Used uniformly across the variables panel. */
function prefixHex(value: string): string {
  if (value.length === 0) return "0x";
  if (value.startsWith("0x") || value.startsWith("0X")) return value;
  return `0x${value}`;
}

interface EvaluateArgs {
  expression?: string;
  context?: string;
  frameId?: number;
}

interface DisassembleArgs {
  memoryReference?: string;
  offset?: number;
  instructionOffset?: number;
  instructionCount?: number;
}

/**
 * Decode a numeric literal in either decimal or hex form. Returns
 * a `bigint` so storage slots beyond 2^53 round-trip safely.
 * Returns `null` for anything we can't parse.
 */
function parseExpressionNumber(raw: string): bigint | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    if (trimmed.startsWith("0x") || trimmed.startsWith("0X")) {
      return BigInt(trimmed);
    }
    if (/^\d+$/.test(trimmed)) {
      return BigInt(trimmed);
    }
  } catch {
    return null;
  }
  return null;
}

/** Parse a `0x...` address-style memoryReference; falls back to 0. */
function parseAddress(raw: string): number {
  const n = parseExpressionNumber(raw);
  return n === null ? 0 : Number(n);
}

/** `PUSH2 0xCAFE` / `STOP` — the human-readable line shown in the disassembly panel. */
function formatInstruction(inst: Instruction): string {
  if (inst.immediate !== null && inst.immediate.length > 0) {
    return `${inst.mnemonic} 0x${inst.immediate}`;
  }
  if (inst.immediate === "") {
    return inst.mnemonic;
  }
  return inst.mnemonic;
}

/** Hex bytes of the encoding (opcode + immediate), space-separated for the gutter. */
function instructionBytes(inst: Instruction): string {
  const opcodeByte = inst.opcode.toString(16).padStart(2, "0");
  if (inst.immediate && inst.immediate.length > 0) {
    return `${opcodeByte} ${inst.immediate.match(/.{1,2}/g)?.join(" ") ?? ""}`.trim();
  }
  return opcodeByte;
}

void opcodeMnemonic; // re-exported for downstream consumers; keeps the import in scope.

/**
 * Read the target address from a CALL-like step's stack snapshot.
 *
 * The geth structLogs convention is bottom-first: `stack[0]` is
 * the EVM stack bottom, `stack[length - 1]` is the top. CALL pops
 * its operands in this order from the top:
 *
 *   gas, addr, value, argsOffset, argsLength, retOffset, retLength
 *
 * STATICCALL / DELEGATECALL drop `value`, but the address is still
 * the second item from the top — we just need `stack[length - 2]`.
 *
 * The result is right-padded inside a 32-byte word; we take the
 * trailing 40 hex chars (= 20 bytes) and lowercase it for the
 * canonical form `auxContexts` is keyed on.
 */
function readAddressFromStack(step: { stack: string[] }): string | null {
  const arr = step.stack;
  if (arr.length < 2) return null;
  const raw = arr[arr.length - 2];
  return normaliseAddress(raw);
}

/**
 * Normalise an address string for use as the `auxContexts` map
 * key. Accepts both `0x`-prefixed and bare hex, padded or unpadded
 * to 32 bytes; returns the lowercased `0x`-prefixed 20-byte form.
 * Returns `null` for malformed input.
 */
function normaliseAddress(input: string): string {
  let hex = input.trim();
  if (hex.startsWith("0x") || hex.startsWith("0X")) hex = hex.slice(2);
  if (!/^[0-9a-fA-F]*$/.test(hex)) return null as unknown as string;
  if (hex.length === 0) return "0x" + "0".repeat(40);
  // Pad to at least 40 hex chars so we can take the trailing 40
  // (right-padded 32-byte words are common in trace stacks).
  if (hex.length > 40) hex = hex.slice(-40);
  hex = hex.padStart(40, "0");
  return ("0x" + hex).toLowerCase();
}

interface SetBreakpointsArgs {
  source: { path?: string; name?: string };
  breakpoints?: { line: number; column?: number; condition?: string }[];
}

/** `launch` request arguments — concrete properties land per stage. */
interface LaunchArguments {
  program?: string;
  test?: string;
  stopOnEntry?: boolean;
  /**
   * Path to a JSON file with a pre-saved EVM trace
   * (`cast run --json <txhash> > trace.json` is the canonical
   * source). Mutually exclusive with `txHash` — if both are set,
   * `traceFile` wins.
   */
  traceFile?: string;
  /**
   * Transaction hash to fetch via `cast run --json <txHash>` at
   * launch time. The adapter spawns `cast run` and ingests the
   * resulting structLogs trace, eliminating the
   * "save trace to disk, point launch.json at it" two-step.
   */
  txHash?: string;
  /**
   * Optional `--rpc-url` passed to `cast run`. When omitted, cast
   * picks up its default endpoint (typically a local Anvil at
   * 127.0.0.1:8545).
   */
  rpcUrl?: string;
  /**
   * Auxiliary contracts that may be CALLed during the trace. Each
   * `{ address, artifact }` pair is loaded at startup and keyed by
   * the lowercase 0x-prefixed address. When the trace's CALL /
   * DELEGATECALL / STATICCALL targets a known address, the adapter
   * switches the active `ContractContext` so source positions,
   * storage pretty-print, and disassembly all resolve against the
   * inner contract instead of falling back to "no source".
   */
  contracts?: { address: string; artifact: string; projectRoot?: string }[];
  /**
   * Path to a forge artifact JSON (`out/<file>.sol/<Contract>.json`).
   * Stage 3 reads this for the deployed bytecode + sourceMap +
   * sources list, which together let the adapter resolve trace
   * PCs back to source positions.
   */
  artifact?: string;
  /**
   * Project root used to resolve the artifact's relative source
   * paths. Defaults to the workspace folder.
   */
  projectRoot?: string;
}
