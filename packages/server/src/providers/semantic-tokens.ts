import type { CancellationToken, SemanticTokens, Range } from "vscode-languageserver/node.js";
import { SemanticTokensBuilder } from "vscode-languageserver/node.js";
import type { TextDocument } from "vscode-languageserver-textdocument";
import { SolSemanticTokenTypes, SolSemanticTokenModifiers } from "@solidity-workbench/common";
import type { SolidityParser, ParseResult } from "../parser/solidity-parser.js";

const tokenTypeMap = new Map(SolSemanticTokenTypes.map((t, i) => [t, i]));
const tokenModifierMap = new Map(SolSemanticTokenModifiers.map((m, i) => [m, i]));

/**
 * Provides semantic token highlighting for Solidity.
 *
 * This goes beyond TextMate grammars by using AST information to
 * color tokens by their semantic role:
 * - State variables vs. local variables vs. parameters
 * - Contract names in type position vs. declaration
 * - Modifiers vs. regular functions
 * - Constants/immutables with a distinct style
 * - Virtual/override/abstract function annotations
 *
 * Implementation notes:
 * - The LSP semantic tokens protocol requires tokens to be pushed in strict
 *   (line, char) order because the wire format uses relative deltas. We
 *   collect tokens into an array first and sort before pushing.
 * - Reference-site identifiers are discovered via a text-based scan of
 *   function bodies. This is not a full scope analysis: a parameter name
 *   declared in one function may colour identically-named identifiers in
 *   another function. We accept this cross-function collision as a known
 *   limitation — the win over TextMate-only highlighting is large.
 */
export class SemanticTokensProvider {
  constructor(private parser: SolidityParser) {}

  provideSemanticTokens(document: TextDocument, token?: CancellationToken): SemanticTokens {
    const tokens = this.collectTokens(document, token);
    if (token?.isCancellationRequested) return { data: [] };
    return this.buildFromTokens(tokens);
  }

  provideSemanticTokensRange(
    document: TextDocument,
    range: Range,
    token?: CancellationToken,
  ): SemanticTokens {
    const tokens = this.collectTokens(document, token).filter(
      (t) => t.line >= range.start.line && t.line <= range.end.line,
    );
    if (token?.isCancellationRequested) return { data: [] };
    return this.buildFromTokens(tokens);
  }

  // ── Token collection ────────────────────────────────────────────────

  private collectTokens(document: TextDocument, token?: CancellationToken): TokenInfo[] {
    const tokens: TokenInfo[] = [];
    const result = this.parser.get(document.uri);
    if (!result) return tokens;

    const text = document.getText();
    const lines = text.split("\n");

    this.collectDeclarationTokens(result, tokens);
    if (token?.isCancellationRequested) return tokens;

    const nameKinds = this.buildGlobalNameKinds(result);
    this.collectReferenceTokens(result, lines, nameKinds, tokens, token);

    return tokens;
  }

  /**
   * Walk the raw `@solidity-parser/parser` AST emitting declaration-site
   * tokens. Driving off the raw AST (rather than the mapped SourceUnit)
   * gives us exact `loc` info for every sub-node — including the
   * `.identifier.loc` of struct members, event/error/function parameters,
   * and state variable names, plus the `.typeName.loc` of every user-
   * defined type reference. This is what lets us colour
   *
   *   struct EscrowedPosition { PoolKey poolKey; MarketId marketId; }
   *
   * correctly: `PoolKey` / `MarketId` as type references and `poolKey` /
   * `marketId` as struct-member properties.
   */
  private collectDeclarationTokens(result: ParseResult, tokens: TokenInfo[]): void {
    const raw = result.rawAst as RawSourceUnit | null | undefined;
    if (!raw?.children) return;
    const lines = (result.text ?? "").split("\n");

    for (const node of raw.children) {
      switch (node?.type) {
        case "PragmaDirective":
          this.emitPragma(node, tokens);
          break;
        case "ImportDirective":
          this.emitImport(node, tokens);
          break;
        case "ContractDefinition":
          this.emitContract(node, lines, tokens);
          break;
        case "FunctionDefinition":
          this.emitFunction(node, lines, tokens);
          break;
        case "CustomErrorDefinition":
        case "CustomErrorType":
          this.emitError(node, lines, tokens);
          break;
        case "TypeDefinition":
          this.emitUdvt(node, lines, tokens);
          break;
      }
    }
  }

