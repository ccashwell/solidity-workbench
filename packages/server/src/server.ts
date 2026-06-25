import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  TextDocumentSyncKind,
  DidChangeConfigurationNotification,
  FileChangeType,
} from "vscode-languageserver/node.js";
import type {
  CodeAction,
  CancellationToken,
  CompletionItem,
  Hover,
  InitializeParams,
  InitializeResult,
  WorkspaceFoldersChangeEvent,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { WorkspaceManager } from "./workspace/workspace-manager.js";
import { SolidityParser } from "./parser/solidity-parser.js";
import { ParserPool } from "./parser/parser-pool.js";
import { SymbolIndex } from "./analyzer/symbol-index.js";
import { GraphIndex, type GraphDependencyIndexingMode } from "./analyzer/graph-index.js";
import { shouldDrainRelationshipsForGraphQuery } from "./analyzer/project-graph-policy.js";
import { CompletionProvider } from "./providers/completion.js";
import { DefinitionProvider } from "./providers/definition.js";
import { HoverProvider } from "./providers/hover.js";
import { DiagnosticsProvider } from "./providers/diagnostics.js";
import { SemanticTokensProvider } from "./providers/semantic-tokens.js";
import { CodeActionsProvider } from "./providers/code-actions.js";
import { FormattingProvider } from "./providers/formatting.js";
import { DocumentSymbolProvider } from "./providers/document-symbols.js";
import { InlayHintsProvider } from "./providers/inlay-hints.js";
import { SignatureHelpProvider } from "./providers/signature-help.js";
import { RenameProvider } from "./providers/rename.js";
import { CodeLensProvider } from "./providers/code-lens.js";
import { ReferencesProvider } from "./providers/references.js";
import { AutoImportProvider } from "./providers/auto-import.js";
import { CallHierarchyProvider } from "./providers/call-hierarchy.js";
import { TypeHierarchyProvider } from "./providers/type-hierarchy.js";
import { DocumentHighlightProvider } from "./providers/document-highlight.js";
import { FoldingRangesProvider } from "./providers/folding-ranges.js";
import { SelectionRangesProvider } from "./providers/selection-ranges.js";
import { DocumentLinksProvider } from "./providers/document-links.js";
import { ImplementationProvider } from "./providers/implementation.js";
import { InheritanceGraphProvider } from "./providers/inheritance-graph.js";
import { SolcBridge } from "./compiler/solc-bridge.js";
import { SemanticResolver } from "./analyzer/semantic-resolver.js";
import { listTests } from "./providers/list-tests.js";
import {
  GetInheritanceGraph,
  GetProjectGraph,
  GetProjectGraphNeighborhood,
  GetProjectGraphPath,
  GetProjectGraphStats,
  QueryProjectGraph,
  RebuildProjectGraph,
  SearchProjectGraph,
  SolSemanticTokenTypes,
  SolSemanticTokenModifiers,
  ServerStateNotification,
  ListTests,
  type GetInheritanceGraphParams,
  type GetProjectGraphParams,
  type GetProjectGraphNeighborhoodParams,
  type GetProjectGraphPathParams,
  type InheritanceGraphResult,
  type ListTestsParams,
  type ListTestsResult,
  type ProjectGraphPathResult,
  type ProjectGraphQueryResult,
  type ProjectGraphMeasuredRequestKind,
  type ProjectGraphResult,
  type ProjectGraphSearchResult,
  type ProjectGraphStatsResult,
  type QueryProjectGraphParams,
  type RebuildProjectGraphParams,
  type SearchProjectGraphParams,
  type ServerStateParams,
} from "@solidity-workbench/common";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

// Core services
let workspaceManager: WorkspaceManager;
let parser: SolidityParser;
let symbolIndex: SymbolIndex;
let graphIndex: GraphIndex;
let graphCacheDir: string | undefined;
let parserPool: ParserPool | null = null;
let graphRelationshipIndexTimer: ReturnType<typeof setTimeout> | null = null;
let graphRelationshipIndexGeneration = 0;

// Providers
let completionProvider: CompletionProvider;
let definitionProvider: DefinitionProvider;
let hoverProvider: HoverProvider;
let diagnosticsProvider: DiagnosticsProvider;
let semanticTokensProvider: SemanticTokensProvider;
let codeActionsProvider: CodeActionsProvider;
let formattingProvider: FormattingProvider;
let documentSymbolProvider: DocumentSymbolProvider;
let inlayHintsProvider: InlayHintsProvider;
let signatureHelpProvider: SignatureHelpProvider;
let renameProvider: RenameProvider;
let codeLensProvider: CodeLensProvider;
let referencesProvider: ReferencesProvider;
let autoImportProvider: AutoImportProvider;
let callHierarchyProvider: CallHierarchyProvider;
let typeHierarchyProvider: TypeHierarchyProvider;
let documentHighlightProvider: DocumentHighlightProvider;
let foldingRangesProvider: FoldingRangesProvider;
let selectionRangesProvider: SelectionRangesProvider;
let documentLinksProvider: DocumentLinksProvider;
let implementationProvider: ImplementationProvider;
let inheritanceGraphProvider: InheritanceGraphProvider;
let semanticResolver: SemanticResolver;
let solcBridge: SolcBridge;

/**
 * Latest snapshot of `solidity-workbench.*` workspace configuration.
 * Providers read through `getServerSettings()` so a configuration change
 * takes effect on the very next LSP request with no restart.
 */
interface ServerSettings {
  foundryPath?: string;
  diagnostics?: {
    compileOnSave?: boolean;
    debounceMs?: number;
  };
  inlayHints?: {
    parameterNames?: boolean;
  };
  gasEstimates?: {
    enabled?: boolean;
  };
  projectGraph?: {
    relationshipIndexing?: "auto" | "manual" | "disabled";
    dependencyIndexing?: GraphDependencyIndexingMode;
  };
}

let currentSettings: ServerSettings = {};

export function getServerSettings(): ServerSettings {
  return currentSettings;
}

function pushServerState(params: ServerStateParams): void {
  connection.sendNotification(ServerStateNotification, params);
}

function cancelGraphRelationshipIndex(): void {
  graphRelationshipIndexGeneration++;
  if (graphRelationshipIndexTimer) {
    clearTimeout(graphRelationshipIndexTimer);
    graphRelationshipIndexTimer = null;
  }
}

function scheduleGraphRelationshipIndex(): void {
  if (!shouldRunBackgroundGraphRelationshipIndex()) return;
  const generation = ++graphRelationshipIndexGeneration;
  let batchesSinceCacheWrite = 0;
  if (graphRelationshipIndexTimer) clearTimeout(graphRelationshipIndexTimer);

  const runBatch = (): void => {
    if (generation !== graphRelationshipIndexGeneration) return;
    const batch = graphIndex.indexRelationshipBatch(35, 20);
    batchesSinceCacheWrite++;
    pushServerState({
      phase: "indexing",
      filesIndexed: batch.filesIndexed,
      filesTotal: batch.filesTotal,
    });

    if (batch.complete) {
      graphRelationshipIndexTimer = null;
      graphIndex.writeCache(graphCacheDir);
      pushServerState({
        phase: "idle",
        rootCount: workspaceManager.rootCount,
        fileCount: workspaceManager.getAllFileUris().length,
      });
      return;
    }

    if (batchesSinceCacheWrite >= 10) {
      batchesSinceCacheWrite = 0;
      graphIndex.writeCache(graphCacheDir);
    }

    graphRelationshipIndexTimer = setTimeout(runBatch, 0);
  };

  graphRelationshipIndexTimer = setTimeout(runBatch, 0);
}

async function drainGraphRelationshipIndexForQuery(token?: CancellationToken): Promise<void> {
  if (graphIndex.isRelationshipIndexComplete()) return;
  cancelGraphRelationshipIndex();

  let batchesSinceCacheWrite = 0;
  let batch = graphIndex.indexRelationshipBatch(50, 50);
  batchesSinceCacheWrite++;
  pushServerState({
    phase: "indexing",
    filesIndexed: batch.filesIndexed,
    filesTotal: batch.filesTotal,
  });

  while (!batch.complete && !token?.isCancellationRequested) {
    const previousFilesIndexed = batch.filesIndexed;
    const previousFilesRemaining = batch.filesRemaining;
    if (batchesSinceCacheWrite >= 10) {
      batchesSinceCacheWrite = 0;
      graphIndex.writeCache(graphCacheDir);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    batch = graphIndex.indexRelationshipBatch(50, 50);
    batchesSinceCacheWrite++;
    pushServerState({
      phase: "indexing",
      filesIndexed: batch.filesIndexed,
      filesTotal: batch.filesTotal,
    });
    if (
      batch.filesIndexed === previousFilesIndexed &&
      batch.filesRemaining === previousFilesRemaining
    ) {
      break;
    }
  }

  graphIndex.writeCache(graphCacheDir);
  pushServerState({
    phase: "idle",
    rootCount: workspaceManager.rootCount,
    fileCount: workspaceManager.getAllFileUris().length,
  });

  if (!batch.complete && shouldRunBackgroundGraphRelationshipIndex()) {
    scheduleGraphRelationshipIndex();
  }
}

function graphRelationshipIndexingMode(): "auto" | "manual" | "disabled" {
  const mode = currentSettings.projectGraph?.relationshipIndexing;
  return mode === "manual" || mode === "disabled" ? mode : "auto";
}

function graphDependencyIndexingMode(): GraphDependencyIndexingMode {
  const mode = currentSettings.projectGraph?.dependencyIndexing;
  return mode === "declarations" || mode === "relationships" ? mode : "disabled";
}

function shouldRunBackgroundGraphRelationshipIndex(): boolean {
  return graphRelationshipIndexingMode() === "auto";
}

function shouldRunExplicitGraphRelationshipIndex(params: RebuildProjectGraphParams): boolean {
  return params.relationships === "blocking" && graphRelationshipIndexingMode() !== "disabled";
}

function graphCacheDirFromInitializationOptions(options: unknown): string | undefined {
  if (!options || typeof options !== "object") return undefined;
  const graphCacheUri = (options as { graphCacheUri?: unknown }).graphCacheUri;
  if (typeof graphCacheUri !== "string" || graphCacheUri.trim().length === 0) return undefined;
  try {
    return URI.parse(graphCacheUri).fsPath;
  } catch {
    return undefined;
  }
}

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const initialFolder = params.workspaceFolders?.[0]?.uri ?? params.rootUri ?? "";

  workspaceManager = new WorkspaceManager(initialFolder, connection);
  graphCacheDir = graphCacheDirFromInitializationOptions(params.initializationOptions);

  // Register every additional workspace folder the client sent.
  for (const folder of params.workspaceFolders ?? []) {
    if (folder.uri !== initialFolder) {
      void workspaceManager.addRoot(folder.uri);
    }
  }

  parser = new SolidityParser();
  symbolIndex = new SymbolIndex(parser, workspaceManager);

  // Wire the worker pool into the parser. Bulk indexing
  // (`SymbolIndex.indexFile`) routes through `parser.parseAsync`,
  // which fans parses out across the pool's worker threads. If the
  // worker bundle is missing or `Worker` construction throws (e.g.
  // older Node, restricted env), parseAsync falls back to a
  // synchronous main-thread parse — startup still works, just
  // serialized.
  parserPool = createParserPool();
  if (parserPool) parser.setPool(parserPool);

  semanticResolver = new SemanticResolver(parser, workspaceManager, symbolIndex);
  graphIndex = new GraphIndex(parser, workspaceManager, semanticResolver, symbolIndex);
  completionProvider = new CompletionProvider(
    symbolIndex,
    parser,
    workspaceManager,
    semanticResolver,
  );
  definitionProvider = new DefinitionProvider(
    symbolIndex,
    parser,
    workspaceManager,
    semanticResolver,
  );
  hoverProvider = new HoverProvider(symbolIndex, parser, workspaceManager, semanticResolver);
  diagnosticsProvider = new DiagnosticsProvider(workspaceManager, connection, documents);
  diagnosticsProvider.setParser(parser);
  semanticTokensProvider = new SemanticTokensProvider(parser);
  codeActionsProvider = new CodeActionsProvider(symbolIndex, parser);
  formattingProvider = new FormattingProvider(workspaceManager);
  documentSymbolProvider = new DocumentSymbolProvider(parser);
  inlayHintsProvider = new InlayHintsProvider(symbolIndex, parser, semanticResolver);
  signatureHelpProvider = new SignatureHelpProvider(symbolIndex, parser, semanticResolver);
  renameProvider = new RenameProvider(symbolIndex, workspaceManager, documents, semanticResolver);
  codeLensProvider = new CodeLensProvider(symbolIndex, parser, workspaceManager, semanticResolver);
  referencesProvider = new ReferencesProvider(
    symbolIndex,
    workspaceManager,
    parser,
    documents,
    semanticResolver,
  );
  autoImportProvider = new AutoImportProvider(symbolIndex, workspaceManager, parser);
  callHierarchyProvider = new CallHierarchyProvider(
    symbolIndex,
    workspaceManager,
    parser,
    semanticResolver,
    graphIndex,
  );
  typeHierarchyProvider = new TypeHierarchyProvider(symbolIndex, parser, semanticResolver);
  documentHighlightProvider = new DocumentHighlightProvider(symbolIndex, parser);
  foldingRangesProvider = new FoldingRangesProvider(parser);
  selectionRangesProvider = new SelectionRangesProvider(parser);
  documentLinksProvider = new DocumentLinksProvider(
    parser,
    workspaceManager,
    symbolIndex,
    semanticResolver,
  );
  implementationProvider = new ImplementationProvider(symbolIndex, semanticResolver);
  inheritanceGraphProvider = new InheritanceGraphProvider(
    parser,
    workspaceManager,
    semanticResolver,
    graphIndex,
  );
  solcBridge = new SolcBridge(workspaceManager);
  graphIndex.setSolcBridge(solcBridge);

  // Make the type-resolved AST cache available to providers that want it
  // for overload disambiguation, member resolution, canonical selector
  // lookup, and scope-aware local-variable rename.
  hoverProvider.setSolcBridge(solcBridge);
  definitionProvider.setSolcBridge(solcBridge);
  completionProvider.setSolcBridge(solcBridge);
  codeLensProvider.setSolcBridge(solcBridge);
  renameProvider.setSolcBridge(solcBridge);
  referencesProvider.setSolcBridge(solcBridge);
  documentHighlightProvider.setSolcBridge(solcBridge);
  callHierarchyProvider.setSolcBridge(solcBridge);

  connection.console.log(
    `Solidity Workbench LSP server initializing for ${workspaceManager.rootCount} root(s)`,
  );

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,

      completionProvider: {
        resolveProvider: true,
        triggerCharacters: [".", "/", '"', "'", "@"],
      },

      definitionProvider: true,
      typeDefinitionProvider: true,
      implementationProvider: true,
      referencesProvider: true,

      hoverProvider: true,

      documentSymbolProvider: true,
      workspaceSymbolProvider: true,

      renameProvider: {
        prepareProvider: true,
      },

      signatureHelpProvider: {
        triggerCharacters: ["(", ","],
      },

      codeActionProvider: {
        codeActionKinds: ["quickfix", "refactor", "refactor.extract", "source.organizeImports"],
      },

      documentFormattingProvider: true,
      documentRangeFormattingProvider: true,

      codeLensProvider: {
        resolveProvider: true,
      },

      inlayHintProvider: true,

      semanticTokensProvider: {
        full: true,
        range: true,
        legend: {
          tokenTypes: [...SolSemanticTokenTypes],
          tokenModifiers: [...SolSemanticTokenModifiers],
        },
      },

      callHierarchyProvider: true,
      typeHierarchyProvider: true,
      documentHighlightProvider: true,
      foldingRangeProvider: true,
      selectionRangeProvider: true,
      documentLinkProvider: {
        resolveProvider: false,
      },

      workspace: {
        workspaceFolders: {
          supported: true,
          changeNotifications: true,
        },
      },
    },
  };
});

