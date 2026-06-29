import type { TypeHierarchyItem, Position } from "vscode-languageserver/node.js";
import { SymbolKind } from "vscode-languageserver/node.js";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type { SymbolIndex } from "../analyzer/symbol-index.js";
import type { SolidityParser } from "../parser/solidity-parser.js";
import type { ResolvedContract, SemanticResolver } from "../analyzer/semantic-resolver.js";
import type { ContractDefinition, SolSymbol } from "@solidity-workbench/common";
import { getWordAtPosition } from "../utils/text.js";

/**
 * Type Hierarchy provider — visualizes the inheritance tree.
 *
 * "Show Supertypes" → what contracts/interfaces does this inherit from?
 * "Show Subtypes" → what contracts inherit from this one?
 *
 * Essential for understanding complex protocol hierarchies like:
 * UniswapV4PoolManager → PoolManager → IPoolManager, Fees, NoDelegateCall, ...
 *
 * Works for contracts, interfaces, and libraries (using-for relationships).
 */
export class TypeHierarchyProvider {
  constructor(
    private symbolIndex: SymbolIndex,
    private parser: SolidityParser,
    private resolver?: SemanticResolver,
  ) {}

  /**
   * Prepare: identify the contract/interface at the cursor.
   */
  prepareTypeHierarchy(document: TextDocument, position: Position): TypeHierarchyItem[] {
    const text = document.getText();
    const word = getWordAtPosition(text, position)?.text ?? null;
    if (!word) return [];

    const symbols = this.symbolIndex.findSymbols(word).filter((sym) => this.isTypeSymbol(sym));
    const underCursor = symbols.find(
      (sym) => sym.filePath === document.uri && this.rangeContains(sym.nameRange, position),
    );
    if (underCursor) {
      const resolved = this.resolver?.resolveContract(underCursor.name, underCursor.filePath);
      if (resolved) return [this.contractToItem(resolved.contract, resolved.uri, resolved.id)];
      const entry = this.symbolIndex.getContract(underCursor.name, underCursor.filePath);
      return entry ? [this.contractToItem(entry.contract, entry.uri)] : [];
    }

    const imported = this.resolver?.resolveImportedSymbol(word, document.uri);
    if (imported) {
      const resolved = this.resolver?.resolveContract(word, document.uri);
      if (resolved) return [this.contractToItem(resolved.contract, resolved.uri, resolved.id)];
    }

    const visibleSymbols = this.resolver
      ? this.resolver.filterVisibleSymbols(document.uri, symbols)
      : symbols;
    if (visibleSymbols.length > 0) {
      const sym =
        visibleSymbols.find((candidate) => candidate.filePath === document.uri) ??
        visibleSymbols[0];
      const resolved = this.resolver?.resolveContract(sym.name, sym.filePath);
      if (resolved) return [this.contractToItem(resolved.contract, resolved.uri, resolved.id)];
      const entry = this.symbolIndex.getContract(sym.name, sym.filePath);
      return entry ? [this.contractToItem(entry.contract, entry.uri)] : [];
    }

    if (this.resolver) return [];

    const entry = this.symbolIndex.getContract(word);
    return entry ? [this.contractToItem(entry.contract, entry.uri)] : [];
  }

  private isTypeSymbol(sym: SolSymbol): boolean {
    return sym.kind === "contract" || sym.kind === "interface" || sym.kind === "library";
  }

  private rangeContains(range: ContractDefinition["nameRange"], position: Position): boolean {
    if (position.line < range.start.line || position.line > range.end.line) return false;
    if (position.line === range.start.line && position.character < range.start.character) {
      return false;
    }
    if (position.line === range.end.line && position.character > range.end.character) {
      return false;
    }
    return true;
  }

  /**
   * Supertypes — what does this contract inherit from?
   * Walks the `is` clause.
   */
  getSupertypes(item: TypeHierarchyItem): TypeHierarchyItem[] {
    const resolved = this.resolveItemContract(item);
    if (resolved && this.resolver) {
      const supertypes: TypeHierarchyItem[] = [];
      for (const base of resolved.contract.baseContracts) {
        const baseEntry = this.resolver.resolveBaseContract(resolved.uri, base.baseName);
        if (baseEntry) {
          supertypes.push(this.contractToItem(baseEntry.contract, baseEntry.uri, baseEntry.id));
        }
      }
      return supertypes;
    }

    const entry = this.symbolIndex.getContract(item.name, item.uri);
    if (!entry) return [];

    const supertypes: TypeHierarchyItem[] = [];

    for (const base of entry.contract.baseContracts) {
      const baseEntry = this.symbolIndex.getVisibleContract(base.baseName, entry.uri);
      if (baseEntry) {
        supertypes.push(this.contractToItem(baseEntry.contract, baseEntry.uri));
      }
    }

    return supertypes;
  }

  /**
   * Subtypes — what contracts inherit from this one?
   * Scans all contracts for `is ThisContract`.
   */
  getSubtypes(item: TypeHierarchyItem): TypeHierarchyItem[] {
    const resolved = this.resolveItemContract(item);
    if (resolved && this.resolver) {
      return this.resolver
        .getSubtypes(resolved)
        .map((entry) => this.contractToItem(entry.contract, entry.uri, entry.id));
    }

    const subtypes: TypeHierarchyItem[] = [];

    for (const entry of this.symbolIndex.getAllContractEntries()) {
      for (const base of entry.contract.baseContracts) {
        const baseEntry = this.symbolIndex.getVisibleContract(base.baseName, entry.uri);
        if (baseEntry?.contract.name === item.name && baseEntry.uri === item.uri) {
          subtypes.push(this.contractToItem(entry.contract, entry.uri));
          break;
        }
      }
    }

    return subtypes;
  }

  private resolveItemContract(item: TypeHierarchyItem): ResolvedContract | undefined {
    const id =
      typeof item.data === "object" && item.data && "id" in item.data ? item.data.id : null;
    if (typeof id === "string") {
      const byId = this.resolver?.resolveContractById(id);
      if (byId) return byId;
    }
    return this.resolver?.resolveContract(item.name, item.uri);
  }

  private contractToItem(
    contract: ContractDefinition,
    uri: string,
    id?: string,
  ): TypeHierarchyItem {
    const kind =
      contract.kind === "interface"
        ? SymbolKind.Interface
        : contract.kind === "library"
          ? SymbolKind.Module
          : SymbolKind.Class;

    const detail =
      contract.baseContracts.length > 0
        ? `is ${contract.baseContracts.map((b) => b.baseName).join(", ")}`
        : contract.kind;

    return {
      name: contract.name,
      kind,
      uri,
      range: contract.range,
      selectionRange: contract.nameRange,
      detail,
      data: id ? { id } : undefined,
    };
  }
}
