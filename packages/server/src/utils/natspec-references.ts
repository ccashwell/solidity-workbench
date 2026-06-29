import { URI } from "vscode-uri";
import type { SolSymbol, SourceRange } from "@solidity-workbench/common";
import type { SemanticResolver } from "../analyzer/semantic-resolver.js";
import type { SymbolIndex } from "../analyzer/symbol-index.js";

export function resolveNatspecReference(
  ref: string,
  documentUri: string,
  symbolIndex: SymbolIndex,
  resolver?: SemanticResolver,
  fromSymbol?: SolSymbol,
): SolSymbol | undefined {
  const parts = ref.split(".");
  const symbolName = parts[parts.length - 1];
  let implicitContainerName = fromSymbol?.containerName;
  if (
    fromSymbol?.kind === "contract" ||
    fromSymbol?.kind === "interface" ||
    fromSymbol?.kind === "library"
  ) {
    implicitContainerName = fromSymbol.name;
  }
  const containerName = parts.length > 1 ? parts.slice(0, -1).join(".") : implicitContainerName;

  const importedTopLevel =
    parts.length === 1 ? resolver?.resolveImportedSymbol(symbolName, documentUri) : undefined;
  let candidates = symbolIndex.findSymbols(importedTopLevel?.name ?? symbolName);
  if (importedTopLevel) {
    candidates = candidates.filter((candidate) => candidate.filePath === importedTopLevel.uri);
  }
  if (resolver) candidates = resolver.filterVisibleSymbols(documentUri, candidates);
  candidates = candidates.filter(isNatspecReferenceTarget);
  candidates = filterReferenceScope(candidates, documentUri, containerName, resolver, fromSymbol);
  if (candidates.length === 0) return undefined;

  if (containerName) {
    const sameContainer = candidates.find(
      (candidate) =>
        candidate.containerName === containerName &&
        (!fromSymbol || candidate.filePath === fromSymbol.filePath),
    );
    if (sameContainer) return sameContainer;

    const anyContainer = candidates.find((candidate) => candidate.containerName === containerName);
    if (anyContainer) return anyContainer;
  }

  return (
    candidates.find((candidate) => candidate.filePath === fromSymbol?.filePath) ??
    candidates.find((candidate) => candidate.filePath === documentUri) ??
    candidates[0]
  );
}

function filterReferenceScope(
  candidates: SolSymbol[],
  documentUri: string,
  containerName: string | undefined,
  resolver: SemanticResolver | undefined,
  fromSymbol: SolSymbol | undefined,
): SolSymbol[] {
  if (!resolver) return candidates;

  return candidates.filter((candidate) => {
    if (candidate.filePath === documentUri || candidate.filePath === fromSymbol?.filePath) {
      return true;
    }

    if (containerName) {
      if (!candidate.containerName) {
        const imported = resolver.resolveImportedSymbol(candidate.name, documentUri);
        return imported?.name === candidate.name && imported.uri === candidate.filePath;
      }

      const importedContainer = resolver.resolveImportedSymbol(containerName, documentUri);
      return (
        importedContainer !== undefined &&
        candidate.containerName === importedContainer.name &&
        candidate.filePath === importedContainer.uri
      );
    }

    if (candidate.containerName) return false;

    const imported = resolver.resolveImportedSymbol(candidate.name, documentUri);
    return imported?.name === candidate.name && imported.uri === candidate.filePath;
  });
}

export function isNatspecReferenceTarget(sym: SolSymbol): boolean {
  return (
    sym.kind === "contract" ||
    sym.kind === "interface" ||
    sym.kind === "library" ||
    sym.kind === "function" ||
    sym.kind === "modifier" ||
    sym.kind === "event" ||
    sym.kind === "error" ||
    sym.kind === "struct" ||
    sym.kind === "enum" ||
    sym.kind === "userDefinedValueType"
  );
}

export function symbolTargetUri(sym: SolSymbol): string {
  return `${symbolDocumentUri(sym)}#L${sym.nameRange.start.line + 1},${
    sym.nameRange.start.character + 1
  }`;
}

export function symbolDocumentUri(sym: SolSymbol): string {
  return sym.filePath.startsWith("file:") ? sym.filePath : URI.file(sym.filePath).toString();
}

export function rangeSize(range: SourceRange): number {
  return (
    (range.end.line - range.start.line) * 10_000 + (range.end.character - range.start.character)
  );
}
