import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  findForgeRoot,
  parseYulOutline,
  findYulFunctionByName,
  type YulOutline,
  type YulFunction,
  type YulFunctionCategory,
} from "@solidity-workbench/common";

/**
 * Per-function delta vs a pinned baseline. `lineDelta` is positive
 * when the function grew in the current output, negative when it
 * shrunk. `state` distinguishes an entirely-new function (`added`),
 * a removed-but-still-flagged-in-summary function (`removed`), or a
 * surviving function whose body changed (`changed`).
 */
type FunctionDelta =
  | { state: "added"; lineDelta: number }
  | { state: "removed"; lineDelta: number }
  | { state: "changed"; lineDelta: number };

const execFileAsync = promisify(execFile);

/**
 * IR Viewer — webview that dumps `forge inspect <Contract> ir` /
 * `irOptimized` / `assembly` into a syntax-styled listing alongside a
 * function-level table of contents parsed from the Yul output.
 *
 * Designed for iterative optimization work: pick a contract, see the
 * compiler's view of your code, and use the TOC to jump between
 * specific functions instead of scrolling through tens of thousands
 * of lines of utility helpers.
 *
 * The TOC groups Yul functions into intent-bearing buckets (external
 * dispatchers, user functions, getters, runtime helpers, etc.) and
 * renders user-defined functions with their demangled Solidity name
 * up-front and the AST id in subscript so overloads disambiguate.
 *
 * The assembly variant skips the TOC — `forge inspect ... assembly`
 * is an opcode listing, not Yul.
 */
/** Window after the last save burst before we re-run forge inspect. */
const AUTO_REFRESH_DEBOUNCE_MS = 600;

export class IrViewerPanel {
  private panel: vscode.WebviewPanel | undefined;
  private state: PanelState | undefined;
  private autoRefreshTimer: NodeJS.Timeout | undefined;

  activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.commands.registerCommand("solidity-workbench.viewIR", () => this.openFromEditor()),
      vscode.workspace.onDidSaveTextDocument((doc) => this.onDocumentSaved(doc)),
      {
        dispose: () => {
          if (this.autoRefreshTimer !== undefined) {
            clearTimeout(this.autoRefreshTimer);
            this.autoRefreshTimer = undefined;
          }
        },
      },
    );
  }

  /**
   * Re-run forge inspect when any `.sol` file in the same forge root
   * as the active panel is saved. Saves to unrelated workspaces (a
   * different Foundry project in a multi-root setup, a stray
   * non-project file) leave the panel alone.
   *
   * Debounced so a fmt-on-save plus user-save burst — or a
   * codegen-watcher writing several files in quick succession — only
   * triggers one refresh.
   */
  private onDocumentSaved(doc: vscode.TextDocument): void {
    if (!this.panel || !this.state) return;
    if (doc.languageId !== "solidity") return;
    const docRoot = findForgeRoot(doc.uri.fsPath);
    const stateRoot = findForgeRoot(this.state.filePath);
    if (!docRoot || !stateRoot || docRoot !== stateRoot) return;
    this.scheduleAutoRefresh();
  }

  private scheduleAutoRefresh(): void {
    if (this.autoRefreshTimer !== undefined) clearTimeout(this.autoRefreshTimer);
    this.autoRefreshTimer = setTimeout(() => {
      this.autoRefreshTimer = undefined;
      if (this.panel && this.state) void this.refresh();
    }, AUTO_REFRESH_DEBOUNCE_MS);
  }

  /**
   * Triggered from the command palette / context menu. Resolves the
   * contract from the active editor (or prompts when ambiguous) and
   * remembers the function under the cursor so we can jump to its
   * Yul block once the dump arrives.
   */
  private async openFromEditor(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== "solidity") {
      vscode.window.showWarningMessage("Open a Solidity file first.");
      return;
    }

    const text = editor.document.getText();
    const contractName = await this.pickContract(text);
    if (!contractName) return;

    const cursorFunctionName = findEnclosingFunctionName(text, editor.selection.active.line);

    await this.show({
      filePath: editor.document.uri.fsPath,
      contractName,
      variant: "irOptimized",
      cursorFunctionName,
      baseline: null,
    });
  }

  private async pickContract(text: string): Promise<string | undefined> {
    const names = [...text.matchAll(/(?:abstract\s+)?contract\s+(\w+)/g)].map((m) => m[1]);
    if (names.length === 0) {
      vscode.window.showWarningMessage("No contract found in this file.");
      return undefined;
    }
    if (names.length === 1) return names[0];
    return vscode.window.showQuickPick(names, {
      placeHolder: "Select a contract to inspect",
    });
  }

  private async show(state: PanelState): Promise<void> {
    this.state = state;

    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "solidity-workbench-ir-viewer",
        `IR: ${state.contractName}`,
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.state = undefined;
        if (this.autoRefreshTimer !== undefined) {
          clearTimeout(this.autoRefreshTimer);
          this.autoRefreshTimer = undefined;
        }
      });
      this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    }
    this.panel.title = `IR: ${state.contractName}`;
    this.panel.webview.html = this.buildLoadingHtml(state);
    await this.refresh();
  }

  /** (Re-)run `forge inspect` for the current state and rebuild the panel HTML. */
  private async refresh(): Promise<void> {
    if (!this.panel || !this.state) return;
    const result = await this.runForgeInspect(this.state);
    if (!this.panel) return;
    if (result.error) {
      this.panel.webview.html = this.buildErrorHtml(this.state, result.error);
      return;
    }
    const output = result.output ?? "";
    const outline = this.state.variant === "assembly" ? null : parseYulOutline(output);
    const initialAnchor =
      outline && this.state.cursorFunctionName
        ? findYulFunctionByName(outline, this.state.cursorFunctionName)?.startLine
        : undefined;
    // Deltas only make sense when both sides are the same variant —
    // a baseline pinned in `irOptimized` shouldn't compare against
    // `ir` line counts.
    const deltas =
      this.state.baseline && outline && this.state.baseline.variant === this.state.variant
        ? computeFunctionDeltas(this.state.baseline.outline, outline)
        : null;
    this.panel.webview.html = this.buildHtml(this.state, output, outline, initialAnchor, deltas);
  }

  private handleMessage(msg: PanelMessage): void {
    if (!this.state) return;
    if (msg.type === "selectVariant") {
      this.state = {
        ...this.state,
        variant: msg.variant,
        cursorFunctionName: null,
        // Drop the baseline on variant switch — line counts across
        // variants aren't comparable.
        baseline:
          this.state.baseline && this.state.baseline.variant === msg.variant
            ? this.state.baseline
            : null,
      };
      void this.refresh();
    } else if (msg.type === "refresh") {
      void this.refresh();
    } else if (msg.type === "pinBaseline") {
      void this.pinBaseline();
    } else if (msg.type === "clearBaseline") {
      this.state = { ...this.state, baseline: null };
      void this.refresh();
    }
  }

  private async pinBaseline(): Promise<void> {
    if (!this.state) return;
    const result = await this.runForgeInspect(this.state);
    if (result.error || !this.state) return;
    const output = result.output ?? "";
    const outline = this.state.variant === "assembly" ? null : parseYulOutline(output);
    this.state = {
      ...this.state,
      baseline: {
        variant: this.state.variant,
        output,
        outline,
        capturedAt: new Date().toISOString(),
      },
    };
    void this.refresh();
  }

  private async runForgeInspect(state: PanelState): Promise<InspectResult> {
    const forgeRoot = findForgeRoot(state.filePath);
    if (!forgeRoot) {
      return {
        error: `No foundry.toml found walking up from ${state.filePath}. Is this file inside a Foundry project?`,
      };
    }
    const config = vscode.workspace.getConfiguration("solidity-workbench");
    const forgePath = config.get<string>("foundryPath") || "forge";
    const field = state.variant; // forge inspect accepts these field names verbatim
    try {
      const { stdout } = await execFileAsync(
        forgePath,
        ["inspect", state.contractName, field],
        {
          cwd: forgeRoot,
          maxBuffer: 64 * 1024 * 1024,
          timeout: 120_000,
        },
      );
      return { output: stdout };
    } catch (err: any) {
      const message =
        (err.stderr ?? "").toString().trim() ||
        (err.stdout ?? "").toString().trim() ||
        err.message ||
        String(err);
      return { error: message };
    }
  }

  // ── HTML ──────────────────────────────────────────────────────────

  private buildLoadingHtml(state: PanelState): string {
    return `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:16px">
<h2 style="margin-top:0">IR: ${escapeHtml(state.contractName)}</h2>
<p>Running <code>forge inspect ${escapeHtml(state.contractName)} ${escapeHtml(state.variant)}</code>…</p>
</body></html>`;
  }

  private buildErrorHtml(state: PanelState, error: string): string {
    return `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:16px">
${this.toolbarHtml(state)}
<h3 style="color:var(--vscode-errorForeground)">forge inspect failed</h3>
<pre style="white-space:pre-wrap;font-family:var(--vscode-editor-font-family);background:var(--vscode-textCodeBlock-background);padding:12px;border-radius:4px">${escapeHtml(error)}</pre>
</body></html>`;
  }

  private buildHtml(
    state: PanelState,
    output: string,
    outline: YulOutline | null,
    initialAnchor: number | undefined,
    deltas: Map<string, FunctionDelta> | null,
  ): string {
    const tocHtml = outline ? this.buildTocHtml(outline, deltas) : "";
    const codeHtml = renderNumberedCode(output);
    const initialAnchorAttr =
      initialAnchor !== undefined ? ` data-initial-anchor="${initialAnchor}"` : "";
    const variantAttr = ` data-variant="${escapeHtml(state.variant)}"`;
    return `<!DOCTYPE html>
<html>
<head>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 0; }
  .toolbar { padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .toolbar h2 { margin: 0; font-size: 1.05em; flex: 1 1 auto; }
  .toolbar select, .toolbar button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-button-border, transparent); padding: 4px 10px; border-radius: 3px; cursor: pointer; font-family: inherit; font-size: 0.9em; }
  .toolbar button:hover, .toolbar select:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .layout { display: flex; height: calc(100vh - 50px); }
  .toc { width: 280px; min-width: 200px; max-width: 360px; resize: horizontal; overflow: auto; border-right: 1px solid var(--vscode-panel-border); padding: 8px 4px 8px 12px; font-size: 0.92em; }
  .toc details { margin: 4px 0; }
  .toc summary { cursor: pointer; padding: 2px 4px; user-select: none; opacity: 0.85; font-weight: 600; }
  .toc summary:hover { opacity: 1; }
  .toc .group-count { opacity: 0.5; font-weight: normal; margin-left: 4px; }
  .toc a { display: block; padding: 2px 4px 2px 16px; color: var(--vscode-foreground); text-decoration: none; border-radius: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .toc a:hover { background: var(--vscode-list-hoverBackground); }
  .toc .ast-id { opacity: 0.45; font-size: 0.85em; margin-left: 4px; }
  .toc .mangled { opacity: 0.55; font-size: 0.82em; font-family: var(--vscode-editor-font-family); }
  .code { flex: 1 1 auto; overflow: auto; }
  pre.listing { margin: 0; padding: 0; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size, 13px); line-height: 1.5; }
  pre.listing .line { display: flex; padding: 0 8px; min-height: 1.5em; }
  pre.listing .line:hover { background: var(--vscode-list-hoverBackground); }
  pre.listing .line:target { background: var(--vscode-editor-findMatchHighlightBackground); }
  pre.listing .line-no { width: 4em; text-align: right; padding-right: 12px; color: var(--vscode-editorLineNumber-foreground); flex: 0 0 auto; user-select: none; }
  pre.listing .line-text { flex: 1 1 auto; white-space: pre; }
  .stats { padding: 6px 12px; border-top: 1px solid var(--vscode-panel-border); font-size: 0.85em; opacity: 0.7; display: flex; gap: 16px; }
  .toc .delta { font-size: 0.78em; font-family: var(--vscode-editor-font-family); padding: 0 4px; margin-left: 4px; border-radius: 3px; }
  .toc .delta.added { background: rgba(80, 180, 80, 0.2); color: #6fce6f; }
  .toc .delta.removed { background: rgba(220, 80, 80, 0.2); color: #ec7676; }
  .toc .delta.grew { background: rgba(220, 130, 60, 0.2); color: #e9a55a; }
  .toc .delta.shrunk { background: rgba(80, 180, 80, 0.2); color: #6fce6f; }
  .baseline-banner { padding: 4px 12px; background: var(--vscode-textCodeBlock-background); border-bottom: 1px solid var(--vscode-panel-border); font-size: 0.85em; opacity: 0.85; display: flex; gap: 16px; align-items: center; }
  .baseline-banner .summary { display: flex; gap: 12px; }
  .baseline-banner .net { font-weight: 600; }
  .baseline-banner .net.positive { color: #ec7676; }
  .baseline-banner .net.negative { color: #6fce6f; }
</style>
</head>
<body${variantAttr}${initialAnchorAttr}>
${this.toolbarHtml(state)}
${this.baselineBannerHtml(state, deltas)}
<div class="layout">
  ${outline ? `<aside class="toc">${tocHtml}</aside>` : ""}
  <div class="code">
    <pre class="listing">${codeHtml}</pre>
    <div class="stats">
      <span>${output.split("\n").length.toLocaleString()} lines</span>
      ${outline ? `<span>${outline.objects.reduce((s, o) => s + o.functions.length, 0)} Yul functions</span>` : ""}
      <span>variant: ${escapeHtml(state.variant)}</span>
    </div>
  </div>
</div>
<script>
  const vscode = acquireVsCodeApi();
  const variant = document.body.dataset.variant;
  const initialAnchor = document.body.dataset.initialAnchor;
  const codeEl = document.querySelector('.code');

  document.getElementById('variant')?.addEventListener('change', (e) => {
    vscode.postMessage({ type: 'selectVariant', variant: e.target.value });
  });
  document.getElementById('refresh')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'refresh' });
  });
  document.getElementById('pin-baseline')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'pinBaseline' });
  });
  document.getElementById('clear-baseline')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'clearBaseline' });
  });

  // Restore per-variant scroll position across panel rebuilds (variant
  // switches, auto-refresh on save, manual refresh) — but if the host
  // gave us an explicit anchor (cursor-aware open), honor that first.
  const persisted = vscode.getState() ?? {};
  const variantState = persisted[variant];
  if (initialAnchor) {
    const el = document.getElementById('L' + initialAnchor);
    if (el) el.scrollIntoView({ block: 'center' });
  } else if (codeEl && variantState && typeof variantState.scrollTop === 'number') {
    requestAnimationFrame(() => { codeEl.scrollTop = variantState.scrollTop; });
  }

  if (codeEl) {
    let pending = null;
    codeEl.addEventListener('scroll', () => {
      if (pending !== null) cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => {
        const next = vscode.getState() ?? {};
        next[variant] = { scrollTop: codeEl.scrollTop };
        vscode.setState(next);
        pending = null;
      });
    }, { passive: true });
  }
</script>
</body>
</html>`;
  }

  private toolbarHtml(state: PanelState): string {
    const variants: { value: IrVariant; label: string }[] = [
      { value: "irOptimized", label: "Yul (optimized)" },
      { value: "ir", label: "Yul (raw)" },
      { value: "assembly", label: "EVM assembly" },
    ];
    const options = variants
      .map(
        (v) =>
          `<option value="${v.value}"${v.value === state.variant ? " selected" : ""}>${v.label}</option>`,
      )
      .join("");
    const baselineButton =
      state.baseline && state.baseline.variant === state.variant
        ? `<button id="clear-baseline">Clear baseline</button>`
        : `<button id="pin-baseline" title="Capture this output as a baseline; subsequent refreshes show per-function deltas in the TOC.">Pin baseline</button>`;
    return `<div class="toolbar">
  <h2>IR: ${escapeHtml(state.contractName)}</h2>
  <select id="variant">${options}</select>
  ${baselineButton}
  <button id="refresh">Refresh</button>
</div>`;
  }

  private baselineBannerHtml(
    state: PanelState,
    deltas: Map<string, FunctionDelta> | null,
  ): string {
    if (!state.baseline || state.baseline.variant !== state.variant) return "";
    const captured = new Date(state.baseline.capturedAt);
    const time = captured.toLocaleTimeString();
    let added = 0;
    let removed = 0;
    let grew = 0;
    let shrunk = 0;
    let net = 0;
    if (deltas) {
      for (const d of deltas.values()) {
        net += d.lineDelta;
        if (d.state === "added") added += 1;
        else if (d.state === "removed") removed += 1;
        else if (d.lineDelta > 0) grew += 1;
        else if (d.lineDelta < 0) shrunk += 1;
      }
    }
    const netClass = net > 0 ? "positive" : net < 0 ? "negative" : "";
    const netLabel = net === 0 ? "no net change" : net > 0 ? `+${net} lines` : `${net} lines`;
    return `<div class="baseline-banner">
  <span>Baseline pinned ${escapeHtml(time)}</span>
  <span class="summary">
    <span class="net ${netClass}">${escapeHtml(netLabel)}</span>
    <span>+${added} added</span>
    <span>-${removed} removed</span>
    <span>▲ ${grew} grew</span>
    <span>▼ ${shrunk} shrunk</span>
  </span>
</div>`;
  }

  private buildTocHtml(
    outline: YulOutline,
    deltas: Map<string, FunctionDelta> | null,
  ): string {
    return outline.objects
      .map((obj) => {
        const groups = groupFunctions(obj.functions);
        const groupHtml = groups
          .map((g) => {
            if (g.functions.length === 0) return "";
            const items = g.functions.map((fn) => this.tocEntry(fn, deltas)).join("");
            const open = g.startsExpanded ? " open" : "";
            return `<details${open}>
              <summary>${escapeHtml(g.label)}<span class="group-count">${g.functions.length}</span></summary>
              ${items}
            </details>`;
          })
          .join("");
        // Surface "removed" entries (in baseline but not current) as a
        // ghost section per object so the user can see what disappeared.
        const removedHtml = deltas ? this.removedEntriesHtml(obj.name, deltas) : "";
        return `<details open><summary>${escapeHtml(obj.name)}</summary>${groupHtml}${removedHtml}</details>`;
      })
      .join("");
  }

  private tocEntry(fn: YulFunction, deltas: Map<string, FunctionDelta> | null): string {
    const display = fn.displayName ?? fn.name;
    const idTag = fn.astId ? `<span class="ast-id">#${escapeHtml(fn.astId)}</span>` : "";
    const showMangled = fn.displayName !== null && fn.displayName !== fn.name;
    const mangledTag = showMangled ? `<div class="mangled">${escapeHtml(fn.name)}</div>` : "";
    const deltaTag = deltas ? this.deltaTag(deltas.get(fn.name)) : "";
    return `<a href="#L${fn.startLine}" title="${escapeHtml(fn.name)} — line ${fn.startLine}">${escapeHtml(display)}${idTag}${deltaTag}${mangledTag}</a>`;
  }

  private deltaTag(delta: FunctionDelta | undefined): string {
    if (!delta) return "";
    if (delta.state === "added") return `<span class="delta added">new</span>`;
    if (delta.state === "removed") return `<span class="delta removed">gone</span>`;
    if (delta.lineDelta > 0) return `<span class="delta grew">+${delta.lineDelta}</span>`;
    if (delta.lineDelta < 0) return `<span class="delta shrunk">${delta.lineDelta}</span>`;
    return "";
  }

  private removedEntriesHtml(objectName: string, deltas: Map<string, FunctionDelta>): string {
    const removed = [...deltas]
      .filter(([, d]) => d.state === "removed")
      .map(([name]) => name);
    if (removed.length === 0) return "";
    void objectName; // baseline outline is per-object too; for MVP we list all removed under their object.
    const items = removed
      .map(
        (name) =>
          `<a class="removed-entry" title="Present in the pinned baseline but missing from the current output."><span style="opacity:0.6;text-decoration:line-through">${escapeHtml(name)}</span><span class="delta removed">gone</span></a>`,
      )
      .join("");
    return `<details><summary>Removed since baseline<span class="group-count">${removed.length}</span></summary>${items}</details>`;
  }
}

