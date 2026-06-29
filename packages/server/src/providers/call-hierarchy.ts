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
import type {
  ContractDefinition,
  FunctionDefinition,
  ModifierDefinition,
} from "@solidity-workbench/common";
import type { SymbolIndex } from "../analyzer/symbol-index.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";
import type { SolidityParser } from "../parser/solidity-parser.js";
import type { SolcBridge } from "../compiler/solc-bridge.js";
import type { SemanticResolver } from "../analyzer/semantic-resolver.js";
import type { GraphIndex, SolidityGraphNode } from "../analyzer/graph-index.js";
import {
  getWordAtPosition,
  CALL_LIKE_KEYWORDS,
  findCommentRanges,
  isInsideString,
  isPositionInCommentRanges,
  isSolidityBuiltinType,
} from "../utils/text.js";
import { resolveDottedReceiverTypeInfo } from "../utils/receiver-type.js";

const CALL_HIERARCHY_INDEX_BATCH_SIZE = 24;

/**
 * Maximum number of files for which we keep the raw source text in
 * `fileTextCache`. Texts referenced via solc declaration resolution
 * (`getTextForPath`) get cached so we don't re-read the same file from
 * disk on every call hierarchy query, but unbounded growth was a real
 * problem on long-running editor sessions: every dependency file ever
 * referenced stayed resident in V8's heap, and the cache slowly grew
 * to dwarf the per-uri parser cache. 256 is large enough to cover the
 * working set of any reasonable interactive session and small enough
 * that even pessimistic 100KB-per-file averages cap us at ~25MB.
 */
