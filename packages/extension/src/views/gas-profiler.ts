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
 *
 * Delta tracking: the last-seen flattened gas map (per contract::function
 * key) is persisted in extension `globalState` under SNAPSHOT_KEY. On each
 * refresh we diff the new numbers against the stored map, surface
 * per-entry deltas in the tree view and as inline decorations, and then
 * overwrite the stored map. Clear the state via
 * `solidity-workbench.gasClearHistory` to reset the baseline.
 */
export class GasProfilerProvider implements vscode.TreeDataProvider<GasEntry> {
  private static readonly SNAPSHOT_KEY = "solidity-workbench.gasSnapshot.previous";

  private _onDidChangeTreeData = new vscode.EventEmitter<GasEntry | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private entries: GasEntry[] = [];
  private watcher: vscode.FileSystemWatcher | undefined;
  private decorationType: vscode.TextEditorDecorationType;
  private context: vscode.ExtensionContext | undefined;

  constructor() {
    this.decorationType = vscode.window.createTextEditorDecorationType({
      after: {
        margin: "0 0 0 2em",
        color: new vscode.ThemeColor("editorCodeLens.foreground"),
      },
    });
  }

  activate(context: vscode.ExtensionContext): void {
    this.context = context;

    const treeView = vscode.window.createTreeView("solidity-workbench-gas-profiler", {
      treeDataProvider: this,
      showCollapseAll: true,
    });
    context.subscriptions.push(treeView);

    this.watcher = vscode.workspace.createFileSystemWatcher("**/.gas-snapshot");
    this.watcher.onDidChange(() => this.refresh());
    this.watcher.onDidCreate(() => this.refresh());
    context.subscriptions.push(this.watcher);

    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor?.document.languageId === "solidity") {
          this.updateDecorations(editor);
        }
      }),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand("solidity-workbench.gasClearHistory", async () => {
        await context.globalState.update(GasProfilerProvider.SNAPSHOT_KEY, undefined);
        await this.refresh();
        vscode.window.showInformationMessage(
          "Solidity Workbench: gas snapshot baseline cleared. Next load will establish a new baseline.",
        );
      }),
    );

    this.refresh();
  }

  async refresh(): Promise<void> {
    const { entries, flatMap } = await this.loadSnapshot();

    // Diff against the previously persisted snapshot before overwriting it.
    const previous =
      this.context?.globalState.get<Record<string, number>>(GasProfilerProvider.SNAPSHOT_KEY) ?? {};

    if (Object.keys(previous).length > 0) {
      for (const contract of entries) {
        let contractDelta = 0;
        for (const func of contract.children) {
          const key = `${contract.label}::${this.stripParams(func.label)}`;
          const old = previous[key];
          if (old !== undefined) {
            func.delta = func.gas - old;
            contractDelta += func.delta;
          }
        }
        if (contractDelta !== 0) {
          contract.delta = contractDelta;
        }
      }
    }

    // Persist the new baseline so subsequent refreshes produce deltas.
    await this.context?.globalState.update(GasProfilerProvider.SNAPSHOT_KEY, flatMap);

    this.entries = entries;
    this._onDidChangeTreeData.fire(undefined);

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

    item.description = this.describeEntry(element);

    if (element.delta !== undefined) {
      if (element.delta > 0) {
        item.iconPath = new vscode.ThemeIcon(
          "arrow-up",
          new vscode.ThemeColor("testing.iconFailed"),
        );
        item.tooltip = `${element.gasFormatted} (+${element.delta.toLocaleString()} gas regression)`;
      } else if (element.delta < 0) {
        item.iconPath = new vscode.ThemeIcon(
          "arrow-down",
          new vscode.ThemeColor("testing.iconPassed"),
        );
        item.tooltip = `${element.gasFormatted} (${element.delta.toLocaleString()} gas improvement)`;
      } else {
        item.iconPath = new vscode.ThemeIcon("dash");
        item.tooltip = `${element.gasFormatted} (no change)`;
      }
    } else {
      item.tooltip = element.gasFormatted;
    }

    return item;
  }

  getChildren(element?: GasEntry): GasEntry[] {
    if (!element) return this.entries;
    return element.children;
  }

  private async loadSnapshot(): Promise<{ entries: GasEntry[]; flatMap: Record<string, number> }> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return { entries: [], flatMap: {} };

    const snapshotPath = path.join(workspaceFolder.uri.fsPath, ".gas-snapshot");

    try {
      if (!fs.existsSync(snapshotPath)) return { entries: [], flatMap: {} };

      const content = fs.readFileSync(snapshotPath, "utf-8");
      return this.parseSnapshot(content);
    } catch {
      return { entries: [], flatMap: {} };
    }
  }

  /**
   * Parse .gas-snapshot format:
   *   ContractName:testFunctionName() (gas: 12345)
   *   ContractName:testFunctionName(uint256) (gas: 12345) (runs: 256, μ: 12345, ~: 12345)
   *
   * Returns both a hierarchical `GasEntry[]` tree keyed by contract and a
   * flat `contract::functionName` → gas map suitable for delta persistence.
   */
  private parseSnapshot(content: string): {
    entries: GasEntry[];
    flatMap: Record<string, number>;
  } {
    const contractMap = new Map<string, GasEntry>();
    const flatMap: Record<string, number> = {};

    for (const line of content.split("\n")) {
      const match = line.match(/^(\w+):(\w+)\(([^)]*)\)\s+\(gas:\s+(\d+)\)/);
      if (!match) continue;

      const [, contractName, funcName, params, gasStr] = match;
      const gas = parseInt(gasStr, 10);

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
      flatMap[`${contractName}::${funcName}`] = gas;
    }

    for (const entry of contractMap.values()) {
      entry.gasFormatted = `total: ${this.formatGas(entry.gas)}`;
    }

    const entries = Array.from(contractMap.values()).sort((a, b) => b.gas - a.gas);
    return { entries, flatMap };
  }

  /**
   * Format an entry's right-hand description. When a delta is known we
   * append it in signed form so the tree shows `⛽ 12.3k (+423)` without
   * forcing the user to hover for the tooltip.
   */
  private describeEntry(entry: GasEntry): string {
    if (entry.delta === undefined || entry.delta === 0) {
      return entry.gasFormatted;
    }
    const sign = entry.delta > 0 ? "+" : "";
    return `${entry.gasFormatted}  (${sign}${entry.delta.toLocaleString()})`;
  }

  /**
   * Add inline decorations showing gas costs next to test functions.
   */
  private updateDecorations(editor: vscode.TextEditor): void {
    const decorations: vscode.DecorationOptions[] = [];
    const text = editor.document.getText();
    const lines = text.split("\n");

    const gasLookup = new Map<string, { gas: number; delta?: number }>();
    for (const contract of this.entries) {
      for (const func of contract.children) {
        const funcName = func.label.split("(")[0];
        gasLookup.set(`${contract.label}::${funcName}`, { gas: func.gas, delta: func.delta });
      }
    }

    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/function\s+((?:test|testFuzz|testFork|testFail)_\w+)\s*\(/);
      if (!match) continue;

      for (const [key, info] of gasLookup) {
        if (key.endsWith(`::${match[1]}`)) {
          const deltaStr =
            info.delta !== undefined && info.delta !== 0
              ? `  (${info.delta > 0 ? "+" : ""}${info.delta.toLocaleString()})`
              : "";
          decorations.push({
            range: new vscode.Range(i, lines[i].length, i, lines[i].length),
            renderOptions: {
              after: {
                contentText: ` ⛽ ${this.formatGas(info.gas)} gas${deltaStr}`,
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

  private stripParams(funcLabel: string): string {
    // "name(uint256) [fuzz: 256 runs]" → "name"
    return funcLabel.split("(")[0];
  }
}

interface GasEntry {
  label: string;
  gas: number;
  gasFormatted: string;
  delta?: number;
  children: GasEntry[];
}
