import * as vscode from "vscode";

/**
 * Chisel REPL integration — Foundry's interactive Solidity shell.
 *
 * Features:
 * - Start Chisel from the command palette
 * - Import project contracts into the REPL context
 * - Send selected code to Chisel for evaluation
 * - Fork from a network for live data access
 */
export class ChiselIntegration {
  private terminal: vscode.Terminal | undefined;

  activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.commands.registerCommand("solforge.chisel.start", () => this.startChisel()),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand("solforge.chisel.startFork", () => this.startChiselFork()),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand("solforge.chisel.sendSelection", () => this.sendSelection()),
    );

    context.subscriptions.push(
      vscode.window.onDidCloseTerminal((t) => {
        if (t === this.terminal) this.terminal = undefined;
      }),
    );
  }

  private startChisel(): void {
    if (this.terminal && !this.terminal.exitStatus) {
      this.terminal.show();
      return;
    }

    this.terminal = vscode.window.createTerminal({
      name: "Chisel",
      iconPath: new vscode.ThemeIcon("terminal"),
    });
    this.terminal.show();
    this.terminal.sendText("chisel");
  }

  private async startChiselFork(): Promise<void> {
    const rpcUrl = await vscode.window.showInputBox({
      title: "Fork RPC URL",
      placeHolder: "https://eth-mainnet.g.alchemy.com/v2/...",
      prompt: "Enter an RPC URL to fork from",
    });
    if (!rpcUrl) return;

    if (this.terminal && !this.terminal.exitStatus) {
      this.terminal.dispose();
    }

    this.terminal = vscode.window.createTerminal({
      name: "Chisel (fork)",
      iconPath: new vscode.ThemeIcon("terminal"),
    });
    this.terminal.show();
    this.terminal.sendText(`chisel --fork-url ${rpcUrl}`);
  }

  private sendSelection(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const selection = editor.document.getText(editor.selection);
    if (!selection.trim()) {
      vscode.window.showWarningMessage("Select some Solidity code to send to Chisel.");
      return;
    }

    if (!this.terminal || this.terminal.exitStatus) {
      this.startChisel();
      // Wait a moment for chisel to start
      setTimeout(() => {
        this.terminal?.sendText(selection);
      }, 1000);
    } else {
      this.terminal.sendText(selection);
    }
  }
}
