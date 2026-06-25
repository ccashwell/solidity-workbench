import * as vscode from "vscode";

export function shouldFormatSolidityOnSave(
  document: Pick<vscode.TextDocument, "languageId">,
  config: Pick<vscode.WorkspaceConfiguration, "get">,
): boolean {
  return document.languageId === "solidity" && config.get<boolean>("formatOnSave") !== false;
}

export function registerFormatOnSave(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.onWillSaveTextDocument((event) => {
      const config = vscode.workspace.getConfiguration("solidity-workbench");
      if (!shouldFormatSolidityOnSave(event.document, config)) return;

      event.waitUntil(formatDocument(event.document));
    }),
  );
}

async function formatDocument(document: vscode.TextDocument): Promise<vscode.TextEdit[]> {
  try {
    const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
      "vscode.executeFormatDocumentProvider",
      document.uri,
      { tabSize: 4, insertSpaces: true },
    );
    return Array.isArray(edits) ? edits : [];
  } catch {
    return [];
  }
}
