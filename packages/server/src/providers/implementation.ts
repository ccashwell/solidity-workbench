import type { Definition, Location, Position } from "vscode-languageserver/node.js";
import { Location as LspLocation } from "vscode-languageserver/node.js";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type {
  ContractDefinition,
  FunctionDefinition,
  ParameterDeclaration,
  SolSymbol,
} from "@solidity-workbench/common";
import type { ResolvedContract, SemanticResolver } from "../analyzer/semantic-resolver.js";
import type { SymbolIndex } from "../analyzer/symbol-index.js";
import { getWordAtPosition } from "../utils/text.js";

/**
 * Go-to-implementation for interfaces, abstract contracts, and virtual
 * methods. This is parser/index-backed and intentionally conservative:
 * it matches by inheritance plus function name/arity so it does not jump
 * to unrelated same-named functions.
 */
export class ImplementationProvider {
  constructor(
    private symbolIndex: SymbolIndex,
    private resolver?: SemanticResolver,
  ) {}

  provideImplementation(document: TextDocument, position: Position): Definition | null {
    const text = document.getText();
    const wordAtPosition = getWordAtPosition(text, position);
    const word = wordAtPosition?.text ?? null;
    if (!word || !wordAtPosition) return null;
    const includeNamespaceImports = this.isQualifiedIdentifier(text, wordAtPosition.range);

    const locations: Location[] = [];

    const importedContract = this.resolveImportedContract(word, document.uri);
    if (importedContract) {
      locations.push(...this.contractImplementationsForResolved(importedContract));
    }

    const symbols = this.selectSymbols(word, document.uri, position, includeNamespaceImports);

    for (const sym of symbols) {
      if (sym.kind === "contract" || sym.kind === "interface") {
        const resolved = this.resolver?.resolveContract(sym.name, sym.filePath);
        if (resolved) {
          locations.push(...this.contractImplementationsForResolved(resolved));
        } else {
          const entry = this.symbolIndex.getContract(sym.name, sym.filePath);
          if (entry) {
            locations.push(...this.contractImplementations(entry));
          }
        }
      }

      if (sym.kind === "function" && sym.containerName) {
        const resolved = this.resolver?.resolveContract(sym.containerName, sym.filePath);
        const sourceFn = resolved?.contract.functions.find(
          (fn) => fn.name === sym.name && this.sameRange(fn.nameRange, sym.nameRange),
        );
        if (resolved && sourceFn) {
          locations.push(...this.functionImplementationsForResolved(resolved, sourceFn));
        } else {
          const container = this.symbolIndex.getContract(sym.containerName, sym.filePath);
          const fallbackFn = container?.contract.functions.find(
            (fn) => fn.name === sym.name && this.sameRange(fn.nameRange, sym.nameRange),
          );
          if (container && fallbackFn) {
            locations.push(...this.functionImplementations(container, fallbackFn));
          }
        }
      }
    }

    const deduped = this.dedupe(locations);
    if (deduped.length === 0) return null;
    return deduped;
  }

  private resolveImportedContract(word: string, documentUri: string): ResolvedContract | null {
    if (!this.resolver?.resolveImportedSymbol(word, documentUri)) return null;
    return this.resolver.resolveContract(word, documentUri) ?? null;
  }

  private selectSymbols(
    word: string,
    documentUri: string,
    position: Position,
    includeNamespaceImports: boolean,
  ): SolSymbol[] {
    let symbols = this.symbolIndex.findSymbols(word);
    const underCursor = symbols.filter(
      (sym) => sym.filePath === documentUri && this.rangeContains(sym.nameRange, position),
    );
    if (underCursor.length > 0) return underCursor;

    if (this.resolver) {
      symbols = this.resolver.filterVisibleSymbols(documentUri, symbols, {
        includeNamespaceImports,
      });
    }
    return symbols;
  }

  private contractImplementationsForResolved(target: ResolvedContract): Location[] {
    const out: Location[] = [];
    for (const entry of this.getAllSemanticSubtypes(target)) {
      if (entry.contract.kind === "interface") continue;
      out.push(LspLocation.create(entry.uri, entry.contract.nameRange));
    }
    return out;
  }

