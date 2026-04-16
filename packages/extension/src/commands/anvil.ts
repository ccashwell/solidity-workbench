import * as vscode from "vscode";

/**
 * Anvil (local testnet) management commands.
 *
 * Accepts an optional `onStatusChange` callback so the status bar can
 * reflect whether Anvil is currently running (and whether it's forked
 * from a remote RPC). The callback is invoked on every start / stop
 * transition and when VSCode notifies us that the Anvil terminal was
 * closed manually.
 */

export interface AnvilStatus {
  forked: boolean;
  host?: string;
}

export type AnvilStatusHandler = (status: AnvilStatus | null) => void;

let anvilTerminal: vscode.Terminal | undefined;

export function registerAnvilCommands(
  context: vscode.ExtensionContext,
  onStatusChange?: AnvilStatusHandler,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("solidity-workbench.anvil.start", async () => {
      if (anvilTerminal && !anvilTerminal.exitStatus) {
        vscode.window.showInformationMessage("Anvil is already running. Stop it first.");
        anvilTerminal.show();
        return;
      }

      const forkUrl = await vscode.window.showInputBox({
        title: "Fork RPC URL (optional)",
        placeHolder: "https://eth-mainnet.g.alchemy.com/v2/...",
        prompt: "Enter an RPC URL to fork from, or leave empty for a fresh chain",
      });

      const args = ["anvil"];
      let host: string | undefined;
      if (forkUrl) {
        args.push("--fork-url", forkUrl);
        try {
          host = new URL(forkUrl).hostname;
        } catch {
          host = forkUrl;
        }

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

      onStatusChange?.({ forked: !!forkUrl, host });

      vscode.window.showInformationMessage(
        forkUrl ? `Anvil started (forking ${host})` : "Anvil started (fresh chain)",
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("solidity-workbench.anvil.stop", async () => {
      if (anvilTerminal && !anvilTerminal.exitStatus) {
        anvilTerminal.dispose();
        anvilTerminal = undefined;
        onStatusChange?.(null);
        vscode.window.showInformationMessage("Anvil stopped.");
      } else {
        vscode.window.showInformationMessage("Anvil is not running.");
      }
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((terminal) => {
      if (terminal === anvilTerminal) {
        anvilTerminal = undefined;
        onStatusChange?.(null);
      }
    }),
  );
}
