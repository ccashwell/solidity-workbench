import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { generateSubgraphScaffold } from "@solidity-workbench/common";

/**
 * Command — **Generate Subgraph Scaffold**. Pick a compiled contract,
 * prompt for network / address / start block, then write the four
 * canonical Graph-Protocol starter files into
 * `<workspace>/subgraph/<ContractName>/` along with a copy of the
 * contract's ABI.
 *
 * The scaffold is events-only (no call/block handlers). Structs are
 * flagged with `TODO` markers because their GraphQL encoding is
 * domain-specific. Most of the real work lives in the pure
 * `@solidity-workbench/common/subgraph-scaffold` module; this command
 * is the thin UI layer.
 */
export function registerSubgraphCommand(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("solidity-workbench.subgraph.scaffold", async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showErrorMessage("Open a Foundry project first.");
        return;
      }

      const artifacts = findArtifacts(workspaceFolder.uri.fsPath);
      if (artifacts.length === 0) {
        vscode.window.showErrorMessage(
          "No compiled artifacts found under `out/**/*.json`. Run `forge build` first.",
        );
        return;
      }

      const pick = await vscode.window.showQuickPick(
        artifacts.map((a) => ({
          label: a.contractName,
          description: a.sourceFile,
          detail: `${a.events} event${a.events === 1 ? "" : "s"} in ABI`,
          artifact: a,
        })),
        {
          placeHolder: "Select a contract to generate a subgraph scaffold for",
          matchOnDescription: true,
          matchOnDetail: true,
        },
      );
      if (!pick) return;

      const network =
        (await vscode.window.showInputBox({
          prompt: "Network slug (mainnet, base, arbitrum-one, optimism, polygon, ...)",
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

      const scaffold = generateSubgraphScaffold(
        {
          contractName: pick.artifact.contractName,
          network,
          address: address || undefined,
          startBlock,
        },
        pick.artifact.abi,
      );

      const outRoot = path.join(workspaceFolder.uri.fsPath, "subgraph", pick.artifact.contractName);
      if (fs.existsSync(outRoot)) {
        const overwrite = await vscode.window.showWarningMessage(
          `Subgraph directory already exists: ${path.relative(workspaceFolder.uri.fsPath, outRoot)}. Overwrite?`,
          { modal: true },
          "Overwrite",
          "Cancel",
        );
        if (overwrite !== "Overwrite") return;
      }

      try {
        writeScaffold(outRoot, scaffold.files, pick.artifact);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to write subgraph scaffold: ${message}`);
        return;
      }

      const manifestPath = path.join(outRoot, "subgraph.yaml");
      await vscode.window.showTextDocument(vscode.Uri.file(manifestPath));

      const msg =
        scaffold.eventsWithTupleWarnings.length === 0
          ? `Scaffold written for ${scaffold.events.length} event(s) at ${path.relative(workspaceFolder.uri.fsPath, outRoot)}.`
          : `Scaffold written for ${scaffold.events.length} event(s). Review TODOs for tuple params in: ${scaffold.eventsWithTupleWarnings.join(", ")}.`;
      vscode.window.showInformationMessage(msg);
    }),
  );
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
  // Stable sort: contracts with events first, then alphabetical.
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

  // Derive the contract name from the filename stem and its parent
  // dir. Forge writes artifacts to `out/<File>.sol/<Contract>.json`.
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
): void {
  fs.mkdirSync(outRoot, { recursive: true });
  fs.mkdirSync(path.join(outRoot, "src"), { recursive: true });
  fs.mkdirSync(path.join(outRoot, "abis"), { recursive: true });

  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(outRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }

  // Drop a copy of the ABI into abis/<Contract>.json so the manifest's
  // `abis[0].file` reference resolves without manual copying.
  fs.writeFileSync(
    path.join(outRoot, "abis", `${artifact.contractName}.json`),
    JSON.stringify(artifact.abi, null, 2),
  );
}