  private emitPragma(node: RawNode, tokens: TokenInfo[]): void {
    if (!node.loc) return;
    const line = node.loc.start.line - 1;
    tokens.push({ line, char: 0, length: 6, type: "keyword", modifiers: [] });
    if (typeof node.name === "string" && node.name.length > 0) {
      tokens.push({ line, char: 7, length: node.name.length, type: "namespace", modifiers: [] });
    }
  }

  private emitImport(node: RawNode, tokens: TokenInfo[]): void {
    if (!node.loc) return;
    tokens.push({
      line: node.loc.start.line - 1,
      char: node.loc.start.column,
      length: 6,
      type: "keyword",
      modifiers: [],
    });
  }

  private emitContract(node: RawNode, lines: string[], tokens: TokenInfo[]): void {
    if (node.name && node.loc) {
      const pos = findNameAfter(lines, node.loc.start.line - 1, node.loc.start.column, node.name);
      if (pos) {
        tokens.push({
          line: pos.line,
          char: pos.char,
          length: node.name.length,
          type: node.kind === "interface" ? "interface" : "class",
          modifiers: ["declaration", "definition"],
        });
      }
    }

    // `contract Foo is Bar, Baz` — tokenize each base name.
    for (const bc of node.baseContracts ?? []) {
      const baseName =
        bc.baseName?.namePath ??
        (typeof bc.baseName?.name === "string" ? bc.baseName.name : undefined);
      if (baseName && bc.baseName?.loc) {
        const first = baseName.split(".")[0];
        tokens.push({
          line: bc.baseName.loc.start.line - 1,
          char: bc.baseName.loc.start.column,
          length: first.length,
          type: "type",
          modifiers: [],
        });
      }
    }

    for (const sub of node.subNodes ?? []) {
      switch (sub.type) {
        case "FunctionDefinition":
          this.emitFunction(sub, lines, tokens);
          break;
        case "StateVariableDeclaration":
          this.emitStateVariable(sub, tokens);
          break;
        case "EventDefinition":
          this.emitEvent(sub, lines, tokens);
          break;
        case "CustomErrorDefinition":
        case "CustomErrorType":
          this.emitError(sub, lines, tokens);
          break;
        case "StructDefinition":
          this.emitStruct(sub, lines, tokens);
          break;
        case "EnumDefinition":
          this.emitEnum(sub, lines, tokens);
          break;
        case "ModifierDefinition":
          this.emitModifier(sub, lines, tokens);
          break;
        case "TypeDefinition":
          this.emitUdvt(sub, lines, tokens);
          break;
      }
    }
  }

  private emitFunction(node: RawNode, lines: string[], tokens: TokenInfo[]): void {
    // `name` is null for constructor / receive / fallback. We still
    // emit parameter tokens for all four; the `function` keyword itself
    // is coloured by the TextMate grammar.
    if (node.name && node.loc) {
      const pos = findNameAfter(lines, node.loc.start.line - 1, node.loc.start.column, node.name);
      if (pos) {
        const modifiers: string[] = ["declaration"];
        if (node.isVirtual) modifiers.push("virtual");
        if (node.override) modifiers.push("override");
        tokens.push({
          line: pos.line,
          char: pos.char,
          length: node.name.length,
          type: "function",
          modifiers,
        });
      }
    }

    for (const p of node.parameters ?? []) this.emitParam(p, "parameter", tokens);
    for (const p of node.returnParameters ?? []) this.emitParam(p, "parameter", tokens);
  }

