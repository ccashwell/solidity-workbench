import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import { parseTraceJson, TraceCursor } from "@solidity-workbench/common";

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
 * - Stage 2 — trace ingestion (THIS REVISION). When the launch
 *   config supplies `traceFile`, the adapter loads it via
 *   `parseTraceJson` and drives a `TraceCursor` from
 *   `next` / `previous` requests. The Call Stack panel surfaces
 *   the cursor's current `pc`/`op`/`depth` so the user sees
 *   meaningful state. Source-position resolution and `setBreakpoints`
 *   are stage 3.
 * - Stages 3-5 — see PRODUCTION_GAPS.md.
 */
export class SolidityDapAdapter implements vscode.DebugAdapter {
  private readonly _onDidSendMessage = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  readonly onDidSendMessage = this._onDidSendMessage.event;

  private seq = 0;
  /** Loaded once during `launch` when the config carries a `traceFile`. */
  private cursor: TraceCursor | null = null;

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
      case "continue":
      case "next":
      case "stepIn":
      case "stepOut":
        return this.handleStepStub(msg);
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
      // Capabilities the adapter advertises today. As stages 2-5
      // land we'll flip more of these to true (breakpoints, hover
      // evaluate, conditional breakpoints, etc.).
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
      supportsLoadedSourcesRequest: false,
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
    // The `initialized` event tells VSCode it can now send any
    // setBreakpoints / setExceptionBreakpoints requests it has
    // queued for us, followed by `configurationDone`.
    this.fireEvent("initialized");
  }

  private handleLaunch(msg: DapRequest): void {
    const args = (msg.arguments ?? {}) as LaunchArguments;
    if (args.traceFile) {
      const loadError = this.loadTraceFile(args.traceFile);
      if (loadError) {
        // Acknowledge the launch but surface the load failure to
        // the user via `output` and `terminated`. Failing the launch
        // outright leaves VSCode in an awkward "session never
        // started" state.
        this.respond(msg, true);
        this.fireEvent("output", {
          category: "stderr",
          output: `Failed to load trace from '${args.traceFile}': ${loadError}\n`,
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
      description: this.cursor
        ? `Loaded ${this.cursor.length} trace step${this.cursor.length === 1 ? "" : "s"}`
        : "Live execution path not yet wired (stage 3) — supply `traceFile` to step through a saved trace.",
    });
  }

  /**
   * Read and parse a `cast run --json` (or `debug_traceTransaction`)
   * dump from disk. Returns a human-readable error string on
   * failure rather than throwing, so the launch handler can surface
   * it via `output` events.
   */
  private loadTraceFile(path: string): string | null {
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
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

  private handleThreads(msg: DapRequest): void {
    this.respond(msg, true, {
      threads: [{ id: 1, name: "EVM" }],
    });
  }

  private handleStackTrace(msg: DapRequest): void {
    // Stage 2: when a trace cursor is loaded, surface the current
    // step's PC / opcode / depth in the Call Stack panel so the
    // user sees meaningful state. Source-position resolution
    // (mapping PC → file/line via the source-map module) lands in
    // stage 3.
    const step = this.cursor?.current;
    if (step) {
      this.respond(msg, true, {
        stackFrames: [
          {
            id: this.cursor!.index,
            name: `${step.op} @ pc=${step.pc} (depth ${step.depth}, gas ${step.gas})`,
            line: 0,
            column: 0,
            presentationHint: "label",
          },
        ],
        totalFrames: 1,
      });
      return;
    }
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
  }

  private handleScopes(msg: DapRequest): void {
    this.respond(msg, true, { scopes: [] });
  }

  private handleVariables(msg: DapRequest): void {
    this.respond(msg, true, { variables: [] });
  }

  private handleStepStub(msg: DapRequest): void {
    // Stage 2: when a trace cursor is loaded, advance / rewind it
    // by one step per request and re-fire `stopped` so VSCode
    // refreshes the Call Stack panel. Source-position-aware
    // step-over / step-in / step-out semantics land in stage 3.
    if (this.cursor) {
      if (msg.command === "continue") {
        this.cursor.seek(this.cursor.length);
      } else if (msg.command === "stepOut") {
        // Without source-position info we can't compute the matching
        // call's exit. Until stage 3 lands, treat stepOut as continue.
        this.cursor.seek(this.cursor.length);
      } else {
        this.cursor.next();
      }
      if (this.cursor.isAtEnd) {
        this.respond(msg, true);
        this.fireEvent("terminated");
        return;
      }
    }
    this.respond(msg, true);
    this.fireEvent("stopped", {
      reason: "step",
      threadId: 1,
      allThreadsStopped: true,
    });
  }

  private handleTerminate(msg: DapRequest): void {
    this.respond(msg, true);
    this.fireEvent("terminated");
    this.fireEvent("exited", { exitCode: 0 });
  }

  // ── Wire helpers ──────────────────────────────────────────────────

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

// ── Local DAP type aliases ──────────────────────────────────────────
//
// We avoid pulling `@vscode/debugprotocol` for the scaffold. The
// shape is documented at https://microsoft.github.io/debug-adapter-protocol/
// and we only touch a handful of fields per request.

interface DapRequest {
  seq: number;
  type: "request";
  command: string;
  arguments?: unknown;
}

/** `launch` request arguments — kept loose; concrete properties land per stage. */
interface LaunchArguments {
  program?: string;
  test?: string;
  stopOnEntry?: boolean;
  /**
   * Path to a JSON file with a pre-saved EVM trace
   * (`cast run --json <txhash> > trace.json` is the canonical
   * source). Stage 2 escape hatch until stage 3 wires the live
   * `forge test --debug --json` execution path.
   */
  traceFile?: string;
}
