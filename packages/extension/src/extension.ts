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
import { StatusBar } from "./views/status-bar.js";

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
  registerAnvilCommands(context, (status) => statusBar.setAnvil(status));
  registerCastCommands(context);
  registerScriptCommands(context);
  registerDeployCommands(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("solidity-workbench.restartServer", async () => {
      await client.restart();
      vscode.window.showInformationMessage("Solidity Workbench language server restarted.");
    }),
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

  // ── Chisel REPL ───────────────────────────────────────────────────

  const chisel = new ChiselIntegration();
  chisel.activate(context);

  // ── Foundry.toml IntelliSense ─────────────────────────────────────

  const foundryToml = new FoundryTomlProvider();
  foundryToml.activate(context);

  // ── Static Analysis ───────────────────────────────────────────────

  const slither = new SlitherIntegration();
  context.subscriptions.push({ dispose: () => slither.dispose() });

  context.subscriptions.push(
    vscode.commands.registerCommand("solidity-workbench.slither", () => slither.analyze()),
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId === "solidity") {
        const config = vscode.workspace.getConfiguration("solidity-workbench");
        if (config.get<boolean>("slither.enabled")) {
          slither.analyze();
        }
      }
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
  if (client) {
    await client.stop();
  }
}
