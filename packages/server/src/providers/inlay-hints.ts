import type { InlayHint, Range } from "vscode-languageserver/node.js";
import { InlayHintKind } from "vscode-languageserver/node.js";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type { ContractDefinition } from "@solidity-workbench/common";
import type { SymbolIndex } from "../analyzer/symbol-index.js";
import type { SemanticResolver } from "../analyzer/semantic-resolver.js";
import type { SolidityParser } from "../parser/solidity-parser.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";
import { URI } from "vscode-uri";
import { resolveReceiverTypeName, type ReceiverExpression } from "../utils/receiver-type.js";
import { usingForParameterNames } from "../utils/using-for.js";
import { getEnclosingContract } from "../utils/scope.js";
import {
  extractDottedReceiver,
  CALL_LIKE_KEYWORDS,
  findCommentRanges,
  isPositionInCommentRanges,
} from "../utils/text.js";

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
    private resolver?: SemanticResolver,
    private workspace?: WorkspaceManager,
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

    const dottedPath = extractDottedReceiver(line, funcNameStart);
    if (dottedPath) {
      const tail = dottedPath.includes(".") ? dottedPath.split(".").pop() : dottedPath;
      return { dottedPath, simpleName: tail };
    }

    let end = dotIdx;
    while (end > 0 && /\s/.test(line[end - 1])) end--;

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
   *   - `Receiver.funcName(...)` where `Receiver` or its declared
   *     type resolves to a contract / interface / library: walk its
   *     import-aware inheritance chain and return the matching
   *     function's parameter names.
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
      const receiverSymbols = receiverName ? this.findVisibleSymbols(uri, receiverName) : [];
      const receiverTypeName = resolveReceiverTypeName(
        this.parser,
        this.symbolIndex,
        uri,
        {
          line: lineNum,
          character: lineChar,
        },
        receiver,
      );
      if (
        receiverSymbols.some((s) => s.kind === "userDefinedValueType") ||
        (receiverTypeName && this.isUserDefinedValueType(uri, receiverTypeName))
      ) {
        return [];
      }

      const memberContainerName =
        receiver.explicitTypeName ??
        (receiverName && receiverSymbols.some((s) => this.isContractLike(s.kind))
          ? receiverName
          : undefined) ??
        receiverTypeName;
      if (memberContainerName) {
        const chain = this.getVisibleInheritanceChain(memberContainerName, uri);
        for (const c of chain) {
          const fn = c.functions.find((f) => f.name === funcName);
          if (fn) {
            return fn.parameters.map((p) => p.name).filter((n): n is string => !!n);
          }
        }
      }

      const usingForParams = usingForParameterNames(
        this.parser,
        this.symbolIndex,
        uri,
        this.getEnclosingContract(uri, lineNum),
        receiverTypeName ?? "",
        funcName,
        this.resolver,
      );
      if (usingForParams.length > 0) return usingForParams;

      // Receiver specified but not resolvable to a known type —
      // refuse to guess.
      return [];
    }

    // Unqualified call — scope to the enclosing contract (and its bases)
    // or same-file free functions. A global `findSymbols` pick would
    // surface the wrong overload when unrelated contracts share a name
    // (e.g. `_open(equity)` vs `_open(params)`).
    const sourceUnit = this.parser.get(uri)?.sourceUnit;
    if (!sourceUnit) return [];

    const contract = getEnclosingContract(sourceUnit, lineNum);
    if (contract) {
      const resolved = this.resolver?.resolveContract(contract.name, uri);
      const chain = resolved
        ? (this.resolver?.getInheritanceChainFor(resolved).map((entry) => entry.contract) ?? [])
        : this.getVisibleInheritanceChain(contract.name, uri);
      for (const c of chain) {
        const fn = c.functions.find((f) => f.name === funcName);
        if (fn) {
          return fn.parameters.map((p) => p.name).filter((n): n is string => !!n);
        }
      }
    }

    const freeFn = sourceUnit.freeFunctions.find((f) => f.name === funcName);
    if (freeFn) {
      return freeFn.parameters.map((p) => p.name).filter((n): n is string => !!n);
    }

    return [];
  }

  private findVisibleSymbols(uri: string, name: string) {
    const symbols = this.symbolIndex.findSymbols(name);
    if (this.resolver) return this.resolver.filterVisibleSymbols(uri, symbols);
    if (!this.workspace) return symbols.filter((sym) => sym.filePath === uri);
    const reachable = this.collectReachableUris(uri);
    return symbols.filter((sym) => reachable.has(sym.filePath));
  }

  private getVisibleInheritanceChain(typeName: string, uri: string) {
    if (!this.resolver) {
      return this.getParserInheritanceChain(typeName, uri).map((entry) => entry.contract);
    }

    const imported = this.resolver.resolveImportedSymbol(typeName, uri);
    if (imported) return this.resolver.getInheritanceChain(typeName, uri).map((e) => e.contract);

    const symbols = this.resolver.filterVisibleSymbols(
      uri,
      this.symbolIndex.findSymbols(typeName).filter((symbol) => this.isContractLike(symbol.kind)),
    );
    const sym = symbols.find((candidate) => candidate.filePath === uri) ?? symbols[0];
    const resolved = sym ? this.resolver.resolveContract(sym.name, sym.filePath) : undefined;
    return resolved ? this.resolver.getInheritanceChainFor(resolved).map((e) => e.contract) : [];
  }

  private collectReachableUris(uri: string, visited: Set<string> = new Set()): Set<string> {
    if (visited.has(uri)) return visited;
    visited.add(uri);
    if (!this.workspace) return visited;

    const result = this.parser.get(uri);
    if (!result) return visited;

    let fsPath: string;
    try {
      fsPath = this.workspace.uriToPath(uri);
    } catch {
      return visited;
    }

    for (const imp of result.sourceUnit.imports) {
      let targetPath: string | null;
      try {
        targetPath = this.workspace.resolveImport(imp.path, fsPath);
      } catch {
        targetPath = null;
      }
      if (!targetPath) continue;
      this.collectReachableUris(URI.file(targetPath).toString(), visited);
    }

    return visited;
  }

  private getParserInheritanceChain(
    typeName: string,
    uri: string,
  ): Array<{ uri: string; contract: ContractDefinition }> {
    const root = this.resolveParserVisibleContract(typeName, uri);
    if (!root) return [];

    const chain: Array<{ uri: string; contract: ContractDefinition }> = [];
    const visited = new Set<string>();

    const walk = (entry: { uri: string; contract: ContractDefinition }): void => {
      const key = `${entry.uri}#${entry.contract.name}`;
      if (visited.has(key)) return;
      visited.add(key);
      chain.push(entry);

      for (const base of entry.contract.baseContracts) {
        const baseEntry = this.resolveParserVisibleContract(base.baseName, entry.uri);
        if (baseEntry) walk(baseEntry);
      }
    };

    walk(root);
    return chain;
  }

  private resolveParserVisibleContract(
    typeName: string,
    uri: string,
  ): { uri: string; contract: ContractDefinition } | undefined {
    const local = this.symbolIndex.getContract(typeName, uri);
    if (local) return local;

    return this.resolveParserImportedContract(typeName, uri);
  }

  private resolveParserImportedContract(
    typeName: string,
    uri: string,
  ): { uri: string; contract: ContractDefinition } | undefined {
    if (!this.workspace) return undefined;

    const sourceUnit = this.parser.get(uri)?.sourceUnit;
    if (!sourceUnit) return undefined;

    let fromPath: string;
    try {
      fromPath = this.workspace.uriToPath(uri);
    } catch {
      return undefined;
    }

    const scoped = typeName.includes(".") ? typeName.split(".") : null;
    for (const imp of sourceUnit.imports) {
      let targetPath: string | null;
      try {
        targetPath = this.workspace.resolveImport(imp.path, fromPath);
      } catch {
        targetPath = null;
      }
      if (!targetPath) continue;
      const targetUri = URI.file(targetPath).toString();

      if (scoped && imp.unitAlias === scoped[0] && scoped[1]) {
        return this.symbolIndex.getContract(scoped[1], targetUri);
      }

      if (scoped) continue;
      for (const alias of imp.symbolAliases ?? []) {
        const visibleName = alias.alias ?? alias.symbol;
        if (visibleName !== typeName) continue;
        return this.symbolIndex.getContract(alias.symbol, targetUri);
      }

      if (!imp.unitAlias && (imp.symbolAliases ?? []).length === 0) {
        const imported = this.symbolIndex.getContract(typeName, targetUri);
        if (imported) return imported;
      }
    }

    return undefined;
  }

  private isContractLike(kind: string): boolean {
    return kind === "contract" || kind === "interface" || kind === "library";
  }

  private isUserDefinedValueType(uri: string, typeName: string): boolean {
    return this.findVisibleSymbols(uri, typeName).some((s) => s.kind === "userDefinedValueType");
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

  private getEnclosingContract(uri: string, lineNum: number) {
    const sourceUnit = this.parser.get(uri)?.sourceUnit;
    if (!sourceUnit) return undefined;
    return getEnclosingContract(sourceUnit, lineNum);
  }
}
