import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";
import {
  findForgeRoot,
  forgeVerbosityFlag,
  GetMutationCandidates,
  type GetMutationCandidatesResult,
  type MutationCandidateInfo,
} from "@solidity-workbench/common";

const execFileAsync = promisify(execFile);

export type MutationStatus = "killed" | "survived" | "timeout" | "error";
export type MutationEngine = "builtin" | "gambit";

export interface MutationCandidate {
  id: string;
  uri: string;
  filePath: string;
  relativePath: string;
  range: vscode.Range;
  operator: string;
  original: string;
  replacement: string;
  contractName?: string;
  functionName?: string;
  lineText: string;
  engine?: MutationEngine;
  mutantDir?: string;
  cleanupRoot?: string;
}

export interface MutationResult {
  candidate: MutationCandidate;
  status: MutationStatus;
  durationMs: number;
  stdout?: string;
  stderr?: string;
  message?: string;
}

export interface MutationRunSummary {
  forgeRoot: string;
  scopeLabel: string;
  generatedAt: string;
  results: MutationResult[];
}

interface MutationRunOptions {
  targetFile?: vscode.Uri;
}

interface MutationOperator {
  token: string;
  replacement: string;
  label: string;
}

const MUTATION_OPERATORS: MutationOperator[] = [
  { token: "==", replacement: "!=", label: "equality" },
  { token: "!=", replacement: "==", label: "inequality" },
  { token: ">=", replacement: ">", label: "boundary" },
  { token: "<=", replacement: "<", label: "boundary" },
  { token: ">", replacement: ">=", label: "boundary" },
  { token: "<", replacement: "<=", label: "boundary" },
  { token: "&&", replacement: "||", label: "logical" },
  { token: "||", replacement: "&&", label: "logical" },
  { token: "+", replacement: "-", label: "arithmetic" },
  { token: "-", replacement: "+", label: "arithmetic" },
];

const EXCLUDED_COPY_ENTRIES = new Set([
  ".git",
  ".codegraph",
  "cache",
  "out",
  "broadcast",
  "node_modules",
]);

export class MutationProvider {
  private outputChannel: vscode.OutputChannel;
  private lastSummary: MutationRunSummary | null = null;

  constructor(private client?: LanguageClient) {
    this.outputChannel = vscode.window.createOutputChannel("Solidity Mutations");
  }

  activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(this.outputChannel);
    context.subscriptions.push(
      vscode.commands.registerCommand("solidity-workbench.mutation.run", () => this.run({})),
      vscode.commands.registerCommand("solidity-workbench.mutation.runFile", () =>
        this.runCurrentFile(),
      ),
      vscode.commands.registerCommand("solidity-workbench.mutation.openReport", () =>
        this.openReport(),
      ),
      vscode.commands.registerCommand("solidity-workbench.mutation.generateTests", () =>
        this.openGeneratedTests(),
      ),
    );
  }

  private async runCurrentFile(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== "solidity") {
      vscode.window.showWarningMessage("Open a Solidity file before running mutation tests.");
      return;
    }
    await editor.document.save();
    await this.run({ targetFile: editor.document.uri });
  }

  private async run(options: MutationRunOptions): Promise<void> {
    const activeSolidityFile =
      options.targetFile ??
      (vscode.window.activeTextEditor?.document.languageId === "solidity"
        ? vscode.window.activeTextEditor.document.uri
        : undefined);
    const workspaceFolder =
      (activeSolidityFile && vscode.workspace.getWorkspaceFolder(activeSolidityFile)) ??
      vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showWarningMessage("Open a Foundry workspace before running mutation tests.");
      return;
    }

    const forgeRoot = findMutationForgeRoot(activeSolidityFile?.fsPath, workspaceFolder.uri.fsPath);
    if (!forgeRoot) {
      vscode.window.showWarningMessage("No foundry.toml found for the selected mutation scope.");
      return;
    }

    const config = vscode.workspace.getConfiguration("solidity-workbench");
    const maxMutants = clampPositiveInt(config.get<number>("mutation.maxMutants"), 25);
    const configuredTimeoutMs = clampPositiveInt(config.get<number>("mutation.timeoutMs"), 120_000);
    const baselineTimeoutMs = resolveMutationBaselineTimeout({ configuredTimeoutMs });
    const includeTests = config.get<boolean>("mutation.includeTests") ?? false;
    const failFast = config.get<boolean>("mutation.failFast") ?? true;
    const configuredForgeTestArgs = stringArraySetting(
      config.get<unknown>("mutation.forgeTestArgs"),
    );
    const scopedForgeTest = resolveMutationForgeTestScope({
      forgeRoot,
      targetFile: options.targetFile?.fsPath,
      configuredArgs: configuredForgeTestArgs,
    });
    const forgeTestArgs = scopedForgeTest.args;
    const forgePath = config.get<string>("foundryPath") || "forge";
    const gambitPath = config.get<string>("mutation.gambitPath") || "gambit";
    const solcPath = config.get<string>("mutation.solcPath") || "";
    const engine = mutationEngine(config.get<string>("mutation.engine"));
    const verbosity = config.get<number>("test.verbosity") ?? 2;

    this.outputChannel.clear();
    this.outputChannel.show(true);
    this.outputChannel.appendLine(`Engine: ${engine}`);
    this.outputChannel.appendLine(`Forge root: ${forgeRoot}`);
    this.outputChannel.appendLine(`Max mutants: ${maxMutants}`);
    this.outputChannel.appendLine(`Configured per-mutant timeout: ${configuredTimeoutMs}ms`);
    this.outputChannel.appendLine(`Baseline timeout: ${baselineTimeoutMs}ms`);
    this.outputChannel.appendLine(`Mutant fail-fast: ${failFast ? "enabled" : "disabled"}`);
    if (forgeTestArgs.length > 0) {
      this.outputChannel.appendLine(`Extra forge test args: ${forgeTestArgs.join(" ")}`);
    }
    if (scopedForgeTest.note) {
      this.outputChannel.appendLine(scopedForgeTest.note);
    }
    this.outputChannel.appendLine(
      `Baseline: ${formatCommand(
        forgePath,
        buildForgeMutationTestArgs({ verbosity, extraArgs: forgeTestArgs }),
      )}`,
    );

    const baseline = await runBaselineTests({
      forgeRoot,
      forgePath,
      timeoutMs: baselineTimeoutMs,
      verbosity,
      extraArgs: forgeTestArgs,
    });
    if (baseline.error) {
      this.outputChannel.appendLine(baseline.error);
      vscode.window.showErrorMessage(baseline.error);
      return;
    }
    const effectiveTimeout = resolveMutationTimeout({
      configuredTimeoutMs,
      baselineDurationMs: baseline.durationMs,
    });
    const timeoutMs = effectiveTimeout.timeoutMs;
    this.outputChannel.appendLine(`Baseline completed in ${baseline.durationMs}ms.`);
    if (effectiveTimeout.note) {
      this.outputChannel.appendLine(effectiveTimeout.note);
    } else {
      this.outputChannel.appendLine(`Effective per-mutant timeout: ${timeoutMs}ms`);
    }
    const candidates =
      engine === "gambit"
        ? await collectGambitMutationCandidates({
            forgeRoot,
            targetFile: options.targetFile?.fsPath,
            includeTests,
            maxMutants,
            gambitPath,
            solcPath,
            outputChannel: this.outputChannel,
          })
        : await collectMutationCandidates({
            forgeRoot,
            targetFile: options.targetFile?.fsPath,
            includeTests,
            maxMutants,
            client: this.client,
            outputChannel: this.outputChannel,
          });

    if (candidates.length === 0) {
      vscode.window.showInformationMessage("No mutation candidates found for the selected scope.");
      return;
    }

    this.outputChannel.appendLine(`Generated ${candidates.length} mutation candidates.`);
    this.outputChannel.appendLine("");

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Running ${candidates.length} Solidity mutation tests`,
        cancellable: true,
      },
      async (progress, token) => {
        const results: MutationResult[] = [];
        const reusableSandboxRoot = canReuseMutationSandbox(candidates)
          ? await createReusableMutationSandbox({
              forgeRoot,
              forgePath,
              timeoutMs,
              outputChannel: this.outputChannel,
            })
          : undefined;
        try {
          for (let i = 0; i < candidates.length; i++) {
            if (token.isCancellationRequested) break;
            const candidate = candidates[i];
            const candidateLabel = `${candidate.relativePath}:${candidate.range.start.line + 1}`;
            progress.report({
              increment: 100 / candidates.length,
              message: `${i + 1}/${candidates.length}: ${candidateLabel}`,
            });
            this.outputChannel.appendLine(
              `[${i + 1}/${candidates.length}] Running ${candidateLabel}`,
            );
            this.outputChannel.appendLine(
              `  ${candidate.operator}: ${candidate.original} -> ${candidate.replacement}`,
            );
            this.outputChannel.appendLine(
              `  $ ${formatCommand(
                forgePath,
                buildForgeMutationTestArgs({ verbosity, extraArgs: forgeTestArgs, failFast }),
              )}`,
            );
            const result = await runCandidate({
              candidate,
              forgeRoot,
              forgePath,
              timeoutMs,
              verbosity,
              extraArgs: forgeTestArgs,
              failFast,
              sandboxRoot: reusableSandboxRoot,
            });
            results.push(result);
            this.outputChannel.appendLine(formatResultLine(result));
          }
        } finally {
          await cleanupMutationCandidates(candidates);
          if (reusableSandboxRoot) {
            await fs.promises.rm(reusableSandboxRoot, { recursive: true, force: true });
          }
        }

        const scopeLabel = options.targetFile
          ? path.relative(forgeRoot, options.targetFile.fsPath)
          : path.basename(forgeRoot);
        this.lastSummary = {
          forgeRoot,
          scopeLabel,
          generatedAt: new Date().toISOString(),
          results,
        };
      },
    );

    if (!this.lastSummary) return;
    const counts = summarizeMutationResults(this.lastSummary.results);
    vscode.window.showInformationMessage(
      `Mutation testing complete: ${counts.killed} killed, ${counts.survived} survived, ${counts.timeout} timeout, ${counts.error} error.`,
    );
    await this.openReport();
  }

  private async openReport(): Promise<void> {
    if (!this.lastSummary) {
      vscode.window.showInformationMessage(
        "Run mutation tests before opening the mutation report.",
      );
      return;
    }
    const doc = await vscode.workspace.openTextDocument({
      language: "markdown",
      content: formatMutationReport(this.lastSummary),
    });
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  private async openGeneratedTests(): Promise<void> {
    if (!this.lastSummary) {
      vscode.window.showInformationMessage("Run mutation tests before generating mutation tests.");
      return;
    }
    const survived = this.lastSummary.results.filter((r) => r.status === "survived");
    if (survived.length === 0) {
      vscode.window.showInformationMessage("No surviving mutants need generated tests.");
      return;
    }
    const doc = await vscode.workspace.openTextDocument({
      language: "solidity",
      content: survived
        .map((result, idx) => generateFoundryTestSkeleton(result.candidate, idx + 1))
        .join("\n\n"),
    });
    await vscode.window.showTextDocument(doc, { preview: false });
  }
}

export async function collectMutationCandidates(options: {
  forgeRoot: string;
  targetFile?: string;
  includeTests: boolean;
  maxMutants: number;
  client?: LanguageClient;
  outputChannel?: vscode.OutputChannel;
}): Promise<MutationCandidate[]> {
  const serverCandidates = await collectServerMutationCandidates(options);
  if (serverCandidates.length > 0) {
    options.outputChannel?.appendLine(
      `Using ${serverCandidates.length} compiler-backed mutation candidates from the language server.`,
    );
    return serverCandidates;
  }

  const files = options.targetFile
    ? [options.targetFile]
    : await findSolidityFiles(options.forgeRoot, options.includeTests);
  const candidates: MutationCandidate[] = [];
  for (const filePath of files) {
    if (candidates.length >= options.maxMutants) break;
    const relativePath = path.relative(options.forgeRoot, filePath);
    if (!options.includeTests && isTestPath(relativePath)) continue;
    const text = await fs.promises.readFile(filePath, "utf-8");
    candidates.push(
      ...buildMutationCandidates(text, {
        uri: vscode.Uri.file(filePath).toString(),
        filePath,
        relativePath,
        maxMutants: options.maxMutants - candidates.length,
      }),
    );
  }
  return candidates.slice(0, options.maxMutants);
}

async function collectServerMutationCandidates(options: {
  forgeRoot: string;
  targetFile?: string;
  includeTests: boolean;
  maxMutants: number;
  client?: LanguageClient;
  outputChannel?: vscode.OutputChannel;
}): Promise<MutationCandidate[]> {
  if (!options.client || options.client.state !== 2 /* LanguageClient.State.Running */) {
    return [];
  }
  try {
    const result = await options.client.sendRequest<GetMutationCandidatesResult>(
      GetMutationCandidates,
      {
        forgeRootUri: vscode.Uri.file(options.forgeRoot).toString(),
        targetFileUri: options.targetFile
          ? vscode.Uri.file(options.targetFile).toString()
          : undefined,
        includeTests: options.includeTests,
        maxMutants: options.maxMutants,
      },
    );
    if (result.source !== "solc" || result.candidates.length === 0) {
      if (result.reason) {
        options.outputChannel?.appendLine(
          `Compiler-backed mutation candidates unavailable: ${result.reason}`,
        );
      }
      return [];
    }
    return result.candidates.map(serverMutationCandidateToLocal);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    options.outputChannel?.appendLine(
      `Compiler-backed mutation candidate request failed; falling back to lexical candidates: ${message}`,
    );
    return [];
  }
}

function serverMutationCandidateToLocal(candidate: MutationCandidateInfo): MutationCandidate {
  return {
    id: candidate.id,
    uri: candidate.uri,
    filePath: candidate.filePath,
    relativePath: candidate.relativePath,
    range: new vscode.Range(
      candidate.range.start.line,
      candidate.range.start.character,
      candidate.range.end.line,
      candidate.range.end.character,
    ),
    operator: candidate.operator,
    original: candidate.original,
    replacement: candidate.replacement,
    contractName: candidate.contractName,
    functionName: candidate.functionName,
    lineText: candidate.lineText,
    engine: "builtin",
  };
}

export async function collectGambitMutationCandidates(options: {
  forgeRoot: string;
  targetFile?: string;
  includeTests: boolean;
  maxMutants: number;
  gambitPath: string;
  solcPath?: string;
  outputChannel?: vscode.OutputChannel;
}): Promise<MutationCandidate[]> {
  const sourceRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "solidity-workbench-gambit-src-"),
  );
  const outRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "solidity-workbench-gambit-out-"),
  );
  try {
    await copyForgeProject(options.forgeRoot, sourceRoot);
    const files = options.targetFile
      ? [options.targetFile]
      : await findSolidityFiles(options.forgeRoot, options.includeTests);
    const candidates: MutationCandidate[] = [];
    for (const filePath of files) {
      if (candidates.length >= options.maxMutants) break;
      const relativePath = path.relative(options.forgeRoot, filePath);
      if (!options.includeTests && isTestPath(relativePath)) continue;
      const outdir = path.join(outRoot, sanitizePathSegment(relativePath));
      const remaining = options.maxMutants - candidates.length;
      const args = buildGambitMutateArgs({
        relativePath,
        outdir,
        numMutants: remaining,
        solcPath: options.solcPath,
      });
      options.outputChannel?.appendLine(`$ ${options.gambitPath} ${args.join(" ")}`);
      await execFileAsync(options.gambitPath, args, {
        cwd: sourceRoot,
        maxBuffer: 50 * 1024 * 1024,
        timeout: 300_000,
      });
      const logPath = path.join(outdir, "mutants.log");
      let parsed: GambitMutantRecord[] = [];
      try {
        parsed = parseGambitMutantsLog(await fs.promises.readFile(logPath, "utf-8"));
      } catch {
        parsed = await fallbackGambitRecords(outdir, relativePath);
      }
      candidates.push(
        ...parsed.slice(0, remaining).map((record) =>
          gambitRecordToCandidate({
            record,
            forgeRoot: options.forgeRoot,
            outdir,
            cleanupRoot: outRoot,
            relativePath,
          }),
        ),
      );
    }
    if (candidates.length === 0) {
      await fs.promises.rm(outRoot, { recursive: true, force: true });
    }
    return candidates.slice(0, options.maxMutants);
  } catch (err: unknown) {
    await fs.promises.rm(outRoot, { recursive: true, force: true });
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Gambit mutation generation failed: ${message}`);
    return [];
  } finally {
    await fs.promises.rm(sourceRoot, { recursive: true, force: true });
    // Mutant directories are consumed later by `runCandidate`, so `outRoot`
    // is attached to each candidate and cleaned after the run completes.
  }
}

