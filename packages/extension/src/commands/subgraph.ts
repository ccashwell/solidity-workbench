import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { generateSubgraphScaffold } from "@solidity-workbench/common";

const execFileAsync = promisify(execFile);

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
 *
 * Build behaviour:
 *   - If the user fires the command with a `.sol` file open and no
 *     artifact for that file exists yet, we invoke `forge build
 *     --match-path <file>` in the background and then retry.
 *   - If no artifacts exist at all, we run a full `forge build`.
 *   - We never error out on a missing build — the command acts like
 *     "scaffold this, compiling on demand if needed".
 */
export function registerSubgraphCommand(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("solidity-workbench.subgraph.scaffold", async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showErrorMessage("Open a Foundry project first.");
        return;
      }

      // `.sol` file active at invocation time — used both to bias the
      // auto-build (--match-path <file>) and to pre-select the user's
      // contract of interest in the quick-pick.
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

      const activeContractName = activeSolFile
        ? path.basename(activeSolFile, ".sol")
        : null;
      const picks = artifacts.map((a) => ({
        label: a.contractName,
        description: a.sourceFile,
        detail: `${a.events} event${a.events === 1 ? "" : "s"} in ABI`,
        artifact: a,
      }));
      // Surface the active file's contract(s) at the top of the list
      // when possible, so the user doesn't need to scroll to find
      // the thing they almost certainly want.
      if (activeContractName) {
        picks.sort((a, b) => {
          const aHit = a.artifact.contractName === activeContractName ? 0 : 1;
          const bHit = b.artifact.contractName === activeContractName ? 0 : 1;
          return aHit - bHit;
        });
      }

      const pick = await vscode.window.showQuickPick(picks, {
        placeHolder: "Select a contract to generate a subgraph scaffold for",
        matchOnDescription: true,
        matchOnDetail: true,
      });
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

// ── Build-on-demand ──────────────────────────────────────────────────

/**
 * Absolute path of the active editor's file if it's a Solidity source
 * file inside the given workspace root; `null` otherwise. Test files
 * and files outside the workspace are intentionally excluded — we
 * don't want to accidentally point `forge build --match-path` at a
 * transient buffer.
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

/**
 * True when `artifacts` contains an entry whose Forge-derived source
 * file matches `sourceAbsPath`. Forge lays artifacts out as
 * `out/<File>.sol/<Contract>.json`, so we compare by basename.
 */
function hasArtifactForSource(artifacts: ForgeArtifact[], sourceAbsPath: string): boolean {
  const basename = path.basename(sourceAbsPath);
  return artifacts.some((a) => path.basename(a.sourceFile) === basename);
}

/**
 * Run `forge build` in the workspace root, optionally narrowed to a
 * single file via `--match-path`. Emits progress to the notification
 * area and surfaces stderr on failure via an error message + the
 * Output panel so users aren't left guessing what went wrong.
 *
 * Returns `true` when the build succeeded, `false` otherwise.
 */
async function ensureCompiled(
  workspaceRoot: string,
  targetFile: string | null,
): Promise<boolean> {
  const config = vscode.workspace.getConfiguration("solidity-workbench");
  const forgePath = config.get<string>("foundryPath") || "forge";

  const args = targetFile
    ? ["build", "--match-path", path.relative(workspaceRoot, targetFile)]
    : ["build"];
  const title = targetFile
    ? `Compiling ${path.basename(targetFile)} for subgraph scaffold…`
    : "Compiling project for subgraph scaffold…";

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
          "forge build failed. Fix the compile errors and re-run `Generate Subgraph Scaffold`.",
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
    buildChannel = vscode.window.createOutputChannel("Solidity Workbench — Subgraph Build");
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
