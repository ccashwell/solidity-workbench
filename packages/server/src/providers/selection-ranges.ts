import type { Position, Range, SelectionRange } from "vscode-languageserver/node.js";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type {
  ContractDefinition,
  ErrorDefinition,
  EventDefinition,
  FunctionDefinition,
  ModifierDefinition,
  SourceRange,
  SoliditySourceUnit,
  StateVariableDeclaration,
  StructDefinition,
  EnumDefinition,
} from "@solidity-workbench/common";
import type { SolidityParser } from "../parser/solidity-parser.js";
import { getWordAtPosition } from "../utils/text.js";

/**
 * Smart selection expansion: identifier -> line -> declaration/member ->
 * contract -> document.
 */
export class SelectionRangesProvider {
  constructor(private parser: SolidityParser) {}

  provideSelectionRanges(document: TextDocument, positions: Position[]): SelectionRange[] {
    const result = this.parser.get(document.uri);
    if (!result) return positions.map(() => this.documentSelection(document));

    return positions.map((position) => this.selectionForPosition(document, result.sourceUnit, position));
  }

  private selectionForPosition(
    document: TextDocument,
    sourceUnit: SoliditySourceUnit,
    position: Position,
  ): SelectionRange {
    const ranges: Range[] = [];
    const word = getWordAtPosition(document.getText(), position);
    if (word) ranges.push(word.range);

    const line = this.lineRange(document, position.line);
    if (line) ranges.push(line);

    for (const range of this.containingDeclarationRanges(sourceUnit, position)) {
      ranges.push(range);
    }

    ranges.push(this.documentRange(document));
    return this.chain(ranges);
  }

  private containingDeclarationRanges(sourceUnit: SoliditySourceUnit, position: Position): Range[] {
    const ranges: Range[] = [];
    for (const contract of sourceUnit.contracts) {
      for (const child of this.contractChildren(contract)) {
        if (this.contains(child.range, position)) ranges.push(child.range);
      }
      if (this.contains(contract.range, position)) ranges.push(contract.range);
    }
    for (const fn of sourceUnit.freeFunctions) {
      if (this.contains(fn.range, position)) ranges.push(fn.range);
    }
    for (const err of sourceUnit.errors) {
      if (this.contains(err.range, position)) ranges.push(err.range);
    }
    for (const udvt of sourceUnit.userDefinedValueTypes) {
      if (this.contains(udvt.range, position)) ranges.push(udvt.range);
    }
    return ranges.sort((a, b) => this.size(a) - this.size(b));
  }

  private contractChildren(
    contract: ContractDefinition,
  ): Array<
    | FunctionDefinition
    | ModifierDefinition
    | EventDefinition
    | ErrorDefinition
    | StateVariableDeclaration
    | StructDefinition
    | EnumDefinition
  > {
    return [
      ...contract.stateVariables,
      ...contract.functions,
      ...contract.modifiers,
      ...contract.events,
      ...contract.errors,
      ...contract.structs,
      ...contract.enums,
    ];
  }

  private chain(ranges: Range[]): SelectionRange {
    const unique: Range[] = [];
    const seen = new Set<string>();
    for (const range of ranges) {
      const key = `${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(range);
    }

    let parent: SelectionRange | undefined;
    for (let i = unique.length - 1; i >= 0; i--) {
      parent = { range: unique[i], parent };
    }
    return parent ?? { range: ranges[0] };
  }

  private lineRange(document: TextDocument, line: number): Range | null {
    const text = document.getText();
    const lines = text.split("\n");
    const current = lines[line];
    if (current === undefined) return null;
    const start = current.search(/\S/);
    if (start === -1) {
      return {
        start: { line, character: 0 },
        end: { line, character: current.length },
      };
    }
    return {
      start: { line, character: start },
      end: { line, character: current.length },
    };
  }

  private documentSelection(document: TextDocument): SelectionRange {
    return { range: this.documentRange(document) };
  }

  private documentRange(document: TextDocument): Range {
    const text = document.getText();
    return {
      start: { line: 0, character: 0 },
      end: document.positionAt(text.length),
    };
  }

  private contains(range: SourceRange, position: Position): boolean {
    if (position.line < range.start.line || position.line > range.end.line) return false;
    if (position.line === range.start.line && position.character < range.start.character) {
      return false;
    }
    if (position.line === range.end.line && position.character > range.end.character) {
      return false;
    }
    return true;
  }

  private size(range: Range): number {
    return (range.end.line - range.start.line) * 10000 + range.end.character - range.start.character;
  }
}
