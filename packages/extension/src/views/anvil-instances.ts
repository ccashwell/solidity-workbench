import * as vscode from "vscode";
import type { AnvilInstance, AnvilManager } from "../commands/anvil.js";

/**
 * Anvil Instances tree view — shows all running Anvil nodes in the
 * sidebar with status, port, chain ID, and fork info.
 *
 * Each instance node expands to show:
 *   - RPC URL (click to copy)
 *   - Chain ID
 *   - Fork source (if forked)
 *   - Uptime
 *
 * Right-click context menu: Stop, Copy RPC URL, Show Logs.
 */
export class AnvilInstancesProvider implements vscode.TreeDataProvider<AnvilTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<AnvilTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private manager: AnvilManager;

  constructor(manager: AnvilManager) {
    this.manager = manager;
    this.manager.onInstanceChange(() => this.refresh());
  }

  activate(context: vscode.ExtensionContext): void {
    const treeView = vscode.window.createTreeView("solidity-workbench-anvil-instances", {
      treeDataProvider: this,
      showCollapseAll: true,
    });
    context.subscriptions.push(treeView);
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: AnvilTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: AnvilTreeItem): AnvilTreeItem[] {
    if (!element) {
      return this.getRootItems();
    }
    return element.children ?? [];
  }

  private getRootItems(): AnvilTreeItem[] {
    const instances = this.manager.getInstances();

    if (instances.length === 0) {
      const empty = new AnvilTreeItem("No instances running", vscode.TreeItemCollapsibleState.None);
      empty.description = "Start one with the + button";
      empty.iconPath = new vscode.ThemeIcon("info");
      return [empty];
    }

    return instances.map((inst) => this.buildInstanceItem(inst));
  }

  private buildInstanceItem(inst: AnvilInstance): AnvilTreeItem {
    const item = new AnvilTreeItem(inst.config.label, vscode.TreeItemCollapsibleState.Expanded);

    item.instanceId = inst.id;
    item.contextValue = "anvilInstance";

    switch (inst.status) {
      case "running":
        item.iconPath = new vscode.ThemeIcon(
          "vm-running",
          new vscode.ThemeColor("testing.iconPassed"),
        );
        item.description = `port ${inst.port}`;
        break;
      case "starting":
        item.iconPath = new vscode.ThemeIcon("sync~spin");
        item.description = "starting...";
        break;
      case "error":
        item.iconPath = new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed"));
        item.description = inst.error ?? "error";
        break;
      case "stopped":
        item.iconPath = new vscode.ThemeIcon("vm-outline");
        item.description = "stopped";
        break;
    }

    const children: AnvilTreeItem[] = [];

    const rpcItem = new AnvilTreeItem(`RPC: ${inst.rpcUrl}`, vscode.TreeItemCollapsibleState.None);
    rpcItem.iconPath = new vscode.ThemeIcon("link");
    rpcItem.command = {
      title: "Copy RPC URL",
      command: "solidity-workbench.anvil.copyRpcUrl",
      arguments: [{ instanceId: inst.id }],
    };
    rpcItem.tooltip = "Click to copy RPC URL";
    children.push(rpcItem);

    if (inst.config.chainId !== undefined) {
      const chainItem = new AnvilTreeItem(
        `Chain ID: ${inst.config.chainId}`,
        vscode.TreeItemCollapsibleState.None,
      );
      chainItem.iconPath = new vscode.ThemeIcon("symbol-number");
      children.push(chainItem);
    }

    if (inst.config.forkUrl) {
      let forkLabel: string;
      try {
        forkLabel = new URL(inst.config.forkUrl).hostname;
      } catch {
        forkLabel = inst.config.forkUrl;
      }
      const forkItem = new AnvilTreeItem(
        `Fork: ${forkLabel}`,
        vscode.TreeItemCollapsibleState.None,
      );
      forkItem.iconPath = new vscode.ThemeIcon("git-branch");
      forkItem.tooltip = inst.config.forkUrl;
      if (inst.config.forkBlockNumber) {
        forkItem.description = `block ${inst.config.forkBlockNumber}`;
      }
      children.push(forkItem);
    }

    if (inst.status === "running") {
      const elapsed = Math.floor((Date.now() - inst.startedAt) / 1000);
      const uptimeItem = new AnvilTreeItem(
        `Uptime: ${this.formatDuration(elapsed)}`,
        vscode.TreeItemCollapsibleState.None,
      );
      uptimeItem.iconPath = new vscode.ThemeIcon("clock");
      children.push(uptimeItem);
    }

    item.children = children;
    return item;
  }

  private formatDuration(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    if (m < 60) return `${m}m ${s}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }
}

class AnvilTreeItem extends vscode.TreeItem {
  children?: AnvilTreeItem[];
  instanceId?: string;
}
