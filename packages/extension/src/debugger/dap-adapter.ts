import * as vscode from "vscode";

/**
 * Solidity Workbench Debug Adapter Protocol (DAP) skeleton.
 *
 * Stage 1 — scaffold only. This commit lights up the plumbing
 * needed for VSCode's "Run and Debug" panel to recognise our debug
 * type, accept a launch configuration, advertise capabilities, and
 * report a (stubbed) initial stop. No EVM tracing or source-map
 * resolution is wired up yet — those land in subsequent commits as
 * the foundation matures (see PRODUCTION_GAPS.md > "DAP debugger").
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
 */
export class SolidityDapAdapter implements vscode.DebugAdapter {
  private readonly _onDidSendMessage = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  readonly onDidSendMessage = this._onDidSendMessage.event;

  private seq = 0;

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
    const args = msg.arguments as LaunchArguments | undefined;
    void args;
    // Stage 1: acknowledge the launch and immediately report a
    // stopped-on-entry event with one synthetic thread. Future
    // stages will spawn `forge test --debug --json`, parse the
    // resulting trace, and walk it with the source-map module
    // landed in the previous commit.
    this.respond(msg, true);
    this.fireEvent("stopped", {
      reason: "entry",
      threadId: 1,
      allThreadsStopped: true,
      description: "EVM trace not yet implemented — adapter scaffold only",
    });
  }

  private handleThreads(msg: DapRequest): void {
    this.respond(msg, true, {
      threads: [{ id: 1, name: "EVM" }],
    });
  }

  private handleStackTrace(msg: DapRequest): void {
    // Stage 1 reports an empty stack with a placeholder frame so
    // the user sees something meaningful in the Call Stack panel
    // rather than a confusing blank.
    this.respond(msg, true, {
      stackFrames: [
        {
          id: 0,
          name: "(EVM trace not yet wired)",
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
    // Stage 1: stepping is a no-op. We acknowledge the request and
    // re-fire `stopped` so VSCode keeps the debugee in a "paused"
    // state. Subsequent stages will advance the trace cursor.
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
}
