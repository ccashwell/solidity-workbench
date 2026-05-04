import * as vscode from "vscode";
import { forgeVerbosityFlag } from "../config.js";

/**
 * Registers Foundry-related commands in the extension.
 *
 * Commands:
 * - solidity-workbench.build: Run `forge build`
 * - solidity-workbench.test: Run `forge test`
 * - solidity-workbench.testFile: Run tests in the current file
 * - solidity-workbench.testFunction: Run the test at cursor
 * - solidity-workbench.format: Run `forge fmt`
 * - solidity-workbench.gasSnapshot: Run `forge snapshot`
 * - solidity-workbench.flatten: Flatten the current contract
 * - solidity-workbench.inspectStorage: Inspect storage layout
 */
export function registerFoundryCommands(context: vscode.ExtensionContext): void {
  const config = () => vscode.workspace.getConfiguration("solidity-workbench");

  function getForge(): string {
    return config().get<string>("foundryPath") || "forge";
  }

  // ── forge build ─────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("solidity-workbench.build", async () => {
      const terminal = getOrCreateTerminal();
      terminal.show();
      terminal.sendText(`${getForge()} build`);
    }),
  );

  // ── forge test ──────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("solidity-workbench.test", async () => {
      const terminal = getOrCreateTerminal();
      terminal.show();
      const verbosity = config().get<number>("test.verbosity") ?? 2;
      const flag = forgeVerbosityFlag(verbosity);
      terminal.sendText(`${getForge()} test${flag ? " " + flag : ""}`);
    }),
  );

  // ── forge test (current file) ──────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("solidity-workbench.testFile", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== "solidity") {
        vscode.window.showWarningMessage("Open a Solidity test file first.");
        return;
      }

      const filePath = editor.document.fileName;
      const terminal = getOrCreateTerminal();
      terminal.show();
      const verbosity = config().get<number>("test.verbosity") ?? 2;
      const flag = forgeVerbosityFlag(verbosity);
      terminal.sendText(`${getForge()} test --match-path ${filePath}${flag ? " " + flag : ""}`);
    }),
  );

  // ── forge test (function at cursor) ────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("solidity-workbench.testFunction", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== "solidity") {
        vscode.window.showWarningMessage("Open a Solidity test file first.");
        return;
      }

      const testName = findTestFunctionAtCursor(editor);
      if (!testName) {
        vscode.window.showWarningMessage(
          "Place cursor inside a test function (test_ or testFuzz_).",
        );
        return;
      }

      const terminal = getOrCreateTerminal();
      terminal.show();
      const verbosity = config().get<number>("test.verbosity") ?? 2;
      const flag = forgeVerbosityFlag(verbosity);
      terminal.sendText(`${getForge()} test --match-test ${testName}${flag ? " " + flag : ""}`);
    }),
  );

  // ── forge fmt ───────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("solidity-workbench.format", async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document.languageId === "solidity") {
        await vscode.commands.executeCommand("editor.action.formatDocument");
      } else {
        const terminal = getOrCreateTerminal();
        terminal.show();
        terminal.sendText(`${getForge()} fmt`);
      }
    }),
  );

  // ── forge snapshot ──────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("solidity-workbench.gasSnapshot", async () => {
      const terminal = getOrCreateTerminal();
      terminal.show();
      terminal.sendText(`${getForge()} snapshot`);
    }),
  );

  // ── forge flatten ───────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("solidity-workbench.flatten", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== "solidity") {
        vscode.window.showWarningMessage("Open a Solidity file first.");
        return;
      }

      const filePath = editor.document.fileName;
      const terminal = getOrCreateTerminal();
      terminal.show();
      terminal.sendText(`${getForge()} flatten ${filePath}`);
    }),
  );

  // ── copy selector ──────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("solidity-workbench.copySelector", async (selector: string) => {
      await vscode.env.clipboard.writeText(selector);
      vscode.window.showInformationMessage(`Copied: ${selector}`);
    }),
  );

  // ── forge inspect (storage layout) ─────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("solidity-workbench.inspectStorage", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== "solidity") {
        vscode.window.showWarningMessage("Open a Solidity file first.");
        return;
      }

      // Try to detect the contract name from the file
      const text = editor.document.getText();
      const contractMatch = text.match(/(?:abstract\s+)?contract\s+(\w+)/);
      if (!contractMatch) {
        vscode.window.showWarningMessage("Could not detect contract name in this file.");
        return;
      }

      const contractName = contractMatch[1];
      const terminal = getOrCreateTerminal();
      terminal.show();
      terminal.sendText(`${getForge()} inspect ${contractName} storage-layout`);
    }),
  );
}

// ── Helpers ────────────────────────────────────────────────────────

let workbenchTerminal: vscode.Terminal | undefined;

function getOrCreateTerminal(): vscode.Terminal {
  if (workbenchTerminal && !workbenchTerminal.exitStatus) {
    return workbenchTerminal;
  }
  workbenchTerminal = vscode.window.createTerminal({
    name: "Solidity Workbench",
    iconPath: new vscode.ThemeIcon("beaker"),
  });
  return workbenchTerminal;
}

/**
 * Find the test function name at the current cursor position.
 * Walks upward from the cursor to find the enclosing function declaration.
 */
function findTestFunctionAtCursor(editor: vscode.TextEditor): string | null {
  const document = editor.document;
  const position = editor.selection.active;

  // Walk upward to find a function declaration
  for (let line = position.line; line >= 0; line--) {
    const lineText = document.lineAt(line).text;
    const match = lineText.match(/function\s+((?:test|testFuzz|testFork|testFail)_\w+)\s*\(/);
    if (match) return match[1];

    // Stop if we hit a contract/interface boundary
    if (/^\s*(?:contract|interface|library)\s/.test(lineText)) break;
  }

  return null;
}
