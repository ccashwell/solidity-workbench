import { readFile } from "node:fs/promises";
import type { CancellationToken, Range, WorkspaceSymbol } from "vscode-languageserver/node.js";
import { SymbolKind as LSPSymbolKind } from "vscode-languageserver/node.js";
import { URI } from "vscode-uri";
import type {
  SolSymbol,
  SymbolKind,
  ContractDefinition,
  FunctionDefinition,
  StructDefinition,
  EnumDefinition,
} from "@solidity-workbench/common";
import type { SolidityParser } from "../parser/solidity-parser.js";
import type { FileTier, WorkspaceManager } from "../workspace/workspace-manager.js";
import { ReferenceIndex } from "./reference-index.js";
import { TrigramIndex, scoreName } from "./trigram-index.js";

/** Files indexed per `setImmediate` yield. Tuned for snappy editor response
 *  on a typical foundry workspace — small enough that any single batch
 *  (parse + symbol extraction + reference scan) finishes in a few ms,
 *  large enough that the per-yield overhead doesn't dominate. */
const INDEX_BATCH_SIZE = 24;

/** Callback fired between batches during the initial workspace index.
 *  `filesIndexed` is monotonically non-decreasing and capped at
 *  `filesTotal`. */
export type IndexProgressReporter = (filesIndexed: number, filesTotal: number) => void;

export interface IndexWorkspaceOptions {
  tiers?: FileTier[];
  skipIndexed?: boolean;
}

/**
 * Maintains a cross-file symbol index for the workspace.
 * Supports go-to-definition, find references, workspace symbols, and completions.
 */
export class SymbolIndex {
  private parser: SolidityParser;
  private workspace: WorkspaceManager;

  /** All symbols indexed by name */
  private symbolsByName: Map<string, SolSymbol[]> = new Map();

  /** All symbols indexed by file URI */
  private symbolsByFile: Map<string, SolSymbol[]> = new Map();

  /** Contract definitions indexed by name — for inheritance resolution */
  private contractsByName: Map<string, { uri: string; contract: ContractDefinition }> = new Map();

  /**
   * Inverted identifier-occurrence index used to answer "find all references"
   * and "reference count" queries in O(1) by-name lookups instead of scanning
   * every file on every query.
   */
  private refIndex = new ReferenceIndex();

  /**
   * Trigram index over symbol names, used to short-circuit the workspace-
   * symbol substring scan on large workspaces. Kept in sync with
   * `symbolsByName` via the same add/remove transitions in `updateFile`.
   */
  private trigrams = new TrigramIndex();

  /**
   * Files queued for the initial workspace index that haven't been
   * processed yet. Drains as `indexWorkspace` walks tiers, as
   * documents are opened by the editor (which short-circuits to
   * `updateFile`), and as {@link ensureImportsIndexed} pulls in the
   * transitive import graph of opened files.
   */
  private pending: Set<string> = new Set();

  constructor(parser: SolidityParser, workspace: WorkspaceManager) {
    this.parser = parser;
    this.workspace = workspace;
  }

