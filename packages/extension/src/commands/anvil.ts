import * as vscode from "vscode";

/**
 * Anvil (local testnet) management commands.
 *
 * - Start/stop Anvil from the command palette
 * - Fork from a given RPC URL
 * - Show Anvil status in the status bar
 */

let anvilTerminal: vscode.Terminal | undefined;

export function registerAnvilCommands(context: vscode.ExtensionContext): void {
  // ── anvil start ─────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("solidity-workbench.anvil.start", async () => {
      if (anvilTerminal && !anvilTerminal.exitStatus) {
        vscode.window.showInformationMessage("Anvil is already running. Stop it first.");
        anvilTerminal.show();
        return;
      }

      // Ask for optional fork URL
      const forkUrl = await vscode.window.showInputBox({
        title: "Fork RPC URL (optional)",
        placeHolder: "https://eth-mainnet.g.alchemy.com/v2/...",
        prompt: "Enter an RPC URL to fork from, or leave empty for a fresh chain",
      });

      const args = ["anvil"];
      if (forkUrl) {
        args.push("--fork-url", forkUrl);

        // Ask for fork block number
        const blockNumber = await vscode.window.showInputBox({
          title: "Fork block number (optional)",
          placeHolder: "latest",
          prompt: "Enter a block number to fork at, or leave empty for latest",
        });
        if (blockNumber && blockNumber !== "latest") {
          args.push("--fork-block-number", blockNumber);
        }
      }

      anvilTerminal = vscode.window.createTerminal({
        name: "Anvil",
        iconPath: new vscode.ThemeIcon("server"),
      });
      anvilTerminal.show();
      anvilTerminal.sendText(args.join(" "));

      vscode.window.showInformationMessage(
        forkUrl
          ? `Anvil started (forking ${new URL(forkUrl).hostname})`
          : "Anvil started (fresh chain)",
      );
    }),
  );

  // ── anvil stop ──────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("solidity-workbench.anvil.stop", async () => {
      if (anvilTerminal && !anvilTerminal.exitStatus) {
        anvilTerminal.dispose();
        anvilTerminal = undefined;
        vscode.window.showInformationMessage("Anvil stopped.");
      } else {
        vscode.window.showInformationMessage("Anvil is not running.");
      }
    }),
  );

  // Clean up terminal on close
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((terminal) => {
      if (terminal === anvilTerminal) {
        anvilTerminal = undefined;
      }
    }),
  );
}
