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
  SemanticTokensBuilder,
  CodeAction,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
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
import { SolcBridge } from "./compiler/solc-bridge.js";
import {
  SolSemanticTokenTypes,
  SolSemanticTokenModifiers,
} from "@solforge/common";

// Create the LSP connection and document manager
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
let solcBridge: SolcBridge;

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const workspaceFolders = params.workspaceFolders ?? [];
  const rootUri = workspaceFolders[0]?.uri ?? params.rootUri ?? "";

  // Initialize core services
  workspaceManager = new WorkspaceManager(rootUri, connection);
  parser = new SolidityParser();
  symbolIndex = new SymbolIndex(parser, workspaceManager);

  // Initialize providers
  completionProvider = new CompletionProvider(symbolIndex, workspaceManager);
  definitionProvider = new DefinitionProvider(symbolIndex, workspaceManager);
  hoverProvider = new HoverProvider(symbolIndex, parser);
  diagnosticsProvider = new DiagnosticsProvider(
    workspaceManager,
    connection,
    documents,
  );
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
  solcBridge = new SolcBridge(workspaceManager);

  connection.console.log(
    `Solforge LSP server initializing for workspace: ${rootUri}`,
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
      implementationProvider: true,

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
        codeActionKinds: [
          "quickfix",
          "refactor",
          "refactor.extract",
          "source.organizeImports",
        ],
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
  // Register for configuration changes
  connection.client.register(
    DidChangeConfigurationNotification.type,
    undefined,
  );

  // Index the workspace
  await workspaceManager.initialize();
  await symbolIndex.indexWorkspace();

  connection.console.log("Solforge LSP server initialized successfully");
});

// ── Document Lifecycle ───────────────────────────────────────────────

documents.onDidChangeContent(async (change) => {
  // Re-parse the changed document
  const uri = change.document.uri;
  const text = change.document.getText();

  parser.parse(uri, text);
  symbolIndex.updateFile(uri);

  // Provide fast diagnostics from parser
  await diagnosticsProvider.provideFastDiagnostics(uri, text);
});

documents.onDidSave(async (event) => {
  // Trigger forge build for full diagnostics on save
  await diagnosticsProvider.provideFullDiagnostics(event.document.uri);

  // Update the rich AST from solc (type-resolved analysis)
  solcBridge.buildAndExtractAst().catch((err) => {
    connection.console.error(`solc AST extraction failed: ${err}`);
  });
});

documents.onDidClose((event) => {
  // Clean up diagnostics for closed files
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

// ── LSP Request Handlers ─────────────────────────────────────────────

connection.onCompletion(async (params): Promise<CompletionItem[]> => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  return completionProvider.provideCompletions(doc, params.position);
});

connection.onCompletionResolve(
  async (item: CompletionItem): Promise<CompletionItem> => {
    return completionProvider.resolveCompletion(item);
  },
);

connection.onDefinition(async (params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  return definitionProvider.provideDefinition(doc, params.position);
});

connection.onTypeDefinition(async (params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  return definitionProvider.provideTypeDefinition(doc, params.position);
});

connection.onReferences(async (params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  return referencesProvider.provideReferences(doc, params.position, params.context);
});

connection.onHover(async (params): Promise<Hover | null> => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  return hoverProvider.provideHover(doc, params.position);
});

connection.onDocumentSymbol(async (params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  return documentSymbolProvider.provideDocumentSymbols(doc);
});

connection.onWorkspaceSymbol(async (params) => {
  return symbolIndex.findWorkspaceSymbols(params.query);
});

connection.onCodeAction(async (params): Promise<CodeAction[]> => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const actions = codeActionsProvider.provideCodeActions(doc, params.range, params.context);
  // Append auto-import actions from diagnostics
  const importActions = autoImportProvider.provideImportActions(doc, params.context.diagnostics);
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

connection.languages.semanticTokens.on(async (params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return { data: [] };
  return semanticTokensProvider.provideSemanticTokens(doc);
});

connection.languages.semanticTokens.onRange(async (params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return { data: [] };
  return semanticTokensProvider.provideSemanticTokensRange(doc, params.range);
});

// ── Inlay Hints ──────────────────────────────────────────────────────

connection.languages.inlayHint.on(async (params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  return inlayHintsProvider.provideInlayHints(doc, params.range);
});

// ── Signature Help ───────────────────────────────────────────────────

connection.onSignatureHelp(async (params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  return signatureHelpProvider.provideSignatureHelp(doc, params.position);
});

// ── Rename ───────────────────────────────────────────────────────────

connection.onPrepareRename(async (params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  return renameProvider.prepareRename(doc, params.position);
});

connection.onRenameRequest(async (params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  return renameProvider.provideRename(doc, params.position, params.newName);
});

// ── Code Lens ────────────────────────────────────────────────────────

connection.onCodeLens(async (params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  return codeLensProvider.provideCodeLenses(doc);
});

connection.onCodeLensResolve(async (codeLens) => {
  return codeLensProvider.resolveCodeLens(codeLens);
});

// ── Call Hierarchy ───────────────────────────────────────────────────

connection.languages.callHierarchy.onPrepare(async (params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  return callHierarchyProvider.prepareCallHierarchy(doc, params.position);
});

connection.languages.callHierarchy.onIncomingCalls(async (params) => {
  return callHierarchyProvider.getIncomingCalls(params.item);
});

connection.languages.callHierarchy.onOutgoingCalls(async (params) => {
  return callHierarchyProvider.getOutgoingCalls(params.item);
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

// ── Start ────────────────────────────────────────────────────────────

documents.listen(connection);
connection.listen();
