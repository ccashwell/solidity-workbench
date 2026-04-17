import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import { SolidityParser } from "../parser/solidity-parser.js";
import { SymbolIndex } from "../analyzer/symbol-index.js";
import { CodeLensProvider } from "../providers/code-lens.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";

function makeFakeWorkspace() {
  return {
    getAllFileUris: () => [],
    uriToPath: (uri: string) => URI.parse(uri).fsPath,
    root: "/w",
  } as unknown as WorkspaceManager;
}

function setup(uri: string, text: string) {
  const parser = new SolidityParser();
  const idx = new SymbolIndex(parser, makeFakeWorkspace());
  parser.parse(uri, text);
  idx.updateFile(uri);
  return {
    doc: TextDocument.create(uri, "solidity", 1, text),
    provider: new CodeLensProvider(idx, parser, makeFakeWorkspace()),
  };
}

describe("CodeLensProvider", () => {
  describe("reference-count lens", () => {
    it("emits findReferencesAt with [uri, position] — not the raw VSCode command", () => {
      // Regression for: clicking the "N references" lens raised
      // "unexpected type" because the lens had been wired directly to
      // VSCode's `editor.action.findReferences`, which requires a
      // `vscode.Uri` instance; our server-side code emitted only a
      // `Position`. The fix routes through the client-side shim
      // `solidity-workbench.findReferencesAt(uri, position)`.
      const uri = "file:///w/A.sol";
      const text = `contract A { function f() external pure {} }
contract B { function g() external pure { A.f(); A.f(); } }`;
      const { doc, provider } = setup(uri, text);

      const lenses = provider.provideCodeLenses(doc);
      const refLens = lenses.find(
        (l) => l.command?.command === "solidity-workbench.findReferencesAt",
      );
      assert.ok(refLens, `expected a findReferencesAt lens; got ${JSON.stringify(lenses)}`);

      const args = refLens!.command!.arguments;
      assert.ok(Array.isArray(args) && args.length === 2, "expected [uri, position] arguments");
      assert.equal(typeof args[0], "string", "first argument must be the document uri");
      assert.equal(args[0], uri);
      assert.equal(typeof args[1], "object");
      assert.equal(typeof (args[1] as { line: number }).line, "number");
      assert.equal(typeof (args[1] as { character: number }).character, "number");

      // And critically — the lens must NOT be pointing at VSCode's
      // editor command directly. That was the source of the bug.
      for (const l of lenses) {
        assert.notEqual(
          l.command?.command,
          "editor.action.findReferences",
          "references lens must route through the client-side shim, not the raw editor command",
        );
      }
    });

    it("includes the reference count in the lens title", () => {
      const uri = "file:///w/B.sol";
      const text = `contract Foo {}
contract User1 { Foo public a; }
contract User2 { Foo public b; }`;
      const { doc, provider } = setup(uri, text);

      const lenses = provider.provideCodeLenses(doc);
      const refLenses = lenses.filter(
        (l) => l.command?.command === "solidity-workbench.findReferencesAt",
      );
      assert.ok(refLenses.length >= 1, "expected at least one reference lens");
      // Title is either `N references` or `1 reference`.
      const titleOk = refLenses.some(
        (l) => /^\d+ references?$/.test(l.command?.title ?? ""),
      );
      assert.ok(titleOk, `expected a "N references" title; got ${JSON.stringify(refLenses)}`);
    });

    it("omits the references lens when there are no usages", () => {
      const uri = "file:///w/C.sol";
      const text = `contract Orphan { function never() external pure {} }`;
      const { doc, provider } = setup(uri, text);

      const lenses = provider.provideCodeLenses(doc);
      const refLens = lenses.find(
        (l) => l.command?.command === "solidity-workbench.findReferencesAt",
      );
      assert.equal(
        refLens,
        undefined,
        `orphan symbols should not produce a references lens; got ${JSON.stringify(refLens)}`,
      );
    });
  });
});
