import type {
  ContractDefinition,
  FunctionDefinition,
  SolSymbol,
  SoliditySourceUnit,
  UsingForDirective,
} from "@solidity-workbench/common";
import type { SymbolIndex } from "../analyzer/symbol-index.js";
import type { SemanticResolver } from "../analyzer/semantic-resolver.js";
import type { SolidityParser } from "../parser/solidity-parser.js";
import { isSameTypeName } from "./receiver-type.js";

/** Directives in scope at `line` inside `uri` (contract-local + file-global). */
export function collectUsingForDirectives(
  sourceUnit: SoliditySourceUnit,
  contract: ContractDefinition | undefined,
): UsingForDirective[] {
  const directives: UsingForDirective[] = [];
  for (const directive of sourceUnit.usingFor) {
    if (directive.isGlobal) directives.push(directive);
  }
  if (contract) {
    directives.push(...contract.usingFor);
  }
  return directives;
}

/**
 * Resolve `receiver.member()` when `member` is bound via `using ... for`
 * (library extension or global free-function attachment).
 */
export function findUsingForFunction(
  parser: SolidityParser,
  symbolIndex: SymbolIndex,
  uri: string,
  contract: ContractDefinition | undefined,
  receiverType: string,
  memberName: string,
  argumentCount?: number,
  resolver?: SemanticResolver,
): { fn: FunctionDefinition; filePath: string; containerName?: string } | null {
  const sourceUnit = parser.get(uri)?.sourceUnit;
  if (!sourceUnit) return null;

  for (const directive of collectUsingForDirectives(sourceUnit, contract)) {
    if (directive.typeName !== undefined && !isSameTypeName(directive.typeName, receiverType)) {
      continue;
    }

    if (directive.libraryName) {
      const libraryEntry =
        resolver?.resolveContract(directive.libraryName, uri) ??
        symbolIndex.getContract(directive.libraryName);
      const library = libraryEntry?.contract;
      const fn = selectUsingForFunction(library?.functions ?? [], memberName, argumentCount);
      if (!library || !fn || fn.parameters.length === 0) continue;
      if (!isSameTypeName(fn.parameters[0].typeName, receiverType)) continue;
      return { fn, filePath: libraryEntry.uri, containerName: library.name };
    }

    if (directive.functionNames && !directive.functionNames.includes(memberName)) {
      continue;
    }

    const fn = selectUsingForFunction(sourceUnit.freeFunctions, memberName, argumentCount);
    if (!fn || fn.parameters.length === 0) continue;
    if (!isSameTypeName(fn.parameters[0].typeName, receiverType)) continue;
    return { fn, filePath: uri };
  }

  return null;
}

function selectUsingForFunction(
  functions: FunctionDefinition[],
  memberName: string,
  argumentCount: number | undefined,
): FunctionDefinition | undefined {
  const candidates = functions.filter((fn) => fn.name === memberName);
  if (argumentCount === undefined) return candidates[0];
  return candidates.find((fn) => fn.parameters.length === argumentCount + 1) ?? candidates[0];
}

export function usingForFunctionToSymbol(hit: {
  fn: FunctionDefinition;
  filePath: string;
  containerName?: string;
}): SolSymbol {
  const { fn, filePath, containerName } = hit;
  return {
    name: fn.name ?? memberFallback(fn),
    kind: "function",
    filePath,
    range: fn.range,
    nameRange: fn.nameRange,
    containerName,
    detail: formatFunctionSignature(fn),
    natspec: fn.natspec,
  };
}

export function usingForParameterNames(
  parser: SolidityParser,
  symbolIndex: SymbolIndex,
  uri: string,
  contract: ContractDefinition | undefined,
  receiverType: string,
  memberName: string,
  resolver?: SemanticResolver,
): string[] {
  const hit = findUsingForFunction(
    parser,
    symbolIndex,
    uri,
    contract,
    receiverType,
    memberName,
    undefined,
    resolver,
  );
  if (!hit) return [];
  return hit.fn.parameters
    .slice(1)
    .map((p) => p.name)
    .filter((n): n is string => !!n);
}

function memberFallback(fn: FunctionDefinition): string {
  return fn.kind;
}

function formatFunctionSignature(func: FunctionDefinition): string {
  const params = func.parameters
    .map((p) => `${p.typeName}${p.name ? " " + p.name : ""}`)
    .join(", ");
  const returns = func.returnParameters.map((p) => p.typeName).join(", ");
  const vis = func.visibility !== "public" ? ` ${func.visibility}` : "";
  const mut = func.mutability !== "nonpayable" ? ` ${func.mutability}` : "";
  const ret = returns ? ` returns (${returns})` : "";
  return `(${params})${vis}${mut}${ret}`;
}
