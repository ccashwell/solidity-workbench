import type { Position, Range, WorkspaceEdit, TextDocuments } from "vscode-languageserver/node.js";
import { TextEdit, ResponseError, ErrorCodes } from "vscode-languageserver/node.js";
import type { TextDocument } from "vscode-languageserver-textdocument";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SymbolIndex } from "../analyzer/symbol-index.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";
import { getWordAtPosition, isInsideString, SOLIDITY_KEYWORDS } from "../utils/text.js";

/**
 * Provides cross-file rename refactoring for Solidity symbols.
 *
 * Supports renaming:
 * - Contract / interface / library names
 * - Function names (including overrides in the inheritance chain)
 * - Event and error names
 * - State variable names
 * - Struct and enum names
 * - Modifier names
 *
 * Safety:
 * - prepareRename validates that the cursor is on a renameable symbol
 * - Scans all workspace files for occurrences
 * - Uses word-boundary matching to avoid false positives
 * - Preserves import aliases (only renames the source, not the alias)
 */
export class RenameProvider {
  constructor(
    private symbolIndex: SymbolIndex,
    private workspace: WorkspaceManager,
    private documents: TextDocuments<TextDocument>,
  ) {}

  /**
   * Validate that the cursor is on a renameable symbol.
   *
   * Returns the range and placeholder text, or `null` if the cursor is not on
   * a word (whitespace, punctuation) or is on a Solidity keyword.
   *
   * Throws a `ResponseError` (surfaced to the client as an inline error) when:
   *   - The identifier is not in the global symbol index (likely a local
   *     variable, parameter, or free identifier we cannot safely rescope).
   *   - The identifier resolves to multiple different symbol kinds, which
   *     would make a text-level rename ambiguous.
   */
  prepareRename(
    document: TextDocument,
    position: Position,
  ): { range: Range; placeholder: string } | null {
    const text = document.getText();
    const word = getWordAtPosition(text, position);
    if (!word) return null;

    if (SOLIDITY_KEYWORDS.has(word.text)) return null;

    const symbols = this.symbolIndex.findSymbols(word.text);
    if (symbols.length === 0) {
      throw new ResponseError(
        ErrorCodes.InvalidRequest,
        "Solidity Workbench does not yet support renaming local variables or parameters. " +
          "Only top-level symbols (contracts, functions, events, errors, structs, " +
          "enums, modifiers, state variables, UDVTs) can be renamed.",
      );
    }

    const uniqueKinds = Array.from(new Set(symbols.map((s) => s.kind))).sort();
    if (uniqueKinds.length > 1) {
      throw new ResponseError(
        ErrorCodes.InvalidRequest,
        `Cannot rename: '${word.text}' refers to multiple symbol kinds ` +
          `(${uniqueKinds.join(", ")}). Rename would be ambiguous.`,
      );
    }

    return {
      range: word.range,
      placeholder: word.text,
    };
  }

  /**
   * Perform the rename across all workspace files.
   */
  async provideRename(
    document: TextDocument,
    position: Position,
    newName: string,
  ): Promise<WorkspaceEdit | null> {
    // NOTE: This is a conservative implementation. True scope-aware rename
    // requires resolving solc AST `referencedDeclaration` IDs (see SolcBridge),
    // which is not yet wired into this provider. Until then, we:
    //   1. Refuse renames for identifiers not in the global symbol index (prepareRename)
    //   2. Refuse renames for ambiguous names (multiple symbol kinds)
    //   3. Exclude `lib/` directories from the edit set
    // This trades power for safety: top-level protocol symbols (contracts,
    // public functions, events, etc.) rename correctly; local variables and
    // parameters cannot be renamed yet.

    const text = document.getText();
    const wordResult = getWordAtPosition(text, position);
    if (!wordResult) return null;

    const oldName = wordResult.text;
    if (oldName === newName) return null;

    // Validate the new name is a valid Solidity identifier
    if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(newName)) return null;

    // Redundant guard: prepareRename should have already rejected this, but
    // we double-check so a stale client never triggers a global text rewrite.
    if (this.symbolIndex.findSymbols(oldName).length === 0) return null;

    const libDirs = this.workspace.libDirs;
    const isInLibDir = (uri: string): boolean => {
      const filePath = this.workspace.uriToPath(uri);
      return libDirs.some(
        (libDir) => filePath === libDir || filePath.startsWith(libDir + path.sep),
      );
    };

    const changes: Record<string, TextEdit[]> = {};

    // 1. Find all occurrences in currently open documents (skip lib/).
    for (const doc of this.documents.all()) {
      if (isInLibDir(doc.uri)) continue;
      const edits = this.findOccurrencesInText(doc.getText(), oldName, doc.uri);
      if (edits.length > 0) {
        changes[doc.uri] = edits.map((range) => TextEdit.replace(range, newName));
      }
    }

    // 2. Scan all workspace files (not currently open), skipping lib/.
    const allUris = this.workspace.getAllFileUris();
    for (const uri of allUris) {
      if (changes[uri]) continue; // Already processed from open docs
      if (isInLibDir(uri)) continue;

      try {
        const filePath = this.workspace.uriToPath(uri);
        const fileText = fs.readFileSync(filePath, "utf-8");
        const edits = this.findOccurrencesInText(fileText, oldName, uri);
        if (edits.length > 0) {
          changes[uri] = edits.map((range) => TextEdit.replace(range, newName));
        }
      } catch {
        // File might not exist or be unreadable
      }
    }

    if (Object.keys(changes).length === 0) return null;

    return { changes };
  }

  /**
   * Find all occurrences of a symbol name in text, using word-boundary matching.
   * Returns ranges for each occurrence.
   */
  private findOccurrencesInText(text: string, symbolName: string, uri: string): Range[] {
    const ranges: Range[] = [];
    const lines = text.split("\n");

    // Build a word-boundary regex
    const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`\\b${escaped}\\b`, "g");

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      const line = lines[lineNum];

      // Skip comments
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

      // Skip string literals (simple heuristic)
      let match: RegExpExecArray | null;
      regex.lastIndex = 0;

      while ((match = regex.exec(line)) !== null) {
        const col = match.index;

        // Check we're not inside a string literal
        if (isInsideString(line, col)) continue;

        // Check we're not inside a comment on this line
        if (this.isInsideLineComment(line, col)) continue;

        ranges.push({
          start: { line: lineNum, character: col },
          end: { line: lineNum, character: col + symbolName.length },
        });
      }
    }

    return ranges;
  }

  private isInsideLineComment(line: string, position: number): boolean {
    const commentStart = line.indexOf("//");
    return commentStart !== -1 && commentStart < position;
  }
}
