import type { InlayHint, Range } from "vscode-languageserver/node.js";
import { InlayHintKind } from "vscode-languageserver/node.js";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type { ContractDefinition, FunctionDefinition } from "@solidity-workbench/common";
import type { SymbolIndex } from "../analyzer/symbol-index.js";
import type { SolidityParser } from "../parser/solidity-parser.js";
import {
  CALL_LIKE_KEYWORDS,
  findCommentRanges,
  findLocalVariableType,
  getFunctionBodyTextPrefix,
  isPositionInCommentRanges,
} from "../utils/text.js";

interface ReceiverExpression {
  simpleName?: string;
  explicitTypeName?: string;
}

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
    // Pre-compute comment regions for the whole document so multi-line
    // block comments are tracked correctly even when `range` only covers
    // the visible viewport.
    const commentRanges = findCommentRanges(text);

    for (
      let lineNum = range.start.line;
      lineNum <= Math.min(range.end.line, lines.length - 1);
      lineNum++
    ) {
      const line = lines[lineNum];
      this.findCallSiteHints(lines, line, lineNum, document.uri, commentRanges, hints);
    }

    return hints;
  }

  private findCallSiteHints(
    lines: string[],
    line: string,
    lineNum: number,
    uri: string,
    commentRanges: Map<number, Array<[number, number]>>,
    hints: InlayHint[],
  ): void {
    if (this.isDeclarationLine(line)) return;

    // Walk the line looking for `<ident>(`, then for each open paren
    // parse the argument list with depth tracking.
    const identRe = /\b(\w+)\s*\(/g;
    let match: RegExpExecArray | null;

    while ((match = identRe.exec(line)) !== null) {
      // NatSpec and other comments are prose, not call sites — even
      // when they happen to contain `name(args)` inside backticks.
      if (isPositionInCommentRanges(commentRanges, lineNum, match.index)) continue;
      const funcName = match[1];
      if (CALL_LIKE_KEYWORDS.has(funcName)) continue;

      // Detect `Receiver.funcName(...)` by looking at the char just
      // before the match. For a chain like `a.b.c.fn()` we pick the
      // immediate receiver `c`; for `IERC20(x).fn()` we keep enough
      // of the cast expression to recover the explicit receiver type.
      const receiver = this.extractReceiver(line, match.index);

      // Opening paren immediately follows the identifier (modulo optional
      // whitespace which is already consumed by \s* in the regex).
      const openParenIdx = match.index + match[0].length - 1;

      // Parse args respecting nested `()` / `[]` / `{}` / string literals.
      const parseResult = this.parseArgumentList(lines, lineNum, openParenIdx);
      if (!parseResult) continue;

      const paramNames = this.getParameterNames(funcName, receiver, uri, lineNum, match.index);
      if (paramNames.length === 0) continue;

      for (let i = 0; i < Math.min(parseResult.args.length, paramNames.length); i++) {
        const arg = parseResult.args[i];
        const trimmed = arg.text.trim();
        if (!trimmed) continue;
        if (trimmed.includes(":")) continue; // already a named arg
        if (trimmed === paramNames[i]) continue; // redundant

        hints.push({
          position: arg.start,
          label: `${paramNames[i]}:`,
          kind: InlayHintKind.Parameter,
          paddingRight: true,
        });
      }
    }
  }

  /**
   * Parse the argument list that begins at `lines[startLine][openParenIdx]`
   * (which must be `(`). The scanner walks across lines, respecting nested
   * delimiters and string literals, so common formatted calls like
   * `transfer(\n  to,\n  amount\n)` get the same parameter hints as
   * single-line calls.
   *
   * Each argument's `start` column is the index in `line` of its first
   * non-whitespace character, which is where we anchor the inlay hint.
   */
  private parseArgumentList(
    lines: string[],
    startLine: number,
    openParenIdx: number,
  ): { args: { text: string; start: { line: number; character: number } }[] } | null {
    if (lines[startLine]?.[openParenIdx] !== "(") return null;

    const args: { text: string; start: { line: number; character: number } }[] = [];
    let depth = 1;
    let argStart: { line: number; character: number } | null = null;
    let argText = "";
    let lineNum = startLine;
    let i = openParenIdx + 1;

    const pushArg = (): void => {
      if (argStart === null) return;
      args.push({ text: argText, start: argStart });
      argText = "";
      argStart = null;
    };

    while (lineNum < lines.length) {
      const line = lines[lineNum];
      if (i >= line.length) {
        if (argStart !== null) argText += "\n";
        lineNum++;
        i = 0;
        continue;
      }

      const ch = line[i];

      // String literal handling so commas / parens inside strings don't
      // fool the depth counter.
      if (ch === '"' || ch === "'") {
        const quote = ch;
        // Start of argument? If we hadn't seen non-whitespace yet, seed
        // the argStart at this quote.
        if (argStart === null) argStart = { line: lineNum, character: i };
        argText += ch;
        i++;
        while (lineNum < lines.length) {
          const currentLine = lines[lineNum];
          if (i >= currentLine.length) {
            argText += "\n";
            lineNum++;
            i = 0;
            continue;
          }
          const c = currentLine[i];
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
        if (argStart === null && !/\s/.test(ch)) {
          argStart = { line: lineNum, character: i };
        }
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

      if (argStart === null) {
        if (!/\s/.test(ch)) argStart = { line: lineNum, character: i };
      }
      if (argStart !== null) argText += ch;
      i++;
    }

    // Unterminated paren.
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
   * Extract the receiver expression from `<Receiver>.funcName(` when
   * the char immediately before the match is a `.`. Returns `null`
   * for plain `funcName(` calls.
   */
  private extractReceiver(line: string, funcNameStart: number): ReceiverExpression | null {
    let dotIdx = funcNameStart - 1;
    while (dotIdx >= 0 && /\s/.test(line[dotIdx])) dotIdx--;
    if (dotIdx < 0 || line[dotIdx] !== ".") return null;

    let end = dotIdx;
    while (end > 0 && /\s/.test(line[end - 1])) end--;

    if (end > 0 && /[\w$]/.test(line[end - 1])) {
      let start = end;
      while (start > 0 && /[\w$]/.test(line[start - 1])) start--;
      const simpleName = line.slice(start, end);
      return simpleName ? { simpleName } : null;
    }

    if (end > 0 && line[end - 1] === ")") {
      const start = this.findCallExpressionStart(line, end - 1);
      if (start === null) return {};
      const text = line.slice(start, end).trim();
      const explicitTypeName = this.extractExplicitTypeName(text);
      return explicitTypeName ? { explicitTypeName } : {};
    }

    return {};
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
   *   - `receiver.funcName(...)` where `receiver` is a typed parameter
   *     or state variable covered by a `using Library for Type`
   *     directive: resolve the library function and skip its implicit
   *     first parameter.
   *   - `Receiver.funcName(...)` where `Receiver` doesn't resolve
   *     to a known member or using-for extension: return `[]`.
   *     "Silent when unsure" is the right default — surfacing a
   *     same-named function from an unrelated type would be worse
   *     than no hint.
   *   - `funcName(...)` (no receiver): fall back to the legacy
   *     name-only lookup, preferring the first `function`-kind
   *     symbol whose container we can resolve.
   */
  private getParameterNames(
    funcName: string,
    receiver: ReceiverExpression | null,
    uri: string,
    lineNum: number,
    lineChar: number,
  ): string[] {
    if (receiver !== null) {
      const receiverName = receiver.simpleName ?? receiver.explicitTypeName;
      const receiverSymbols = receiverName ? this.symbolIndex.findSymbols(receiverName) : [];
      if (receiverSymbols.some((s) => s.kind === "userDefinedValueType")) return [];

      if (receiverName) {
        const chain = this.symbolIndex.getInheritanceChain(receiverName);
        for (const c of chain) {
          const fn = c.functions.find((f) => f.name === funcName);
          if (fn) {
            return fn.parameters.map((p) => p.name).filter((n): n is string => !!n);
          }
        }
      }

      const usingForParams = this.getUsingForParameterNames(
        funcName,
        receiver,
        uri,
        lineNum,
        lineChar,
      );
      if (usingForParams.length > 0) return usingForParams;

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

  private findCallExpressionStart(line: string, closeParenIdx: number): number | null {
    let depth = 0;
    for (let i = closeParenIdx; i >= 0; i--) {
      const ch = line[i];
      if (ch === ")") {
        depth++;
      } else if (ch === "(") {
        depth--;
        if (depth === 0) {
          let start = i;
          while (start > 0 && /\s/.test(line[start - 1])) start--;
          while (start > 0 && /[\w$.]/.test(line[start - 1])) start--;
          return start;
        }
      }
    }
    return null;
  }

  private extractExplicitTypeName(expression: string): string | undefined {
    const match = /^([A-Za-z_$][\w$.]*)\s*\(/.exec(expression);
    if (!match) return undefined;
    const candidate = match[1];
    return this.symbolIndex
      .findSymbols(candidate)
      .some((s) => s.kind === "contract" || s.kind === "interface")
      ? candidate
      : undefined;
  }

  private getUsingForParameterNames(
    funcName: string,
    receiver: ReceiverExpression,
    uri: string,
    lineNum: number,
    lineChar: number,
  ): string[] {
    const contract = this.getEnclosingContract(uri, lineNum);
    if (!contract) return [];

    const receiverType = this.resolveReceiverType(receiver, contract, uri, lineNum, lineChar);
    if (!receiverType) return [];

    for (const directive of contract.usingFor) {
      if (
        directive.typeName !== undefined &&
        !this.isSameTypeName(directive.typeName, receiverType)
      ) {
        continue;
      }

      const library = this.symbolIndex.getContract(directive.libraryName)?.contract;
      const fn = library?.functions.find((f) => f.name === funcName);
      if (!fn || fn.parameters.length === 0) continue;
      if (!this.isSameTypeName(fn.parameters[0].typeName, receiverType)) continue;

      return fn.parameters
        .slice(1)
        .map((p) => p.name)
        .filter((n): n is string => !!n);
    }

    return [];
  }

  private getEnclosingContract(uri: string, lineNum: number): ContractDefinition | undefined {
    const sourceUnit = this.parser.get(uri)?.sourceUnit;
    return sourceUnit?.contracts.find(
      (contract) => contract.range.start.line <= lineNum && lineNum <= contract.range.end.line,
    );
  }

  private resolveReceiverType(
    receiver: ReceiverExpression,
    contract: ContractDefinition,
    uri: string,
    lineNum: number,
    lineChar: number,
  ): string | undefined {
    if (receiver.explicitTypeName) return receiver.explicitTypeName;
    if (!receiver.simpleName) return undefined;

    const fn = this.getEnclosingFunction(contract, lineNum);
    const parameter = fn?.parameters.find((p) => p.name === receiver.simpleName);
    if (parameter) return parameter.typeName;

    const text = this.parser.getText(uri);
    if (text && fn) {
      const bodyPrefix = getFunctionBodyTextPrefix(
        text,
        fn.range.start.line,
        lineNum,
        lineChar,
      );
      if (bodyPrefix) {
        const localType = findLocalVariableType(bodyPrefix, receiver.simpleName);
        if (localType) return localType;
      }
    }

    const stateVariable = contract.stateVariables.find((v) => v.name === receiver.simpleName);
    return stateVariable?.typeName;
  }

  private getEnclosingFunction(
    contract: ContractDefinition,
    lineNum: number,
  ): FunctionDefinition | undefined {
    return contract.functions.find(
      (fn) => fn.range.start.line <= lineNum && lineNum <= fn.range.end.line,
    );
  }

  private isSameTypeName(left: string, right: string): boolean {
    return this.normalizeTypeName(left) === this.normalizeTypeName(right);
  }

  private normalizeTypeName(typeName: string): string {
    return typeName.replace(/\s+(memory|storage|calldata)\b/g, "").trim();
  }
}
