import type { DocumentSymbol } from "vscode-languageserver/node.js";
import { SymbolKind } from "vscode-languageserver/node.js";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type { SolidityParser } from "../parser/solidity-parser.js";
import type { ContractDefinition, FunctionDefinition } from "@solidity-workbench/common";

/**
 * Provides the document symbol outline (breadcrumbs, outline panel).
 *
 * Produces a hierarchical symbol tree:
 * - Contract / Interface / Library
 *   - Functions
 *   - Modifiers
 *   - Events
 *   - Errors
 *   - Structs
 *   - Enums
 *   - State Variables
 */
export class DocumentSymbolProvider {
  constructor(private parser: SolidityParser) {}

  provideDocumentSymbols(document: TextDocument): DocumentSymbol[] {
    const result = this.parser.get(document.uri);
    if (!result) return [];

    const symbols: DocumentSymbol[] = [];

    // Pragmas (flat, not nested)
    for (const pragma of result.sourceUnit.pragmas) {
      symbols.push({
        name: `pragma ${pragma.name} ${pragma.value}`,
        kind: SymbolKind.Namespace,
        range: pragma.range,
        selectionRange: pragma.range,
      });
    }

    // Contracts (with nested children)
    for (const contract of result.sourceUnit.contracts) {
      symbols.push(this.buildContractSymbol(contract));
    }

    return symbols;
  }

  private buildContractSymbol(contract: ContractDefinition): DocumentSymbol {
    const children: DocumentSymbol[] = [];

    // Functions
    for (const func of contract.functions) {
      const name = func.name ?? func.kind; // constructor, receive, fallback
      const detail = this.buildFunctionDetail(func);
      children.push({
        name,
        detail,
        kind: func.kind === "constructor" ? SymbolKind.Constructor : SymbolKind.Function,
        range: func.range,
        selectionRange: func.nameRange,
        tags: func.isVirtual ? [] : undefined,
      });
    }

    // Modifiers
    for (const mod of contract.modifiers) {
      children.push({
        name: mod.name,
        kind: SymbolKind.Method,
        range: mod.range,
        selectionRange: mod.nameRange,
      });
    }

    // Events
    for (const event of contract.events) {
      children.push({
        name: event.name,
        kind: SymbolKind.Event,
        range: event.range,
        selectionRange: event.nameRange,
      });
    }

    // Errors
    for (const error of contract.errors) {
      children.push({
        name: error.name,
        detail: "error",
        kind: SymbolKind.Struct,
        range: error.range,
        selectionRange: error.nameRange,
      });
    }

    // Structs
    for (const struct of contract.structs) {
      children.push({
        name: struct.name,
        kind: SymbolKind.Struct,
        range: struct.range,
        selectionRange: struct.nameRange,
      });
    }

    // Enums
    for (const enumDef of contract.enums) {
      children.push({
        name: enumDef.name,
        detail: `{ ${enumDef.members.join(", ")} }`,
        kind: SymbolKind.Enum,
        range: enumDef.range,
        selectionRange: enumDef.nameRange,
      });
    }

    // State variables
    for (const svar of contract.stateVariables) {
      children.push({
        name: svar.name,
        detail: svar.typeName,
        kind: svar.mutability === "constant" ? SymbolKind.Constant : SymbolKind.Field,
        range: svar.range,
        selectionRange: svar.nameRange,
      });
    }

    const kind =
      contract.kind === "interface"
        ? SymbolKind.Interface
        : contract.kind === "library"
          ? SymbolKind.Module
          : SymbolKind.Class;

    return {
      name: contract.name,
      detail: contract.kind,
      kind,
      range: contract.range,
      selectionRange: contract.nameRange,
      children,
    };
  }

  private buildFunctionDetail(func: FunctionDefinition): string {
    const parts: string[] = [];

    if (func.visibility !== "public") parts.push(func.visibility);
    if (func.mutability !== "nonpayable") parts.push(func.mutability);
    if (func.isVirtual) parts.push("virtual");
    if (func.isOverride) parts.push("override");

    const params = func.parameters.map((p) => p.typeName).join(", ");

    return `(${params})${parts.length > 0 ? " " + parts.join(" ") : ""}`;
  }
}