connection.onInitialized(async () => {
  connection.client.register(DidChangeConfigurationNotification.type, undefined);

  // Pull initial config from the client (solidity-workbench.*) and apply.
  await refreshConfiguration();

  await workspaceManager.initialize();
  const graphRestored = graphIndex.restoreFromCache(graphCacheDir);
  if (graphRestored) {
    connection.console.log("Project graph restored from cache");
  }
  pushServerState({
    phase: "indexing",
    filesIndexed: 0,
    filesTotal: workspaceManager.getAllFileUris().length,
  });

  await symbolIndex.indexWorkspace((filesIndexed, filesTotal) => {
    pushServerState({ phase: "indexing", filesIndexed, filesTotal });
  });
  graphIndex.ensureWorkspaceDeclarations();
  graphIndex.writeCache(graphCacheDir);
  if (!graphIndex.isRelationshipIndexComplete() && shouldRunBackgroundGraphRelationshipIndex()) {
    scheduleGraphRelationshipIndex();
  }

  pushServerState({
    phase: "idle",
    rootCount: workspaceManager.rootCount,
    fileCount: workspaceManager.getAllFileUris().length,
  });

  // React to workspace folder changes (multi-root add / remove).
  connection.workspace.onDidChangeWorkspaceFolders(handleWorkspaceFoldersChanged);

  connection.console.log("Solidity Workbench LSP server initialized successfully");
});

