import type {
  ContractDefinition,
  FunctionDefinition,
  SolSymbol,
  SoliditySourceUnit,
  UsingForDirective,
} from "@solidity-workbench/common";
import type { SymbolIndex } from "../analyzer/symbol-index.js";
import type { ResolvedContract, SemanticResolver } from "../analyzer/semantic-resolver.js";
import type { SolidityParser } from "../parser/solidity-parser.js";
import { isSameTypeName } from "./receiver-type.js";

/** Directives in scope at `line` inside `uri` (contract-local + file-global). */
export function collectUsingForDirectives(
  sourceUnit: SoliditySourceUnit,
  contract: ContractDefinition | undefined,
): UsingForDirective[] {
  const directives: UsingForDirective[] = [];
  for (const directive of sourceUnit.usingFor) {
    directives.push(directive);
  }
  if (contract) {
    directives.push(...contract.usingFor);
  }
  return directives;
}

export function collectUsingForDirectivesInScope(
  parser: SolidityParser,
  uri: string,
  sourceUnit: SoliditySourceUnit,
  contract: ContractDefinition | undefined,
  resolver?: SemanticResolver,
): UsingForDirective[] {
  const directives = collectUsingForDirectives(sourceUnit, contract);
  if (!resolver) return directives;

  for (const reachableUri of resolver.collectReachableUris(uri)) {
    if (reachableUri === uri) continue;
    const reachableSourceUnit = parser.get(reachableUri)?.sourceUnit;
    if (!reachableSourceUnit) continue;
    directives.push(...reachableSourceUnit.usingFor.filter((directive) => directive.isGlobal));
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

  for (const directive of collectUsingForDirectivesInScope(
    parser,
    uri,
    sourceUnit,
    contract,
    resolver,
  )) {
    if (directive.typeName !== undefined && !isSameTypeName(directive.typeName, receiverType)) {
      continue;
    }

    if (directive.libraryName) {
      const libraryEntry = resolveUsingForLibrary(
        symbolIndex,
        uri,
        directive.libraryName,
        resolver,
      );
      const library = libraryEntry?.contract;
      const fn = selectUsingForFunction(library?.functions ?? [], memberName, argumentCount);
      if (!library || !fn || fn.parameters.length === 0) continue;
      if (!isSameTypeName(fn.parameters[0].typeName, receiverType)) continue;
      return { fn, filePath: libraryEntry.uri, containerName: library.name };
    }

    const functionName = directiveFunctionName(directive, memberName);
    if (!functionName) {
      continue;
    }

    const hit = selectVisibleFreeFunction(
      parser,
      symbolIndex,
      uri,
      functionName,
      argumentCount,
      resolver,
    );
    const fn = hit?.fn;
    if (!fn || fn.parameters.length === 0) continue;
    if (!isSameTypeName(fn.parameters[0].typeName, receiverType)) continue;
    return { fn, filePath: hit.filePath };
  }

  return null;
}

function resolveUsingForLibrary(
  symbolIndex: SymbolIndex,
  uri: string,
  libraryName: string,
  resolver?: SemanticResolver,
): { uri: string; contract: ContractDefinition } | ResolvedContract | undefined {
  if (!resolver) return symbolIndex.getContract(libraryName);

  const imported = resolver.resolveImportedSymbol(libraryName, uri);
  if (imported) return resolver.resolveContract(libraryName, uri);

  const visible = resolver.filterVisibleSymbols(
    uri,
    symbolIndex.findSymbols(libraryName).filter((symbol) => symbol.kind === "library"),
  );
  const sym = visible.find((candidate) => candidate.filePath === uri) ?? visible[0];
  return sym ? resolver.resolveContract(sym.name, sym.filePath) : undefined;
}

function selectVisibleFreeFunction(
  parser: SolidityParser,
  symbolIndex: SymbolIndex,
  uri: string,
  functionName: string,
  argumentCount: number | undefined,
  resolver?: SemanticResolver,
): { fn: FunctionDefinition; filePath: string } | undefined {
  const imported = resolver?.resolveImportedSymbol(functionName, uri);
  if (imported) {
    const sourceUnit = parser.get(imported.uri)?.sourceUnit;
    const importedMatch = selectUsingForFunction(
      sourceUnit?.freeFunctions ?? [],
      imported.name,
      argumentCount,
    );
    if (importedMatch) return { fn: importedMatch, filePath: imported.uri };
  }

  const unqualifiedName = functionName.includes(".")
    ? (functionName.split(".").at(-1) ?? functionName)
    : functionName;
  if (functionName === unqualifiedName) {
    const local = parser.get(uri)?.sourceUnit.freeFunctions ?? [];
    const localMatch = selectUsingForFunction(local, unqualifiedName, argumentCount);
    if (localMatch) return { fn: localMatch, filePath: uri };
  }

  const symbols = symbolIndex
    .findSymbols(unqualifiedName)
    .filter((symbol) => symbol.kind === "function" && !symbol.containerName);
  const visible = resolver ? resolver.filterVisibleSymbols(uri, symbols) : symbols;
  for (const symbol of visible) {
    const sourceUnit = parser.get(symbol.filePath)?.sourceUnit;
    if (!sourceUnit) continue;
    const fn = selectUsingForFunction(sourceUnit.freeFunctions, unqualifiedName, argumentCount);
    if (fn) return { fn, filePath: symbol.filePath };
  }
  return undefined;
}

function directiveFunctionName(
  directive: UsingForDirective,
  memberName: string,
): string | undefined {
  const alias = directive.functionAliases?.find((entry) => entry.memberName === memberName);
  if (alias) return alias.functionName;
  if (directive.functionNames && !directive.functionNames.includes(memberName)) return undefined;
  return memberName;
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