interface PanelState {
  filePath: string;
  contractName: string;
  variant: IrVariant;
  /** Solidity function name the cursor was on when the panel was opened. */
  cursorFunctionName: string | null;
  /**
   * Pinned snapshot of a previous forge-inspect output. Used to
   * compute per-function deltas after subsequent refreshes — the core
   * "did my refactor save anything?" workflow. Cleared on variant
   * switch since deltas across variants don't make sense.
   */
  baseline: PinnedBaseline | null;
}

interface PinnedBaseline {
  variant: IrVariant;
  output: string;
  outline: YulOutline | null;
  /** ISO timestamp when the baseline was captured, for the toolbar caption. */
  capturedAt: string;
}

type IrVariant = "ir" | "irOptimized" | "assembly";

interface InspectResult {
  output?: string;
  error?: string;
}

type PanelMessage =
  | { type: "selectVariant"; variant: IrVariant }
  | { type: "refresh" }
  | { type: "pinBaseline" }
  | { type: "clearBaseline" };

interface FunctionGroup {
  label: string;
  functions: YulFunction[];
  startsExpanded: boolean;
}

/**
 * Bucket functions by category into TOC sections, ordered to put
 * what-the-user-asked-about first (external entries, internals,
 * constructor) and runtime utilities last (collapsed by default).
 */
