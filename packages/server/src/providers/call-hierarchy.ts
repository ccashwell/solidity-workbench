import type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  CancellationToken,
  Position,
  Range,
} from "vscode-languageserver/node.js";
import { SymbolKind } from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import * as fs from "node:fs";
import * as path from "node:path";
import { URI } from "vscode-uri";
import type { ContractDefinition, FunctionDefinition } from "@solidity-workbench/common";
import type { SymbolIndex } from "../analyzer/symbol-index.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";
import type { SolidityParser } from "../parser/solidity-parser.js";
import type { SolcBridge } from "../compiler/solc-bridge.js";
import { getWordAtPosition, CALL_LIKE_KEYWORDS, isSolidityBuiltinType } from "../utils/text.js";

const CALL_HIERARCHY_INDEX_BATCH_SIZE = 24;

/**
 * Call Hierarchy provider — traces call chains through the codebase.
 *
 * "Show Incoming Calls" → who calls this function?
 * "Show Outgoing Calls" → what does this function call?
 *
 * This is critical for understanding control flow in complex protocol code
 * where a single function may be called through multiple entry points
 * (routers, multicall, proxy delegates, etc.).
 *
 * Strategy:
 * 1. Build a call graph by scanning function bodies for identifier references
 * 2. Cross-reference with the symbol index to resolve call targets
 * 3. Walk the inheritance chain for virtual/override dispatch
 *
 * Without a full solc AST we can't do exact type inference, so when two
 * contracts define identically-named functions (e.g. ERC20 `transfer` on many
 * tokens) naïvely keying incoming calls by just the callee name produces
 * cross-contract contamination. We disambiguate by remembering the *receiver*
 * of each call (the identifier before the dot) and resolving it through the
 * enclosing function's parameters and the enclosing contract's state variables
 * back to a contract/interface-like type name. Filtering then happens at
 * lookup time against the target contract's name and its inheritance chain.
 */
export class CallHierarchyProvider {
  /**
   * calleeName → [site, ...].
   *
   * Kept keyed by bare callee name so cross-file matches still work; the
   * per-site `qualifier` field is what disambiguates which concrete
   * contract the call is dispatched on.
   */
  private incomingCalls: Map<string, CallSite[]> = new Map();
  /** callerFunction key (`<uri>#<name>`) → [site, ...] */
  private outgoingCalls: Map<string, CallSite[]> = new Map();

  private indexedFiles: Set<string> = new Set();
  private solcBridge: SolcBridge | null = null;
  private workspaceIndexPromise: Promise<void> | null = null;
  private reachableCache: Map<string, Set<string>> = new Map();
  private qualifierCache: Map<string, Set<string>> = new Map();
  private fileTextCache: Map<string, string | null> = new Map();

  constructor(
    private symbolIndex: SymbolIndex,
    private workspace: WorkspaceManager,
    private parser: SolidityParser,
  ) {}

  setSolcBridge(bridge: SolcBridge): void {
    this.solcBridge = bridge;
  }

  /**
   * Prepare: identify the function at the cursor position.
   */
  prepareCallHierarchy(document: TextDocument, position: Position): CallHierarchyItem[] {
    const text = document.getText();
    const word = getWordAtPosition(text, position)?.text ?? null;
    if (!word) return [];

    const symbols = this.symbolIndex.findSymbols(word);
    const funcSymbols = symbols.filter((s) => s.kind === "function" || s.kind === "modifier");

    if (funcSymbols.length === 0) return [];

    const symbolsAtCursor = funcSymbols.filter(
      (sym) =>
        sym.filePath === document.uri &&
        this.positionInRange(position, sym.nameRange.start, sym.nameRange.end),
    );
    const prepared = symbolsAtCursor.length > 0 ? symbolsAtCursor : funcSymbols;

    return prepared.map((sym) => ({
      name: sym.name,
      kind: sym.kind === "modifier" ? SymbolKind.Method : SymbolKind.Function,
      uri: sym.filePath,
      range: sym.range,
      selectionRange: sym.nameRange,
      detail: sym.containerName,
      data: this.makeKey(sym.filePath, sym.name, sym.containerName),
    }));
  }

