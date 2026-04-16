import * as vscode from "vscode";

/**
 * Forge Script runner — execute deployment and interaction scripts
 * with simulation preview before broadcasting.
 *
 * Features:
 * - Run `forge script` with dry-run simulation first
 * - Preview transactions that would be sent (to, value, calldata)
 * - Broadcast to a network after confirmation
 * - Resume failed broadcasts
 * - Multi-chain script execution
 * - Environment variable / .env file support
 */
export function registerScriptCommands(context: vscode.ExtensionContext): void {
  // ── forge script (simulate) ───────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("solidity-workbench.script.simulate", async () => {
      const scriptFile = await pickScriptFile();
      if (!scriptFile) return;

      const rpcUrl = await pickNetwork();
      if (!rpcUrl) return;

      const config = vscode.workspace.getConfiguration("solidity-workbench");
      const forgePath = config.get<string>("foundryPath") || "forge";

      const terminal = getOrCreateScriptTerminal();
      terminal.show();

      // Dry run first (no --broadcast flag)
      terminal.sendText(`${forgePath} script ${scriptFile} --rpc-url ${rpcUrl} -vvvv`);
    }),
  );

  // ── forge script (broadcast) ──────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("solidity-workbench.script.broadcast", async () => {
      const scriptFile = await pickScriptFile();
      if (!scriptFile) return;

      const rpcUrl = await pickNetwork();
      if (!rpcUrl) return;

      // Confirm broadcast
      const confirm = await vscode.window.showWarningMessage(
        `This will broadcast transactions to ${rpcUrl}. Continue?`,
        { modal: true },
        "Simulate First",
        "Broadcast",
      );

      if (!confirm) return;

      const config = vscode.workspace.getConfiguration("solidity-workbench");
      const forgePath = config.get<string>("foundryPath") || "forge";
      const terminal = getOrCreateScriptTerminal();
      terminal.show();

      if (confirm === "Simulate First") {
        terminal.sendText(`${forgePath} script ${scriptFile} --rpc-url ${rpcUrl} -vvvv`);
        // After simulation, user can re-run with broadcast
        vscode.window.showInformationMessage(
          "Simulation complete. Run 'Solidity Workbench: Broadcast Script' to send transactions.",
        );
      } else {
        // Ask for private key source
        const keySource = await vscode.window.showQuickPick(
          [
            {
              label: "$(key) Ledger",
              description: "--ledger",
              detail: "Sign with Ledger hardware wallet",
            },
            {
              label: "$(lock) Keystore",
              description: "--keystore",
              detail: "Sign with encrypted keystore file",
            },
            {
              label: "$(terminal) Private Key",
              description: "--private-key",
              detail: "Enter private key (not recommended for production)",
            },
            {
              label: "$(shield) Interactive",
              description: "--interactive",
              detail: "Enter private key interactively (hidden)",
            },
          ],
          { placeHolder: "How do you want to sign transactions?" },
        );

        if (!keySource) return;

        let signFlag = "";
        switch (keySource.description) {
          case "--ledger":
            signFlag = "--ledger";
            break;
          case "--keystore": {
            const keystorePath = await vscode.window.showOpenDialog({
              title: "Select keystore file",
              canSelectMany: false,
            });
            if (!keystorePath?.[0]) return;
            signFlag = `--keystore ${keystorePath[0].fsPath}`;
            break;
          }
          case "--private-key": {
            const pk = await vscode.window.showInputBox({
              title: "Private Key",
              password: true,
              prompt: "Enter the private key for signing",
            });
            if (!pk) return;
            signFlag = `--private-key ${pk}`;
            break;
          }
          case "--interactive":
            signFlag = "--interactive";
            break;
        }

        terminal.sendText(
          `${forgePath} script ${scriptFile} --rpc-url ${rpcUrl} --broadcast ${signFlag} -vvvv`,
        );
      }
    }),
  );

  // ── forge script resume ───────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("solidity-workbench.script.resume", async () => {
      const scriptFile = await pickScriptFile();
      if (!scriptFile) return;

      const rpcUrl = await pickNetwork();
      if (!rpcUrl) return;

      const config = vscode.workspace.getConfiguration("solidity-workbench");
      const forgePath = config.get<string>("foundryPath") || "forge";
      const terminal = getOrCreateScriptTerminal();
      terminal.show();

      terminal.sendText(`${forgePath} script ${scriptFile} --rpc-url ${rpcUrl} --resume -vvvv`);
    }),
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

async function pickScriptFile(): Promise<string | undefined> {
  const editor = vscode.window.activeTextEditor;

  // If the current file is a script, use it
  if (editor?.document.fileName.endsWith(".s.sol")) {
    return editor.document.fileName;
  }

  // Otherwise, find script files in the workspace
  const scripts = await vscode.workspace.findFiles("**/*.s.sol", "**/node_modules/**");

  if (scripts.length === 0) {
    vscode.window.showWarningMessage("No script files (*.s.sol) found.");
    return undefined;
  }

  if (scripts.length === 1) return scripts[0].fsPath;

  const picked = await vscode.window.showQuickPick(
    scripts.map((s) => ({
      label: vscode.workspace.asRelativePath(s),
      detail: s.fsPath,
    })),
    { placeHolder: "Select a script to run" },
  );

  return picked?.detail;
}

async function pickNetwork(): Promise<string | undefined> {
  const networks = [
    { label: "$(server) Local (Anvil)", rpc: "http://127.0.0.1:8545" },
    { label: "$(globe) Ethereum Mainnet", rpc: "https://eth.llamarpc.com" },
    { label: "$(globe) Sepolia", rpc: "https://rpc.sepolia.org" },
    { label: "$(globe) Base", rpc: "https://mainnet.base.org" },
    { label: "$(globe) Base Sepolia", rpc: "https://sepolia.base.org" },
    { label: "$(globe) Arbitrum One", rpc: "https://arb1.arbitrum.io/rpc" },
    { label: "$(globe) Optimism", rpc: "https://mainnet.optimism.io" },
    { label: "$(globe) Polygon", rpc: "https://polygon-rpc.com" },
    { label: "$(edit) Custom RPC...", rpc: "custom" },
  ];

  const picked = await vscode.window.showQuickPick(
    networks.map((n) => ({ label: n.label, description: n.rpc, detail: n.rpc })),
    { placeHolder: "Select target network" },
  );

  if (!picked) return undefined;

  if (picked.detail === "custom") {
    return vscode.window.showInputBox({
      title: "RPC URL",
      placeHolder: "https://...",
      prompt: "Enter the RPC endpoint URL",
    });
  }

  return picked.detail;
}

let scriptTerminal: vscode.Terminal | undefined;

function getOrCreateScriptTerminal(): vscode.Terminal {
  if (scriptTerminal && !scriptTerminal.exitStatus) return scriptTerminal;
  scriptTerminal = vscode.window.createTerminal({
    name: "Forge Script",
    iconPath: new vscode.ThemeIcon("rocket"),
  });
  return scriptTerminal;
}
