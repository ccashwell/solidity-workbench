import type { FoldingRange } from "vscode-languageserver/node.js";
import { FoldingRangeKind } from "vscode-languageserver/node.js";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type {
  ContractDefinition,
  ErrorDefinition,
  EventDefinition,
  FunctionDefinition,
  ModifierDefinition,
  SourceRange,
  StructDefinition,
  EnumDefinition,
} from "@solidity-workbench/common";
import type { SolidityParser } from "../parser/solidity-parser.js";

/**
 * Folding ranges for Solidity declarations, import groups, and comments.
 *
 * VSCode can infer some indentation folds on its own, but an AST-backed
 * provider gives stable ranges for one-line-indented code, nested contract
 * members, and contiguous import blocks.
 */
export class FoldingRangesProvider {
  constructor(private parser: SolidityParser) {}

  provideFoldingRanges(document: TextDocument): FoldingRange[] {
    const result = this.parser.get(document.uri);
    if (!result) return [];

    const ranges: FoldingRange[] = [];

    this.addImportFolds(
      result.sourceUnit.imports.map((imp) => imp.range),
      ranges,
    );

    for (const contract of result.sourceUnit.contracts) {
      this.pushRange(ranges, contract.range);
      for (const child of this.contractChildren(contract)) {
        this.pushRange(ranges, child.range);
      }
    }

    this.addCommentFolds(document.getText(), ranges);

    return this.dedupe(ranges).sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  }

  private contractChildren(
    contract: ContractDefinition,
  ): Array<
    | FunctionDefinition
    | ModifierDefinition
    | EventDefinition
    | ErrorDefinition
    | StructDefinition
    | EnumDefinition
  > {
    return [
      ...contract.functions,
      ...contract.modifiers,
      ...contract.events,
      ...contract.errors,
      ...contract.structs,
      ...contract.enums,
    ];
  }

  private pushRange(out: FoldingRange[], range: SourceRange, kind?: FoldingRangeKind): void {
    if (range.end.line <= range.start.line) return;
    out.push({
      startLine: range.start.line,
      startCharacter: range.start.character,
      endLine: range.end.line,
      endCharacter: range.end.character,
      kind,
    });
  }

  private addImportFolds(importRanges: SourceRange[], out: FoldingRange[]): void {
    if (importRanges.length < 2) return;

    const sorted = [...importRanges].sort((a, b) => a.start.line - b.start.line);
    let groupStart = sorted[0];
    let previous = sorted[0];

    for (const current of sorted.slice(1)) {
      if (current.start.line <= previous.end.line + 1) {
        previous = current;
        continue;
      }
      this.pushImportGroup(groupStart, previous, out);
      groupStart = current;
      previous = current;
    }
    this.pushImportGroup(groupStart, previous, out);
  }

  private pushImportGroup(start: SourceRange, end: SourceRange, out: FoldingRange[]): void {
    if (end.end.line <= start.start.line) return;
    out.push({
      startLine: start.start.line,
      startCharacter: start.start.character,
      endLine: end.end.line,
      endCharacter: end.end.character,
      kind: FoldingRangeKind.Imports,
    });
  }

  private addCommentFolds(text: string, out: FoldingRange[]): void {
    const lines = text.split("\n");
    let blockStart: { line: number; character: number } | null = null;

    for (let line = 0; line < lines.length; line++) {
      const current = lines[line];
      if (blockStart) {
        const end = current.indexOf("*/");
        if (end !== -1) {
          if (line > blockStart.line) {
            out.push({
              startLine: blockStart.line,
              startCharacter: blockStart.character,
              endLine: line,
              endCharacter: end + 2,
              kind: FoldingRangeKind.Comment,
            });
          }
          blockStart = null;
        }
        continue;
      }

      const start = current.indexOf("/*");
      if (start !== -1 && current.indexOf("*/", start + 2) === -1) {
        blockStart = { line, character: start };
      }
    }
  }

  private dedupe(ranges: FoldingRange[]): FoldingRange[] {
    const seen = new Set<string>();
    const out: FoldingRange[] = [];
    for (const range of ranges) {
      const key = `${range.startLine}:${range.startCharacter}:${range.endLine}:${range.endCharacter}:${range.kind ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(range);
    }
    return out;
  }
}
