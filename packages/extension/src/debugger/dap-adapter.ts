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
  /** Loaded once during `launch` when the config supplies an `artifact`. */
  private contractContext: ContractContext | null = null;
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

    this.respond(msg, true);
    this.fireEvent("stopped", {
      reason: "entry",
      threadId: 1,
      allThreadsStopped: true,
      description: this.summariseLoadState(),
    });
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
    const internalFrames = this.buildInternalCallStack();
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
          name: frameLabel + (this.contractContext ? " — no source for this depth/opcode" : ""),
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
    this.respond(msg, true, {
      scopes: [
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
      ],
    });
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
    const sources = this.contractContext?.sources.map((s) => ({
      name: path.basename(s.absolutePath),
      path: s.absolutePath,
    })) ?? [];
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
    // context is loaded, fall back to single-step behaviour from
    // stage 2 so the user can still walk opcode-by-opcode.
    if (!this.contractContext) {
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
    // Bare identifier — look up via the storage layout.
    if (/^[A-Za-z_]\w*$/.test(expression) && this.contractContext?.storageLayout) {
      const match = this.contractContext.storageLayout.entries.find(
        (e) => e.label === expression,
      );
      if (match) {
        const slotKey = match.slot.toString();
        const value =
          step.storage[slotKey] ?? step.storage[`0x${match.slot.toString(16)}`];
        if (value !== undefined) return prefixHex(value);
        return "(slot has no observed write — value unchanged from before this trace)";
      }
    }
    return null;
  }

  private handleDisassemble(msg: DapRequest): void {
    const args = msg.arguments as DisassembleArgs | undefined;
    if (!args || !this.contractContext) {
      this.respond(msg, false, undefined, "No contract loaded — supply `artifact` in launch.json");
      return;
    }
    const all = this.contractContext.disassembly;
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
   * Walk the trace from index 0 through the cursor's current step,
   * pushing on `jump: "i"` and popping on `jump: "o"`, to construct
   * the Solidity internal call stack at the current position.
   *
   * The bottom-most frame represents the function the trace
   * started in (the test function, typically); each subsequent
   * frame is one level deeper. The DAP convention is
   * topmost-first, so the returned array is reversed before
   * delivery — index 0 is the innermost function.
   *
   * Inner external CALLs (depth > entry depth) are skipped here:
   * their bytecode isn't ours, so we can't track their internal
   * stack. They contribute as a single label frame in the trace
   * but don't unwind our internal stack.
   *
   * Defensive: refuses to pop the bottom frame so an unbalanced
   * `jump: "o"` (which can happen when an exception unwinds) leaves
   * a sensible stack rather than emptying it.
   */
  private buildInternalCallStack(): InternalFrame[] {
    if (!this.cursor || !this.contractContext) return [];
    const ctx = this.contractContext;
    const cursorIndex = this.cursor.index;
    const stack: InternalFrame[] = [];

    for (let i = 0; i <= cursorIndex && i < this.cursor.length; i++) {
      const step = this.cursor.steps[i];
      if (step.depth !== ctx.depth) continue; // skip inner-external opcodes
      const entry = resolveSourcePosition(step.pc, ctx.pcMap, ctx.sourceMap);
      if (!entry) continue;
      const source = ctx.sources[entry.fileIndex];
      if (!source?.lineIndex) continue;
      const pos = source.lineIndex.positionAt(entry.start);

      if (stack.length === 0) {
        stack.push({
          name: "(entry)",
          filePath: source.absolutePath,
          line: pos.line,
          character: pos.character,
        });
        continue;
      }

      if (entry.jump === "i") {
        stack.push({
          name: `function@${path.basename(source.absolutePath)}:${pos.line + 1}`,
          filePath: source.absolutePath,
          line: pos.line,
          character: pos.character,
        });
      } else if (entry.jump === "o" && stack.length > 1) {
        stack.pop();
      }

      // The topmost frame's source position tracks the *current*
      // step (so the user sees where execution is right now, not
      // where the JUMP-in landed).
      const top = stack[stack.length - 1];
      top.filePath = source.absolutePath;
      top.line = pos.line;
      top.character = pos.character;
    }

    return stack.reverse();
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
    const layout = this.contractContext?.storageLayout;
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
    if (!this.contractContext) return null;
    if (step.depth !== this.contractContext.depth) {
      // Inner call frames: their bytecode isn't ours. Multi-frame
      // resolution lands in stage 4.
      return null;
    }
    const entry = resolveSourcePosition(
      step.pc,
      this.contractContext.pcMap,
      this.contractContext.sourceMap,
    );
    if (!entry) return null;
    const source = this.contractContext.sources[entry.fileIndex];
    if (!source || !source.lineIndex) return null;
    const pos = source.lineIndex.positionAt(entry.start);
    return { filePath: source.absolutePath, line: pos.line, character: pos.character };
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
    this.contractContext = this.buildContractContext(artifact, root);
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
    return {
      sourceMap,
      pcMap,
      sources,
      depth: 1,
      storageLayout,
      disassembly,
    };
  }

  // ── Wire helpers ─────────────────────────────────────────────────

  private summariseLoadState(): string {
    const parts: string[] = [];
    if (this.cursor) parts.push(`${this.cursor.length} trace steps`);
    if (this.contractContext) {
      const sourcesWithIndex = this.contractContext.sources.filter((s) => s.lineIndex).length;
      parts.push(`${sourcesWithIndex} source file${sourcesWithIndex === 1 ? "" : "s"} indexed`);
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
  depth: number;
  /** Storage layout from the artifact, or `null` when unavailable. */
  storageLayout: StorageLayout | null;
  /** Pre-disassembled deployed bytecode, computed at load time. */
  disassembly: Instruction[];
}

interface DapRequest {
  seq: number;
  type: "request";
  command: string;
  arguments?: unknown;
}

/**
 * One Solidity-level call frame, computed by walking the trace's
 * source-map `i` / `o` jump markers. The topmost (innermost) frame
 * is the function the cursor is currently executing in.
 */
interface InternalFrame {
  name: string;
  filePath: string;
  /** 0-based line number; `+1`'d before sending over DAP. */
  line: number;
  /** 0-based character offset; `+1`'d before sending over DAP. */
  character: number;
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