// ── Configuration ───────────────────────────────────────────────────

async function refreshConfiguration(): Promise<boolean> {
  let dependencyModeChanged = false;
  try {
    const [config] = (await connection.workspace.getConfiguration([
      { section: "solidity-workbench" },
    ])) as [ServerSettings | null | undefined];

    currentSettings = config ?? {};
    workspaceManager.setForgePath(currentSettings.foundryPath);
    diagnosticsProvider.setDebounceMs(currentSettings.diagnostics?.debounceMs ?? 300);
    dependencyModeChanged = graphIndex.setDependencyIndexing(graphDependencyIndexingMode());
  } catch (err) {
    connection.console.warn(`workspace/configuration unavailable: ${err}`);
  }
  return dependencyModeChanged;
}

connection.onDidChangeConfiguration(async () => {
  const dependencyModeChanged = await refreshConfiguration();
  if (dependencyModeChanged) {
    cancelGraphRelationshipIndex();
    graphIndex.rebuildWorkspaceDeclarations();
    graphIndex.writeCache(graphCacheDir);
  }
  if (!shouldRunBackgroundGraphRelationshipIndex()) {
    cancelGraphRelationshipIndex();
    return;
  }
  if (!graphIndex.isRelationshipIndexComplete()) {
    scheduleGraphRelationshipIndex();
  }
});

