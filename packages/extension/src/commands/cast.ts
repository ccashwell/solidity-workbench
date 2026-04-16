import * as vscode from "vscode";

/**
 * Cast command palette integration.
 *
 * Provides quick access to commonly-used `cast` commands:
 * - Decode calldata / ABI-encode data
 * - Look up function selectors
 * - Convert between units (wei/gwei/ether)
 * - Compute keccak256 hashes
 * - Look up ENS names
 * - Query chain data (balance, nonce, storage)
 */
export function registerCastCommands(context: vscode.ExtensionContext): void {
  // ── cast sig — get function selector ──────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("solidity-workbench.cast.sig", async () => {
      const input = await vscode.window.showInputBox({
        title: "Function Signature",
        placeHolder: 'transfer(address,uint256) or "function transfer(address to, uint256 amount)"',
        prompt: "Enter a function signature to compute its 4-byte selector",
      });
      if (!input) return;

      const terminal = getOrCreateCastTerminal();
      terminal.show();
      terminal.sendText(`cast sig "${input}"`);
    }),
  );

  // ── cast 4byte — decode selector ──────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("solidity-workbench.cast.4byte", async () => {
      const selector = await getSelectionOrInput(
        "Function Selector",
        "0xa9059cbb",
        "Enter a 4-byte selector to look up",
      );
      if (!selector) return;

      const terminal = getOrCreateCastTerminal();
      terminal.show();
      terminal.sendText(`cast 4byte ${selector}`);
    }),
  );

  // ── cast calldata-decode ──────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("solidity-workbench.cast.calldataDecode", async () => {
      const sig = await vscode.window.showInputBox({
        title: "Function Signature",
        placeHolder: "transfer(address,uint256)",
      });
      if (!sig) return;

      const calldata = await vscode.window.showInputBox({
        title: "Calldata (hex)",
        placeHolder: "0xa9059cbb000000000000000000000000...",
      });
      if (!calldata) return;

      const terminal = getOrCreateCastTerminal();
      terminal.show();
      terminal.sendText(`cast calldata-decode "${sig}" ${calldata}`);
    }),
  );

  // ── cast abi-encode ───────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("solidity-workbench.cast.abiEncode", async () => {
      const sig = await vscode.window.showInputBox({
        title: "Function Signature",
        placeHolder: "transfer(address,uint256)",
      });
      if (!sig) return;

      const args = await vscode.window.showInputBox({
        title: "Arguments",
        placeHolder: "0xdead...beef 1000000",
      });
      if (!args) return;

      const terminal = getOrCreateCastTerminal();
      terminal.show();
      terminal.sendText(`cast abi-encode "${sig}" ${args}`);
    }),
  );

  // ── cast keccak — hash computation ────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("solidity-workbench.cast.keccak", async () => {
      const input = await getSelectionOrInput(
        "Input to Hash",
        "Transfer(address,address,uint256)",
        "Enter text to keccak256 hash",
      );
      if (!input) return;

      const terminal = getOrCreateCastTerminal();
      terminal.show();
      terminal.sendText(`cast keccak "${input}"`);
    }),
  );

  // ── cast to-wei / from-wei — unit conversion ─────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("solidity-workbench.cast.toWei", async () => {
      const amount = await vscode.window.showInputBox({
        title: "Amount in ether",
        placeHolder: "1.5",
      });
      if (!amount) return;

      const terminal = getOrCreateCastTerminal();
      terminal.show();
      terminal.sendText(`cast to-wei ${amount}`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("solidity-workbench.cast.fromWei", async () => {
      const amount = await vscode.window.showInputBox({
        title: "Amount in wei",
        placeHolder: "1500000000000000000",
      });
      if (!amount) return;

      const terminal = getOrCreateCastTerminal();
      terminal.show();
      terminal.sendText(`cast from-wei ${amount}`);
    }),
  );

  // ── cast balance — check address balance ──────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("solidity-workbench.cast.balance", async () => {
      const address = await getSelectionOrInput(
        "Address",
        "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
        "Enter an address to check balance",
      );
      if (!address) return;

      const rpc = await getRpcUrl();
      const terminal = getOrCreateCastTerminal();
      terminal.show();
      terminal.sendText(`cast balance ${address} --rpc-url ${rpc} --ether`);
    }),
  );

  // ── cast storage — read storage slot ──────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("solidity-workbench.cast.storage", async () => {
      const address = await vscode.window.showInputBox({
        title: "Contract Address",
        placeHolder: "0x...",
      });
      if (!address) return;

      const slot = await vscode.window.showInputBox({
        title: "Storage Slot",
        placeHolder: "0 or 0x0000...0000",
      });
      if (!slot) return;

      const rpc = await getRpcUrl();
      const terminal = getOrCreateCastTerminal();
      terminal.show();
      terminal.sendText(`cast storage ${address} ${slot} --rpc-url ${rpc}`);
    }),
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

let castTerminal: vscode.Terminal | undefined;

function getOrCreateCastTerminal(): vscode.Terminal {
  if (castTerminal && !castTerminal.exitStatus) return castTerminal;
  castTerminal = vscode.window.createTerminal({
    name: "Cast",
    iconPath: new vscode.ThemeIcon("broadcast"),
  });
  return castTerminal;
}

async function getSelectionOrInput(
  title: string,
  placeholder: string,
  prompt: string,
): Promise<string | undefined> {
  // Check if there's a selection in the active editor
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const selection = editor.document.getText(editor.selection);
    if (selection.trim()) return selection.trim();
  }

  return vscode.window.showInputBox({ title, placeHolder: placeholder, prompt });
}

async function getRpcUrl(): Promise<string> {
  // Check if Anvil is running locally
  return "http://127.0.0.1:8545";
}
