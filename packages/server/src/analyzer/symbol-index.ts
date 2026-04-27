import { readFileSync } from "node:fs";
import type { CancellationToken, Range, WorkspaceSymbol } from "vscode-languageserver/node.js";
import {
  Location,
  SymbolInformation,
  SymbolKind as LSPSymbolKind,
} from "vscode-languageserver/node.js";
import { URI } from "vscode-uri";
import type {
  SolSymbol,
  SymbolKind,
  ContractDefinition,
  FunctionDefinition,
} from "@solidity-workbench/common";
import type { SolidityParser } from "../parser/solidity-parser.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";
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
  async indexWorkspace(reportProgress?: IndexProgressReporter): Promise<void> {
    const tieredFn = (this.workspace as Partial<WorkspaceManager>).getFileUrisByTier;
    const ordered = tieredFn
      ? (() => {
          const t = tieredFn.call(this.workspace);
          return [...t.project, ...t.tests, ...t.deps];
        })()
      : this.workspace.getAllFileUris();

    const total = ordered.length;
    this.pending = new Set(ordered);
    if (total === 0) {
      reportProgress?.(0, 0);
      return;
    }

    let lastReported = 0;
    for (const uri of ordered) {
      // A concurrent `flushPending` (driven by a name-miss in another
      // request) or a document open via `updateFile` may have already
      // indexed this file — skip the redundant pass.
      if (this.pending.has(uri)) {
        this.pending.delete(uri);
        await this.indexFile(uri);
      }

      const done = total - this.pending.size;
      const isLast = this.pending.size === 0;
      if ((done >= lastReported + INDEX_BATCH_SIZE || isLast) && done !== lastReported) {
        lastReported = done;
        reportProgress?.(done, total);
        if (!isLast) {
          // Yield to the event loop so pending LSP requests can run
          // between batches. A microtask (`await Promise.resolve()`)
          // isn't enough — only a macrotask boundary lets I/O and
          // timers fire.
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }

      if (isLast) break;
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
  async ensureImportsIndexed(uri: string, visited: Set<string> = new Set()): Promise<void> {
    if (visited.has(uri)) return;
    visited.add(uri);

    // The opened document is parsed and `updateFile`'d separately by
    // the LSP layer — but a transitively-imported file may not be in
    // either cache yet. Index it before walking its imports so we can
    // see what *it* imports.
    if (!this.symbolsByFile.has(uri)) {
      this.pending.delete(uri);
      await this.indexFile(uri);
    }

    const result = this.parser.get(uri);
    if (!result) return;

    const fsPath = this.workspace.uriToPath(uri);
    for (const imp of result.sourceUnit.imports) {
      const targetPath = this.workspace.resolveImport(imp.path, fsPath);
      if (!targetPath) continue;
      const targetUri = URI.file(targetPath).toString();
      await this.ensureImportsIndexed(targetUri, visited);
    }
  }

  /**
   * Index or re-index a single file.
   *
   * Reads the file from disk, updates the parser cache, and then delegates
   * to `updateFile(uri)` to (re)build both the symbol table and the
   * inverted reference index from the parser's cached source text.
   */
  async indexFile(uri: string): Promise<void> {
    try {
      const filePath = this.workspace.uriToPath(uri);
      const text = readFileSync(filePath, "utf-8");
      this.parser.parse(uri, text);
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

    // Remove old symbols for this file
    const oldSymbols = this.symbolsByFile.get(uri) ?? [];
    for (const sym of oldSymbols) {
      const byName = this.symbolsByName.get(sym.name);
      if (byName) {
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
    }

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

      // Functions
      for (const func of contract.functions) {
        if (func.name) {
          newSymbols.push({
            name: func.name,
            kind: "function",
            filePath: uri,
            range: func.range,
            nameRange: func.nameRange,
            containerName: contract.name,
            detail: this.buildFunctionSignature(func),
            natspec: func.natspec,
          });
        }
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
        newSymbols.push({
          name: struct.name,
          kind: "struct",
          filePath: uri,
          range: struct.range,
          nameRange: struct.nameRange,
          containerName: contract.name,
          natspec: struct.natspec,
        });
      }

      // Enums
      for (const enumDef of contract.enums) {
        newSymbols.push({
          name: enumDef.name,
          kind: "enum",
          filePath: uri,
          range: enumDef.range,
          nameRange: enumDef.nameRange,
          containerName: contract.name,
          natspec: enumDef.natspec,
        });
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

    // File-level custom errors
    for (const err of su.errors) {
      newSymbols.push({
        name: err.name,
        kind: "error",
        filePath: uri,
        range: err.range,
        nameRange: err.nameRange,
        natspec: err.natspec,
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
   * Drop all inverted-index entries for a file — intended for cleanup when a
   * file is closed or removed from the workspace.  Symbol / contract maps
   * are untouched; those remain valid until the next `updateFile` rebuild.
   */
  onFileClosed(uri: string): void {
    this.refIndex.removeFile(uri);
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
    const candidates = this.trigrams.candidates(query);

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
      case "modifier":
        return LSPSymbolKind.Method;
      case "event":
        return LSPSymbolKind.Event;
      case "error":
        return LSPSymbolKind.Struct;
      case "struct":
        return LSPSymbolKind.Struct;
      case "enum":
        return LSPSymbolKind.Enum;
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
