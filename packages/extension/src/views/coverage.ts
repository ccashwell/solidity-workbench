import * as vscode from "vscode";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Forge coverage visualization.
 *
 * Runs `forge coverage --report lcov` into a temp file, parses the LCOV
 * output, and overlays **line-level** coverage decorations onto every open
 * Solidity file:
 *
 * - Green gutter / background for covered lines (`DA:<line>,<hits>` with hits > 0)
 * - Red gutter / background for uncovered lines (`DA:<line>,0`)
 * - Yellow for partially covered branches (`BRDA:<line>,...,<taken>` mixed)
 *
 * Summary percentages (lines / branches / functions) still appear in the
 * status bar so users see coverage at a glance. Running the summary report
 * would be faster but wouldn't give us line-level data; LCOV is the only
 * format forge emits that contains `DA`/`BRDA`/`FN`/`FNDA` records.
 */
export class CoverageProvider {
  private coveredDecoration: vscode.TextEditorDecorationType;
  private uncoveredDecoration: vscode.TextEditorDecorationType;
  private partialDecoration: vscode.TextEditorDecorationType;
  private statusBarItem: vscode.StatusBarItem;

  /** relative file path (as produced by forge lcov) → coverage record */
  private coverageData: Map<string, FileCoverage> = new Map();

  private coverageListener: ((pct: number | null) => void) | null = null;

