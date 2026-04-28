import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import * as vscode from "vscode";
import {
  ChiselOutputBuffer,
  classifyBody,
  findForgeRoot,
  type ChiselEvalResult,
} from "@solidity-workbench/common";

/**
 * Chisel REPL — webview panel that drives a long-lived `chisel`
 * subprocess and renders each evaluation as a card. Replaces the
 * legacy `vscode.Terminal` wrapper at `views/chisel.ts`.
 *
 * Design notes:
 *
 * - The subprocess is spawned with default piped stdio. Chisel's
 *   reedline frontend disables prompt rendering when stdout is not a
 *   TTY, so we can't pair inputs to outputs by prompt sentinels.
 *   Instead we pair them by a quiet-window heuristic: after the user
 *   sends an expression we wait for chisel's stdout to fall silent
 *   for `QUIET_WINDOW_MS`, then drain whatever's been buffered. See
 *   `@solidity-workbench/common/chisel-output.ts` for the parser.
 * - History is persisted to `globalState` under
 *   `solidity-workbench.chisel.history`, capped at 200 entries.
 * - The subprocess is terminated on panel disposal AND on extension
 *   `deactivate()` so it doesn't outlive a VSCode reload. The hook
 *   into `context.subscriptions` is what fires on deactivate.
 */

/** ms of stdout silence after sending input that constitute "complete". */
const QUIET_WINDOW_MS = 250;

/** Max persisted history entries. */
const HISTORY_LIMIT = 200;

/** globalState key. */
const HISTORY_KEY = "solidity-workbench.chisel.history";

/** Time-box `sendSelection`'s wait for chisel's first ready. */
const SEND_SELECTION_READY_TIMEOUT_MS = 5_000;

/** A single persisted evaluation history entry. */
export interface ChiselHistoryEntry {
  expression: string;
  response: string;
  status: "ok" | "error";
  timestampMs: number;
}

type ChiselMode = { kind: "fresh" } | { kind: "fork"; rpcUrl: string };

interface PendingExpression {
  expression: string;
  source: "user" | "rerun" | "selection";
}

export class ChiselPanel {
  private context!: vscode.ExtensionContext;

  private panel: vscode.WebviewPanel | undefined;
  private process: ChildProcess | undefined;
  private outputBuffer: ChiselOutputBuffer | undefined;

  private mode: ChiselMode = { kind: "fresh" };
  /** FIFO of expressions awaiting their result body. */
  private pending: PendingExpression[] = [];
  /** Timer for the quiet-window flush. */
  private quietTimer: NodeJS.Timeout | undefined;
  /** Resolves the next time the parser flips to ready. */
  private readyWaiters: Array<() => void> = [];

  activate(context: vscode.ExtensionContext): void {
    this.context = context;

    context.subscriptions.push(
      vscode.commands.registerCommand("solidity-workbench.chisel.start", async () => {
        await this.start({ kind: "fresh" });
      }),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand("solidity-workbench.chisel.startFork", async () => {
        const rpcUrl = await vscode.window.showInputBox({
          title: "Fork RPC URL",
          placeHolder: "https://eth-mainnet.g.alchemy.com/v2/...",
          prompt: "Enter an RPC URL to fork from",
        });
        if (!rpcUrl) return;
        await this.start({ kind: "fork", rpcUrl });
      }),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand("solidity-workbench.chisel.sendSelection", async () => {
        await this.sendSelection();
      }),
    );

    // Tear down the subprocess when the extension deactivates so a
    // VSCode reload doesn't leak a chisel process.
    context.subscriptions.push({
      dispose: () => {
        void this.terminate();
      },
    });
  }

