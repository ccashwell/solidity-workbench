import type {
  CancellationToken,
  Position,
  ReferenceContext,
  TextDocuments,
} from "vscode-languageserver/node.js";
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
 * Fast path: delegates to `SymbolIndex.findReferences`, which reads from an
 * inverted identifier-occurrence index that's kept up to date as files are
 * parsed. That index already handles word boundaries, block comments, line
 * comments, and string literals, so a single map lookup returns all valid
 * occurrences across the workspace.
 *
 * Slow path (fallback): if the identifier hasn't been indexed yet — typically
 * for brand-new files that haven't been parsed or for identifiers the index
 * has never seen — we fall back to the legacy text-scan across open documents
 * and known workspace files. A `console.warn` is emitted in this case so it
 * shows up during development.
 *
 * Declarations are merged in or filtered out based on
 * `ReferenceContext.includeDeclaration`.
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
    token?: CancellationToken,
  ): Location[] {
    const text = document.getText();
    const word = getWordAtPosition(text, position)?.text ?? null;
    if (!word) return [];

    const seen = new Set<string>(); // Deduplicate by "uri:line:char"
    const results: Location[] = [];

    const pushUnique = (uri: string, range: Location["range"]): void => {
      const key = `${uri}:${range.start.line}:${range.start.character}`;
      if (seen.has(key)) return;
      seen.add(key);
      results.push(Location.create(uri, range));
    };

    // 1. Fast path: inverted index
    if (this.symbolIndex.hasReferences(word)) {
      for (const entry of this.symbolIndex.findReferences(word)) {
        if (token?.isCancellationRequested) return [];
        pushUnique(entry.uri, entry.range);
      }
    } else {
      // Unindexed identifier — fall back to a live text scan.  This happens
      // for files that haven't been parsed/indexed yet (e.g. a freshly
      // opened buffer before onDidChangeContent fires).
      console.warn(
        `[references] identifier "${word}" not in reference index; falling back to text scan`,
      );
      for (const doc of this.documents.all()) {
        if (token?.isCancellationRequested) return [];
        this.findInText(doc.getText(), word, doc.uri, results, seen);
      }
      for (const uri of this.workspace.getAllFileUris()) {
        if (token?.isCancellationRequested) return [];
        if (this.documents.get(uri)) continue;
        try {
          const filePath = this.workspace.uriToPath(uri);
          const fileText = fs.readFileSync(filePath, "utf-8");
          this.findInText(fileText, word, uri, results, seen);
        } catch {
          /* unreadable, skip */
        }
      }
    }

    if (token?.isCancellationRequested) return [];

    // 2. Handle the declaration flag.
    const declarations = this.symbolIndex.findSymbols(word);

    if (context.includeDeclaration) {
      // Merge in declarations (using nameRange). Dedup against what the
      // inverted index already returned — a declaration usually shows up
      // there too, but belt-and-suspenders.
      for (const sym of declarations) {
        pushUnique(sym.filePath, sym.nameRange);
      }
    } else {
      // Strip out declaration name ranges from the results.
      const declKeys = new Set<string>();
      for (const sym of declarations) {
        declKeys.add(
          `${sym.filePath}:${sym.nameRange.start.line}:${sym.nameRange.start.character}`,
        );
      }
      if (declKeys.size > 0) {
        return results.filter((loc) => {
          const key = `${loc.uri}:${loc.range.start.line}:${loc.range.start.character}`;
          return !declKeys.has(key);
        });
      }
    }

    return results;
  }

  /**
   * Text-scan fallback — only invoked when the inverted index has never seen
   * the identifier. Mirrors the pre-index behaviour: word-boundary matches
   * with block-comment, line-comment, and string-literal filtering.
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
