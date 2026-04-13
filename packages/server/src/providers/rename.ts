import type {
  Position,
  Range,
  WorkspaceEdit,
  TextDocuments} from "vscode-languageserver/node.js";
import {
  TextEdit
} from "vscode-languageserver/node.js";
import type { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import * as fs from "node:fs";
import type { SymbolIndex } from "../analyzer/symbol-index.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";

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
   * Returns the range and placeholder text, or null if not renameable.
   */
  prepareRename(
    document: TextDocument,
    position: Position,
  ): { range: Range; placeholder: string } | null {
    const text = document.getText();
    const word = this.getWordAtPosition(text, position);
    if (!word) return null;

    // Check it's a known symbol
    const symbols = this.symbolIndex.findSymbols(word.text);
    if (symbols.length === 0) {
      // Not a known symbol — might be a local variable or keyword
      if (this.isSolidityKeyword(word.text)) return null;
      // Allow renaming even if not in the global index (could be a local)
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
    const text = document.getText();
    const word = this.getWordAtPosition(text, position);
    if (!word) return null;

    const oldName = word.text;
    if (oldName === newName) return null;

    // Validate the new name is a valid Solidity identifier
    if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(newName)) return null;

    const changes: Record<string, TextEdit[]> = {};

    // 1. Find all occurrences in currently open documents
    for (const doc of this.documents.all()) {
      const edits = this.findOccurrencesInText(doc.getText(), oldName, doc.uri);
      if (edits.length > 0) {
        changes[doc.uri] = edits.map((range) => TextEdit.replace(range, newName));
      }
    }

    // 2. Scan all workspace files (not currently open)
    const allUris = this.workspace.getAllFileUris();
    for (const uri of allUris) {
      if (changes[uri]) continue; // Already processed from open docs

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
        if (this.isInsideString(line, col)) continue;

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

  private isInsideString(line: string, position: number): boolean {
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < position; i++) {
      if (line[i] === "'" && !inDouble && (i === 0 || line[i - 1] !== "\\")) {
        inSingle = !inSingle;
      } else if (line[i] === '"' && !inSingle && (i === 0 || line[i - 1] !== "\\")) {
        inDouble = !inDouble;
      }
    }
    return inSingle || inDouble;
  }

  private isInsideLineComment(line: string, position: number): boolean {
    const commentStart = line.indexOf("//");
    return commentStart !== -1 && commentStart < position;
  }

  private getWordAtPosition(
    text: string,
    position: Position,
  ): { text: string; range: Range } | null {
    const lines = text.split("\n");
    if (position.line >= lines.length) return null;
    const line = lines[position.line];

    let start = position.character;
    let end = position.character;
    while (start > 0 && /[\w$]/.test(line[start - 1])) start--;
    while (end < line.length && /[\w$]/.test(line[end])) end++;

    if (start === end) return null;

    return {
      text: line.slice(start, end),
      range: {
        start: { line: position.line, character: start },
        end: { line: position.line, character: end },
      },
    };
  }

  private isSolidityKeyword(word: string): boolean {
    const keywords = new Set([
      "pragma",
      "import",
      "contract",
      "interface",
      "library",
      "abstract",
      "function",
      "modifier",
      "event",
      "error",
      "struct",
      "enum",
      "mapping",
      "constructor",
      "receive",
      "fallback",
      "public",
      "private",
      "internal",
      "external",
      "pure",
      "view",
      "payable",
      "virtual",
      "override",
      "immutable",
      "constant",
      "memory",
      "storage",
      "calldata",
      "if",
      "else",
      "for",
      "while",
      "do",
      "break",
      "continue",
      "return",
      "try",
      "catch",
      "revert",
      "require",
      "assert",
      "emit",
      "new",
      "delete",
      "type",
      "assembly",
      "unchecked",
      "using",
      "is",
      "as",
      "true",
      "false",
      "this",
      "super",
      "bool",
      "address",
      "string",
      "bytes",
      "uint",
      "int",
      "uint256",
      "int256",
      "msg",
      "block",
      "tx",
      "abi",
    ]);
    return keywords.has(word);
  }
}
