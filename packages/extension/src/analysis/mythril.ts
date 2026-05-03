import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename } from "node:path";
import {
  parseMythrilReport,
  summarizeMythril,
  type MythrilFinding,
} from "@solidity-workbench/common";

const execFileAsync = promisify(execFile);

/**
 * Mythril (ConsenSys) symbolic-execution analysis integration.
 *
 * Runs `myth analyze -o json <file>` against a single Solidity
 * source file (the active editor's file by default) and surfaces
 * each finding as a VSCode `Diagnostic` under the `mythril` source.
 *
 * Mythril is slow — symbolic execution often takes tens of seconds
 * to multiple minutes per contract. The integration:
 *   - shows a long-running progress notification with a cancel
 *     button while the analyzer runs;
 *   - runs against a single file rather than the whole workspace
 *     (whole-project Mythril runs are not practical), targeting
 *     the active editor's `.sol` file by default;
 *   - auto-runs on save only when the user explicitly opts in via
 *     `solidity-workbench.mythril.enabled = true` (the setting
 *     defaults to false to avoid a save-time stall).
 */
export class MythrilIntegration {
  private diagnosticCollection: vscode.DiagnosticCollection;
  private outputChannel: vscode.OutputChannel;
  /** Latest in-flight run, so a save-burst doesn't stack analyses. */
  private inFlight: Promise<void> | null = null;

  constructor() {
    this.diagnosticCollection = vscode.languages.createDiagnosticCollection("mythril");
    this.outputChannel = vscode.window.createOutputChannel("Mythril");
  }

  dispose(): void {
    this.diagnosticCollection.dispose();
    this.outputChannel.dispose();
  }

  /**
   * Run Mythril against `targetUri` (or the active editor's file if
   * omitted). Silent no-op when the integration is disabled, the
   * target isn't a Solidity file, or another analysis is in flight.
   */
  async analyze(targetUri?: vscode.Uri): Promise<void> {
    const config = vscode.workspace.getConfiguration("solidity-workbench");
    if (!config.get<boolean>("mythril.enabled")) return;

    const target = targetUri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target || !target.fsPath.endsWith(".sol")) return;

    if (this.inFlight) return;

    const run = this.runOnce(target);
    this.inFlight = run;
    try {
      await run;
    } finally {
      this.inFlight = null;
    }
  }

  private async runOnce(target: vscode.Uri): Promise<void> {
    const config = vscode.workspace.getConfiguration("solidity-workbench");
    const mythrilPath = config.get<string>("mythril.path") || "myth";
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const cwd = workspaceFolder?.uri.fsPath ?? undefined;
    const fileName = basename(target.fsPath);

    this.outputChannel.appendLine(`Running Mythril on ${fileName}...`);
    this.diagnosticCollection.delete(target);

    let stdout = "";
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: `Mythril analyzing ${fileName}`,
          cancellable: false,
        },
        async () => {
          try {
            const result = await execFileAsync(
              mythrilPath,
              ["analyze", "-o", "json", target.fsPath],
              {
                cwd,
                maxBuffer: 50 * 1024 * 1024,
                // Mythril analyses can run for minutes; cap at 10 to
                // keep a runaway run from sitting forever.
                timeout: 10 * 60 * 1000,
              },
            );
            stdout = result.stdout;
          } catch (err: unknown) {
            // Mythril exits non-zero when findings exist. The JSON
            // ends up on stdout in that case; only surface the error
            // to the user when stdout is empty (genuine failure).
            const e = err as { stdout?: string; stderr?: string; message?: string };
            stdout = e.stdout ?? "";
            if (!stdout) {
              const message = e.stderr?.trim() || e.message || String(err);
              this.outputChannel.appendLine(`Mythril error: ${message}`);
              vscode.window.showErrorMessage(`Mythril analysis failed: ${message}`);
            }
          }
        },
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.outputChannel.appendLine(`Mythril error: ${message}`);
      return;
    }

    if (!stdout) return;

    const findings = parseMythrilReport(stdout);
    this.applyFindings(findings, target);
  }

  private applyFindings(findings: MythrilFinding[], target: vscode.Uri): void {
    if (findings.length === 0) {
      this.outputChannel.appendLine("No issues found.");
      return;
    }

    const diagnostics: vscode.Diagnostic[] = [];
    for (const finding of findings) {
      // Mythril reports filenames as the absolute path it was passed.
      // Anything that isn't this target is an oddity (a transitive
      // import flagged?) — surface it on the original target's
      // diagnostics list so the user actually sees it.
      const line = Math.max(0, finding.line - 1);
      const swcTag = finding.swcId ? ` [SWC-${finding.swcId}]` : "";
      const fnTag = finding.function ? ` (${finding.function})` : "";
      const message = `[mythril${swcTag}]${fnTag} ${finding.title}: ${finding.description}`.trim();
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(line, 0, line, 1000),
        message,
        toDiagnosticSeverity(finding.severity),
      );
      diagnostic.source = "mythril";
      diagnostic.code = finding.swcId ? `SWC-${finding.swcId}` : finding.title;
      diagnostics.push(diagnostic);
    }
    this.diagnosticCollection.set(target, diagnostics);

    const summary = summarizeMythril(findings);
    this.outputChannel.appendLine(
      `Mythril found ${summary.total} issues in ${basename(target.fsPath)} ` +
        `(${summary.high} high, ${summary.medium} medium, ${summary.low} low, ${summary.informational} informational).`,
    );
  }
}

function toDiagnosticSeverity(severity: MythrilFinding["severity"]): vscode.DiagnosticSeverity {
  switch (severity) {
    case "high":
      return vscode.DiagnosticSeverity.Error;
    case "medium":
    case "low":
      return vscode.DiagnosticSeverity.Warning;
    case "informational":
      return vscode.DiagnosticSeverity.Information;
  }
}
