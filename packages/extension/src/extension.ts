import * as path from "node:path";
import * as vscode from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";
import { registerFoundryCommands } from "./commands/foundry.js";
import { registerAnvilCommands } from "./commands/anvil.js";
import { registerCastCommands } from "./commands/cast.js";
import { registerScriptCommands } from "./commands/script.js";
import { registerDeployCommands } from "./commands/deploy.js";
import { FoundryTestProvider } from "./test-explorer/test-provider.js";
import { GasProfilerProvider } from "./views/gas-profiler.js";
import { CoverageProvider } from "./views/coverage.js";
import { StorageLayoutPanel } from "./views/storage-layout.js";
import { SlitherIntegration } from "./analysis/slither.js";
import { SolidityDebugProvider } from "./debugger/debug-adapter.js";
import { ChiselIntegration } from "./views/chisel.js";
import { FoundryTomlProvider } from "./views/foundry-toml-schema.js";
import { InheritanceGraphPanel } from "./views/inheritance-graph.js";
import { AbiPanel } from "./views/abi-panel.js";
import { GasDiffProvider } from "./views/gas-diff.js";

let client: LanguageClient;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // ── LSP Server ───────────────────────────────────────────────────

  const serverModule = context.asAbsolutePath(
    path.join("node_modules", "@solforge", "server", "dist", "server.js"),
  );

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
    outputChannelName: "Solforge",
  };

  client = new LanguageClient("solforge", "Solforge Language Server", serverOptions, clientOptions);

  // Start the client (which also starts the server)
  await client.start();

  // ── Commands ──────────────────────────────────────────────────────

  registerFoundryCommands(context);
  registerAnvilCommands(context);
  registerCastCommands(context);
  registerScriptCommands(context);
  registerDeployCommands(context);

  // Restart server command
  context.subscriptions.push(
    vscode.commands.registerCommand("solforge.restartServer", async () => {
      await client.restart();
      vscode.window.showInformationMessage("Solforge language server restarted.");
    }),
  );

  // ── Test Explorer ─────────────────────────────────────────────────

  const testProvider = new FoundryTestProvider();
  testProvider.activate(context);

  // ── Gas Profiler ──────────────────────────────────────────────────

  const gasProfiler = new GasProfilerProvider();
  gasProfiler.activate(context);

  // ── Coverage ──────────────────────────────────────────────────────

  const coverage = new CoverageProvider();
  coverage.activate(context);

  // ── Storage Layout ────────────────────────────────────────────────

  const storageLayout = new StorageLayoutPanel();
  storageLayout.activate(context);

  // ── Debugger ──────────────────────────────────────────────────────

  const debugProvider = new SolidityDebugProvider();
  debugProvider.activate(context);

  // ── Chisel REPL ───────────────────────────────────────────────────

  const chisel = new ChiselIntegration();
  chisel.activate(context);

  // ── Foundry.toml IntelliSense ─────────────────────────────────────

  const foundryToml = new FoundryTomlProvider();
  foundryToml.activate(context);

  // ── Inheritance Graph ──────────────────────────────────────────────

  const inheritanceGraph = new InheritanceGraphPanel();
  inheritanceGraph.activate(context);

  // ── ABI Explorer ─────────────────────────────────────────────────

  const abiPanel = new AbiPanel();
  abiPanel.activate(context);

  // ── Gas Diff ──────────────────────────────────────────────────────

  const gasDiff = new GasDiffProvider();
  gasDiff.activate(context);

  // ── Static Analysis ───────────────────────────────────────────────

  const slither = new SlitherIntegration();
  context.subscriptions.push({ dispose: () => slither.dispose() });

  context.subscriptions.push(
    vscode.commands.registerCommand("solforge.slither", () => slither.analyze()),
  );

  // Auto-run slither on save if enabled
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId === "solidity") {
        const config = vscode.workspace.getConfiguration("solforge");
        if (config.get<boolean>("slither.enabled")) {
          slither.analyze();
        }
      }
    }),
  );

  // ── Status Bar ────────────────────────────────────────────────────

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.text = "$(beaker) Solforge";
  statusBar.tooltip = "Solforge — Solidity IDE";
  statusBar.command = "solforge.build";
  statusBar.show();
  context.subscriptions.push(statusBar);

  // ── Output Channel ────────────────────────────────────────────────

  const outputChannel = vscode.window.createOutputChannel("Solforge", {
    log: true,
  });
  context.subscriptions.push(outputChannel);
  outputChannel.info("Solforge activated");
}

export async function deactivate(): Promise<void> {
  if (client) {
    await client.stop();
  }
}
