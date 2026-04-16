import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";
import { ServerStateNotification, type ServerStateParams } from "@solidity-workbench/common";

/**
 * Solidity Workbench status bar item.
 *
 * Shows a live view of server + toolchain state:
 *   - LSP indexing progress / idle with file count
 *   - Latest `forge build` result (✓ / error / warning counts)
 *   - Whether Anvil is running locally (updated by AnvilCommands)
 *   - Coverage percentage (updated by CoverageProvider)
 *
 * Design: a single status bar item so we don't clutter the bar. The
 * item's text rotates through the most salient piece of state; the
 * tooltip shows everything. Clicking opens the Solidity Workbench
 * output channel so users can see what the server is doing.
 */
export class StatusBar {
  private item: vscode.StatusBarItem;

  private indexing: { current: number; total: number } | null = null;
  private rootCount = 0;
  private fileCount = 0;
  private build: null | {
    success: boolean;
    errors: number;
    warnings: number;
    durationMs: number;
  } = null;
  private anvil: { forked: boolean; host?: string } | null = null;
  private coveragePct: number | null = null;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.name = "Solidity Workbench";
    this.item.command = "solidity-workbench.showOutput";
    this.render();
  }

  activate(context: vscode.ExtensionContext, client: LanguageClient): void {
    context.subscriptions.push(this.item);

    context.subscriptions.push(
      vscode.commands.registerCommand("solidity-workbench.showOutput", () => {
        client.outputChannel.show();
      }),
    );

    // Subscribe to server-state heartbeats so the status bar reflects
    // indexing / building / idle transitions without any polling.
    client.onNotification(ServerStateNotification, (state: ServerStateParams) => {
      this.applyServerState(state);
    });

    this.item.show();
  }

  setAnvil(anvil: { forked: boolean; host?: string } | null): void {
    this.anvil = anvil;
    this.render();
  }

  setCoverage(pct: number | null): void {
    this.coveragePct = pct;
    this.render();
  }

  private applyServerState(state: ServerStateParams): void {
    switch (state.phase) {
      case "indexing":
        this.indexing = { current: state.filesIndexed, total: state.filesTotal };
        break;
      case "idle":
        this.indexing = null;
        this.rootCount = state.rootCount;
        this.fileCount = state.fileCount;
        break;
      case "building":
        // Keep previous build result visible as "stale" while a new
        // build runs — rendering adds a spinner.
        this.build = this.build ? { ...this.build } : null;
        break;
      case "build-result":
        this.build = {
          success: state.success,
          errors: state.errorCount,
          warnings: state.warningCount,
          durationMs: state.durationMs,
        };
        break;
    }
    this.render();
  }

  private render(): void {
    const segments: string[] = [];

    if (this.indexing && this.indexing.total > 0) {
      segments.push(`$(sync~spin) Indexing ${this.indexing.current}/${this.indexing.total}`);
    } else {
      segments.push(`$(beaker) Workbench`);
    }

    if (this.build) {
      if (this.build.success) {
        segments.push(this.build.warnings > 0 ? `$(warning) ${this.build.warnings}w` : `$(check)`);
      } else {
        segments.push(`$(error) ${this.build.errors}e`);
      }
    }

    if (this.coveragePct !== null) {
      segments.push(`$(shield) ${this.coveragePct.toFixed(0)}%`);
    }

    if (this.anvil) {
      segments.push(this.anvil.forked ? `$(server) anvil⇨fork` : `$(server) anvil`);
    }

    this.item.text = segments.join("  ");

    // Multi-line tooltip with the full picture.
    const lines: string[] = ["**Solidity Workbench**"];
    lines.push("");
    if (this.indexing && this.indexing.total > 0) {
      lines.push(`_Indexing ${this.indexing.current}/${this.indexing.total} files_`);
    } else {
      lines.push(`${this.rootCount} root(s), ${this.fileCount} Solidity file(s) indexed`);
    }
    if (this.build) {
      if (this.build.success) {
        lines.push(
          `✓ Last build: ${this.build.warnings} warning${this.build.warnings === 1 ? "" : "s"} (${this.build.durationMs} ms)`,
        );
      } else {
        lines.push(
          `✗ Last build: ${this.build.errors} error${this.build.errors === 1 ? "" : "s"}, ` +
            `${this.build.warnings} warning${this.build.warnings === 1 ? "" : "s"} (${this.build.durationMs} ms)`,
        );
      }
    }
    if (this.anvil) {
      lines.push(
        this.anvil.forked
          ? `Anvil running (forked${this.anvil.host ? " from " + this.anvil.host : ""})`
          : "Anvil running (fresh chain)",
      );
    }
    if (this.coveragePct !== null) {
      lines.push(`Coverage: ${this.coveragePct.toFixed(1)}%`);
    }
    lines.push("");
    lines.push("_Click to open the Solidity Workbench output channel._");

    const md = new vscode.MarkdownString(lines.join("\n"));
    md.isTrusted = false;
    this.item.tooltip = md;
  }
}