  private contractImplementations(target: {
    uri: string;
    contract: ContractDefinition;
  }): Location[] {
    const out: Location[] = [];
    for (const entry of this.symbolIndex.getAllContractEntries()) {
      if (entry.uri === target.uri && entry.contract.name === target.contract.name) continue;
      if (!this.inheritsFrom(entry, target)) continue;
      if (entry.contract.kind === "interface") continue;
      out.push(LspLocation.create(entry.uri, entry.contract.nameRange));
    }
    return out;
  }

  private functionImplementations(
    baseContract: { uri: string; contract: ContractDefinition },
    sourceFn: FunctionDefinition,
  ): Location[] {
    const out: Location[] = [];
    for (const entry of this.symbolIndex.getAllContractEntries()) {
      if (entry.uri === baseContract.uri && entry.contract.name === baseContract.contract.name) {
        continue;
      }
      if (!this.inheritsFrom(entry, baseContract)) continue;
      if (entry.contract.kind === "interface") continue;

      for (const candidate of entry.contract.functions) {
        if (!candidate.name || candidate.name !== sourceFn.name) continue;
        if (!this.sameParameters(candidate.parameters, sourceFn.parameters)) continue;
        out.push(LspLocation.create(entry.uri, candidate.nameRange));
      }
    }
    return out;
  }

  private functionImplementationsForResolved(
    baseContract: ResolvedContract,
    sourceFn: FunctionDefinition,
  ): Location[] {
    const out: Location[] = [];
    for (const entry of this.getAllSemanticSubtypes(baseContract)) {
      if (entry.contract.kind === "interface") continue;

      for (const candidate of entry.contract.functions) {
        if (!candidate.name || candidate.name !== sourceFn.name) continue;
        if (!this.sameParameters(candidate.parameters, sourceFn.parameters)) continue;
        out.push(LspLocation.create(entry.uri, candidate.nameRange));
      }
    }
    return out;
  }

  private getAllSemanticSubtypes(target: ResolvedContract): ResolvedContract[] {
    if (!this.resolver) return [];

    const out: ResolvedContract[] = [];
    const visited = new Set<string>();
    const walk = (entry: ResolvedContract): void => {
      for (const subtype of this.resolver?.getSubtypes(entry) ?? []) {
        if (visited.has(subtype.id)) continue;
        visited.add(subtype.id);
        out.push(subtype);
        walk(subtype);
      }
    };
    walk(target);
    return out;
  }

  private inheritsFrom(
    candidate: { uri: string; contract: ContractDefinition },
    target: { uri: string; contract: ContractDefinition },
  ): boolean {
    const visited = new Set<string>();
    const walk = (entry: { uri: string; contract: ContractDefinition }): boolean => {
      const key = `${entry.uri}#${entry.contract.name}`;
      if (visited.has(key)) return false;
      visited.add(key);

      for (const base of entry.contract.baseContracts) {
        const baseEntry = this.symbolIndex.getVisibleContract(base.baseName, entry.uri);
        if (!baseEntry) continue;
        if (baseEntry.uri === target.uri && baseEntry.contract.name === target.contract.name) {
          return true;
        }
        if (walk(baseEntry)) return true;
      }
      return false;
    };

    return walk(candidate);
  }

  private sameParameters(a: ParameterDeclaration[], b: ParameterDeclaration[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((param, i) => param.typeName === b[i].typeName);
  }

  private sameRange(
    a: FunctionDefinition["nameRange"],
    b: FunctionDefinition["nameRange"],
  ): boolean {
    return (
      a.start.line === b.start.line &&
      a.start.character === b.start.character &&
      a.end.line === b.end.line &&
      a.end.character === b.end.character
    );
  }

  private rangeContains(range: FunctionDefinition["nameRange"], position: Position): boolean {
    if (position.line < range.start.line || position.line > range.end.line) return false;
    if (position.line === range.start.line && position.character < range.start.character) {
      return false;
    }
    if (position.line === range.end.line && position.character > range.end.character) {
      return false;
    }
    return true;
  }

  private isQualifiedIdentifier(text: string, range: FunctionDefinition["nameRange"]): boolean {
    const line = text.split("\n")[range.start.line] ?? "";
    return range.start.character > 0 && line[range.start.character - 1] === ".";
  }

  private dedupe(locations: Location[]): Location[] {
    const seen = new Set<string>();
    const out: Location[] = [];
    for (const loc of locations) {
      const key = `${loc.uri}:${loc.range.start.line}:${loc.range.start.character}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(loc);
    }
    return out;
  }
}
