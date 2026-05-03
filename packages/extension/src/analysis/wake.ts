import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  parseWakeReport,
  summarizeWake,
  type WakeFinding,
  type WakeInstance,
} from "@solidity-workbench/common";

const execFileAsync = promisify(execFile);

/**
 * Wake (Ackee Blockchain) static-analysis integration.
 *
 * Runs `wake detect all --output-format json` in the workspace root,
 * parses the stdout via the shared `wake-report` helper, and surfaces
 * each finding as a VSCode `Diagnostic` under the `wake` source.
 *
 * Parallel to `AderynIntegration` and `SlitherIntegration` in shape —
 * keyed by the `solidity-workbench.wake.enabled` /
 * `solidity-workbench.wake.path` settings, with an optional
 * auto-run-on-save hook wired in `extension.ts`. Wake writes its
 * report to stdout (no `--output` flag like Aderyn), so we capture
 * `stdout` instead of a temp file.
 */
export class WakeIntegration {
  private diagnosticCollection: vscode.DiagnosticCollection;
  private outputChannel: vscode.OutputChannel;

  constructor() {
    this.diagnosticCollection = vscode.languages.createDiagnosticCollection("wake");
    this.outputChannel = vscode.window.createOutputChannel("Wake");
  }

  dispose(): void {
    this.diagnosticCollection.dispose();
    this.outputChannel.dispose();
  }

  /**
   * Run Wake against the primary workspace folder. Silent no-op when
   * the integration is disabled or the workspace is empty. Wake exits
   * non-zero when it finds issues; we still process the JSON in that
   * case as long as stdout looks like a parseable report.
   */
  async analyze(): Promise<void> {
    const config = vscode.workspace.getConfiguration("solidity-workbench");
    const enabled = config.get<boolean>("wake.enabled");
    if (!enabled) return;

    const wakePath = config.get<string>("wake.path") || "wake";
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return;

    this.outputChannel.appendLine("Running Wake analysis...");
    this.diagnosticCollection.clear();

    let stdout = "";
    try {
      const result = await execFileAsync(
        wakePath,
        ["detect", "all", "--output-format", "json"],
        {
          cwd: workspaceFolder.uri.fsPath,
          maxBuffer: 50 * 1024 * 1024,
          timeout: 300_000,
        },
      );
      stdout = result.stdout;
    } catch (err: unknown) {
      // Wake exits non-zero when findings exist. The report still
      // ends up on stdout in that case, so try to parse before
      // declaring the run a failure.
      const e = err as { stdout?: string; stderr?: string; message?: string };
      stdout = e.stdout ?? "";
      if (!stdout) {
        const message = e.stderr?.trim() || e.message || String(err);
        this.outputChannel.appendLine(`Wake error: ${message}`);
        vscode.window.showErrorMessage(`Wake analysis failed: ${message}`);
        return;
      }
    }

    const findings = parseWakeReport(stdout);
    if (findings.length === 0 && !looksLikeWakeJson(stdout)) {
      // Wake printed something that wasn't JSON (e.g. "no
      // detectors enabled"). Surface verbatim so the user can act.
      this.outputChannel.appendLine(stdout);
      return;
    }
    this.applyFindings(findings, workspaceFolder.uri);
  }

  private applyFindings(findings: WakeFinding[], workspaceUri: vscode.Uri): void {
    if (findings.length === 0) {
      this.outputChannel.appendLine("No issues found.");
      return;
    }

    const diagnosticsByFile = new Map<string, vscode.Diagnostic[]>();

    for (const finding of findings) {
      const severity = toDiagnosticSeverity(finding.impact);
      const message = `[${finding.detector}] ${finding.message || finding.detector} (confidence: ${finding.confidence})`;

      for (const instance of finding.instances) {
        const fileUri = resolveInstanceUri(workspaceUri, instance);
        const key = fileUri.toString();
        const range = toRange(instance);
        const diagnostic = new vscode.Diagnostic(range, message, severity);
        diagnostic.source = "wake";
        diagnostic.code = finding.detector;

        if (finding.instances.length > 1) {
          diagnostic.relatedInformation = finding.instances
            .filter((e) => e !== instance)
            .slice(0, 5)
            .map((e) => {
              const relUri = resolveInstanceUri(workspaceUri, e);
              return new vscode.DiagnosticRelatedInformation(
                new vscode.Location(relUri, toRange(e)),
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

    const summary = summarizeWake(findings);
    this.outputChannel.appendLine(
      `Wake found ${summary.total} issues across ${diagnosticsByFile.size} files ` +
        `(${summary.high} high, ${summary.medium} medium, ${summary.low} low, ${summary.warning} warning, ${summary.info} info).`,
    );
  }
}

function toDiagnosticSeverity(impact: WakeFinding["impact"]): vscode.DiagnosticSeverity {
  switch (impact) {
    case "high":
      return vscode.DiagnosticSeverity.Error;
    case "medium":
    case "low":
    case "warning":
      return vscode.DiagnosticSeverity.Warning;
    case "info":
      return vscode.DiagnosticSeverity.Information;
  }
}

/**
 * Wake's location uses 1-based line/column; LSP ranges are 0-based.
 * When an end position is missing we fall back to a single-character
 * span at the start (caller-visible range; users can still navigate).
 */
function toRange(instance: WakeInstance): vscode.Range {
  const startLine = Math.max(0, instance.line - 1);
  const startCol = instance.column !== undefined ? Math.max(0, instance.column - 1) : 0;
  const endLine =
    instance.endLine !== undefined ? Math.max(0, instance.endLine - 1) : startLine;
  const endCol =
    instance.endColumn !== undefined
      ? Math.max(0, instance.endColumn - 1)
      : instance.column !== undefined
        ? startCol + 1
        : 1000;
  return new vscode.Range(startLine, startCol, endLine, endCol);
}

/**
 * Wake emits `source_unit_name` as either workspace-relative (when
 * invoked at the project root) or absolute (otherwise). Mirrors the
 * Aderyn integration's path resolver.
 */
function resolveInstanceUri(workspaceUri: vscode.Uri, instance: WakeInstance): vscode.Uri {
  const path = instance.contractPath;
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) {
    return vscode.Uri.file(path);
  }
  return vscode.Uri.joinPath(workspaceUri, path);
}

/**
 * Cheap heuristic to tell apart "Wake printed JSON we couldn't
 * parse" from "Wake printed a human-readable status message". Used
 * so the latter shows up in the output channel instead of being
 * silently dropped.
 */
function looksLikeWakeJson(stdout: string): boolean {
  const trimmed = stdout.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}
