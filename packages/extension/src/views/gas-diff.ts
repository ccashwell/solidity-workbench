import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";

const execFileAsync = promisify(execFile);

/**
 * Gas Diff — compare .gas-snapshot between git branches or commits.
 *
 * Features:
 * - Compare current snapshot against any branch/commit
 * - Tree view showing regressions (red), improvements (green), unchanged
 * - Sortable by delta, percentage change, or absolute cost
 * - One-click to navigate to the test function
 * - Summary stats: total regression, total improvement
 */
export class GasDiffProvider implements vscode.TreeDataProvider<GasDiffEntry> {
  private _onDidChangeTreeData = new vscode.EventEmitter<GasDiffEntry | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private entries: GasDiffEntry[] = [];
  private summaryItem: GasDiffEntry | undefined;

  activate(context: vscode.ExtensionContext): void {
    const treeView = vscode.window.createTreeView("solidity-workbench-gas-diff", {
      treeDataProvider: this,
      showCollapseAll: true,
    });
    context.subscriptions.push(treeView);

    context.subscriptions.push(
      vscode.commands.registerCommand("solidity-workbench.gasDiff", () => this.runDiff()),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand("solidity-workbench.gasDiffRefresh", () => this.runDiff()),
    );
  }

  getTreeItem(element: GasDiffEntry): vscode.TreeItem {
    if (element.isSummary) {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
      item.description = element.description;
      item.iconPath = new vscode.ThemeIcon("info");
      return item;
    }

    if (element.children.length > 0) {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = element.description;
      return item;
    }

    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.description = element.description;

    if (element.delta !== undefined) {
      if (element.delta > 0) {
        item.iconPath = new vscode.ThemeIcon(
          "arrow-up",
          new vscode.ThemeColor("testing.iconFailed"),
        );
        item.tooltip = `+${element.delta.toLocaleString()} gas (${element.percentChange})`;
      } else if (element.delta < 0) {
        item.iconPath = new vscode.ThemeIcon(
          "arrow-down",
          new vscode.ThemeColor("testing.iconPassed"),
        );
        item.tooltip = `${element.delta.toLocaleString()} gas (${element.percentChange})`;
      } else {
        item.iconPath = new vscode.ThemeIcon("dash");
        item.tooltip = "No change";
      }
    }

    return item;
  }

  getChildren(element?: GasDiffEntry): GasDiffEntry[] {
    if (!element) {
      const result: GasDiffEntry[] = [];
      if (this.summaryItem) result.push(this.summaryItem);
      result.push(...this.entries);
      return result;
    }
    return element.children;
  }

  private async runDiff(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showWarningMessage("Open a workspace first.");
      return;
    }

    const cwd = workspaceFolder.uri.fsPath;
    const snapshotPath = path.join(cwd, ".gas-snapshot");

    if (!fs.existsSync(snapshotPath)) {
      vscode.window.showWarningMessage("No .gas-snapshot file found. Run `forge snapshot` first.");
      return;
    }

    // Get list of branches for quick pick
    const branches = await this.getBranches(cwd);
    const items = ["main", "master", ...branches.filter((b) => b !== "main" && b !== "master")];
    const uniqueItems = [...new Set(items)];

