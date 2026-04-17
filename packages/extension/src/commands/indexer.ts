import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  generateSubgraphScaffold,
  generatePonderScaffold,
  generateEnvioScaffold,
  type SubgraphScaffoldResult,
  type PonderScaffoldResult,
  type EnvioScaffoldResult,
} from "@solidity-workbench/common";

const execFileAsync = promisify(execFile);

/**
 * Indexer backend we know how to scaffold. Adding another one means
 * plugging a new entry into `BACKENDS` plus a generator function that
 * returns the same shape.
 */
type Backend = "subgraph" | "ponder" | "envio";

interface BackendSpec {
  label: string;
  description: string;
  detail: string;
  /** Top-level directory under the workspace root. */
  rootDir: string;
  /** File to open after a successful write so users land on the manifest. */
  entrypointFile: string;
  scaffold: (opts: {
    contractName: string;
    network: string;
    address: string | undefined;
    startBlock: number;
    abi: unknown[];
  }) => SubgraphScaffoldResult | PonderScaffoldResult | EnvioScaffoldResult;
  /** Absolute path to the ABI copy (backend-specific filename). */
  abiFile(root: string, contractName: string): string;
  /** Serialized ABI contents to write into `abiFile`. */
  abiContents(abi: unknown[], contractName: string): string;
}

/**
 * The subgraph backend expects a raw JSON ABI at `abis/<Name>.json`;
 * Ponder uses a TypeScript `as const` module which the Ponder
 * generator itself produces; Envio expects a JSON ABI like subgraph.
 *
 * Keeping the ABI-copy details inside each `BackendSpec` means the
 * scaffold runner stays uniform — it just writes every file from the
 * generator's `files` map and, if the backend wants a raw ABI copy,
 * drops that alongside.
 */
const BACKENDS: Record<Backend, BackendSpec> = {
  subgraph: {
    label: "Graph Protocol (subgraph)",
    description: "subgraph.yaml + AssemblyScript mappings",
    detail: "Deploy to The Graph hosted / decentralized network",
    rootDir: "subgraph",
    entrypointFile: "subgraph.yaml",
    scaffold: (o) =>
      generateSubgraphScaffold(
        {
          contractName: o.contractName,
          network: o.network,
          address: o.address,
          startBlock: o.startBlock,
        },
        o.abi,
      ),
    abiFile: (root, name) => path.join(root, "abis", `${name}.json`),
    abiContents: (abi) => JSON.stringify(abi, null, 2),
  },
  ponder: {
    label: "Ponder",
    description: "ponder.config.ts + ponder.schema.ts + TypeScript handlers",
    detail: "Local-first TypeScript indexer (SQLite / Postgres)",
    rootDir: "ponder",
    entrypointFile: "ponder.config.ts",
    scaffold: (o) =>
      generatePonderScaffold(
        {
          contractName: o.contractName,
          network: o.network,
          address: o.address,
          startBlock: o.startBlock,
        },
        o.abi,
      ),
    // Ponder's ABI lives in abis/<Contract>Abi.ts which the generator
    // emits directly — nothing for the runner to copy.
    abiFile: () => "",
    abiContents: () => "",
  },
  envio: {
    label: "Envio HyperIndex",
    description: "config.yaml + schema.graphql + TypeScript handlers",
    detail: "Hosted / self-hostable high-throughput indexer",
    rootDir: "envio",
    entrypointFile: "config.yaml",
    scaffold: (o) =>
      generateEnvioScaffold(
        {
          contractName: o.contractName,
          network: o.network,
          address: o.address,
          startBlock: o.startBlock,
        },
        o.abi,
      ),
    abiFile: (root, name) => path.join(root, "abis", `${name}.json`),
    abiContents: (abi) => JSON.stringify(abi, null, 2),
  },
};

/**
 * Register the two scaffold entry points:
 *
 *   - `solidity-workbench.indexer.scaffold` — unified command that
 *     asks the user which backend to target.
 *   - `solidity-workbench.subgraph.scaffold` — legacy alias that skips
 *     the backend picker and goes straight to the subgraph flow.
 *     Preserves muscle memory for users who had the old command bound
 *     to a key.
 */
export function registerIndexerCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("solidity-workbench.indexer.scaffold", async () => {
      const backend = await pickBackend();
      if (!backend) return;
      await runScaffold(backend);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("solidity-workbench.subgraph.scaffold", async () => {
      await runScaffold("subgraph");
    }),
  );
}