  constructor() {
    this.coveredDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: "rgba(80, 200, 120, 0.12)",
      overviewRulerColor: new vscode.ThemeColor("testing.iconPassed"),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });

    this.uncoveredDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: "rgba(230, 108, 117, 0.15)",
      overviewRulerColor: new vscode.ThemeColor("testing.iconFailed"),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });

    this.partialDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: "rgba(255, 200, 0, 0.15)",
      overviewRulerColor: "rgba(255, 200, 0, 0.5)",
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });

    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  }

  /**
   * Register a listener that receives the current overall coverage
   * percentage whenever the data set changes (or `null` when cleared).
   * The status bar hooks into this to show a single consolidated
   * indicator rather than competing with our own status bar item.
   */
  onCoverageChange(listener: (pct: number | null) => void): void {
    this.coverageListener = listener;
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

    const lcovPath = path.join(os.tmpdir(), `solidity-workbench-lcov-${process.pid}.info`);

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Running forge coverage (LCOV report)...",
        cancellable: false,
      },
      async () => {
        try {
          await execFileAsync(
            forgePath,
            ["coverage", "--report", "lcov", "--report-file", lcovPath],
            {
              cwd: workspaceFolder.uri.fsPath,
              maxBuffer: 50 * 1024 * 1024,
              timeout: 600_000,
            },
          );

          if (!fs.existsSync(lcovPath)) {
            vscode.window.showErrorMessage(
              `forge coverage ran but produced no LCOV at ${lcovPath}`,
            );
            return;
          }

          const lcov = fs.readFileSync(lcovPath, "utf-8");
          this.coverageData = parseLcov(lcov);

          this.updateStatusBar();

          for (const editor of vscode.window.visibleTextEditors) {
            this.updateDecorations(editor);
          }

          vscode.window.showInformationMessage(
            `Coverage loaded: ${this.coverageData.size} files. Open .sol files to see per-line highlights.`,
          );
        } catch (err: any) {
          vscode.window.showErrorMessage(`forge coverage failed: ${err.stderr || err.message}`);
        } finally {
          try {
            fs.unlinkSync(lcovPath);
          } catch {
            /* temp file cleanup failed — non-critical */
          }
        }
      },
    );
  }

  clearCoverage(): void {
    this.coverageData.clear();
    this.statusBarItem.hide();
    this.coverageListener?.(null);

    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.coveredDecoration, []);
      editor.setDecorations(this.uncoveredDecoration, []);
      editor.setDecorations(this.partialDecoration, []);
    }
  }

  private updateStatusBar(): void {
    if (this.coverageData.size === 0) {
      this.statusBarItem.hide();
      this.coverageListener?.(null);
      return;
    }

    let totalLines = 0;
    let coveredLines = 0;
    for (const cov of this.coverageData.values()) {
      totalLines += cov.lineTotal;
      coveredLines += cov.lineHit;
    }

    const pct = totalLines > 0 ? (coveredLines / totalLines) * 100 : 0;

    // Keep the standalone status-bar item (it's a clickable shortcut to
    // clear highlights) AND push the percentage to the main workbench
    // status bar via the registered listener.
    this.statusBarItem.text = `$(shield) ${pct.toFixed(1)}% coverage`;
    this.statusBarItem.tooltip = new vscode.MarkdownString(
      `**Solidity Workbench — line coverage**\n\n` +
        `- Files: ${this.coverageData.size}\n` +
        `- Lines: ${coveredLines.toLocaleString()} / ${totalLines.toLocaleString()}\n\n` +
        `Click to clear highlights.`,
    );
    this.statusBarItem.command = "solidity-workbench.coverageClear";
    this.statusBarItem.show();
    this.coverageListener?.(pct);
  }

  private updateDecorations(editor: vscode.TextEditor): void {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (!workspaceFolder) return;

    // LCOV paths from forge are workspace-relative; the editor URI is
    // absolute. Try both relative and absolute lookups so CI setups that
    // emit absolute paths in LCOV still match.
    const relativePath = path.relative(workspaceFolder.uri.fsPath, editor.document.uri.fsPath);
    const absolutePath = editor.document.uri.fsPath;

    const coverage =
      this.coverageData.get(relativePath) ??
      this.coverageData.get(relativePath.replace(/\\/g, "/")) ??
      this.coverageData.get(absolutePath);

    if (!coverage) {
      editor.setDecorations(this.coveredDecoration, []);
      editor.setDecorations(this.uncoveredDecoration, []);
      editor.setDecorations(this.partialDecoration, []);
      return;
    }

    const covered: vscode.DecorationOptions[] = [];
    const uncovered: vscode.DecorationOptions[] = [];
    const partial: vscode.DecorationOptions[] = [];
    const lineCount = editor.document.lineCount;

    // Build branch coverage per line. A branch-line is partial if at least
    // one branch was taken but at least one other was not.
    const branchStatus = summarizeBranches(coverage.branches);

    for (const [line, hits] of coverage.lines) {
      if (line < 1 || line > lineCount) continue;
      const range = new vscode.Range(line - 1, 0, line - 1, 0);

      const branchInfo = branchStatus.get(line);
      if (branchInfo && branchInfo === "partial" && hits > 0) {
        partial.push({
          range,
          hoverMessage: new vscode.MarkdownString(
            `**Partial branch coverage** — at least one branch on line ${line} is never taken`,
          ),
        });
        continue;
      }

      if (hits > 0) {
        covered.push({
          range,
          hoverMessage: new vscode.MarkdownString(
            hits === 1 ? `Covered (1 hit)` : `Covered (${hits.toLocaleString()} hits)`,
          ),
        });
      } else {
        uncovered.push({
          range,
          hoverMessage: new vscode.MarkdownString(`**Uncovered** — line ${line} never executed`),
        });
      }
    }

    editor.setDecorations(this.coveredDecoration, covered);
    editor.setDecorations(this.uncoveredDecoration, uncovered);
    editor.setDecorations(this.partialDecoration, partial);
  }
}

// ── LCOV parsing ─────────────────────────────────────────────────────

export interface FileCoverage {
  file: string;
  /** 1-based line number → hit count */
  lines: Map<number, number>;
  /** Parallel list of branch-level records for partial-coverage detection */
  branches: BranchRecord[];
  lineTotal: number;
  lineHit: number;
  branchTotal: number;
  branchHit: number;
  fnTotal: number;
  fnHit: number;
}