  /** Public API used by the activate handlers and `sendSelection`. */
  private async start(mode: ChiselMode): Promise<void> {
    this.mode = mode;
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      // If the existing subprocess is dead or we're switching modes,
      // restart it; otherwise just refresh the title.
      if (!this.process || this.process.exitCode !== null) {
        this.spawnChisel();
      }
    } else {
      this.showPanel();
      this.spawnChisel();
    }
  }

  /**
   * Terminate the subprocess (SIGTERM with a 1-second SIGKILL fallback).
   * Safe to call multiple times.
   */
  async terminate(): Promise<void> {
    const proc = this.process;
    this.process = undefined;
    if (this.quietTimer) {
      clearTimeout(this.quietTimer);
      this.quietTimer = undefined;
    }
    if (!proc || proc.exitCode !== null) return;
    proc.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already dead */
        }
        resolve();
      }, 1_000);
      proc.once("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });
    });
  }

  // ── Panel + webview wiring ────────────────────────────────────────

  private showPanel(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "solidity-workbench-chisel",
      this.panelTitle(),
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.webview.html = this.buildHtml(this.panel.webview);

    this.panel.onDidDispose(() => {
      this.panel = undefined;
      void this.terminate();
    });

    this.panel.webview.onDidReceiveMessage((msg) => this.onWebviewMessage(msg));

    // Send the initial state once the webview is ready to receive
    // postMessage. The HTML's inline script calls back via `ready`
    // when it's mounted.
  }

  private panelTitle(): string {
    if (this.mode.kind === "fork") {
      let host = "fork";
      try {
        host = new URL(this.mode.rpcUrl).host;
      } catch {
        /* fall back to the literal "fork" label */
      }
      return `Chisel (fork: ${host})`;
    }
    return "Chisel";
  }

  private async onWebviewMessage(msg: unknown): Promise<void> {
    if (!msg || typeof msg !== "object") return;
    const m = msg as { type?: string };
    switch (m.type) {
      case "uiReady":
        this.postInit();
        return;
      case "evaluate":
      case "rerun": {
        const expr = String((m as { expression?: unknown }).expression ?? "").trim();
        if (!expr) return;
        this.evaluate(expr, m.type === "rerun" ? "rerun" : "user");
        return;
      }
      case "clearHistory":
        await this.context.globalState.update(HISTORY_KEY, []);
        this.postInit();
        return;
      case "copy": {
        const text = String((m as { text?: unknown }).text ?? "");
        await vscode.env.clipboard.writeText(text);
        vscode.window.showInformationMessage("Copied to clipboard.");
        return;
      }
      case "restart":
        await this.terminate();
        this.spawnChisel();
        return;
    }
  }

  private postInit(): void {
    if (!this.panel) return;
    const history = this.readHistory();
    this.panel.webview.postMessage({
      type: "init",
      history,
      mode: this.mode.kind,
      forkUrl: this.mode.kind === "fork" ? this.mode.rpcUrl : undefined,
      title: this.panelTitle(),
    });
  }

  // ── History persistence ────────────────────────────────────────────

  private readHistory(): ChiselHistoryEntry[] {
    const raw = this.context.globalState.get<ChiselHistoryEntry[]>(HISTORY_KEY, []);
    return Array.isArray(raw) ? raw : [];
  }

  private async appendHistory(entry: ChiselHistoryEntry): Promise<void> {
    const next = [...this.readHistory(), entry];
    while (next.length > HISTORY_LIMIT) next.shift();
    await this.context.globalState.update(HISTORY_KEY, next);
  }

  // ── Subprocess lifecycle ───────────────────────────────────────────

  private resolveChiselPath(): string {
    const config = vscode.workspace.getConfiguration("solidity-workbench");
    const foundryPath = (config.get<string>("foundryPath") ?? "").trim();
    if (!foundryPath) return "chisel";
    // Treat foundryPath as a path to the `forge` binary; chisel lives
    // alongside it.
    return path.join(path.dirname(foundryPath), "chisel");
  }

  private spawnChisel(): void {
    const cwd = this.resolveCwd();
    const args: string[] = [];
    if (this.mode.kind === "fork") args.push("--fork-url", this.mode.rpcUrl);

    const buf = new ChiselOutputBuffer();
    this.outputBuffer = buf;
    this.pending = [];

    let proc: ChildProcess;
    try {
      proc = spawn(this.resolveChiselPath(), args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err: unknown) {
      this.postSubprocessError(err);
      return;
    }
    this.process = proc;

    proc.on("error", (err) => {
      this.postSubprocessError(err);
    });

    proc.on("exit", (code) => {
      if (this.process === proc) {
        this.process = undefined;
      }
      // Drain anything still buffered as a final result.
      const trailing = buf.splitNow();
      for (const r of trailing) this.consumeResult(r);
      if (this.panel) {
        this.panel.webview.postMessage({ type: "subprocessExit", code });
      }
    });

    proc.stdout?.on("data", (chunk: Buffer) => {
      const r = buf.push(chunk.toString("utf8"));
      if (r.ready) this.flipReady();
      this.scheduleQuietFlush();
    });

    // chisel writes compile / runtime diagnostics to stderr. Surface
    // them in-panel by synthesising a result entry per stderr chunk.
    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (!text) return;
      this.consumeResult({ body: text, isError: classifyBody(text) === "error" || true });
    });

    if (this.panel) this.postInit();
  }

  private resolveCwd(): string {
    const editor = vscode.window.activeTextEditor;
    const filePath = editor?.document.uri.fsPath;
    if (filePath) {
      const root = findForgeRoot(filePath);
      if (root) return root;
    }
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri.fsPath : process.cwd();
  }

  private postSubprocessError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    if (this.panel) {
      this.panel.webview.postMessage({ type: "subprocessError", message });
    }
    vscode.window.showErrorMessage(`Chisel: ${message}`);
  }

  // ── Quiet-window pairing ──────────────────────────────────────────

  private scheduleQuietFlush(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => {
      this.quietTimer = undefined;
      this.drainOnce();
    }, QUIET_WINDOW_MS);
  }

  private drainOnce(): void {
    if (!this.outputBuffer) return;
    const result = this.outputBuffer.flushQuiet();
    if (!result) return;
    this.consumeResult(result);
  }

  private consumeResult(result: ChiselEvalResult): void {
    // Pair to the head pending expression, if any. Chisel's REPL is
    // strictly serial so the head expression is what produced this
    // body.
    const pending = this.pending.shift();
    const expression = pending?.expression ?? "";
    const entry: ChiselHistoryEntry = {
      expression,
      response: result.body,
      status: result.isError ? "error" : "ok",
      timestampMs: Date.now(),
    };
    void this.appendHistory(entry);
    if (this.panel) {
      this.panel.webview.postMessage({ type: "result", entry });
    }
  }

  private flipReady(): void {
    if (this.panel) {
      this.panel.webview.postMessage({ type: "ready" });
    }
    const waiters = this.readyWaiters.splice(0);
    for (const fn of waiters) fn();
  }

  private waitForReady(timeoutMs: number): Promise<boolean> {
    if (this.outputBuffer?.isReady()) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const t = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((fn) => fn !== ok);
        resolve(false);
      }, timeoutMs);
      const ok = (): void => {
        clearTimeout(t);
        resolve(true);
      };
      this.readyWaiters.push(ok);
    });
  }

  // ── Evaluate path (used by webview AND sendSelection) ─────────────

  private evaluate(expression: string, source: PendingExpression["source"]): void {
    if (!this.process || this.process.exitCode !== null) {
      // Spawn-on-demand keeps "Re-run" working after a restart.
      this.spawnChisel();
    }
    const proc = this.process;
    if (!proc || !proc.stdin || proc.stdin.destroyed) return;

    this.pending.push({ expression, source });
    proc.stdin.write(expression + "\n");
    // Echo the expression as a "running" card so the user sees it
    // immediately. The result body arrives later via consumeResult.
    if (this.panel) {
      this.panel.webview.postMessage({ type: "evaluating", expression, source });
    }
  }

  // ── sendSelection ─────────────────────────────────────────────────

  private async sendSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage("Open a Solidity file first.");
      return;
    }
    const selection = editor.document.getText(editor.selection).trim();
    if (!selection) {
      vscode.window.showWarningMessage("Select some Solidity code to send to Chisel.");
      return;
    }

    if (!this.panel || !this.process || this.process.exitCode !== null) {
      await this.start({ kind: "fresh" });
      const ready = await this.waitForReady(SEND_SELECTION_READY_TIMEOUT_MS);
      if (!ready) {
        vscode.window.showWarningMessage(
          "Chisel did not become ready within 5s; try Run Chisel REPL first.",
        );
        return;
      }
    }

    this.evaluate(selection, "selection");
  }

  // ── HTML ──────────────────────────────────────────────────────────

  private buildHtml(webview: vscode.Webview): string {
    const cspSource = webview.cspSource;
    return `<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src ${cspSource} 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 0; margin: 0; display: flex; flex-direction: column; height: 100vh; box-sizing: border-box; }
  .toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); }
  .toolbar h2 { margin: 0; font-size: 0.95em; }
  .mode-badge { font-size: 0.75em; padding: 2px 8px; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .mode-badge.fork { background: #6e3a1a; color: #e5c07b; }
  .toolbar-spacer { flex: 1; }
  .btn { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 4px 10px; border-radius: 3px; cursor: pointer; font-size: 0.8em; font-family: inherit; }
  .btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .feed { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
  .empty { opacity: 0.6; font-size: 0.9em; text-align: center; padding: 24px; }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 8px 10px; background: var(--vscode-editor-inactiveSelectionBackground); }
  .card.error { border-left: 3px solid #e06c75; }
  .card.ok { border-left: 3px solid #4ec96e; }
  .card.pending { border-left: 3px solid #abb2bf; opacity: 0.85; }
  .card-head { display: flex; gap: 8px; align-items: flex-start; }
  .expr { flex: 1; font-family: var(--vscode-editor-font-family); font-size: 0.9em; white-space: pre-wrap; word-break: break-word; }
  .ts { font-size: 0.7em; opacity: 0.6; white-space: nowrap; padding-top: 2px; }
  .body { margin-top: 6px; font-family: var(--vscode-editor-font-family); font-size: 0.85em; white-space: pre-wrap; word-break: break-word; opacity: 0.9; }
  .source-tag { font-size: 0.65em; padding: 1px 5px; border-radius: 2px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); margin-left: 6px; }
  .actions { margin-top: 6px; display: flex; gap: 6px; }
  .input-area { border-top: 1px solid var(--vscode-panel-border); padding: 8px 12px; display: flex; gap: 8px; align-items: stretch; }
  textarea { flex: 1; min-height: 38px; max-height: 160px; resize: vertical; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; padding: 6px 8px; font-family: var(--vscode-editor-font-family); font-size: 0.9em; }
  textarea:disabled { opacity: 0.5; }
  .run-btn { min-width: 70px; }
  .status-line { font-size: 0.75em; opacity: 0.6; padding: 4px 12px; border-top: 1px solid var(--vscode-panel-border); }
</style>
</head>
<body>
  <div class="toolbar">
    <h2>Chisel</h2>
    <span id="mode-badge" class="mode-badge">starting…</span>
    <div class="toolbar-spacer"></div>
    <button class="btn" id="btn-restart">Restart</button>
    <button class="btn" id="btn-clear">Clear History</button>
  </div>

  <div class="feed" id="feed"></div>

  <div class="status-line" id="status">Waiting for chisel to start…</div>

  <div class="input-area">
    <textarea id="input" placeholder="Type a Solidity expression. Enter to run, Shift+Enter for newline." disabled></textarea>
    <button class="btn btn-primary run-btn" id="btn-run" disabled>Run</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const feed = document.getElementById('feed');
    const input = document.getElementById('input');
    const runBtn = document.getElementById('btn-run');
    const clearBtn = document.getElementById('btn-clear');
    const restartBtn = document.getElementById('btn-restart');
    const statusEl = document.getElementById('status');
    const modeBadge = document.getElementById('mode-badge');

    let history = [];
    /** Expressions sent but no result yet; matched in FIFO order. */
    const inflight = [];

    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    function fmtTs(ms) {
      try {
        const d = new Date(ms);
        return d.toLocaleTimeString();
      } catch {
        return '';
      }
    }

    function setReady(ready) {
      input.disabled = !ready;
      runBtn.disabled = !ready;
      if (ready) {
        statusEl.textContent = 'Ready.';
        input.focus();
      }
    }

    function setMode(mode, forkUrl, title) {
      if (mode === 'fork') {
        modeBadge.textContent = 'fork: ' + (forkUrl || '?');
        modeBadge.classList.add('fork');
      } else {
        modeBadge.textContent = 'fresh';
        modeBadge.classList.remove('fork');
      }
      if (title) document.title = title;
    }

    function renderEmpty() {
      if (history.length === 0 && inflight.length === 0) {
        if (!feed.querySelector('.empty')) {
          feed.innerHTML = '<div class="empty">No evaluations yet. Type an expression below.</div>';
        }
      }
    }

    function clearEmpty() {
      const e = feed.querySelector('.empty');
      if (e) e.remove();
    }

    function renderEntry(entry) {
      clearEmpty();
      const card = document.createElement('div');
      card.className = 'card ' + (entry.status === 'error' ? 'error' : 'ok');
      const exprText = entry.expression || '(no expression)';
      card.innerHTML =
        '<div class="card-head">' +
          '<div class="expr">' + escapeHtml(exprText) + '</div>' +
          '<div class="ts">' + escapeHtml(fmtTs(entry.timestampMs)) + '</div>' +
        '</div>' +
        '<div class="body">' + escapeHtml(entry.response) + '</div>' +
        '<div class="actions">' +
          '<button class="btn btn-rerun">Re-run</button>' +
          '<button class="btn btn-copy-expr">Copy expression</button>' +
          '<button class="btn btn-copy-resp">Copy response</button>' +
        '</div>';
      card.querySelector('.btn-rerun').addEventListener('click', () => {
        vscode.postMessage({ type: 'rerun', expression: entry.expression });
      });
      card.querySelector('.btn-copy-expr').addEventListener('click', () => {
        vscode.postMessage({ type: 'copy', text: entry.expression });
      });
      card.querySelector('.btn-copy-resp').addEventListener('click', () => {
        vscode.postMessage({ type: 'copy', text: entry.response });
      });
      feed.appendChild(card);
      feed.scrollTop = feed.scrollHeight;
    }

    function renderInflight(expression, source) {
      clearEmpty();
      const card = document.createElement('div');
      card.className = 'card pending';
      card.dataset.kind = 'inflight';
      const tag = source && source !== 'user'
        ? '<span class="source-tag">' + escapeHtml(source) + '</span>'
        : '';
      card.innerHTML =
        '<div class="card-head">' +
          '<div class="expr">' + escapeHtml(expression) + tag + '</div>' +
          '<div class="ts">running…</div>' +
        '</div>';
      feed.appendChild(card);
      feed.scrollTop = feed.scrollHeight;
      inflight.push(card);
    }

    function consumeInflight(entry) {
      const card = inflight.shift();
      if (card) card.remove();
      renderEntry(entry);
    }

    function renderAll() {
      feed.innerHTML = '';
      for (const entry of history) renderEntry(entry);
      renderEmpty();
    }

    runBtn.addEventListener('click', submit);
    clearBtn.addEventListener('click', () => vscode.postMessage({ type: 'clearHistory' }));
    restartBtn.addEventListener('click', () => {
      statusEl.textContent = 'Restarting chisel…';
      setReady(false);
      vscode.postMessage({ type: 'restart' });
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    });
    function submit() {
      const expr = input.value.trim();
      if (!expr) return;
      vscode.postMessage({ type: 'evaluate', expression: expr });
      input.value = '';
    }

    window.addEventListener('message', (event) => {
      const m = event.data;
      if (!m || typeof m !== 'object') return;
      switch (m.type) {
        case 'init':
          history = Array.isArray(m.history) ? m.history.slice() : [];
          renderAll();
          setMode(m.mode, m.forkUrl, m.title);
          // Wait for the explicit ready message before enabling input;
          // it arrives once chisel emits its banner.
          break;
        case 'ready':
          setReady(true);
          break;
        case 'result':
          history.push(m.entry);
          while (history.length > 200) history.shift();
          consumeInflight(m.entry);
          break;
        case 'evaluating':
          renderInflight(m.expression, m.source);
          break;
        case 'subprocessExit':
          setReady(false);
          statusEl.textContent = 'Chisel exited (code ' + (m.code === null ? 'null' : m.code) + '). Click Restart to run again.';
          // Drop any inflight cards — they won't get a result.
          while (inflight.length) {
            const c = inflight.pop();
            if (c) c.remove();
          }
          break;
        case 'subprocessError':
          setReady(false);
          statusEl.textContent = 'Chisel error: ' + m.message;
          break;
      }
    });

    // Tell the extension we're ready to receive the init message.
    vscode.postMessage({ type: 'uiReady' });
  </script>
</body>
</html>`;
  }
}