async function pickBackend(): Promise<Backend | null> {
  const pick = await vscode.window.showQuickPick(
    (Object.entries(BACKENDS) as [Backend, BackendSpec][]).map(([id, spec]) => ({
      id,
      label: spec.label,
      description: spec.description,
      detail: spec.detail,
    })),
    {
      placeHolder: "Select an indexer backend",
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );
  return pick?.id ?? null;
}

/**
 * Core scaffold flow shared by every backend. Picks a contract
 * (auto-building on demand), prompts for network / address / start
 * block, runs the backend-specific generator, and writes the files.
 */
async function runScaffold(backend: Backend): Promise<void> {
  const spec = BACKENDS[backend];
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage("Open a Foundry project first.");
    return;
  }

  const activeSolFile = currentSolFilePath(workspaceFolder.uri.fsPath);

  let artifacts = findArtifacts(workspaceFolder.uri.fsPath);
  const needsBuild =
    artifacts.length === 0 ||
    (activeSolFile !== null && !hasArtifactForSource(artifacts, activeSolFile));

  if (needsBuild) {
    const ok = await ensureCompiled(workspaceFolder.uri.fsPath, activeSolFile);
    if (!ok) return;
    artifacts = findArtifacts(workspaceFolder.uri.fsPath);
    if (artifacts.length === 0) {
      vscode.window.showErrorMessage(
        "forge build produced no artifacts under `out/`. Check the Output panel for compile errors.",
      );
      return;
    }
  }

  const activeContractName = activeSolFile ? path.basename(activeSolFile, ".sol") : null;
  const picks = artifacts.map((a) => ({
    label: a.contractName,
    description: a.sourceFile,
    detail: `${a.events} event${a.events === 1 ? "" : "s"} in ABI`,
    artifact: a,
  }));
  if (activeContractName) {
    picks.sort((a, b) => {
      const aHit = a.artifact.contractName === activeContractName ? 0 : 1;
      const bHit = b.artifact.contractName === activeContractName ? 0 : 1;
      return aHit - bHit;
    });
  }

  const pick = await vscode.window.showQuickPick(picks, {
    placeHolder: `Select a contract to scaffold a ${spec.label} indexer for`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!pick) return;

  const network =
    (await vscode.window.showInputBox({
      prompt: "Network slug (mainnet, base, arbitrum-one, optimism, polygon, sepolia, ...)",
      value: "mainnet",
      validateInput: (v) =>
        /^[a-z][a-z0-9-]*$/.test(v) ? null : "Network slug must be lowercase kebab-case.",
    })) ?? "mainnet";

  const address =
    (await vscode.window.showInputBox({
      prompt: "Deployed contract address (0x-prefixed). Leave blank to use a placeholder.",
      value: "",
      validateInput: (v) =>
        v === "" || /^0x[0-9a-fA-F]{40}$/.test(v)
          ? null
          : "Expected an 0x-prefixed 20-byte hex address.",
    })) ?? "";

  const startBlockRaw =
    (await vscode.window.showInputBox({
      prompt: "Start block",
      value: "0",
      validateInput: (v) =>
        /^\d+$/.test(v) ? null : "Start block must be a non-negative integer.",
    })) ?? "0";
  const startBlock = Number.parseInt(startBlockRaw, 10);

  const scaffold = spec.scaffold({
    contractName: pick.artifact.contractName,
    network,
    address: address || undefined,
    startBlock,
    abi: pick.artifact.abi,
  });

  const outRoot = path.join(
    workspaceFolder.uri.fsPath,
    spec.rootDir,
    pick.artifact.contractName,
  );
  if (fs.existsSync(outRoot)) {
    const overwrite = await vscode.window.showWarningMessage(
      `${spec.label} directory already exists: ${path.relative(workspaceFolder.uri.fsPath, outRoot)}. Overwrite?`,
      { modal: true },
      "Overwrite",
      "Cancel",
    );
    if (overwrite !== "Overwrite") return;
  }

  try {
    writeScaffold(outRoot, scaffold.files, pick.artifact, spec);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Failed to write ${spec.label} scaffold: ${message}`);
    return;
  }

  const entrypointPath = path.join(outRoot, spec.entrypointFile);
  if (fs.existsSync(entrypointPath)) {
    await vscode.window.showTextDocument(vscode.Uri.file(entrypointPath));
  }

  const relRoot = path.relative(workspaceFolder.uri.fsPath, outRoot);
  const msg =
    scaffold.eventsWithTupleWarnings.length === 0
      ? `${spec.label} scaffold written for ${scaffold.events.length} event(s) at ${relRoot}.`
      : `${spec.label} scaffold written for ${scaffold.events.length} event(s). Review TODOs for tuple params in: ${scaffold.eventsWithTupleWarnings.join(", ")}.`;
  vscode.window.showInformationMessage(msg);
}

// ── Build-on-demand ──────────────────────────────────────────────────

/**
 * Absolute path of the active editor's file if it's a Solidity source
 * file inside the given workspace root; `null` otherwise. Files
 * outside the workspace are intentionally excluded — we don't want
 * to accidentally pass a transient buffer path as a `forge build`
 * positional argument.
 */
function currentSolFilePath(workspaceRoot: string): string | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return null;
  if (editor.document.languageId !== "solidity") return null;
  const uri = editor.document.uri;
  if (uri.scheme !== "file") return null;
  const fsPath = uri.fsPath;
  const rel = path.relative(workspaceRoot, fsPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return fsPath;
}

function hasArtifactForSource(artifacts: ForgeArtifact[], sourceAbsPath: string): boolean {
  const basename = path.basename(sourceAbsPath);
  return artifacts.some((a) => path.basename(a.sourceFile) === basename);
}

/**
 * Run `forge build` in the workspace root, optionally narrowed to a
 * single file by passing its relative path as a positional argument.
 *
 * Note: `--match-path` is a `forge test` flag, **not** a `forge build`
 * flag — `forge build` expects positional paths. Passing
 * `--match-path` here fails with "unexpected argument". Forge
 * resolves positional paths by searching the configured source
 * trees, so passing the path relative to the workspace root works
 * for sources laid out under `src/` or `contracts/`.
 *
 * Returns `true` when the build succeeded, `false` otherwise.
 */
async function ensureCompiled(workspaceRoot: string, targetFile: string | null): Promise<boolean> {
  const config = vscode.workspace.getConfiguration("solidity-workbench");
  const forgePath = config.get<string>("foundryPath") || "forge";

  const args = targetFile ? ["build", path.relative(workspaceRoot, targetFile)] : ["build"];
  const title = targetFile
    ? `Compiling ${path.basename(targetFile)} for indexer scaffold…`
    : "Compiling project for indexer scaffold…";

  let ok = false;
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title,
      cancellable: false,
    },
    async () => {
      try {
        await execFileAsync(forgePath, args, {
          cwd: workspaceRoot,
          maxBuffer: 50 * 1024 * 1024,
          timeout: 600_000,
        });
        ok = true;
      } catch (err: unknown) {
        const e = err as { stderr?: string; stdout?: string; message?: string };
        const detail = (e.stderr || e.stdout || e.message || "unknown error").trim();
        const channel = getOrCreateBuildChannel();
        channel.appendLine(`forge ${args.join(" ")} failed:`);
        channel.appendLine(detail);
        const showOutput = "Show Output";
        const pick = await vscode.window.showErrorMessage(
          "forge build failed. Fix the compile errors and re-run the scaffold command.",
          showOutput,
        );
        if (pick === showOutput) channel.show();
      }
    },
  );
  return ok;
}

let buildChannel: vscode.OutputChannel | null = null;
function getOrCreateBuildChannel(): vscode.OutputChannel {
  if (!buildChannel) {
    buildChannel = vscode.window.createOutputChannel("Solidity Workbench — Indexer Build");
  }
  return buildChannel;
}

// ── Artifact discovery ────────────────────────────────────────────────

interface ForgeArtifact {
  contractName: string;
  sourceFile: string;
  abi: unknown[];
  events: number;
}

/**
 * Walk Forge's `out/` tree looking for compiled contract artifacts
 * (files matching `out/*.sol/*.json`). Skips build-info files under
 * `out/build-info/`, Test and Mock contracts, and anything without a
 * well-formed ABI.
 */
function findArtifacts(root: string): ForgeArtifact[] {
  const outDir = path.join(root, "out");
  if (!fs.existsSync(outDir)) return [];

  const out: ForgeArtifact[] = [];
  const stack: string[] = [outDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "build-info") continue;
        stack.push(full);
        continue;
      }
      if (!entry.name.endsWith(".json")) continue;
      const artifact = tryReadArtifact(full, outDir);
      if (artifact) out.push(artifact);
    }
  }
  out.sort((a, b) => b.events - a.events || a.contractName.localeCompare(b.contractName));
  return out;
}

