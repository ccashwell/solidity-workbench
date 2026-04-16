import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Solidity Transaction Debugger — terminal-based fallback.
 *
 * Exposes three commands (`solidity-workbench.debugTest`, `solidity-workbench.debugScript`,
 * `solidity-workbench.debugTransaction`) that shell out to `forge test --debug`,
 * `forge debug <script>`, and `forge debug --rpc-url <url> <txHash>` in a
 * dedicated VSCode terminal. This gives users step-through EVM debugging
 * via forge's built-in TUI without requiring a Debug Adapter Protocol
 * server.
 *
 * A full DAP implementation is planned; see PRODUCTION_GAPS.md.
 */
export class SolidityDebugProvider {
  activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.commands.registerCommand("solidity-workbench.debugTest", (testName?: string) =>
        this.debugTest(testName),
      ),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand("solidity-workbench.debugScript", () => this.debugScript()),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand("solidity-workbench.debugTransaction", () =>
        this.debugTransaction(),
      ),
    );
  }

  /**
   * Debug a specific test function using forge's trace output.
   */
  private async debugTest(testName?: string): Promise<void> {
    if (!testName) {
      // Try to detect from cursor position
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        testName = this.findTestAtCursor(editor);
      }
    }

    if (!testName) {
      testName = await vscode.window.showInputBox({
        title: "Test Function Name",
        placeHolder: "test_myFunction",
      });
    }

    if (!testName) return;

    const config = vscode.workspace.getConfiguration("solidity-workbench");
    const forgePath = config.get<string>("foundryPath") || "forge";

    // Use the terminal-based debugger with maximum verbosity and debug flag
    const terminal = vscode.window.createTerminal({
      name: `Debug: ${testName}`,
      iconPath: new vscode.ThemeIcon("debug"),
    });
    terminal.show();
    terminal.sendText(`${forgePath} test --match-test "${testName}" --debug`);
  }

  /**
   * Debug a script file.
   */
  private async debugScript(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const scriptFile = editor?.document.fileName;

    if (!scriptFile?.endsWith(".s.sol")) {
      vscode.window.showWarningMessage("Open a script file (.s.sol) first.");
      return;
    }

    const config = vscode.workspace.getConfiguration("solidity-workbench");
    const forgePath = config.get<string>("foundryPath") || "forge";

    const terminal = vscode.window.createTerminal({
      name: `Debug: ${scriptFile.split("/").pop()}`,
      iconPath: new vscode.ThemeIcon("debug"),
    });
    terminal.show();
    terminal.sendText(`${forgePath} debug ${scriptFile}`);
  }

  /**
   * Debug a transaction by replaying it.
   */
  private async debugTransaction(): Promise<void> {
    const txHash = await vscode.window.showInputBox({
      title: "Transaction Hash",
      placeHolder: "0x...",
      prompt: "Enter the transaction hash to debug",
    });
    if (!txHash) return;

    const rpcUrl = await vscode.window.showInputBox({
      title: "RPC URL",
      value: "http://127.0.0.1:8545",
      prompt: "Enter the RPC URL for the chain the transaction is on",
    });
    if (!rpcUrl) return;

    const config = vscode.workspace.getConfiguration("solidity-workbench");
    const forgePath = config.get<string>("foundryPath") || "forge";

    const terminal = vscode.window.createTerminal({
      name: `Debug: ${txHash.slice(0, 10)}...`,
      iconPath: new vscode.ThemeIcon("debug"),
    });
    terminal.show();
    terminal.sendText(`${forgePath} debug --rpc-url ${rpcUrl} ${txHash}`);
  }

  /**
   * Parse a forge trace and create a structured debug view.
   * This processes the -vvvvv trace output into a navigable format.
   */
  async parseTrace(testName: string): Promise<TraceEntry[] | null> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return null;

    const config = vscode.workspace.getConfiguration("solidity-workbench");
    const forgePath = config.get<string>("foundryPath") || "forge";

    try {
      const result = await execFileAsync(
        forgePath,
        ["test", "--match-test", testName, "-vvvvv", "--json"],
        {
          cwd: workspaceFolder.uri.fsPath,
          maxBuffer: 50 * 1024 * 1024,
          timeout: 120_000,
        },
      );

      return this.parseTraceOutput(result.stdout);
    } catch (err: any) {
      if (err.stdout) return this.parseTraceOutput(err.stdout);
      return null;
    }
  }

  private parseTraceOutput(output: string): TraceEntry[] {
    const entries: TraceEntry[] = [];
    const lines = output.split("\n");

    for (const line of lines) {
      // Parse trace lines like:
      // [123456] ContractName::functionName(args) [call/staticcall/delegatecall]
      const traceMatch = line.match(/\[(\d+)\]\s+(\w+)::(\w+)\((.*?)\)\s*(?:\[(\w+)\])?/);

      if (traceMatch) {
        entries.push({
          gasUsed: parseInt(traceMatch[1]),
          contract: traceMatch[2],
          function: traceMatch[3],
          args: traceMatch[4],
          callType: traceMatch[5] ?? "call",
          depth: (line.match(/^\s*/)?.[0].length ?? 0) / 2,
        });
      }
    }

    return entries;
  }

  private findTestAtCursor(editor: vscode.TextEditor): string | null {
    const pos = editor.selection.active;
    for (let line = pos.line; line >= 0; line--) {
      const text = editor.document.lineAt(line).text;
      const match = text.match(/function\s+((?:test|testFuzz|testFork|testFail)_\w+)\s*\(/);
      if (match) return match[1];
      if (/^\s*(?:contract|interface|library)\s/.test(text)) break;
    }
    return null;
  }
}

interface TraceEntry {
  gasUsed: number;
  contract: string;
  function: string;
  args: string;
  callType: string;
  depth: number;
}
