import type { TypeHierarchyItem, Position } from "vscode-languageserver/node.js";
import { SymbolKind } from "vscode-languageserver/node.js";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type { SymbolIndex } from "../analyzer/symbol-index.js";
import type { SolidityParser } from "../parser/solidity-parser.js";
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
  ) {}

  /**
   * Prepare: identify the contract/interface at the cursor.
   */
  prepareTypeHierarchy(document: TextDocument, position: Position): TypeHierarchyItem[] {
    const text = document.getText();
    const word = getWordAtPosition(text, position)?.text ?? null;
    if (!word) return [];

    const entry = this.symbolIndex.getContract(word);
    if (!entry) return [];

    return [this.contractToItem(entry.contract, entry.uri)];
  }

  /**
   * Supertypes — what does this contract inherit from?
   * Walks the `is` clause.
   */
  getSupertypes(item: TypeHierarchyItem): TypeHierarchyItem[] {
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
    const subtypes: TypeHierarchyItem[] = [];

    for (const [name, entry] of this.symbolIndex.getAllContracts()) {
      for (const base of entry.contract.baseContracts) {
        if (base.baseName === item.name) {
          subtypes.push(this.contractToItem(entry.contract, entry.uri));
          break;
        }
      }
    }

    return subtypes;
  }

  private contractToItem(contract: ContractDefinition, uri: string): TypeHierarchyItem {
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
    };
  }
}