interface BranchRecord {
  line: number;
  branchId: string;
  taken: number;
}

/**
 * Parse LCOV tracefile content into a map of file-relative-path → coverage
 * record. Exported for testability. Supports the subset of LCOV records
 * forge emits: `SF`, `DA`, `BRDA`, `FN`, `FNDA`, `LF`, `LH`, `BRF`, `BRH`,
 * `FNF`, `FNH`, `end_of_record`.
 */
export function parseLcov(text: string): Map<string, FileCoverage> {
  const result = new Map<string, FileCoverage>();
  let current: FileCoverage | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line === "end_of_record") {
      if (current) {
        // LCOV-reported totals may be 0 when LF/BRF aren't emitted; fall
        // back to derived counts so the status bar still works.
        if (current.lineTotal === 0) current.lineTotal = current.lines.size;
        if (current.lineHit === 0) {
          let hit = 0;
          for (const hits of current.lines.values()) if (hits > 0) hit++;
          current.lineHit = hit;
        }
        result.set(current.file, current);
      }
      current = null;
      continue;
    }

    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;
    const tag = line.slice(0, colonIdx);
    const payload = line.slice(colonIdx + 1);

    if (tag === "SF") {
      current = {
        file: payload,
        lines: new Map(),
        branches: [],
        lineTotal: 0,
        lineHit: 0,
        branchTotal: 0,
        branchHit: 0,
        fnTotal: 0,
        fnHit: 0,
      };
      continue;
    }

    if (!current) continue;

    switch (tag) {
      case "DA": {
        // DA:<line>,<hits>[,<checksum>]
        const parts = payload.split(",");
        const lineNo = parseInt(parts[0], 10);
        const hits = parseInt(parts[1] ?? "0", 10);
        if (!Number.isFinite(lineNo)) break;
        current.lines.set(lineNo, (current.lines.get(lineNo) ?? 0) + (hits || 0));
        break;
      }
      case "BRDA": {
        // BRDA:<line>,<block>,<branch>,<taken | "-">
        const parts = payload.split(",");
        if (parts.length < 4) break;
        const lineNo = parseInt(parts[0], 10);
        const branchId = `${parts[1]}/${parts[2]}`;
        const takenStr = parts[3];
        const taken = takenStr === "-" ? 0 : parseInt(takenStr, 10);
        if (!Number.isFinite(lineNo)) break;
        current.branches.push({ line: lineNo, branchId, taken: taken || 0 });
        break;
      }
      case "LF":
        current.lineTotal = parseInt(payload, 10) || 0;
        break;
      case "LH":
        current.lineHit = parseInt(payload, 10) || 0;
        break;
      case "BRF":
        current.branchTotal = parseInt(payload, 10) || 0;
        break;
      case "BRH":
        current.branchHit = parseInt(payload, 10) || 0;
        break;
      case "FNF":
        current.fnTotal = parseInt(payload, 10) || 0;
        break;
      case "FNH":
        current.fnHit = parseInt(payload, 10) || 0;
        break;
      default:
        break;
    }
  }

  return result;
}

/**
 * Bucket each branch-bearing line into `fully` / `partial` / `missed` based
 * on how many of its branches have taken > 0. Exported for testability.
 */
export function summarizeBranches(
  branches: BranchRecord[],
): Map<number, "fully" | "partial" | "missed"> {
  const byLine = new Map<number, { total: number; taken: number }>();

  for (const br of branches) {
    const entry = byLine.get(br.line) ?? { total: 0, taken: 0 };
    entry.total += 1;
    if (br.taken > 0) entry.taken += 1;
    byLine.set(br.line, entry);
  }

  const out = new Map<number, "fully" | "partial" | "missed">();
  for (const [line, { total, taken }] of byLine) {
    if (taken === 0) out.set(line, "missed");
    else if (taken === total) out.set(line, "fully");
    else out.set(line, "partial");
  }
  return out;
}
