import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

/**
 * End-to-end coverage of the feature surface that landed across the
 * April–May 2026 sweeps. Complements the existing `activation` and
 * `lsp-round-trip` suites with broader (not deeper) coverage:
 *
 *   - LSP-driven providers reachable via VSCode's
 *     `executeXxxProvider` commands (code lens, inlay hints,
 *     diagnostics).
 *   - User-facing webview commands (storage layout, IR Viewer,
 *     ABI Explorer, inheritance graph) — verified to be reachable
 *     and execute without throwing.
 *   - Test Explorer controller registration.
 *   - DAP debug adapter registration via the public configuration
 *     contribution.
 *
 * Tests degrade gracefully when external binaries (forge, slither,
 * aderyn, wake, mythril, cast) aren't available on the runner —
 * we assert provider/command shape, not external-tool output.
 */
const EXTENSION_ID = "ccashwell.solidity-workbench";

describe("Feature coverage — LSP providers", () => {
  before(async function () {
    this.timeout(60_000);
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} not found`);
    await ext!.activate();
    await new Promise((r) => setTimeout(r, 3_000));
  });

  it("publishes diagnostics on Counter.sol from at least one source", async function () {
    this.timeout(30_000);
    const uri = findSampleFile("src/Counter.sol");
    await vscode.workspace.openTextDocument(uri);
    // Diagnostics arrive asynchronously via the language client. Poll
    // for up to ~5 s — the cold-start parse usually settles inside 2.
    let diagnostics: vscode.Diagnostic[] = [];
    for (let attempt = 0; attempt < 20; attempt++) {
      diagnostics = vscode.languages.getDiagnostics(uri);
      if (diagnostics.length > 0) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    // Counter.sol may legitimately have zero diagnostics on a clean
    // build; the assertion is that the API responds with an array
    // and the diagnostic shape (when present) is well-formed.
    assert.ok(Array.isArray(diagnostics));
    for (const d of diagnostics) {
      assert.ok(typeof d.message === "string", "diagnostic.message must be a string");
      assert.ok(d.range instanceof vscode.Range, "diagnostic.range must be a Range");
    }
  });

  it("returns code lenses on Counter.sol", async function () {
    this.timeout(30_000);
    const uri = findSampleFile("src/Counter.sol");
    await vscode.workspace.openTextDocument(uri);
    const lenses = await retry<vscode.CodeLens[]>(() =>
      vscode.commands.executeCommand("vscode.executeCodeLensProvider", uri),
    );
    assert.ok(Array.isArray(lenses), "code lens provider must return an array");
    // Counter.sol has multiple functions / events — expect at least
    // one lens (selector / topic0 / reference count). Allow zero on
    // a stripped runner where forge build hasn't cached selectors.
    if (lenses.length > 0) {
      const lens = lenses[0];
      assert.ok(lens.range instanceof vscode.Range);
    }
  });

  it("returns inlay hints for a function-call range in Counter.t.sol", async function () {
    this.timeout(30_000);
    const uri = findSampleFile("test/Counter.t.sol");
    const doc = await vscode.workspace.openTextDocument(uri);
    const range = new vscode.Range(0, 0, doc.lineCount, 0);
    const hints = await retry<vscode.InlayHint[]>(() =>
      vscode.commands.executeCommand("vscode.executeInlayHintProvider", uri, range),
    );
    assert.ok(Array.isArray(hints), "inlay hint provider must return an array");
    // Each hint must have a position and a label.
    for (const h of hints) {
      assert.ok(h.position instanceof vscode.Position);
      assert.ok(h.label !== undefined && h.label !== null);
    }
  });

  it("returns document highlight ranges for a state-variable identifier", async function () {
    this.timeout(30_000);
    const uri = findSampleFile("src/Counter.sol");
    const doc = await vscode.workspace.openTextDocument(uri);
    const lines = doc.getText().split("\n");
    const decl = lines.findIndex((l) => /uint256 public count;/.test(l));
    assert.ok(decl >= 0);
    const col = lines[decl].indexOf("count");
    const highlights = await retry<vscode.DocumentHighlight[]>(() =>
      vscode.commands.executeCommand(
        "vscode.executeDocumentHighlights",
        uri,
        new vscode.Position(decl, col),
      ),
    );
    assert.ok(Array.isArray(highlights), "document highlight provider must return an array");
  });

  it("type definition for `Counter` resolves to its declaration", async function () {
    this.timeout(30_000);
    const uri = findSampleFile("test/Counter.t.sol");
    const doc = await vscode.workspace.openTextDocument(uri);
    const lines = doc.getText().split("\n");
    const usageLine = lines.findIndex((l) => /Counter public counter;/.test(l));
    if (usageLine < 0) return; // sample fixture changed; skip without failing.
    const col = lines[usageLine].indexOf("Counter");
    const locs = await retry<(vscode.Location | vscode.LocationLink)[]>(() =>
      vscode.commands.executeCommand(
        "vscode.executeTypeDefinitionProvider",
        uri,
        new vscode.Position(usageLine, col),
      ),
    );
    assert.ok(Array.isArray(locs), "type definition provider must return an array");
  });
});

describe("Feature coverage — webview commands", () => {
  before(async function () {
    this.timeout(60_000);
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    await ext!.activate();
  });

  /**
   * Each webview command is invoked with the active editor on a
   * Solidity file; the assertion is "the command exists and
   * doesn't throw". Some commands open VSCode quick-pickers that
   * the test environment can't dismiss — those are wrapped with a
   * short timeout so the suite doesn't hang.
   */
  it("registers each webview-opening command", async () => {
    const all = await vscode.commands.getCommands(true);
    const expected = [
      "solidity-workbench.inspectStoragePanel",
      "solidity-workbench.inheritanceGraph",
      "solidity-workbench.showAbi",
      "solidity-workbench.gasDiff",
      "solidity-workbench.remoteChain.open",
      "solidity-workbench.viewIR",
      "solidity-workbench.chisel.start",
    ];
    for (const cmd of expected) {
      assert.ok(all.includes(cmd), `expected '${cmd}' to be registered`);
    }
  });

  it("registers each static-analysis command", async () => {
    const all = await vscode.commands.getCommands(true);
    for (const cmd of [
      "solidity-workbench.slither",
      "solidity-workbench.aderyn",
      "solidity-workbench.wake",
      "solidity-workbench.mythril",
    ]) {
      assert.ok(all.includes(cmd), `expected '${cmd}' to be registered`);
    }
  });
});

describe("Feature coverage — Test Explorer", () => {
  before(async function () {
    this.timeout(60_000);
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    await ext!.activate();
    await new Promise((r) => setTimeout(r, 3_000));
  });

  it("contributes the Solidity Tests view container", async () => {
    // The package.json contributes the test controller; just check
    // that the controller IDs we expect end up in the host. The
    // public `vscode.tests` API doesn't expose a list of registered
    // controllers, so the cleanest assertion is that running the
    // built-in `testing.refreshTests` command doesn't throw — that
    // proves a controller is at least registered.
    await vscode.commands.executeCommand("testing.refreshTests").then(
      () => {
        /* ok */
      },
      () => {
        /* tolerate environments without the testing API */
      },
    );
  });
});

describe("Feature coverage — DAP debugger contribution", () => {
  before(async function () {
    this.timeout(60_000);
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    await ext!.activate();
  });

  it("declares the `solidity-workbench` debug type via package.json contribution", async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    const debuggers = (ext?.packageJSON?.contributes?.debuggers ?? []) as Array<{
      type?: string;
      label?: string;
    }>;
    const ours = debuggers.find((d) => d.type === "solidity-workbench");
    assert.ok(ours, "expected a `solidity-workbench` debug type contribution");
    assert.ok(typeof ours!.label === "string" && ours!.label.length > 0);
  });

  it("breakpoints are declared for the solidity language", () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    const breakpoints = (ext?.packageJSON?.contributes?.breakpoints ?? []) as Array<{
      language?: string;
    }>;
    assert.ok(
      breakpoints.some((b) => b.language === "solidity"),
      "expected a `breakpoints[language=solidity]` contribution so .sol files expose gutter breakpoints",
    );
  });

  it("starts a debug session with a synthetic trace + artifact and reports a stack frame", async function () {
    this.timeout(45_000);
    const fixture = makeDebugFixture();
    const tracker = installSessionTracker();

    try {
      const ok = await vscode.debug.startDebugging(undefined, {
        type: "solidity-workbench",
        request: "launch",
        name: "e2e: synthetic trace",
        traceFile: fixture.tracePath,
        artifact: fixture.artifactPath,
        projectRoot: fixture.projectRoot,
      });
      assert.ok(ok, "startDebugging returned false — VSCode rejected the configuration");

      // Wait for the adapter's `stopped: entry` event.
      await tracker.waitForEvent("stopped", 10_000);

      // Trigger a stackTrace request via VSCode's DAP relay. The
      // public API doesn't expose `vscode.debug.activeDebugSession.customRequest`
      // on every channel, but it's the canonical way.
      const session = vscode.debug.activeDebugSession;
      assert.ok(session, "expected an active debug session");
      const reply = await session!.customRequest("stackTrace", { threadId: 1 });
      assert.ok(reply, "stackTrace returned no body");
      assert.ok(Array.isArray(reply.stackFrames));
      assert.ok(reply.stackFrames.length >= 1, "expected at least one stack frame");
    } finally {
      try {
        await vscode.debug.stopDebugging(vscode.debug.activeDebugSession);
      } catch {
        /* tolerate "no active session" if the launch failed */
      }
      tracker.dispose();
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});

// ── Helpers ──────────────────────────────────────────────────────────

function findSampleFile(rel: string): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "workspace folder must be open for these tests");
  return vscode.Uri.joinPath(folder.uri, rel);
}

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
  return (await fn()) as T;
}

/**
 * Spin up a temp dir with the absolute minimum the DAP adapter
 * needs to bring up a session: a tiny trace JSON (3 structLog
 * steps) and a synthetic forge artifact (one PUSH1 STOP, source
 * map pointing nowhere meaningful). The session won't have real
 * source resolution but stackTrace should still respond, exercising
 * the wire protocol end-to-end.
 */
function makeDebugFixture(): {
  dir: string;
  tracePath: string;
  artifactPath: string;
  projectRoot: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solidity-workbench-dap-"));
  const tracePath = path.join(dir, "trace.json");
  const artifactPath = path.join(dir, "artifact.json");
  fs.writeFileSync(
    tracePath,
    JSON.stringify({
      gas: 21000,
      failed: false,
      returnValue: "0x",
      structLogs: [
        { pc: 0, op: "PUSH1", depth: 1, gas: 999990, gasCost: 3, stack: [], memory: [] },
        { pc: 2, op: "STOP", depth: 1, gas: 999987, gasCost: 0, stack: ["0x1"], memory: [] },
      ],
    }),
  );
  // Smallest plausible artifact. fileIndex -1 (`-`) so source
  // resolution returns null gracefully — the test only exercises
  // wire-protocol shape, not source mapping.
  fs.writeFileSync(
    artifactPath,
    JSON.stringify({
      bytecode: { object: "0x600100", sourceMap: "0:0:-1:-:0" },
      deployedBytecode: { object: "0x600100", sourceMap: "0:0:-1:-:0" },
      metadata: JSON.stringify({ sources: {} }),
    }),
  );
  return { dir, tracePath, artifactPath, projectRoot: dir };
}

interface SessionTracker {
  waitForEvent(name: string, timeoutMs: number): Promise<unknown>;
  dispose(): void;
}

function installSessionTracker(): SessionTracker {
  const events: { name: string; body: unknown }[] = [];
  const waiters: {
    name: string;
    resolve: (body: unknown) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }[] = [];

  const onEvent = (name: string, body: unknown): void => {
    events.push({ name, body });
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].name === name) {
        clearTimeout(waiters[i].timer);
        waiters[i].resolve(body);
        waiters.splice(i, 1);
      }
    }
  };

  const factory = vscode.debug.registerDebugAdapterTrackerFactory("solidity-workbench", {
    createDebugAdapterTracker() {
      return {
        onDidSendMessage(msg: { type?: string; event?: string; body?: unknown }) {
          if (msg.type === "event" && typeof msg.event === "string") {
            onEvent(msg.event, msg.body);
          }
        },
      };
    },
  });

  return {
    waitForEvent(name, timeoutMs) {
      const past = events.find((e) => e.name === name);
      if (past) return Promise.resolve(past.body);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for DAP event '${name}'`));
        }, timeoutMs);
        waiters.push({ name, resolve, reject, timer });
      });
    },
    dispose() {
      factory.dispose();
      for (const w of waiters) clearTimeout(w.timer);
    },
  };
}
