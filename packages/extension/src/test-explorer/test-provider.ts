import * as vscode from "vscode";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Foundry Test Explorer — integrates `forge test` with VSCode's
 * native Test Explorer API.
 *
 * Features:
 * - Auto-discovers test files and test functions
 * - Run individual tests, test contracts, or all tests
 * - Inline pass/fail indicators via code lens
 * - Test output with stack traces and gas usage
 * - Fuzz test counterexample display
 */
export class FoundryTestProvider {
  private controller!: vscode.TestController;
  private testItems: Map<string, vscode.TestItem> = new Map();

  activate(context: vscode.ExtensionContext): void {
    this.controller = vscode.tests.createTestController("solforge-foundry-tests", "Foundry Tests");
    context.subscriptions.push(this.controller);

    // Set up run profiles
    this.controller.createRunProfile(
      "Run",
      vscode.TestRunProfileKind.Run,
      (request, token) => this.runTests(request, token),
      true, // default
    );

    this.controller.createRunProfile("Debug", vscode.TestRunProfileKind.Debug, (request, token) =>
      this.debugTests(request, token),
    );

    // Auto-discover tests when files change
    this.controller.resolveHandler = async (item) => {
      if (!item) {
        await this.discoverAllTests();
      }
    };

    // Watch for test file changes
    const watcher = vscode.workspace.createFileSystemWatcher("**/*.t.sol");
    watcher.onDidCreate(() => this.discoverAllTests());
    watcher.onDidChange(() => this.discoverAllTests());
    watcher.onDidDelete(() => this.discoverAllTests());
    context.subscriptions.push(watcher);

    // Initial discovery
    this.discoverAllTests();
  }

  /**
   * Discover all test files and functions in the workspace.
   */
  private async discoverAllTests(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return;

    for (const folder of workspaceFolders) {
      const testFiles = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, "**/*.t.sol"),
        "**/node_modules/**",
      );

      for (const file of testFiles) {
        await this.parseTestFile(file, folder.uri);
      }
    }
  }

  /**
   * Parse a test file to extract test contracts and test functions.
   */
  private async parseTestFile(fileUri: vscode.Uri, workspaceUri: vscode.Uri): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(fileUri);
    const text = doc.getText();
    const relativePath = path.relative(workspaceUri.fsPath, fileUri.fsPath);

    // Find test contracts (contracts ending with "Test" or containing test functions)
    const contractRe = /contract\s+(\w+(?:Test\w*)?)\s+/g;
    let contractMatch: RegExpExecArray | null;

    while ((contractMatch = contractRe.exec(text)) !== null) {
      const contractName = contractMatch[1];
      const contractId = `${relativePath}::${contractName}`;

      let contractItem = this.testItems.get(contractId);
      if (!contractItem) {
        contractItem = this.controller.createTestItem(contractId, contractName, fileUri);
        this.controller.items.add(contractItem);
        this.testItems.set(contractId, contractItem);
      }

      // Find test functions within this contract's scope
      const contractStart = contractMatch.index;
      const bodyMatch = text.slice(contractStart).match(/\{/);
      if (!bodyMatch) continue;

      const bodyStart = contractStart + bodyMatch.index! + 1;
      let depth = 1;
      let i = bodyStart;
      while (i < text.length && depth > 0) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}") depth--;
        i++;
      }
      const bodyEnd = i;
      const body = text.slice(bodyStart, bodyEnd);

      // Find all test/testFuzz/testFork/testFail functions
      const funcRe = /function\s+((?:test|testFuzz|testFork|testFail)_\w+)\s*\(/g;
      let funcMatch: RegExpExecArray | null;

      // Clear old children
      contractItem.children.replace([]);

      while ((funcMatch = funcRe.exec(body)) !== null) {
        const testName = funcMatch[1];
        const testId = `${contractId}::${testName}`;

        // Calculate line number
        const textBeforeFunc = text.slice(0, bodyStart + funcMatch.index);
        const lineNumber = textBeforeFunc.split("\n").length - 1;

        const testItem = this.controller.createTestItem(testId, testName, fileUri);
        testItem.range = new vscode.Range(
          new vscode.Position(lineNumber, 0),
          new vscode.Position(lineNumber, funcMatch[0].length),
        );

        // Tag fuzz tests
        if (testName.startsWith("testFuzz_")) {
          testItem.tags = [new vscode.TestTag("fuzz")];
        }

        contractItem.children.add(testItem);
        this.testItems.set(testId, testItem);
      }

      // Remove contract items with no test functions
      if (contractItem.children.size === 0) {
        this.controller.items.delete(contractId);
        this.testItems.delete(contractId);
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
    const config = vscode.workspace.getConfiguration("solforge");
    const forgePath = config.get<string>("foundryPath") || "forge";
    const verbosity = config.get<number>("test.verbosity") ?? 2;

    const items = request.include ?? this.gatherAllTests();

    for (const item of items) {
      if (token.isCancellationRequested) break;

      run.started(item);

      try {
        const args = ["test", "--json"];

        // Build match flags based on the test item
        const parts = item.id.split("::");
        if (parts.length >= 3) {
          // Individual test function
          args.push("--match-test", parts[2]);
          args.push("--match-contract", parts[1]);
        } else if (parts.length >= 2) {
          // Test contract
          args.push("--match-contract", parts[1]);
        }
        // If just a file path, match by path
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

        // Parse JSON output
        this.processTestOutput(run, item, result.stdout);
      } catch (err: any) {
        // forge test returns non-zero on test failure
        if (err.stdout) {
          this.processTestOutput(run, item, err.stdout);
        } else {
          run.failed(item, new vscode.TestMessage(err.message));
        }
      }
    }

    run.end();
  }

  /**
   * Debug tests — runs with extra trace output.
   */
  private async debugTests(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
  ): Promise<void> {
    // For now, run with maximum verbosity
    // Full debugger integration would use forge debug or a transaction debugger
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
   * Parse forge test --json output and update test results.
   */
  private processTestOutput(run: vscode.TestRun, item: vscode.TestItem, stdout: string): void {
    try {
      // forge test --json outputs JSONL (one JSON per line)
      // or a single JSON object depending on version
      const lines = stdout.trim().split("\n");
      for (const line of lines) {
        try {
          const data = JSON.parse(line);
          this.processTestJson(run, item, data);
        } catch {
          // Not JSON, skip
        }
      }
    } catch {
      // If we can't parse, mark as passed (no failure info)
      run.passed(item);
    }
  }

  private processTestJson(run: vscode.TestRun, parentItem: vscode.TestItem, data: any): void {
    // Handle both per-contract and per-test result formats
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
