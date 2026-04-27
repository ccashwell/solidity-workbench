import * as vscode from "vscode";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LanguageClient } from "vscode-languageclient/node";
import {
  ListTests,
  type ListTestsParams,
  type ListTestsResult,
  type TestContractInfo,
  findForgeRoot,
  parseForgeDurationMs,
  stripForgeTestSignature,
} from "@solidity-workbench/common";
import { forgeVerbosityFlag } from "../config.js";

const execFileAsync = promisify(execFile);

/**
 * Foundry Test Explorer — integrates `forge test` with VSCode's native
 * Test Explorer API.
 *
 * Test discovery pipeline:
 *   1. Request `solidity-workbench/listTests` from the LSP server. The
 *      server walks its parsed-AST cache and returns a precise list of
 *      `{ uri, contractName, tests[] }` records. This replaces the
 *      previous client-side regex parse, which broke on braces inside
 *      strings and multi-line function headers.
 *   2. If the LSP client isn't ready (e.g. activation race), the
 *      watcher re-triggers discovery once LSP is up.
 *
 * Features:
 *   - Auto-discovered tree of contracts and tests
 *   - Run individual tests, whole contracts, or everything
 *   - Inline pass/fail indicators via code lens
 *   - Fuzz test counterexamples surfaced as TestMessage content
 */
export class FoundryTestProvider {
  private controller!: vscode.TestController;
  private testItems: Map<string, vscode.TestItem> = new Map();
  private client: LanguageClient | null = null;

  /** Provided by `extension.ts` once the LanguageClient has started. */
  setLanguageClient(client: LanguageClient): void {
    this.client = client;
    // Now that the server is up we can run the initial discovery for real.
    void this.discoverAllTests();
  }

  activate(context: vscode.ExtensionContext): void {
    this.controller = vscode.tests.createTestController(
      "solidity-workbench-foundry-tests",
      "Foundry Tests",
    );
    context.subscriptions.push(this.controller);

    this.controller.createRunProfile(
      "Run",
      vscode.TestRunProfileKind.Run,
      (request, token) => this.runTests(request, token),
      true,
    );

    this.controller.createRunProfile("Debug", vscode.TestRunProfileKind.Debug, (request, token) =>
      this.debugTests(request, token),
    );

    this.controller.resolveHandler = async (item) => {
      if (!item) {
        await this.discoverAllTests();
      }
    };

    // Watch for .sol changes — not just .t.sol, because tests can live
    // in any file and the LSP AST handles classification.
    const watcher = vscode.workspace.createFileSystemWatcher("**/*.sol");
    watcher.onDidCreate(() => this.discoverAllTests());
    watcher.onDidChange(() => this.discoverAllTests());
    watcher.onDidDelete(() => this.discoverAllTests());
    context.subscriptions.push(watcher);

    // Attempt initial discovery; it will no-op without a client and be
    // retried when `setLanguageClient` is called.
    void this.discoverAllTests();
  }

