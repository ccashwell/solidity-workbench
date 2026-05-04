import type { Definition, Location, Position } from "vscode-languageserver/node.js";
import { Location as LspLocation } from "vscode-languageserver/node.js";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type {
  ContractDefinition,
  FunctionDefinition,
  ParameterDeclaration,
} from "@solidity-workbench/common";
import type { SymbolIndex } from "../analyzer/symbol-index.js";
import { getWordAtPosition } from "../utils/text.js";

/**
 * Go-to-implementation for interfaces, abstract contracts, and virtual
 * methods. This is parser/index-backed and intentionally conservative:
 * it matches by inheritance plus function name/arity so it does not jump
 * to unrelated same-named functions.
 */
export class ImplementationProvider {
  constructor(private symbolIndex: SymbolIndex) {}

  provideImplementation(document: TextDocument, position: Position): Definition | null {
    const word = getWordAtPosition(document.getText(), position)?.text ?? null;
    if (!word) return null;

    const symbols = this.symbolIndex
      .findSymbols(word)
      .filter((sym) => sym.filePath === document.uri || sym.name === word);

    const locations: Location[] = [];

    for (const sym of symbols) {
      if (sym.kind === "contract" || sym.kind === "interface") {
        const entry = this.symbolIndex.getContract(sym.name);
        if (entry) {
          locations.push(...this.contractImplementations(entry.contract));
        }
      }

      if (sym.kind === "function" && sym.containerName) {
        const container = this.symbolIndex.getContract(sym.containerName);
        const sourceFn = container?.contract.functions.find(
          (fn) => fn.name === sym.name && this.sameRange(fn.nameRange, sym.nameRange),
        );
        if (container && sourceFn) {
          locations.push(...this.functionImplementations(container.contract.name, sourceFn));
        }
      }
    }

    const deduped = this.dedupe(locations);
    if (deduped.length === 0) return null;
    return deduped;
  }

  private contractImplementations(contract: ContractDefinition): Location[] {
    const out: Location[] = [];
    for (const [, entry] of this.symbolIndex.getAllContracts()) {
      if (entry.contract.name === contract.name) continue;
      if (!this.inheritsFrom(entry.contract.name, contract.name)) continue;
      if (entry.contract.kind === "interface") continue;
      out.push(LspLocation.create(entry.uri, entry.contract.nameRange));
    }
    return out;
  }

  private functionImplementations(baseContract: string, sourceFn: FunctionDefinition): Location[] {
    const out: Location[] = [];
    for (const [, entry] of this.symbolIndex.getAllContracts()) {
      if (entry.contract.name === baseContract) continue;
      if (!this.inheritsFrom(entry.contract.name, baseContract)) continue;
      if (entry.contract.kind === "interface") continue;

      for (const candidate of entry.contract.functions) {
        if (!candidate.name || candidate.name !== sourceFn.name) continue;
        if (!this.sameParameters(candidate.parameters, sourceFn.parameters)) continue;
        out.push(LspLocation.create(entry.uri, candidate.nameRange));
      }
    }
    return out;
  }

  private inheritsFrom(contractName: string, baseName: string): boolean {
    return this.symbolIndex
      .getInheritanceChain(contractName)
      .some((contract) => contract.name === baseName);
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