export interface GambitMutantRecord {
  id: string;
  file: string;
  line?: number;
  column?: number;
  original?: string;
  replacement?: string;
  operator?: string;
  description?: string;
}

export function buildGambitMutateArgs(options: {
  relativePath: string;
  outdir: string;
  numMutants: number;
  solcPath?: string;
}): string[] {
  const args = [
    "mutate",
    "--filename",
    options.relativePath,
    "--sourceroot",
    ".",
    "--outdir",
    options.outdir,
    "--num_mutants",
    String(options.numMutants),
  ];
  if (options.solcPath) {
    args.push("--solc", options.solcPath);
  }
  return args;
}

export function parseGambitMutantsLog(text: string): GambitMutantRecord[] {
  const records: GambitMutantRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const jsonRecord = parseGambitJsonLine(trimmed);
    if (jsonRecord) {
      records.push(jsonRecord);
      continue;
    }
    const textRecord = parseGambitTextLine(trimmed);
    if (textRecord) records.push(textRecord);
  }
  return records;
}

function parseGambitJsonLine(line: string): GambitMutantRecord | null {
  if (!line.startsWith("{")) return null;
  try {
    const record = JSON.parse(line) as Record<string, unknown>;
    const id = stringField(record, ["id", "mutant_id", "mutant"]);
    const file = stringField(record, ["file", "filename", "path", "source_file"]);
    if (!id || !file) return null;
    return {
      id,
      file,
      line: numberField(record, ["line", "line_no", "start_line"]),
      column: numberField(record, ["column", "col", "start_column"]),
      original: stringField(record, ["original", "from", "old"]),
      replacement: stringField(record, ["replacement", "to", "new"]),
      operator: stringField(record, ["operator", "mutation", "mutator"]),
      description: stringField(record, ["description", "message", "summary"]),
    };
  } catch {
    return null;
  }
}

