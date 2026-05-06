import * as path from "node:path";
import * as vscode from "vscode";
import { LanguageClient, TransportKind } from "vscode-languageclient/node";
import type { LanguageClientOptions, ServerOptions } from "vscode-languageclient/node";
import { registerFoundryCommands } from "./commands/foundry.js";
import { AnvilManager, registerAnvilCommands } from "./commands/anvil.js";
import { AnvilInstancesProvider } from "./views/anvil-instances.js";
import { registerCastCommands } from "./commands/cast.js";
import { registerScriptCommands } from "./commands/script.js";
import { registerDeployCommands } from "./commands/deploy.js";
import { registerIndexerCommands } from "./commands/indexer.js";
import { FoundryTestProvider } from "./test-explorer/test-provider.js";
import { GasProfilerProvider } from "./views/gas-profiler.js";
import { CoverageProvider } from "./views/coverage.js";
import { StorageLayoutPanel } from "./views/storage-layout.js";
import { SlitherIntegration } from "./analysis/slither.js";
import { AderynIntegration } from "./analysis/aderyn.js";
import { WakeIntegration } from "./analysis/wake.js";
import { MythrilIntegration } from "./analysis/mythril.js";
import { SolidityDebugProvider } from "./debugger/debug-adapter.js";
import {
  SolidityDapAdapterFactory,
  SolidityDapConfigurationProvider,
} from "./debugger/dap-adapter.js";
import { ChiselPanel } from "./views/chisel-panel.js";
import { FoundryTomlProvider } from "./views/foundry-toml-schema.js";
import { StatusBar } from "./views/status-bar.js";
import { InheritanceGraphPanel } from "./views/inheritance-graph.js";
import { AbiPanel } from "./views/abi-panel.js";
import { GasDiffProvider } from "./views/gas-diff.js";
import { RemoteChainPanel } from "./views/remote-chain.js";
import { IrViewerPanel } from "./views/ir-viewer.js";

