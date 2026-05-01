import type { Connection, Diagnostic, TextDocuments } from "vscode-languageserver/node.js";
import { DiagnosticSeverity } from "vscode-languageserver/node.js";
import type { TextDocument } from "vscode-languageserver-textdocument";
import * as fs from "node:fs";
import * as path from "node:path";
import { URI } from "vscode-uri";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";
import { SolidityLinter } from "./linter.js";
import type { SolidityParser } from "../parser/solidity-parser.js";
import { LineIndex } from "../utils/line-index.js";

/**
 * solc warning codes whose semantics are exclusively about *deployment*
 * to a real chain. These are noise on `test/` and `script/` files —
 * Foundry test contracts run inside the local EVM where the Spurious
 * Dragon and Shanghai size limits don't apply.
 *
 * - 5574: contract code size exceeds 24,576 bytes (Spurious Dragon)
 * - 3860: contract initcode size exceeds 49,152 bytes (Shanghai)
 */
export const DEPLOY_ONLY_SOLC_CODES: ReadonlySet<string> = new Set(["5574", "3860"]);

/**
 * True when a solc error/warning should be hidden from the user given
 * the tier its file belongs to. Currently only filters
 * `DEPLOY_ONLY_SOLC_CODES` on `tests`-tier files; `project` and `deps`
 * are unaffected.
 */
export function shouldSuppressForTier(
  errorCode: string | undefined,
  tier: "project" | "tests" | "deps" | null,
): boolean {
  if (!errorCode || tier !== "tests") return false;
  return DEPLOY_ONLY_SOLC_CODES.has(errorCode);
}

/**
 * True when our own linter + syntax-rule warnings should run on the
 * given file tier. These rules (missing-event, floating-pragma,
 * tx-origin, deprecated-selfdestruct, reentrancy, storage-in-loop,
 * unchecked-call, ...) are designed for deployable contracts. On
 * `tests`-tier files they're noise — tests aren't deployed and
 * aren't indexed. On `deps`-tier files (third-party libraries) the
 * user can't act on findings. Returns true only for `project` and
 * unknown-tier files (fail-open for files not yet classified).
 */
export function shouldRunStaticAnalysis(tier: "project" | "tests" | "deps" | null): boolean {
  return tier === "project" || tier === null;
}

/**
 * Provides diagnostics (errors/warnings) from three sources:
 *
 * 1. **Fast path** (on every change): Parser-based syntax errors
 * 2. **Lint path** (on change, debounced): Custom security/best-practice rules
 * 3. **Full path** (on save): `forge build --json` for compiler errors
 *
 * The triple-path approach gives instant feedback for typos and syntax,
 * security warnings from our linter, and full compiler diagnostics on save.
 */
export class DiagnosticsProvider {
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private debounceMs = 300;
  private linter = new SolidityLinter();
  private parser: SolidityParser | undefined;

  constructor(
    private workspace: WorkspaceManager,
    private connection: Connection,
    private documents: TextDocuments<TextDocument>,
  ) {}

  /** Set the parser reference for lint integration */
  setParser(parser: SolidityParser): void {
    this.parser = parser;
  }