function tryReadArtifact(file: string, outDir: string): ForgeArtifact | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  const abi = Array.isArray(parsed.abi) ? (parsed.abi as unknown[]) : null;
  if (!abi) return null;

  const contractName = path.basename(file, ".json");
  const parent = path.basename(path.dirname(file));
  if (!parent.endsWith(".sol")) return null;
  if (/^(Test|Mock)/.test(contractName)) return null;
  if (contractName === "build-info") return null;

  const events = abi.filter(
    (e) => e && typeof e === "object" && (e as Record<string, unknown>).type === "event",
  ).length;

  return {
    contractName,
    sourceFile: path.relative(path.dirname(outDir), file),
    abi,
    events,
  };
}

// ── Filesystem output ────────────────────────────────────────────────

function writeScaffold(
  outRoot: string,
  files: Record<string, string>,
  artifact: ForgeArtifact,
  spec: BackendSpec,
): void {
  fs.mkdirSync(outRoot, { recursive: true });

  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(outRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }

  const abiTarget = spec.abiFile(outRoot, artifact.contractName);
  if (abiTarget) {
    fs.mkdirSync(path.dirname(abiTarget), { recursive: true });
    fs.writeFileSync(abiTarget, spec.abiContents(artifact.abi, artifact.contractName));
  }
}
