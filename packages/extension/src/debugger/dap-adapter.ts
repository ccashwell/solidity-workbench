import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import * as path from "node:path";
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
 *   setBreakpoints (THIS REVISION). When the launch config supplies
 *   `artifact` (path to a forge artifact JSON), the adapter loads the
 *   deployed bytecode + sourceMap, builds a `ContractContext`, and:
 *     * `stackTrace` reports the actual source file + line for the
 *       cursor's current step.
 *     * `next` advances until the source line changes (skipping
 *       generated helpers and inner-call opcodes naturally).
 *     * `stepIn` is identical to `next` in single-contract mode —
 *       multi-contract source resolution lands in stage 4.
 *     * `stepOut` advances until the call depth drops below the
 *       current frame.
 *     * `continue` advances to the next breakpoint or end-of-trace.
 *     * `setBreakpoints` accepts source-line breakpoints and
 *       reports them all verified.
 *     * `loadedSources` enumerates the artifact's source list.
 * - Stages 4-5 — see PRODUCTION_GAPS.md.
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
  /** Cached so `next` knows when the source line has actually changed. */
  private lastReportedLine: { filePath: string; line: number } | null = null;

  handleMessage(message: vscode.DebugProtocolMessage): void {
    const msg = message as DapRequest;
    if (msg.type !== "request") return;

    switch (msg.command) {
      case "initialize":
        return this.handleInitialize(msg);
      case "launch":
        return this.handleLaunch(msg);
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
      supportsEvaluateForHovers: false,
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
      supportsDisassembleRequest: false,
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

  private handleLaunch(msg: DapRequest): void {
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

    const source = this.resolveStepSource(step);
    const cursor = this.cursor!;
    const frameLabel = `${step.op} @ pc=${step.pc} (depth ${step.depth}, gas ${step.gas})`;
    if (source) {
      this.respond(msg, true, {
        stackFrames: [
          {
            id: cursor.index,
            name: frameLabel,
            // DAP lines / columns are 1-based.
            line: source.line + 1,
            column: source.character + 1,
            source: { path: source.filePath, name: path.basename(source.filePath) },
          },
        ],
        totalFrames: 1,
      });
      this.lastReportedLine = { filePath: source.filePath, line: source.line };
    } else {
      this.respond(msg, true, {
        stackFrames: [
          {
            id: cursor.index,
            name: frameLabel + (this.contractContext ? " — generated/no source" : ""),
            line: 0,
            column: 0,
            presentationHint: "label",
          },
        ],
        totalFrames: 1,
      });
    }
  }

  private handleScopes(msg: DapRequest): void {
    this.respond(msg, true, { scopes: [] });
  }

  private handleVariables(msg: DapRequest): void {
    this.respond(msg, true, { variables: [] });
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

  private handleTerminate(msg: DapRequest): void {
    this.respond(msg, true);
    this.fireEvent("terminated");
    this.fireEvent("exited", { exitCode: 0 });
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
    return { sourceMap, pcMap, sources, depth: 1 };
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
}

interface DapRequest {
  seq: number;
  type: "request";
  command: string;
  arguments?: unknown;
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
   * source). Stage 2 escape hatch until stage 4 wires the live
   * `forge test --debug --json` execution path.
   */
  traceFile?: string;
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
