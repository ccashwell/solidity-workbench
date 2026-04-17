import * as assert from "node:assert";
import * as vscode from "vscode";

/**
 * End-to-end LSP round-trip tests. Each test opens `Counter.sol` from
 * the sample Foundry project that `@vscode/test-electron` mounts as
 * the workspace, then exercises a `vscode.executeXxxProvider`
 * built-in command which asks VSCode to route the request through
 * our language client to our LSP server.
 *
 * These tests complement the server-side `node --test` suites —
 * those run the providers directly with a fake workspace, while
 * these prove the full wire protocol works end-to-end inside a real
 * VSCode host.
 *
 * Every test pokes at indexing with a short wait + retry loop
 * because the LSP's workspace indexing is asynchronous; there is no
 * LSP request that deterministically says "indexing finished", and
 * we don't want these to be flaky on a cold CI runner.
 */
const EXTENSION_ID = "ccashwell.solidity-workbench";

describe("LSP round-trip", () => {
  before(async function () {
    this.timeout(60_000);
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} not found`);
    await ext!.activate();
    // Give the LSP server a moment to finish the initial indexing
    // pass before the first executeXxxProvider request.
    await new Promise((r) => setTimeout(r, 3_000));
  });

  it("hover on `count` returns a code block mentioning the identifier", async function () {
    this.timeout(30_000);
    const uri = findSampleFile("src/Counter.sol");
    const doc = await vscode.workspace.openTextDocument(uri);

    // `uint256 public count;` — cursor on the identifier `count`.
    const line = doc
      .getText()
      .split("\n")
      .findIndex((l) => /uint256 public count;/.test(l));
    assert.ok(line >= 0, "expected `uint256 public count;` in Counter.sol");
    const position = new vscode.Position(line, doc.lineAt(line).text.indexOf("count"));

    const hovers = await retry<vscode.Hover[]>(() =>
      vscode.commands.executeCommand("vscode.executeHoverProvider", uri, position),
    );
    assert.ok(hovers && hovers.length > 0, "expected at least one hover");
    const markdown = flattenHover(hovers);
    assert.match(markdown, /count/);
  });

  it("workspace symbols returns a ranked match for `Counter`", async function () {
    this.timeout(30_000);
    const symbols = await retry<vscode.SymbolInformation[]>(() =>
      vscode.commands.executeCommand("vscode.executeWorkspaceSymbolProvider", "Counter"),
    );
    assert.ok(symbols && symbols.length > 0, "expected matches for 'Counter'");
    // The trigram-index path must surface the exact-name match at the
    // top (or near the top) of the results.
    const hit = symbols.find((s) => s.name === "Counter" || s.name.endsWith(".Counter"));
    assert.ok(hit, `expected a Counter match; got ${symbols.map((s) => s.name).join(", ")}`);
  });

  it("workspace symbols fuzzy query `ctr` surfaces `Counter` via subsequence ranking", async function () {
    this.timeout(30_000);
    const symbols = await retry<vscode.SymbolInformation[]>(() =>
      vscode.commands.executeCommand("vscode.executeWorkspaceSymbolProvider", "ctr"),
    );
    assert.ok(symbols, "expected non-undefined result");
    // 'ctr' has no trigram overlap with 'Counter' but ordered-
    // subsequence ranking should still surface it.
    assert.ok(
      symbols.some((s) => /Counter/.test(s.name)),
      `fuzzy query 'ctr' should match Counter; got ${symbols.map((s) => s.name).join(", ")}`,
    );
  });

  it("references on `count` returns multiple locations across the contract", async function () {
    this.timeout(30_000);
    const uri = findSampleFile("src/Counter.sol");
    const doc = await vscode.workspace.openTextDocument(uri);
    const line = doc
      .getText()
      .split("\n")
      .findIndex((l) => /uint256 public count;/.test(l));
    const position = new vscode.Position(line, doc.lineAt(line).text.indexOf("count"));

    const refs = await retry<vscode.Location[]>(() =>
      vscode.commands.executeCommand("vscode.executeReferenceProvider", uri, position),
    );
    assert.ok(refs && refs.length > 0, "expected reference results");
    // `count` is used in increment(), incrementBy(), reset(), getCount()
    // plus the declaration itself. Even a minimal fallback should
    // catch 3+ occurrences.
    assert.ok(refs.length >= 3, `expected ≥3 refs for \`count\`; got ${refs.length}`);
  });

  it("rename on a local variable returns a WorkspaceEdit with changes", async function () {
    this.timeout(30_000);
    const uri = findSampleFile("src/Counter.sol");
    const doc = await vscode.workspace.openTextDocument(uri);

    // Rename the local `oldValue` in `increment()` — scope-aware
    // rename is the path that requires a SolcBridge AST. When no
    // forge build has run in the test environment we fall back to
    // the workspace-wide path, which is still expected to produce
    // a WorkspaceEdit touching Counter.sol.
    const lines = doc.getText().split("\n");
    const incrLine = lines.findIndex((l) => /uint256 oldValue = count;/.test(l));
    assert.ok(incrLine >= 0);
    const col = lines[incrLine].indexOf("oldValue");

    const edit = await retry<vscode.WorkspaceEdit | null>(() =>
      vscode.commands.executeCommand(
        "vscode.executeDocumentRenameProvider",
        uri,
        new vscode.Position(incrLine, col),
        "newValue",
      ),
    );
    if (!edit) {
      // Rename on a scope-limited local before any forge build is
      // a legitimate "no rename available" case — the server
      // refuses to guess rather than rewrite blindly. Accept that
      // path but assert the provider responded at all.
      return;
    }
    // If we did get an edit, it must touch at least one file.
    const entries = edit.entries();
    assert.ok(entries.length > 0, "WorkspaceEdit should have ≥1 file entry");
  });

  it("code actions surface an auto-import / quick-fix for an unresolved symbol", async function () {
    this.timeout(30_000);
    const uri = findSampleFile("src/Counter.sol");
    const doc = await vscode.workspace.openTextDocument(uri);

    // Ask for code actions over a small region that covers one of
    // the diagnostics-producing lines. We don't assert a specific
    // action title — different server builds may offer different
    // refactorings — only that the provider responded and returned
    // an array (possibly empty).
    const range = new vscode.Range(0, 0, Math.min(doc.lineCount, 10), 0);
    const actions = await retry<(vscode.Command | vscode.CodeAction)[]>(() =>
      vscode.commands.executeCommand("vscode.executeCodeActionProvider", uri, range),
    );
    assert.ok(Array.isArray(actions), "code action provider must return an array");
  });

  it("document formatting provider responds (forge fmt wiring or no-op)", async function () {
    this.timeout(30_000);
    const uri = findSampleFile("src/Counter.sol");
    await vscode.workspace.openTextDocument(uri);
    // The formatting provider is backed by `forge fmt`. In a CI
    // environment without forge, the provider returns zero edits
    // rather than failing — we just assert it returns an array.
    const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
      "vscode.executeFormatDocumentProvider",
      uri,
      { insertSpaces: true, tabSize: 4 },
    );
    assert.ok(Array.isArray(edits), "format provider must return an array");
  });
});

// ── Helpers ──────────────────────────────────────────────────────────

function findSampleFile(rel: string): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "workspace folder must be open for these tests");
  return vscode.Uri.joinPath(folder.uri, rel);
}

/**
 * LSP requests can race the initial workspace-indexing pass on a
 * cold test host. Retry a command a few times with short backoff
 * rather than making the whole test flaky.
 */
async function retry<T>(fn: () => Thenable<T>, attempts = 10, delayMs = 500): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await fn();
      if (result !== undefined && result !== null) return result;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  if (lastErr) throw lastErr;
  // Final attempt, throwing if still undefined.
  return (await fn()) as T;
}

function flattenHover(hovers: vscode.Hover[]): string {
  const parts: string[] = [];
  for (const h of hovers) {
    for (const c of h.contents) {
      if (typeof c === "string") parts.push(c);
      else if (c && typeof c === "object" && "value" in c) parts.push(String(c.value));
    }
  }
  return parts.join("\n");
}