function groupFunctions(fns: YulFunction[]): FunctionGroup[] {
  const buckets: Record<YulFunctionCategory, YulFunction[]> = {
    external: [],
    internal: [],
    getter: [],
    constructor: [],
    modifier: [],
    abi: [],
    cleanup: [],
    revert: [],
    storage: [],
    memory: [],
    math: [],
    util: [],
  };
  for (const fn of fns) buckets[fn.category].push(fn);
  return [
    { label: "External entries", functions: buckets.external, startsExpanded: true },
    { label: "Functions", functions: buckets.internal, startsExpanded: true },
    { label: "Getters", functions: buckets.getter, startsExpanded: true },
    { label: "Constructor", functions: buckets.constructor, startsExpanded: true },
    { label: "Modifiers", functions: buckets.modifier, startsExpanded: true },
    { label: "ABI helpers", functions: buckets.abi, startsExpanded: false },
    { label: "Storage helpers", functions: buckets.storage, startsExpanded: false },
    { label: "Memory helpers", functions: buckets.memory, startsExpanded: false },
    { label: "Math helpers", functions: buckets.math, startsExpanded: false },
    { label: "Reverts / panics", functions: buckets.revert, startsExpanded: false },
    { label: "Cleanup / validators", functions: buckets.cleanup, startsExpanded: false },
    { label: "Other", functions: buckets.util, startsExpanded: false },
  ];
}

