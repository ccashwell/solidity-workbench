import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LanguageClient } from "vscode-languageclient/node";
import {
  ListTests,
  type ListTestsParams,
  type ListTestsResult,
  type TestContractInfo,
} from "@solidity-workbench/common";

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
        const args = ["test", "--json"];

        const parts = item.id.split("::");
        if (parts.length >= 3) {
          args.push("--match-test", parts[2]);
          args.push("--match-contract", parts[1]);
        } else if (parts.length >= 2) {
          args.push("--match-contract", parts[1]);
        }
        if (parts[0]) {
          args.push("--match-path", parts[0]);
        }

        args.push(`${"-".repeat(verbosity)}v`);

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) continue;

        const result = await execFileAsync(forgePath, args, {
          cwd: workspaceFolder.uri.fsPath,
          maxBuffer: 10 * 1024 * 1024,
          timeout: 120_000,
        });

        this.processTestOutput(run, item, result.stdout);
      } catch (err: any) {
        if (err.stdout) {
          this.processTestOutput(run, item, err.stdout);
        } else {
          run.failed(item, new vscode.TestMessage(err.message));
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

  private processTestOutput(run: vscode.TestRun, item: vscode.TestItem, stdout: string): void {
    try {
      const lines = stdout.trim().split("\n");
      for (const line of lines) {
        try {
          const data = JSON.parse(line);
          this.processTestJson(run, item, data);
        } catch {
          /* Not JSON, skip */
        }
      }
    } catch {
      run.passed(item);
    }
  }

  private processTestJson(run: vscode.TestRun, parentItem: vscode.TestItem, data: any): void {
    if (data.test_results) {
      for (const [name, result] of Object.entries(data.test_results) as any) {
        const childItem = this.findChildByName(parentItem, name) ?? parentItem;

        if (result.status === "Success") {
          run.passed(childItem, result.duration?.secs ? result.duration.secs * 1000 : undefined);
        } else if (result.status === "Failure") {
          const message = new vscode.TestMessage(result.reason ?? "Test failed");
          if (result.counterexample) {
            message.message += `\n\nCounterexample: ${JSON.stringify(result.counterexample)}`;
          }
          run.failed(childItem, message);
        } else {
          run.skipped(childItem);
        }
      }
    }
  }

  private findChildByName(parent: vscode.TestItem, name: string): vscode.TestItem | undefined {
    let found: vscode.TestItem | undefined;
    parent.children.forEach((child) => {
      if (child.label === name || child.id.endsWith(`::${name}`)) {
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
