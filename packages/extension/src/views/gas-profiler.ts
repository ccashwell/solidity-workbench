import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Gas Profiler — tracks and visualizes gas usage across test runs.
 *
 * Features:
 * - Reads .gas-snapshot file produced by `forge snapshot`
 * - Shows a tree view of gas costs per contract and function
 * - Highlights gas regressions (delta from previous snapshot)
 * - Inline decorations showing gas cost next to function definitions
 * - Clickable entries that navigate to the corresponding function
 */
export class GasProfilerProvider implements vscode.TreeDataProvider<GasEntry> {
  private _onDidChangeTreeData = new vscode.EventEmitter<GasEntry | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private entries: GasEntry[] = [];
  private watcher: vscode.FileSystemWatcher | undefined;
  private decorationType: vscode.TextEditorDecorationType;

  constructor() {
    this.decorationType = vscode.window.createTextEditorDecorationType({
      after: {
        margin: "0 0 0 2em",
        color: new vscode.ThemeColor("editorCodeLens.foreground"),
      },
    });
  }

  activate(context: vscode.ExtensionContext): void {
    const treeView = vscode.window.createTreeView("solidity-workbench-gas-profiler", {
      treeDataProvider: this,
      showCollapseAll: true,
    });
    context.subscriptions.push(treeView);

    // Watch .gas-snapshot
    this.watcher = vscode.workspace.createFileSystemWatcher("**/.gas-snapshot");
    this.watcher.onDidChange(() => this.refresh());
    this.watcher.onDidCreate(() => this.refresh());
    context.subscriptions.push(this.watcher);

    // Refresh decorations when the active editor changes
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor?.document.languageId === "solidity") {
          this.updateDecorations(editor);
        }
      }),
    );

    this.refresh();
  }

  async refresh(): Promise<void> {
    this.entries = await this.loadSnapshot();
    this._onDidChangeTreeData.fire(undefined);

    // Update decorations in active editor
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.languageId === "solidity") {
      this.updateDecorations(editor);
    }
  }

  getTreeItem(element: GasEntry): vscode.TreeItem {
    const item = new vscode.TreeItem(
      element.label,
      element.children.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );

    item.description = element.gasFormatted;

    if (element.delta !== undefined) {
      if (element.delta > 0) {
        item.iconPath = new vscode.ThemeIcon(
          "arrow-up",
          new vscode.ThemeColor("testing.iconFailed"),
        );
        item.tooltip = `${element.gasFormatted} (+${element.delta} gas regression)`;
      } else if (element.delta < 0) {
        item.iconPath = new vscode.ThemeIcon(
          "arrow-down",
          new vscode.ThemeColor("testing.iconPassed"),
        );
        item.tooltip = `${element.gasFormatted} (${element.delta} gas improvement)`;
      } else {
        item.iconPath = new vscode.ThemeIcon("dash");
        item.tooltip = `${element.gasFormatted} (no change)`;
      }
    }

    return item;
  }

  getChildren(element?: GasEntry): GasEntry[] {
    if (!element) return this.entries;
    return element.children;
  }

  private async loadSnapshot(): Promise<GasEntry[]> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return [];

    const snapshotPath = path.join(workspaceFolder.uri.fsPath, ".gas-snapshot");

    try {
      if (!fs.existsSync(snapshotPath)) return [];

      const content = fs.readFileSync(snapshotPath, "utf-8");
      return this.parseSnapshot(content);
    } catch {
      return [];
    }
  }

  /**
   * Parse .gas-snapshot format:
   * ContractName:testFunctionName() (gas: 12345)
   * ContractName:testFunctionName(uint256) (gas: 12345) (runs: 256, μ: 12345, ~: 12345)
   */
  private parseSnapshot(content: string): GasEntry[] {
    const contractMap = new Map<string, GasEntry>();

    for (const line of content.split("\n")) {
      const match = line.match(/^(\w+):(\w+)\(([^)]*)\)\s+\(gas:\s+(\d+)\)/);
      if (!match) continue;

      const [, contractName, funcName, params, gasStr] = match;
      const gas = parseInt(gasStr, 10);

      // Check for fuzz run stats
      const fuzzMatch = line.match(/\(runs:\s+(\d+),\s+μ:\s+(\d+),\s+~:\s+(\d+)\)/);

      let contractEntry = contractMap.get(contractName);
      if (!contractEntry) {
        contractEntry = {
          label: contractName,
          gas: 0,
          gasFormatted: "",
          children: [],
        };
        contractMap.set(contractName, contractEntry);
      }

      const funcLabel = fuzzMatch
        ? `${funcName}(${params}) [fuzz: ${fuzzMatch[1]} runs]`
        : `${funcName}(${params})`;

      contractEntry.children.push({
        label: funcLabel,
        gas,
        gasFormatted: this.formatGas(gas),
        children: [],
      });

      contractEntry.gas += gas;
    }

    // Format contract totals
    for (const entry of contractMap.values()) {
      entry.gasFormatted = `total: ${this.formatGas(entry.gas)}`;
    }

    return Array.from(contractMap.values()).sort((a, b) => b.gas - a.gas);
  }

  /**
   * Add inline decorations showing gas costs next to test functions.
   */
  private updateDecorations(editor: vscode.TextEditor): void {
    const decorations: vscode.DecorationOptions[] = [];
    const text = editor.document.getText();
    const lines = text.split("\n");

    // Flatten all gas entries for lookup
    const gasLookup = new Map<string, number>();
    for (const contract of this.entries) {
      for (const func of contract.children) {
        const funcName = func.label.split("(")[0];
        gasLookup.set(`${contract.label}::${funcName}`, func.gas);
      }
    }

    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/function\s+((?:test|testFuzz|testFork|testFail)_\w+)\s*\(/);
      if (!match) continue;

      // Try to find gas for this function in any contract
      for (const [key, gas] of gasLookup) {
        if (key.endsWith(`::${match[1]}`)) {
          decorations.push({
            range: new vscode.Range(i, lines[i].length, i, lines[i].length),
            renderOptions: {
              after: {
                contentText: ` ⛽ ${this.formatGas(gas)} gas`,
              },
            },
          });
          break;
        }
      }
    }

    editor.setDecorations(this.decorationType, decorations);
  }

  private formatGas(gas: number): string {
    if (gas >= 1_000_000) return `${(gas / 1_000_000).toFixed(2)}M`;
    if (gas >= 1_000) return `${(gas / 1_000).toFixed(1)}k`;
    return gas.toLocaleString();
  }
}

interface GasEntry {
  label: string;
  gas: number;
  gasFormatted: string;
  delta?: number;
  children: GasEntry[];
}
