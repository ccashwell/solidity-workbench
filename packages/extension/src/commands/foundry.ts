import * as vscode from "vscode";

/**
 * Registers Foundry-related commands in the extension.
 *
 * Commands:
 * - solforge.build: Run `forge build`
 * - solforge.test: Run `forge test`
 * - solforge.testFile: Run tests in the current file
 * - solforge.testFunction: Run the test at cursor
 * - solforge.format: Run `forge fmt`
 * - solforge.gasSnapshot: Run `forge snapshot`
 * - solforge.flatten: Flatten the current contract
 * - solforge.inspectStorage: Inspect storage layout
 */
export function registerFoundryCommands(context: vscode.ExtensionContext): void {
  const config = () => vscode.workspace.getConfiguration("solforge");

  function getForge(): string {
    return config().get<string>("foundryPath") || "forge";
  }

  // ── forge build ─────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("solforge.build", async () => {
      const terminal = getOrCreateTerminal();
      terminal.show();
      terminal.sendText(`${getForge()} build`);
    }),
  );

  // ── forge test ──────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("solforge.test", async () => {
      const terminal = getOrCreateTerminal();
      terminal.show();
      const verbosity = config().get<number>("test.verbosity") ?? 2;
      terminal.sendText(`${getForge()} test ${"-".repeat(verbosity)}v`);
    }),
  );

  // ── forge test (current file) ──────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("solforge.testFile", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== "solidity") {
        vscode.window.showWarningMessage("Open a Solidity test file first.");
        return;
      }

      const filePath = editor.document.fileName;
      const terminal = getOrCreateTerminal();
      terminal.show();
      const verbosity = config().get<number>("test.verbosity") ?? 2;
      terminal.sendText(`${getForge()} test --match-path ${filePath} ${"-".repeat(verbosity)}v`);
    }),
  );

  // ── forge test (function at cursor) ────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("solforge.testFunction", async () => {
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
      terminal.sendText(`${getForge()} test --match-test ${testName} ${"-".repeat(verbosity)}v`);
    }),
  );

  // ── forge fmt ───────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("solforge.format", async () => {
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
    vscode.commands.registerCommand("solforge.gasSnapshot", async () => {
      const terminal = getOrCreateTerminal();
      terminal.show();
      terminal.sendText(`${getForge()} snapshot`);
    }),
  );

  // ── forge flatten ───────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("solforge.flatten", async () => {
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

  // ── forge inspect (storage layout) ─────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("solforge.inspectStorage", async () => {
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

let solforgeTerminal: vscode.Terminal | undefined;

function getOrCreateTerminal(): vscode.Terminal {
  if (solforgeTerminal && !solforgeTerminal.exitStatus) {
    return solforgeTerminal;
  }
  solforgeTerminal = vscode.window.createTerminal({
    name: "Solforge",
    iconPath: new vscode.ThemeIcon("beaker"),
  });
  return solforgeTerminal;
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
