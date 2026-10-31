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
 *
 * Incomplete code (error-recovery AST nodes) often carries empty names.
 * Those must not be returned — vscode-languageclient throws
 * `Error: name must not be falsy` when converting them.
 */
export class DocumentSymbolProvider {
  constructor(private parser: SolidityParser) {}

  provideDocumentSymbols(document: TextDocument): DocumentSymbol[] {
    const result = this.parser.get(document.uri);
    if (!result) return [];

    const symbols: DocumentSymbol[] = [];

    // Pragmas (flat, not nested)
    for (const pragma of result.sourceUnit.pragmas) {
      const name = `pragma ${pragma.name} ${pragma.value}`.trim();
      // Skip degenerate recovery nodes like a bare `pragma` with no name/value.
      if (!pragma.name && !pragma.value) continue;
      this.pushNamed(symbols, {
        name,
        kind: SymbolKind.Namespace,
        range: pragma.range,
        selectionRange: pragma.range,
      });
    }

    // Contracts (with nested children). Nameless recovery nodes promote
    // any named children so the outline still shows partial members.
    for (const contract of result.sourceUnit.contracts) {
      const built = this.buildContractSymbol(contract);
      if (built) symbols.push(built);
      else symbols.push(...this.collectContractChildren(contract));
    }

    for (const struct of result.sourceUnit.structs) {
      this.pushNamed(symbols, {
        name: struct.name,
        kind: SymbolKind.Struct,
        range: struct.range,
        selectionRange: struct.nameRange,
      });
    }

    for (const enumDef of result.sourceUnit.enums) {
      this.pushNamed(symbols, {
        name: enumDef.name,
        detail: `{ ${enumDef.members.map((m) => m.name).join(", ")} }`,
        kind: SymbolKind.Enum,
        range: enumDef.range,
        selectionRange: enumDef.nameRange,
      });
    }

    for (const fn of result.sourceUnit.freeFunctions) {
      if (!fn.name) continue;
      this.pushNamed(symbols, {
        name: fn.name,
        detail: this.buildFunctionDetail(fn),
        kind: SymbolKind.Function,
        range: fn.range,
        selectionRange: fn.nameRange,
      });
    }

    for (const event of result.sourceUnit.events) {
      this.pushNamed(symbols, {
        name: event.name,
        detail: "event",
        kind: SymbolKind.Event,
        range: event.range,
        selectionRange: event.nameRange,
      });
    }

    for (const err of result.sourceUnit.errors) {
      this.pushNamed(symbols, {
        name: err.name,
        detail: "error",
        kind: SymbolKind.Struct,
        range: err.range,
        selectionRange: err.nameRange,
      });
    }

    for (const udvt of result.sourceUnit.userDefinedValueTypes) {
      this.pushNamed(symbols, {
        name: udvt.name,
        detail: udvt.underlyingType,
        kind: SymbolKind.TypeParameter,
        range: udvt.range,
        selectionRange: udvt.nameRange,
      });
    }

    for (const constant of result.sourceUnit.fileConstants) {
      this.pushNamed(symbols, {
        name: constant.name,
        detail: constant.typeName,
        kind: SymbolKind.Constant,
        range: constant.range,
        selectionRange: constant.nameRange,
      });
    }

    return symbols;
  }

  /**
   * Build a contract symbol, or `null` when the contract itself has no
   * usable name (incomplete `contract` / `interface` / `library` keyword).
   */
  private buildContractSymbol(contract: ContractDefinition): DocumentSymbol | null {
    if (!contract.name) return null;

    const children = this.collectContractChildren(contract);

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

  private collectContractChildren(contract: ContractDefinition): DocumentSymbol[] {
    const children: DocumentSymbol[] = [];

    // Functions
    for (const func of contract.functions) {
      // Prefer the declared name; fall back to kind for constructor/receive/fallback.
      // Note: `??` (not `||`) would keep an empty-string recovery name — use truthiness.
      const name = func.name || func.kind;
      if (!name) continue;
      const detail = this.buildFunctionDetail(func);
      this.pushNamed(children, {
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
      this.pushNamed(children, {
        name: mod.name,
        kind: SymbolKind.Method,
        range: mod.range,
        selectionRange: mod.nameRange,
      });
    }

    // Events
    for (const event of contract.events) {
      this.pushNamed(children, {
        name: event.name,
        kind: SymbolKind.Event,
        range: event.range,
        selectionRange: event.nameRange,
      });
    }

    // Errors
    for (const error of contract.errors) {
      this.pushNamed(children, {
        name: error.name,
        detail: "error",
        kind: SymbolKind.Struct,
        range: error.range,
        selectionRange: error.nameRange,
      });
    }

    // Structs
    for (const struct of contract.structs) {
      this.pushNamed(children, {
        name: struct.name,
        kind: SymbolKind.Struct,
        range: struct.range,
        selectionRange: struct.nameRange,
      });
    }

    // Enums
    for (const enumDef of contract.enums) {
      this.pushNamed(children, {
        name: enumDef.name,
        detail: `{ ${enumDef.members.map((m) => m.name).join(", ")} }`,
        kind: SymbolKind.Enum,
        range: enumDef.range,
        selectionRange: enumDef.nameRange,
      });
    }

    // State variables
    for (const svar of contract.stateVariables) {
      this.pushNamed(children, {
        name: svar.name,
        detail: svar.typeName,
        kind: svar.mutability === "constant" ? SymbolKind.Constant : SymbolKind.Field,
        range: svar.range,
        selectionRange: svar.nameRange,
      });
    }

    return children;
  }

  private pushNamed(target: DocumentSymbol[], symbol: DocumentSymbol): void {
    if (!symbol.name) return;
    target.push(symbol);
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