// ── Workspace folders ───────────────────────────────────────────────

async function handleWorkspaceFoldersChanged(event: WorkspaceFoldersChangeEvent): Promise<void> {
  for (const removed of event.removed) {
    workspaceManager.removeRoot(removed.uri);
    connection.console.log(`Removed workspace root: ${removed.uri}`);
  }
  for (const added of event.added) {
    await workspaceManager.addRoot(added.uri);
    connection.console.log(`Added workspace root: ${added.uri}`);
  }

  // Rebuild the symbol + reference index over the new root set.
  await symbolIndex.indexWorkspace();
  cancelGraphRelationshipIndex();
  graphIndex.rebuildWorkspaceDeclarations();
  graphIndex.writeCache(graphCacheDir);
  if (shouldRunBackgroundGraphRelationshipIndex()) scheduleGraphRelationshipIndex();
}

// ── File System Watching ────────────────────────────────────────────

connection.onDidChangeWatchedFiles(async (params) => {
  let needsWorkspaceReload = false;
  const touchedSolFiles: string[] = [];
  const removedSolFiles: string[] = [];

  for (const change of params.changes) {
    const fsPath = URI.parse(change.uri).fsPath;
    const basename = path.basename(fsPath);

    if (basename === "foundry.toml" || basename === "remappings.txt") {
      needsWorkspaceReload = true;
      continue;
    }

    if (!fsPath.endsWith(".sol")) continue;
    if (documents.get(change.uri)) continue;

    if (change.type === FileChangeType.Deleted) {
      removedSolFiles.push(change.uri);
    } else {
      touchedSolFiles.push(change.uri);
    }
  }

  if (needsWorkspaceReload) {
    connection.console.log("foundry.toml or remappings.txt changed — reloading workspace");
    await workspaceManager.initialize();
    semanticResolver.invalidate();
    await symbolIndex.indexWorkspace();
    cancelGraphRelationshipIndex();
    graphIndex.rebuildWorkspaceDeclarations();
    graphIndex.writeCache(graphCacheDir);
    if (shouldRunBackgroundGraphRelationshipIndex()) scheduleGraphRelationshipIndex();
    return;
  }

  for (const uri of removedSolFiles) {
    solcBridge.invalidateFile(URI.parse(uri).fsPath);
    parser.removeFile(uri);
    symbolIndex.removeFile(uri);
    for (const refreshedUri of graphIndex.removeFileAndDependents(uri, false)) {
      callHierarchyProvider.invalidateFile(refreshedUri);
    }
    connection.sendDiagnostics({ uri, diagnostics: [] });
  }

  for (const uri of touchedSolFiles) {
    solcBridge.invalidateFile(URI.parse(uri).fsPath);
    await symbolIndex.indexFile(uri);
    semanticResolver.invalidate();
    for (const refreshedUri of graphIndex.updateFileAndDependents(uri, false)) {
      callHierarchyProvider.invalidateFile(refreshedUri);
    }
  }
  if (removedSolFiles.length > 0 || touchedSolFiles.length > 0) {
    graphIndex.writeCache(graphCacheDir);
    if (
      (removedSolFiles.length > 0 || touchedSolFiles.length > 0) &&
      shouldRunBackgroundGraphRelationshipIndex()
    ) {
      scheduleGraphRelationshipIndex();
    }
  }
});

