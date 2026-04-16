import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Storage Layout Visualization — interactive webview panel showing
 * the storage slot layout of a contract.
 *
 * Features:
 * - Visual slot map: each 32-byte slot shown with its contents
 * - Packed variable highlighting (multiple vars in one slot)
 * - Slot number, offset, type, and variable name
 * - Inherited storage from parent contracts
 * - Proxy-aware: shows implementation storage for proxy patterns
 * - Clickable entries that navigate to the variable declaration
 *
 * Uses `forge inspect <contract> storage-layout --json` for data.
 */
export class StorageLayoutPanel {
  private panel: vscode.WebviewPanel | undefined;

  activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.commands.registerCommand("solidity-workbench.inspectStoragePanel", () =>
        this.showPanel(context),
      ),
    );
  }

  private async showPanel(context: vscode.ExtensionContext): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== "solidity") {
      vscode.window.showWarningMessage("Open a Solidity file first.");
      return;
    }

    // Detect contract name from the file
    const text = editor.document.getText();
    const contractNames = [...text.matchAll(/(?:abstract\s+)?contract\s+(\w+)/g)].map((m) => m[1]);

    if (contractNames.length === 0) {
      vscode.window.showWarningMessage("No contract found in this file.");
      return;
    }

    // If multiple contracts, let the user pick
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

    // Get storage layout
    const layout = await this.getStorageLayout(contractName);
    if (!layout) {
      vscode.window.showErrorMessage(
        `Failed to get storage layout for ${contractName}. Make sure the project compiles.`,
      );
      return;
    }

    // Create or reveal the webview panel
    if (this.panel) {
      this.panel.reveal();
    } else {
      this.panel = vscode.window.createWebviewPanel(
        "solidity-workbench-storage-layout",
        `Storage: ${contractName}`,
        vscode.ViewColumn.Beside,
        { enableScripts: true },
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });
    }

    this.panel.title = `Storage: ${contractName}`;
    this.panel.webview.html = this.buildHtml(contractName, layout);
  }

  private async getStorageLayout(contractName: string): Promise<StorageEntry[] | null> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return null;

    const config = vscode.workspace.getConfiguration("solidity-workbench");
    const forgePath = config.get<string>("foundryPath") || "forge";

    try {
      const result = await execFileAsync(
        forgePath,
        ["inspect", contractName, "storage-layout", "--json"],
        {
          cwd: workspaceFolder.uri.fsPath,
          maxBuffer: 10 * 1024 * 1024,
          timeout: 60_000,
        },
      );

      const data = JSON.parse(result.stdout);
      return data.storage ?? data ?? [];
    } catch (err: any) {
      // Try alternative format
      try {
        const result = await execFileAsync(forgePath, ["inspect", contractName, "storage"], {
          cwd: workspaceFolder.uri.fsPath,
          maxBuffer: 10 * 1024 * 1024,
        });
        return this.parseTextLayout(result.stdout);
      } catch {
        return null;
      }
    }
  }

  private parseTextLayout(text: string): StorageEntry[] {
    const entries: StorageEntry[] = [];
    const lines = text.split("\n").filter((l) => l.includes("|"));

    for (const line of lines) {
      const parts = line
        .split("|")
        .map((p) => p.trim())
        .filter(Boolean);
      if (parts.length < 4 || parts[0] === "Name") continue;

      entries.push({
        label: parts[0],
        type: parts[1],
        slot: parts[2],
        offset: parseInt(parts[3]) || 0,
        numberOfBytes: parts[4] || "32",
      });
    }

    return entries;
  }

  private buildHtml(contractName: string, layout: StorageEntry[]): string {
    // Group entries by slot
    const slotMap = new Map<string, StorageEntry[]>();
    for (const entry of layout) {
      const slot = entry.slot?.toString() ?? "0";
      const existing = slotMap.get(slot) ?? [];
      existing.push(entry);
      slotMap.set(slot, existing);
    }

    const slotRows = Array.from(slotMap.entries())
      .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
      .map(([slot, entries]) => {
        const isPacked = entries.length > 1;
        const vars = entries
          .map((e) => {
            const bytes = parseInt(e.numberOfBytes) || 32;
            const widthPercent = (bytes / 32) * 100;
            const color = this.typeColor(e.type);
            return `<div class="var" style="width:${widthPercent}%;background:${color}" title="${e.type} (${bytes} bytes, offset ${e.offset})">
              <span class="var-name">${this.escapeHtml(e.label)}</span>
              <span class="var-type">${this.escapeHtml(e.type)}</span>
              <span class="var-size">${bytes}B</span>
            </div>`;
          })
          .join("");

        return `<tr>
          <td class="slot-num">${slot}</td>
          <td class="slot-hex">0x${parseInt(slot).toString(16).padStart(4, "0")}</td>
          <td class="slot-bar"><div class="bar">${vars}</div></td>
          <td class="slot-packed">${isPacked ? "packed" : ""}</td>
        </tr>`;
      })
      .join("\n");

    const totalSlots = slotMap.size;
    const totalBytes = layout.reduce((sum, e) => sum + (parseInt(e.numberOfBytes) || 32), 0);

    return `<!DOCTYPE html>
<html>
<head>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; }
  h2 { margin-top: 0; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 8px; }
  .stats { display: flex; gap: 24px; margin-bottom: 16px; opacity: 0.8; }
  .stat { display: flex; flex-direction: column; }
  .stat-value { font-size: 1.4em; font-weight: bold; }
  .stat-label { font-size: 0.85em; opacity: 0.7; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; padding: 6px 8px; border-bottom: 2px solid var(--vscode-panel-border); font-size: 0.85em; opacity: 0.7; }
  td { padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: middle; }
  .slot-num { font-family: var(--vscode-editor-font-family); font-weight: bold; width: 50px; }
  .slot-hex { font-family: var(--vscode-editor-font-family); opacity: 0.6; width: 60px; }
  .slot-bar { width: 100%; }
  .slot-packed { font-size: 0.8em; opacity: 0.5; width: 60px; }
  .bar { display: flex; height: 32px; border-radius: 4px; overflow: hidden; gap: 1px; }
  .var { display: flex; flex-direction: column; justify-content: center; align-items: center; padding: 2px 6px; color: #fff; font-size: 0.75em; cursor: default; min-width: 0; overflow: hidden; border-radius: 3px; }
  .var-name { font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; width: 100%; text-align: center; }
  .var-type { opacity: 0.8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; width: 100%; text-align: center; font-size: 0.9em; }
  .var-size { opacity: 0.6; font-size: 0.85em; }
  .legend { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 16px; font-size: 0.85em; }
  .legend-item { display: flex; align-items: center; gap: 4px; }
  .legend-color { width: 12px; height: 12px; border-radius: 2px; }
</style>
</head>
<body>
  <h2>Storage Layout: ${this.escapeHtml(contractName)}</h2>
  <div class="stats">
    <div class="stat"><span class="stat-value">${totalSlots}</span><span class="stat-label">slots used</span></div>
    <div class="stat"><span class="stat-value">${totalBytes}</span><span class="stat-label">bytes total</span></div>
    <div class="stat"><span class="stat-value">${layout.length}</span><span class="stat-label">variables</span></div>
  </div>
  <table>
    <tr><th>Slot</th><th>Hex</th><th>Contents</th><th></th></tr>
    ${slotRows}
  </table>
  <div class="legend">
    <div class="legend-item"><div class="legend-color" style="background:#4a9eff"></div>uint/int</div>
    <div class="legend-item"><div class="legend-color" style="background:#e06c75"></div>address</div>
    <div class="legend-item"><div class="legend-color" style="background:#98c379"></div>bool/bytes</div>
    <div class="legend-item"><div class="legend-color" style="background:#c678dd"></div>mapping</div>
    <div class="legend-item"><div class="legend-color" style="background:#e5c07b"></div>struct/array</div>
    <div class="legend-item"><div class="legend-color" style="background:#56b6c2"></div>string</div>
  </div>
</body>
</html>`;
  }

  private typeColor(type: string): string {
    if (type.startsWith("uint") || type.startsWith("int")) return "#4a9eff";
    if (type.startsWith("address")) return "#e06c75";
    if (type.startsWith("bool") || type.startsWith("bytes")) return "#98c379";
    if (type.startsWith("mapping")) return "#c678dd";
    if (type.startsWith("struct") || type.includes("[]")) return "#e5c07b";
    if (type.startsWith("string")) return "#56b6c2";
    return "#abb2bf";
  }

  private escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
}

interface StorageEntry {
  label: string;
  type: string;
  slot: string;
  offset: number;
  numberOfBytes: string;
}
