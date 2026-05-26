import type {
  ContractDefinition,
  FunctionDefinition,
  SoliditySourceUnit,
  SourcePosition,
  SourceRange,
} from "@solidity-workbench/common";

export interface EnclosingFunctionScope {
  fn: FunctionDefinition;
  contract?: ContractDefinition;
}

function rangeContains(range: SourceRange, position: SourcePosition): boolean {
  if (position.line < range.start.line || position.line > range.end.line) return false;
  if (position.line === range.start.line && position.character < range.start.character) {
    return false;
  }
  if (position.line === range.end.line && position.character > range.end.character) {
    return false;
  }
  return true;
}

function rangeSize(range: SourceRange): number {
  return range.end.line - range.start.line;
}

/**
 * Innermost function or modifier body containing `position`, searching
 * contract functions first, then file-level free functions.
 */
export function getEnclosingFunctionScope(
  sourceUnit: SoliditySourceUnit,
  position: SourcePosition,
): EnclosingFunctionScope | undefined {
  const candidates: EnclosingFunctionScope[] = [];

  for (const contract of sourceUnit.contracts) {
    for (const fn of contract.functions) {
      if (rangeContains(fn.range, position)) {
        candidates.push({ fn, contract });
      }
    }
  }

  for (const fn of sourceUnit.freeFunctions) {
    if (rangeContains(fn.range, position)) {
      candidates.push({ fn });
    }
  }

  return candidates.sort((a, b) => rangeSize(a.fn.range) - rangeSize(b.fn.range))[0];
}

export function getEnclosingContract(
  sourceUnit: SoliditySourceUnit,
  lineNum: number,
): ContractDefinition | undefined {
  return sourceUnit.contracts.find(
    (contract) => contract.range.start.line <= lineNum && lineNum <= contract.range.end.line,
  );
}