  /**
   * Index every Solidity file in the workspace, walking files in
   * priority order: project source first, then tests/scripts, then
   * library dependencies.
   *
   * The work is broken into {@link INDEX_BATCH_SIZE}-sized chunks with
   * a `setImmediate` yield between batches so the LSP can serve hover,
   * completion, and other requests while bulk indexing is still in
   * flight. The `reportProgress` callback fires at every yield point
   * (and one final time when indexing completes) so the client status
   * bar can stream progress instead of jumping 0 → done.
   *
   * If the workspace stub doesn't expose `getFileUrisByTier` (older
   * test fakes) we fall back to the flat URI list with no priority.
   */
  async indexWorkspace(
    reportProgress?: IndexProgressReporter,
    options: IndexWorkspaceOptions = {},
  ): Promise<void> {
    const tieredFn = (this.workspace as Partial<WorkspaceManager>).getFileUrisByTier;
    const ordered = tieredFn
      ? (() => {
          const t = tieredFn.call(this.workspace);
          const requested = new Set(options.tiers ?? ["project", "tests", "deps"]);
          const out: string[] = [];
          if (requested.has("project")) out.push(...t.project);
          if (requested.has("tests")) out.push(...t.tests);
          if (requested.has("deps")) out.push(...t.deps);
          return out;
        })()
      : this.workspace.getAllFileUris();

    const queued = options.skipIndexed
      ? ordered.filter((uri) => !this.symbolsByFile.has(uri))
      : ordered;
    const total = queued.length;
    this.pending = new Set(queued);
    if (total === 0) {
      reportProgress?.(0, 0);
      return;
    }

    // Process files INDEX_BATCH_SIZE at a time with `Promise.all`, so
    // the parser pool can fan out to multiple workers concurrently.
    // Without `Promise.all` the `await indexFile` chain would
    // serialize on the main thread (one parse at a time, regardless of
    // worker count) — exactly what we're spawning workers to avoid.
    let lastReported = 0;
    for (let i = 0; i < ordered.length; i += INDEX_BATCH_SIZE) {
      const slice = ordered.slice(i, i + INDEX_BATCH_SIZE);

      // Filter to URIs still in `pending`. A concurrent
      // `ensureImportsIndexed` (driven by a document open) or a
      // direct `updateFile` may have already pulled some entries out
      // of the queue while we were awaiting the previous batch.
      const todo = slice.filter((uri) => this.pending.has(uri));
      for (const uri of todo) this.pending.delete(uri);

      if (todo.length > 0) {
        await Promise.all(todo.map((uri) => this.indexFile(uri)));
      }

      const done = total - this.pending.size;
      const isLast = this.pending.size === 0;
      if (done !== lastReported) {
        lastReported = done;
        reportProgress?.(done, total);
      }
      if (isLast) break;

      // Yield to the event loop so pending LSP requests can run
      // between batches. A microtask (`await Promise.resolve()`)
      // isn't enough — only a macrotask boundary lets I/O and
      // timers fire.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  /**
   * Eagerly index the transitive import graph of `uri` so providers
   * (hover, inlay hints, definition, etc.) can resolve any symbol
   * reachable from an opened document without waiting for the bulk
   * `indexWorkspace` sweep to reach `lib/`.
   *
   * Bounded by the actual import graph of the file the user is
   * touching — typically a few dozen files (forge-std, openzeppelin,
   * project-internal helpers) instead of the entire dependency tree.
   *
   * Already-indexed files are skipped via the `visited` set; pending
   * files are pulled out of the bulk-sweep queue and indexed
   * immediately, which also prevents the bulk loop from
   * double-indexing them later.
   */
  async ensureImportsIndexed(
    uri: string,
    visited: Set<string> = new Set(),
    onIndexed?: (uri: string) => void,
  ): Promise<void> {
    if (visited.has(uri)) return;
    visited.add(uri);

    // The opened document is parsed and `updateFile`'d separately by
    // the LSP layer — but a transitively-imported file may not be in
    // either cache yet. Index it before walking its imports so we can
    // see what *it* imports.
    if (!this.symbolsByFile.has(uri)) {
      this.pending.delete(uri);
      await this.indexFile(uri);
      onIndexed?.(uri);
    }

    const result = this.parser.get(uri);
    if (!result) return;

    const fsPath = this.workspace.uriToPath(uri);
    for (const imp of result.sourceUnit.imports) {
      const targetPath = this.workspace.resolveImport(imp.path, fsPath);
      if (!targetPath) continue;
      const targetUri = URI.file(targetPath).toString();
      await this.ensureImportsIndexed(targetUri, visited, onIndexed);
    }
  }

  /**
   * Index or re-index a single file.
   *
   * Reads the file from disk asynchronously and routes the parse
   * through `parser.parseAsync`, which fans out to a `worker_threads`
   * pool when one is wired in. Async I/O lets concurrent batch
   * indexing overlap reads, and the worker pool lets multiple files
   * parse in parallel — bulk indexing of a populated `lib/` tree no
   * longer pegs a single thread.
   */
  async indexFile(uri: string): Promise<void> {
    try {
      const filePath = this.workspace.uriToPath(uri);
      const text = await readFile(filePath, "utf-8");
      await this.parser.parseAsync(uri, text);
      this.updateFile(uri);
    } catch {
      /* file unreadable, skip */
    }
  }

  /**
   * Update the index for a file that's already been parsed.
   */
  updateFile(uri: string): void {
    const result = this.parser.get(uri);
    if (!result) return;

    // The file is being indexed via the editor / file-watcher path —
    // make sure the bulk `indexWorkspace` loop and any later
    // `flushPending` skip it.
    this.pending.delete(uri);

    // Refresh the inverted reference index using the cached source text.
    // If for some reason the parser didn't retain text (older call sites),
    // we skip the refresh rather than re-reading from disk here — indexFile()
    // is the canonical entry point that guarantees both caches are populated.
    const cachedText = this.parser.getText(uri);
    if (cachedText !== undefined) {
      this.refIndex.indexFile(uri, cachedText);
    }

    this.removeFileSymbols(uri);

    // Build new symbols
    const newSymbols: SolSymbol[] = [];
    const su = result.sourceUnit;

    for (const contract of su.contracts) {
      // Contract itself
      newSymbols.push({
        name: contract.name,
        kind:
          contract.kind === "interface"
            ? "interface"
            : contract.kind === "library"
              ? "library"
              : "contract",
        filePath: uri,
        range: contract.range,
        nameRange: contract.nameRange,
        natspec: contract.natspec,
      });

      this.contractsByName.set(contract.name, { uri, contract });

      // Functions (including constructor / receive / fallback — `name` is null)
      for (const func of contract.functions) {
        const symbolName = func.name ?? func.kind;
        const symbolKind =
          func.kind === "constructor"
            ? "constructor"
            : func.kind === "receive"
              ? "receive"
              : func.kind === "fallback"
                ? "fallback"
                : "function";
        if (!symbolName) continue;
        newSymbols.push({
          name: symbolName,
          kind: symbolKind,
          filePath: uri,
          range: func.range,
          nameRange: func.nameRange,
          containerName: contract.name,
          detail: this.buildFunctionSignature(func),
          natspec: func.natspec,
        });
      }

      // Events
      for (const event of contract.events) {
        newSymbols.push({
          name: event.name,
          kind: "event",
          filePath: uri,
          range: event.range,
          nameRange: event.nameRange,
          containerName: contract.name,
          detail: this.buildEventSignature(event),
          natspec: event.natspec,
        });
      }

      // Errors
      for (const error of contract.errors) {
        newSymbols.push({
          name: error.name,
          kind: "error",
          filePath: uri,
          range: error.range,
          nameRange: error.nameRange,
          containerName: contract.name,
          detail: this.buildErrorSignature(error),
          natspec: error.natspec,
        });
      }

      // State variables
      for (const svar of contract.stateVariables) {
        newSymbols.push({
          name: svar.name,
          kind: "stateVariable",
          filePath: uri,
          range: svar.range,
          nameRange: svar.nameRange,
          containerName: contract.name,
          detail: svar.typeName,
          natspec: svar.natspec,
        });
      }

      // Structs
      for (const struct of contract.structs) {
        this.indexStruct(newSymbols, uri, struct, contract.name);
      }

      // Enums
      for (const enumDef of contract.enums) {
        this.indexEnum(newSymbols, uri, enumDef, contract.name);
      }

      // Modifiers
      for (const mod of contract.modifiers) {
        newSymbols.push({
          name: mod.name,
          kind: "modifier",
          filePath: uri,
          range: mod.range,
          nameRange: mod.nameRange,
          containerName: contract.name,
          natspec: mod.natspec,
        });
      }
    }

    // File-level free functions (Solidity >=0.7.1)
    for (const fn of su.freeFunctions) {
      if (!fn.name) continue;
      newSymbols.push({
        name: fn.name,
        kind: "function",
        filePath: uri,
        range: fn.range,
        nameRange: fn.nameRange,
        detail: this.buildFunctionSignature(fn),
        natspec: fn.natspec,
      });
    }

    // File-level structs and enums (Solidity >=0.8.0)
    for (const struct of su.structs) {
      this.indexStruct(newSymbols, uri, struct);
    }

    for (const enumDef of su.enums) {
      this.indexEnum(newSymbols, uri, enumDef);
    }

    // File-level events
    for (const event of su.events) {
      newSymbols.push({
        name: event.name,
        kind: "event",
        filePath: uri,
        range: event.range,
        nameRange: event.nameRange,
        detail: this.buildEventSignature(event),
        natspec: event.natspec,
      });
    }

    // File-level custom errors
    for (const err of su.errors) {
      newSymbols.push({
        name: err.name,
        kind: "error",
        filePath: uri,
        range: err.range,
        nameRange: err.nameRange,
        detail: this.buildErrorSignature(err),
        natspec: err.natspec,
      });
    }

    for (const constant of su.fileConstants) {
      newSymbols.push({
        name: constant.name,
        kind: "fileConstant",
        filePath: uri,
        range: constant.range,
        nameRange: constant.nameRange,
        detail: constant.typeName,
        natspec: constant.natspec,
      });
    }

    // File-level user-defined value types (e.g. `type Fixed is uint256;`)
    for (const udvt of su.userDefinedValueTypes) {
      newSymbols.push({
        name: udvt.name,
        kind: "userDefinedValueType",
        filePath: uri,
        range: udvt.range,
        nameRange: udvt.nameRange,
        detail: udvt.underlyingType,
      });
    }

    // Store symbols
    this.symbolsByFile.set(uri, newSymbols);
    for (const sym of newSymbols) {
      const existing = this.symbolsByName.get(sym.name) ?? [];
      existing.push(sym);
      this.symbolsByName.set(sym.name, existing);
      // `add` is idempotent, so re-indexing the same file doesn't
      // bloat the trigram posting lists.
      this.trigrams.add(sym.name);
    }
  }

  /**
   * Find symbols by name (exact match or prefix).
   *
   * Returns whatever the in-memory map currently knows. During the
   * initial workspace sweep this may legitimately be empty for a
   * symbol that lives in an unindexed `lib/` file. Providers that
   * have a known file URI to consult (e.g. an opened document)
   * should call {@link ensureImportsIndexed} instead of expecting a
   * cross-tree synchronous drain — that path used to live here and
   * blocked the LSP for as long as it took to read every dep file.
   */
  findSymbols(name: string): SolSymbol[] {
    return this.symbolsByName.get(name) ?? [];
  }

  /**
   * Find every textual occurrence of `name` in indexed files.
   *
   * Backed by the inverted `ReferenceIndex`, which pre-computes word-boundary
   * matches and already strips block comments, line comments, and string
   * literals.  Includes both declaration sites and usage sites; callers that
   * want to distinguish them can intersect with {@link findSymbols}.
   */
  findReferences(name: string): { uri: string; range: Range }[] {
    return this.refIndex.findReferences(name);
  }

  /**
   * Total count of indexed occurrences of `name` (declarations + usages).
   */
  referenceCount(name: string): number {
    return this.refIndex.referenceCount(name);
  }

  /**
   * True if any file in the workspace has been indexed with an occurrence of
   * `name`.  Used by callers that want to decide between the fast inverted
   * index path and a slow text-scan fallback for identifiers we haven't seen
   * yet (e.g. newly opened files not yet indexed).
   */
  hasReferences(name: string): boolean {
    return this.refIndex.has(name);
  }

  /**
   * Drop volatile reference entries for a closed file while preserving symbol
   * and contract maps. Deletions use `removeFile`, which clears all indexes.
   */
  onFileClosed(uri: string): void {
    this.refIndex.removeFile(uri);
  }

  removeFile(uri: string): void {
    this.pending.delete(uri);
    this.refIndex.removeFile(uri);
    this.removeFileSymbols(uri);
  }

  /**
   * Find symbols matching a query (for workspace symbol search).
   *
   * Pipeline:
   *   1. Trigram index prunes the candidate set. For queries of 3+
   *      chars this examines only names whose trigrams overlap the
   *      query's — typically a small fraction of the workspace.
   *   2. Each candidate is scored by {@link scoreName}, which ranks
   *      exact > prefix > substring > fuzzy subsequence, with shorter
   *      names preferred within a tier.
   *   3. Symbol entries for surviving candidates are emitted, sorted
   *      by descending score, and capped at 100 results.
   *
   * Supports cancellation: if the client cancels we return whatever
   * we've accumulated rather than finishing the full scan.
   */
  findWorkspaceSymbols(query: string, token?: CancellationToken): WorkspaceSymbol[] {
    // Collect all (symbol, score) pairs across the candidate names.
    const scored: { sym: SolSymbol; score: number }[] = [];
    let candidates = this.trigrams.candidates(query);
    // Trigram intersection only guarantees substring matches. When it
    // finds nothing (e.g. `ctr` vs `Counter`), fall back to every
    // indexed name and let scoreName's subsequence tier decide.
    if (candidates.length === 0 && query.length >= 3) {
      candidates = this.trigrams.allNames();
    }

    for (const name of candidates) {
      if (token?.isCancellationRequested) break;
      const score = scoreName(name, query);
      if (score <= 0) continue;
      const symbols = this.symbolsByName.get(name);
      if (!symbols) continue;
      for (const sym of symbols) scored.push({ sym, score });
    }

    scored.sort((a, b) => b.score - a.score);

    const results: WorkspaceSymbol[] = [];
    for (const { sym } of scored) {
      if (results.length >= 100) break;
      results.push({
        name: sym.containerName ? `${sym.containerName}.${sym.name}` : sym.name,
        kind: this.toLSPSymbolKind(sym.kind),
        location: {
          uri: sym.filePath,
          range: sym.range,
        },
        containerName: sym.containerName,
      });
    }

    return results;
  }

  /**
   * Get all symbols in a file.
   */
  getFileSymbols(uri: string): SolSymbol[] {
    return this.symbolsByFile.get(uri) ?? [];
  }

  /**
   * Get a contract definition by name.
   *
   * Returns whatever the in-memory map currently knows. Inheritance
   * walks (`getInheritanceChain`) hit this method repeatedly; we
   * trust that any base contract reachable from the user's open
   * document has already been pulled in by
   * {@link ensureImportsIndexed}.
   */
  getContract(name: string): { uri: string; contract: ContractDefinition } | undefined {
    return this.contractsByName.get(name);
  }

  /**
   * Look up a struct definition by name in `uri` (file-level, then any contract).
   */
  getStruct(uri: string, structName: string): StructDefinition | undefined {
    const su = this.parser.get(uri)?.sourceUnit;
    if (!su) return undefined;

    const local = this.findStructInSourceUnit(uri, structName);
    if (local) return local;

    const imported = this.resolveImportedSymbolName(uri, structName);
    if (imported) {
      return this.findStructInSourceUnit(imported.uri, imported.name);
    }

    return undefined;
  }

  private findStructInSourceUnit(uri: string, structName: string): StructDefinition | undefined {
    const su = this.parser.get(uri)?.sourceUnit;
    if (!su) return undefined;

    const fileLevel = su.structs.find((s) => s.name === structName);
    if (fileLevel) return fileLevel;

    for (const contract of su.contracts) {
      const nested = contract.structs.find((s) => s.name === structName);
      if (nested) return nested;
    }
    return undefined;
  }

  private resolveImportedSymbolName(
    fromUri: string,
    name: string,
  ): { name: string; uri: string } | undefined {
    const su = this.parser.get(fromUri)?.sourceUnit;
    if (!su) return undefined;

    let fromPath: string;
    try {
      fromPath = this.workspace.uriToPath(fromUri);
    } catch {
      return undefined;
    }

    const scoped = name.includes(".") ? name.split(".") : null;
    for (const imp of su.imports) {
      let targetPath: string | null;
      try {
        targetPath = this.workspace.resolveImport(imp.path, fromPath);
      } catch {
        targetPath = null;
      }
      if (!targetPath) continue;
      const targetUri = URI.file(targetPath).toString();

      if (scoped && imp.unitAlias === scoped[0] && scoped[1]) {
        return { name: scoped[1], uri: targetUri };
      }

      if (scoped) continue;
      for (const alias of imp.symbolAliases ?? []) {
        const visibleName = alias.alias ?? alias.symbol;
        if (visibleName === name) return { name: alias.symbol, uri: targetUri };
      }

      if (!imp.unitAlias && (imp.symbolAliases ?? []).length === 0) {
        const plainImportStruct = this.findStructInSourceUnit(targetUri, name);
        if (plainImportStruct) return { name, uri: targetUri };
      }
    }

    return undefined;
  }

  /**
   * Find an indexed struct or enum member by container type name.
   */
  findContainerMember(
    memberName: string,
    containerName: string,
    kind: "structMember" | "enumMember",
    uri?: string,
  ): SolSymbol | undefined {
    return this.findSymbols(memberName).find(
      (sym) =>
        sym.kind === kind &&
        sym.containerName === containerName &&
        (uri === undefined || sym.filePath === uri),
    );
  }

  private removeFileSymbols(uri: string): void {
    const oldSymbols = this.symbolsByFile.get(uri) ?? [];
    const removedContractNames = new Set<string>();
    for (const sym of oldSymbols) {
      if (sym.kind === "contract" || sym.kind === "interface" || sym.kind === "library") {
        removedContractNames.add(sym.name);
      }
      const byName = this.symbolsByName.get(sym.name);
      if (!byName) continue;
      const filtered = byName.filter((s) => s.filePath !== uri);
      if (filtered.length > 0) {
        this.symbolsByName.set(sym.name, filtered);
      } else {
        this.symbolsByName.delete(sym.name);
        // Last symbol with this name is gone — drop it from the
        // trigram index so stale names aren't returned by future
        // workspace-symbol queries.
        this.trigrams.remove(sym.name);
      }
    }
    this.symbolsByFile.delete(uri);
    for (const name of removedContractNames) {
      if (this.contractsByName.get(name)?.uri === uri) {
        this.restoreContractEntry(name);
      }
    }
  }

  private restoreContractEntry(name: string): void {
    this.contractsByName.delete(name);
    const remaining = this.symbolsByName
      .get(name)
      ?.find(
        (sym) => sym.kind === "contract" || sym.kind === "interface" || sym.kind === "library",
      );
    if (!remaining) return;
    const contract = this.parser
      .get(remaining.filePath)
      ?.sourceUnit.contracts.find((candidate) => candidate.name === name);
    if (contract) this.contractsByName.set(name, { uri: remaining.filePath, contract });
  }

  private indexStruct(
    newSymbols: SolSymbol[],
    uri: string,
    struct: StructDefinition,
    contractName?: string,
  ): void {
    newSymbols.push({
      name: struct.name,
      kind: "struct",
      filePath: uri,
      range: struct.range,
      nameRange: struct.nameRange,
      containerName: contractName,
      natspec: struct.natspec,
    });

    for (const member of struct.members) {
      if (!member.name || !member.nameRange) continue;
      newSymbols.push({
        name: member.name,
        kind: "structMember",
        filePath: uri,
        range: member.range ?? member.nameRange,
        nameRange: member.nameRange,
        containerName: struct.name,
        detail: member.typeName,
      });
    }
  }

  private indexEnum(
    newSymbols: SolSymbol[],
    uri: string,
    enumDef: EnumDefinition,
    contractName?: string,
  ): void {
    newSymbols.push({
      name: enumDef.name,
      kind: "enum",
      filePath: uri,
      range: enumDef.range,
      nameRange: enumDef.nameRange,
      containerName: contractName,
      natspec: enumDef.natspec,
    });

    for (const member of enumDef.members) {
      newSymbols.push({
        name: member.name,
        kind: "enumMember",
        filePath: uri,
        range: member.range,
        nameRange: member.nameRange,
        containerName: enumDef.name,
      });
    }
  }

  /**
   * Get all contracts (for completions and navigation).
   */
  getAllContracts(): Map<string, { uri: string; contract: ContractDefinition }> {
    return this.contractsByName;
  }

  /**
   * Resolve the full inheritance chain for a contract.
   */
  getInheritanceChain(contractName: string): ContractDefinition[] {
    const chain: ContractDefinition[] = [];
    const visited = new Set<string>();

    const resolve = (name: string) => {
      if (visited.has(name)) return;
      visited.add(name);

      const entry = this.contractsByName.get(name);
      if (!entry) return;

      chain.push(entry.contract);
      for (const base of entry.contract.baseContracts) {
        resolve(base.baseName);
      }
    };

    resolve(contractName);
    return chain;
  }

  private buildFunctionSignature(func: FunctionDefinition): string {
    const params = func.parameters
      .map((p) => `${p.typeName}${p.name ? " " + p.name : ""}`)
      .join(", ");
    const returns = func.returnParameters.map((p) => p.typeName).join(", ");
    const vis = func.visibility !== "public" ? ` ${func.visibility}` : "";
    const mut = func.mutability !== "nonpayable" ? ` ${func.mutability}` : "";
    const ret = returns ? ` returns (${returns})` : "";
    return `(${params})${vis}${mut}${ret}`;
  }

  private buildEventSignature(event: {
    parameters: { typeName: string; name?: string; indexed?: boolean }[];
    isAnonymous?: boolean;
  }): string {
    const params = event.parameters.map((p) => this.buildParameterSignature(p)).join(", ");
    return `(${params})${event.isAnonymous ? " anonymous" : ""}`;
  }

  private buildErrorSignature(error: {
    parameters: { typeName: string; name?: string; indexed?: boolean }[];
  }): string {
    const params = error.parameters.map((p) => this.buildParameterSignature(p)).join(", ");
    return `(${params})`;
  }

  private buildParameterSignature(param: {
    typeName: string;
    name?: string;
    indexed?: boolean;
  }): string {
    return [param.typeName, param.indexed ? "indexed" : "", param.name ?? ""]
      .filter(Boolean)
      .join(" ");
  }

  private toLSPSymbolKind(kind: SymbolKind): LSPSymbolKind {
    switch (kind) {
      case "contract":
        return LSPSymbolKind.Class;
      case "interface":
        return LSPSymbolKind.Interface;
      case "library":
        return LSPSymbolKind.Module;
      case "function":
        return LSPSymbolKind.Function;
      case "constructor":
        return LSPSymbolKind.Constructor;
      case "receive":
      case "fallback":
        return LSPSymbolKind.Function;
      case "modifier":
        return LSPSymbolKind.Method;
      case "event":
        return LSPSymbolKind.Event;
      case "error":
        return LSPSymbolKind.Struct;
      case "struct":
        return LSPSymbolKind.Struct;
      case "structMember":
        return LSPSymbolKind.Field;
      case "enum":
        return LSPSymbolKind.Enum;
      case "enumMember":
        return LSPSymbolKind.EnumMember;
      case "fileConstant":
        return LSPSymbolKind.Constant;
      case "stateVariable":
        return LSPSymbolKind.Field;
      case "localVariable":
        return LSPSymbolKind.Variable;
      case "parameter":
        return LSPSymbolKind.Variable;
      case "userDefinedValueType":
        return LSPSymbolKind.TypeParameter;
    }
  }
}