  private emitEvent(node: RawNode, lines: string[], tokens: TokenInfo[]): void {
    if (node.name && node.loc) {
      const pos = findNameAfter(lines, node.loc.start.line - 1, node.loc.start.column, node.name);
      if (pos) {
        tokens.push({
          line: pos.line,
          char: pos.char,
          length: node.name.length,
          type: "event",
          modifiers: ["declaration"],
        });
      }
    }
    for (const p of node.parameters ?? []) this.emitParam(p, "parameter", tokens);
  }

  private emitError(node: RawNode, lines: string[], tokens: TokenInfo[]): void {
    if (node.name && node.loc) {
      const pos = findNameAfter(lines, node.loc.start.line - 1, node.loc.start.column, node.name);
      if (pos) {
        tokens.push({
          line: pos.line,
          char: pos.char,
          length: node.name.length,
          // Errors don't have a dedicated token type in LSP; `function`
          // matches how most clients style error identifiers and keeps
          // us within the declared legend.
          type: "function",
          modifiers: ["declaration"],
        });
      }
    }
    for (const p of node.parameters ?? []) this.emitParam(p, "parameter", tokens);
  }

  private emitStruct(node: RawNode, lines: string[], tokens: TokenInfo[]): void {
    if (node.name && node.loc) {
      const pos = findNameAfter(lines, node.loc.start.line - 1, node.loc.start.column, node.name);
      if (pos) {
        tokens.push({
          line: pos.line,
          char: pos.char,
          length: node.name.length,
          type: "struct",
          modifiers: ["declaration"],
        });
      }
    }
    // Struct members are VariableDeclaration nodes — tokenize type
    // reference (if user-defined) and the member name as `property`.
    for (const m of node.members ?? []) this.emitParam(m, "property", tokens);
  }

  private emitEnum(node: RawNode, lines: string[], tokens: TokenInfo[]): void {
    if (node.name && node.loc) {
      const pos = findNameAfter(lines, node.loc.start.line - 1, node.loc.start.column, node.name);
      if (pos) {
        tokens.push({
          line: pos.line,
          char: pos.char,
          length: node.name.length,
          type: "enum",
          modifiers: ["declaration"],
        });
      }
    }
  }

  private emitModifier(node: RawNode, lines: string[], tokens: TokenInfo[]): void {
    if (node.name && node.loc) {
      const pos = findNameAfter(lines, node.loc.start.line - 1, node.loc.start.column, node.name);
      if (pos) {
        tokens.push({
          line: pos.line,
          char: pos.char,
          length: node.name.length,
          type: "macro",
          modifiers: ["declaration"],
        });
      }
    }
    for (const p of node.parameters ?? []) this.emitParam(p, "parameter", tokens);
  }

  private emitUdvt(node: RawNode, lines: string[], tokens: TokenInfo[]): void {
    // `type Foo is uint256;` — tokenize `Foo` as `type`.
    if (node.name && node.loc) {
      const pos = findNameAfter(lines, node.loc.start.line - 1, node.loc.start.column, node.name);
      if (pos) {
        tokens.push({
          line: pos.line,
          char: pos.char,
          length: node.name.length,
          type: "type",
          modifiers: ["declaration"],
        });
      }
    }
  }

  private emitStateVariable(node: RawNode, tokens: TokenInfo[]): void {
    // StateVariableDeclaration wraps one or more VariableDeclaration
    // nodes in `.variables`. Each carries a dedicated `.identifier.loc`
    // for the name and `.typeName.loc` for the type.
    for (const v of node.variables ?? []) {
      this.emitTypeRef(v.typeName, tokens);
      if (v.name && v.identifier?.loc) {
        const modifiers: string[] = ["declaration"];
        if (v.isDeclaredConst || v.isImmutable) modifiers.push("readonly");
        tokens.push({
          line: v.identifier.loc.start.line - 1,
          char: v.identifier.loc.start.column,
          length: v.name.length,
          type: "property",
          modifiers,
        });
      }
    }
  }

