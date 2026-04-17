import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseAderynReport,
  summarizeAderyn,
  type AderynFinding,
  type AderynInstance,
} from "@solidity-workbench/common";

const execFileAsync = promisify(execFile);

/**
 * Aderyn (Cyfrin) static analysis integration.
 *
 * Runs `aderyn` in the workspace root, asks it to write a JSON report
 * to a temporary file, parses the report via the shared
 * `@solidity-workbench/common/aderyn-report` helper, and surfaces
 * each finding as a VSCode `Diagnostic` under the `aderyn` source.
 *
 * Parallel to `SlitherIntegration` in structure — keyed by the
 * `solidity-workbench.aderyn.enabled` / `solidity-workbench.aderyn.path`
 * settings, with an optional auto-run-on-save hook wired in
 * `extension.ts`.
 */
export class AderynIntegration {
  private diagnosticCollection: vscode.DiagnosticCollection;
  private outputChannel: vscode.OutputChannel;

  constructor() {
    this.diagnosticCollection = vscode.languages.createDiagnosticCollection("aderyn");
    this.outputChannel = vscode.window.createOutputChannel("Aderyn");
  }

  dispose(): void {
    this.diagnosticCollection.dispose();
    this.outputChannel.dispose();
  }

  /**
   * Run Aderyn against the primary workspace folder. Silent no-op when
   * the integration is disabled or the workspace is empty. Aderyn
   * exits non-zero when it finds issues; we still process the
   * generated report in that case.
   */
  async analyze(): Promise<void> {
    const config = vscode.workspace.getConfiguration("solidity-workbench");
    const enabled = config.get<boolean>("aderyn.enabled");
    if (!enabled) return;

    const aderynPath = config.get<string>("aderyn.path") || "aderyn";
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return;

    const tmp = mkdtempSync(join(tmpdir(), "solidity-workbench-aderyn-"));
    const reportPath = join(tmp, "report.json");

    this.outputChannel.appendLine("Running Aderyn analysis...");
    this.diagnosticCollection.clear();

    try {
      await execFileAsync(aderynPath, ["--output", reportPath, "."], {
        cwd: workspaceFolder.uri.fsPath,
        maxBuffer: 50 * 1024 * 1024,
        timeout: 300_000, // 5 minutes
      });
    } catch (err: unknown) {
      // Aderyn exits non-zero when findings exist. Only surface the
      // error if we don't have a report to read.
      try {
        readFileSync(reportPath, "utf-8");
      } catch {
        const message = err instanceof Error ? err.message : String(err);
        this.outputChannel.appendLine(`Aderyn error: ${message}`);
        vscode.window.showErrorMessage(`Aderyn analysis failed: ${message}`);
        rmSync(tmp, { recursive: true, force: true });
        return;
      }
    }

    try {
      const json = readFileSync(reportPath, "utf-8");
      const findings = parseAderynReport(json);
      this.applyFindings(findings, workspaceFolder.uri);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.outputChannel.appendLine(`Failed to read Aderyn report: ${message}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  private applyFindings(findings: AderynFinding[], workspaceUri: vscode.Uri): void {
    if (findings.length === 0) {
      this.outputChannel.appendLine("No issues found.");
      return;
    }

    const diagnosticsByFile = new Map<string, vscode.Diagnostic[]>();

    for (const finding of findings) {
      const severity = toDiagnosticSeverity(finding.severity);
      const message = `[${finding.detector}] ${finding.title}`;

      for (const instance of finding.instances) {
        const fileUri = resolveInstanceUri(workspaceUri, instance);
        const key = fileUri.toString();
        // Aderyn line numbers are 1-based; LSP ranges are 0-based. We
        // don't have column info in the JSON, so we span the whole
        // line (0..1000 handles every realistic source line).
        const line = Math.max(0, instance.line - 1);
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(line, 0, line, 1000),
          message,
          severity,
        );
        diagnostic.source = "aderyn";
        diagnostic.code = finding.detector;

        // Attach other instances of the same finding as related
        // information, capped to keep the popup tidy.
        if (finding.instances.length > 1) {
          diagnostic.relatedInformation = finding.instances
            .filter((e) => e !== instance)
            .slice(0, 5)
            .map((e) => {
              const relUri = resolveInstanceUri(workspaceUri, e);
              const relLine = Math.max(0, e.line - 1);
              return new vscode.DiagnosticRelatedInformation(
                new vscode.Location(relUri, new vscode.Range(relLine, 0, relLine, 1000)),
                `Also here (${finding.detector})`,
              );
            });
        }

        const existing = diagnosticsByFile.get(key) ?? [];
        existing.push(diagnostic);
        diagnosticsByFile.set(key, existing);
      }
    }

    for (const [key, diagnostics] of diagnosticsByFile) {
      this.diagnosticCollection.set(vscode.Uri.parse(key), diagnostics);
    }

    const summary = summarizeAderyn(findings);
    this.outputChannel.appendLine(
      `Aderyn found ${summary.total} issues across ${diagnosticsByFile.size} files ` +
        `(${summary.high} high, ${summary.low} low, ${summary.nc} non-critical).`,
    );
  }
}

function toDiagnosticSeverity(sev: AderynFinding["severity"]): vscode.DiagnosticSeverity {
  switch (sev) {
    case "high":
      return vscode.DiagnosticSeverity.Error;
    case "low":
      return vscode.DiagnosticSeverity.Warning;
    case "nc":
      return vscode.DiagnosticSeverity.Information;
  }
}

/**
 * Aderyn emits `contract_path` as either:
 *   - a workspace-relative path (`src/Foo.sol`) when invoked at the
 *     workspace root, or
 *   - an absolute path in other cases.
 *
 * Handle both without probing the filesystem.
 */
function resolveInstanceUri(workspaceUri: vscode.Uri, instance: AderynInstance): vscode.Uri {
  const path = instance.contractPath;
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) {
    return vscode.Uri.file(path);
  }
  return vscode.Uri.joinPath(workspaceUri, path);
}
