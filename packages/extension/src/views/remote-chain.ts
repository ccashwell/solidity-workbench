import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { type AbiFunctionFragment, findForgeRoot } from "@solidity-workbench/common";

const execFileAsync = promisify(execFile);

/**
 * Remote Chain UI — webview that wraps `cast call` against a chain
 * picker, with ABI awareness so args are typed.
 *
 * Read-only in 0.3.2: write functions render as disabled options
 * with a tooltip ("writes require a private key — coming in a later
 * release"). `cast send`, Etherscan ABI fetch, multi-chain calls,
 * and gas estimation overlays are explicitly out of scope per the
 * implementation plan.
 *
 * # Plan deviations
 *
 * The 0.3.2 plan called for a two-stage `cast call → cast
 * decode-output --json` pipeline. `cast decode-output` does not
 * exist on Foundry 1.5 (the subcommand is `cast decode-abi`, and
 * even that has no `--json` flag). Instead we lean on cast's native
 * inline decoding: when the signature includes return types
 * (`name(in)(out)`), `cast call` already prints decoded values.
 * The panel therefore invokes cast twice in parallel — once with
 * the bare signature for raw hex, once with the with-returns
 * signature for decoded text — and renders both in the result card.
 */

/** A pre-configured chain entry. */
export interface ChainOption {
  /** Internal slug, also persisted as the last-selection key. */
  id: string;
  /** Human-readable label for the dropdown. */
  label: string;
  /** Public RPC URL. */
  rpcUrl: string;
  /** Display-only — `cast` discovers the chain id over RPC. */
  chainId: number;
}

/**
 * Public, no-API-key endpoints listed by the upstream chain teams /
 * the Foundry book / canonical chain documentation. Each entry
 * carries an inline comment naming the source per the
 * onchain-conventions rule. Users with an Alchemy / Infura URL
 * pick "Custom RPC URL…".
 */
const CHAINS: ChainOption[] = [
  {
    id: "mainnet",
    label: "Ethereum Mainnet",
    rpcUrl: "https://eth.llamarpc.com",
    chainId: 1,
  }, // public LlamaRPC
  {
    id: "sepolia",
    label: "Sepolia",
    rpcUrl: "https://sepolia.gateway.tenderly.co",
    chainId: 11155111,
  }, // Tenderly public gateway
  {
    id: "base",
    label: "Base",
    rpcUrl: "https://mainnet.base.org",
    chainId: 8453,
  }, // Coinbase official
  {
    id: "base-sepolia",
    label: "Base Sepolia",
    rpcUrl: "https://sepolia.base.org",
    chainId: 84532,
  }, // Coinbase official testnet
  {
    id: "optimism",
    label: "Optimism",
    rpcUrl: "https://mainnet.optimism.io",
    chainId: 10,
  }, // OP Labs official
  {
    id: "arbitrum",
    label: "Arbitrum One",
    rpcUrl: "https://arb1.arbitrum.io/rpc",
    chainId: 42161,
  }, // Offchain Labs official
  {
    id: "polygon",
    label: "Polygon PoS",
    rpcUrl: "https://polygon-rpc.com",
    chainId: 137,
  }, // Polygon official
];

interface RemoteChainSession {
  chainId: string;
  customRpcUrl?: string;
  contractAddress?: string;
  abiSource?: "paste" | "artifact";
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SESSION_KEY = "solidity-workbench.remoteChain.lastSession";

export class RemoteChainPanel {
  private context!: vscode.ExtensionContext;
  private panel: vscode.WebviewPanel | undefined;
  /** True while a `cast call` is in flight; second clicks are dropped. */
  private inFlight = false;

  activate(context: vscode.ExtensionContext): void {
    this.context = context;
    context.subscriptions.push(
      vscode.commands.registerCommand("solidity-workbench.remoteChain.open", () =>
        this.showPanel(),
      ),
    );
  }

  // ── Panel lifecycle ───────────────────────────────────────────────

