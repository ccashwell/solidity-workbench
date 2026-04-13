import * as parser from "@solidity-parser/parser";
import type { ASTNode } from "@solidity-parser/parser/src/ast-types";
import { getWordTextAtPosition } from "../utils/text.js";
import type {
  SoliditySourceUnit,
  ContractDefinition,
  FunctionDefinition,
  StateVariableDeclaration,
  EventDefinition,
  ErrorDefinition,
  StructDefinition,
  EnumDefinition,
  ModifierDefinition,
  ImportDirective,
  PragmaDirective,
  SourceRange,
  Visibility,
  Mutability,
  ContractKind,
  ParameterDeclaration,
} from "@solforge/common";

/**
 * Production Solidity parser wrapping @solidity-parser/parser (ANTLR4-based).
 *
 * Handles all Solidity syntax correctly including:
 * - Multiline contract declarations
 * - Nested mappings
 * - Complex function signatures with tuple returns
 * - Constructor initializer lists
 * - Free functions, custom errors, user-defined value types
 * - Error recovery for incomplete/broken code
 */
export class SolidityParser {
  private cache: Map<string, ParseResult> = new Map();

  /**
   * Parse a Solidity source file and cache the result.
   */
  parse(uri: string, text: string): ParseResult {
    try {
      const ast = parser.parse(text, {
        tolerant: true,
        loc: true,
        range: true,
      });

      const errors: ParseError[] = [];
      if ("errors" in ast && Array.isArray((ast as any).errors)) {
        for (const err of (ast as any).errors) {
          errors.push({
            message: err.message ?? String(err),
            range: this.locToRange(err.loc),
          });
        }
      }

      const sourceUnit = this.mapSourceUnit(uri, ast);
      const result: ParseResult = { sourceUnit, errors };
      this.cache.set(uri, result);
      return result;
    } catch (err: unknown) {
      const parseErr = err as {
        message?: string;
        loc?: { start: { line: number; column: number }; end: { line: number; column: number } };
      };
      const errorResult: ParseResult = {
        sourceUnit: this.emptySourceUnit(uri),
        errors: [
          {
            message: parseErr.message ?? `Parse error: ${err}`,
            range: parseErr.loc
              ? this.locToRange(parseErr.loc)
              : { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          },
        ],
      };
      this.cache.set(uri, errorResult);
      return errorResult;
    }
  }

  get(uri: string): ParseResult | undefined {
    return this.cache.get(uri);
  }

  getWordAtPosition(text: string, line: number, character: number): string | null {
    return getWordTextAtPosition(text, line, character);
  }

  getLineText(text: string, line: number): string {
    const lines = text.split("\n");
    return line < lines.length ? lines[line] : "";
  }

  // ── AST Mapping ────────────────────────────────────────────────────

  private mapSourceUnit(uri: string, ast: any): SoliditySourceUnit {
    const pragmas: PragmaDirective[] = [];
    const imports: ImportDirective[] = [];
    const contracts: ContractDefinition[] = [];
    const freeFunctions: FunctionDefinition[] = [];
    const errors: ErrorDefinition[] = [];
    const userDefinedValueTypes: {
      type: "UserDefinedValueTypeDefinition";
      name: string;
      underlyingType: string;
      range: SourceRange;
      nameRange: SourceRange;
    }[] = [];

    for (const node of ast.children ?? []) {
      switch (node.type) {
        case "PragmaDirective":
          pragmas.push({
            type: "PragmaDirective",
            name: node.name,
            value: node.value,
            range: this.locToRange(node.loc),
          });
          break;

        case "ImportDirective":
          imports.push(this.mapImport(node));
          break;

        case "ContractDefinition":
          contracts.push(this.mapContract(node));
          break;

        case "FunctionDefinition":
          freeFunctions.push(this.mapFunction(node));
          break;

        case "CustomErrorType":
        case "CustomErrorDefinition":
          errors.push(this.mapError(node));
          break;

        case "TypeDefinition":
          userDefinedValueTypes.push({
            type: "UserDefinedValueTypeDefinition",
            name: node.name,
            underlyingType: this.typeNameToString(node.definition),
            range: this.locToRange(node.loc),
            nameRange: this.nameRange(node),
          });
          break;
      }
    }

    return {
      filePath: uri,
      pragmas,
      imports,
      contracts,
      freeFunctions,
      errors,
      userDefinedValueTypes,
    };
  }

  private mapImport(node: any): ImportDirective {
    const imp: ImportDirective = {
      type: "ImportDirective",
      path: node.path,
      range: this.locToRange(node.loc),
    };

    if (node.unitAlias) {
      imp.unitAlias = node.unitAlias;
    }
    if (node.symbolAliases) {
      imp.symbolAliases = node.symbolAliases.map((a: [string, string | null]) => ({
        symbol: a[0],
        alias: a[1] ?? undefined,
      }));
    }
    if (node.symbolAliasesIdentifiers) {
      imp.symbolAliases = node.symbolAliasesIdentifiers.map((a: any) => ({
        symbol: a.id ?? a[0],
        alias: a.alias ?? a[1] ?? undefined,
      }));
    }

    return imp;
  }

  private mapContract(node: any): ContractDefinition {
    const kind: ContractKind = node.kind === "abstract" ? "abstract" : (node.kind ?? "contract");

    const functions: FunctionDefinition[] = [];
    const stateVariables: StateVariableDeclaration[] = [];
    const events: EventDefinition[] = [];
    const contractErrors: ErrorDefinition[] = [];
    const structs: StructDefinition[] = [];
    const enums: EnumDefinition[] = [];
    const modifiers: ModifierDefinition[] = [];
    const usingFor: { type: "UsingForDirective"; libraryName: string; typeName?: string }[] = [];

    for (const sub of node.subNodes ?? []) {
      switch (sub.type) {
        case "FunctionDefinition":
          functions.push(this.mapFunction(sub));
          break;
        case "StateVariableDeclaration":
          stateVariables.push(...this.mapStateVars(sub));
          break;
        case "EventDefinition":
          events.push(this.mapEvent(sub));
          break;
        case "CustomErrorType":
        case "CustomErrorDefinition":
          contractErrors.push(this.mapError(sub));
          break;
        case "StructDefinition":
          structs.push(this.mapStruct(sub));
          break;
        case "EnumDefinition":
          enums.push(this.mapEnum(sub));
          break;
        case "ModifierDefinition":
          modifiers.push(this.mapModifier(sub));
          break;
        case "UsingForDeclaration":
          usingFor.push({
            type: "UsingForDirective",
            libraryName: sub.libraryName ?? (sub.functions ? "<operators>" : ""),
            typeName: sub.typeName ? this.typeNameToString(sub.typeName) : undefined,
          });
          break;
      }
    }

    const baseContracts = (node.baseContracts ?? []).map((b: any) => ({
      baseName: b.baseName?.namePath ?? b.baseName ?? String(b),
    }));

    return {
      type: "ContractDefinition",
      name: node.name,
      kind,
      baseContracts,
      stateVariables,
      functions,
      modifiers,
      events,
      errors: contractErrors,
      structs,
      enums,
      usingFor,
      range: this.locToRange(node.loc),
      nameRange: this.nameRange(node),
    };
  }

  private mapFunction(node: any): FunctionDefinition {
    const isReceive = !!node.isReceiveEther;
    const isFallback = !!node.isFallback;
    const isConstructor = !isReceive && !isFallback && (!!node.isConstructor || node.name === null);

    let funcKind: "function" | "constructor" | "receive" | "fallback" = "function";
    if (isReceive) funcKind = "receive";
    else if (isFallback) funcKind = "fallback";
    else if (isConstructor) funcKind = "constructor";

    const visibility: Visibility = node.visibility ?? "public";
    let mutability: Mutability = "nonpayable";
    if (node.stateMutability === "pure") mutability = "pure";
    else if (node.stateMutability === "view") mutability = "view";
    else if (node.stateMutability === "payable") mutability = "payable";

    const parameters = (node.parameters ?? []).map((p: any) => this.mapParameter(p));
    const returnParameters = (node.returnParameters ?? []).map((p: any) => this.mapParameter(p));
    const modifierNames = (node.modifiers ?? []).map((m: any) => m.name ?? "");

    return {
      type: "FunctionDefinition",
      name: funcKind === "function" ? (node.name ?? null) : null,
      kind: funcKind,
      visibility,
      mutability,
      parameters,
      returnParameters,
      modifiers: modifierNames,
      isVirtual: node.isVirtual ?? false,
      isOverride: node.override !== null && node.override !== undefined,
      body: node.body !== null && node.body !== undefined,
      range: this.locToRange(node.loc),
      nameRange: this.nameRange(node),
    };
  }

  private mapStateVars(node: any): StateVariableDeclaration[] {
    const vars: StateVariableDeclaration[] = [];

    // StateVariableDeclaration can declare multiple variables in some AST shapes,
    // but typically it's one variable per node.
    const typeName = this.typeNameToString(node.typeName ?? node.variables?.[0]?.typeName);
    const variables = node.variables ?? [node];

    for (const v of variables) {
      let visibility: Visibility = "internal";
      if (v.visibility) visibility = v.visibility;

      let mutabilityAttr: "constant" | "immutable" | undefined;
      if (v.isDeclaredConst || v.isImmutable) {
        mutabilityAttr = v.isImmutable ? "immutable" : "constant";
      }

      vars.push({
        type: "StateVariableDeclaration",
        typeName: v.typeName ? this.typeNameToString(v.typeName) : typeName,
        name: v.name ?? v.identifier?.name ?? "",
        visibility,
        mutability: mutabilityAttr,
        range: this.locToRange(v.loc ?? node.loc),
        nameRange: this.nameRange(v.loc ? v : node),
      });
    }

    return vars;
  }

  private mapEvent(node: any): EventDefinition {
    return {
      type: "EventDefinition",
      name: node.name,
      parameters: (node.parameters ?? []).map((p: any) => this.mapParameter(p)),
      isAnonymous: node.isAnonymous ?? false,
      range: this.locToRange(node.loc),
      nameRange: this.nameRange(node),
    };
  }

  private mapError(node: any): ErrorDefinition {
    return {
      type: "ErrorDefinition",
      name: node.name,
      parameters: (node.parameters ?? []).map((p: any) => this.mapParameter(p)),
      range: this.locToRange(node.loc),
      nameRange: this.nameRange(node),
    };
  }

  private mapStruct(node: any): StructDefinition {
    return {
      type: "StructDefinition",
      name: node.name,
      members: (node.members ?? []).map((m: any) => this.mapParameter(m)),
      range: this.locToRange(node.loc),
      nameRange: this.nameRange(node),
    };
  }

  private mapEnum(node: any): EnumDefinition {
    return {
      type: "EnumDefinition",
      name: node.name,
      members: (node.members ?? []).map((m: any) => m.name ?? m),
      range: this.locToRange(node.loc),
      nameRange: this.nameRange(node),
    };
  }

  private mapModifier(node: any): ModifierDefinition {
    return {
      type: "ModifierDefinition",
      name: node.name,
      parameters: (node.parameters ?? []).map((p: any) => this.mapParameter(p)),
      isVirtual: node.isVirtual ?? false,
      isOverride: !!node.override,
      range: this.locToRange(node.loc),
      nameRange: this.nameRange(node),
    };
  }

  private mapParameter(node: any): ParameterDeclaration {
    return {
      type: "ParameterDeclaration",
      typeName: this.typeNameToString(node.typeName),
      name: node.name ?? node.identifier?.name ?? undefined,
      storageLocation: node.storageLocation ?? undefined,
      indexed: node.isIndexed ?? undefined,
    };
  }

  // ── Type name serialization ────────────────────────────────────────

  private typeNameToString(node: any): string {
    if (!node) return "unknown";
    if (typeof node === "string") return node;

    switch (node.type) {
      case "ElementaryTypeName":
        return (node.name ?? node.stateMutability)
          ? `${node.name}${node.stateMutability === "payable" ? " payable" : ""}`
          : (node.name ?? "unknown");

      case "UserDefinedTypeName":
        return node.namePath ?? node.name ?? "unknown";

      case "Mapping":
        return `mapping(${this.typeNameToString(node.keyType)} => ${this.typeNameToString(node.valueType)})`;

      case "ArrayTypeName":
        return node.length
          ? `${this.typeNameToString(node.baseTypeName)}[${node.length.number ?? node.length}]`
          : `${this.typeNameToString(node.baseTypeName)}[]`;

      case "FunctionTypeName": {
        const params = (node.parameterTypes ?? [])
          .map((p: any) => this.typeNameToString(p.typeName))
          .join(", ");
        const ret = (node.returnTypes ?? [])
          .map((p: any) => this.typeNameToString(p.typeName))
          .join(", ");
        return ret ? `function(${params}) returns (${ret})` : `function(${params})`;
      }

      default:
        return node.name ?? node.namePath ?? "unknown";
    }
  }

  // ── Location helpers ───────────────────────────────────────────────

  private locToRange(loc: any): SourceRange {
    if (!loc) {
      return { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
    }
    return {
      start: { line: (loc.start?.line ?? 1) - 1, character: loc.start?.column ?? 0 },
      end: { line: (loc.end?.line ?? 1) - 1, character: loc.end?.column ?? 0 },
    };
  }

  private nameRange(node: any): SourceRange {
    // Try to compute a name-specific range from the node's location
    if (node.loc && node.name) {
      const startLine = (node.loc.start?.line ?? 1) - 1;
      const startCol = node.loc.start?.column ?? 0;
      // Heuristic: the name often starts near the beginning of the node
      return {
        start: { line: startLine, character: startCol },
        end: { line: startLine, character: startCol + (node.name?.length ?? 0) },
      };
    }
    return this.locToRange(node.loc);
  }

  private emptySourceUnit(uri: string): SoliditySourceUnit {
    return {
      filePath: uri,
      pragmas: [],
      imports: [],
      contracts: [],
      freeFunctions: [],
      errors: [],
      userDefinedValueTypes: [],
    };
  }
}

// ── Types ────────────────────────────────────────────────────────────

export interface ParseResult {
  sourceUnit: SoliditySourceUnit;
  errors: ParseError[];
}

export interface ParseError {
  message: string;
  range: SourceRange;
}