/**
 * Find the nearest enclosing `function NAME(...)` walking backwards
 * from `cursorLine`. Returns `null` if no function header is above
 * the cursor in the file. This is a heuristic — we don't validate
 * that the cursor is actually inside the body — but it's good enough
 * to seed the IR Viewer's auto-scroll behavior.
 */
function findEnclosingFunctionName(text: string, cursorLine: number): string | null {
  const lines = text.split("\n");
  const target = Math.min(cursorLine, lines.length - 1);
  for (let i = target; i >= 0; i--) {
    const m = /^\s*function\s+(\w+)\s*\(/.exec(lines[i]);
    if (m) return m[1];
  }
  return null;
}

/**
 * Compute per-function deltas between a pinned baseline outline and
 * the current outline. Functions are matched by mangled name (which
 * includes the source AST id, so it's stable across recompiles
 * unless the source AST itself changed).
 *
 *   - In current only        -> { state: "added",   lineDelta: +N }
 *   - In baseline only       -> { state: "removed", lineDelta: -N }
 *   - In both, body-line delta != 0 -> { state: "changed", lineDelta }
 *   - In both, identical line count  -> NOT included (no surprise to surface)
 *
 * The line count is the function's body line span; counts are
 * approximate (header + closing brace included) but stable across
 * runs, which is what matters for the "did this change?" comparison.
 */
function computeFunctionDeltas(
  baseline: YulOutline | null,
  current: YulOutline,
): Map<string, FunctionDelta> {
  const deltas = new Map<string, FunctionDelta>();
  if (!baseline) {
    for (const obj of current.objects) {
      for (const fn of obj.functions) {
        deltas.set(fn.name, { state: "added", lineDelta: fn.endLine - fn.startLine + 1 });
      }
    }
    return deltas;
  }
  const baselineLineCounts = new Map<string, number>();
  for (const obj of baseline.objects) {
    for (const fn of obj.functions) {
      baselineLineCounts.set(fn.name, fn.endLine - fn.startLine + 1);
    }
  }
  const currentSeen = new Set<string>();
  for (const obj of current.objects) {
    for (const fn of obj.functions) {
      currentSeen.add(fn.name);
      const curLines = fn.endLine - fn.startLine + 1;
      const baseLines = baselineLineCounts.get(fn.name);
      if (baseLines === undefined) {
        deltas.set(fn.name, { state: "added", lineDelta: curLines });
      } else if (baseLines !== curLines) {
        deltas.set(fn.name, { state: "changed", lineDelta: curLines - baseLines });
      }
    }
  }
  for (const [name, baseLines] of baselineLineCounts) {
    if (!currentSeen.has(name)) {
      deltas.set(name, { state: "removed", lineDelta: -baseLines });
    }
  }
  return deltas;
}

function renderNumberedCode(source: string): string {
  const lines = source.split("\n");
  let html = "";
  for (let i = 0; i < lines.length; i++) {
    const num = i + 1;
    html += `<div class="line" id="L${num}"><span class="line-no">${num}</span><span class="line-text">${escapeHtml(lines[i]) || "&nbsp;"}</span></div>`;
  }
  return html;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
