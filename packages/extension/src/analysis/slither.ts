import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Slither static analysis integration.
 *
 * Runs slither on the workspace and surfaces findings as VSCode diagnostics.
 * Uses `--json` output format for structured results and maps them to
 * file locations with appropriate severity levels.
 *
 * Detector severity mapping:
 * - High / Medium → Error
 * - Low → Warning
 * - Informational / Optimization → Information
 */
export class SlitherIntegration {
  private diagnosticCollection: vscode.DiagnosticCollection;
  private outputChannel: vscode.OutputChannel;

  constructor() {
    this.diagnosticCollection = vscode.languages.createDiagnosticCollection("slither");
    this.outputChannel = vscode.window.createOutputChannel("Slither");
  }

  dispose(): void {
    this.diagnosticCollection.dispose();
    this.outputChannel.dispose();
  }

  /**
   * Run slither analysis on the workspace.
   */
  async analyze(): Promise<void> {
    const config = vscode.workspace.getConfiguration("solidity-workbench");
    const enabled = config.get<boolean>("slither.enabled");
    if (!enabled) return;

    const slitherPath = config.get<string>("slither.path") || "slither";
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return;

    this.outputChannel.appendLine("Running Slither analysis...");
    this.diagnosticCollection.clear();

    try {
      const result = await execFileAsync(
        slitherPath,
        [
          ".",
          "--json",
          "-",
          "--foundry-compile-all",
          "--exclude-informational",
          "--exclude-optimization",
        ],
        {
          cwd: workspaceFolder.uri.fsPath,
          maxBuffer: 50 * 1024 * 1024,
          timeout: 300_000, // 5 minutes
        },
      );

      this.processResults(result.stdout, workspaceFolder.uri);
    } catch (err: any) {
      // Slither exits non-zero when it finds issues
      if (err.stdout) {
        this.processResults(err.stdout, workspaceFolder.uri);
      } else {
        this.outputChannel.appendLine(`Slither error: ${err.message}`);
        vscode.window.showErrorMessage(`Slither analysis failed: ${err.message}`);
      }
    }
  }

  private processResults(jsonOutput: string, workspaceUri: vscode.Uri): void {
    try {
      const data = JSON.parse(jsonOutput);
      if (!data.results?.detectors) {
        this.outputChannel.appendLine("No issues found.");
        return;
      }

      const diagnosticMap = new Map<string, vscode.Diagnostic[]>();
      let totalFindings = 0;

      for (const detector of data.results.detectors) {
        totalFindings++;

        const severity = this.mapSeverity(detector.impact);
        const message = `[${detector.check}] ${detector.description}`;

        // Map source elements to file locations
        for (const element of detector.elements ?? []) {
          if (!element.source_mapping?.filename_relative) continue;

          const fileUri = vscode.Uri.joinPath(
            workspaceUri,
            element.source_mapping.filename_relative,
          );
          const filePath = fileUri.toString();

          const startLine = (element.source_mapping.lines?.[0] ?? 1) - 1;
          const endLine = (element.source_mapping.lines?.at(-1) ?? startLine + 1) - 1;

          const diagnostic = new vscode.Diagnostic(
            new vscode.Range(startLine, 0, endLine, 1000),
            message,
            severity,
          );
          diagnostic.source = "slither";
          diagnostic.code = detector.check;

          // Add related information if there are multiple elements
          if (detector.elements.length > 1) {
            diagnostic.relatedInformation = detector.elements
              .filter((e: any) => e !== element && e.source_mapping?.filename_relative)
              .slice(0, 5)
              .map((e: any) => {
                const relUri = vscode.Uri.joinPath(
                  workspaceUri,
                  e.source_mapping.filename_relative,
                );
                const relLine = (e.source_mapping.lines?.[0] ?? 1) - 1;
                return new vscode.DiagnosticRelatedInformation(
                  new vscode.Location(relUri, new vscode.Range(relLine, 0, relLine, 1000)),
                  e.name ?? "related",
                );
              });
          }

          const existing = diagnosticMap.get(filePath) ?? [];
          existing.push(diagnostic);
          diagnosticMap.set(filePath, existing);
        }
      }

      // Set diagnostics
      for (const [filePath, diagnostics] of diagnosticMap) {
        this.diagnosticCollection.set(vscode.Uri.parse(filePath), diagnostics);
      }

      this.outputChannel.appendLine(
        `Slither found ${totalFindings} findings across ${diagnosticMap.size} files.`,
      );
    } catch (err) {
      this.outputChannel.appendLine(`Failed to parse Slither output: ${err}`);
    }
  }

  private mapSeverity(impact: string): vscode.DiagnosticSeverity {
    switch (impact?.toLowerCase()) {
      case "high":
      case "medium":
        return vscode.DiagnosticSeverity.Error;
      case "low":
        return vscode.DiagnosticSeverity.Warning;
      case "informational":
      case "optimization":
        return vscode.DiagnosticSeverity.Information;
      default:
        return vscode.DiagnosticSeverity.Warning;
    }
  }
}