  /**
   * Emit tokens for a single parameter / struct member — the type
   * reference (if user-defined) and then the name. Shared between
   * function, event, error, modifier, and struct callers.
   */
  private emitParam(p: RawNode, nameKind: "parameter" | "property", tokens: TokenInfo[]): void {
    if (!p) return;
    this.emitTypeRef(p.typeName, tokens);
    if (p.name && p.identifier?.loc) {
      tokens.push({
        line: p.identifier.loc.start.line - 1,
        char: p.identifier.loc.start.column,
        length: p.name.length,
        type: nameKind,
        modifiers: ["declaration"],
      });
    }
  }

  /**
   * Recursively tokenize user-defined type references inside a type
   * expression. Mapping key/value, array element, and function-type
   * parameter types are descended into. Elementary types (uint256,
   * address, bytes32, ...) are intentionally skipped — the TextMate
   * grammar already colours them as keywords.
   */
  private emitTypeRef(t: RawNode | null | undefined, tokens: TokenInfo[]): void {
    if (!t) return;
    switch (t.type) {
      case "UserDefinedTypeName": {
        const name =
          t.namePath ?? (typeof t.name === "string" && t.name.length > 0 ? t.name : undefined);
        if (name && t.loc) {
          // For a dotted path like `IERC20.Transfer`, only the first
          // segment is a type reference; the dot-suffix is a member
          // access and is handled elsewhere.
          const firstSeg = name.split(".")[0];
          tokens.push({
            line: t.loc.start.line - 1,
            char: t.loc.start.column,
            length: firstSeg.length,
            type: "type",
            modifiers: [],
          });
        }
        return;
      }
      case "Mapping":
        this.emitTypeRef(t.keyType, tokens);
        this.emitTypeRef(t.valueType, tokens);
        return;
      case "ArrayTypeName":
        this.emitTypeRef(t.baseTypeName, tokens);
        return;
      case "FunctionTypeName":
        for (const p of t.parameterTypes ?? []) this.emitTypeRef(p.typeName, tokens);
        for (const p of t.returnTypes ?? []) this.emitTypeRef(p.typeName, tokens);
        return;
    }
  }

  // ── Reference-site tokens ───────────────────────────────────────────

  private buildGlobalNameKinds(result: ParseResult): Map<string, string> {
    // Map file/contract-scoped identifier text → semantic token type.
    // Function parameters are intentionally added later per function body
    // so a parameter named `owner` in one function does not recolor
    // `owner` references in another function.
    const kinds = new Map<string, string>();
    const su = result.sourceUnit;

    // User-defined types first. References to these in function bodies
    // (e.g. `PoolKey memory k = ...` or `MarketId id = ...`) get the
    // `type` semantic color, matching their declaration-site colour.
    for (const udvt of su.userDefinedValueTypes ?? []) {
      if (udvt.name) kinds.set(udvt.name, "type");
    }
    for (const contract of su.contracts) {
      if (contract.name) {
        kinds.set(contract.name, contract.kind === "interface" ? "interface" : "class");
      }
      for (const struct of contract.structs) {
        if (struct.name) kinds.set(struct.name, "struct");
      }
      for (const enumDef of contract.enums) {
        if (enumDef.name) kinds.set(enumDef.name, "enum");
      }
      for (const err of contract.errors) {
        if (err.name) kinds.set(err.name, "function");
      }
    }
    for (const err of su.errors ?? []) {
      if (err.name) kinds.set(err.name, "function");
    }

    for (const contract of su.contracts) {
      for (const svar of contract.stateVariables) {
        if (svar.name) kinds.set(svar.name, "property");
      }
      for (const event of contract.events) {
        if (event.name) kinds.set(event.name, "event");
      }
      for (const mod of contract.modifiers) {
        if (mod.name) kinds.set(mod.name, "macro");
      }
      for (const func of contract.functions) {
        if (func.name) kinds.set(func.name, "function");
      }
    }

    return kinds;
  }

