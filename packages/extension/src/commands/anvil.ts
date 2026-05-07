import * as vscode from "vscode";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";

/**
 * Multi-instance Anvil manager.
 *
 * Supports an arbitrary number of concurrent Anvil processes — designed
 * for multi-chain fork integration tests (e.g. Ethereum + Arbitrum + Base
 * all running simultaneously on different ports).
 *
 * Ports auto-assign starting at 8545 and incrementing, but users can
 * override with an explicit port. Each instance is a headless
 * child_process with output streamed to a shared OutputChannel.
 *
 * Presets (`.solidity-workbench/anvil-presets.json`) let teams define
 * named multi-chain configurations that spin up with one command.
 */

// ── Types ──────────────────────────────────────────────────────────

export interface AnvilInstanceConfig {
  label: string;
  port?: number;
  chainId?: number;
  forkUrl?: string;
  forkBlockNumber?: string;
  blockTime?: number;
  accounts?: number;
  extraArgs?: string[];
}

export interface AnvilInstance {
  id: string;
  config: AnvilInstanceConfig;
  port: number;
  process: ChildProcess;
  status: "starting" | "running" | "stopped" | "error";
  rpcUrl: string;
  startedAt: number;
  error?: string;
}

export interface AnvilPreset {
  name: string;
  instances: AnvilInstanceConfig[];
}

export type AnvilChangeHandler = (instances: AnvilInstance[]) => void;

// ── Manager ────────────────────────────────────────────────────────

const BASE_PORT = 8545;

export class AnvilManager {
  private instances = new Map<string, AnvilInstance>();
  private nextId = 1;
  private outputChannel: vscode.OutputChannel;
  private _onChange: AnvilChangeHandler | undefined;

  constructor() {
    this.outputChannel = vscode.window.createOutputChannel("Anvil", { log: true });
  }

  onInstanceChange(handler: AnvilChangeHandler): void {
    this._onChange = handler;
  }

  getInstances(): AnvilInstance[] {
    return Array.from(this.instances.values());
  }

  getRunning(): AnvilInstance[] {
    return this.getInstances().filter((i) => i.status === "running" || i.status === "starting");
  }

  getInstance(id: string): AnvilInstance | undefined {
    return this.instances.get(id);
  }

  async startInstance(config: AnvilInstanceConfig): Promise<AnvilInstance> {
    const port = config.port ?? (await this.findAvailablePort());
    const id = `anvil-${this.nextId++}`;
    const rpcUrl = `http://127.0.0.1:${port}`;

    const args = this.buildArgs(config, port);

    this.outputChannel.appendLine(`[${config.label}] Starting anvil on port ${port}...`);
    this.outputChannel.appendLine(`[${config.label}] anvil ${args.join(" ")}`);

    const proc = spawn("anvil", args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    const instance: AnvilInstance = {
      id,
      config,
      port,
      process: proc,
      status: "starting",
      rpcUrl,
      startedAt: Date.now(),
    };

    this.instances.set(id, instance);
    this.fire();

    proc.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      for (const line of text.split("\n").filter(Boolean)) {
        this.outputChannel.appendLine(`[${config.label}] ${line}`);
      }
      if (instance.status === "starting" && text.includes("Listening on")) {
        instance.status = "running";
        this.fire();
      }
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      for (const line of text.split("\n").filter(Boolean)) {
        this.outputChannel.appendLine(`[${config.label}] ERR: ${line}`);
      }
    });

    proc.on("error", (err) => {
      instance.status = "error";
      instance.error = err.message;
      this.outputChannel.appendLine(`[${config.label}] Process error: ${err.message}`);
      this.fire();
    });

    proc.on("exit", (code) => {
      if (instance.status !== "stopped") {
        instance.status = code === 0 ? "stopped" : "error";
        if (code !== 0 && code !== null) {
          instance.error = `Exited with code ${code}`;
        }
      }
      this.outputChannel.appendLine(`[${config.label}] Exited (code=${code})`);
      this.fire();
    });

    // Wait briefly for the process to either start or fail
    await new Promise<void>((resolve) => setTimeout(resolve, 500));

    if (instance.status === "starting" && !proc.killed && proc.exitCode === null) {
      instance.status = "running";
      this.fire();
    }

