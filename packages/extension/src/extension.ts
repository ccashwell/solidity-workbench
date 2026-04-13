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
import { FoundryTestProvider } from "./test-explorer/test-provider.js";

let client: LanguageClient;

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
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
      ],
    },
    outputChannelName: "Solforge",
  };

  client = new LanguageClient(
    "solforge",
    "Solforge Language Server",
    serverOptions,
    clientOptions,
  );

  // Start the client (which also starts the server)
  await client.start();

  // ── Commands ──────────────────────────────────────────────────────

  registerFoundryCommands(context);
  registerAnvilCommands(context);

  // Restart server command
  context.subscriptions.push(
    vscode.commands.registerCommand("solforge.restartServer", async () => {
      await client.restart();
      vscode.window.showInformationMessage("Solforge language server restarted.");
    }),
  );

  // ── Test Explorer ─────────────────────────────────────────────────

  const testProvider = new FoundryTestProvider();
  context.subscriptions.push(
    vscode.tests.createTestController("solforge-tests", "Solforge Tests"),
  );
  testProvider.activate(context);

  // ── Status Bar ────────────────────────────────────────────────────

  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
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
