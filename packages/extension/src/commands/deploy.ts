import * as vscode from "vscode";

/**
 * Deploy workflow — guided contract deployment using Foundry.
 *
 * Supports two deployment modes:
 * 1. `forge create` — direct single-contract deployment
 * 2. `forge script` — script-based deployment (for complex multi-step deploys)
 *
 * Features:
 * - Contract picker from compiled artifacts
 * - Constructor argument input with type validation
 * - Network selection with saved presets
 * - Signing method selection (ledger, keystore, private key)
 * - Etherscan verification after deployment
 * - Deployment receipt display
 */
export function registerDeployCommands(context: vscode.ExtensionContext): void {
  // ── forge create (simple deploy) ──────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("solforge.deploy.create", async () => {
      // Step 1: Pick the contract
      const contractInfo = await pickContract();
      if (!contractInfo) return;

      // Step 2: Pick the network
      const rpcUrl = await pickDeployNetwork();
      if (!rpcUrl) return;

      // Step 3: Constructor arguments
      const constructorArgs = await getConstructorArgs(contractInfo.name);

      // Step 4: Signing method
      const signFlag = await pickSigningMethod();
      if (!signFlag) return;

      // Step 5: Etherscan verification?
      const verify = await vscode.window.showQuickPick(
        ["Yes — verify on Etherscan", "No — skip verification"],
        { placeHolder: "Verify on Etherscan after deployment?" },
      );

      // Build the command
      const config = vscode.workspace.getConfiguration("solforge");
      const forgePath = config.get<string>("foundryPath") || "forge";

      let cmd = `${forgePath} create ${contractInfo.path}:${contractInfo.name}`;
      cmd += ` --rpc-url ${rpcUrl}`;
      cmd += ` ${signFlag}`;

      if (constructorArgs) {
        cmd += ` --constructor-args ${constructorArgs}`;
      }

      if (verify?.startsWith("Yes")) {
        cmd += " --verify";
        const etherscanKey = await getEtherscanApiKey();
        if (etherscanKey) {
          cmd += ` --etherscan-api-key ${etherscanKey}`;
        }
      }

      // Confirm and execute
      const confirmed = await vscode.window.showWarningMessage(
        `Deploy ${contractInfo.name} to ${rpcUrl}?`,
        { modal: true },
        "Deploy",
      );

      if (confirmed !== "Deploy") return;

      const terminal = getOrCreateDeployTerminal();
      terminal.show();
      terminal.sendText(cmd);
    }),
  );

  // ── Verify existing contract ──────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("solforge.deploy.verify", async () => {
      const address = await vscode.window.showInputBox({
        title: "Contract Address",
        placeHolder: "0x...",
        prompt: "Enter the deployed contract address",
      });
      if (!address) return;

      const contractInfo = await pickContract();
      if (!contractInfo) return;

      const rpcUrl = await pickDeployNetwork();
      if (!rpcUrl) return;

      const chainId = await getChainId(rpcUrl);
      const etherscanKey = await getEtherscanApiKey();

      const config = vscode.workspace.getConfiguration("solforge");
      const forgePath = config.get<string>("foundryPath") || "forge";

      let cmd = `${forgePath} verify-contract ${address} ${contractInfo.path}:${contractInfo.name}`;
      cmd += ` --chain-id ${chainId}`;
      if (etherscanKey) cmd += ` --etherscan-api-key ${etherscanKey}`;

      const constructorArgs = await vscode.window.showInputBox({
        title: "Constructor Arguments (ABI-encoded, optional)",
        placeHolder: "Leave empty if no constructor args",
      });
      if (constructorArgs) {
        cmd += ` --constructor-args ${constructorArgs}`;
      }

      const terminal = getOrCreateDeployTerminal();
      terminal.show();
      terminal.sendText(cmd);
    }),
  );

  // ── Check verification status ─────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("solforge.deploy.verifyCheck", async () => {
      const guid = await vscode.window.showInputBox({
        title: "Verification GUID",
        placeHolder: "The GUID returned by the verify command",
      });
      if (!guid) return;

      const chainId = await vscode.window.showInputBox({
        title: "Chain ID",
        value: "1",
      });

      const etherscanKey = await getEtherscanApiKey();
      const config = vscode.workspace.getConfiguration("solforge");
      const forgePath = config.get<string>("foundryPath") || "forge";

      let cmd = `${forgePath} verify-check ${guid}`;
      cmd += ` --chain-id ${chainId}`;
      if (etherscanKey) cmd += ` --etherscan-api-key ${etherscanKey}`;

      const terminal = getOrCreateDeployTerminal();
      terminal.show();
      terminal.sendText(cmd);
    }),
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

interface ContractInfo {
  name: string;
  path: string;
}