const FILE_TEXT_CACHE_LIMIT = 256;

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

  /**
   * Inverse index over `incomingCalls`: maps a file URI to the set of
   * callee names referenced anywhere in that file. Without this, every
   * keystroke in any document triggered an O(workspace_callee_names)
   * scan of `incomingCalls` to evict that file's stale sites — a cost
   * that grew unboundedly as more of the dependency tree got indexed.
   * With it, `invalidateFile` only iterates the names this file
   * actually mentioned, which is typically a few dozen even in large
   * files.
   */
  private incomingByFile: Map<string, Set<string>> = new Map();
  /**
   * Inverse index over `outgoingCalls`: per-file list of caller keys
   * indexed from this file. Lets us delete only those keys instead of
   * scanning every entry in `outgoingCalls`.
   */
  private outgoingByFile: Map<string, Set<string>> = new Map();

  private indexedFiles: Set<string> = new Set();
  private solcBridge: SolcBridge | null = null;
  private workspaceIndexPromise: Promise<void> | null = null;
  private reachableCache: Map<string, Set<string>> = new Map();
  private qualifierCache: Map<string, Set<string>> = new Map();
  /**
   * LRU bounded by {@link FILE_TEXT_CACHE_LIMIT}. We use insertion-
   * order semantics: every `set` and every `get` re-inserts the entry
   * to mark it most-recently-used, and on overflow we evict the
   * oldest. `Map.delete` + `Map.set` is O(1) and Maps preserve
   * insertion order, so this needs no extra bookkeeping.
   */
  private fileTextCache: Map<string, string | null> = new Map();

  constructor(
    private symbolIndex: SymbolIndex,
    private workspace: WorkspaceManager,
    private parser: SolidityParser,
    private resolver?: SemanticResolver,
    private graphIndex?: GraphIndex,
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

    const symbols = this.filterVisibleSymbols(document.uri, this.symbolIndex.findSymbols(word));
    const funcSymbols = symbols.filter((s) => this.isCallHierarchySymbolKind(s.kind));

    if (funcSymbols.length === 0) return [];

    const symbolsAtCursor = funcSymbols.filter(
      (sym) =>
        sym.filePath === document.uri &&
        this.positionInRange(position, sym.nameRange.start, sym.nameRange.end),
    );
    const prepared = symbolsAtCursor.length > 0 ? symbolsAtCursor : funcSymbols;

    return prepared.map((sym) => ({
      name: sym.name,
      kind: this.symbolKindToCallHierarchyKind(sym.kind),
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
    const graphCalls = await this.getGraphIncomingCalls(item, token);
    if (graphCalls) return graphCalls;

    await this.ensureIndexedForItem(item, "incoming", token);
    if (token?.isCancellationRequested) return [];

    const sites = this.incomingCalls.get(item.name) ?? [];
    const allowedQualifiers = this.computeAllowedQualifiers(item.detail, item.uri);

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
    const graphCalls = this.getGraphOutgoingCalls(item);
    if (graphCalls) return graphCalls;

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
            kind: this.symbolKindToCallHierarchyKind(calleeSym.kind),
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

  private async getGraphIncomingCalls(
    item: CallHierarchyItem,
    token?: CancellationToken,
  ): Promise<CallHierarchyIncomingCall[] | null> {
    if (token?.isCancellationRequested) return [];
    if (!this.graphIndex) return null;
    const target = this.findGraphCallableNode(item);
    if (!target) return null;

    await this.drainGraphRelationships(token);
    if (token?.isCancellationRequested) return [];

    const callerMap = new Map<string, { item: CallHierarchyItem; ranges: Range[] }>();
    for (const edgeKind of this.graphIncomingEdgeKinds(target)) {
      for (const edge of this.graphIndex!.getIncomingEdges(target.id, edgeKind)) {
        if (!edge.range) continue;
        const source = this.graphIndex!.getNode(edge.source);
        if (!source || !this.isCallHierarchySourceNode(source)) continue;

        const existing = callerMap.get(source.id);
        if (existing) {
          existing.ranges.push(edge.range);
          continue;
        }

        callerMap.set(source.id, {
          item: this.graphNodeToCallHierarchyItem(source),
          ranges: [edge.range],
        });
      }
    }

    return Array.from(callerMap.values()).map((entry) => ({
      from: entry.item,
      fromRanges: entry.ranges,
    }));
  }

  private async drainGraphRelationships(token?: CancellationToken): Promise<void> {
    if (!this.graphIndex || this.graphIndex.isRelationshipIndexComplete()) return;

    let batch = this.graphIndex.indexRelationshipBatch(50, 50);
    while (!batch.complete && !token?.isCancellationRequested) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      batch = this.graphIndex.indexRelationshipBatch(50, 50);
    }
  }

  private getGraphOutgoingCalls(item: CallHierarchyItem): CallHierarchyOutgoingCall[] | null {
    this.graphIndex?.ensureFileRelationships(item.uri);
    const source = this.findGraphCallableNode(item);
    if (!source) return null;

    const calleeMap = new Map<string, { item: CallHierarchyItem; ranges: Range[] }>();
    for (const edgeKind of ["calls", "emits", "revertsWith"] as const) {
      for (const edge of this.graphIndex!.getOutgoingEdges(source.id, edgeKind)) {
        if (!edge.range) continue;
        const target = this.graphIndex!.getNode(edge.target);
        if (!target || !this.isCallHierarchyTargetNode(target)) continue;

        const existing = calleeMap.get(target.id);
        if (existing) {
          existing.ranges.push(edge.range);
          continue;
        }

        calleeMap.set(target.id, {
          item: this.graphNodeToCallHierarchyItem(target),
          ranges: [edge.range],
        });
      }
    }

    return Array.from(calleeMap.values()).map((entry) => ({
      to: entry.item,
      fromRanges: entry.ranges,
    }));
  }

  private findGraphCallableNode(item: CallHierarchyItem): SolidityGraphNode | undefined {
    if (!this.graphIndex) return undefined;
    return this.graphIndex
      .getNodes()
      .find(
        (node) =>
          this.isCallHierarchyTargetNode(node) &&
          node.uri === item.uri &&
          node.name === item.name &&
          (!item.detail || node.containerName === item.detail),
      );
  }

  private graphNodeToCallHierarchyItem(node: SolidityGraphNode): CallHierarchyItem {
    return {
      name: node.name,
      kind: this.graphNodeKindToCallHierarchyKind(node.kind),
      uri: node.uri,
      range: node.range,
      selectionRange: node.selectionRange,
      detail: node.containerName,
      data: this.makeKey(node.uri, node.name, node.containerName),
    };
  }

  private isCallHierarchySourceNode(node: SolidityGraphNode): boolean {
    return (
      node.kind === "function" ||
      node.kind === "constructor" ||
      node.kind === "receive" ||
      node.kind === "fallback" ||
      node.kind === "modifier" ||
      node.kind === "stateVariable"
    );
  }

  private isCallHierarchyTargetNode(node: SolidityGraphNode): boolean {
    return this.isCallHierarchySourceNode(node) || node.kind === "event" || node.kind === "error";
  }

  private graphIncomingEdgeKinds(node: SolidityGraphNode): ("calls" | "emits" | "revertsWith")[] {
    if (node.kind === "event") return ["emits"];
    if (node.kind === "error") return ["revertsWith"];
    return ["calls"];
  }

  private isCallHierarchySymbolKind(kind: string): boolean {
    return (
      kind === "function" ||
      kind === "modifier" ||
      kind === "stateVariable" ||
      kind === "event" ||
      kind === "error"
    );
  }

  private symbolKindToCallHierarchyKind(kind: string | undefined): SymbolKind {
    return kind === "stateVariable"
      ? SymbolKind.Field
      : kind === "event"
        ? SymbolKind.Event
        : kind === "error"
          ? SymbolKind.Struct
          : kind === "modifier"
            ? SymbolKind.Method
            : SymbolKind.Function;
  }

  private graphNodeKindToCallHierarchyKind(kind: SolidityGraphNode["kind"]): SymbolKind {
    return kind === "stateVariable"
      ? SymbolKind.Field
      : kind === "event"
        ? SymbolKind.Event
        : kind === "error"
          ? SymbolKind.Struct
          : kind === "modifier"
            ? SymbolKind.Method
            : SymbolKind.Function;
  }

  /**
   * Drop every cached call site that originated from `uri`.
   *
   * Called from `documents.onDidChangeContent`, which fires on every
   * keystroke, so this MUST be O(callees-referenced-in-this-file)
   * rather than O(total-callees-in-workspace). The previous
   * implementation walked every entry in `incomingCalls` and rebuilt
   * its array, which became the dominant per-keystroke cost on
   * sessions where the dependency tree (forge-std, OpenZeppelin,
   * project libraries) had been indexed.
   *
   * The `incomingByFile` / `outgoingByFile` inverse indexes record
   * exactly which entries to touch, so this work scales with the file
   * rather than the workspace.
   */
  invalidateFile(uri: string): void {
    const incomingNames = this.incomingByFile.get(uri);
    if (incomingNames) {
      for (const calleeName of incomingNames) {
        const sites = this.incomingCalls.get(calleeName);
        if (!sites) continue;
        const filtered = sites.filter((s) => s.callerUri !== uri);
        if (filtered.length === sites.length) continue;
        if (filtered.length > 0) this.incomingCalls.set(calleeName, filtered);
        else this.incomingCalls.delete(calleeName);
      }
      this.incomingByFile.delete(uri);
    }

    const outgoingKeys = this.outgoingByFile.get(uri);
    if (outgoingKeys) {
      for (const key of outgoingKeys) this.outgoingCalls.delete(key);
      this.outgoingByFile.delete(uri);
    }

    this.indexedFiles.delete(uri);
    // Reachability is rooted at this file's import list; drop only the
    // entry that depends on this file's contents. Reach sets that
    // include this URI but are rooted elsewhere are unaffected by
    // edits to this file's body. (If imports were added or removed,
    // those reach sets become slightly stale until the user navigates
    // through the relevant file — an acceptable trade-off given the
    // alternative is wiping every cached reach set on every keystroke.)
    this.reachableCache.delete(uri);
    // Qualifier cache is keyed by container name and depends on the
    // inheritance chain owned by the symbol index. Edits that change
    // a contract's `is ...` clause invalidate it; we can't cheaply
    // tell whether the current edit was such a change, so a cache-
    // wide wipe is the conservative choice. The cache typically has
    // a handful of entries (one per contract a user has invoked call-
    // hierarchy on), so `clear` is microseconds — unlike the prior
    // O(workspace) loop over `incomingCalls`, this isn't the cost
    // we were trying to dodge.
    this.qualifierCache.clear();
    this.fileTextCache.delete(uri);
    this.resolver?.invalidate(uri);
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
  private computeAllowedQualifiers(
    containerName: string | undefined,
    fromUri: string,
  ): Set<string> {
    const cacheKey = containerName ? `${fromUri}\0${containerName}` : "";
    if (containerName && this.qualifierCache.has(cacheKey)) {
      return this.qualifierCache.get(cacheKey)!;
    }
    const allowed = new Set<string>();
    if (!containerName) return allowed;
    allowed.add(containerName);
    const chain = this.resolver?.getInheritanceChain(containerName, fromUri) ?? [];
    if (chain.length > 0) {
      for (const base of chain) {
        if (base.contract.name) allowed.add(base.contract.name);
      }
    } else {
      for (const base of this.symbolIndex.getInheritanceChain(containerName)) {
        if (base.name) allowed.add(base.name);
      }
    }
    this.qualifierCache.set(cacheKey, allowed);
    return allowed;
  }

  /**
   * Index all function calls within a file by scanning function bodies.
   */
  private indexCallsInFile(uri: string, text: string): void {
    const result = this.parser.get(uri) ?? this.parser.parse(uri, text);
    const lines = text.split("\n");
    const commentRanges = findCommentRanges(text);

    // Track which callee names and caller keys this file owns so
    // `invalidateFile` can drop them in O(file) instead of scanning
    // the whole workspace map.
    let fileIncomingNames = this.incomingByFile.get(uri);
    if (!fileIncomingNames) {
      fileIncomingNames = new Set();
      this.incomingByFile.set(uri, fileIncomingNames);
    }
    let fileOutgoingKeys = this.outgoingByFile.get(uri);
    if (!fileOutgoingKeys) {
      fileOutgoingKeys = new Set();
      this.outgoingByFile.set(uri, fileOutgoingKeys);
    }

    for (const contract of result.sourceUnit.contracts) {
      for (const func of contract.functions) {
        this.indexCallsInFunction({
          uri,
          text,
          lines,
          commentRanges,
          func,
          callerContainer: contract.name,
          contract,
          fileIncomingNames,
          fileOutgoingKeys,
        });
      }

      for (const mod of contract.modifiers) {
        this.indexCallsInFunction({
          uri,
          text,
          lines,
          commentRanges,
          func: mod,
          callerContainer: contract.name,
          contract,
          fileIncomingNames,
          fileOutgoingKeys,
        });
      }
    }

    for (const func of result.sourceUnit.freeFunctions) {
      this.indexCallsInFunction({
        uri,
        text,
        lines,
        commentRanges,
        func,
        callerContainer: undefined,
        contract: undefined,
        fileIncomingNames,
        fileOutgoingKeys,
      });
    }
  }

  private indexCallsInFunction({
    uri,
    text,
    lines,
    commentRanges,
    func,
    callerContainer,
    contract,
    fileIncomingNames,
    fileOutgoingKeys,
  }: {
    uri: string;
    text: string;
    lines: string[];
    commentRanges: Map<number, Array<[number, number]>>;
    func: FunctionDefinition | ModifierDefinition;
    callerContainer: string | undefined;
    contract: ContractDefinition | undefined;
    fileIncomingNames: Set<string>;
    fileOutgoingKeys: Set<string>;
  }): void {
    const callerName = this.callableName(func);

    const bodyRange = this.getFunctionBodyRange(text, func.range.start.line, commentRanges);
    if (!bodyRange) return;

    if (func.type === "FunctionDefinition" && contract) {
      this.indexModifierInvocations({
        uri,
        lines,
        commentRanges,
        func,
        bodyRange,
        contract,
        callerName,
        callerContainer,
        fileIncomingNames,
        fileOutgoingKeys,
      });
    }

    // Start *after* the opening brace so the function's own signature
    // (which naturally contains `name(`) isn't mistaken for a recursive
    // self-call when the body lives on the same physical line as the
    // declaration.
    const firstLine = lines[bodyRange.bodyStartLine].slice(bodyRange.bodyStartChar);
    const restLines = lines.slice(bodyRange.bodyStartLine + 1, bodyRange.bodyEndLine + 1);
    const bodyText = restLines.length > 0 ? [firstLine, ...restLines].join("\n") : firstLine;

    // Pre-compute the position of every newline in `bodyText` once,
    // so each call match can resolve to (line, column) via a binary
    // search instead of regex-scanning the prefix per match. The
    // prior `bodyText.slice(0, idx).match(/\n/g)` pattern was
    // O(call_sites × body_length), which dominated the file-index
    // pass on dense bodies.
    const newlineOffsets: number[] = [];
    for (let i = 0; i < bodyText.length; i++) {
      if (bodyText.charCodeAt(i) === 10) newlineOffsets.push(i);
    }

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
      // Binary-search the precomputed newline offsets to locate
      // (line, column) for `absoluteMatchStart`. `newlinesBefore`
      // is the count of newlines strictly before the offset; the
      // start-of-current-line is the offset just past the last
      // newline (or 0 on the first line of the body).
      const newlinesBefore = countNewlinesBefore(newlineOffsets, absoluteMatchStart);
      const lineStartOffset = newlinesBefore === 0 ? 0 : newlineOffsets[newlinesBefore - 1] + 1;
      const callLine = bodyRange.bodyStartLine + newlinesBefore;
      const callCol =
        newlinesBefore === 0
          ? bodyRange.bodyStartChar + absoluteMatchStart
          : absoluteMatchStart - lineStartOffset;

      if (isPositionInCommentRanges(commentRanges, callLine, callCol)) continue;
      if (isInsideString(lines[callLine] ?? "", callCol)) continue;

      const callRange: Range = {
        start: { line: callLine, character: Math.max(0, callCol) },
        end: { line: callLine, character: Math.max(0, callCol) + calleeName.length },
      };
      const qualifier = this.resolveQualifier(rawQualifier, uri, contract, callRange.start);
      const target = this.resolveSemanticCallTarget(uri, text, callRange);

      this.recordCallSite({
        calleeName,
        qualifier,
        callRange,
        callerUri: uri,
        callerName,
        callerContainer,
        target,
        fileIncomingNames,
        fileOutgoingKeys,
      });
    }
  }

  private callableName(func: FunctionDefinition | ModifierDefinition): string {
    return func.type === "FunctionDefinition" ? (func.name ?? func.kind) : func.name;
  }

  private indexModifierInvocations({
    uri,
    lines,
    commentRanges,
    func,
    bodyRange,
    contract,
    callerName,
    callerContainer,
    fileIncomingNames,
    fileOutgoingKeys,
  }: {
    uri: string;
    lines: string[];
    commentRanges: Map<number, Array<[number, number]>>;
    func: FunctionDefinition;
    bodyRange: { bodyStartLine: number; bodyStartChar: number; bodyEndLine: number };
    contract: ContractDefinition;
    callerName: string;
    callerContainer: string | undefined;
    fileIncomingNames: Set<string>;
    fileOutgoingKeys: Set<string>;
  }): void {
    for (const modifierName of func.modifiers) {
      const callRange = this.findModifierInvocationRange(
        modifierName,
        func.range.start.line,
        bodyRange.bodyStartLine,
        bodyRange.bodyStartChar,
        lines,
        commentRanges,
      );
      if (!callRange) continue;

      this.recordCallSite({
        calleeName: modifierName,
        qualifier: undefined,
        callRange,
        callerUri: uri,
        callerName,
        callerContainer,
        target: this.resolveModifierTarget(uri, contract, modifierName),
        fileIncomingNames,
        fileOutgoingKeys,
      });
    }
  }

  private findModifierInvocationRange(
    modifierName: string,
    startLine: number,
    bodyStartLine: number,
    bodyStartChar: number,
    lines: string[],
    commentRanges: Map<number, Array<[number, number]>>,
  ): Range | undefined {
    const pattern = new RegExp(`\\b${escapeRegExp(modifierName)}\\b`, "g");
    for (let line = startLine; line <= bodyStartLine; line++) {
      const text =
        line === bodyStartLine ? (lines[line] ?? "").slice(0, bodyStartChar) : (lines[line] ?? "");
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        const col = match.index;
        if (isPositionInCommentRanges(commentRanges, line, col)) continue;
        if (isInsideString(lines[line] ?? "", col)) continue;
        return {
          start: { line, character: col },
          end: { line, character: col + modifierName.length },
        };
      }
    }
    return undefined;
  }

  private resolveModifierTarget(
    uri: string,
    contract: ContractDefinition,
    modifierName: string,
  ): CallTarget | undefined {
    const resolved = this.resolver?.findMemberInInheritanceChain(contract.name, modifierName, uri);
    if (resolved?.kind === "modifier") return this.symbolToTarget(resolved);

    const candidates = this.filterVisibleSymbols(
      uri,
      this.symbolIndex
        .findSymbols(modifierName)
        .filter((sym) => sym.kind === "modifier" && sym.containerName === contract.name),
    );
    return candidates[0] ? this.symbolToTarget(candidates[0]) : undefined;
  }

  private recordCallSite({
    calleeName,
    qualifier,
    callRange,
    callerUri,
    callerName,
    callerContainer,
    target,
    fileIncomingNames,
    fileOutgoingKeys,
  }: CallSite & { fileIncomingNames: Set<string>; fileOutgoingKeys: Set<string> }): void {
    const callerKey = this.makeKey(callerUri, callerName, callerContainer);

    const outgoing = this.outgoingCalls.get(callerKey) ?? [];
    outgoing.push({
      calleeName,
      qualifier,
      callRange,
      callerUri,
      callerName,
      callerContainer,
      target,
    });
    this.outgoingCalls.set(callerKey, outgoing);
    fileOutgoingKeys.add(callerKey);

    const incoming = this.incomingCalls.get(calleeName) ?? [];
    incoming.push({
      calleeName,
      qualifier,
      callRange,
      callerUri,
      callerName,
      callerContainer,
      target,
    });
    this.incomingCalls.set(calleeName, incoming);
    fileIncomingNames.add(calleeName);
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
          kind: "function",
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
          kind: "modifier",
          uri: targetUri,
          range: mod.range,
          selectionRange: mod.nameRange,
          containerName: entry.contract.name,
        };
      }
      for (const svar of entry.contract.stateVariables) {
        if (!this.rangeContains(svar.range, start, end)) continue;
        return {
          name: svar.name,
          kind: "stateVariable",
          uri: targetUri,
          range: svar.range,
          selectionRange: svar.nameRange,
          containerName: entry.contract.name,
        };
      }
      for (const event of entry.contract.events) {
        if (!this.rangeContains(event.range, start, end)) continue;
        return {
          name: event.name,
          kind: "event",
          uri: targetUri,
          range: event.range,
          selectionRange: event.nameRange,
          containerName: entry.contract.name,
        };
      }
      for (const err of entry.contract.errors) {
        if (!this.rangeContains(err.range, start, end)) continue;
        return {
          name: err.name,
          kind: "error",
          uri: targetUri,
          range: err.range,
          selectionRange: err.nameRange,
          containerName: entry.contract.name,
        };
      }
    }
    const sourceUnit = this.parser.get(targetUri)?.sourceUnit;
    if (sourceUnit) {
      for (const fn of sourceUnit.freeFunctions) {
        if (!fn.name || !this.rangeContains(fn.range, start, end)) continue;
        return {
          name: fn.name,
          kind: "function",
          uri: targetUri,
          range: fn.range,
          selectionRange: fn.nameRange,
        };
      }
      for (const event of sourceUnit.events) {
        if (!this.rangeContains(event.range, start, end)) continue;
        return {
          name: event.name,
          kind: "event",
          uri: targetUri,
          range: event.range,
          selectionRange: event.nameRange,
        };
      }
      for (const err of sourceUnit.errors) {
        if (!this.rangeContains(err.range, start, end)) continue;
        return {
          name: err.name,
          kind: "error",
          uri: targetUri,
          range: err.range,
          selectionRange: err.nameRange,
        };
      }
    }
    return undefined;
  }

  private matchesTarget(target: CallTarget, item: CallHierarchyItem): boolean {
    if (target.name !== item.name) return false;
    if (item.detail) return target.containerName === item.detail;
    return !target.containerName && target.uri === item.uri;
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
    uri: string,
    contract: ContractDefinition | undefined,
    position: Position,
  ): string | undefined {
    if (!rawQualifier) return undefined;

    if (rawQualifier === "this" && contract) {
      return contract.name.length > 0 ? contract.name : undefined;
    }
    if (rawQualifier === "super" && contract) {
      const firstBase = contract.baseContracts[0]?.baseName;
      return firstBase && firstBase.length > 0 ? firstBase : undefined;
    }

    return (
      this.stripTypeDecorations(
        resolveDottedReceiverTypeInfo(this.parser, this.symbolIndex, uri, position, rawQualifier)
          ?.typeName,
      ) ?? rawQualifier
    );
  }

  private resolveCalleeSymbol(site: CallSite): CallTarget | undefined {
    const candidates = this.symbolIndex
      .findSymbols(site.calleeName)
      .filter((sym) => this.isCallHierarchySymbolKind(sym.kind));
    if (candidates.length === 0) return undefined;

    const visible = this.filterVisibleSymbols(site.callerUri, candidates);
    const pool = visible.length > 0 ? visible : candidates;

    if (site.qualifier) {
      const resolved = this.resolver?.findMemberInInheritanceChain(
        site.qualifier,
        site.calleeName,
        site.callerUri,
      );
      if (resolved && this.isCallHierarchySymbolKind(resolved.kind)) {
        return this.symbolToTarget(resolved);
      }

      const allowed = this.computeAllowedQualifiers(site.qualifier, site.callerUri);
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
    kind?: string;
    filePath: string;
    range: Range;
    nameRange: Range;
    containerName?: string;
  }): CallTarget {
    return {
      name: sym.name,
      kind: sym.kind,
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
    if (this.resolver) return this.resolver.filterVisibleSymbols(callerUri, symbols);
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
    if (cached !== undefined) {
      // Touch this entry so it moves to the most-recently-used end of
      // the insertion order. `Map` iterates in insertion order, so
      // re-setting the key is the canonical LRU bump on V8 Maps.
      this.fileTextCache.delete(uri);
      this.fileTextCache.set(uri, cached);
      return cached;
    }
    let filePath: string;
    try {
      filePath = this.workspace.uriToPath(uri);
    } catch {
      this.cacheFileText(uri, null);
      return null;
    }
    const text = this.readFile(filePath);
    this.cacheFileText(uri, text);
    return text;
  }

  /**
   * Insert into `fileTextCache`, evicting the least-recently-used
   * entry when we exceed {@link FILE_TEXT_CACHE_LIMIT}. The cache is
   * just a hint to avoid re-reading the same dependency file from disk
   * in close succession during a call hierarchy traversal; we do not
   * rely on it for correctness, so dropping the oldest entry is safe.
   */
  private cacheFileText(uri: string, text: string | null): void {
    if (this.fileTextCache.has(uri)) this.fileTextCache.delete(uri);
    this.fileTextCache.set(uri, text);
    while (this.fileTextCache.size > FILE_TEXT_CACHE_LIMIT) {
      const oldest = this.fileTextCache.keys().next().value;
      if (oldest === undefined) break;
      this.fileTextCache.delete(oldest);
    }
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
    commentRanges: Map<number, Array<[number, number]>>,
  ): { bodyStartLine: number; bodyStartChar: number; bodyEndLine: number } | null {
    const lines = text.split("\n");
    let braceDepth = 0;
    let foundOpen = false;
    let bodyStartLine = funcStartLine;
    let bodyStartChar = 0;

    for (let i = funcStartLine; i < lines.length; i++) {
      const line = lines[i];
      for (let j = 0; j < line.length; j++) {
        if (isPositionInCommentRanges(commentRanges, i, j)) continue;
        if (isInsideString(line, j)) continue;
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
      if (!foundOpen && this.hasSemicolonOutsideIgnoredRanges(line, i, commentRanges)) return null;
    }

    return null;
  }

  private hasSemicolonOutsideIgnoredRanges(
    line: string,
    lineNum: number,
    commentRanges: Map<number, Array<[number, number]>>,
  ): boolean {
    for (let col = 0; col < line.length; col++) {
      if (line[col] !== ";") continue;
      if (isPositionInCommentRanges(commentRanges, lineNum, col)) continue;
      if (isInsideString(line, col)) continue;
      return true;
    }
    return false;
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
  kind?: string;
  uri: string;
  range: Range;
  selectionRange: Range;
  containerName?: string;
}

/**
 * Count newlines in the precomputed sorted offset array that occur
 * strictly before `offset`. Equivalent to `Array.prototype.findIndex`
 * for the first offset >= the target, but in O(log N) — what makes
 * the inner call-site scan O(call_sites · log(line_count)) instead of
 * the prior O(call_sites · body_length) regex slice-and-count.
 */
function countNewlinesBefore(sortedOffsets: number[], offset: number): number {
  let lo = 0;
  let hi = sortedOffsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedOffsets[mid] < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