// ── Document Lifecycle ──────────────────────────────────────────────

documents.onDidChangeContent(async (change) => {
  const uri = change.document.uri;
  const text = change.document.getText();

  solcBridge.invalidateFile(URI.parse(uri).fsPath);
  parser.parse(uri, text);
  symbolIndex.updateFile(uri);
  semanticResolver.invalidate();
  for (const refreshedUri of graphIndex.updateFileAndDependents(uri, false)) {
    callHierarchyProvider.invalidateFile(refreshedUri);
  }
  if (shouldRunBackgroundGraphRelationshipIndex()) scheduleGraphRelationshipIndex();

  // Eagerly index the document's transitive import graph so hover,
  // inlay hints, definition, etc. can resolve symbols across the
  // import tree without waiting for the bulk workspace sweep to
  // reach `lib/`. Fire-and-forget — the diagnostics path below
  // shouldn't block on dep-tree indexing.
  void symbolIndex
    .ensureImportsIndexed(uri, new Set(), (indexedUri) => graphIndex.updateFile(indexedUri, false))
    .catch((err) => {
      connection.console.warn(`ensureImportsIndexed(${uri}) failed: ${err}`);
    });

  await diagnosticsProvider.provideFastDiagnostics(uri, text);
});

documents.onDidSave(async (event) => {
  if (currentSettings.diagnostics?.compileOnSave === false) return;

  pushServerState({ phase: "building" });
  const startedAt = Date.now();
  const { errorCount, warningCount } = await diagnosticsProvider.provideFullDiagnostics(
    event.document.uri,
  );
  pushServerState({
    phase: "build-result",
    success: errorCount === 0,
    errorCount,
    warningCount,
    durationMs: Date.now() - startedAt,
  });

  solcBridge.buildAndExtractAst().catch((err) => {
    connection.console.error(`solc AST extraction failed: ${err}`);
  });
  graphIndex.writeCache(graphCacheDir);
});