function parseGambitTextLine(line: string): GambitMutantRecord | null {
  const idMatch = line.match(/(?:^|\b)(?:mutant\s*)?(\d+)(?::|\s)/i);
  const fileMatch = line.match(/([A-Za-z0-9_./@+-]+\.sol)(?::(\d+))?(?::(\d+))?/);
  if (!idMatch || !fileMatch) return null;
  const arrowMatch = line.match(/`?([^`\s]+)`?\s*(?:=>|->|to)\s*`?([^`\s]+)`?/i);
  return {
    id: idMatch[1],
    file: fileMatch[1],
    line: fileMatch[2] ? Number(fileMatch[2]) : undefined,
    column: fileMatch[3] ? Number(fileMatch[3]) : undefined,
    original: arrowMatch?.[1],
    replacement: arrowMatch?.[2],
    description: line,
  };
}

function gambitRecordToCandidate(options: {
  record: GambitMutantRecord;
  forgeRoot: string;
  outdir: string;
  cleanupRoot: string;
  relativePath: string;
}): MutationCandidate {
  const relativePath = normalizeRelativePath(options.record.file || options.relativePath);
  const line = Math.max(0, (options.record.line ?? 1) - 1);
  const column = Math.max(0, (options.record.column ?? 1) - 1);
  const mutantDir = path.join(options.outdir, "mutants", options.record.id);
  return {
    id: `gambit:${options.record.id}`,
    uri: vscode.Uri.file(path.join(options.forgeRoot, relativePath)).toString(),
    filePath: path.join(options.forgeRoot, relativePath),
    relativePath,
    range: new vscode.Range(
      line,
      column,
      line,
      column + Math.max(1, options.record.original?.length ?? 1),
    ),
    operator: options.record.operator ?? "gambit",
    original: options.record.original ?? "original",
    replacement: options.record.replacement ?? "mutated",
    lineText: options.record.description ?? `Gambit mutant ${options.record.id}`,
    engine: "gambit",
    mutantDir,
    cleanupRoot: options.cleanupRoot,
  };
}

async function fallbackGambitRecords(
  outdir: string,
  relativePath: string,
): Promise<GambitMutantRecord[]> {
  const mutantsDir = path.join(outdir, "mutants");
  const entries = await fs.promises.readdir(mutantsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      id: entry.name,
      file: relativePath,
      description: `Gambit mutant ${entry.name}`,
    }));
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
}

function stringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

function numberField(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  }
  return undefined;
}