  /**
   * Get incoming calls — who calls this function?
   *
   * Sites stored under the bare callee name are filtered by their recorded
   * qualifier against the target contract (item.detail) plus every contract
   * or interface in its inheritance chain. Unqualified sites are always
   * included because without type info we cannot prove they *don't* dispatch
   * to this target, and unqualified internal calls are the common case.
   */
  async getIncomingCalls(
    item: CallHierarchyItem,
    token?: CancellationToken,
  ): Promise<CallHierarchyIncomingCall[]> {
    await this.ensureIndexedForItem(item, "incoming", token);
    if (token?.isCancellationRequested) return [];

    const sites = this.incomingCalls.get(item.name) ?? [];
    const allowedQualifiers = this.computeAllowedQualifiers(item.detail);

    const callerMap = new Map<string, { item: CallHierarchyItem; ranges: Range[] }>();

    for (const site of sites) {
      if (site.target && !this.matchesTarget(site.target, item)) {
        continue;
      }
      if (site.qualifier && item.detail && !allowedQualifiers.has(site.qualifier)) {
        continue;
      }

      const callerKey = this.makeKey(site.callerUri, site.callerName, site.callerContainer);
      let entry = callerMap.get(callerKey);

      if (!entry) {
        const callerSymbols = this.symbolIndex.findSymbols(site.callerName);
        const callerSym =
          callerSymbols.find(
            (s) => s.filePath === site.callerUri && s.containerName === site.callerContainer,
          ) ??
          callerSymbols.find((s) => s.filePath === site.callerUri) ??
          callerSymbols[0];
        if (!callerSym) continue;

        entry = {
          item: {
            name: site.callerName,
            kind: SymbolKind.Function,
            uri: site.callerUri,
            range: callerSym.range,
            selectionRange: callerSym.nameRange,
            detail: callerSym.containerName,
            data: this.makeKey(callerSym.filePath, callerSym.name, callerSym.containerName),
          },
          ranges: [],
        };
        callerMap.set(callerKey, entry);
      }

      entry.ranges.push(site.callRange);
    }

    return Array.from(callerMap.values()).map((entry) => ({
      from: entry.item,
      fromRanges: entry.ranges,
    }));
  }

  /**
   * Get outgoing calls — what does this function call?
   */
  async getOutgoingCalls(
    item: CallHierarchyItem,
    token?: CancellationToken,
  ): Promise<CallHierarchyOutgoingCall[]> {
    await this.ensureIndexedForItem(item, "outgoing", token);
    if (token?.isCancellationRequested) return [];

    const key = this.makeKey(item.uri, item.name, item.detail);
    const sites = this.outgoingCalls.get(key) ?? [];

    // Group by callee function
    const calleeMap = new Map<string, { item: CallHierarchyItem; ranges: Range[] }>();

    for (const site of sites) {
      const calleeKey = site.target
        ? `${site.target.uri}:${site.target.containerName ?? ""}:${site.target.name}`
        : site.calleeName;
      let entry = calleeMap.get(calleeKey);

      if (!entry) {
        const calleeSym = site.target ?? this.resolveCalleeSymbol(site);
        if (!calleeSym) continue;

        entry = {
          item: {
            name: calleeSym.name,
            kind: SymbolKind.Function,
            uri: calleeSym.uri,
            range: calleeSym.range,
            selectionRange: calleeSym.selectionRange,
            detail: calleeSym.containerName,
            data: this.makeKey(calleeSym.uri, calleeSym.name, calleeSym.containerName),
          },
          ranges: [],
        };
        calleeMap.set(calleeKey, entry);
      }

      entry.ranges.push(site.callRange);
    }

    return Array.from(calleeMap.values()).map((entry) => ({
      to: entry.item,
      fromRanges: entry.ranges,
    }));
  }

  /**
   * Build the call graph by scanning all workspace files.
   */
  invalidateFile(uri: string): void {
    // Remove all call sites from/to this file
    for (const [key, sites] of this.incomingCalls) {
      const filtered = sites.filter((s) => s.callerUri !== uri);
      if (filtered.length > 0) this.incomingCalls.set(key, filtered);
      else this.incomingCalls.delete(key);
    }
    for (const [key] of this.outgoingCalls) {
      if (key.startsWith(uri + "#")) this.outgoingCalls.delete(key);
    }
    this.indexedFiles.delete(uri);
    this.reachableCache.clear();
    this.qualifierCache.clear();
    this.fileTextCache.delete(uri);
  }

