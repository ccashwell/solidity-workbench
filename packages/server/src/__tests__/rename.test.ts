import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import type { TextDocuments } from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";

import { SolidityParser } from "../parser/solidity-parser.js";
import { SymbolIndex } from "../analyzer/symbol-index.js";
import { RenameProvider } from "../providers/rename.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";

interface TestFile {
  path: string;
  text: string;
}

interface TestHarness {
  provider: RenameProvider;
  docForPath: (p: string) => TextDocument;
  uriFor: (p: string) => string;
}

/**
 * Minimal WorkspaceManager stand-in. The rename provider only pulls
 * three members off of it: getAllFileUris, uriToPath, and libDirs.
 */
function makeFakeWorkspace(files: TestFile[], libDirs: string[]): WorkspaceManager {
  const uris = files.map((f) => URI.file(f.path).toString());
  return {
    getAllFileUris: () => uris,
    uriToPath: (uri: string) => URI.parse(uri).fsPath,
    libDirs,
  } as unknown as WorkspaceManager;
}

/**
 * Minimal TextDocuments stand-in. The rename provider only calls
 * `all()` and, elsewhere, `get()`. Returning a static array is enough.
 */
function makeFakeDocuments(docs: TextDocument[]): TextDocuments<TextDocument> {
  return {
    all: () => docs,
    get: (uri: string) => docs.find((d) => d.uri === uri),
    keys: () => docs.map((d) => d.uri),
  } as unknown as TextDocuments<TextDocument>;
}

function setupHarness(files: TestFile[], libDirs: string[] = []): TestHarness {
  const parser = new SolidityParser();
  const workspace = makeFakeWorkspace(files, libDirs);
  const symbolIndex = new SymbolIndex(parser, workspace);

  const docs: TextDocument[] = [];
  for (const file of files) {
    const uri = URI.file(file.path).toString();
    parser.parse(uri, file.text);
    symbolIndex.updateFile(uri);
    docs.push(TextDocument.create(uri, "solidity", 1, file.text));
  }

  const fakeDocs = makeFakeDocuments(docs);
  const provider = new RenameProvider(symbolIndex, workspace, fakeDocs);

  const byPath = new Map<string, TextDocument>(docs.map((d, i) => [files[i].path, d]));
  return {
    provider,
    docForPath: (p) => {
      const d = byPath.get(p);
      if (!d) throw new Error(`No doc for path ${p}`);
      return d;
    },
    uriFor: (p) => URI.file(p).toString(),
  };
}

// Virtual paths — we don't actually touch the filesystem. `URI.file` +
// `URI.parse(...).fsPath` round-trip these cleanly on POSIX, and the
// rename provider's fs reads are either skipped (via the libDir filter
// or the "already processed" guard) or fall into the try/catch on ENOENT.
const VIRTUAL_ROOT = path.join(path.sep, "virtual", "solidity-workbench");
const SRC_DIR = path.join(VIRTUAL_ROOT, "src");
const LIB_DIR = path.join(VIRTUAL_ROOT, "lib");