export function buildMutationCandidates(
  text: string,
  options: { uri: string; filePath: string; relativePath: string; maxMutants?: number },
): MutationCandidate[] {
  const maxMutants = Math.max(1, options.maxMutants ?? 25);
  const lines = text.split(/\r?\n/);
  const candidates: MutationCandidate[] = [];
  let contractName: string | undefined;
  let functionName: string | undefined;
  let inBlockComment = false;

  for (let lineNo = 0; lineNo < lines.length && candidates.length < maxMutants; lineNo++) {
    const line = lines[lineNo];
    const stripped = stripCommentsFromLine(line, inBlockComment);
    inBlockComment = stripped.inBlockComment;
    const code = stripped.code;
    const contractMatch = code.match(
      /\b(?:abstract\s+)?(?:contract|library|interface)\s+([A-Za-z_]\w*)/,
    );
    if (contractMatch) contractName = contractMatch[1];
    const functionMatch = code.match(/\bfunction\s+([A-Za-z_]\w*)\s*\(/);
    if (functionMatch) functionName = functionMatch[1];
    if (shouldSkipMutationLine(code)) continue;

    for (const operator of MUTATION_OPERATORS) {
      for (const col of tokenColumns(code, operator.token)) {
        if (candidates.length >= maxMutants) break;
        candidates.push({
          id: `${path.basename(options.filePath)}:${lineNo + 1}:${col + 1}:${operator.token}->${operator.replacement}`,
          uri: options.uri,
          filePath: options.filePath,
          relativePath: options.relativePath,
          range: new vscode.Range(lineNo, col, lineNo, col + operator.token.length),
          operator: operator.label,
          original: operator.token,
          replacement: operator.replacement,
          contractName,
          functionName,
          lineText: line.trim(),
        });
      }
    }
  }

  return candidates;
}

export function applyMutation(text: string, candidate: MutationCandidate): string {
  const lines = text.split(/\r?\n/);
  const line = lines[candidate.range.start.line];
  if (line === undefined) return text;
  const start = candidate.range.start.character;
  const end = candidate.range.end.character;
  lines[candidate.range.start.line] =
    line.slice(0, start) + candidate.replacement + line.slice(end);
  return lines.join("\n");
}

export function summarizeMutationResults(
  results: MutationResult[],
): Record<MutationStatus, number> {
  return results.reduce<Record<MutationStatus, number>>(
    (acc, result) => {
      acc[result.status] += 1;
      return acc;
    },
    { killed: 0, survived: 0, timeout: 0, error: 0 },
  );
}

export function formatMutationReport(summary: MutationRunSummary): string {
  const counts = summarizeMutationResults(summary.results);
  const scoreDenominator = counts.killed + counts.survived;
  const score = scoreDenominator > 0 ? (counts.killed / scoreDenominator) * 100 : 0;
  const survived = summary.results.filter((r) => r.status === "survived");
  const lines = [
    "# Solidity Mutation Report",
    "",
    `- Scope: \`${summary.scopeLabel}\``,
    `- Generated: ${summary.generatedAt}`,
    `- Mutants: ${summary.results.length}`,
    `- Score: ${score.toFixed(1)}%`,
    `- Killed: ${counts.killed}`,
    `- Survived: ${counts.survived}`,
    `- Timeout: ${counts.timeout}`,
    `- Error: ${counts.error}`,
    "",
    "## Results",
    "",
  ];

  for (const result of summary.results) {
    const c = result.candidate;
    lines.push(
      `### ${result.status.toUpperCase()} - ${c.relativePath}:${c.range.start.line + 1}`,
      "",
      `- Operator: ${c.operator}`,
      `- Change: \`${c.original}\` -> \`${c.replacement}\``,
      `- Context: \`${c.lineText}\``,
      `- Function: \`${c.contractName ?? "file"}${c.functionName ? `.${c.functionName}` : ""}\``,
      `- Duration: ${result.durationMs}ms`,
      "",
    );
    if (result.message) {
      lines.push(`- Detail: ${result.message}`, "");
    }
  }

  if (survived.length > 0) {
    lines.push("## Generated Test Starting Points", "");
    for (let i = 0; i < survived.length; i++) {
      lines.push(
        "```solidity",
        generateFoundryTestSkeleton(survived[i].candidate, i + 1),
        "```",
        "",
      );
    }
  }

  return lines.join("\n");
}

export function generateFoundryTestSkeleton(candidate: MutationCandidate, index = 1): string {
  const contract = candidate.contractName ?? "Target";
  const functionPart = candidate.functionName ? `_${candidate.functionName}` : "";
  const testName = sanitizeSolidityIdentifier(
    `test_mutation_${contract}${functionPart}_${candidate.operator}_${index}`,
  );
  return [
    `function ${testName}() public {`,
    `    // Survived mutant: ${candidate.relativePath}:${candidate.range.start.line + 1}`,
    `    // ${candidate.original} -> ${candidate.replacement}`,
    `    // Original line: ${candidate.lineText}`,
    "    // Arrange the boundary or branch condition that distinguishes the original from the mutant.",
    "    // Act against the deployed target.",
    "    // Assert the externally observable behavior, revert, event, or state delta.",
    "}",
  ].join("\n");
}

async function runCandidate(options: {
  candidate: MutationCandidate;
  forgeRoot: string;
  forgePath: string;
  timeoutMs: number;
  verbosity: number;
  extraArgs?: string[];
  failFast?: boolean;
  sandboxRoot?: string;
}): Promise<MutationResult> {
  const started = Date.now();
  const tempRoot =
    options.sandboxRoot ??
    (await fs.promises.mkdtemp(path.join(os.tmpdir(), "solidity-workbench-mutant-")));
  const ownsTempRoot = !options.sandboxRoot;
  let restoreFile: { filePath: string; text: string } | undefined;
  try {
    if (ownsTempRoot) {
      await copyForgeProject(options.forgeRoot, tempRoot);
    }
    if (options.candidate.engine === "gambit" && options.candidate.mutantDir) {
      await copyMutantOverlay(options.candidate.mutantDir, tempRoot);
    } else {
      const relativePath = path.relative(options.forgeRoot, options.candidate.filePath);
      const tempFile = path.join(tempRoot, relativePath);
      const originalText = await fs.promises.readFile(tempFile, "utf-8");
      restoreFile = { filePath: tempFile, text: originalText };
      await fs.promises.writeFile(
        tempFile,
        applyMutation(originalText, options.candidate),
        "utf-8",
      );
    }
    const args = buildForgeMutationTestArgs({
      verbosity: options.verbosity,
      extraArgs: options.extraArgs,
      failFast: options.failFast,
    });
    const result = await execFileAsync(options.forgePath, args, {
      cwd: tempRoot,
      maxBuffer: 50 * 1024 * 1024,
      timeout: options.timeoutMs,
    });
    if (hasForgeTestFailures(result.stdout)) {
      const message = describeForgeTestFailure(result.stdout);
      return {
        candidate: options.candidate,
        status: "killed",
        durationMs: Date.now() - started,
        stdout: result.stdout,
        stderr: result.stderr,
        message,
      };
    }
    return {
      candidate: options.candidate,
      status: "survived",
      durationMs: Date.now() - started,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (err: unknown) {
    const e = err as {
      code?: unknown;
      signal?: string;
      killed?: boolean;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    const timedOut = e.killed === true || e.signal === "SIGTERM";
    const classification = timedOut
      ? undefined
      : classifyForgeMutationFailure({
          stdout: e.stdout,
          stderr: e.stderr,
          message: e.message,
        });
    return {
      candidate: options.candidate,
      status: timedOut ? "timeout" : (classification?.status ?? "error"),
      durationMs: Date.now() - started,
      stdout: e.stdout,
      stderr: e.stderr,
      message: timedOut
        ? `forge test did not complete within ${options.timeoutMs}ms; narrow solidity-workbench.mutation.forgeTestArgs or raise solidity-workbench.mutation.timeoutMs.`
        : classification?.message,
    };
  } finally {
    if (restoreFile) {
      await fs.promises.writeFile(restoreFile.filePath, restoreFile.text, "utf-8");
    }
    if (ownsTempRoot) {
      await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
  }
}

export function canReuseMutationSandbox(candidates: readonly MutationCandidate[]): boolean {
  return candidates.length > 0 && candidates.every((candidate) => candidate.engine !== "gambit");
}

async function createReusableMutationSandbox(options: {
  forgeRoot: string;
  forgePath: string;
  timeoutMs: number;
  outputChannel: vscode.OutputChannel;
}): Promise<string> {
  const sandboxRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "solidity-workbench-mutants-"),
  );
  options.outputChannel.appendLine(`Preparing reusable mutation sandbox: ${sandboxRoot}`);
  try {
    await copyForgeProject(options.forgeRoot, sandboxRoot, { includeBuildArtifacts: true });
    const args = buildForgeMutationBuildArgs();
    options.outputChannel.appendLine(`  $ ${formatCommand(options.forgePath, args)}`);
    await execFileAsync(options.forgePath, args, {
      cwd: sandboxRoot,
      maxBuffer: 50 * 1024 * 1024,
      timeout: options.timeoutMs,
    });
    options.outputChannel.appendLine("Reusable mutation sandbox build complete.");
    return sandboxRoot;
  } catch (err) {
    await fs.promises.rm(sandboxRoot, { recursive: true, force: true });
    throw err;
  }
}

async function runBaselineTests(options: {
  forgeRoot: string;
  forgePath: string;
  timeoutMs: number;
  verbosity: number;
  extraArgs?: string[];
}): Promise<{ durationMs: number; error?: string }> {
  const started = Date.now();
  const args = buildForgeMutationTestArgs({
    verbosity: options.verbosity,
    extraArgs: options.extraArgs,
  });
  try {
    const result = await execFileAsync(options.forgePath, args, {
      cwd: options.forgeRoot,
      maxBuffer: 50 * 1024 * 1024,
      timeout: options.timeoutMs,
    });
    const durationMs = Date.now() - started;
    return {
      durationMs,
      error: hasForgeTestFailures(result.stdout)
        ? "Baseline forge test run has failing tests; mutation testing aborted."
        : undefined,
    };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
    const durationMs = Date.now() - started;
    if (e.killed === true) {
      return {
        durationMs,
        error: `Baseline forge test run timed out after ${options.timeoutMs}ms; mutation testing aborted. Set solidity-workbench.mutation.forgeTestArgs to narrow the covering suite or raise solidity-workbench.mutation.timeoutMs.`,
      };
    }
    if (hasForgeTestFailures(e.stdout)) {
      return {
        durationMs,
        error: "Baseline forge test run has failing tests; mutation testing aborted.",
      };
    }
    return {
      durationMs,
      error: `Baseline forge test run failed before mutation testing: ${e.stderr?.trim() || e.message || String(err)}`,
    };
  }
}

function classifyForgeMutationFailure(err: {
  stdout?: string;
  stderr?: string;
  message?: string;
}): { status: MutationStatus; message: string } {
  const testFailure = describeForgeTestFailure(err.stdout);
  if (testFailure) {
    return { status: "killed", message: testFailure };
  }
  const output = `${err.stdout ?? ""}\n${err.stderr ?? ""}\n${err.message ?? ""}`;
  if (/Failing tests|Encountered \d+ failing test|Suite result: FAILED/i.test(output)) {
    return {
      status: "killed",
      message: summarizeForgeOutput(output) ?? "Forge reported failing tests.",
    };
  }
  return {
    status: "error",
    message: summarizeForgeOutput(output) ?? "forge test exited without a recognized test failure.",
  };
}

export function buildForgeMutationTestArgs(options: {
  verbosity: number;
  extraArgs?: string[];
  failFast?: boolean;
}): string[] {
  const args = ["test", "--json"];
  const verbosityFlag = forgeVerbosityFlag(options.verbosity);
  if (verbosityFlag) args.push(verbosityFlag);
  if (options.failFast) args.push("--fail-fast");
  args.push(...(options.extraArgs ?? []));
  return args;
}

export function buildForgeMutationBuildArgs(): string[] {
  return ["build"];
}

export function resolveMutationTimeout(options: {
  configuredTimeoutMs: number;
  baselineDurationMs: number;
}): { timeoutMs: number; note?: string } {
  const adaptiveTimeoutMs = Math.ceil(options.baselineDurationMs * 3 + 30_000);
  const timeoutMs = Math.max(options.configuredTimeoutMs, adaptiveTimeoutMs);
  if (timeoutMs === options.configuredTimeoutMs) {
    return { timeoutMs };
  }
  return {
    timeoutMs,
    note: `Effective per-mutant timeout raised to ${timeoutMs}ms based on baseline duration ${options.baselineDurationMs}ms.`,
  };
}

export function resolveMutationBaselineTimeout(options: { configuredTimeoutMs: number }): number {
  return Math.max(options.configuredTimeoutMs * 3, 300_000);
}

export function resolveMutationForgeTestScope(options: {
  forgeRoot: string;
  targetFile?: string;
  configuredArgs: string[];
}): { args: string[]; note?: string } {
  if (!options.targetFile || hasForgeTestSelector(options.configuredArgs)) {
    return { args: options.configuredArgs };
  }

  const relativePath = path.relative(options.forgeRoot, options.targetFile);
  if (isTestPath(relativePath)) {
    const matchPath = toForgePath(relativePath);
    return {
      args: [...options.configuredArgs, "--match-path", matchPath],
      note: `Scoped single-file mutation run to test file: ${matchPath}`,
    };
  }

  const inferredMatchPath = inferSourceMutationTestMatchPath(options.forgeRoot, relativePath);
  if (inferredMatchPath) {
    return {
      args: [...options.configuredArgs, "--match-path", inferredMatchPath],
      note: `Scoped source-file mutation run to inferred covering tests: ${inferredMatchPath}`,
    };
  }

  return {
    args: options.configuredArgs,
    note: `Current mutation target is not a test file; set solidity-workbench.mutation.forgeTestArgs to narrow the covering test suite.`,
  };
}

export function inferSourceMutationTestMatchPath(
  forgeRoot: string,
  sourceRelativePath: string,
): string | undefined {
  const sourcePath = toForgePath(sourceRelativePath);
  const segments = sourcePath.split("/").filter(Boolean);
  if (segments.length === 0 || isTestPath(sourcePath)) return undefined;

  const sourceRoot = segments[0];
  const sourceRoots = new Set(["src", "contracts"]);
  const testRoot = path.join(forgeRoot, "test");
  if (!sourceRoots.has(sourceRoot) || !hasSolidityFiles(testRoot)) {
    return undefined;
  }

  const area = segments[1];
  if (area) {
    const areaDir = path.join(testRoot, area);
    if (hasSolidityFiles(areaDir)) {
      return `test/${area}/**`;
    }
  }

  const stem = path.basename(sourcePath, ".sol");
  const basenameMatch = findMatchingTestBasename(testRoot, stem);
  if (basenameMatch) {
    return basenameMatch;
  }

  return undefined;
}

function hasForgeTestSelector(args: string[]): boolean {
  return args.some(
    (arg) =>
      arg === "--match-path" ||
      arg === "--match-contract" ||
      arg === "--match-test" ||
      arg.startsWith("--match-path=") ||
      arg.startsWith("--match-contract=") ||
      arg.startsWith("--match-test="),
  );
}

function toForgePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function hasSolidityFiles(dir: string): boolean {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".sol")) return true;
      if (entry.isDirectory() && hasSolidityFiles(path.join(dir, entry.name))) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function findMatchingTestBasename(testRoot: string, sourceStem: string): string | undefined {
  const queue = [testRoot];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const matchingFile = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".sol"))
      .map((entry) => entry.name)
      .find((name) => name === `${sourceStem}.t.sol` || name.startsWith(`${sourceStem}.`));
    if (matchingFile) {
      return toForgePath(path.relative(path.dirname(testRoot), path.join(dir, matchingFile)));
    }
    for (const entry of entries) {
      if (entry.isDirectory()) queue.push(path.join(dir, entry.name));
    }
  }
  return undefined;
}