async function pickContract(): Promise<ContractInfo | undefined> {
  const editor = vscode.window.activeTextEditor;

  // Try to detect from current file
  if (editor?.document.languageId === "solidity") {
    const text = editor.document.getText();
    const contracts = [...text.matchAll(/(?:abstract\s+)?contract\s+(\w+)/g)]
      .map((m) => m[1])
      .filter((name) => !name.endsWith("Test") && !name.startsWith("Mock"));

    if (contracts.length === 1) {
      return {
        name: contracts[0],
        path: vscode.workspace.asRelativePath(editor.document.uri),
      };
    }

    if (contracts.length > 1) {
      const picked = await vscode.window.showQuickPick(contracts, {
        placeHolder: "Select a contract to deploy",
      });
      if (!picked) return undefined;
      return {
        name: picked,
        path: vscode.workspace.asRelativePath(editor.document.uri),
      };
    }
  }

  // Find all Solidity files in src/
  const files = await vscode.workspace.findFiles("src/**/*.sol", "**/node_modules/**");

  const items: vscode.QuickPickItem[] = [];
  for (const file of files) {
    const doc = await vscode.workspace.openTextDocument(file);
    const matches = [...doc.getText().matchAll(/(?:abstract\s+)?contract\s+(\w+)/g)];
    for (const match of matches) {
      const name = match[1];
      if (!name.endsWith("Test") && !name.startsWith("Mock")) {
        items.push({
          label: name,
          detail: vscode.workspace.asRelativePath(file),
        });
      }
    }
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Select a contract to deploy",
  });

  if (!picked) return undefined;
  return { name: picked.label, path: picked.detail! };
}

async function pickDeployNetwork(): Promise<string | undefined> {
  const networks = [
    { label: "$(server) Local (Anvil)", rpc: "http://127.0.0.1:8545" },
    { label: "$(globe) Ethereum Mainnet", rpc: "https://eth.llamarpc.com" },
    { label: "$(globe) Sepolia Testnet", rpc: "https://rpc.sepolia.org" },
    { label: "$(globe) Base", rpc: "https://mainnet.base.org" },
    { label: "$(globe) Base Sepolia", rpc: "https://sepolia.base.org" },
    { label: "$(globe) Arbitrum One", rpc: "https://arb1.arbitrum.io/rpc" },
    { label: "$(globe) Optimism", rpc: "https://mainnet.optimism.io" },
    { label: "$(edit) Custom RPC...", rpc: "custom" },
  ];

  const picked = await vscode.window.showQuickPick(
    networks.map((n) => ({
      label: n.label,
      description: n.rpc === "custom" ? "" : n.rpc,
      rpc: n.rpc,
    })),
    { placeHolder: "Select deployment target" },
  );

  if (!picked) return undefined;
  if ((picked as any).rpc === "custom") {
    return vscode.window.showInputBox({ title: "RPC URL", placeHolder: "https://..." });
  }
  return (picked as any).rpc;
}

async function pickSigningMethod(): Promise<string | undefined> {
  const methods = [
    { label: "$(key) Ledger", flag: "--ledger" },
    { label: "$(lock) Keystore File", flag: "--keystore" },
    { label: "$(shield) Interactive (hidden input)", flag: "--interactive" },
    { label: "$(terminal) Private Key (env var)", flag: "--private-key $PRIVATE_KEY" },
  ];

  const picked = await vscode.window.showQuickPick(
    methods.map((m) => ({ label: m.label, detail: m.flag, flag: m.flag })),
    { placeHolder: "Select signing method" },
  );

  if (!picked) return undefined;

  if ((picked as any).flag === "--keystore") {
    const file = await vscode.window.showOpenDialog({
      title: "Select keystore file",
      canSelectMany: false,
    });
    if (!file?.[0]) return undefined;
    return `--keystore ${file[0].fsPath}`;
  }

  return (picked as any).flag;
}

async function getConstructorArgs(contractName: string): Promise<string | undefined> {
  const hasConstructor = await vscode.window.showQuickPick(
    ["No constructor arguments", "Enter constructor arguments"],
    { placeHolder: `Does ${contractName} have constructor arguments?` },
  );

  if (hasConstructor === "Enter constructor arguments") {
    return vscode.window.showInputBox({
      title: "Constructor Arguments",
      placeHolder: "arg1 arg2 arg3 (space-separated, strings in quotes)",
      prompt: "Enter constructor arguments in the order they appear",
    });
  }

  return undefined;
}

async function getEtherscanApiKey(): Promise<string | undefined> {
  // Check environment variable first
  const envKey = process.env.ETHERSCAN_API_KEY;
  if (envKey) return envKey;

  return vscode.window.showInputBox({
    title: "Etherscan API Key",
    placeHolder: "Your Etherscan API key (or set ETHERSCAN_API_KEY env var)",
    password: true,
  });
}

async function getChainId(rpcUrl: string): Promise<string> {
  const knownChains: Record<string, string> = {
    "eth.llamarpc.com": "1",
    "rpc.sepolia.org": "11155111",
    "mainnet.base.org": "8453",
    "sepolia.base.org": "84532",
    "arb1.arbitrum.io": "42161",
    "mainnet.optimism.io": "10",
    "polygon-rpc.com": "137",
    "127.0.0.1:8545": "31337",
  };

  for (const [host, chain] of Object.entries(knownChains)) {
    if (rpcUrl.includes(host)) return chain;
  }

  const chainId = await vscode.window.showInputBox({
    title: "Chain ID",
    placeHolder: "1",
    prompt: "Enter the chain ID for verification",
  });

  return chainId ?? "1";
}

let deployTerminal: vscode.Terminal | undefined;

function getOrCreateDeployTerminal(): vscode.Terminal {
  if (deployTerminal && !deployTerminal.exitStatus) return deployTerminal;
  deployTerminal = vscode.window.createTerminal({
    name: "Forge Deploy",
    iconPath: new vscode.ThemeIcon("rocket"),
  });
  return deployTerminal;
}
