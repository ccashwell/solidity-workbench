import {
  Connection,
  Diagnostic,
  DiagnosticSeverity,
  TextDocuments,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import { WorkspaceManager } from "../workspace/workspace-manager.js";

/**
 * Provides diagnostics (errors/warnings) from two sources:
 *
 * 1. **Fast path** (on every change): Parser-based syntax errors
 * 2. **Full path** (on save): `forge build --format-json` for compiler errors
 *
 * The dual-path approach gives instant feedback for typos and syntax errors
 * while still showing full compiler diagnostics after save.
 */
export class DiagnosticsProvider {
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(
    private workspace: WorkspaceManager,
    private connection: Connection,
    private documents: TextDocuments<TextDocument>,
  ) {}

  /**
   * Fast diagnostics from parser — runs on every change with debouncing.
   */
  async provideFastDiagnostics(uri: string, text: string): Promise<void> {
    // Debounce
    const existing = this.debounceTimers.get(uri);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(
      uri,
      setTimeout(() => {
        const diagnostics = this.extractSyntaxDiagnostics(text);
        this.connection.sendDiagnostics({ uri, diagnostics });
      }, 300),
    );
  }

  /**
   * Full diagnostics from forge build — runs on save.
   */
  async provideFullDiagnostics(uri: string): Promise<void> {
    try {
      const result = await this.workspace.runForge([
        "build",
        "--format-json",
      ]);

      // Parse forge build JSON output for errors
      const diagnosticsByFile = this.parseForgeOutput(result.stdout, result.stderr);

      // Send diagnostics for all affected files
      for (const [fileUri, diags] of diagnosticsByFile) {
        this.connection.sendDiagnostics({ uri: fileUri, diagnostics: diags });
      }

      // Clear diagnostics for files that had no errors
      const allUris = this.workspace.getAllFileUris();
      for (const fileUri of allUris) {
        if (!diagnosticsByFile.has(fileUri)) {
          this.connection.sendDiagnostics({
            uri: fileUri,
            diagnostics: [],
          });
        }
      }
    } catch (err) {
      this.connection.console.error(`forge build failed: ${err}`);
    }
  }

  /**
   * Extract syntax-level diagnostics from the source text.
   * These are fast, parser-independent checks.
   */
  private extractSyntaxDiagnostics(text: string): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const lines = text.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Check for missing SPDX license
      if (i === 0 && !trimmed.startsWith("//") && !trimmed.startsWith("/*")) {
        // Only warn if there's no SPDX anywhere in the first 5 lines
        const first5 = lines.slice(0, 5).join("\n");
        if (!first5.includes("SPDX-License-Identifier")) {
          diagnostics.push({
            severity: DiagnosticSeverity.Warning,
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 0 },
            },
            message: "Missing SPDX license identifier. Consider adding: // SPDX-License-Identifier: MIT",
            source: "solforge",
            code: "missing-spdx",
          });
        }
      }

      // Check for pragma version
      if (trimmed.startsWith("pragma solidity")) {
        const versionMatch = trimmed.match(/pragma solidity\s+(.+?)\s*;/);
        if (versionMatch) {
          const version = versionMatch[1];
          // Warn about floating pragmas in non-library code
          if (version.startsWith("^") || version.startsWith(">=")) {
            diagnostics.push({
              severity: DiagnosticSeverity.Information,
              range: {
                start: { line: i, character: 0 },
                end: { line: i, character: line.length },
              },
              message: "Floating pragma detected. Consider pinning the Solidity version for deployable contracts.",
              source: "solforge",
              code: "floating-pragma",
            });
          }
        }
      }

      // Check for tx.origin usage (common security issue)
      if (trimmed.includes("tx.origin") && !trimmed.startsWith("//") && !trimmed.startsWith("*")) {
        diagnostics.push({
          severity: DiagnosticSeverity.Warning,
          range: {
            start: { line: i, character: line.indexOf("tx.origin") },
            end: { line: i, character: line.indexOf("tx.origin") + 9 },
          },
          message: "Avoid using tx.origin for authorization. Use msg.sender instead.",
          source: "solforge",
          code: "tx-origin",
        });
      }

      // Check for selfdestruct usage
      if (trimmed.includes("selfdestruct") && !trimmed.startsWith("//") && !trimmed.startsWith("*")) {
        diagnostics.push({
          severity: DiagnosticSeverity.Warning,
          range: {
            start: { line: i, character: line.indexOf("selfdestruct") },
            end: { line: i, character: line.indexOf("selfdestruct") + 12 },
          },
          message: "selfdestruct is deprecated (EIP-6049). It no longer destroys the contract on most EVM chains.",
          source: "solforge",
          code: "deprecated-selfdestruct",
        });
      }

      // Detect unmatched braces (simple count)
      // This will be replaced by the full parser
    }

    return diagnostics;
  }

  /**
   * Parse forge build output into diagnostics per file.
   * Forge outputs JSON with errors in the standard solc format.
   */
  private parseForgeOutput(
    stdout: string,
    stderr: string,
  ): Map<string, Diagnostic[]> {
    const diagnosticsByFile = new Map<string, Diagnostic[]>();

    // Try parsing as JSON first (forge build --format-json)
    try {
      const output = JSON.parse(stdout);
      if (output.errors) {
        for (const error of output.errors) {
          this.parseSolcError(error, diagnosticsByFile);
        }
      }
      return diagnosticsByFile;
    } catch {
      // Not JSON, fall through to regex parsing
    }

    // Parse stderr for solc-style error messages
    // Format: Error (NNNN): Message\n --> file:line:col:\n
    const errorRe =
      /(Error|Warning|Info)\s*(?:\((\d+)\))?\s*:\s*(.*?)(?:\n\s*-->\s*(.+?):(\d+):(\d+))?/g;

    const source = stderr || stdout;
    let match: RegExpExecArray | null;

    while ((match = errorRe.exec(source)) !== null) {
      const severity = match[1];
      const code = match[2] ?? "";
      const message = match[3].trim();
      const file = match[4];
      const line = match[5] ? parseInt(match[5]) - 1 : 0;
      const col = match[6] ? parseInt(match[6]) - 1 : 0;

      if (!file) continue;

      const fileUri = `file://${this.workspace.root}/${file}`;
      const diags = diagnosticsByFile.get(fileUri) ?? [];

      diags.push({
        severity:
          severity === "Error"
            ? DiagnosticSeverity.Error
            : severity === "Warning"
              ? DiagnosticSeverity.Warning
              : DiagnosticSeverity.Information,
        range: {
          start: { line, character: col },
          end: { line, character: col + 1 },
        },
        message,
        source: "solc",
        code,
      });

      diagnosticsByFile.set(fileUri, diags);
    }

    return diagnosticsByFile;
  }

  private parseSolcError(
    error: any,
    diagnosticsByFile: Map<string, Diagnostic[]>,
  ): void {
    if (!error.sourceLocation) return;

    const file = error.sourceLocation.file;
    if (!file) return;

    const fileUri = `file://${this.workspace.root}/${file}`;
    const diags = diagnosticsByFile.get(fileUri) ?? [];

    // solc provides byte offset, we need line/col
    // For now use start=0,0 — the full implementation maps byte offsets
    diags.push({
      severity:
        error.severity === "error"
          ? DiagnosticSeverity.Error
          : error.severity === "warning"
            ? DiagnosticSeverity.Warning
            : DiagnosticSeverity.Information,
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      },
      message: error.message || error.formattedMessage || "Unknown error",
      source: "solc",
      code: error.errorCode,
    });

    diagnosticsByFile.set(fileUri, diags);
  }
}