export function hasForgeTestFailures(stdout: string | undefined): boolean {
  return !!describeForgeTestFailure(stdout);
}

export function describeForgeTestFailure(stdout: string | undefined): string | undefined {
  if (!stdout?.trim()) return undefined;
  try {
    const parsed = JSON.parse(stdout.trim()) as unknown;
    return findForgeJsonFailure(parsed);
  } catch {
    return /"status"\s*:\s*"Failure"/.test(stdout) || /Suite result: FAILED/i.test(stdout)
      ? (summarizeForgeOutput(stdout) ?? "Forge reported failing tests.")
      : undefined;
  }
}

function findForgeJsonFailure(value: unknown, pathParts: string[] = []): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const hit = findForgeJsonFailure(entry, pathParts);
      if (hit) return hit;
    }
    return undefined;
  }
  const object = value as Record<string, unknown>;
  if (object.status === "Failure") {
    const name = pathParts[pathParts.length - 1];
    const reason = stringField(object, ["reason", "message"]);
    if (name && reason) return `${name}: ${reason}`;
    if (name) return name;
    return reason ? `Forge test failed: ${reason}` : "Forge reported a failing test.";
  }
  for (const [key, entry] of Object.entries(object)) {
    const hit = findForgeJsonFailure(entry, [...pathParts, key]);
    if (hit) return hit;
  }
  return undefined;
}