  /**
   * Update the debounce window for fast diagnostics. Wired to the
   * `solidity-workbench.diagnostics.debounceMs` client setting so the
   * user can tune it without restarting the server. Clamped to [50,
   * 2000] to avoid degenerate configurations.
   */
  setDebounceMs(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) return;
    this.debounceMs = Math.max(50, Math.min(2000, Math.round(ms)));
  }

  /**
   * Fast diagnostics from parser — runs on every change with debouncing.
   */
  async provideFastDiagnostics(uri: string, text: string): Promise<void> {
    const existing = this.debounceTimers.get(uri);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(
      uri,
      setTimeout(() => {
        // Skip static analysis on test/script and dependency files —
        // their findings are noise (see `shouldRunStaticAnalysis`).
        // Still publish an empty list so any previously-shown
        // diagnostics from before a file was reclassified are cleared.
        if (!shouldRunStaticAnalysis(this.workspace.getFileTier(uri))) {
          this.connection.sendDiagnostics({ uri, diagnostics: [] });
          return;
        }

        const diagnostics = DiagnosticsProvider.extractSyntaxDiagnostics(text);

        if (this.parser) {
          const result = this.parser.get(uri);
          if (result) {
            // Pass the raw AST so the linter's AST-based rules (reentrancy,
            // missing-event, storage-in-loop, unchecked-call, delegatecall,
            // unprotected-selfdestruct) can run. When parsing failed, `rawAst`
            // is null and those rules silently skip.
            diagnostics.push(...this.linter.lint(result.sourceUnit, text, result.rawAst));
          }
        }

        this.connection.sendDiagnostics({ uri, diagnostics });
      }, this.debounceMs),
    );
  }

  /**
   * Full diagnostics from forge build — runs on save.
   *
   * Returns aggregate error / warning counts so the server can publish
   * a `solidity-workbench/serverState` heartbeat after every build. On
   * failure we still return `{ errorCount: 0, warningCount: 0 }` rather
   * than throwing, so the caller's heartbeat logic stays simple.
   */
  async provideFullDiagnostics(
    _uri: string,
  ): Promise<{ errorCount: number; warningCount: number }> {
    try {
      const result = await this.workspace.runForge(["build", "--json"]);
      const diagnosticsByFile = this.parseForgeOutput(result.stdout, result.stderr);

      let errorCount = 0;
      let warningCount = 0;
      for (const [fileUri, diags] of diagnosticsByFile) {
        for (const d of diags) {
          if (d.severity === DiagnosticSeverity.Error) errorCount += 1;
          else if (d.severity === DiagnosticSeverity.Warning) warningCount += 1;
        }
        this.connection.sendDiagnostics({ uri: fileUri, diagnostics: diags });
      }

      const allUris = this.workspace.getAllFileUris();
      for (const fileUri of allUris) {
        if (!diagnosticsByFile.has(fileUri)) {
          this.connection.sendDiagnostics({
            uri: fileUri,
            diagnostics: [],
          });
        }
      }

      return { errorCount, warningCount };
    } catch (err) {
      this.connection.console.error(`forge build failed: ${err}`);
      return { errorCount: 0, warningCount: 0 };
    }
  }

  /**
   * Extract syntax-level diagnostics from the source text.
   *
   * These are the fast, parser-independent checks we run on every
   * keystroke: SPDX header, floating-pragma warning, `tx.origin`
   * misuse, deprecated `selfdestruct`. Exposed as a static helper so
   * tests can drive it directly without spinning up a real LSP
   * connection or debounce timer.
   */
  static extractSyntaxDiagnostics(text: string): Diagnostic[] {
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
            message:
              "Missing SPDX license identifier. Consider adding: // SPDX-License-Identifier: MIT",
            source: "solidity-workbench",
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
              message:
                "Floating pragma detected. Consider pinning the Solidity version for deployable contracts.",
              source: "solidity-workbench",
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
          source: "solidity-workbench",
          code: "tx-origin",
        });
      }

      // Check for selfdestruct usage
      if (
        trimmed.includes("selfdestruct") &&
        !trimmed.startsWith("//") &&
        !trimmed.startsWith("*")
      ) {
        diagnostics.push({
          severity: DiagnosticSeverity.Warning,
          range: {
            start: { line: i, character: line.indexOf("selfdestruct") },
            end: { line: i, character: line.indexOf("selfdestruct") + 12 },
          },
          message:
            "selfdestruct is deprecated (EIP-6049). It no longer destroys the contract on most EVM chains.",
          source: "solidity-workbench",
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
  private parseForgeOutput(stdout: string, stderr: string): Map<string, Diagnostic[]> {
    const diagnosticsByFile = new Map<string, Diagnostic[]>();

    // Try parsing as JSON first (forge build --json)
    try {
      const output = JSON.parse(stdout);
      if (output.errors) {
        // Cache LineIndex per file so we only read and index each file once
        const lineIndexCache = new Map<string, LineIndex | null>();
        for (const error of output.errors) {
          let lineIndex: LineIndex | null = null;
          if (error.sourceLocation?.file) {
            const filePath = path.join(this.workspace.root, error.sourceLocation.file);
            if (!lineIndexCache.has(filePath)) {
              try {
                const text = fs.readFileSync(filePath, "utf-8");
                lineIndexCache.set(filePath, LineIndex.fromText(text));
              } catch {
                lineIndexCache.set(filePath, null);
              }
            }
            lineIndex = lineIndexCache.get(filePath) ?? null;
          }
          this.parseSolcError(error, diagnosticsByFile, lineIndex);
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

      const fileUri = URI.file(path.join(this.workspace.root, file)).toString();

      if (shouldSuppressForTier(code, this.workspace.getFileTier(fileUri))) continue;

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
    lineIndex: LineIndex | null,
  ): void {
    if (!error.sourceLocation) return;

    const file = error.sourceLocation.file;
    if (!file) return;

    const fileUri = URI.file(path.join(this.workspace.root, file)).toString();

    // Suppress deploy-only warnings on test/script files — they're never
    // deployed, so Spurious Dragon / Shanghai size warnings are noise.
    if (shouldSuppressForTier(error.errorCode, this.workspace.getFileTier(fileUri))) {
      return;
    }

    const diags = diagnosticsByFile.get(fileUri) ?? [];

    // Convert solc UTF-8 byte offsets to LSP Positions via the line index
    let start = { line: 0, character: 0 };
    let end = { line: 0, character: 0 };
    if (lineIndex) {
      if (typeof error.sourceLocation.start === "number") {
        start = lineIndex.positionAt(error.sourceLocation.start);
      }
      if (typeof error.sourceLocation.end === "number") {
        end = lineIndex.positionAt(error.sourceLocation.end);
      } else {
        end = start;
      }
    }

    diags.push({
      severity:
        error.severity === "error"
          ? DiagnosticSeverity.Error
          : error.severity === "warning"
            ? DiagnosticSeverity.Warning
            : DiagnosticSeverity.Information,
      range: { start, end },
      message: error.message || error.formattedMessage || "Unknown error",
      source: "solc",
      code: error.errorCode,
    });

    diagnosticsByFile.set(fileUri, diags);
  }
}