  private collectReferenceTokens(
    result: ParseResult,
    lines: string[],
    nameKinds: Map<string, string>,
    tokens: TokenInfo[],
    token?: CancellationToken,
  ): void {
    for (const contract of result.sourceUnit.contracts) {
      if (token?.isCancellationRequested) return;
      for (const func of contract.functions) {
        if (token?.isCancellationRequested) return;
        if (!func.body) continue;
        const bounds = getFunctionBodyBounds(lines, func.range.start.line);
        if (!bounds) continue;

        const scopedNameKinds = new Map(nameKinds);
        for (const param of func.parameters) {
          if (param.name) scopedNameKinds.set(param.name, "parameter");
        }
        for (const param of func.returnParameters) {
          if (param.name) scopedNameKinds.set(param.name, "parameter");
        }

        const idents = scanIdentifiersInRange(lines, bounds);
        for (const id of idents) {
          const kind = scopedNameKinds.get(id.text);
          if (!kind) continue;
          tokens.push({
            line: id.line,
            char: id.char,
            length: id.length,
            type: kind,
            modifiers: [],
          });
        }
      }
    }
  }

  // ── Build / emit ────────────────────────────────────────────────────

  private buildFromTokens(tokens: TokenInfo[]): SemanticTokens {
    const sorted = [...tokens].sort((a, b) => a.line - b.line || a.char - b.char);
    const builder = new SemanticTokensBuilder();
    for (const t of sorted) {
      this.pushToken(builder, t.line, t.char, t.length, t.type, t.modifiers);
    }
    return builder.build();
  }

  private pushToken(
    builder: SemanticTokensBuilder,
    line: number,
    char: number,
    length: number,
    tokenType: string,
    tokenModifiers: string[],
  ): void {
    const typeIndex = tokenTypeMap.get(tokenType as (typeof SolSemanticTokenTypes)[number]);
    if (typeIndex === undefined) return;

    let modifierBitmask = 0;
    for (const mod of tokenModifiers) {
      const modIndex = tokenModifierMap.get(mod as (typeof SolSemanticTokenModifiers)[number]);
      if (modIndex !== undefined) {
        modifierBitmask |= 1 << modIndex;
      }
    }

    builder.push(line, char, length, typeIndex, modifierBitmask);
  }
}

interface TokenInfo {
  line: number;
  char: number;
  length: number;
  type: string;
  modifiers: string[];
}

interface BodyBounds {
  startLine: number;
  startChar: number; // first char *inside* the opening brace
  endLine: number;
  endChar: number; // position of the closing brace
}

/**
 * Find the body of a function starting at `funcStartLine` and return its
 * char-level bounds (just inside the `{` through just before the `}`).
 *
 * This is a simple brace-depth scanner adapted from `call-hierarchy.ts`'s
 * `getFunctionBodyRange`. It does not treat braces inside strings/comments
 * specially, which matches the existing helper's behaviour.
 */
function getFunctionBodyBounds(lines: string[], funcStartLine: number): BodyBounds | null {
  let depth = 0;
  let open: { line: number; char: number } | null = null;

  for (let i = funcStartLine; i < lines.length; i++) {
    const line = lines[i];
    for (let col = 0; col < line.length; col++) {
      const ch = line[col];
      if (ch === "{") {
        if (!open) open = { line: i, char: col };
        depth++;
      } else if (ch === "}") {
        depth--;
        if (open && depth === 0) {
          return {
            startLine: open.line,
            startChar: open.char + 1,
            endLine: i,
            endChar: col,
          };
        }
      }
    }
    if (!open && line.includes(";")) return null;
  }
  return null;
}

interface IdentifierMatch {
  line: number;
  char: number;
  length: number;
  text: string;
}

/**
 * Scan the text range described by `bounds` and emit every identifier we
 * encounter, skipping any content inside strings, line comments, or block
 * comments. Block-comment state is carried across line boundaries.
 *
 * Conceptually this mirrors `isInsideString` + `findLineCommentStart` from
 * `../utils/text.js`, but folded into a single char-by-char pass so that
 * block comments spanning multiple lines are handled correctly.
 */
