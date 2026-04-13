import type { Position, ReferenceContext, TextDocuments } from "vscode-languageserver/node.js";
import { Location } from "vscode-languageserver/node.js";
import type { TextDocument } from "vscode-languageserver-textdocument";
import * as fs from "node:fs";
import type { SymbolIndex } from "../analyzer/symbol-index.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";
import type { SolidityParser } from "../parser/solidity-parser.js";
import { getWordAtPosition, isInsideString, findLineCommentStart } from "../utils/text.js";

/**
 * Full workspace-wide find-all-references.
 *
 * Strategy:
 * 1. Identify the symbol at the cursor position
 * 2. Search all indexed files for textual occurrences
 * 3. Filter by word boundary to avoid false positives
 * 4. Include/exclude the declaration based on ReferenceContext
 *
 * The dual approach (symbol index + text search) catches both:
 * - Declarations and definitions (from the symbol index)
 * - Usages in function bodies (from text scanning)
 *
 * For maximum accuracy, the rich AST (solc) path would provide
 * scope-aware reference resolution. The text search is a pragmatic
 * 90% solution that works across the entire workspace.
 */
export class ReferencesProvider {
  constructor(
    private symbolIndex: SymbolIndex,
    private workspace: WorkspaceManager,
    private parser: SolidityParser,
    private documents: TextDocuments<TextDocument>,
  ) {}

  provideReferences(
    document: TextDocument,
    position: Position,
    context: ReferenceContext,
  ): Location[] {
    const text = document.getText();
    const word = getWordAtPosition(text, position)?.text ?? null;
    if (!word) return [];

    const references: Location[] = [];
    const seen = new Set<string>(); // Deduplicate by "uri:line:char"

    // 1. Check the symbol index for declarations
    if (context.includeDeclaration) {
      const symbols = this.symbolIndex.findSymbols(word);
      for (const sym of symbols) {
        const key = `${sym.filePath}:${sym.nameRange.start.line}:${sym.nameRange.start.character}`;
        if (!seen.has(key)) {
          seen.add(key);
          references.push(Location.create(sym.filePath, sym.nameRange));
        }
      }
    }

    // 2. Scan all open documents for textual occurrences
    for (const doc of this.documents.all()) {
      this.findInText(doc.getText(), word, doc.uri, references, seen);
    }

    // 3. Scan all workspace files not currently open
    const allUris = this.workspace.getAllFileUris();
    for (const uri of allUris) {
      if (this.documents.get(uri)) continue; // Already scanned above

      try {
        const filePath = this.workspace.uriToPath(uri);
        const fileText = fs.readFileSync(filePath, "utf-8");
        this.findInText(fileText, word, uri, references, seen);
      } catch {
        // File might not exist or be unreadable
      }
    }

    return references;
  }

  /**
   * Scan text for word-boundary occurrences of a symbol.
   */
  private findInText(
    text: string,
    symbolName: string,
    uri: string,
    results: Location[],
    seen: Set<string>,
  ): void {
    const lines = text.split("\n");
    const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`\\b${escaped}\\b`, "g");

    let inBlockComment = false;

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      const line = lines[lineNum];

      // Track block comments
      if (inBlockComment) {
        if (line.includes("*/")) {
          inBlockComment = false;
          // Only check the part after */
          const afterComment = line.slice(line.indexOf("*/") + 2);
          this.matchInSegment(
            afterComment,
            line.indexOf("*/") + 2,
            symbolName,
            regex,
            lineNum,
            uri,
            results,
            seen,
          );
        }
        continue;
      }

      if (line.includes("/*") && !line.includes("*/")) {
        // Block comment starts — only scan before it
        const beforeComment = line.slice(0, line.indexOf("/*"));
        this.matchInSegment(beforeComment, 0, symbolName, regex, lineNum, uri, results, seen);
        inBlockComment = true;
        continue;
      }

      // Skip pure line comments
      const trimmed = line.trim();
      if (trimmed.startsWith("//")) continue;

      // For lines with inline comments, only scan the code portion
      const commentStart = findLineCommentStart(line);
      const codePortion = commentStart === -1 ? line : line.slice(0, commentStart);

      this.matchInSegment(codePortion, 0, symbolName, regex, lineNum, uri, results, seen);
    }
  }

  private matchInSegment(
    segment: string,
    colOffset: number,
    symbolName: string,
    regex: RegExp,
    lineNum: number,
    uri: string,
    results: Location[],
    seen: Set<string>,
  ): void {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(segment)) !== null) {
      const col = colOffset + match.index;

      // Skip if inside a string literal
      if (isInsideString(segment, match.index)) continue;

      const key = `${uri}:${lineNum}:${col}`;
      if (seen.has(key)) continue;
      seen.add(key);

      results.push(
        Location.create(uri, {
          start: { line: lineNum, character: col },
          end: { line: lineNum, character: col + symbolName.length },
        }),
      );
    }
  }
}