  private async ensureIndexedForItem(
    item: CallHierarchyItem,
    mode: "incoming" | "outgoing",
    token?: CancellationToken,
  ): Promise<void> {
    await this.ensureIndexedUris(this.priorityUrisFor(item.uri, mode === "incoming"), token);
    if (token?.isCancellationRequested) return;

    if (mode === "outgoing") {
      this.queueWorkspaceIndex();
      return;
    }

    await this.ensureWorkspaceIndexed(token);
  }

  private queueWorkspaceIndex(): void {
    if (this.workspaceIndexPromise) return;
    this.workspaceIndexPromise = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.ensureIndexedUris(this.workspace.getAllFileUris()))
      .finally(() => {
        this.workspaceIndexPromise = null;
      });
  }

  private async ensureWorkspaceIndexed(token?: CancellationToken): Promise<void> {
    if (!this.workspaceIndexPromise) {
      this.workspaceIndexPromise = this.ensureIndexedUris(
        this.workspace.getAllFileUris(),
        token,
      ).finally(() => {
        this.workspaceIndexPromise = null;
      });
    }
    await this.workspaceIndexPromise;
  }

  private async ensureIndexedUris(uris: string[], token?: CancellationToken): Promise<void> {
    let indexedInBatch = 0;
    for (const uri of uris) {
      if (token?.isCancellationRequested) return;
      if (this.indexedFiles.has(uri)) continue;
      const text = this.getTextForUri(uri);
      if (text === null) {
        this.indexedFiles.add(uri);
        continue;
      }
      this.indexCallsInFile(uri, text);
      this.indexedFiles.add(uri);

      indexedInBatch++;
      if (indexedInBatch >= CALL_HIERARCHY_INDEX_BATCH_SIZE) {
        indexedInBatch = 0;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }

  private priorityUrisFor(uri: string, includeRest: boolean): string[] {
    const reachable = this.collectReachableUris(uri);
    const allUris = this.workspace.getAllFileUris();
    const ordered = [uri, ...reachable].filter((u, i, arr) => arr.indexOf(u) === i);
    if (!includeRest) return ordered;
    for (const candidate of allUris) {
      if (!reachable.has(candidate) && candidate !== uri) ordered.push(candidate);
    }
    return ordered;
  }

  /**
   * Compute the set of qualifier names that should be considered as matching
   * a target contract. This is the contract itself plus every base contract
   * and interface in its inheritance chain, so that e.g. a call recorded with
   * qualifier `IERC20` is still attributed to `MyToken.transfer` when
   * `MyToken is IERC20`.
   */
  private computeAllowedQualifiers(containerName: string | undefined): Set<string> {
    if (containerName && this.qualifierCache.has(containerName)) {
      return this.qualifierCache.get(containerName)!;
    }
    const allowed = new Set<string>();
    if (!containerName) return allowed;
    allowed.add(containerName);
    const chain = this.symbolIndex.getInheritanceChain(containerName);
    for (const base of chain) {
      if (base.name) allowed.add(base.name);
    }
    this.qualifierCache.set(containerName, allowed);
    return allowed;
  }

  /**
   * Index all function calls within a file by scanning function bodies.
   */
  private indexCallsInFile(uri: string, text: string): void {
    const result = this.parser.get(uri) ?? this.parser.parse(uri, text);
    const lines = text.split("\n");

    for (const contract of result.sourceUnit.contracts) {
      for (const func of contract.functions) {
        const callerName = func.name ?? func.kind;
        const callerKey = this.makeKey(uri, callerName, contract.name);

        const bodyRange = this.getFunctionBodyRange(text, func.range.start.line);
        if (!bodyRange) continue;

        // Start *after* the opening brace so the function's own signature
        // (which naturally contains `name(`) isn't mistaken for a recursive
        // self-call when the body lives on the same physical line as the
        // declaration.
        const firstLine = lines[bodyRange.bodyStartLine].slice(bodyRange.bodyStartChar);
        const restLines = lines.slice(bodyRange.bodyStartLine + 1, bodyRange.bodyEndLine + 1);
        const bodyText = restLines.length > 0 ? [firstLine, ...restLines].join("\n") : firstLine;

        // Capture group 1 = optional receiver identifier, group 2 = callee
        // name. Chained expressions (`a.b.c()`) are only partially handled —
        // the captured qualifier is the identifier immediately before the
        // dot, which is fine for the 95% case but would need solc's AST for
        // full accuracy.
        const callRe = /(?:\b([a-zA-Z_$][\w$]*)\s*\.\s*)?\b([a-zA-Z_$][\w$]*)\s*\(/g;
        let match: RegExpExecArray | null;

        while ((match = callRe.exec(bodyText)) !== null) {
          const rawQualifier = match[1];
          const calleeName = match[2];

          if (CALL_LIKE_KEYWORDS.has(calleeName)) continue;
          if (isSolidityBuiltinType(calleeName)) continue;

          const absoluteMatchStart = match.index + match[0].lastIndexOf(calleeName);
          const qualifier = this.resolveQualifier(
            rawQualifier,
            func,
            contract,
            bodyText.slice(0, absoluteMatchStart),
          );
          const precedingInBody = bodyText.slice(0, absoluteMatchStart);
          const newlinesBefore = (precedingInBody.match(/\n/g) ?? []).length;
          const callLine = bodyRange.bodyStartLine + newlinesBefore;
          const callCol =
            newlinesBefore === 0
              ? bodyRange.bodyStartChar + absoluteMatchStart
              : absoluteMatchStart - precedingInBody.lastIndexOf("\n") - 1;

          const callRange: Range = {
            start: { line: callLine, character: Math.max(0, callCol) },
            end: { line: callLine, character: Math.max(0, callCol) + calleeName.length },
          };
          const target = this.resolveSemanticCallTarget(uri, text, callRange);

          const outgoing = this.outgoingCalls.get(callerKey) ?? [];
          outgoing.push({
            calleeName,
            qualifier,
            callRange,
            callerUri: uri,
            callerName,
            callerContainer: contract.name,
            target,
          });
          this.outgoingCalls.set(callerKey, outgoing);

          const incoming = this.incomingCalls.get(calleeName) ?? [];
          incoming.push({
            calleeName,
            qualifier,
            callRange,
            callerUri: uri,
            callerName,
            callerContainer: contract.name,
            target,
          });
          this.incomingCalls.set(calleeName, incoming);
        }
      }
    }
  }

  private resolveSemanticCallTarget(
    uri: string,
    text: string,
    callRange: Range,
  ): CallTarget | undefined {
    if (!this.solcBridge) return undefined;
    const filePath = this.workspace.uriToPath(uri);
    const doc = TextDocument.create(uri, "solidity", 1, text);
    const ref = this.solcBridge.resolveReference(filePath, doc.offsetAt(callRange.start));
    if (!ref) return undefined;

    const targetUri = this.uriForPath(ref.filePath);
    const targetText = targetUri === uri ? text : this.getTextForPath(ref.filePath);
    if (targetText === null) return undefined;
    const targetDoc =
      targetUri === uri ? doc : TextDocument.create(targetUri, "solidity", 1, targetText);
    const start = targetDoc.positionAt(ref.offset);
    const end = targetDoc.positionAt(ref.offset + ref.length);

    for (const [, entry] of this.symbolIndex.getAllContracts()) {
      if (entry.uri !== targetUri) continue;
      for (const fn of entry.contract.functions) {
        if (!fn.name) continue;
        if (!this.rangeContains(fn.range, start, end)) continue;
        return {
          name: fn.name,
          uri: targetUri,
          range: fn.range,
          selectionRange: fn.nameRange,
          containerName: entry.contract.name,
        };
      }
      for (const mod of entry.contract.modifiers) {
        if (!this.rangeContains(mod.range, start, end)) continue;
        return {
          name: mod.name,
          uri: targetUri,
          range: mod.range,
          selectionRange: mod.nameRange,
          containerName: entry.contract.name,
        };
      }
    }
    return undefined;
  }

  private matchesTarget(target: CallTarget, item: CallHierarchyItem): boolean {
    return target.name === item.name && (!item.detail || target.containerName === item.detail);
  }

  /**
   * Best-effort mapping of a raw qualifier identifier (e.g. `a` in
   * `a.transfer()`) to a contract/interface-like type name.
   *
   * - `this` collapses to the enclosing contract (so `this.foo()` is still
   *   attributed to this contract and not to any same-named `foo` elsewhere).
   * - `super` collapses to the first declared base contract, which is where
   *   the dispatch starts for `super.foo()`.
   * - Parameter and state-variable references are resolved to their declared
   *   type names.
   * - Anything else (e.g. `MyLib` in `MyLib.foo()`) is returned verbatim and
   *   will match as long as it's a real contract/library name.
   */
  private resolveQualifier(
    rawQualifier: string | undefined,
    func: FunctionDefinition,
    contract: ContractDefinition,
    bodyPrefix: string,
  ): string | undefined {
    if (!rawQualifier) return undefined;

    if (rawQualifier === "this") {
      return contract.name.length > 0 ? contract.name : undefined;
    }
    if (rawQualifier === "super") {
      const firstBase = contract.baseContracts[0]?.baseName;
      return firstBase && firstBase.length > 0 ? firstBase : undefined;
    }

    for (const p of func.parameters) {
      if (p.name && p.name === rawQualifier) {
        return this.stripTypeDecorations(p.typeName) ?? rawQualifier;
      }
    }

    const localType = this.findLocalVariableType(bodyPrefix, rawQualifier);
    if (localType) return localType;

    for (const v of contract.stateVariables) {
      if (v.name === rawQualifier) {
        return this.stripTypeDecorations(v.typeName) ?? rawQualifier;
      }
    }

    return rawQualifier;
  }

  private findLocalVariableType(bodyPrefix: string, name: string): string | undefined {
    const escapedName = escapeRegExp(name);
    const declarationRe = new RegExp(
      String.raw`(?:^|[;{}\n])\s*([A-Za-z_$][\w$]*(?:\s*\[[^\]]*\])*)\s+(?:(?:memory|storage|calldata)\s+)?${escapedName}\b`,
      "g",
    );
    let match: RegExpExecArray | null;
    let typeName: string | undefined;
    while ((match = declarationRe.exec(bodyPrefix)) !== null) {
      typeName = this.stripTypeDecorations(match[1]);
    }
    return typeName;
  }

  private resolveCalleeSymbol(site: CallSite): CallTarget | undefined {
    const candidates = this.symbolIndex
      .findSymbols(site.calleeName)
      .filter((sym) => sym.kind === "function" || sym.kind === "modifier");
    if (candidates.length === 0) return undefined;

    const visible = this.filterVisibleSymbols(site.callerUri, candidates);
    const pool = visible.length > 0 ? visible : candidates;

    if (site.qualifier) {
      const allowed = this.computeAllowedQualifiers(site.qualifier);
      const qualified = pool.find((sym) => sym.containerName && allowed.has(sym.containerName));
      if (qualified) return this.symbolToTarget(qualified);
    }

    const local = pool.find(
      (sym) => sym.filePath === site.callerUri && sym.containerName === site.callerContainer,
    );
    if (local) return this.symbolToTarget(local);

    return this.symbolToTarget(pool[0]);
  }

  private symbolToTarget(sym: {
    name: string;
    filePath: string;
    range: Range;
    nameRange: Range;
    containerName?: string;
  }): CallTarget {
    return {
      name: sym.name,
      uri: sym.filePath,
      range: sym.range,
      selectionRange: sym.nameRange,
      containerName: sym.containerName,
    };
  }

  private filterVisibleSymbols<T extends { filePath: string }>(
    callerUri: string,
    symbols: T[],
  ): T[] {
    const resolveImport = (this.workspace as Partial<WorkspaceManager>).resolveImport;
    if (!resolveImport) return symbols;
    const reachable = this.collectReachableUris(callerUri);
    return symbols.filter((sym) => reachable.has(sym.filePath));
  }

  private collectReachableUris(
    uri: string,
    visited: Set<string> = new Set(),
    rootUri: string = uri,
  ): Set<string> {
    if (uri === rootUri && visited.size === 0) {
      const cached = this.reachableCache.get(uri);
      if (cached) return cached;
    }
    if (visited.has(uri)) return visited;
    visited.add(uri);

    const resolveImport = (this.workspace as Partial<WorkspaceManager>).resolveImport;
    if (!resolveImport) return visited;

    const result = this.parser.get(uri);
    if (!result) return visited;

    let fsPath: string;
    try {
      fsPath = this.workspace.uriToPath(uri);
    } catch {
      return visited;
    }

    for (const imp of result.sourceUnit.imports) {
      const targetPath = resolveImport.call(this.workspace, imp.path, fsPath);
      if (!targetPath) continue;
      this.collectReachableUris(URI.file(targetPath).toString(), visited, rootUri);
    }

    if (uri === rootUri) {
      this.reachableCache.set(rootUri, new Set(visited));
    }
    return visited;
  }

  /**
   * Reduce a declared type name to its underlying contract-like identifier by
   * stripping array suffixes and trailing location / mutability keywords.
   * E.g. `A[] memory` → `A`, `IPool[3] calldata` → `IPool`.
   */
  private stripTypeDecorations(typeName: string | undefined): string | undefined {
    if (!typeName) return undefined;
    let t = typeName.trim();
    while (/\[[^\]]*\]\s*$/.test(t)) {
      t = t.replace(/\s*\[[^\]]*\]\s*$/, "").trim();
    }
    t = t.replace(/\s+(memory|storage|calldata|payable)$/, "").trim();
    return t.length > 0 ? t : undefined;
  }

  private rangeContains(range: Range, start: Position, end: Position): boolean {
    const startsBefore =
      range.start.line < start.line ||
      (range.start.line === start.line && range.start.character <= start.character);
    const endsAfter =
      range.end.line > end.line ||
      (range.end.line === end.line && range.end.character >= end.character);
    return startsBefore && endsAfter;
  }

  private positionInRange(position: Position, start: Position, end: Position): boolean {
    const startsBefore =
      start.line < position.line ||
      (start.line === position.line && start.character <= position.character);
    const endsAfter =
      end.line > position.line ||
      (end.line === position.line && end.character >= position.character);
    return startsBefore && endsAfter;
  }

  private uriForPath(filePath: string): string {
    return URI.file(this.absolutePath(filePath)).toString();
  }

  private getTextForUri(uri: string): string | null {
    const cachedText = this.parser.getText(uri);
    if (cachedText !== undefined) return cachedText;
    const cached = this.fileTextCache.get(uri);
    if (cached !== undefined) return cached;
    let filePath: string;
    try {
      filePath = this.workspace.uriToPath(uri);
    } catch {
      this.fileTextCache.set(uri, null);
      return null;
    }
    const text = this.readFile(filePath);
    this.fileTextCache.set(uri, text);
    return text;
  }

  private getTextForPath(filePath: string): string | null {
    const uri = this.uriForPath(filePath);
    return this.getTextForUri(uri);
  }

  private readFile(filePath: string): string | null {
    try {
      return fs.readFileSync(this.absolutePath(filePath), "utf-8");
    } catch {
      return null;
    }
  }

  private absolutePath(filePath: string): string {
    if (path.isAbsolute(filePath)) return filePath;
    const root = (this.workspace as { root?: string }).root ?? process.cwd();
    return path.join(root, filePath);
  }

  private getFunctionBodyRange(
    text: string,
    funcStartLine: number,
  ): { bodyStartLine: number; bodyStartChar: number; bodyEndLine: number } | null {
    const lines = text.split("\n");
    let braceDepth = 0;
    let foundOpen = false;
    let bodyStartLine = funcStartLine;
    let bodyStartChar = 0;

    for (let i = funcStartLine; i < lines.length; i++) {
      const line = lines[i];
      for (let j = 0; j < line.length; j++) {
        const ch = line[j];
        if (ch === "{") {
          if (!foundOpen) {
            foundOpen = true;
            bodyStartLine = i;
            bodyStartChar = j + 1;
          }
          braceDepth++;
        } else if (ch === "}") {
          braceDepth--;
          if (foundOpen && braceDepth === 0) {
            return { bodyStartLine, bodyStartChar, bodyEndLine: i };
          }
        }
      }
      // If we hit a semicolon before opening brace, it's an interface function
      if (!foundOpen && line.includes(";")) return null;
    }

    return null;
  }

  private makeKey(uri: string, name: string, containerName?: string): string {
    return `${uri}#${containerName ?? ""}#${name}`;
  }
}

interface CallSite {
  calleeName: string;
  /**
   * Resolved contract/interface-like type of the call receiver, or undefined
   * for unqualified calls. Variable-name qualifiers are mapped through the
   * enclosing function's parameters and the enclosing contract's state
   * variables; `this` maps to the enclosing contract, `super` to the first
   * declared base contract.
   */
  qualifier?: string;
  callRange: Range;
  callerUri: string;
  callerName: string;
  callerContainer?: string;
  target?: CallTarget;
}

interface CallTarget {
  name: string;
  uri: string;
  range: Range;
  selectionRange: Range;
  containerName?: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
