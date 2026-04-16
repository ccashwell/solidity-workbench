import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import { SolidityParser } from "../parser/solidity-parser.js";
import { SymbolIndex } from "../analyzer/symbol-index.js";
import { SignatureHelpProvider } from "../providers/signature-help.js";
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
    provider: new SignatureHelpProvider(idx, parser),
  };
}

describe("SignatureHelpProvider", () => {
  describe("built-in functions", () => {
    it("returns a signature for `require(` open paren", () => {
      const text = `pragma solidity ^0.8.0;
contract A {
    function f() external pure { require( }
}`;
      const { doc, provider } = setup("file:///w/A.sol", text);
      // Position cursor right after the `(` in require(
      // line 2, col ... find position of "(" after require
      const line = text.split("\n")[2];
      const openParen = line.indexOf("require(") + "require(".length;
      const sig = provider.provideSignatureHelp(doc, { line: 2, character: openParen });
      assert.ok(sig, "expected signature help");
      assert.equal(sig!.signatures.length, 1);
      assert.match(sig!.signatures[0].label, /require/);
      assert.equal(sig!.activeParameter, 0);
    });

    it("advances activeParameter on each comma", () => {
      const text = `pragma solidity ^0.8.0;
contract B {
    function f(bytes32 h) external pure { ecrecover(h, 27, h, }
}`;
      const { doc, provider } = setup("file:///w/B.sol", text);
      const line = text.split("\n")[2];
      // Cursor right after the third comma in ecrecover
      const afterThirdComma = line.indexOf("h, }");
      const sig = provider.provideSignatureHelp(doc, { line: 2, character: afterThirdComma + 2 });
      assert.ok(sig);
      assert.match(sig!.signatures[0].label, /ecrecover/);
      // ecrecover(hash, v, r, s) — after 3 commas we should be on param 3
      assert.equal(sig!.activeParameter, 3);
    });
  });

  describe("user-defined functions", () => {
    it("returns the user function signature with types", () => {
      // Uses a COMPLETE source (closed parens) so the parser's tolerant
      // mode registers the `transfer` declaration even while the cursor
      // sits between `(` and `)` conceptually. We place the cursor
      // one char past the open paren on the call line.
      const text = `pragma solidity ^0.8.0;
contract C {
    function transfer(address to, uint256 amount) public returns (bool) {
        to; amount;
        return true;
    }
    function trigger() external {
        transfer(address(0), 100);
    }
}`;
      const { doc, provider } = setup("file:///w/C.sol", text);
      const lines = text.split("\n");
      const callLine = lines.findIndex(
        (l, i) => i > 2 /* skip the declaration */ && l.includes("transfer("),
      );
      assert.ok(callLine > 2, "expected a post-declaration call line");
      const col = lines[callLine].indexOf("transfer(") + "transfer(".length;

      const sig = provider.provideSignatureHelp(doc, { line: callLine, character: col });
      assert.ok(sig, "expected signature help");
      assert.ok(sig!.signatures.length >= 1);
      const label = sig!.signatures[0].label;
      assert.match(label, /transfer\(/);
      assert.match(label, /address to/);
      assert.match(label, /uint256 amount/);
    });
  });

  describe("robustness", () => {
    it("returns null when the cursor isn't inside any call", () => {
      const text = `pragma solidity ^0.8.0;
contract D { function f() external {} }`;
      const { doc, provider } = setup("file:///w/D.sol", text);
      const sig = provider.provideSignatureHelp(doc, { line: 1, character: 0 });
      assert.equal(sig, null);
    });
  });
});
