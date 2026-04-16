import type { FormattingOptions, Range } from "vscode-languageserver/node.js";
import { DocumentFormattingParams, TextEdit } from "vscode-languageserver/node.js";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

/**
 * Provides document formatting via `forge fmt`.
 *
 * Uses forge fmt directly so formatting matches what the developer gets
 * from running `forge fmt` on the command line. Respects foundry.toml
 * [fmt] configuration.
 */
export class FormattingProvider {
  constructor(private workspace: WorkspaceManager) {}

  async format(document: TextDocument, options: FormattingOptions): Promise<TextEdit[]> {
    return this.formatDocument(document);
  }

  async formatRange(
    document: TextDocument,
    range: Range,
    options: FormattingOptions,
  ): Promise<TextEdit[]> {
    // forge fmt doesn't support range formatting natively,
    // so we format the whole document then filter edits to the requested range.
    const fullEdits = await this.formatDocument(document);
    if (fullEdits.length === 0) return [];

    // The full edit replaces the entire document. Extract only the lines in range.
    const formatted = fullEdits[0].newText;
    const original = document.getText();
    const origLines = original.split("\n");
    const fmtLines = formatted.split("\n");

    // Find edits within the range using line-by-line diff
    const edits: TextEdit[] = [];
    const startLine = range.start.line;
    const endLine = Math.min(range.end.line, origLines.length - 1, fmtLines.length - 1);

    for (let i = startLine; i <= endLine; i++) {
      if (i < origLines.length && i < fmtLines.length && origLines[i] !== fmtLines[i]) {
        edits.push(
          TextEdit.replace(
            {
              start: { line: i, character: 0 },
              end: { line: i, character: origLines[i].length },
            },
            fmtLines[i],
          ),
        );
      }
    }

    return edits;
  }

  private async formatDocument(document: TextDocument): Promise<TextEdit[]> {
    const text = document.getText();

    // Write to a temp file, run forge fmt, read back
    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, `solidity-workbench-fmt-${crypto.randomUUID()}.sol`);

    try {
      fs.writeFileSync(tmpFile, text, "utf-8");

      const result = await this.workspace.runForge(["fmt", tmpFile]);

      if (result.exitCode !== 0) {
        // forge fmt failed — return no edits rather than corrupting the file
        return [];
      }

      const formatted = fs.readFileSync(tmpFile, "utf-8");

      if (formatted === text) {
        return []; // No changes needed
      }

      // Replace the entire document
      const lastLine = text.split("\n").length - 1;
      const lastChar = text.split("\n")[lastLine]?.length ?? 0;

      return [
        TextEdit.replace(
          {
            start: { line: 0, character: 0 },
            end: { line: lastLine, character: lastChar },
          },
          formatted,
        ),
      ];
    } finally {
      // Clean up temp file
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        /* cleanup failed, non-critical */
      }
    }
  }
}