  /**
   * Enumerate test contracts across the workspace by asking the LSP.
   *
   * Diffs against `this.testItems` so we add / remove entries instead of
   * wiping the tree on every change.
   */
  private async discoverAllTests(): Promise<void> {
    if (!this.client || this.client.state !== 2 /* LanguageClient.State.Running */) {
      // Server not up yet. `setLanguageClient` triggers a re-run.
      return;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return;

    const allContracts: TestContractInfo[] = [];
    for (const folder of workspaceFolders) {
      try {
        const params: ListTestsParams = { folderUri: folder.uri.toString() };
        const result = await this.client.sendRequest<ListTestsResult>(ListTests, params);
        allContracts.push(...result.contracts);
      } catch (err) {
        console.warn(`[test-explorer] listTests failed for ${folder.uri.toString()}:`, err);
      }
    }

    const seenIds = new Set<string>();

    for (const contract of allContracts) {
      // We only surface tests that live in files the user would expect
      // (`.t.sol` today, future: also configurable paths). Non-test-file
      // contracts that happen to have a `setUp` are skipped.
      const isTestFile = contract.uri.endsWith(".t.sol");
      if (!isTestFile) continue;

      const fileUri = vscode.Uri.parse(contract.uri);
      const relativePath = vscode.workspace.asRelativePath(fileUri);
      const contractId = `${relativePath}::${contract.name}`;

      let contractItem = this.testItems.get(contractId);
      if (!contractItem) {
        contractItem = this.controller.createTestItem(contractId, contract.name, fileUri);
        this.controller.items.add(contractItem);
        this.testItems.set(contractId, contractItem);
      }
      contractItem.range = new vscode.Range(
        new vscode.Position(contract.range.start.line, contract.range.start.character),
        new vscode.Position(contract.range.end.line, contract.range.end.character),
      );

      // Rebuild children from the LSP response so removed tests vanish.
      contractItem.children.replace([]);
      seenIds.add(contractId);

      for (const test of contract.tests) {
        // `setUp` is infrastructure, not a runnable test. Still track it
        // so the count of "things in this contract" is accurate? No —
        // keep the tree clean.
        if (test.kind === "setUp") continue;

        const testId = `${contractId}::${test.name}`;
        const testItem = this.controller.createTestItem(testId, test.name, fileUri);
        testItem.range = new vscode.Range(
          new vscode.Position(test.range.start.line, test.range.start.character),
          new vscode.Position(test.range.end.line, test.range.end.character),
        );

        const tags: vscode.TestTag[] = [];
        if (test.kind === "testFuzz") tags.push(new vscode.TestTag("fuzz"));
        if (test.kind === "testFork") tags.push(new vscode.TestTag("fork"));
        if (test.kind === "testFail") tags.push(new vscode.TestTag("fail"));
        if (test.kind === "invariant") tags.push(new vscode.TestTag("invariant"));
        testItem.tags = tags;

        contractItem.children.add(testItem);
        this.testItems.set(testId, testItem);
        seenIds.add(testId);
      }
    }

    // Garbage-collect items that no longer exist (deleted contracts,
    // renamed tests, or tests moved to a different contract).
    for (const id of Array.from(this.testItems.keys())) {
      if (!seenIds.has(id)) {
        // Only remove top-level contract items from the controller;
        // child tests are removed via their parent's children.replace().
        if (id.split("::").length === 2) {
          this.controller.items.delete(id);
        }
        this.testItems.delete(id);
      }
    }
  }

  /**
   * Run selected tests via `forge test --json`.
   */
  private async runTests(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const run = this.controller.createTestRun(request);
    const config = vscode.workspace.getConfiguration("solidity-workbench");
    const forgePath = config.get<string>("foundryPath") || "forge";
    const verbosity = config.get<number>("test.verbosity") ?? 2;

    const items = request.include ?? this.gatherAllTests();

    for (const item of items) {
      if (token.isCancellationRequested) break;

      run.started(item);

      try {
        // Each test runs in its own Foundry project root — the directory
        // containing the nearest `foundry.toml` walking up from the test
        // file. This lets the Test Explorer work in monorepos where the
        // VSCode workspace root sits above the actual Foundry project
        // (e.g. this repo's `test/fixtures/sample-project/`), and also
        // across workspaces with several parallel Foundry projects.
        const testFilePath = item.uri?.fsPath;
        if (!testFilePath) {
          run.failed(
            item,
            new vscode.TestMessage("Test item has no file URI; cannot locate its Foundry project."),
          );
          continue;
        }
        const forgeRoot = findForgeRoot(testFilePath);
        if (!forgeRoot) {
          run.failed(
            item,
            new vscode.TestMessage(
              `No foundry.toml found walking up from ${testFilePath}. Is this test inside a Foundry project?`,
            ),
          );
          continue;
        }
        const matchPath = path.relative(forgeRoot, testFilePath);

        const args = ["test", "--json"];
        const parts = item.id.split("::");
        if (parts.length >= 3) {
          args.push("--match-test", parts[2]);
          args.push("--match-contract", parts[1]);
        } else if (parts.length >= 2) {
          args.push("--match-contract", parts[1]);
        }
        args.push("--match-path", matchPath);

        const verbosityFlag = forgeVerbosityFlag(verbosity);
        if (verbosityFlag) args.push(verbosityFlag);

        // Echo the command into the run's output pane so the user sees
        // exactly what's being executed — no `--json` noise (it's an
        // implementation detail), but every other arg verbatim.
        const displayArgs = args.filter((a) => a !== "--json");
        appendOutputLine(run, `$ ${forgePath} ${displayArgs.join(" ")}`);
        appendOutputLine(run, `  (cwd: ${forgeRoot})`);
        appendOutputLine(run, "");

        const result = await execFileAsync(forgePath, args, {
          cwd: forgeRoot,
          maxBuffer: 10 * 1024 * 1024,
          timeout: 120_000,
        });

        this.processTestOutput(run, item, result.stdout);
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        if (typeof e.stdout === "string" && e.stdout.length > 0) {
          this.processTestOutput(run, item, e.stdout);
        } else {
          // Surface stderr when forge failed before producing any
          // stdout (build error, binary missing, etc.) so the user
          // sees why rather than an opaque "no output".
          const detail = (e.stderr || e.message || "forge test failed").trim();
          appendOutputBlock(run, item, detail);
          run.failed(item, new vscode.TestMessage(detail));
        }
      }
    }

    run.end();
  }

  private async debugTests(
    request: vscode.TestRunRequest,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const items = request.include ?? this.gatherAllTests();
    for (const item of items) {
      const parts = item.id.split("::");
      const testName = parts[parts.length - 1];

      const terminal = vscode.window.createTerminal({
        name: `Debug: ${testName}`,
        iconPath: new vscode.ThemeIcon("debug"),
      });
      terminal.show();
      terminal.sendText(`forge test --match-test ${testName} -vvvvv`);
    }
  }

  /**
   * Parse a `forge test --json` payload and drive the TestRun.
   *
   * The output shape is a single JSON object (one line, no newlines
   * inside) keyed by `<file>:<Contract>`:
   *
   *   {
   *     "test/Counter.t.sol:CounterTest": {
   *       "duration": "2ms 860µs 417ns",
   *       "test_results": {
   *         "test_Increment()": { "status": "Success", ... },
   *         "testFuzz_IncrementBy(uint256)": { "status": "Failure", "counterexample": {...}, ... }
   *       },
   *       "warnings": []
   *     }
   *   }
   *
   * An earlier implementation split the output line-by-line and read
   * `data.test_results` one level too shallow — both wrong against
   * real forge output, so nothing ever got reported back to the Test
   * Explorer. The pipeline now parses the whole blob and walks both
   * levels.
   */
  private processTestOutput(run: vscode.TestRun, item: vscode.TestItem, stdout: string): void {
    const trimmed = stdout.trim();
    if (!trimmed) {
      appendOutputBlock(run, item, "forge test produced no output");
      run.failed(item, new vscode.TestMessage("forge test produced no output"));
      return;
    }

    let data: unknown;
    try {
      data = JSON.parse(trimmed);
    } catch {
      // Forge failed to produce a JSON blob — typically because the
      // build crashed before any test ran. Surface the raw text so the
      // user has something to work with.
      appendOutputBlock(run, item, trimmed);
      run.failed(
        item,
        new vscode.TestMessage(
          `forge test did not emit JSON. Raw output:\n\n${trimmed.slice(0, 4_000)}`,
        ),
      );
      return;
    }
    if (!data || typeof data !== "object") {
      run.failed(item, new vscode.TestMessage("forge test JSON was not an object"));
      return;
    }

    let reportedAny = false;
    for (const [suiteId, suite] of Object.entries(data as Record<string, unknown>)) {
      if (!suite || typeof suite !== "object") continue;
      const s = suite as { test_results?: Record<string, unknown> };
      if (!s.test_results || typeof s.test_results !== "object") continue;
      reportedAny ||= this.reportSuiteResults(run, item, suiteId, s.test_results);
    }

    if (!reportedAny) {
      // JSON parsed but contained no test_results for us — mark the
      // parent as skipped rather than leaving it in the started state
      // forever, which is what produced the "run but nothing shows"
      // symptom.
      run.skipped(item);
    }
  }

  private reportSuiteResults(
    run: vscode.TestRun,
    parentItem: vscode.TestItem,
    suiteId: string,
    testResults: Record<string, unknown>,
  ): boolean {
    let reportedAny = false;
    let passed = 0;
    let failed = 0;
    let skipped = 0;

    for (const [rawName, raw] of Object.entries(testResults)) {
      if (!raw || typeof raw !== "object") continue;
      const result = raw as {
        status?: string;
        reason?: string | null;
        counterexample?: unknown;
        duration?: unknown;
        decoded_logs?: unknown;
        kind?: unknown;
      };

      const childItem = this.findChildByName(parentItem, rawName) ?? parentItem;
      const durationMs = parseForgeDurationMs(result.duration);
      reportedAny = true;

      // Build a compact human-readable block per test for the run's
      // output pane. Associating it with `childItem` makes the test
      // result clickable — VSCode jumps to just this slice when the
      // user selects the test in the explorer.
      const headerLine = formatTestHeader(suiteId, rawName, result.status, durationMs, result.kind);
      appendOutputLine(run, headerLine, childItem);

      const decodedLogs = Array.isArray(result.decoded_logs) ? result.decoded_logs : [];
      for (const log of decodedLogs) {
        appendOutputLine(run, `    ${String(log)}`, childItem);
      }

      if (result.status === "Success") {
        run.passed(childItem, durationMs);
        passed += 1;
      } else if (result.status === "Failure") {
        const reasonLine = result.reason ?? "Test failed";
        appendOutputLine(run, `    reason: ${reasonLine}`, childItem);
        const lines = [reasonLine];
        if (result.counterexample) {
          const ce = JSON.stringify(result.counterexample);
          appendOutputLine(run, `    counterexample: ${ce}`, childItem);
          lines.push("", `Counterexample: ${ce}`);
        }
        run.failed(childItem, new vscode.TestMessage(lines.join("\n")), durationMs);
        failed += 1;
      } else {
        // "Skipped", "Warning", or any future status we don't recognize.
        run.skipped(childItem);
        skipped += 1;
      }
      appendOutputLine(run, "", childItem);
    }

    appendOutputLine(
      run,
      `[${suiteId}] ${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`,
      parentItem,
    );
    appendOutputLine(run, "", parentItem);
    return reportedAny;
  }

  /**
   * Forge emits test names as Solidity signatures including parens
   * and param types — `test_Increment()`, `testFuzz_Bound(uint256)` —
   * but our TestItem labels are the bare Solidity identifier
   * (`test_Increment`, `testFuzz_Bound`). Compare both forms, and
   * fall back to matching the id suffix for defensiveness.
   */
  private findChildByName(parent: vscode.TestItem, rawName: string): vscode.TestItem | undefined {
    const bareName = stripForgeTestSignature(rawName);
    let found: vscode.TestItem | undefined;
    parent.children.forEach((child) => {
      if (found) return;
      if (child.label === rawName || child.label === bareName) {
        found = child;
      } else if (child.id.endsWith(`::${rawName}`) || child.id.endsWith(`::${bareName}`)) {
        found = child;
      }
    });
    return found;
  }

  private gatherAllTests(): vscode.TestItem[] {
    const items: vscode.TestItem[] = [];
    this.controller.items.forEach((item) => items.push(item));
    return items;
  }
}

// ── Output formatting helpers ────────────────────────────────────────

/**
 * Append a single line to the test run's output pane. VSCode's
 * test-run output is a terminal-style channel — line terminators
 * must be CRLF (`\r\n`), not bare `\n`, or the next line writes
 * over the previous one. Wrapping `run.appendOutput` in a helper
 * keeps that detail in one place.
 *
 * When `item` is supplied the line is associated with that test
 * item, and selecting the item in the explorer scopes the output
 * pane to just its slice.
 */
function appendOutputLine(run: vscode.TestRun, line: string, item?: vscode.TestItem): void {
  run.appendOutput(`${line}\r\n`, undefined, item);
}

/** Append a multi-line block, normalizing newlines to CRLF. */
function appendOutputBlock(run: vscode.TestRun, item: vscode.TestItem, text: string): void {
  for (const line of text.split(/\r?\n/)) {
    appendOutputLine(run, line, item);
  }
}

/**
 * Render the per-test header line for the output pane:
 *
 *   ✓ CounterTest::test_Increment  (2.86ms, gas: 31303)
 *   ✗ CounterTest::testFuzz_Bound  (12.4ms, runs: 256)
 *   ⊘ CounterTest::test_Skipped
 *
 * `kind` is forge's nested gas/fuzz info — `{ Standard: 31303 }`
 * for plain tests, `{ Fuzz: { runs: 256, mean_gas: ... } }` for
 * fuzz, etc. We pull the most useful number out per shape.
 */
function formatTestHeader(
  suiteId: string,
  rawName: string,
  status: string | undefined,
  durationMs: number | undefined,
  kind: unknown,
): string {
  const glyph = status === "Success" ? "✓" : status === "Failure" ? "✗" : "⊘";
  const detail: string[] = [];
  if (typeof durationMs === "number" && Number.isFinite(durationMs)) {
    detail.push(`${durationMs.toFixed(2)}ms`);
  }
  const gasOrRuns = formatKind(kind);
  if (gasOrRuns) detail.push(gasOrRuns);
  const tail = detail.length > 0 ? `  (${detail.join(", ")})` : "";
  return `${glyph} ${suiteId}::${rawName}${tail}`;
}

function formatKind(kind: unknown): string | null {
  if (!kind || typeof kind !== "object") return null;
  const k = kind as Record<string, unknown>;
  // Forge wraps the gas/runs payload in a tagged-union shape:
  //   { Unit: { gas: 34426 } }                    — plain tests
  //   { Fuzz: { runs, mean_gas, median_gas, … } } — `testFuzz_*`
  //   { Invariant: { runs, calls, reverts, … } }  — `invariant_*`
  // (Older forges used `Standard` for the unit case; we accept it
  // too rather than dropping that ergonomics on users who haven't
  // updated foundryup.)
  const unit = (k.Unit ?? k.Standard) as { gas?: number } | undefined;
  if (unit && typeof unit.gas === "number") {
    return `gas: ${unit.gas.toLocaleString()}`;
  }
  if (k.Fuzz && typeof k.Fuzz === "object") {
    const f = k.Fuzz as { runs?: number; mean_gas?: number; median_gas?: number };
    const parts: string[] = [];
    if (typeof f.runs === "number") parts.push(`runs: ${f.runs}`);
    if (typeof f.mean_gas === "number") parts.push(`μgas: ${f.mean_gas.toLocaleString()}`);
    if (typeof f.median_gas === "number") parts.push(`med: ${f.median_gas.toLocaleString()}`);
    return parts.length > 0 ? parts.join(", ") : null;
  }
  if (k.Invariant && typeof k.Invariant === "object") {
    const i = k.Invariant as { runs?: number; calls?: number; reverts?: number };
    const parts: string[] = [];
    if (typeof i.runs === "number") parts.push(`runs: ${i.runs}`);
    if (typeof i.calls === "number") parts.push(`calls: ${i.calls}`);
    if (typeof i.reverts === "number") parts.push(`reverts: ${i.reverts}`);
    return parts.length > 0 ? parts.join(", ") : null;
  }
  return null;
}