function summarizeForgeOutput(output: string | undefined, maxLength = 1200): string | undefined {
  const lines = (output ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return undefined;
  const interesting = lines.filter(
    (line) =>
      /error|fail|revert|panic|reason|compiler|solc|no such file|permission denied/i.test(line) &&
      !/^\{/.test(line),
  );
  const summary = (interesting.length > 0 ? interesting : lines).slice(0, 8).join("\n");
  return summary.length > maxLength ? `${summary.slice(0, maxLength - 1)}…` : summary;
}

async function copyMutantOverlay(from: string, to: string): Promise<void> {
  await fs.promises.cp(from, to, {
    recursive: true,
    dereference: false,
    force: true,
    filter: (source) => {
      const name = path.basename(source);
      return !EXCLUDED_COPY_ENTRIES.has(name) && name !== "README.md";
    },
  });
}

async function copyForgeProject(
  from: string,
  to: string,
  options: { includeBuildArtifacts?: boolean } = {},
): Promise<void> {
  await fs.promises.cp(from, to, {
    recursive: true,
    dereference: false,
    filter: (source) => {
      const name = path.basename(source);
      if (options.includeBuildArtifacts && (name === "cache" || name === "out")) {
        return true;
      }
      return !EXCLUDED_COPY_ENTRIES.has(name);
    },
  });
}

async function findSolidityFiles(root: string, includeTests: boolean): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (EXCLUDED_COPY_ENTRIES.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".sol")) {
        const relativePath = path.relative(root, fullPath);
        if (includeTests || !isTestPath(relativePath)) found.push(fullPath);
      }
    }
  }
  await walk(root);
  return found.sort();
}

