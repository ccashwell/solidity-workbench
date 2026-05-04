import * as parser from "@solidity-parser/parser";
import type { ASTNode } from "@solidity-parser/parser/src/ast-types";
import { getWordTextAtPosition } from "../utils/text.js";
import type { ParserPool } from "./parser-pool.js";
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
  NatspecComment,
} from "@solidity-workbench/common";

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
   * Source lines for the file currently being parsed. Populated at the start
   * of `parse(uri, text)` and cleared in the finally block so the per-node
   * `mapX` methods can look up preceding NatSpec comments without threading
   * the lines array through every signature. A parser instance only handles
   * one `parse` call at a time, so holding this state on the instance is safe.
   */
  private currentLines: string[] | null = null;

  /**
   * Optional `worker_threads` pool for off-main-thread bulk parsing.
   * Wired in by `server.ts` once it has a worker bundle path; the pool
   * is used only by `parseAsync` (which falls back to the synchronous
   * `parse` if no pool is set, so unit tests that drive the parser
   * directly keep working).
   */
  private pool: ParserPool | null = null;

  /**
   * Wire a parser pool. `parseAsync` will route through the pool while
   * one is set; setting `null` (e.g. on shutdown) reverts to
   * main-thread parsing.
   */
  setPool(pool: ParserPool | null): void {
    this.pool = pool;
  }

  /**
   * Parse a Solidity source file and cache the result.
   *
   * We cache both the mapped `SoliditySourceUnit` (used by providers
   * that only need declaration-level information) AND the original
   * `@solidity-parser/parser` AST (used by the AST-based linter rules
   * that need statement-level walking). The raw AST is kept on the
   * cache so downstream consumers can call `parser.getRawAst(uri)`
   * without re-parsing.
   */
  parse(uri: string, text: string): ParseResult {
    this.currentLines = text.split("\n");
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
      const result: ParseResult = { sourceUnit, errors, text, rawAst: ast };
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
        text,
        rawAst: null,
      };
      this.cache.set(uri, errorResult);
      return errorResult;
    } finally {
      this.currentLines = null;
    }
  }

  /**
   * Async parse that off-loads to the worker pool when one is wired in.
   *
   * Bulk-indexing callers (`SymbolIndex.indexFile`) should prefer this
   * over `parse(uri, text)` so the LSP server can fan parses out
   * across worker threads rather than running them all on the main
   * thread between `setImmediate` yields.
   *
   * Workers return `sourceUnit + errors + text` and skip shipping the
   * raw AST across the thread boundary; the resulting cache entry has
   * `rawAst: null`. `getRawAst(uri)` re-parses lazily on the main
   * thread the first time anyone asks for it. If no pool is wired in,
   * or a pool dispatch throws, we fall back to the synchronous `parse`
   * so indexing always makes progress.
   */
  async parseAsync(uri: string, text: string): Promise<ParseResult> {
    if (this.pool) {
      try {
        const out = await this.pool.parse(uri, text);
        const result: ParseResult = {
          sourceUnit: out.sourceUnit,
          errors: out.errors as ParseError[],
          text: out.text,
          rawAst: null,
        };
        this.cache.set(uri, result);
        return result;
      } catch {
        // Worker error — fall through to a main-thread parse. Better
        // to lose the parallelism for one file than to lose its
        // symbols entirely.
      }
    }
    return this.parse(uri, text);
  }

  /**
   * Return the raw `@solidity-parser/parser` AST for a previously-parsed
   * file, or `null` if parsing failed.
   *
   * Files indexed via the worker pool live in the cache with
   * `rawAst: null` because the AST isn't shipped across the worker
   * boundary (see `parser-worker.ts` for the rationale). The first
   * caller to ask for the raw AST of a bulk-indexed file pays a
   * synchronous main-thread re-parse; subsequent calls hit the cache.
   *
   * In practice the only consumers are the linter and the semantic-
   * tokens provider, both of which run on user-opened files —
   * `documents.onDidChangeContent` already calls the synchronous
   * `parse(uri, text)` for those, so the lazy path is rarely hit.
   */
  getRawAst(uri: string): unknown | null {
    const cached = this.cache.get(uri);
    if (!cached) return null;
    if (cached.rawAst !== null && cached.rawAst !== undefined) return cached.rawAst;
    if (cached.text === null || cached.text === undefined) return null;
    this.parse(uri, cached.text);
    return this.cache.get(uri)?.rawAst ?? null;
  }

  get(uri: string): ParseResult | undefined {
    return this.cache.get(uri);
  }

  /**
   * Retrieve the raw source text that was passed to `parse(uri, text)` most
   * recently for the given URI. Returns undefined if the file hasn't been
   * parsed yet. Useful for downstream indexes that need the original text
   * without re-reading from disk.
   */
  getText(uri: string): string | undefined {
    return this.cache.get(uri)?.text;
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

    const natspec = this.extractNatspecBefore(this.currentLines, (node.loc?.start?.line ?? 1) - 1);

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
      natspec,
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

    const natspec = this.extractNatspecBefore(this.currentLines, (node.loc?.start?.line ?? 1) - 1);

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
      natspec,
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

      const declLine = (v.loc?.start?.line ?? node.loc?.start?.line ?? 1) - 1;
      const natspec = this.extractNatspecBefore(this.currentLines, declLine);

      vars.push({
        type: "StateVariableDeclaration",
        typeName: v.typeName ? this.typeNameToString(v.typeName) : typeName,
        name: v.name ?? v.identifier?.name ?? "",
        visibility,
        mutability: mutabilityAttr,
        natspec,
        range: this.locToRange(v.loc ?? node.loc),
        nameRange: this.nameRange(v.loc ? v : node),
      });
    }

    return vars;
  }

  private mapEvent(node: any): EventDefinition {
    const natspec = this.extractNatspecBefore(this.currentLines, (node.loc?.start?.line ?? 1) - 1);
    return {
      type: "EventDefinition",
      name: node.name,
      parameters: (node.parameters ?? []).map((p: any) => this.mapParameter(p)),
      isAnonymous: node.isAnonymous ?? false,
      natspec,
      range: this.locToRange(node.loc),
      nameRange: this.nameRange(node),
    };
  }

  private mapError(node: any): ErrorDefinition {
    const natspec = this.extractNatspecBefore(this.currentLines, (node.loc?.start?.line ?? 1) - 1);
    return {
      type: "ErrorDefinition",
      name: node.name,
      parameters: (node.parameters ?? []).map((p: any) => this.mapParameter(p)),
      natspec,
      range: this.locToRange(node.loc),
      nameRange: this.nameRange(node),
    };
  }

  private mapStruct(node: any): StructDefinition {
    const natspec = this.extractNatspecBefore(this.currentLines, (node.loc?.start?.line ?? 1) - 1);
    return {
      type: "StructDefinition",
      name: node.name,
      members: (node.members ?? []).map((m: any) => this.mapParameter(m)),
      natspec,
      range: this.locToRange(node.loc),
      nameRange: this.nameRange(node),
    };
  }

  private mapEnum(node: any): EnumDefinition {
    const natspec = this.extractNatspecBefore(this.currentLines, (node.loc?.start?.line ?? 1) - 1);
    return {
      type: "EnumDefinition",
      name: node.name,
      members: (node.members ?? []).map((m: any) => m.name ?? m),
      natspec,
      range: this.locToRange(node.loc),
      nameRange: this.nameRange(node),
    };
  }

  private mapModifier(node: any): ModifierDefinition {
    const natspec = this.extractNatspecBefore(this.currentLines, (node.loc?.start?.line ?? 1) - 1);
    return {
      type: "ModifierDefinition",
      name: node.name,
      parameters: (node.parameters ?? []).map((p: any) => this.mapParameter(p)),
      isVirtual: node.isVirtual ?? false,
      isOverride: !!node.override,
      natspec,
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
      const name = String(node.name);
      const startLine = (node.loc.start?.line ?? 1) - 1;
      const startCol = node.loc.start?.column ?? 0;
      const line = this.currentLines?.[startLine] ?? "";
      const actualStart = line.indexOf(name, startCol);
      if (actualStart >= 0) {
        return {
          start: { line: startLine, character: actualStart },
          end: { line: startLine, character: actualStart + name.length },
        };
      }
      return {
        start: { line: startLine, character: startCol },
        end: { line: startLine, character: startCol + name.length },
      };
    }
    return this.locToRange(node.loc);
  }

  // ── NatSpec extraction ─────────────────────────────────────────────

  /**
   * Extract the NatSpec docblock that immediately precedes a given line.
   * Walks backward from `lineIndex - 1` collecting:
   *   - A contiguous run of `/// ...` triple-slash lines
   *   - Or a single `/** ... *\/` block comment ending on the previous
   *     non-empty line (the block comment start `/**` must be on its own line
   *     — modulo leading whitespace — to count as NatSpec)
   *
   * Parses tags: @title, @author, @notice, @dev, @param <name> <desc>,
   *              @return [name] <desc>, @inheritdoc <name>, @custom:<tag> <value>.
   * Lines without tags append (with a single-space separator) to whichever
   * section was most recently started; before any tag the implicit section
   * is `@notice`.
   *
   * Returns `undefined` when no NatSpec is present or every parsed field
   * would be empty. `lineIndex` is the zero-based line of the declaration
   * itself; callers typically pass `node.loc.start.line - 1`.
   */
  private extractNatspecBefore(
    lines: string[] | null,
    lineIndex: number,
  ): NatspecComment | undefined {
    if (!lines || lineIndex <= 0 || lineIndex > lines.length) {
      return undefined;
    }

    // Skip blank lines between the declaration and the preceding comment.
    let i = lineIndex - 1;
    while (i >= 0 && lines[i].trim() === "") i--;
    if (i < 0) return undefined;

    const firstTrimmed = lines[i].trim();
    const rawLines: string[] = [];

    if (firstTrimmed.endsWith("*/")) {
      // Block comment form. Walk backward until we find a line whose trimmed
      // content starts with `/**` — that's the NatSpec opener. If we never
      // find it (e.g. this is a regular `/* ... */` comment), bail.
      let startIdx = i;
      while (startIdx >= 0 && !lines[startIdx].trim().startsWith("/**")) {
        startIdx--;
      }
      if (startIdx < 0) return undefined;
      for (let j = startIdx; j <= i; j++) {
        rawLines.push(stripBlockCommentMarkers(lines[j]));
      }
    } else if (firstTrimmed.startsWith("///")) {
      // Triple-slash form. Collect contiguous `///` lines walking backward.
      const collected: string[] = [];
      let j = i;
      while (j >= 0 && lines[j].trim().startsWith("///")) {
        collected.push(stripTripleSlashMarker(lines[j]));
        j--;
      }
      collected.reverse();
      rawLines.push(...collected);
    } else {
      return undefined;
    }

    return parseNatspecLines(rawLines);
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

// ── NatSpec parsing helpers ──────────────────────────────────────────

/**
 * Matches a NatSpec tag line. Captures:
 *   1. tag name (e.g. "notice", "param", "custom")
 *   2. optional sub-tag after `:` (e.g. "security" in `@custom:security`)
 *   3. optional remainder of the line after whitespace
 */
const TAG_REGEX = /^@(\w+)(?::(\w+))?(?:\s+(.*))?$/;

/** Matches a Solidity identifier (used to detect named `@return` values). */
const IDENTIFIER_REGEX = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

/**
 * Strip block-comment decoration from a single line:
 *   - trailing `*/ ` (with any preceding whitespace / extra stars)
 *   - leading `; /**` / `/*` opener (with optional single space after)
 *   - leading `*` found on interior lines (with optional single space after)
 */
function stripBlockCommentMarkers(line: string): string {
  let s = line;
  s = s.replace(/\s*\*+\/\s*$/, "");
  s = s.replace(/^\s*\/\*+\s?/, "");
  s = s.replace(/^\s*\*+\s?/, "");
  return s.trim();
}

/** Strip the leading `///` marker (and optional single space) from a line. */
function stripTripleSlashMarker(line: string): string {
  return line.replace(/^\s*\/\/\/\s?/, "").trim();
}

/** Which tag's value a subsequent untagged continuation line appends to. */
type NatspecSection =
  | { kind: "notice" }
  | { kind: "dev" }
  | { kind: "param"; name: string }
  | { kind: "return"; name: string }
  | { kind: "custom"; tag: string }
  | null;

/**
 * Parse an array of NatSpec lines (already stripped of comment markers) into
 * a `NatspecComment`. Returns undefined if no fields end up populated.
 */
function parseNatspecLines(rawLines: string[]): NatspecComment | undefined {
  const natspec: NatspecComment = {};
  // Before any tag, untagged lines fold into @notice per solc convention.
  let section: NatspecSection = { kind: "notice" };

  // Continuation lines join with a literal newline, not a space. Markdown
  // renders a single `\n` as a soft wrap and `\n\n` as a paragraph break,
  // so this preserves authored structure (headings, lists, multi-paragraph
  // long-form docs) end-to-end into the hover popover. The previous
  // single-space join collapsed every `///` line into one run-on
  // paragraph, which is what users were seeing on contracts with
  // structured natspec.
  const append = (text: string) => {
    if (!section) return;
    switch (section.kind) {
      case "notice":
        natspec.notice = natspec.notice !== undefined ? natspec.notice + "\n" + text : text;
        return;
      case "dev":
        natspec.dev = natspec.dev !== undefined ? natspec.dev + "\n" + text : text;
        return;
      case "param": {
        if (!natspec.params) natspec.params = {};
        const prev = natspec.params[section.name];
        natspec.params[section.name] = prev !== undefined ? prev + "\n" + text : text;
        return;
      }
      case "return": {
        if (!natspec.returns) natspec.returns = {};
        const prev = natspec.returns[section.name];
        natspec.returns[section.name] = prev !== undefined ? prev + "\n" + text : text;
        return;
      }
      case "custom": {
        if (!natspec.custom) natspec.custom = {};
        const prev = natspec.custom[section.tag];
        natspec.custom[section.tag] = prev !== undefined ? prev + "\n" + text : text;
        return;
      }
    }
  };

  for (const raw of rawLines) {
    const line = raw.trim();

    // Blank lines aren't skipped — they're appended as empty strings so the
    // running section content gets a `\n\n` paragraph break at exactly the
    // place the author put one. Without this, every blank `///` line
    // between paragraphs vanished and content fused into one block.
    if (!line) {
      append("");
      continue;
    }

    const match = line.match(TAG_REGEX);
    if (!match) {
      append(line);
      continue;
    }

    const tag = match[1];
    const sub = match[2];
    const rest = (match[3] ?? "").trim();

    switch (tag) {
      case "title":
        natspec.title = rest;
        section = null;
        break;
      case "author":
        natspec.author = rest;
        section = null;
        break;
      case "notice":
        natspec.notice = rest;
        section = { kind: "notice" };
        break;
      case "dev":
        natspec.dev = rest;
        section = { kind: "dev" };
        break;
      case "param": {
        const parts = rest.split(/\s+/).filter(Boolean);
        const name = parts[0] ?? "";
        const desc = parts.slice(1).join(" ");
        if (!natspec.params) natspec.params = {};
        natspec.params[name] = desc;
        section = { kind: "param", name };
        break;
      }
      case "return": {
        const parts = rest.split(/\s+/).filter(Boolean);
        if (!natspec.returns) natspec.returns = {};
        if (parts.length > 0 && IDENTIFIER_REGEX.test(parts[0])) {
          const name = parts[0];
          natspec.returns[name] = parts.slice(1).join(" ");
          section = { kind: "return", name };
        } else {
          natspec.returns[""] = rest;
          section = { kind: "return", name: "" };
        }
        break;
      }
      case "inheritdoc":
        if (!natspec.custom) natspec.custom = {};
        natspec.custom.inheritdoc = rest;
        section = null;
        break;
      case "custom":
        if (sub) {
          if (!natspec.custom) natspec.custom = {};
          natspec.custom[sub] = rest;
          section = { kind: "custom", tag: sub };
        }
        break;
      default:
        // Unknown tag: store under custom so we don't drop it silently.
        if (!natspec.custom) natspec.custom = {};
        natspec.custom[tag] = rest;
        section = { kind: "custom", tag };
        break;
    }
  }

  // `title` and `author` are inherently single-line fields — collapse
  // any incidental whitespace so they render cleanly. Everything else
  // may carry markdown structure (paragraphs, lists, headings) so we
  // tidy *intra-line* whitespace but preserve `\n` separators, and
  // trim leading/trailing blank lines from the edges.
  const collapseSingleLine = (s: string): string => s.replace(/\s+/g, " ").trim();
  const tidyMultiLine = (s: string): string =>
    s
      .split(/\r?\n/)
      .map((line) => line.replace(/[ \t]+/g, " ").replace(/^ | $/g, ""))
      .join("\n")
      .replace(/^\n+|\n+$/g, "");

  if (natspec.title !== undefined) natspec.title = collapseSingleLine(natspec.title);
  if (natspec.author !== undefined) natspec.author = collapseSingleLine(natspec.author);
  if (natspec.notice !== undefined) natspec.notice = tidyMultiLine(natspec.notice);
  if (natspec.dev !== undefined) natspec.dev = tidyMultiLine(natspec.dev);
  if (natspec.params) {
    for (const k of Object.keys(natspec.params)) {
      natspec.params[k] = tidyMultiLine(natspec.params[k]);
    }
  }
  if (natspec.returns) {
    for (const k of Object.keys(natspec.returns)) {
      natspec.returns[k] = tidyMultiLine(natspec.returns[k]);
    }
  }
  if (natspec.custom) {
    for (const k of Object.keys(natspec.custom)) {
      natspec.custom[k] = tidyMultiLine(natspec.custom[k]);
    }
  }

  const hasContent =
    natspec.title !== undefined ||
    natspec.author !== undefined ||
    natspec.notice !== undefined ||
    natspec.dev !== undefined ||
    (natspec.params !== undefined && Object.keys(natspec.params).length > 0) ||
    (natspec.returns !== undefined && Object.keys(natspec.returns).length > 0) ||
    (natspec.custom !== undefined && Object.keys(natspec.custom).length > 0);

  return hasContent ? natspec : undefined;
}

// ── Types ────────────────────────────────────────────────────────────

export interface ParseResult {
  sourceUnit: SoliditySourceUnit;
  errors: ParseError[];
  /** Raw source text that produced this parse result. */
  text?: string;
  /**
   * Raw `@solidity-parser/parser` AST (SourceUnit at the top). `null`
   * when parsing threw entirely. Typed as `unknown` here to avoid
   * coupling the whole server to the parser's node-type taxonomy;
   * consumers that actually walk the AST import the types locally.
   */
  rawAst?: unknown | null;
}

export interface ParseError {
  message: string;
  range: SourceRange;
}