documents.onDidClose((event) => {
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

// ── LSP Request Handlers ────────────────────────────────────────────

connection.onCompletion(async (params, token): Promise<CompletionItem[]> => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  if (token.isCancellationRequested) return [];
  return completionProvider.provideCompletions(doc, params.position);
});

connection.onCompletionResolve(async (item: CompletionItem): Promise<CompletionItem> => {
  return completionProvider.resolveCompletion(item);
});

connection.onDefinition(async (params, token) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  if (token.isCancellationRequested) return null;
  return definitionProvider.provideDefinition(doc, params.position);
});

connection.onTypeDefinition(async (params, token) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  if (token.isCancellationRequested) return null;
  return definitionProvider.provideTypeDefinition(doc, params.position);
});

connection.onImplementation(async (params, token) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  if (token.isCancellationRequested) return null;
  return implementationProvider.provideImplementation(doc, params.position);
});

connection.onReferences(async (params, token) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  return referencesProvider.provideReferences(doc, params.position, params.context, token);
});

connection.onHover(async (params, token): Promise<Hover | null> => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  if (token.isCancellationRequested) return null;
  return hoverProvider.provideHover(doc, params.position);
});

connection.onDocumentSymbol(async (params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  return documentSymbolProvider.provideDocumentSymbols(doc);
});

connection.onWorkspaceSymbol(async (params, token) => {
  return symbolIndex.findWorkspaceSymbols(params.query, token);
});

connection.onCodeAction(async (params, token): Promise<CodeAction[]> => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  if (token.isCancellationRequested) return [];
  const actions = codeActionsProvider.provideCodeActions(doc, params.range, params.context);
  const importActions = autoImportProvider.provideImportActions(
    doc,
    params.context.diagnostics,
    params.range,
  );
  return [...actions, ...importActions];
});

connection.onDocumentFormatting(async (params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  return formattingProvider.format(doc, params.options);
});

connection.onDocumentRangeFormatting(async (params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  return formattingProvider.formatRange(doc, params.range, params.options);
});

connection.languages.semanticTokens.on(async (params, token) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return { data: [] };
  return semanticTokensProvider.provideSemanticTokens(doc, token);
});

connection.languages.semanticTokens.onRange(async (params, token) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return { data: [] };
  return semanticTokensProvider.provideSemanticTokensRange(doc, params.range, token);
});

// ── Inlay Hints ─────────────────────────────────────────────────────

connection.languages.inlayHint.on(async (params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  // Respect the client's preference. If parameter-name hints are off,
  // return early to skip the per-line scan entirely.
  if (currentSettings.inlayHints?.parameterNames === false) return [];
  return inlayHintsProvider.provideInlayHints(doc, params.range);
});

// ── Signature Help ──────────────────────────────────────────────────

connection.onSignatureHelp(async (params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  return signatureHelpProvider.provideSignatureHelp(doc, params.position);
});

// ── Rename ──────────────────────────────────────────────────────────

connection.onPrepareRename(async (params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  return renameProvider.prepareRename(doc, params.position);
});

