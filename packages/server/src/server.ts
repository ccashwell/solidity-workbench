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
  semanticTokensProvider = new SemanticTokensProvider(parser);
  codeActionsProvider = new CodeActionsProvider(symbolIndex, parser);
  formattingProvider = new FormattingProvider(workspaceManager);
  documentSymbolProvider = new DocumentSymbolProvider(parser);

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
  return definitionProvider.provideReferences(doc, params.position);
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
  return codeActionsProvider.provideCodeActions(doc, params.range, params.context);
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

// ── Start ────────────────────────────────────────────────────────────

documents.listen(connection);
connection.listen();
