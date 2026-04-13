/**
 * Solidity-specific AST and symbol types shared between the LSP server
 * and the extension client.
 */

// ── Solidity Source Unit ──────────────────────────────────────────────

export interface SoliditySourceUnit {
  filePath: string;
  pragmas: PragmaDirective[];
  imports: ImportDirective[];
  contracts: ContractDefinition[];
  /** Free functions (Solidity >=0.7.1) */
  freeFunctions: FunctionDefinition[];
  /** Custom errors at file level */
  errors: ErrorDefinition[];
  /** User-defined value types */
  userDefinedValueTypes: UserDefinedValueTypeDefinition[];
}

export interface PragmaDirective {
  type: "PragmaDirective";
  name: string; // "solidity", "abicoder", "experimental"
  value: string;
  range: SourceRange;
}

export interface ImportDirective {
  type: "ImportDirective";
  path: string;
  unitAlias?: string;
  symbolAliases?: { symbol: string; alias?: string }[];
  range: SourceRange;
}

// ── Contract / Interface / Library ────────────────────────────────────

export type ContractKind = "contract" | "interface" | "library" | "abstract";

export interface ContractDefinition {
  type: "ContractDefinition";
  name: string;
  kind: ContractKind;
  baseContracts: InheritanceSpecifier[];
  stateVariables: StateVariableDeclaration[];
  functions: FunctionDefinition[];
  modifiers: ModifierDefinition[];
  events: EventDefinition[];
  errors: ErrorDefinition[];
  structs: StructDefinition[];
  enums: EnumDefinition[];
  usingFor: UsingForDirective[];
  natspec?: NatspecComment;
  range: SourceRange;
  nameRange: SourceRange;
}

export interface InheritanceSpecifier {
  baseName: string;
  arguments?: string[];
}

// ── Functions & Modifiers ─────────────────────────────────────────────

export type Visibility = "public" | "private" | "internal" | "external";
export type Mutability = "pure" | "view" | "payable" | "nonpayable";

export interface FunctionDefinition {
  type: "FunctionDefinition";
  name: string | null; // null for constructor, receive, fallback
  kind: "function" | "constructor" | "receive" | "fallback";
  visibility: Visibility;
  mutability: Mutability;
  parameters: ParameterDeclaration[];
  returnParameters: ParameterDeclaration[];
  modifiers: string[];
  isVirtual: boolean;
  isOverride: boolean;
  body: boolean; // true if has implementation
  natspec?: NatspecComment;
  range: SourceRange;
  nameRange: SourceRange;
}

export interface ModifierDefinition {
  type: "ModifierDefinition";
  name: string;
  parameters: ParameterDeclaration[];
  isVirtual: boolean;
  isOverride: boolean;
  natspec?: NatspecComment;
  range: SourceRange;
  nameRange: SourceRange;
}

export interface ParameterDeclaration {
  type: "ParameterDeclaration";
  typeName: string;
  name?: string;
  storageLocation?: "memory" | "storage" | "calldata";
  indexed?: boolean;
}

// ── State Variables ───────────────────────────────────────────────────

export interface StateVariableDeclaration {
  type: "StateVariableDeclaration";
  typeName: string;
  name: string;
  visibility: Visibility;
  mutability?: "constant" | "immutable";
  natspec?: NatspecComment;
  range: SourceRange;
  nameRange: SourceRange;
}

// ── Events, Errors, Structs, Enums ────────────────────────────────────

export interface EventDefinition {
  type: "EventDefinition";
  name: string;
  parameters: ParameterDeclaration[];
  isAnonymous: boolean;
  natspec?: NatspecComment;
  range: SourceRange;
  nameRange: SourceRange;
}

export interface ErrorDefinition {
  type: "ErrorDefinition";
  name: string;
  parameters: ParameterDeclaration[];
  natspec?: NatspecComment;
  range: SourceRange;
  nameRange: SourceRange;
}

export interface StructDefinition {
  type: "StructDefinition";
  name: string;
  members: ParameterDeclaration[];
  natspec?: NatspecComment;
  range: SourceRange;
  nameRange: SourceRange;
}

export interface EnumDefinition {
  type: "EnumDefinition";
  name: string;
  members: string[];
  natspec?: NatspecComment;
  range: SourceRange;
  nameRange: SourceRange;
}

export interface UserDefinedValueTypeDefinition {
  type: "UserDefinedValueTypeDefinition";
  name: string;
  underlyingType: string;
  range: SourceRange;
  nameRange: SourceRange;
}

export interface UsingForDirective {
  type: "UsingForDirective";
  libraryName: string;
  typeName?: string; // undefined means "*"
}

// ── NatSpec ───────────────────────────────────────────────────────────

export interface NatspecComment {
  title?: string;
  author?: string;
  notice?: string;
  dev?: string;
  params?: Record<string, string>;
  returns?: Record<string, string>;
  custom?: Record<string, string>;
}

// ── Source Locations ──────────────────────────────────────────────────

export interface SourceRange {
  start: SourcePosition;
  end: SourcePosition;
}

export interface SourcePosition {
  line: number; // 0-based
  character: number; // 0-based
}

// ── Symbol Table ─────────────────────────────────────────────────────

export type SymbolKind =
  | "contract"
  | "interface"
  | "library"
  | "function"
  | "modifier"
  | "event"
  | "error"
  | "struct"
  | "enum"
  | "stateVariable"
  | "localVariable"
  | "parameter"
  | "userDefinedValueType";

export interface SolSymbol {
  name: string;
  kind: SymbolKind;
  filePath: string;
  range: SourceRange;
  nameRange: SourceRange;
  containerName?: string; // e.g. contract name for a function
  detail?: string; // e.g. type signature
  natspec?: NatspecComment;
}

// ── Foundry Test Results ─────────────────────────────────────────────

export interface ForgeTestResult {
  contract: string;
  test: string;
  status: "pass" | "fail" | "skip";
  reason?: string;
  gasUsed?: number;
  duration?: number; // milliseconds
  logs?: string[];
  traces?: string;
  counterexample?: string;
}

export interface ForgeTestSuite {
  file: string;
  contract: string;
  tests: ForgeTestResult[];
  totalPassed: number;
  totalFailed: number;
  totalSkipped: number;
}