    const target = await vscode.window.showQuickPick(uniqueItems, {
      placeHolder: "Compare gas snapshot against which branch/commit?",
      title: "Gas Diff — Select Base",
    });
    if (!target) return;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Computing gas diff..." },
      async () => {
        const currentSnapshot = this.parseSnapshot(fs.readFileSync(snapshotPath, "utf-8"));
        const baseSnapshot = await this.getBaseSnapshot(cwd, target);

        if (!baseSnapshot) {
          vscode.window.showWarningMessage(
            `No .gas-snapshot found on ${target}. Run \`forge snapshot\` on that branch first.`,
          );
          return;
        }

        this.computeDiff(currentSnapshot, baseSnapshot, target);
      },
    );
  }

  private computeDiff(
    current: Map<string, number>,
    base: Map<string, number>,
    baseName: string,
  ): void {
    const contractMap = new Map<string, GasDiffEntry>();
    let totalRegression = 0;
    let totalImprovement = 0;
    let regressionCount = 0;
    let improvementCount = 0;

    const allKeys = new Set([...current.keys(), ...base.keys()]);

    for (const key of allKeys) {
      const currentGas = current.get(key);
      const baseGas = base.get(key);

      const [contractName, funcName] = key.split("::");
      let contractEntry = contractMap.get(contractName);
      if (!contractEntry) {
        contractEntry = { label: contractName, children: [], description: "" };
        contractMap.set(contractName, contractEntry);
      }

      if (currentGas !== undefined && baseGas !== undefined) {
        const delta = currentGas - baseGas;
        const pct = baseGas > 0 ? ((delta / baseGas) * 100).toFixed(1) + "%" : "—";

        if (delta > 0) {
          totalRegression += delta;
          regressionCount++;
        } else if (delta < 0) {
          totalImprovement += Math.abs(delta);
          improvementCount++;
        }

        contractEntry.children.push({
          label: funcName,
          description: `${this.formatGas(currentGas)} (${delta >= 0 ? "+" : ""}${this.formatGas(delta)})`,
          delta,
          percentChange: pct,
          children: [],
        });
      } else if (currentGas !== undefined && baseGas === undefined) {
        contractEntry.children.push({
          label: funcName,
          description: `${this.formatGas(currentGas)} (new)`,
          delta: currentGas,
          percentChange: "new",
          children: [],
        });
      } else if (currentGas === undefined && baseGas !== undefined) {
        contractEntry.children.push({
          label: funcName,
          description: `removed (was ${this.formatGas(baseGas)})`,
          delta: -baseGas,
          percentChange: "removed",
          children: [],
        });
      }
    }

    // Sort children by delta descending (worst regressions first)
    for (const entry of contractMap.values()) {
      entry.children.sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0));
      const contractDelta = entry.children.reduce((sum, c) => sum + (c.delta ?? 0), 0);
      entry.description =
        contractDelta >= 0 ? `+${this.formatGas(contractDelta)}` : this.formatGas(contractDelta);
    }

    this.entries = Array.from(contractMap.values()).sort((a, b) => {
      const aDelta = a.children.reduce((s, c) => s + (c.delta ?? 0), 0);
      const bDelta = b.children.reduce((s, c) => s + (c.delta ?? 0), 0);
      return bDelta - aDelta;
    });

    this.summaryItem = {
      label: `vs ${baseName}`,
      description: `${regressionCount} regressions (+${this.formatGas(totalRegression)}), ${improvementCount} improvements (-${this.formatGas(totalImprovement)})`,
      isSummary: true,
      children: [],
    };

    this._onDidChangeTreeData.fire(undefined);
  }

  private parseSnapshot(content: string): Map<string, number> {
    const map = new Map<string, number>();
    for (const line of content.split("\n")) {
      const match = line.match(/^(\w+):(\w+)\([^)]*\)\s+\(gas:\s+(\d+)\)/);
      if (match) {
        map.set(`${match[1]}::${match[2]}`, parseInt(match[3], 10));
      }
    }
    return map;
  }

  private async getBaseSnapshot(cwd: string, ref: string): Promise<Map<string, number> | null> {
    try {
      const result = await execFileAsync("git", ["show", `${ref}:.gas-snapshot`], {
        cwd,
        timeout: 10_000,
      });
      return this.parseSnapshot(result.stdout);
    } catch {
      return null;
    }
  }

  private async getBranches(cwd: string): Promise<string[]> {
    try {
      const result = await execFileAsync("git", ["branch", "--format=%(refname:short)"], {
        cwd,
        timeout: 5_000,
      });
      return result.stdout
        .split("\n")
        .map((b) => b.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  private formatGas(gas: number): string {
    if (Math.abs(gas) >= 1_000_000) return `${(gas / 1_000_000).toFixed(1)}M`;
    if (Math.abs(gas) >= 1_000) return `${(gas / 1_000).toFixed(1)}k`;
    return gas.toLocaleString();
  }
}

interface GasDiffEntry {
  label: string;
  description?: string;
  delta?: number;
  percentChange?: string;
  isSummary?: boolean;
  children: GasDiffEntry[];
}
