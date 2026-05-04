import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import { keccak256 } from "js-sha3";
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
      const titleOk = refLenses.some((l) => /^\d+ references?$/.test(l.command?.title ?? ""));
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

  describe("error selector lens", () => {
    // Oracle: compute the expected selector the same way
    // `CodeLensProvider.computeSelector` does, so we don't hardcode
    // hashes that would drift if the canonical-signature logic
    // changes.
    function expectedErrorSelector(sig: string): string {
      return `0x${keccak256(sig).slice(0, 8)}`;
    }

    it("emits a `selector: 0x...` lens for a contract-level error", () => {
      const uri = "file:///w/A.sol";
      const text = `contract C {
    error NotOwner(address caller, address expectedOwner);
    function reset() external {}
}`;
      const { doc, provider } = setup(uri, text);

      const lenses = provider.provideCodeLenses(doc);
      const expected = expectedErrorSelector("NotOwner(address,address)");
      const errorLens = lenses.find((l) => l.command?.title === `selector: ${expected}`);
      assert.ok(
        errorLens,
        `expected error selector lens titled "selector: ${expected}"; got ${JSON.stringify(lenses.map((l) => l.command?.title))}`,
      );
      assert.deepEqual(errorLens!.command!.arguments, [expected]);
    });

    it("emits a selector lens for a zero-arg error", () => {
      const uri = "file:///w/B.sol";
      const text = `contract C { error Overflow(); }`;
      const { doc, provider } = setup(uri, text);
      const lenses = provider.provideCodeLenses(doc);
      const expected = expectedErrorSelector("Overflow()");
      const errorLens = lenses.find((l) => l.command?.title === `selector: ${expected}`);
      assert.ok(
        errorLens,
        `expected Overflow() selector lens at ${expected}; got ${JSON.stringify(lenses.map((l) => l.command?.title))}`,
      );
    });

    it("emits a selector lens for a file-level (global) error", () => {
      // Solidity 0.8.4+ allows top-level errors outside any contract.
      const uri = "file:///w/C.sol";
      const text = `error GlobalErr(uint256 code);
contract X {}`;
      const { doc, provider } = setup(uri, text);
      const lenses = provider.provideCodeLenses(doc);
      // bytes4(keccak256("GlobalErr(uint256)"))
      const errorLens = lenses.find(
        (l) =>
          l.command?.command === "solidity-workbench.copySelector" &&
          /^selector: 0x[0-9a-f]{8}$/.test(l.command?.title ?? "") &&
          l.range.start.line === 0,
      );
      assert.ok(errorLens, `expected a file-level error lens; got ${JSON.stringify(lenses)}`);
    });

    it("renders a distinct selector for each error in the same contract", () => {
      const uri = "file:///w/D.sol";
      const text = `contract C {
    error E1(uint256);
    error E2(address);
    error E3();
}`;
      const { doc, provider } = setup(uri, text);
      const lenses = provider.provideCodeLenses(doc);
      const selectorLenses = lenses.filter(
        (l) =>
          l.command?.command === "solidity-workbench.copySelector" &&
          l.command?.title?.startsWith("selector: "),
      );
      assert.ok(
        selectorLenses.length >= 3,
        `expected ≥3 selector lenses (one per error); got ${selectorLenses.length}: ${JSON.stringify(selectorLenses.map((l) => l.command?.title))}`,
      );
      const titles = new Set(selectorLenses.map((l) => l.command?.title));
      assert.equal(
        titles.size,
        selectorLenses.length,
        "every error should get a distinct selector",
      );
    });
  });
});