    return instance;
  }

  stopInstance(id: string): void {
    const instance = this.instances.get(id);
    if (!instance) return;

    instance.status = "stopped";
    if (instance.process && !instance.process.killed) {
      instance.process.kill("SIGTERM");
    }
    this.instances.delete(id);
    this.outputChannel.appendLine(`[${instance.config.label}] Stopped`);
    this.fire();
  }

  stopAll(): void {
    for (const id of [...this.instances.keys()]) {
      this.stopInstance(id);
    }
  }

  async startPreset(preset: AnvilPreset): Promise<AnvilInstance[]> {
    this.outputChannel.appendLine(
      `Starting preset "${preset.name}" (${preset.instances.length} instances)...`,
    );

    const results: AnvilInstance[] = [];
    for (const config of preset.instances) {
      const instance = await this.startInstance(config);
      results.push(instance);
    }

    this.outputChannel.appendLine(`Preset "${preset.name}" started: ${results.length} instances`);
    return results;
  }

  async loadPresets(): Promise<AnvilPreset[]> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return [];

    const presetPath = path.join(
      workspaceFolder.uri.fsPath,
      ".solidity-workbench",
      "anvil-presets.json",
    );

    try {
      if (!fs.existsSync(presetPath)) return [];
      const content = fs.readFileSync(presetPath, "utf-8");
      const data = JSON.parse(content);
      if (Array.isArray(data)) return data;
      if (data.presets && Array.isArray(data.presets)) return data.presets;
      return [];
    } catch {
      return [];
    }
  }

  async scaffoldPresetFile(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return;

    const dir = path.join(workspaceFolder.uri.fsPath, ".solidity-workbench");
    const presetPath = path.join(dir, "anvil-presets.json");

    if (fs.existsSync(presetPath)) {
      const doc = await vscode.workspace.openTextDocument(presetPath);
      await vscode.window.showTextDocument(doc);
      return;
    }

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const scaffold: { presets: AnvilPreset[] } = {
      presets: [
        {
          name: "cross-chain-fork",
          instances: [
            {
              label: "Ethereum",
              chainId: 1,
              forkUrl: "https://eth.llamarpc.com",
            },
            {
              label: "Arbitrum",
              chainId: 42161,
              forkUrl: "https://arb1.arbitrum.io/rpc",
            },
            {
              label: "Base",
              chainId: 8453,
              forkUrl: "https://mainnet.base.org",
            },
          ],
        },
      ],
    };

    fs.writeFileSync(presetPath, JSON.stringify(scaffold, null, 2) + "\n");
    const doc = await vscode.workspace.openTextDocument(presetPath);
    await vscode.window.showTextDocument(doc);
  }

  showOutput(): void {
    this.outputChannel.show();
  }

  dispose(): void {
    this.stopAll();
    this.outputChannel.dispose();
  }

  // ── Private ────────────────────────────────────────────────────────

  private buildArgs(config: AnvilInstanceConfig, port: number): string[] {
    const args = ["--port", String(port), "--host", "127.0.0.1"];

    if (config.chainId !== undefined) {
      args.push("--chain-id", String(config.chainId));
    }
    if (config.forkUrl) {
      args.push("--fork-url", config.forkUrl);
    }
    if (config.forkBlockNumber) {
      args.push("--fork-block-number", config.forkBlockNumber);
    }
    if (config.blockTime !== undefined) {
      args.push("--block-time", String(config.blockTime));
    }
    if (config.accounts !== undefined) {
      args.push("--accounts", String(config.accounts));
    }
    if (config.extraArgs) {
      args.push(...config.extraArgs);
    }

    return args;
  }

  private async findAvailablePort(): Promise<number> {
    const usedPorts = new Set(this.getRunning().map((i) => i.port));
    let port = BASE_PORT;

    while (usedPorts.has(port) || (await this.isPortInUse(port))) {
      port++;
      if (port > BASE_PORT + 100) {
        throw new Error("No available ports in range 8545-8645");
      }
    }

    return port;
  }

  private isPortInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(true));
      server.once("listening", () => {
        server.close(() => resolve(false));
      });
      server.listen(port, "127.0.0.1");
    });
  }

  private fire(): void {
    this._onChange?.(this.getInstances());
  }
}

// ── Command Registration ────────────────────────────────────────────

