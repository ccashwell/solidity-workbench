import type { DocumentHighlight, Position } from "vscode-languageserver/node.js";
import { DocumentHighlightKind } from "vscode-languageserver/node.js";
import type { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import type { SymbolIndex } from "../analyzer/symbol-index.js";
import type { SolidityParser } from "../parser/solidity-parser.js";
import type { SolcBridge } from "../compiler/solc-bridge.js";
import {
  findLocalVariableType,
  getFunctionBodyTextPrefix,
  getWordAtPosition,
} from "../utils/text.js";
import { getEnclosingFunctionScope } from "../utils/scope.js";

/**
 * Document highlight provider — answers `textDocument/documentHighlight`.
 *
 * Without this provider VSCode falls back to a regex-based highlighter
 * that lights up every occurrence of the word at the cursor, including
 * inside `///` natspec comments and string literals — the "overlay on
 * comment text" symptom users report.
 *
 * We reuse the server's existing inverted `ReferenceIndex`, which is
 * built from source text with comment / string stripping baked in, and
 * filter to the current file. Results are returned with kind `Write`
 * for declarations and `Read` for everything else — VSCode applies
 * distinct subtle backgrounds for each, matching the UX of other
 * mature language servers.
 */
export class DocumentHighlightProvider {
  private solcBridge: SolcBridge | null = null;

  constructor(
    private symbolIndex: SymbolIndex,
    private parser: SolidityParser,
  ) {}

  setSolcBridge(bridge: SolcBridge): void {
    this.solcBridge = bridge;
  }

  provideDocumentHighlights(document: TextDocument, position: Position): DocumentHighlight[] {
    const text = document.getText();
    const wordAtPosition = getWordAtPosition(text, position);
    const word = wordAtPosition?.text;
    if (!wordAtPosition || !word) return [];

    const semantic = this.provideSemanticHighlights(document, position);
    if (semantic) return semantic;

    // Reference index covers cross-file occurrences too; for highlights
    // we only want the current file so the subtle background doesn't
    // wander away from the user's focus.
    const refs = this.symbolIndex.findReferences(word);
    const localRefs = refs.filter((r) => r.uri === document.uri);
    if (localRefs.length === 0) return [];
    const scopedRefs = this.scopeFallbackReferences(document, position, word, localRefs);

    // All occurrences come back as `Read`. LSP also has `Write` for
    // declaration / assignment sites, but accurately distinguishing
    // those would require byte-level assignment tracking that the
    // mapped AST's coarse `nameRange` heuristic doesn't provide.
    // Claiming Write unreliably is worse than claiming Read uniformly;
    // the subtle background VSCode applies for Read is identical to
    // the legacy fallback's, so the visual experience is consistent.
    return scopedRefs.map((ref) => ({
      range: ref.range,
      kind: DocumentHighlightKind.Read,
    }));
  }

  private scopeFallbackReferences<T extends { range: { start: Position; end: Position } }>(
    document: TextDocument,
    position: Position,
    word: string,
    refs: T[],
  ): T[] {
    const parsed = this.parser.get(document.uri)?.sourceUnit;
    if (!parsed) return refs;

    const scope = getEnclosingFunctionScope(parsed, position);
    if (!scope) return refs;

    const isParameter = scope.fn.parameters.some((param) => param.name === word);
    const isLocal = this.isLocalDeclaredAtOrBefore(
      document,
      scope.fn.range.start.line,
      position,
      word,
    );
    if (!isParameter && !isLocal) return refs;

    return refs.filter((ref) => this.rangeContains(scope.fn.range, ref.range.start));
  }

  private isLocalDeclaredAtOrBefore(
    document: TextDocument,
    functionStartLine: number,
    position: Position,
    word: string,
  ): boolean {
    const lines = document.getText().split("\n");
    const lineEnd = lines[position.line]?.length ?? position.character;
    const bodyPrefix = getFunctionBodyTextPrefix(
      document.getText(),
      functionStartLine,
      position.line,
      Math.max(position.character, lineEnd),
    );
    return bodyPrefix ? findLocalVariableType(bodyPrefix, word) !== undefined : false;
  }

  private rangeContains(range: { start: Position; end: Position }, position: Position): boolean {
    if (position.line < range.start.line || position.line > range.end.line) return false;
    if (position.line === range.start.line && position.character < range.start.character) {
      return false;
    }
    if (position.line === range.end.line && position.character > range.end.character) {
      return false;
    }
    return true;
  }

  private provideSemanticHighlights(
    document: TextDocument,
    position: Position,
  ): DocumentHighlight[] | null {
    if (!this.solcBridge) return null;
    const fsPath = URI.parse(document.uri).fsPath;
    const refs = this.solcBridge.findReferencesAt(fsPath, document.offsetAt(position));
    if (!refs) return null;

    const out: DocumentHighlight[] = [];
    const seen = new Set<string>();
    const push = (offset: number, length: number): void => {
      const range = {
        start: document.positionAt(offset),
        end: document.positionAt(offset + length),
      };
      const key = `${range.start.line}:${range.start.character}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ range, kind: DocumentHighlightKind.Read });
    };

    for (const ref of refs.references) {
      if (URI.file(ref.filePath).toString() !== document.uri) continue;
      push(ref.offset, ref.length);
    }

    if (refs.declaration && URI.file(refs.declaration.filePath).toString() === document.uri) {
      push(refs.declaration.offset, refs.declaration.length);
    }

    return out.length > 0 ? out : null;
  }
}