let client: LanguageClient;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // ── LSP Server ───────────────────────────────────────────────────

  const serverModule = context.asAbsolutePath(path.join("dist", "server.js"));

  const serverOptions: ServerOptions = {
    run: {
      module: serverModule,
      transport: TransportKind.stdio,
    },
    debug: {
      module: serverModule,
      transport: TransportKind.stdio,
      options: { execArgv: ["--nolazy", "--inspect=6009"] },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "solidity" }],
    synchronize: {
      fileEvents: [
        vscode.workspace.createFileSystemWatcher("**/*.sol"),
        vscode.workspace.createFileSystemWatcher("**/foundry.toml"),
        vscode.workspace.createFileSystemWatcher("**/remappings.txt"),
        vscode.workspace.createFileSystemWatcher("**/.gas-snapshot"),
      ],
    },
    outputChannelName: "Solidity Workbench",
  };

  client = new LanguageClient(
    "solidity-workbench",
    "Solidity Workbench Language Server",
    serverOptions,
    clientOptions,
  );

  await client.start();

  // ── Status bar (subscribes to serverState notifications) ──────────

  const statusBar = new StatusBar();
  statusBar.activate(context, client);

  // ── Commands ──────────────────────────────────────────────────────

  registerFoundryCommands(context);

  const anvilManager = new AnvilManager();
  anvilManager.onInstanceChange((instances) => {
    const running = instances.filter((i) => i.status === "running" || i.status === "starting");
    const forked = running.filter((i) => !!i.config.forkUrl);
    statusBar.setAnvilInstances(running.length, forked.length);
  });
  registerAnvilCommands(context, anvilManager);

  const anvilTree = new AnvilInstancesProvider(anvilManager);
  anvilTree.activate(context);

  registerCastCommands(context);
  registerScriptCommands(context);
  registerDeployCommands(context);
  registerIndexerCommands(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("solidity-workbench.restartServer", async () => {
      await client.restart();
      vscode.window.showInformationMessage("Solidity Workbench language server restarted.");
    }),
  );

  // Client-side shim for the "N references" code lens. LSP sends URIs
  // over the wire as strings, but VSCode's `editor.action.findReferences`
  // command expects a proper `vscode.Uri` instance (passing a string
  // raises "unexpected type"). This shim converts the wire arguments
  // into the types the editor command requires.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "solidity-workbench.findReferencesAt",
      async (uri: string, position: { line: number; character: number }) => {
        if (typeof uri !== "string" || !position) return;
        await vscode.commands.executeCommand(
          "editor.action.findReferences",
          vscode.Uri.parse(uri),
          new vscode.Position(position.line, position.character),
        );
      },
    ),
  );

  // ── Test Explorer ─────────────────────────────────────────────────

  const testProvider = new FoundryTestProvider();
  testProvider.activate(context);
  testProvider.setLanguageClient(client);

  // ── Gas Profiler ──────────────────────────────────────────────────

  const gasProfiler = new GasProfilerProvider();
  gasProfiler.activate(context);

  // ── Coverage ──────────────────────────────────────────────────────

  const coverage = new CoverageProvider();
  coverage.onCoverageChange((pct) => statusBar.setCoverage(pct));
  coverage.activate(context);

  // ── Storage Layout ────────────────────────────────────────────────

  const storageLayout = new StorageLayoutPanel();
  storageLayout.activate(context);

  // ── Debugger ──────────────────────────────────────────────────────

  const debugProvider = new SolidityDebugProvider();
  debugProvider.activate(context);

  // DAP adapter scaffold — registers the `solidity-workbench` debug
  // type so VSCode's "Run and Debug" panel can launch it. Stage 1
  // is plumbing only; trace ingestion lands in subsequent commits.
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory(
      "solidity-workbench",
      new SolidityDapAdapterFactory(),
    ),
    vscode.debug.registerDebugConfigurationProvider(
      "solidity-workbench",
      new SolidityDapConfigurationProvider(),
    ),
  );

  // ── Chisel REPL ───────────────────────────────────────────────────

  const chisel = new ChiselPanel();
  chisel.activate(context);

  // ── Foundry.toml IntelliSense ─────────────────────────────────────

  const foundryToml = new FoundryTomlProvider();
  foundryToml.activate(context);

  // ── Inheritance Graph ──────────────────────────────────────────────

  const inheritanceGraph = new InheritanceGraphPanel(client);
  inheritanceGraph.activate(context);

  // ── ABI Explorer ─────────────────────────────────────────────────

  const abiPanel = new AbiPanel();
  abiPanel.activate(context);

  // ── Gas Diff ──────────────────────────────────────────────────────

  const gasDiff = new GasDiffProvider();
  gasDiff.activate(context);

  // ── Remote Chain UI ───────────────────────────────────────────────

  const remoteChain = new RemoteChainPanel();
  remoteChain.activate(context);

  // ── IR Viewer ─────────────────────────────────────────────────────

  const irViewer = new IrViewerPanel();
  irViewer.activate(context);

  // ── Static Analysis ───────────────────────────────────────────────

  const slither = new SlitherIntegration();
  context.subscriptions.push({ dispose: () => slither.dispose() });

  context.subscriptions.push(
    vscode.commands.registerCommand("solidity-workbench.slither", () => slither.analyze()),
  );

  const aderyn = new AderynIntegration();
  context.subscriptions.push({ dispose: () => aderyn.dispose() });

  context.subscriptions.push(
    vscode.commands.registerCommand("solidity-workbench.aderyn", () => aderyn.analyze()),
  );

  const wake = new WakeIntegration();
  context.subscriptions.push({ dispose: () => wake.dispose() });

  context.subscriptions.push(
    vscode.commands.registerCommand("solidity-workbench.wake", () => wake.analyze()),
  );

  const mythril = new MythrilIntegration();
  context.subscriptions.push({ dispose: () => mythril.dispose() });

  context.subscriptions.push(
    vscode.commands.registerCommand("solidity-workbench.mythril", () => mythril.analyze()),
  );

  // Opt-in on-save hooks for the optional analyzers. Each analyzer
  // bails internally when its own `enabled` setting is false, so the
  // handler just unconditionally delegates. Mythril runs against
  // the saved file specifically (per-file analysis) where the
  // others run against the whole workspace.
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId !== "solidity") return;
      const config = vscode.workspace.getConfiguration("solidity-workbench");
      if (config.get<boolean>("slither.enabled")) slither.analyze();
      if (config.get<boolean>("aderyn.enabled")) aderyn.analyze();
      if (config.get<boolean>("wake.enabled")) wake.analyze();
      if (config.get<boolean>("mythril.enabled")) mythril.analyze(doc.uri);
    }),
  );

  // ── Output Channel ────────────────────────────────────────────────

  const outputChannel = vscode.window.createOutputChannel("Solidity Workbench", {
    log: true,
  });
  context.subscriptions.push(outputChannel);
  outputChannel.info("Solidity Workbench activated");
}

export async function deactivate(): Promise<void> {
  // The ChiselPanel disposes itself via context.subscriptions, which
  // VSCode runs as part of extension teardown — that path also fires
  // its SIGTERM/SIGKILL chain on the chisel subprocess. Nothing
  // additional to do here; just stop the LSP client.
  if (client) {
    await client.stop();
  }
}
