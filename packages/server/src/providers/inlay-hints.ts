import type { InlayHint, Range } from "vscode-languageserver/node.js";
import { InlayHintKind } from "vscode-languageserver/node.js";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type { SymbolIndex } from "../analyzer/symbol-index.js";
import type { SolidityParser } from "../parser/solidity-parser.js";
import { CALL_LIKE_KEYWORDS } from "../utils/text.js";

/**
 * Provides inlay hints — inline annotations that show parameter names
 * at call sites: `transfer(‸to: addr, ‸amount: 100)`.
 *
 * Call-site detection: we walk the line character-by-character looking
 * for the pattern `<ident>(`, then walk forward with paren/bracket depth
 * so that nested calls like `transfer(address(0x1), 100)` split into the
 * correct top-level argument list (`address(0x1)`, `100`) instead of
 * the first-close-paren-wins result a regex would give.
 *
 * Declaration lines (function / event / error / ...) are skipped wholesale.
 */
export class InlayHintsProvider {
  constructor(
    private symbolIndex: SymbolIndex,
    private parser: SolidityParser,
  ) {}

  provideInlayHints(document: TextDocument, range: Range): InlayHint[] {
    const hints: InlayHint[] = [];
    const text = document.getText();
    const lines = text.split("\n");

    for (
      let lineNum = range.start.line;
      lineNum <= Math.min(range.end.line, lines.length - 1);
      lineNum++
    ) {
      const line = lines[lineNum];
      this.findCallSiteHints(line, lineNum, document.uri, hints);
    }

    return hints;
  }

  private findCallSiteHints(line: string, lineNum: number, _uri: string, hints: InlayHint[]): void {
    if (this.isDeclarationLine(line)) return;

    // Walk the line looking for `<ident>(`, then for each open paren
    // parse the argument list with depth tracking.
    const identRe = /\b(\w+)\s*\(/g;
    let match: RegExpExecArray | null;

    while ((match = identRe.exec(line)) !== null) {
      const funcName = match[1];
      if (CALL_LIKE_KEYWORDS.has(funcName)) continue;

      // Opening paren immediately follows the identifier (modulo optional
      // whitespace which is already consumed by \s* in the regex).
      const openParenIdx = match.index + match[0].length - 1;

      // Parse args respecting nested `()` / `[]` / `{}` / string literals.
      const parseResult = this.parseArgumentList(line, openParenIdx);
      if (!parseResult) continue;

      const paramNames = this.getParameterNames(funcName);
      if (paramNames.length === 0) continue;

      for (let i = 0; i < Math.min(parseResult.args.length, paramNames.length); i++) {
        const arg = parseResult.args[i];
        const trimmed = arg.text.trim();
        if (!trimmed) continue;
        if (trimmed.includes(":")) continue; // already a named arg
        if (trimmed === paramNames[i]) continue; // redundant

        hints.push({
          position: { line: lineNum, character: arg.start },
          label: `${paramNames[i]}:`,
          kind: InlayHintKind.Parameter,
          paddingRight: true,
        });
      }
    }
  }

  /**
   * Parse the argument list that begins at `line[openParenIdx]` (which
   * must be `(`). Returns `null` when no matching close-paren is found
   * on the same line — inlay hints for multi-line argument lists is a
   * future enhancement; today we skip that case rather than guess.
   *
   * Each argument's `start` column is the index in `line` of its first
   * non-whitespace character, which is where we anchor the inlay hint.
   */
  private parseArgumentList(
    line: string,
    openParenIdx: number,
  ): { args: { text: string; start: number }[] } | null {
    if (line[openParenIdx] !== "(") return null;

    const args: { text: string; start: number }[] = [];
    let depth = 1;
    let argStartCol: number | null = null;
    let argText = "";
    let i = openParenIdx + 1;

    const pushArg = (): void => {
      if (argStartCol === null) return;
      args.push({ text: argText, start: argStartCol });
      argText = "";
      argStartCol = null;
    };

    while (i < line.length) {
      const ch = line[i];

      // String literal handling so commas / parens inside strings don't
      // fool the depth counter.
      if (ch === '"' || ch === "'") {
        const quote = ch;
        // Start of argument? If we hadn't seen non-whitespace yet, seed
        // the argStart at this quote.
        if (argStartCol === null) argStartCol = i;
        argText += ch;
        i++;
        while (i < line.length) {
          const c = line[i];
          argText += c;
          i++;
          if (c === "\\") {
            if (i < line.length) {
              argText += line[i];
              i++;
            }
            continue;
          }
          if (c === quote) break;
        }
        continue;
      }

      if (ch === "(" || ch === "[" || ch === "{") {
        depth++;
        if (argStartCol === null && !/\s/.test(ch)) argStartCol = i;
        argText += ch;
        i++;
        continue;
      }

      if (ch === ")" || ch === "]" || ch === "}") {
        depth--;
        if (depth === 0) {
          pushArg();
          return { args };
        }
        argText += ch;
        i++;
        continue;
      }

      if (ch === "," && depth === 1) {
        pushArg();
        i++;
        continue;
      }

      if (argStartCol === null) {
        if (!/\s/.test(ch)) argStartCol = i;
      }
      if (argStartCol !== null) argText += ch;
      i++;
    }

    // Unterminated paren on this line.
    return null;
  }

  /**
   * True if `line`'s first non-whitespace token introduces a declaration
   * whose parameter list would otherwise look like a call site to the
   * inlay-hint regex.
   */
  private isDeclarationLine(line: string): boolean {
    const trimmed = line.trimStart();
    return /^(function|modifier|event|error|constructor|receive|fallback|struct|enum|interface|contract|library|abstract)\b/.test(
      trimmed,
    );
  }

  private getParameterNames(funcName: string): string[] {
    const symbols = this.symbolIndex.findSymbols(funcName);
    for (const sym of symbols) {
      if (sym.kind === "function") {
        const contract = sym.containerName
          ? this.symbolIndex.getContract(sym.containerName)
          : undefined;
        if (contract) {
          const func = contract.contract.functions.find((f) => f.name === funcName);
          if (func) {
            return func.parameters.map((p) => p.name).filter((n): n is string => !!n);
          }
        }
      }
    }
    return [];
  }
}
