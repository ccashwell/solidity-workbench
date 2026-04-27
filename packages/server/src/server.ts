import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  CompletionItem,
  Hover,
  DidChangeConfigurationNotification,
  CodeAction,
  FileChangeType,
  WorkspaceFoldersChangeEvent,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import * as path from "node:path";
import { WorkspaceManager } from "./workspace/workspace-manager.js";
import { SolidityParser } from "./parser/solidity-parser.js";
import { SymbolIndex } from "./analyzer/symbol-index.js";
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
import { SolcBridge } from "./compiler/solc-bridge.js";
import { listTests } from "./providers/list-tests.js";
import {
  SolSemanticTokenTypes,
  SolSemanticTokenModifiers,
  ServerStateNotification,
  ListTests,
  type ListTestsParams,
  type ListTestsResult,
  type ServerStateParams,
} from "@solidity-workbench/common";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

// Core services
let workspaceManager: WorkspaceManager;
let parser: SolidityParser;
let symbolIndex: SymbolIndex;

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
}

let currentSettings: ServerSettings = {};

export function getServerSettings(): ServerSettings {
  return currentSettings;
}

function pushServerState(params: ServerStateParams): void {
  connection.sendNotification(ServerStateNotification, params);
}

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const initialFolder = params.workspaceFolders?.[0]?.uri ?? params.rootUri ?? "";

  workspaceManager = new WorkspaceManager(initialFolder, connection);

  // Register every additional workspace folder the client sent.
  for (const folder of params.workspaceFolders ?? []) {
    if (folder.uri !== initialFolder) {
      void workspaceManager.addRoot(folder.uri);
    }
  }

  parser = new SolidityParser();
  symbolIndex = new SymbolIndex(parser, workspaceManager);

  completionProvider = new CompletionProvider(symbolIndex, workspaceManager);
  definitionProvider = new DefinitionProvider(symbolIndex, workspaceManager);
  hoverProvider = new HoverProvider(symbolIndex, parser);
  diagnosticsProvider = new DiagnosticsProvider(workspaceManager, connection, documents);
  diagnosticsProvider.setParser(parser);
  semanticTokensProvider = new SemanticTokensProvider(parser);
  codeActionsProvider = new CodeActionsProvider(symbolIndex, parser);
  formattingProvider = new FormattingProvider(workspaceManager);
  documentSymbolProvider = new DocumentSymbolProvider(parser);
  inlayHintsProvider = new InlayHintsProvider(symbolIndex, parser);
  signatureHelpProvider = new SignatureHelpProvider(symbolIndex, parser);
  renameProvider = new RenameProvider(symbolIndex, workspaceManager, documents);
  codeLensProvider = new CodeLensProvider(symbolIndex, parser, workspaceManager);
  referencesProvider = new ReferencesProvider(symbolIndex, workspaceManager, parser, documents);
  autoImportProvider = new AutoImportProvider(symbolIndex, workspaceManager, parser);
  callHierarchyProvider = new CallHierarchyProvider(symbolIndex, workspaceManager, parser);
  typeHierarchyProvider = new TypeHierarchyProvider(symbolIndex, parser);
  documentHighlightProvider = new DocumentHighlightProvider(symbolIndex, parser);
  solcBridge = new SolcBridge(workspaceManager);

  // Make the type-resolved AST cache available to providers that want it
  // for overload disambiguation, member resolution, canonical selector
  // lookup, and scope-aware local-variable rename.
  hoverProvider.setSolcBridge(solcBridge);
  definitionProvider.setSolcBridge(solcBridge);
  completionProvider.setSolcBridge(solcBridge);
  codeLensProvider.setSolcBridge(solcBridge);
  renameProvider.setSolcBridge(solcBridge);

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
  pushServerState({
    phase: "indexing",
    filesIndexed: 0,
    filesTotal: workspaceManager.getAllFileUris().length,
  });

  await symbolIndex.indexWorkspace((filesIndexed, filesTotal) => {
    pushServerState({ phase: "indexing", filesIndexed, filesTotal });
  });

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

async function refreshConfiguration(): Promise<void> {
  try {
    const [config] = (await connection.workspace.getConfiguration([
      { section: "solidity-workbench" },
    ])) as [ServerSettings | null | undefined];

    currentSettings = config ?? {};
    workspaceManager.setForgePath(currentSettings.foundryPath);
    diagnosticsProvider.setDebounceMs(currentSettings.diagnostics?.debounceMs ?? 300);
  } catch (err) {
    connection.console.warn(`workspace/configuration unavailable: ${err}`);
  }
}

connection.onDidChangeConfiguration(async () => {
  await refreshConfiguration();
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
  pushServerState({
    phase: "idle",
    rootCount: workspaceManager.rootCount,
    fileCount: workspaceManager.getAllFileUris().length,
  });
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
    await symbolIndex.indexWorkspace();
    pushServerState({
      phase: "idle",
      rootCount: workspaceManager.rootCount,
      fileCount: workspaceManager.getAllFileUris().length,
    });
    return;
  }

  for (const uri of removedSolFiles) {
    symbolIndex.onFileClosed(uri);
    callHierarchyProvider.invalidateFile(uri);
    connection.sendDiagnostics({ uri, diagnostics: [] });
  }

  for (const uri of touchedSolFiles) {
    await symbolIndex.indexFile(uri);
    callHierarchyProvider.invalidateFile(uri);
  }
});

// ── Document Lifecycle ──────────────────────────────────────────────

documents.onDidChangeContent(async (change) => {
  const uri = change.document.uri;
  const text = change.document.getText();

  parser.parse(uri, text);
  symbolIndex.updateFile(uri);
  callHierarchyProvider.invalidateFile(uri);

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

// ── Custom requests ─────────────────────────────────────────────────

connection.onRequest(ListTests, async (params: ListTestsParams): Promise<ListTestsResult> => {
  return listTests(workspaceManager, parser, params);
});

// ── Start ───────────────────────────────────────────────────────────

documents.listen(connection);
connection.listen();