function scanIdentifiersInRange(lines: string[], bounds: BodyBounds): IdentifierMatch[] {
  const out: IdentifierMatch[] = [];
  let inBlockComment = false;

  for (
    let lineIdx = bounds.startLine;
    lineIdx <= bounds.endLine && lineIdx < lines.length;
    lineIdx++
  ) {
    const line = lines[lineIdx];
    const startCol = lineIdx === bounds.startLine ? bounds.startChar : 0;
    const endCol = lineIdx === bounds.endLine ? Math.min(bounds.endChar, line.length) : line.length;
    let col = startCol;

    while (col < endCol) {
      if (inBlockComment) {
        const closeIdx = line.indexOf("*/", col);
        if (closeIdx === -1 || closeIdx >= endCol) {
          col = endCol;
        } else {
          col = closeIdx + 2;
          inBlockComment = false;
        }
        continue;
      }

      const ch = line[col];
      const next = col + 1 < line.length ? line[col + 1] : "";

      if (ch === "/" && next === "*") {
        inBlockComment = true;
        col += 2;
        continue;
      }
      if (ch === "/" && next === "/") {
        break; // line comment — skip the rest of the line
      }
      if (ch === '"' || ch === "'") {
        const quote = ch;
        col++;
        while (col < endCol) {
          if (line[col] === "\\") {
            col += 2;
            continue;
          }
          if (line[col] === quote) {
            col++;
            break;
          }
          col++;
        }
        continue;
      }
      if (isIdentStart(ch)) {
        let end = col + 1;
        while (end < endCol && isIdentCont(line[end])) end++;
        out.push({
          line: lineIdx,
          char: col,
          length: end - col,
          text: line.slice(col, end),
        });
        col = end;
        continue;
      }
      col++;
    }
  }
  return out;
}

function isIdentStart(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_" || ch === "$";
}

function isIdentCont(ch: string): boolean {
  return isIdentStart(ch) || (ch >= "0" && ch <= "9");
}

/**
 * Search forward from `(startLine, startCol)` for the first whole-word
 * occurrence of `name`. Used to pinpoint a declaration's identifier
 * when the parser only gives us the enclosing node's `loc.start`
 * (which for contracts / functions / events / errors / etc. points at
 * the keyword rather than the name). Bounded lookahead keeps us from
 * accidentally matching an occurrence far beyond the declaration.
 */
function findNameAfter(
  lines: string[],
  startLine: number,
  startCol: number,
  name: string,
  maxLookaheadLines = 5,
): { line: number; char: number } | null {
  if (!name) return null;
  const re = new RegExp(`\\b${escapeRegex(name)}\\b`);
  const endLine = Math.min(startLine + maxLookaheadLines, lines.length - 1);
  for (let l = startLine; l <= endLine; l++) {
    const line = lines[l] ?? "";
    const slice = l === startLine ? line.slice(startCol) : line;
    const m = slice.match(re);
    if (m && typeof m.index === "number") {
      return { line: l, char: (l === startLine ? startCol : 0) + m.index };
    }
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Raw `@solidity-parser/parser` AST shapes (structural-typing only) ─

/**
 * Minimal structural typing for the raw `@solidity-parser/parser` AST
 * nodes we inspect here. The parser package publishes `ASTNode` but it
 * doesn't cover every shape consistently (e.g. `.identifier.loc` on
 * variable declarations), and we intentionally only read a handful of
 * fields. Declaring the narrow shape here keeps the walker type-safe
 * without introducing a hard dependency on internal parser types.
 */
interface RawSourceUnit {
  children?: RawNode[];
}

interface RawLoc {
  start: { line: number; column: number };
  end: { line: number; column: number };
}

interface RawNode {
  type?: string;
  name?: string;
  namePath?: string;
  loc?: RawLoc;
  kind?: string;
  isVirtual?: boolean;
  override?: unknown;
  isDeclaredConst?: boolean;
  isImmutable?: boolean;
  children?: RawNode[];
  subNodes?: RawNode[];
  parameters?: RawNode[];
  returnParameters?: RawNode[];
  members?: RawNode[];
  variables?: RawNode[];
  parameterTypes?: RawNode[];
  returnTypes?: RawNode[];
  typeName?: RawNode;
  baseTypeName?: RawNode;
  keyType?: RawNode;
  valueType?: RawNode;
  identifier?: RawNode;
  baseContracts?: { baseName?: RawNode }[];
}