async function cleanupMutationCandidates(candidates: MutationCandidate[]): Promise<void> {
  const roots = new Set(candidates.map((c) => c.cleanupRoot).filter((v): v is string => !!v));
  await Promise.all(
    Array.from(roots).map((root) => fs.promises.rm(root, { recursive: true, force: true })),
  );
}

function findMutationForgeRoot(
  targetFile: string | undefined,
  workspaceRoot: string,
): string | null {
  if (targetFile) {
    return findForgeRoot(targetFile);
  }
  const candidate = path.join(workspaceRoot, "foundry.toml");
  if (fs.existsSync(candidate)) {
    return workspaceRoot;
  }
  const nested = findNestedFoundryRoot(workspaceRoot);
  return nested ?? findForgeRoot(path.join(workspaceRoot, "src", "_.sol"));
}

function findNestedFoundryRoot(workspaceRoot: string): string | null {
  const queue = [workspaceRoot];
  for (let visited = 0; queue.length > 0 && visited < 256; visited++) {
    const dir = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (EXCLUDED_COPY_ENTRIES.has(entry.name) || entry.name === "lib") continue;
      const fullPath = path.join(dir, entry.name);
      if (fs.existsSync(path.join(fullPath, "foundry.toml"))) {
        return fullPath;
      }
      queue.push(fullPath);
    }
  }
  return null;
}

function mutationEngine(value: string | undefined): MutationEngine {
  return value === "gambit" ? "gambit" : "builtin";
}

function stringArraySetting(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

function tokenColumns(line: string, token: string): number[] {
  const columns: number[] = [];
  let cursor = 0;
  while (cursor < line.length) {
    const idx = line.indexOf(token, cursor);
    if (idx === -1) break;
    if (!isPartOfLongerOperator(line, idx, token) && !isInsideQuotedString(line, idx)) {
      columns.push(idx);
    }
    cursor = idx + token.length;
  }
  return columns;
}

function isPartOfLongerOperator(line: string, idx: number, token: string): boolean {
  const before = line[idx - 1] ?? "";
  const after = line[idx + token.length] ?? "";
  if (["+", "-", ">", "<"].includes(token) && (before === token || after === token)) {
    return true;
  }
  if ((token === ">" || token === "<") && before === ".") {
    return true;
  }
  if ((token === ">" || token === "<" || token === "+" || token === "-") && after === token) {
    return true;
  }
  if ((token === ">" || token === "<" || token === "!" || token === "=") && after === "=") {
    return true;
  }
  if ((token === "+" || token === "-") && after === "=") {
    return true;
  }
  if ((token === "+" || token === "-") && before === "=") {
    return true;
  }
  if ((token === ">" || token === "<") && before === "=") {
    return true;
  }
  if ((token === "==" || token === "!=" || token === ">=" || token === "<=") && before === "=") {
    return true;
  }
  return false;
}

function shouldSkipMutationLine(line: string): boolean {
  return (
    line.trim().length === 0 ||
    /^\s*(import|pragma|using)\b/.test(line) ||
    /^\s*\/\//.test(line) ||
    /\b(event|error|struct|enum)\b/.test(line)
  );
}

function stripCommentsFromLine(
  line: string,
  startsInBlockComment: boolean,
): { code: string; inBlockComment: boolean } {
  let inBlockComment = startsInBlockComment;
  let inSingle = false;
  let inDouble = false;
  let code = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1] ?? "";
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      code += " ";
      continue;
    }
    if (ch === "'" && !inDouble && line[i - 1] !== "\\") {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle && line[i - 1] !== "\\") {
      inDouble = !inDouble;
    }
    if (!inSingle && !inDouble && ch === "/" && next === "/") {
      break;
    }
    if (!inSingle && !inDouble && ch === "/" && next === "*") {
      inBlockComment = true;
      code += " ";
      i += 1;
      continue;
    }
    code += ch;
  }
  return { code, inBlockComment };
}

function isInsideQuotedString(line: string, idx: number): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < idx; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble && line[i - 1] !== "\\") inSingle = !inSingle;
    if (ch === '"' && !inSingle && line[i - 1] !== "\\") inDouble = !inDouble;
  }
  return inSingle || inDouble;
}

function isTestPath(relativePath: string): boolean {
  return relativePath.split(path.sep).includes("test") || relativePath.endsWith(".t.sol");
}

function clampPositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function formatResultLine(result: MutationResult): string {
  const c = result.candidate;
  const message = result.message ? ` - ${result.message}` : "";
  return `${result.status.toUpperCase()} ${c.relativePath}:${c.range.start.line + 1} ${c.original}->${c.replacement} (${result.durationMs}ms)${message}`;
}

function sanitizeSolidityIdentifier(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `test_${cleaned}`;
}
