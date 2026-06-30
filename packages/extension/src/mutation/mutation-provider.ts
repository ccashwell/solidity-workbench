import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { findForgeRoot, forgeVerbosityFlag } from "@solidity-workbench/common";

const execFileAsync = promisify(execFile);

export type MutationStatus = "killed" | "survived" | "timeout" | "error";

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

  constructor() {
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
    const timeoutMs = clampPositiveInt(config.get<number>("mutation.timeoutMs"), 120_000);
    const includeTests = config.get<boolean>("mutation.includeTests") ?? false;
    const forgePath = config.get<string>("foundryPath") || "forge";
    const verbosity = config.get<number>("test.verbosity") ?? 2;
    const candidates = await collectMutationCandidates({
      forgeRoot,
      targetFile: options.targetFile?.fsPath,
      includeTests,
      maxMutants,
    });

    if (candidates.length === 0) {
      vscode.window.showInformationMessage("No mutation candidates found for the selected scope.");
      return;
    }

    this.outputChannel.clear();
    this.outputChannel.show(true);
    this.outputChannel.appendLine(`Generated ${candidates.length} mutation candidates.`);

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Running ${candidates.length} Solidity mutation tests`,
        cancellable: true,
      },
      async (progress, token) => {
        const results: MutationResult[] = [];
        for (let i = 0; i < candidates.length; i++) {
          if (token.isCancellationRequested) break;
          const candidate = candidates[i];
          progress.report({
            increment: 100 / candidates.length,
            message: `${i + 1}/${candidates.length}: ${candidate.relativePath}:${candidate.range.start.line + 1}`,
          });
          const result = await runCandidate({
            candidate,
            forgeRoot,
            forgePath,
            timeoutMs,
            verbosity,
          });
          results.push(result);
          this.outputChannel.appendLine(formatResultLine(result));
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
}): Promise<MutationCandidate[]> {
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

export function buildMutationCandidates(
  text: string,
  options: { uri: string; filePath: string; relativePath: string; maxMutants?: number },
): MutationCandidate[] {
  const maxMutants = Math.max(1, options.maxMutants ?? 25);
  const lines = text.split(/\r?\n/);
  const candidates: MutationCandidate[] = [];
  let contractName: string | undefined;
  let functionName: string | undefined;

  for (let lineNo = 0; lineNo < lines.length && candidates.length < maxMutants; lineNo++) {
    const line = lines[lineNo];
    const code = stripLineComment(line);
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
}): Promise<MutationResult> {
  const started = Date.now();
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "solidity-workbench-mutant-"));
  try {
    await copyForgeProject(options.forgeRoot, tempRoot);
    const relativePath = path.relative(options.forgeRoot, options.candidate.filePath);
    const tempFile = path.join(tempRoot, relativePath);
    const originalText = await fs.promises.readFile(tempFile, "utf-8");
    await fs.promises.writeFile(tempFile, applyMutation(originalText, options.candidate), "utf-8");
    const args = ["test", "--json"];
    const verbosityFlag = forgeVerbosityFlag(options.verbosity);
    if (verbosityFlag) args.push(verbosityFlag);
    const result = await execFileAsync(options.forgePath, args, {
      cwd: tempRoot,
      maxBuffer: 50 * 1024 * 1024,
      timeout: options.timeoutMs,
    });
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
    return {
      candidate: options.candidate,
      status: timedOut ? "timeout" : mutationFailureStatus(e),
      durationMs: Date.now() - started,
      stdout: e.stdout,
      stderr: e.stderr,
      message: e.stderr?.trim() || e.message,
    };
  } finally {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  }
}

function mutationFailureStatus(err: {
  stdout?: string;
  stderr?: string;
  message?: string;
}): MutationStatus {
  const output = `${err.stdout ?? ""}\n${err.stderr ?? ""}\n${err.message ?? ""}`;
  if (/Failing tests|Encountered \d+ failing test|FAIL|Suite result: FAILED/i.test(output)) {
    return "killed";
  }
  return "error";
}

async function copyForgeProject(from: string, to: string): Promise<void> {
  await fs.promises.cp(from, to, {
    recursive: true,
    dereference: false,
    filter: (source) => {
      const name = path.basename(source);
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
  if ((token === ">" || token === "<" || token === "+" || token === "-") && after === token) {
    return true;
  }
  if ((token === ">" || token === "<" || token === "!" || token === "=") && after === "=") {
    return true;
  }
  if ((token === "+" || token === "-") && after === "=") {
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

function stripLineComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length - 1; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble && line[i - 1] !== "\\") inSingle = !inSingle;
    if (ch === '"' && !inSingle && line[i - 1] !== "\\") inDouble = !inDouble;
    if (!inSingle && !inDouble && ch === "/" && line[i + 1] === "/") return line.slice(0, i);
  }
  return line;
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
  return `${result.status.toUpperCase()} ${c.relativePath}:${c.range.start.line + 1} ${c.original}->${c.replacement} (${result.durationMs}ms)`;
}

function sanitizeSolidityIdentifier(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `test_${cleaned}`;
}