connection.onRenameRequest(async (params, token) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  return renameProvider.provideRename(doc, params.position, params.newName, token);
});

// ── Code Lens ───────────────────────────────────────────────────────

connection.onCodeLens(async (params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  if (currentSettings.gasEstimates?.enabled === false) {
    // Still return non-gas lenses (refs, selectors, run-test).
    return codeLensProvider.provideCodeLenses(doc, { suppressGas: true });
  }
  return codeLensProvider.provideCodeLenses(doc);
});

connection.onCodeLensResolve(async (codeLens) => {
  return codeLensProvider.resolveCodeLens(codeLens);
});

// ── Call Hierarchy ──────────────────────────────────────────────────

connection.languages.callHierarchy.onPrepare(async (params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  return callHierarchyProvider.prepareCallHierarchy(doc, params.position);
});

connection.languages.callHierarchy.onIncomingCalls(async (params, token) => {
  return callHierarchyProvider.getIncomingCalls(params.item, token);
});

connection.languages.callHierarchy.onOutgoingCalls(async (params, token) => {
  return callHierarchyProvider.getOutgoingCalls(params.item, token);
});

// ── Type Hierarchy ──────────────────────────────────────────────────

connection.languages.typeHierarchy.onPrepare(async (params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  return typeHierarchyProvider.prepareTypeHierarchy(doc, params.position);
});

connection.languages.typeHierarchy.onSupertypes(async (params) => {
  return typeHierarchyProvider.getSupertypes(params.item);
});

connection.languages.typeHierarchy.onSubtypes(async (params) => {
  return typeHierarchyProvider.getSubtypes(params.item);
});

// ── Document Highlight ──────────────────────────────────────────────

connection.onDocumentHighlight(async (params, token) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  if (token.isCancellationRequested) return [];
  return documentHighlightProvider.provideDocumentHighlights(doc, params.position);
});

connection.onFoldingRanges(async (params, token) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  if (token.isCancellationRequested) return [];
  return foldingRangesProvider.provideFoldingRanges(doc);
});

connection.onSelectionRanges(async (params, token) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  if (token.isCancellationRequested) return [];
  return selectionRangesProvider.provideSelectionRanges(doc, params.positions);
});

connection.onDocumentLinks(async (params, token) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  if (token.isCancellationRequested) return [];
  return documentLinksProvider.provideDocumentLinks(doc);
});

// ── Custom requests ─────────────────────────────────────────────────

connection.onRequest(ListTests, async (params: ListTestsParams): Promise<ListTestsResult> => {
  return listTests(workspaceManager, parser, params);
});

connection.onRequest(
  GetInheritanceGraph,
  async (params: GetInheritanceGraphParams): Promise<InheritanceGraphResult> => {
    return inheritanceGraphProvider.provideInheritanceGraph(params);
  },
);

async function measureProjectGraphRequest<T>(
  kind: ProjectGraphMeasuredRequestKind,
  fn: () => T | Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    graphIndex.recordRequestDuration(kind, Date.now() - startedAt);
  }
}

connection.onRequest(
  GetProjectGraph,
  async (params: GetProjectGraphParams = {}): Promise<ProjectGraphResult> => {
    return measureProjectGraphRequest("graph", () =>
      graphIndex.toProjectGraph(
        params.edgeKinds,
        params.maxNodes,
        params.includeTests,
        params.includeDependencies,
      ),
    );
  },
);

connection.onRequest(
  GetProjectGraphNeighborhood,
  async (params: GetProjectGraphNeighborhoodParams): Promise<ProjectGraphResult> => {
    return measureProjectGraphRequest("neighborhood", () => {
      if (params.uri) graphIndex.ensureFileRelationships(params.uri);
      return graphIndex.toNeighborhood(params);
    });
  },
);

connection.onRequest(
  GetProjectGraphPath,
  async (params: GetProjectGraphPathParams): Promise<ProjectGraphPathResult> => {
    return measureProjectGraphRequest("path", () => {
      if (params.from.uri) graphIndex.ensureFileRelationships(params.from.uri);
      if (params.to.uri) graphIndex.ensureFileRelationships(params.to.uri);
      return graphIndex.toShortestPath(params);
    });
  },
);

connection.onRequest(
  SearchProjectGraph,
  async (params: SearchProjectGraphParams): Promise<ProjectGraphSearchResult> => {
    return measureProjectGraphRequest("search", () => {
      graphIndex.ensureWorkspaceDeclarations();
      return graphIndex.search(params);
    });
  },
);