  private showPanel(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      "solidity-workbench-remote-chain",
      "Remote Chain",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.webview.html = this.buildHtml(this.panel.webview);
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m));
  }

  private async onMessage(msg: unknown): Promise<void> {
    if (!msg || typeof msg !== "object") return;
    const m = msg as { type?: string };
    switch (m.type) {
      case "uiReady":
        this.postInit();
        return;
      case "selectChain": {
        const chainId = String((m as { chainId?: unknown }).chainId ?? "");
        const customRpcUrl = (m as { customRpcUrl?: string }).customRpcUrl;
        await this.persistSession((s) => ({ ...s, chainId, customRpcUrl }));
        return;
      }
      case "loadAbiPaste": {
        const json = String((m as { json?: unknown }).json ?? "");
        this.handleAbiPaste(json);
        return;
      }
      case "loadAbiArtifactRequest":
        await this.sendArtifactList();
        return;
      case "loadAbiArtifactPick": {
        const p = String((m as { path?: unknown }).path ?? "");
        const c = String((m as { contract?: unknown }).contract ?? "");
        await this.loadAbiFromArtifact(p, c);
        return;
      }
      case "call": {
        const signature = String((m as { signature?: unknown }).signature ?? "");
        const address = String((m as { address?: unknown }).address ?? "");
        const rpcUrl = String((m as { rpcUrl?: unknown }).rpcUrl ?? "");
        const args = Array.isArray((m as { args?: unknown[] }).args)
          ? ((m as { args?: unknown[] }).args as unknown[]).map((a) => String(a))
          : [];
        const sigWithReturns = String((m as { sigWithReturns?: unknown }).sigWithReturns ?? "");
        await this.executeCall(address, signature, sigWithReturns, args, rpcUrl);
        return;
      }
      case "copy": {
        const text = String((m as { text?: unknown }).text ?? "");
        await vscode.env.clipboard.writeText(text);
        vscode.window.showInformationMessage("Copied to clipboard.");
        return;
      }
    }
  }

  private postInit(): void {
    if (!this.panel) return;
    const last = this.context.workspaceState.get<RemoteChainSession>(SESSION_KEY) ?? null;
    this.panel.webview.postMessage({ type: "init", chains: CHAINS, lastSession: last });
  }

  private async persistSession(
    update: (current: RemoteChainSession) => RemoteChainSession,
  ): Promise<void> {
    const current =
      this.context.workspaceState.get<RemoteChainSession>(SESSION_KEY) ??
      ({ chainId: "mainnet" } as RemoteChainSession);
    await this.context.workspaceState.update(SESSION_KEY, update(current));
  }

  // ── ABI loading ──────────────────────────────────────────────────

  private handleAbiPaste(json: string): void {
    if (!this.panel) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      this.panel.webview.postMessage({
        type: "abiError",
        message: `Invalid JSON: ${(err as Error).message}`,
      });
      return;
    }
    // Accept either a bare ABI array or a forge-artifact-style object with `.abi`.
    const abi = this.extractAbi(parsed);
    if (!abi) {
      this.panel.webview.postMessage({
        type: "abiError",
        message: "Could not find an ABI array in the pasted JSON.",
      });
      return;
    }
    this.panel.webview.postMessage({ type: "abiLoaded", abi, source: "paste" });
    void this.persistSession((s) => ({ ...s, abiSource: "paste" }));
  }

  private extractAbi(obj: unknown): AbiFunctionFragment[] | null {
    if (Array.isArray(obj)) return obj as AbiFunctionFragment[];
    if (obj && typeof obj === "object" && Array.isArray((obj as { abi?: unknown }).abi)) {
      return (obj as { abi: AbiFunctionFragment[] }).abi;
    }
    return null;
  }

  private async sendArtifactList(): Promise<void> {
    if (!this.panel) return;
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      this.panel.webview.postMessage({
        type: "artifactList",
        artifacts: [],
        message: "No workspace folder open.",
      });
      return;
    }
    const found = await vscode.workspace.findFiles("out/**/*.json", "**/build-info/**", 200);
    const artifacts: { contract: string; path: string }[] = [];
    for (const uri of found) {
      const p = uri.fsPath;
      const base = path.basename(p, ".json");
      // Skip files that aren't ABI-bearing (build-info, debug etc) by
      // peeking at the parsed JSON. Cheap because forge artifacts are
      // small and we cap at 200 files.
      try {
        const buf = await vscode.workspace.fs.readFile(uri);
        const parsed = JSON.parse(buf.toString());
        if (Array.isArray(parsed?.abi)) {
          artifacts.push({ contract: base, path: p });
        }
      } catch {
        // ignore non-ABI files
      }
    }
    artifacts.sort((a, b) => a.contract.localeCompare(b.contract));
    this.panel.webview.postMessage({ type: "artifactList", artifacts });
  }

  private async loadAbiFromArtifact(filePath: string, contract: string): Promise<void> {
    if (!this.panel) return;
    try {
      const buf = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
      const parsed = JSON.parse(buf.toString());
      const abi = this.extractAbi(parsed);
      if (!abi) {
        this.panel.webview.postMessage({
          type: "abiError",
          message: `Artifact ${contract} has no ABI.`,
        });
        return;
      }
      this.panel.webview.postMessage({
        type: "abiLoaded",
        abi,
        source: "artifact",
        contract,
        path: filePath,
      });
      void this.persistSession((s) => ({ ...s, abiSource: "artifact" }));
    } catch (err) {
      this.panel.webview.postMessage({
        type: "abiError",
        message: `Failed to load ${filePath}: ${(err as Error).message}`,
      });
    }
  }

  // ── cast invocation ──────────────────────────────────────────────

  private resolveCastPath(): string {
    const config = vscode.workspace.getConfiguration("solidity-workbench");
    const foundryPath = (config.get<string>("foundryPath") ?? "").trim();
    if (!foundryPath) return "cast";
    return path.join(path.dirname(foundryPath), "cast");
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

  private async executeCall(
    address: string,
    signature: string,
    sigWithReturns: string,
    args: string[],
    rpcUrl: string,
  ): Promise<void> {
    if (!this.panel) return;
    if (this.inFlight) return;

    if (!ADDRESS_RE.test(address)) {
      this.panel.webview.postMessage({
        type: "callError",
        signature,
        message: `Invalid address: ${address}`,
      });
      return;
    }
    if (!rpcUrl) {
      this.panel.webview.postMessage({
        type: "callError",
        signature,
        message: "RPC URL is required.",
      });
      return;
    }

    this.inFlight = true;
    const start = Date.now();
    const cast = this.resolveCastPath();
    const cwd = this.resolveCwd();
    const opts = { cwd, timeout: 30_000, maxBuffer: 10 * 1024 * 1024 };

    try {
      // Run two cast calls in parallel — bare for hex, with-returns
      // for decoded text. cast does not have a `decode-output`
      // subcommand on Foundry 1.5, so this two-shot pattern is the
      // simplest version-stable way to surface both forms.
      const argvBare = ["call", address, signature, ...args, "--rpc-url", rpcUrl];
      const argvDecoded =
        sigWithReturns && sigWithReturns !== signature
          ? ["call", address, sigWithReturns, ...args, "--rpc-url", rpcUrl]
          : null;

      const hexPromise = execFileAsync(cast, argvBare, opts).then((r) => r.stdout.trim());
      const decodedPromise = argvDecoded
        ? execFileAsync(cast, argvDecoded, opts).then((r) => r.stdout.trim())
        : Promise.resolve(null);

      const [hex, decoded] = await Promise.all([hexPromise, decodedPromise]);
      const durationMs = Date.now() - start;

      this.panel.webview.postMessage({
        type: "callResult",
        signature,
        hex,
        decoded,
        durationMs,
      });
      void this.persistSession((s) => ({ ...s, contractAddress: address }));
    } catch (err: unknown) {
      const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
      const stderr = (e.stderr ?? "").toString().trim();
      const stdout = (e.stdout ?? "").toString().trim();
      const message = stderr || stdout || e.message || String(err);
      this.panel.webview.postMessage({
        type: "callError",
        signature,
        message,
      });
    } finally {
      this.inFlight = false;
    }
  }

  // ── HTML ─────────────────────────────────────────────────────────

  private buildHtml(webview: vscode.Webview): string {
    const cspSource = webview.cspSource;
    return `<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src ${cspSource} 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 14px; margin: 0; line-height: 1.4; }
  h2 { margin: 0 0 12px 0; font-size: 1.05em; }
  h3 { margin: 14px 0 6px 0; font-size: 0.85em; opacity: 0.7; text-transform: uppercase; letter-spacing: 0.6px; font-weight: 600; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
  .row label { font-size: 0.8em; opacity: 0.75; min-width: 90px; }
  input[type=text], textarea, select { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; padding: 4px 6px; font-family: var(--vscode-editor-font-family); font-size: 0.85em; }
  input[type=text] { flex: 1; min-width: 200px; }
  input.invalid { border-color: #e06c75; }
  select { min-width: 240px; }
  textarea { width: 100%; min-height: 80px; resize: vertical; box-sizing: border-box; }
  .btn { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 4px 10px; border-radius: 3px; cursor: pointer; font-size: 0.8em; font-family: inherit; }
  .btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .args-form { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 4px; margin: 8px 0; }
  .arg { display: flex; gap: 8px; align-items: flex-start; flex-wrap: wrap; }
  .arg-label { min-width: 160px; font-size: 0.8em; padding-top: 4px; font-family: var(--vscode-editor-font-family); }
  .arg input, .arg textarea { flex: 1; min-width: 280px; }
  .arg .hint { width: 100%; font-size: 0.7em; opacity: 0.6; padding-left: 168px; margin-top: -2px; }
  .feed { display: flex; flex-direction: column; gap: 10px; margin-top: 12px; }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 8px 10px; background: var(--vscode-editor-inactiveSelectionBackground); }
  .card.error { border-left: 3px solid #e06c75; }
  .card.ok { border-left: 3px solid #4ec96e; }
  .card .sig { font-family: var(--vscode-editor-font-family); font-size: 0.85em; opacity: 0.85; }
  .card .field { margin-top: 6px; font-family: var(--vscode-editor-font-family); font-size: 0.8em; word-break: break-all; }
  .card .field .lbl { display: inline-block; min-width: 70px; opacity: 0.6; }
  .card .actions { margin-top: 6px; display: flex; gap: 6px; }
  .read-only-only { display: block; }
  .scope-note { font-size: 0.75em; opacity: 0.65; margin-top: 4px; }
  .err-msg { color: #e06c75; font-size: 0.8em; margin-top: 6px; }
  optgroup { font-weight: bold; }
</style>
</head>
<body>
  <h2>Remote Chain</h2>
  <p class="scope-note">Read-only contract calls (cast call). Writes are disabled in 0.3.2.</p>

  <h3>Chain</h3>
  <div class="row">
    <select id="chain-select"></select>
    <input type="text" id="custom-rpc" placeholder="https://… (custom RPC URL)" style="display:none;">
  </div>

  <h3>Contract</h3>
  <div class="row">
    <label>Address</label>
    <input type="text" id="address" placeholder="0x...40 hex chars">
  </div>

  <h3>ABI</h3>
  <div class="row">
    <button class="btn" id="btn-paste-abi">Paste ABI JSON</button>
    <button class="btn" id="btn-pick-artifact">Pick from out/</button>
    <span id="abi-status" class="scope-note"></span>
  </div>
  <div id="paste-abi-area" style="display:none;">
    <textarea id="abi-json" placeholder='[{"type":"function","name":"…","inputs":[],"outputs":[],"stateMutability":"view"}]'></textarea>
    <div class="row" style="margin-top:6px;">
      <button class="btn btn-primary" id="btn-paste-load">Load</button>
      <button class="btn" id="btn-paste-cancel">Cancel</button>
    </div>
  </div>
  <div id="artifact-pick-area" style="display:none;">
    <select id="artifact-select" size="6" style="width:100%;"></select>
    <div class="row" style="margin-top:6px;">
      <button class="btn btn-primary" id="btn-artifact-load">Load Selected</button>
      <button class="btn" id="btn-artifact-cancel">Cancel</button>
    </div>
  </div>

  <div id="abi-error" class="err-msg" style="display:none;"></div>

  <div id="function-area" style="display:none;">
    <h3>Function</h3>
    <div class="row">
      <select id="function-select"></select>
    </div>
    <div id="args-form-container"></div>
    <div class="row">
      <button class="btn btn-primary" id="btn-call" disabled>Run cast call</button>
      <span id="run-status" class="scope-note"></span>
    </div>
  </div>

  <div class="feed" id="feed"></div>

  <script>
    const vscode = acquireVsCodeApi();

    // ── DOM refs ─────────────────────────────────────────────
    const chainSelect = document.getElementById('chain-select');
    const customRpc = document.getElementById('custom-rpc');
    const addressInput = document.getElementById('address');
    const btnPasteAbi = document.getElementById('btn-paste-abi');
    const btnPickArtifact = document.getElementById('btn-pick-artifact');
    const pasteAbiArea = document.getElementById('paste-abi-area');
    const abiJson = document.getElementById('abi-json');
    const btnPasteLoad = document.getElementById('btn-paste-load');
    const btnPasteCancel = document.getElementById('btn-paste-cancel');
    const artifactPickArea = document.getElementById('artifact-pick-area');
    const artifactSelect = document.getElementById('artifact-select');
    const btnArtifactLoad = document.getElementById('btn-artifact-load');
    const btnArtifactCancel = document.getElementById('btn-artifact-cancel');
    const abiError = document.getElementById('abi-error');
    const abiStatus = document.getElementById('abi-status');
    const functionArea = document.getElementById('function-area');
    const functionSelect = document.getElementById('function-select');
    const argsFormContainer = document.getElementById('args-form-container');
    const btnCall = document.getElementById('btn-call');
    const runStatus = document.getElementById('run-status');
    const feed = document.getElementById('feed');

    // ── State ──────────────────────────────────────────────────
    let chains = [];
    let abi = [];
    let selectedFnIndex = -1;

    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    function isAddress(s) {
      return /^0x[0-9a-fA-F]{40}$/.test(s);
    }

    function updateAddressValidity() {
      const v = addressInput.value.trim();
      addressInput.classList.toggle('invalid', v.length > 0 && !isAddress(v));
      updateRunButton();
    }

    function rpcUrl() {
      const id = chainSelect.value;
      if (id === 'custom') return customRpc.value.trim();
      const c = chains.find((c) => c.id === id);
      return c ? c.rpcUrl : '';
    }

    function persistChain() {
      vscode.postMessage({
        type: 'selectChain',
        chainId: chainSelect.value,
        customRpcUrl: chainSelect.value === 'custom' ? customRpc.value.trim() : undefined,
      });
    }

    chainSelect.addEventListener('change', () => {
      customRpc.style.display = chainSelect.value === 'custom' ? '' : 'none';
      persistChain();
      updateRunButton();
    });
    customRpc.addEventListener('change', () => {
      persistChain();
      updateRunButton();
    });
    addressInput.addEventListener('input', updateAddressValidity);

    btnPasteAbi.addEventListener('click', () => {
      pasteAbiArea.style.display = '';
      artifactPickArea.style.display = 'none';
    });
    btnPickArtifact.addEventListener('click', () => {
      pasteAbiArea.style.display = 'none';
      artifactPickArea.style.display = '';
      artifactSelect.innerHTML = '<option>Loading…</option>';
      vscode.postMessage({ type: 'loadAbiArtifactRequest' });
    });
    btnPasteLoad.addEventListener('click', () => {
      vscode.postMessage({ type: 'loadAbiPaste', json: abiJson.value });
    });
    btnPasteCancel.addEventListener('click', () => {
      pasteAbiArea.style.display = 'none';
    });
    btnArtifactLoad.addEventListener('click', () => {
      const opt = artifactSelect.options[artifactSelect.selectedIndex];
      if (!opt || !opt.dataset.path) return;
      vscode.postMessage({
        type: 'loadAbiArtifactPick',
        path: opt.dataset.path,
        contract: opt.dataset.contract,
      });
    });
    btnArtifactCancel.addEventListener('click', () => {
      artifactPickArea.style.display = 'none';
    });

    function functionSig(fn) {
      const inputs = (fn.inputs || []).map(canonicalType).join(',');
      return fn.name + '(' + inputs + ')';
    }
    function functionSigWithReturns(fn) {
      const base = functionSig(fn);
      const outputs = (fn.outputs || []).map(canonicalType).join(',');
      return outputs ? base + '(' + outputs + ')' : base;
    }
    function canonicalType(p) {
      const raw = p.type;
      if (!raw.startsWith('tuple')) return raw;
      const suffix = raw.slice(4);
      const inner = (p.components || []).map(canonicalType).join(',');
      return '(' + inner + ')' + suffix;
    }
    function displayType(p) {
      const raw = p.type;
      if (!raw.startsWith('tuple')) return raw;
      const suffix = raw.slice(4);
      const parts = (p.components || []).map((c) => {
        const t = displayType(c);
        return c.name ? t + ' ' + c.name : t;
      });
      return '(' + parts.join(', ') + ')' + suffix;
    }
    function readableSig(fn) {
      const parts = (fn.inputs || []).map((p) => {
        const t = displayType(p);
        return p.name ? t + ' ' + p.name : t;
      });
      return fn.name + '(' + parts.join(', ') + ')';
    }
    function isReadOnly(fn) {
      return fn.stateMutability === 'view' || fn.stateMutability === 'pure';
    }

    function renderFunctionPicker() {
      functionSelect.innerHTML = '';
      const reads = abi.filter((f) => f.type === 'function' && isReadOnly(f));
      const writes = abi.filter((f) => f.type === 'function' && !isReadOnly(f));

      if (reads.length === 0 && writes.length === 0) {
        functionArea.style.display = 'none';
        return;
      }
      functionArea.style.display = '';

      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = '(select a function…)';
      functionSelect.appendChild(placeholder);

      if (reads.length > 0) {
        const og = document.createElement('optgroup');
        og.label = 'Read-only (view / pure)';
        reads.forEach((f) => {
          const o = document.createElement('option');
          o.value = 'r:' + abi.indexOf(f);
          o.textContent = readableSig(f);
          og.appendChild(o);
        });
        functionSelect.appendChild(og);
      }

      if (writes.length > 0) {
        const og = document.createElement('optgroup');
        og.label = 'Writes — disabled in 0.3.2';
        writes.forEach((f) => {
          const o = document.createElement('option');
          o.value = 'w:' + abi.indexOf(f);
          o.textContent = readableSig(f);
          o.disabled = true;
          o.title = 'writes require a private key — coming in a later release';
          og.appendChild(o);
        });
        functionSelect.appendChild(og);
      }

      functionSelect.addEventListener('change', onFunctionChange);
      onFunctionChange();
    }

    function onFunctionChange() {
      const v = functionSelect.value;
      argsFormContainer.innerHTML = '';
      selectedFnIndex = -1;
      if (!v || v.startsWith('w:')) {
        updateRunButton();
        return;
      }
      const idx = parseInt(v.slice(2), 10);
      const fn = abi[idx];
      if (!fn) return;
      selectedFnIndex = idx;

      if (!fn.inputs || fn.inputs.length === 0) {
        const note = document.createElement('div');
        note.className = 'scope-note';
        note.textContent = '(no arguments)';
        argsFormContainer.appendChild(note);
        updateRunButton();
        return;
      }

      const form = document.createElement('div');
      form.className = 'args-form';
      fn.inputs.forEach((p, i) => {
        const row = document.createElement('div');
        row.className = 'arg';
        const label = document.createElement('div');
        label.className = 'arg-label';
        label.textContent = (p.name || 'arg' + i) + ' : ' + displayType(p);
        row.appendChild(label);

        const isArrayLike = /\\[\\d*\\]/.test(p.type);
        const isTupleLike = p.type.startsWith('tuple');
        const isBool = p.type === 'bool';

        let input;
        if (isBool) {
          input = document.createElement('select');
          ['false', 'true'].forEach((v) => {
            const o = document.createElement('option');
            o.value = v;
            o.textContent = v;
            input.appendChild(o);
          });
        } else if (isTupleLike || isArrayLike) {
          input = document.createElement('textarea');
          input.placeholder = isTupleLike ? 'JSON object or [v1,v2,…]' : 'JSON array, e.g. ["0x…",1,true]';
          input.rows = 2;
        } else {
          input = document.createElement('input');
          input.type = 'text';
          if (p.type === 'address' || p.type === 'address payable') {
            input.placeholder = '0x...';
          } else if (/^(uint|int)/.test(p.type)) {
            input.placeholder = '123';
            input.inputMode = 'numeric';
          } else if (p.type.startsWith('bytes')) {
            input.placeholder = '0x...';
          }
        }
        input.dataset.argIndex = String(i);
        input.dataset.argType = p.type;
        row.appendChild(input);

        if (isTupleLike || isArrayLike) {
          const hint = document.createElement('div');
          hint.className = 'hint';
          hint.textContent = isTupleLike
            ? 'Tuples are forwarded to cast as (a,b,c). JSON arrays accepted; JSON objects are flattened in declaration order.'
            : 'Arrays are forwarded to cast as [a,b,c]. JSON arrays accepted.';
          row.appendChild(hint);
        }

        form.appendChild(row);
      });
      argsFormContainer.appendChild(form);
      updateRunButton();
    }

    function collectArgs(fn) {
      const inputs = argsFormContainer.querySelectorAll('input, textarea, select');
      const out = [];
      inputs.forEach((el) => {
        const i = parseInt(el.dataset.argIndex, 10);
        const t = el.dataset.argType;
        const v = (el.value || '').trim();
        if (t.startsWith('tuple') || /\\[/.test(t)) {
          out[i] = encodeStructured(v, t);
        } else if (t === 'bool') {
          out[i] = v === 'true' ? 'true' : 'false';
        } else {
          out[i] = v;
        }
      });
      return out;
    }

    function encodeStructured(value, type) {
      if (!value) return '';
      try {
        const parsed = JSON.parse(value);
        return jsonToCast(parsed, type);
      } catch {
        // Fall through — caller will pass the raw string and let cast surface its own error.
        return value;
      }
    }

    function jsonToCast(v, type) {
      if (Array.isArray(v)) {
        return '[' + v.map((x) => scalarToCast(x)).join(',') + ']';
      }
      if (v && typeof v === 'object') {
        // Tuples: emit values in declaration order.
        return '(' + Object.values(v).map((x) => scalarToCast(x)).join(',') + ')';
      }
      return scalarToCast(v);
    }
    function scalarToCast(v) {
      if (typeof v === 'string') return v;
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      if (v && typeof v === 'object') return jsonToCast(v, '');
      return String(v);
    }

    function updateRunButton() {
      const addrOk = isAddress(addressInput.value.trim());
      const rpcOk = rpcUrl().length > 0;
      const fnOk = selectedFnIndex >= 0;
      btnCall.disabled = !(addrOk && rpcOk && fnOk);
    }

    btnCall.addEventListener('click', () => {
      if (selectedFnIndex < 0) return;
      const fn = abi[selectedFnIndex];
      const args = collectArgs(fn);
      const sig = functionSig(fn);
      const sigR = functionSigWithReturns(fn);
      runStatus.textContent = 'Calling…';
      btnCall.disabled = true;
      vscode.postMessage({
        type: 'call',
        signature: sig,
        sigWithReturns: sigR,
        address: addressInput.value.trim(),
        rpcUrl: rpcUrl(),
        args,
      });
    });

    function appendCard(html, kind) {
      const card = document.createElement('div');
      card.className = 'card ' + (kind === 'error' ? 'error' : 'ok');
      card.innerHTML = html;
      // Wire up copy buttons.
      card.querySelectorAll('[data-copy]').forEach((btn) => {
        btn.addEventListener('click', () => {
          vscode.postMessage({ type: 'copy', text: btn.dataset.copy });
        });
      });
      feed.prepend(card);
    }

    // ── Inbound message handling ────────────────────────────
    window.addEventListener('message', (event) => {
      const m = event.data;
      if (!m || typeof m !== 'object') return;
      switch (m.type) {
        case 'init': {
          chains = m.chains || [];
          chainSelect.innerHTML = '';
          chains.forEach((c) => {
            const o = document.createElement('option');
            o.value = c.id;
            o.textContent = c.label + ' (chainId ' + c.chainId + ')';
            chainSelect.appendChild(o);
          });
          const customOpt = document.createElement('option');
          customOpt.value = 'custom';
          customOpt.textContent = 'Custom RPC URL…';
          chainSelect.appendChild(customOpt);
          if (m.lastSession) {
            if (m.lastSession.chainId) chainSelect.value = m.lastSession.chainId;
            if (m.lastSession.chainId === 'custom') {
              customRpc.style.display = '';
              customRpc.value = m.lastSession.customRpcUrl || '';
            }
            if (m.lastSession.contractAddress) {
              addressInput.value = m.lastSession.contractAddress;
              updateAddressValidity();
            }
          }
          break;
        }
        case 'abiLoaded': {
          abi = Array.isArray(m.abi) ? m.abi : [];
          abiError.style.display = 'none';
          const reads = abi.filter((f) => f.type === 'function' && isReadOnly(f)).length;
          const writes = abi.filter((f) => f.type === 'function' && !isReadOnly(f)).length;
          abiStatus.textContent = 'Loaded ' + abi.length + ' fragments (' + reads + ' read, ' + writes + ' write).' + (m.contract ? ' [' + m.contract + ']' : '');
          pasteAbiArea.style.display = 'none';
          artifactPickArea.style.display = 'none';
          renderFunctionPicker();
          break;
        }
        case 'abiError': {
          abiError.textContent = m.message;
          abiError.style.display = '';
          break;
        }
        case 'artifactList': {
          artifactSelect.innerHTML = '';
          (m.artifacts || []).forEach((a) => {
            const o = document.createElement('option');
            o.value = a.path;
            o.textContent = a.contract;
            o.dataset.path = a.path;
            o.dataset.contract = a.contract;
            artifactSelect.appendChild(o);
          });
          if ((m.artifacts || []).length === 0) {
            const o = document.createElement('option');
            o.textContent = 'No artifacts under out/. Run forge build first.';
            o.disabled = true;
            artifactSelect.appendChild(o);
          }
          break;
        }
        case 'callResult': {
          runStatus.textContent = 'Done in ' + m.durationMs + ' ms.';
          updateRunButton();
          const decodedHtml = m.decoded
            ? '<div class="field"><span class="lbl">Decoded:</span> ' + escapeHtml(m.decoded) + ' <button class="btn" data-copy="' + escapeHtml(m.decoded) + '">copy</button></div>'
            : '';
          appendCard(
            '<div class="sig">' + escapeHtml(m.signature) + '</div>' +
              '<div class="field"><span class="lbl">Hex:</span> ' + escapeHtml(m.hex) + ' <button class="btn" data-copy="' + escapeHtml(m.hex) + '">copy</button></div>' +
              decodedHtml,
            'ok',
          );
          break;
        }
        case 'callError': {
          runStatus.textContent = 'Failed.';
          updateRunButton();
          appendCard(
            '<div class="sig">' + escapeHtml(m.signature) + '</div>' +
              '<div class="field" style="white-space: pre-wrap;">' + escapeHtml(m.message) + '</div>',
            'error',
          );
          break;
        }
      }
    });

    vscode.postMessage({ type: 'uiReady' });
  </script>
</body>
</html>`;
  }
}
