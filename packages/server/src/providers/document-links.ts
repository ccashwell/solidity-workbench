import type { DocumentLink, Range } from "vscode-languageserver/node.js";
import type { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import type { SolSymbol } from "@solidity-workbench/common";
import type { SemanticResolver } from "../analyzer/semantic-resolver.js";
import type { SymbolIndex } from "../analyzer/symbol-index.js";
import type { SolidityParser } from "../parser/solidity-parser.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";
import {
  isNatspecReferenceTarget,
  rangeSize,
  resolveNatspecReference,
  symbolTargetUri,
} from "../utils/natspec-references.js";

/**
 * Turns Solidity import paths into clickable document links.
 */
export class DocumentLinksProvider {
  constructor(
    private parser: SolidityParser,
    private workspace: WorkspaceManager,
    private symbolIndex?: SymbolIndex,
    private resolver?: SemanticResolver,
  ) {}

  provideDocumentLinks(document: TextDocument): DocumentLink[] {
    const result = this.parser.get(document.uri);
    if (!result) return [];

    const lines = document.getText().split("\n");
    const fromPath = this.workspace.uriToPath(document.uri);
    const links: DocumentLink[] = [];

    for (const imp of result.sourceUnit.imports) {
      const target = this.workspace.resolveImport(imp.path, fromPath);
      if (!target) continue;

      const range = this.importPathRange(lines, imp.path, imp.range.start.line);
      if (!range) continue;

      links.push({
        range,
        target: URI.file(target).toString(),
        tooltip: `Open ${imp.path}`,
      });
    }

    links.push(...this.natspecReferenceLinks(document, lines));

    return links;
  }

  private importPathRange(lines: string[], importPath: string, startLine: number): Range | null {
    for (let line = startLine; line < Math.min(lines.length, startLine + 4); line++) {
      const col = lines[line].indexOf(importPath);
      if (col === -1) continue;
      return {
        start: { line, character: col },
        end: { line, character: col + importPath.length },
      };
    }
    return null;
  }

  private natspecReferenceLinks(document: TextDocument, lines: string[]): DocumentLink[] {
    if (!this.symbolIndex) return [];

    const links: DocumentLink[] = [];
    for (const comment of this.natspecCommentRanges(lines)) {
      const fromSymbol = this.findDocumentedSymbol(document.uri, comment.endLine);
      for (let line = comment.startLine; line <= comment.endLine; line++) {
        const text = lines[line] ?? "";
        for (const match of text.matchAll(/\{([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\}/g)) {
          const ref = match[1];
          const start = match.index ?? 0;
          const target = resolveNatspecReference(
            ref,
            document.uri,
            this.symbolIndex,
            this.resolver,
            fromSymbol,
          );
          if (!target) continue;

          links.push({
            range: {
              start: { line, character: start },
              end: { line, character: start + match[0].length },
            },
            target: symbolTargetUri(target),
            tooltip: `Open ${target.containerName ? `${target.containerName}.` : ""}${target.name}`,
          });
        }
      }
    }
    return links;
  }

  private natspecCommentRanges(lines: string[]): Array<{ startLine: number; endLine: number }> {
    const ranges: Array<{ startLine: number; endLine: number }> = [];
    for (let line = 0; line < lines.length; line++) {
      const text = lines[line];
      const trimmed = text.trimStart();
      if (trimmed.startsWith("///")) {
        const startLine = line;
        while (line + 1 < lines.length && lines[line + 1].trimStart().startsWith("///")) line++;
        ranges.push({ startLine, endLine: line });
        continue;
      }

      const blockStart = text.indexOf("/**");
      if (blockStart === -1) continue;
      const startLine = line;
      while (line < lines.length && !lines[line].includes("*/")) line++;
      ranges.push({ startLine, endLine: line });
    }
    return ranges;
  }

  private findDocumentedSymbol(uri: string, commentEndLine: number): SolSymbol | undefined {
    if (!this.symbolIndex) return undefined;
    return this.symbolIndex
      .getFileSymbols(uri)
      .filter(isNatspecReferenceTarget)
      .filter((symbol) => symbol.range.start.line > commentEndLine)
      .sort(
        (a, b) =>
          a.range.start.line - b.range.start.line ||
          a.range.start.character - b.range.start.character ||
          rangeSize(a.range) - rangeSize(b.range),
      )[0];
  }
}
