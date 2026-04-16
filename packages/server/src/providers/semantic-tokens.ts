import type { SemanticTokens, Range } from "vscode-languageserver/node.js";
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

  provideSemanticTokens(document: TextDocument): SemanticTokens {
    const tokens = this.collectTokens(document);
    return this.buildFromTokens(tokens);
  }

  provideSemanticTokensRange(document: TextDocument, range: Range): SemanticTokens {
    const tokens = this.collectTokens(document).filter(
      (t) => t.line >= range.start.line && t.line <= range.end.line,
    );
    return this.buildFromTokens(tokens);
  }

  // ── Token collection ────────────────────────────────────────────────

  private collectTokens(document: TextDocument): TokenInfo[] {
    const tokens: TokenInfo[] = [];
    const result = this.parser.get(document.uri);
    if (!result) return tokens;

    const text = document.getText();
    const lines = text.split("\n");

    this.collectDeclarationTokens(result, tokens);

    const nameKinds = this.buildNameKinds(result);
    this.collectReferenceTokens(result, lines, nameKinds, tokens);

    return tokens;
  }

  private collectDeclarationTokens(result: ParseResult, tokens: TokenInfo[]): void {
    const su = result.sourceUnit;

    for (const pragma of su.pragmas) {
      tokens.push({
        line: pragma.range.start.line,
        char: 0,
        length: 6, // "pragma"
        type: "keyword",
        modifiers: [],
      });
      tokens.push({
        line: pragma.range.start.line,
        char: 7,
        length: pragma.name.length,
        type: "namespace",
        modifiers: [],
      });
    }

    for (const imp of su.imports) {
      tokens.push({
        line: imp.range.start.line,
        char: 0,
        length: 6, // "import"
        type: "keyword",
        modifiers: [],
      });
    }

    for (const contract of su.contracts) {
      tokens.push({
        line: contract.nameRange.start.line,
        char: contract.nameRange.start.character,
        length: contract.name.length,
        type: contract.kind === "interface" ? "interface" : "class",
        modifiers: ["declaration", "definition"],
      });

      for (const func of contract.functions) {
        if (func.name) {
          const modifiers: string[] = ["declaration"];
          if (func.isVirtual) modifiers.push("virtual");
          if (func.isOverride) modifiers.push("override");
          tokens.push({
            line: func.range.start.line,
            char: func.nameRange.start.character,
            length: func.name.length,
            type: "function",
            modifiers,
          });
        }
      }

      for (const event of contract.events) {
        tokens.push({
          line: event.range.start.line,
          char: event.nameRange.start.character,
          length: event.name.length,
          type: "event",
          modifiers: ["declaration"],
        });
      }

      for (const svar of contract.stateVariables) {
        const modifiers: string[] = [];
        if (svar.mutability === "constant" || svar.mutability === "immutable") {
          modifiers.push("readonly");
        }
        tokens.push({
          line: svar.range.start.line,
          char: svar.nameRange.start.character,
          length: svar.name.length,
          type: "property",
          modifiers,
        });
      }

      for (const struct of contract.structs) {
        tokens.push({
          line: struct.range.start.line,
          char: struct.nameRange.start.character,
          length: struct.name.length,
          type: "struct",
          modifiers: ["declaration"],
        });
      }

      for (const enumDef of contract.enums) {
        tokens.push({
          line: enumDef.range.start.line,
          char: enumDef.nameRange.start.character,
          length: enumDef.name.length,
          type: "enum",
          modifiers: ["declaration"],
        });
      }

      for (const mod of contract.modifiers) {
        tokens.push({
          line: mod.range.start.line,
          char: mod.nameRange.start.character,
          length: mod.name.length,
          type: "macro",
          modifiers: ["declaration"],
        });
      }
    }
  }

  // ── Reference-site tokens ───────────────────────────────────────────

  private buildNameKinds(result: ParseResult): Map<string, string> {
    // Map identifier text → semantic token type. Later writes win; the
    // priority order (state vars → events → modifiers → functions →
    // parameters) puts locals ahead of file-scoped symbols so parameter
    // references mask state variable references when names collide.
    const kinds = new Map<string, string>();

    for (const contract of result.sourceUnit.contracts) {
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
      for (const func of contract.functions) {
        for (const param of func.parameters) {
          if (param.name) kinds.set(param.name, "parameter");
        }
        for (const param of func.returnParameters) {
          if (param.name) kinds.set(param.name, "parameter");
        }
      }
      for (const mod of contract.modifiers) {
        for (const param of mod.parameters) {
          if (param.name) kinds.set(param.name, "parameter");
        }
      }
    }

    return kinds;
  }

  private collectReferenceTokens(
    result: ParseResult,
    lines: string[],
    nameKinds: Map<string, string>,
    tokens: TokenInfo[],
  ): void {
    for (const contract of result.sourceUnit.contracts) {
      for (const func of contract.functions) {
        if (!func.body) continue;
        const bounds = getFunctionBodyBounds(lines, func.range.start.line);
        if (!bounds) continue;

        const idents = scanIdentifiersInRange(lines, bounds);
        for (const id of idents) {
          const kind = nameKinds.get(id.text);
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
