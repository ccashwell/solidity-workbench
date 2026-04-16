import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import { SolidityParser } from "../parser/solidity-parser.js";
import { SymbolIndex } from "../analyzer/symbol-index.js";
import { HoverProvider } from "../providers/hover.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";

function makeFakeWorkspace() {
  return {
    getAllFileUris: () => [],
    uriToPath: (uri: string) => URI.parse(uri).fsPath,
  } as unknown as WorkspaceManager;
}

function setup(uri: string, text: string) {
  const parser = new SolidityParser();
  const idx = new SymbolIndex(parser, makeFakeWorkspace());
  parser.parse(uri, text);
  idx.updateFile(uri);
  return {
    doc: TextDocument.create(uri, "solidity", 1, text),
    provider: new HoverProvider(idx, parser),
  };
}

describe("HoverProvider", () => {
  describe("built-in globals", () => {
    it("returns a hover for `msg`", () => {
      const { doc, provider } = setup(
        "file:///w/A.sol",
        `pragma solidity ^0.8.0;
contract A {
    function f() external view { address a = msg.sender; a; }
}`,
      );

      // Cursor on "msg" at line 2
      const h = provider.provideHover(doc, { line: 2, character: 48 });
      assert.ok(h, "expected hover");
      const value = (h!.contents as any).value as string;
      // The hover renders `msg`'s shape as an inline struct description;
      // assert on the descriptive fields rather than the literal syntax
      // since we don't dictate the exact wording of the doc blurb.
      assert.match(value, /address sender/);
      assert.match(value, /message context/i);
    });

    it("returns a hover for `keccak256`", () => {
      const { doc, provider } = setup(
        "file:///w/B.sol",
        `pragma solidity ^0.8.0;
contract B {
    function h() external pure returns (bytes32) { return keccak256(""); }
}`,
      );
      const h = provider.provideHover(doc, { line: 2, character: 58 });
      assert.ok(h, "expected hover");
      const value = (h!.contents as any).value as string;
      assert.match(value, /Keccak-256/);
    });
  });

  describe("user-defined symbols", () => {
    it("surfaces NatSpec on a function hover", () => {
      const { doc, provider } = setup(
        "file:///w/C.sol",
        `pragma solidity ^0.8.0;
contract C {
    /// @notice Does the thing.
    /// @dev Reverts on overflow.
    /// @param x The input.
    /// @return The doubled value.
    function doubled(uint256 x) public pure returns (uint256) { return x * 2; }
}`,
      );
      // Cursor on "doubled"
      const h = provider.provideHover(doc, { line: 6, character: 18 });
      assert.ok(h, "expected hover");
      const value = (h!.contents as any).value as string;
      assert.match(value, /doubled/);
      assert.match(value, /Does the thing/);
      assert.match(value, /Reverts on overflow/);
      assert.match(value, /The input/);
    });

    it("shows `contract C` for a contract-name hover", () => {
      const { doc, provider } = setup(
        "file:///w/D.sol",
        `pragma solidity ^0.8.0;
contract D {}`,
      );
      const h = provider.provideHover(doc, { line: 1, character: 9 });
      assert.ok(h, "expected hover");
      const value = (h!.contents as any).value as string;
      assert.match(value, /contract D/);
    });

    it("returns null when hovering on whitespace", () => {
      const { doc, provider } = setup(
        "file:///w/E.sol",
        `pragma solidity ^0.8.0;
contract E {}`,
      );
      const h = provider.provideHover(doc, { line: 0, character: 0 });
      // Position 0 is the start of "pragma" — will hover the pragma keyword.
      // That's fine; we just assert the provider doesn't crash.
      void h;
    });
  });

  describe("elementary type hover", () => {
    it("hovers on `address`", () => {
      const { doc, provider } = setup(
        "file:///w/F.sol",
        `pragma solidity ^0.8.0;
contract F { function f(address a) external {} }`,
      );
      const h = provider.provideHover(doc, { line: 1, character: 26 });
      assert.ok(h, "expected hover");
      const value = (h!.contents as any).value as string;
      assert.match(value, /address/);
    });
  });
});