describe("RenameProvider", () => {
  describe("prepareRename", () => {
    it("returns range and placeholder for a known contract name", () => {
      const file: TestFile = {
        path: path.join(SRC_DIR, "Counter.sol"),
        text: "contract Counter {\n    uint256 x;\n}\n",
      };
      const h = setupHarness([file]);
      const doc = h.docForPath(file.path);

      // `Counter` spans line 0 characters 9..16; the cursor sits on the 'n'.
      const result = h.provider.prepareRename(doc, { line: 0, character: 12 });
      assert.ok(result, "expected a prepareRename result for a known contract");
      assert.equal(result.placeholder, "Counter");
      assert.equal(result.range.start.line, 0);
      assert.equal(result.range.start.character, 9);
      assert.equal(result.range.end.line, 0);
      assert.equal(result.range.end.character, 16);
    });

    it("rejects an identifier that is not in the global symbol index", () => {
      const file: TestFile = {
        path: path.join(SRC_DIR, "Counter.sol"),
        text:
          "contract Counter {\n" +
          "    function doStuff(uint256 localParam) external {\n" +
          "        uint256 localVar = 1;\n" +
          "    }\n" +
          "}\n",
      };
      const h = setupHarness([file]);
      const doc = h.docForPath(file.path);

      // `localParam` is a parameter — not indexed at the workspace level.
      // Without a SolcBridge wired in, the RenameProvider can't rescope
      // it, so it should reject with a clear actionable message.
      assert.throws(
        () => h.provider.prepareRename(doc, { line: 1, character: 32 }),
        (err: Error) => {
          assert.ok(err instanceof Error, "expected an Error instance");
          assert.match(err.message, /not in the workspace symbol index|no type-resolved AST/i);
          return true;
        },
      );
    });

    it("returns null for a Solidity keyword", () => {
      const file: TestFile = {
        path: path.join(SRC_DIR, "Counter.sol"),
        text: "contract Counter {\n    uint256 public count;\n}\n",
      };
      const h = setupHarness([file]);
      const doc = h.docForPath(file.path);

      // `uint256` spans line 1 characters 4..11; the cursor sits inside it.
      const result = h.provider.prepareRename(doc, { line: 1, character: 6 });
      assert.equal(result, null);
    });

    it("rejects names that resolve to multiple symbol kinds", () => {
      // `Foo` appears as both a contract (in Foo.sol) and a function (in
      // Other.sol). The text-level rename would be ambiguous, so we refuse.
      const fileA: TestFile = {
        path: path.join(SRC_DIR, "Foo.sol"),
        text: "contract Foo {\n    uint256 x;\n}\n",
      };
      const fileB: TestFile = {
        path: path.join(SRC_DIR, "Other.sol"),
        text: "contract Bar {\n    function Foo() external {}\n}\n",
      };
      const h = setupHarness([fileA, fileB]);
      const docA = h.docForPath(fileA.path);

      assert.throws(
        () => h.provider.prepareRename(docA, { line: 0, character: 11 }),
        (err: Error) => {
          assert.match(err.message, /multiple symbol kinds/);
          assert.match(err.message, /contract/);
          assert.match(err.message, /function/);
          return true;
        },
      );
    });
  });

  describe("provideRename", () => {
    it("produces a WorkspaceEdit covering the declaration of a contract", async () => {
      const file: TestFile = {
        path: path.join(SRC_DIR, "Counter.sol"),
        text: "contract Counter {\n    uint256 x;\n}\n",
      };
      const h = setupHarness([file]);
      const doc = h.docForPath(file.path);

      const result = await h.provider.provideRename(doc, { line: 0, character: 12 }, "Renamed");
      assert.ok(result, "expected a WorkspaceEdit");
      assert.ok(result.changes, "expected result.changes");

      const uri = h.uriFor(file.path);
      const edits = result.changes[uri];
      assert.ok(edits && edits.length >= 1, "expected at least one edit for the file");

      const declEdit = edits.find((e) => e.range.start.line === 0 && e.range.start.character === 9);
      assert.ok(declEdit, "expected an edit spanning the declaration site (line 0, col 9)");
      assert.equal(declEdit.range.end.character, 16);
      assert.equal(declEdit.newText, "Renamed");
    });

    it("skips files whose paths fall inside libDirs", async () => {
      const srcFile: TestFile = {
        path: path.join(SRC_DIR, "Main.sol"),
        text: "contract Main {\n    uint256 x;\n}\n",
      };
      const libFile: TestFile = {
        path: path.join(LIB_DIR, "dep", "Main.sol"),
        text: "contract Main {\n    uint256 y;\n}\n",
      };
      const h = setupHarness([srcFile, libFile], [LIB_DIR]);
      const doc = h.docForPath(srcFile.path);

      const result = await h.provider.provideRename(doc, { line: 0, character: 10 }, "Renamed");
      assert.ok(result);
      assert.ok(result.changes);

      const srcUri = h.uriFor(srcFile.path);
      const libUri = h.uriFor(libFile.path);

      assert.ok(result.changes[srcUri], "expected src/ file to receive edits");
      assert.equal(result.changes[libUri], undefined, "expected lib/ file to be skipped entirely");
      assert.deepEqual(
        Object.keys(result.changes),
        [srcUri],
        "expected exactly one edited file (src only)",
      );
    });

    it("uses semantic SolcBridge references instead of rewriting every same-named function", async () => {
      const file: TestFile = {
        path: path.join(SRC_DIR, "Overloads.sol"),
        text:
          "contract A {\n" +
          "    function ping() external {}\n" +
          "    function call() external { ping(); }\n" +
          "}\n" +
          "contract B {\n" +
          "    function ping(uint256 x) external {}\n" +
          "}\n",
      };
      const h = setupHarness([file]);
      const doc = h.docForPath(file.path);
      const text = doc.getText();
      const declOffset = text.indexOf("function ping()") + "function ".length;
      const callOffset = text.indexOf("ping();");
      h.provider.setSolcBridge({
        findReferencesAt: () => ({
          declaration: {
            filePath: file.path,
            offset: text.indexOf("function ping()"),
            length: "function ping() external {}".length,
          },
          references: [{ filePath: file.path, offset: callOffset, length: "ping".length }],
        }),
      } as any);

      const result = await h.provider.provideRename(doc, doc.positionAt(declOffset), "pong");

      assert.ok(result?.changes);
      const edits = result.changes[h.uriFor(file.path)] ?? [];
      assert.equal(edits.length, 2, `expected declaration + one call edit, got ${edits.length}`);
      assert.ok(edits.some((e) => e.range.start.line === 1 && e.newText === "pong"));
      assert.ok(edits.some((e) => e.range.start.line === 2 && e.newText === "pong"));
      assert.ok(
        !edits.some((e) => e.range.start.line === 5),
        "semantic rename must not rewrite B.ping(uint256)",
      );
    });
  });
});