connection.onRequest(
  QueryProjectGraph,
  async (
    params: QueryProjectGraphParams,
    token?: CancellationToken,
  ): Promise<ProjectGraphQueryResult> => {
    return measureProjectGraphRequest("query", async () => {
      graphIndex.ensureWorkspaceDeclarations();
      if (params.target?.uri) graphIndex.ensureFileRelationships(params.target.uri);
      if (shouldDrainRelationshipsForGraphQuery(params.kind, graphRelationshipIndexingMode())) {
        await drainGraphRelationshipIndexForQuery(token);
        if (token?.isCancellationRequested) {
          const stats = graphIndex.getStats();
          return {
            nodes: [],
            edges: [],
            kind: params.kind,
            query: params.query,
            found: false,
            missReason: "targetNotFound",
            indexStatus: {
              relationshipIndexComplete: stats.relationshipIndexComplete,
              relationshipFilesIndexed: stats.relationshipFilesIndexed,
              relationshipFilesTotal: stats.relationshipFilesTotal,
              pendingRelationshipFiles: stats.pendingRelationshipFiles,
              partial: stats.relationshipIndexComplete !== true,
            },
            edgeQuality: {
              edgesByResolutionConfidence: {},
              unresolvedEdgeCount: 0,
              lowConfidenceEdgeCount: 0,
            },
          };
        }
      }
      return graphIndex.query(params);
    });
  },
);

connection.onRequest(GetProjectGraphStats, async (): Promise<ProjectGraphStatsResult> => {
  return measureProjectGraphRequest("stats", () => graphIndex.getStats());
});

connection.onRequest(
  RebuildProjectGraph,
  async (
    params: RebuildProjectGraphParams = {},
    token?: CancellationToken,
  ): Promise<ProjectGraphStatsResult> => {
    return measureProjectGraphRequest("rebuild", async () => {
      cancelGraphRelationshipIndex();
      await workspaceManager.initialize();
      semanticResolver.invalidate();
      await symbolIndex.indexWorkspace();
      graphIndex.rebuildWorkspaceDeclarations();

      if (shouldRunExplicitGraphRelationshipIndex(params)) {
        let complete = false;
        let canceled = false;
        while (!complete) {
          if (token?.isCancellationRequested) {
            canceled = true;
            break;
          }
          complete = graphIndex.indexRelationshipBatch(50, 50).complete;
          // Drain the relationship queue for explicit, user-triggered rebuilds.
        }
        graphIndex.writeCache(graphCacheDir);
        return { ...graphIndex.getStats(), rebuildCanceled: canceled };
      }

      graphIndex.writeCache(graphCacheDir);
      if (
        params.relationships !== "declarationsOnly" &&
        !graphIndex.isRelationshipIndexComplete() &&
        shouldRunBackgroundGraphRelationshipIndex()
      ) {
        scheduleGraphRelationshipIndex();
      }
      return graphIndex.getStats();
    });
  },
);

// ── Shutdown ────────────────────────────────────────────────────────

connection.onShutdown(async () => {
  cancelGraphRelationshipIndex();
  if (parserPool) {
    await parserPool.terminate();
    parserPool = null;
  }
});

// ── Parser pool factory ─────────────────────────────────────────────

/**
 * Locate the bundled `parser-worker.js` and start a pool sized to half
 * the available CPUs (min 1, max 6 — beyond that the structured-clone
 * cost on the message channel starts to dominate the parse cost).
 *
 * Returns `null` if the worker bundle isn't where we expect or `Worker`
 * construction throws. The parser falls back to synchronous main-thread
 * parsing, which is the pre-pool behaviour — slower for cold-start
 * indexing but functionally identical otherwise.
 */
function createParserPool(): ParserPool | null {
  const workerPath = path.resolve(__dirname, "parser-worker.js");
  if (!fs.existsSync(workerPath)) {
    connection.console.warn(
      `Parser worker bundle not found at ${workerPath}; falling back to single-threaded parsing`,
    );
    return null;
  }
  const cpuCount = Math.max(1, os.cpus()?.length ?? 1);
  const size = Math.max(1, Math.min(6, Math.floor(cpuCount / 2)));
  try {
    const pool = new ParserPool(workerPath, size);
    connection.console.log(`Parser worker pool started with ${size} worker(s)`);
    return pool;
  } catch (err) {
    connection.console.warn(
      `Failed to start parser worker pool, falling back to single-threaded parsing: ${err}`,
    );
    return null;
  }
}

// ── Start ───────────────────────────────────────────────────────────

documents.listen(connection);
connection.listen();
