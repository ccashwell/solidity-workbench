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

      // Detect `Receiver.funcName(...)` by looking at the char just
      // before the match. If present, the receiver is the identifier
      // walking backward through word chars. For a chain like
      // `a.b.c.fn()` we pick the immediate receiver `c` — that's the
      // type `fn` belongs to, not the root `a`.
      const receiver = this.extractReceiver(line, match.index);

      // Opening paren immediately follows the identifier (modulo optional
      // whitespace which is already consumed by \s* in the regex).
      const openParenIdx = match.index + match[0].length - 1;

      // Parse args respecting nested `()` / `[]` / `{}` / string literals.
      const parseResult = this.parseArgumentList(line, openParenIdx);
      if (!parseResult) continue;

      const paramNames = this.getParameterNames(funcName, receiver);
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

  /**
   * Extract the receiver identifier from `<Receiver>.funcName(` when
   * the char immediately before the match is a `.`. Returns `null`
   * for plain `funcName(` calls. Whitespace between the dot and the
   * function name is legal Solidity but vanishingly rare; we match
   * the common, no-whitespace form.
   */
  private extractReceiver(line: string, funcNameStart: number): string | null {
    if (funcNameStart <= 0 || line[funcNameStart - 1] !== ".") return null;
    let start = funcNameStart - 1;
    while (start > 0 && /[\w$]/.test(line[start - 1])) start--;
    const ident = line.slice(start, funcNameStart - 1);
    return ident || null;
  }

  /**
   * Look up parameter names for `funcName` — receiver-aware when a
   * receiver is identified in the source.
   *
   * Rules:
   *   - `Receiver.funcName(...)` where `Receiver` is a user-defined
   *     value type: the only legal members are the implicit
   *     `wrap` / `unwrap`, neither of which benefits from inlay
   *     hints. Return `[]`.
   *   - `Receiver.funcName(...)` where `Receiver` resolves to a
   *     contract / interface / library: walk its inheritance chain
   *     and return the matching function's parameter names.
   *   - `Receiver.funcName(...)` where `Receiver` doesn't resolve
   *     (e.g. it's a local variable whose type we can't infer at
   *     the inlay-hint layer): return `[]`. "Silent when unsure" is
   *     the right default — surfacing a same-named function from an
   *     unrelated type would be worse than no hint.
   *   - `funcName(...)` (no receiver): fall back to the legacy
   *     name-only lookup, preferring the first `function`-kind
   *     symbol whose container we can resolve.
   */
  private getParameterNames(funcName: string, receiver: string | null): string[] {
    if (receiver !== null) {
      const receiverSymbols = this.symbolIndex.findSymbols(receiver);
      if (receiverSymbols.some((s) => s.kind === "userDefinedValueType")) return [];

      const chain = this.symbolIndex.getInheritanceChain(receiver);
      for (const c of chain) {
        const fn = c.functions.find((f) => f.name === funcName);
        if (fn) {
          return fn.parameters.map((p) => p.name).filter((n): n is string => !!n);
        }
      }

      // Receiver specified but not resolvable to a known type —
      // refuse to guess.
      return [];
    }

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
