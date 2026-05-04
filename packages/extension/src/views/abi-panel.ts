import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { findForgeRoot } from "@solidity-workbench/common";

const execFileAsync = promisify(execFile);

/**
 * ABI Explorer — interactive webview panel for exploring, copying, and
 * exporting contract ABIs.
 *
 * Features:
 * - Visual ABI explorer grouped by type (functions, events, errors)
 * - Click-to-copy: function signatures, selectors, full ABI JSON
 * - Filter/search within the ABI
 * - Export full ABI as JSON file
 * - Generate cast calldata from the panel
 */
export class AbiPanel {
  private panel: vscode.WebviewPanel | undefined;

  activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.commands.registerCommand("solidity-workbench.showAbi", () => this.showPanel()),
    );
  }

  private async showPanel(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== "solidity") {
      vscode.window.showWarningMessage("Open a Solidity file first.");
      return;
    }

    const text = editor.document.getText();
    const contractNames = [...text.matchAll(/(?:abstract\s+)?contract\s+(\w+)/g)].map((m) => m[1]);

    if (contractNames.length === 0) {
      vscode.window.showWarningMessage("No contracts found in this file.");
      return;
    }

    let contractName: string;
    if (contractNames.length === 1) {
      contractName = contractNames[0];
    } else {
      const picked = await vscode.window.showQuickPick(contractNames, {
        placeHolder: "Select a contract to inspect",
      });
      if (!picked) return;
      contractName = picked;
    }

    const filePath = editor.document.uri.fsPath;
    const result = await this.getAbi(filePath, contractName);
    if (!result.abi) {
      vscode.window.showErrorMessage(
        `Failed to get ABI for ${contractName}: ${result.error ?? "unknown error"}`,
      );
      return;
    }
    const abi = result.abi;

    if (this.panel) {
      this.panel.reveal();
    } else {
      this.panel = vscode.window.createWebviewPanel(
        "solidity-workbench-abi-panel",
        `ABI: ${contractName}`,
        vscode.ViewColumn.Beside,
        { enableScripts: true },
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });
    }

    this.panel.title = `ABI: ${contractName}`;
    this.panel.webview.html = this.buildHtml(contractName, abi);

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "copy":
          await vscode.env.clipboard.writeText(msg.text);
          vscode.window.showInformationMessage("Copied to clipboard.");
          break;
        case "export": {
          const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(`${contractName}.abi.json`),
            filters: { JSON: ["json"] },
          });
          if (uri) {
            const content = Buffer.from(JSON.stringify(abi, null, 2), "utf-8");
            await vscode.workspace.fs.writeFile(uri, content);
            vscode.window.showInformationMessage(`ABI exported to ${uri.fsPath}`);
          }
          break;
        }
      }
    });
  }

  /**
   * Resolve the ABI for `contractName` defined in `filePath`.
   *
   * Same two fixes as the storage-layout panel: resolve `cwd` to
   * the nearest `foundry.toml` ancestor (so multi-project / nested
   * workspaces work), and surface forge's stderr verbatim instead
   * of swallowing the error and showing a generic "make sure the
   * project compiles" message. Also fixes the
   * `getConfiguration("solforge")` typo — that namespace doesn't
   * exist, so `solidity-workbench.foundryPath` was being silently
   * ignored here and only the default `forge` on PATH was used.
   */
  private async getAbi(
    filePath: string,
    contractName: string,
  ): Promise<{ abi: AbiEntry[] | null; error?: string }> {
    const forgeRoot = findForgeRoot(filePath);
    if (!forgeRoot) {
      return {
        abi: null,
        error: `No foundry.toml found walking up from ${filePath}. Is this file inside a Foundry project?`,
      };
    }

    const config = vscode.workspace.getConfiguration("solidity-workbench");
    const forgePath = config.get<string>("foundryPath") || "forge";

    try {
      const result = await execFileAsync(forgePath, ["inspect", contractName, "abi"], {
        cwd: forgeRoot,
        maxBuffer: 10 * 1024 * 1024,
        timeout: 60_000,
      });
      return { abi: JSON.parse(result.stdout) };
    } catch (err: unknown) {
      const execErr = err as { stderr?: unknown; stdout?: unknown; message?: string };
      const stderr = (execErr.stderr ?? "").toString().trim();
      const stdout = (execErr.stdout ?? "").toString().trim();
      const message = stderr || stdout || execErr.message || String(err);
      return { abi: null, error: message };
    }
  }

  private buildHtml(contractName: string, abi: AbiEntry[]): string {
    const functions = abi.filter((e) => e.type === "function");
    const events = abi.filter((e) => e.type === "event");
    const errors = abi.filter((e) => e.type === "error");
    const constructor = abi.find((e) => e.type === "constructor");
    const receive = abi.find((e) => e.type === "receive");
    const fallback = abi.find((e) => e.type === "fallback");

    const renderInputs = (inputs: AbiParam[]): string =>
      inputs.map((i) => `${i.type}${i.name ? " " + this.esc(i.name) : ""}`).join(", ");

    const renderOutputs = (outputs: AbiParam[]): string =>
      outputs.map((o) => `${o.type}${o.name ? " " + this.esc(o.name) : ""}`).join(", ");

    const sig = (name: string, inputs: AbiParam[]): string =>
      `${name}(${inputs.map((i) => i.type).join(",")})`;

    const functionRows = functions
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))
      .map((f) => {
        const signature = sig(f.name!, f.inputs ?? []);
        const mutTag = f.stateMutability ?? "";
        const mutClass =
          mutTag === "view" || mutTag === "pure"
            ? "tag-read"
            : mutTag === "payable"
              ? "tag-payable"
              : "tag-write";
        return `<tr class="abi-row">
          <td><span class="func-name">${this.esc(f.name!)}</span></td>
          <td class="sig">(${renderInputs(f.inputs ?? [])})</td>
          <td class="sig">${f.outputs?.length ? renderOutputs(f.outputs) : "—"}</td>
          <td><span class="tag ${mutClass}">${mutTag || "nonpayable"}</span></td>
          <td>
            <button class="btn" onclick="copyText('${this.escJs(signature)}')">sig</button>
            <button class="btn" onclick="copyText(JSON.stringify(${this.escJs(JSON.stringify(f))}, null, 2))">json</button>
          </td>
        </tr>`;
      })
      .join("\n");

    const eventRows = events
      .map((e) => {
        const signature = sig(e.name!, e.inputs ?? []);
        return `<tr class="abi-row">
          <td><span class="event-name">${this.esc(e.name!)}</span></td>
          <td class="sig">(${renderInputs(e.inputs ?? [])})</td>
          <td>
            <button class="btn" onclick="copyText('${this.escJs(signature)}')">sig</button>
          </td>
        </tr>`;
      })
      .join("\n");

    const errorRows = errors
      .map((e) => {
        const signature = sig(e.name!, e.inputs ?? []);
        return `<tr class="abi-row">
          <td><span class="error-name">${this.esc(e.name!)}</span></td>
          <td class="sig">(${renderInputs(e.inputs ?? [])})</td>
          <td>
            <button class="btn" onclick="copyText('${this.escJs(signature)}')">sig</button>
          </td>
        </tr>`;
      })
      .join("\n");

    const specialRows: string[] = [];
    if (constructor) {
      specialRows.push(
        `<tr class="abi-row"><td><span class="func-name">constructor</span></td><td class="sig">(${renderInputs(constructor.inputs ?? [])})</td><td>—</td><td><span class="tag tag-write">deploy</span></td><td></td></tr>`,
      );
    }
    if (receive) {
      specialRows.push(
        `<tr class="abi-row"><td><span class="func-name">receive</span></td><td>—</td><td>—</td><td><span class="tag tag-payable">payable</span></td><td></td></tr>`,
      );
    }
    if (fallback) {
      specialRows.push(
        `<tr class="abi-row"><td><span class="func-name">fallback</span></td><td>—</td><td>—</td><td><span class="tag tag-write">${fallback.stateMutability ?? "nonpayable"}</span></td><td></td></tr>`,
      );
    }

    return `<!DOCTYPE html>
<html>
<head>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 0; margin: 0; }
  .toolbar { padding: 10px 16px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; align-items: center; gap: 12px; }
  .toolbar h2 { margin: 0; font-size: 1.1em; }
  .toolbar-actions { margin-left: auto; display: flex; gap: 8px; }
  .btn { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 3px 8px; border-radius: 3px; cursor: pointer; font-size: 0.8em; }
  .btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
  .search { padding: 6px 10px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; width: 200px; font-size: 0.9em; }
  .section { padding: 12px 16px; }
  .section-title { font-size: 0.9em; font-weight: bold; opacity: 0.7; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; padding: 4px 8px; font-size: 0.8em; opacity: 0.5; border-bottom: 1px solid var(--vscode-panel-border); }
  .abi-row td { padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); font-size: 0.9em; }
  .abi-row:hover { background: var(--vscode-list-hoverBackground); }
  .func-name { color: #dcdcaa; font-weight: bold; }
  .event-name { color: #4ec96e; font-weight: bold; }
  .error-name { color: #e06c75; font-weight: bold; }
  .sig { font-family: var(--vscode-editor-font-family); font-size: 0.85em; opacity: 0.8; }
  .tag { font-size: 0.75em; padding: 2px 6px; border-radius: 3px; }
  .tag-read { background: #1a6e3a; color: #4ec96e; }
  .tag-write { background: #6e3a1a; color: #e5c07b; }
  .tag-payable { background: #6e1a3a; color: #e06c75; }
  .count { font-size: 0.85em; opacity: 0.5; }
  .hidden { display: none; }
</style>
</head>
<body>
  <div class="toolbar">
    <h2>${this.esc(contractName)}</h2>
    <span class="count">${abi.length} entries</span>
    <input class="search" type="text" placeholder="Filter..." oninput="filterAbi(this.value)">
    <div class="toolbar-actions">
      <button class="btn btn-primary" onclick="copyAll()">Copy ABI JSON</button>
      <button class="btn" onclick="exportAbi()">Export...</button>
    </div>
  </div>

  ${
    specialRows.length > 0
      ? `<div class="section"><div class="section-title">Special</div><table>${specialRows.join("\n")}</table></div>`
      : ""
  }

  ${
    functions.length > 0
      ? `<div class="section"><div class="section-title">Functions (${functions.length})</div>
    <table>
      <tr><th>Name</th><th>Inputs</th><th>Outputs</th><th>Mutability</th><th></th></tr>
      ${functionRows}
    </table></div>`
      : ""
  }

  ${
    events.length > 0
      ? `<div class="section"><div class="section-title">Events (${events.length})</div>
    <table>
      <tr><th>Name</th><th>Parameters</th><th></th></tr>
      ${eventRows}
    </table></div>`
      : ""
  }

  ${
    errors.length > 0
      ? `<div class="section"><div class="section-title">Errors (${errors.length})</div>
    <table>
      <tr><th>Name</th><th>Parameters</th><th></th></tr>
      ${errorRows}
    </table></div>`
      : ""
  }

  <script>
    const vscode = acquireVsCodeApi();
    const fullAbi = ${JSON.stringify(abi)};

    function copyText(text) {
      vscode.postMessage({ type: 'copy', text });
    }
    function copyAll() {
      vscode.postMessage({ type: 'copy', text: JSON.stringify(fullAbi, null, 2) });
    }
    function exportAbi() {
      vscode.postMessage({ type: 'export' });
    }
    function filterAbi(query) {
      const q = query.toLowerCase();
      document.querySelectorAll('.abi-row').forEach(row => {
        const text = row.textContent.toLowerCase();
        row.classList.toggle('hidden', q && !text.includes(q));
      });
    }
  </script>
</body>
</html>`;
  }

  private esc(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  private escJs(text: string): string {
    return text.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, '\\"');
  }
}

interface AbiParam {
  name: string;
  type: string;
  indexed?: boolean;
  components?: AbiParam[];
  internalType?: string;
}

interface AbiEntry {
  type: "function" | "event" | "error" | "constructor" | "receive" | "fallback";
  name?: string;
  inputs?: AbiParam[];
  outputs?: AbiParam[];
  stateMutability?: string;
  anonymous?: boolean;
}
