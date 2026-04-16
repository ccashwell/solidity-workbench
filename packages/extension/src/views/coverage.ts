import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Forge coverage visualization.
 *
 * Runs `forge coverage` and overlays coverage data onto Solidity files
 * using VSCode's editor decoration API. Shows:
 *
 * - Green gutter for covered lines
 * - Red gutter for uncovered lines
 * - Yellow gutter for partially covered lines (branches)
 * - Summary statistics in the status bar
 *
 * Integrates with `forge coverage --report lcov` for standard LCOV output
 * that can also be consumed by other coverage tools.
 */
export class CoverageProvider {
  private coveredDecoration: vscode.TextEditorDecorationType;
  private uncoveredDecoration: vscode.TextEditorDecorationType;
  private partialDecoration: vscode.TextEditorDecorationType;
  private statusBarItem: vscode.StatusBarItem;
  private coverageData: Map<string, FileCoverage> = new Map();

  constructor() {
    this.coveredDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      gutterIconPath: undefined, // set dynamically
      backgroundColor: new vscode.ThemeColor("diffEditor.insertedTextBackground"),
      overviewRulerColor: new vscode.ThemeColor("testing.iconPassed"),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });

    this.uncoveredDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("diffEditor.removedTextBackground"),
      overviewRulerColor: new vscode.ThemeColor("testing.iconFailed"),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });

    this.partialDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: "rgba(255, 200, 0, 0.1)",
      overviewRulerColor: "rgba(255, 200, 0, 0.5)",
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });

    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  }

  activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(this.coveredDecoration);
    context.subscriptions.push(this.uncoveredDecoration);
    context.subscriptions.push(this.partialDecoration);
    context.subscriptions.push(this.statusBarItem);

    context.subscriptions.push(
      vscode.commands.registerCommand("solidity-workbench.coverage", () => this.runCoverage()),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand("solidity-workbench.coverageClear", () =>
        this.clearCoverage(),
      ),
    );

    // Update decorations when active editor changes
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) this.updateDecorations(editor);
      }),
    );
  }

  async runCoverage(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return;

    const config = vscode.workspace.getConfiguration("solidity-workbench");
    const forgePath = config.get<string>("foundryPath") || "forge";

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Running forge coverage...",
        cancellable: false,
      },
      async () => {
        try {
          const result = await execFileAsync(forgePath, ["coverage", "--report", "summary"], {
            cwd: workspaceFolder.uri.fsPath,
            maxBuffer: 50 * 1024 * 1024,
            timeout: 600_000, // 10 minutes — coverage can be slow
          });

          this.parseSummaryOutput(result.stdout);
          this.updateStatusBar();

          // Apply decorations to active editor
          const editor = vscode.window.activeTextEditor;
          if (editor) this.updateDecorations(editor);

          vscode.window.showInformationMessage(
            "Coverage data loaded. Open Solidity files to see coverage highlights.",
          );
        } catch (err: any) {
          vscode.window.showErrorMessage(`forge coverage failed: ${err.stderr || err.message}`);
        }
      },
    );
  }

  clearCoverage(): void {
    this.coverageData.clear();
    this.statusBarItem.hide();

    // Clear decorations from all visible editors
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.coveredDecoration, []);
      editor.setDecorations(this.uncoveredDecoration, []);
      editor.setDecorations(this.partialDecoration, []);
    }
  }

  /**
   * Parse `forge coverage --report summary` output.
   *
   * Example:
   * | File              | % Lines     | % Statements | % Branches  | % Funcs    |
   * |-------------------|-------------|--------------|-------------|------------|
   * | src/Counter.sol   | 100.00% (8/8) | 100.00% (9/9) | 50.00% (1/2) | 100% (5/5) |
   */
  private parseSummaryOutput(stdout: string): void {
    this.coverageData.clear();

    const lines = stdout.split("\n");
    for (const line of lines) {
      if (!line.includes("|") || line.includes("File") || line.includes("---")) continue;

      const parts = line
        .split("|")
        .map((p) => p.trim())
        .filter(Boolean);

      if (parts.length < 5) continue;

      const [file, linesStr, statementsStr, branchesStr, funcsStr] = parts;
      if (!file || file.startsWith("-")) continue;

      const lineCov = this.parseCoveragePercent(linesStr);
      const stmtCov = this.parseCoveragePercent(statementsStr);
      const branchCov = this.parseCoveragePercent(branchesStr);
      const funcCov = this.parseCoveragePercent(funcsStr);

      this.coverageData.set(file, {
        file,
        linePercent: lineCov,
        statementPercent: stmtCov,
        branchPercent: branchCov,
        functionPercent: funcCov,
      });
    }
  }

  private parseCoveragePercent(str: string): number {
    const match = str.match(/([\d.]+)%/);
    return match ? parseFloat(match[1]) : 0;
  }

  private updateStatusBar(): void {
    if (this.coverageData.size === 0) {
      this.statusBarItem.hide();
      return;
    }

    let totalLines = 0;
    let coveredCount = 0;
    for (const cov of this.coverageData.values()) {
      totalLines++;
      coveredCount += cov.linePercent;
    }

    const avgCoverage = totalLines > 0 ? (coveredCount / totalLines).toFixed(1) : "0";

    this.statusBarItem.text = `$(shield) ${avgCoverage}% coverage`;
    this.statusBarItem.tooltip = `Solidity Workbench: ${this.coverageData.size} files analyzed`;
    this.statusBarItem.command = "solidity-workbench.coverageClear";
    this.statusBarItem.show();
  }

  private updateDecorations(editor: vscode.TextEditor): void {
    const filePath = vscode.workspace.asRelativePath(editor.document.uri);
    const coverage = this.coverageData.get(filePath);

    if (!coverage) {
      editor.setDecorations(this.coveredDecoration, []);
      editor.setDecorations(this.uncoveredDecoration, []);
      editor.setDecorations(this.partialDecoration, []);
      return;
    }

    // For now, show a file-level indication since forge coverage summary
    // doesn't provide line-level data. Line-level coverage requires
    // parsing LCOV output which we'll add in a follow-up.
    // Display a banner at the top of the file with coverage stats.
    const topDecoration: vscode.DecorationOptions = {
      range: new vscode.Range(0, 0, 0, 0),
      renderOptions: {
        after: {
          contentText: `  Coverage: ${coverage.linePercent}% lines | ${coverage.branchPercent}% branches | ${coverage.functionPercent}% functions`,
          color: new vscode.ThemeColor("editorCodeLens.foreground"),
          fontStyle: "italic",
          margin: "0 0 0 2em",
        },
      },
    };

    if (coverage.linePercent >= 80) {
      editor.setDecorations(this.coveredDecoration, [topDecoration]);
    } else if (coverage.linePercent >= 50) {
      editor.setDecorations(this.partialDecoration, [topDecoration]);
    } else {
      editor.setDecorations(this.uncoveredDecoration, [topDecoration]);
    }
  }
}

interface FileCoverage {
  file: string;
  linePercent: number;
  statementPercent: number;
  branchPercent: number;
  functionPercent: number;
}