export function registerAnvilCommands(
  context: vscode.ExtensionContext,
  manager: AnvilManager,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("solidity-workbench.anvil.start", async () => {
      const label = await vscode.window.showInputBox({
        title: "Instance Label",
        value: `Chain ${manager.getRunning().length + 1}`,
        prompt: "A name for this Anvil instance (e.g. Ethereum, Arbitrum)",
      });
      if (!label) return;

      const forkUrl = await vscode.window.showInputBox({
        title: "Fork RPC URL (optional)",
        placeHolder: "https://eth-mainnet.g.alchemy.com/v2/...",
        prompt: "Enter an RPC URL to fork from, or leave empty for a fresh chain",
      });

      const config: AnvilInstanceConfig = { label };

      if (forkUrl) {
        config.forkUrl = forkUrl;

        const blockNumber = await vscode.window.showInputBox({
          title: "Fork block number (optional)",
          placeHolder: "latest",
          prompt: "Enter a block number to fork at, or leave empty for latest",
        });
        if (blockNumber && blockNumber !== "latest") {
          config.forkBlockNumber = blockNumber;
        }
      }

      const portInput = await vscode.window.showInputBox({
        title: "Port (optional)",
        placeHolder: "auto",
        prompt: "Enter a port number, or leave empty to auto-assign",
      });
      if (portInput) {
        const parsed = parseInt(portInput, 10);
        if (!isNaN(parsed)) config.port = parsed;
      }

      const chainIdInput = await vscode.window.showInputBox({
        title: "Chain ID (optional)",
        placeHolder: forkUrl ? "auto (from fork)" : "31337",
        prompt: "Enter a chain ID, or leave empty for default",
      });
      if (chainIdInput) {
        const parsed = parseInt(chainIdInput, 10);
        if (!isNaN(parsed)) config.chainId = parsed;
      }

      try {
        const instance = await manager.startInstance(config);
        vscode.window.showInformationMessage(
          `Anvil "${label}" started on port ${instance.port}${forkUrl ? " (forked)" : ""}`,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to start Anvil: ${msg}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("solidity-workbench.anvil.stop", async () => {
      const running = manager.getRunning();
      if (running.length === 0) {
        vscode.window.showInformationMessage("No Anvil instances running.");
        return;
      }

      if (running.length === 1) {
        manager.stopInstance(running[0].id);
        vscode.window.showInformationMessage(`Anvil "${running[0].config.label}" stopped.`);
        return;
      }

      const items = [
        { label: "Stop All", description: `${running.length} instances`, id: "__all__" },
        ...running.map((i) => ({
          label: i.config.label,
          description: `port ${i.port} — ${i.rpcUrl}`,
          id: i.id,
        })),
      ];

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "Which instance to stop?",
      });
      if (!picked) return;

      if (picked.id === "__all__") {
        manager.stopAll();
        vscode.window.showInformationMessage("All Anvil instances stopped.");
      } else {
        manager.stopInstance(picked.id);
        vscode.window.showInformationMessage(`Anvil "${picked.label}" stopped.`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("solidity-workbench.anvil.stopAll", () => {
      manager.stopAll();
      vscode.window.showInformationMessage("All Anvil instances stopped.");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("solidity-workbench.anvil.startPreset", async () => {
      const presets = await manager.loadPresets();
      if (presets.length === 0) {
        const create = await vscode.window.showInformationMessage(
          "No anvil presets found. Create a preset file?",
          "Create",
          "Cancel",
        );
        if (create === "Create") {
          await manager.scaffoldPresetFile();
        }
        return;
      }

      const picked = await vscode.window.showQuickPick(
        presets.map((p) => ({
          label: p.name,
          description: `${p.instances.length} instance(s)`,
          preset: p,
        })),
        { placeHolder: "Select a preset to launch" },
      );
      if (!picked) return;

      try {
        const instances = await manager.startPreset(picked.preset);
        const ports = instances.map((i) => i.port).join(", ");
        vscode.window.showInformationMessage(
          `Preset "${picked.label}" started: ${instances.length} instances on ports ${ports}`,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to start preset: ${msg}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("solidity-workbench.anvil.editPresets", () =>
      manager.scaffoldPresetFile(),
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("solidity-workbench.anvil.showOutput", () =>
      manager.showOutput(),
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "solidity-workbench.anvil.copyRpcUrl",
      (item?: { instanceId?: string }) => {
        if (!item?.instanceId) return;
        const instance = manager.getInstance(item.instanceId);
        if (instance) {
          vscode.env.clipboard.writeText(instance.rpcUrl);
          vscode.window.showInformationMessage(`Copied: ${instance.rpcUrl}`);
        }
      },
    ),
  );

  context.subscriptions.push({ dispose: () => manager.dispose() });
}
