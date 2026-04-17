import * as assert from "node:assert";
import * as vscode from "vscode";

/**
 * Smoke-level extension activation tests.
 *
 * We rely on `@vscode/test-electron` having opened the sample Foundry
 * project (`test/fixtures/sample-project/`) as the workspace — the
 * `workspaceContains:**\/foundry.toml` activation event should fire on
 * extension load. We then assert:
 *
 *   1. The extension is present and reports active.
 *   2. Our key commands are registered.
 *   3. The Solidity language is registered so `.sol` files open with
 *      the right `languageId`.
 *
 * These tests are intentionally shallow — the deeper behaviours (LSP
 * requests returning locations, code lenses appearing, etc.) live in
 * separate suites that can spin up once the initial smoke tests are
 * green in CI.
 */
// Publisher is declared in packages/extension/package.json — keep this
// constant in sync with that publisher + name pair.
const EXTENSION_ID = "ccashwell.solidity-workbench";

describe("Extension activation", () => {
  it("is present", () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `expected extension ${EXTENSION_ID} to be registered`);
  });

  it("activates", async function () {
    this.timeout(30_000);
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    await ext!.activate();
    assert.ok(ext!.isActive, "extension should be active after activate()");
  });

  it("registers its key commands", async function () {
    this.timeout(15_000);
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    if (ext && !ext.isActive) await ext.activate();

    const all = await vscode.commands.getCommands(true);
    const expected = [
      "solidity-workbench.build",
      "solidity-workbench.test",
      "solidity-workbench.format",
      "solidity-workbench.coverage",
      "solidity-workbench.gasSnapshot",
      "solidity-workbench.gasClearHistory",
      "solidity-workbench.anvil.start",
      "solidity-workbench.anvil.stop",
      "solidity-workbench.chisel.start",
      "solidity-workbench.restartServer",
      "solidity-workbench.inspectStoragePanel",
      "solidity-workbench.deploy.create",
      "solidity-workbench.script.simulate",
      "solidity-workbench.slither",
      "solidity-workbench.aderyn",
      "solidity-workbench.indexer.scaffold",
      "solidity-workbench.subgraph.scaffold",
      // Client-side shim invoked by code lenses.
      "solidity-workbench.findReferencesAt",
    ];
    for (const cmd of expected) {
      assert.ok(all.includes(cmd), `expected command '${cmd}' to be registered`);
    }
  });

  it("registers the Solidity language", async () => {
    const langs = await vscode.languages.getLanguages();
    assert.ok(langs.includes("solidity"), "solidity language must be registered");
  });
});

describe("LSP document features on the sample project", () => {
  before(async function () {
    this.timeout(60_000);
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    await ext!.activate();
    // Give the LSP server time to finish indexing the sample project.
    await new Promise((r) => setTimeout(r, 3_000));
  });

  it("opens Counter.sol with languageId 'solidity'", async () => {
    const uri = findSampleFile("src/Counter.sol");
    const doc = await vscode.workspace.openTextDocument(uri);
    assert.equal(doc.languageId, "solidity");
    assert.ok(doc.getText().includes("contract Counter"));
  });

  it("returns document symbols including the Counter contract", async function () {
    this.timeout(30_000);
    const uri = findSampleFile("src/Counter.sol");
    await vscode.workspace.openTextDocument(uri);

    // Retry a few times — the LSP may still be indexing when we first ask.
    let symbols: vscode.DocumentSymbol[] | vscode.SymbolInformation[] | undefined;
    for (let attempt = 0; attempt < 10; attempt++) {
      symbols = await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", uri);
      if (symbols && symbols.length > 0) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    assert.ok(symbols && symbols.length > 0, "expected at least one document symbol");
    const counter = (symbols as vscode.DocumentSymbol[]).find((s) => s.name === "Counter");
    assert.ok(counter, "expected a 'Counter' symbol");
  });
});

function findSampleFile(rel: string): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "workspace folder must be open for these tests");
  return vscode.Uri.joinPath(folder.uri, rel);
}
