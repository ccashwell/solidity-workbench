import type { TypeHierarchyItem, Position } from "vscode-languageserver/node.js";
import { SymbolKind } from "vscode-languageserver/node.js";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type { SymbolIndex } from "../analyzer/symbol-index.js";
import type { SolidityParser } from "../parser/solidity-parser.js";
import type { ResolvedContract, SemanticResolver } from "../analyzer/semantic-resolver.js";
import type { ContractDefinition } from "@solidity-workbench/common";
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

    const resolved = this.resolver?.resolveContract(word, document.uri);
    if (resolved) return [this.contractToItem(resolved.contract, resolved.uri, resolved.id)];

    const entry = this.symbolIndex.getContract(word);
    return entry ? [this.contractToItem(entry.contract, entry.uri)] : [];
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

    const entry = this.symbolIndex.getContract(item.name);
    if (!entry) return [];

    const supertypes: TypeHierarchyItem[] = [];

    for (const base of entry.contract.baseContracts) {
      const baseEntry = this.symbolIndex.getContract(base.baseName);
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

    for (const [, entry] of this.symbolIndex.getAllContracts()) {
      for (const base of entry.contract.baseContracts) {
        if (base.baseName === item.name) {
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
