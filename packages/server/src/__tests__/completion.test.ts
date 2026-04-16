import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import { SolidityParser } from "../parser/solidity-parser.js";
import { SymbolIndex } from "../analyzer/symbol-index.js";
import { CompletionProvider } from "../providers/completion.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";

function makeFakeWorkspace() {
  return {
    getAllFileUris: () => [],
    uriToPath: (uri: string) => URI.parse(uri).fsPath,
    getRemappings: () => [
      { prefix: "forge-std/", path: "/project/lib/forge-std/src/" },
      { prefix: "@oz/", path: "/project/lib/openzeppelin-contracts/contracts/" },
    ],
  } as unknown as WorkspaceManager;
}

function setup(uri: string, text: string) {
  const parser = new SolidityParser();
  const idx = new SymbolIndex(parser, makeFakeWorkspace());
  parser.parse(uri, text);
  idx.updateFile(uri);
  return {
    doc: TextDocument.create(uri, "solidity", 1, text),
    provider: new CompletionProvider(idx, makeFakeWorkspace()),
  };
}

function labels(items: { label: string }[]): Set<string> {
  return new Set(items.map((i) => i.label));
}

describe("CompletionProvider", () => {
  describe("keyword + type completions (default context)", () => {
    it("includes common Solidity keywords and value types", () => {
      const text = `pragma solidity ^0.8.0;
contract A { function f() external { \n    } }`;
      const { doc, provider } = setup("file:///w/A.sol", text);

      // Cursor on the empty body line (line 2).
      const items = provider.provideCompletions(doc, { line: 2, character: 4 });
      const ls = labels(items);

      // Keywords
      for (const kw of ["if", "else", "for", "while", "require", "emit"]) {
        assert.ok(ls.has(kw), `expected keyword '${kw}' in completions`);
      }

      // Types
      for (const ty of ["uint256", "address", "bool", "bytes32"]) {
        assert.ok(ls.has(ty), `expected type '${ty}' in completions`);
      }
    });

    it("includes user-defined symbols from the current file", () => {
      const text = `pragma solidity ^0.8.0;
contract Widget {
    uint256 public size;
    function resize() external {}
}
contract Gadget {
    function use() external {
        \n    }
}`;
      const { doc, provider } = setup("file:///w/Widget.sol", text);
      const items = provider.provideCompletions(doc, { line: 7, character: 4 });
      const ls = labels(items);

      // User-defined contracts appear as type completions.
      assert.ok(ls.has("Widget"));
      assert.ok(ls.has("Gadget"));
    });

    it("includes the Foundry test snippets", () => {
      const { doc, provider } = setup(
        "file:///w/X.t.sol",
        `pragma solidity ^0.8.0;
contract XTest { \n }`,
      );
      const items = provider.provideCompletions(doc, { line: 1, character: 16 });
      const ls = labels(items);
      assert.ok(ls.has("test"), "expected `test` snippet");
      assert.ok(ls.has("testFuzz"), "expected `testFuzz` snippet");
      assert.ok(ls.has("setUp"), "expected `setUp` snippet");
    });
  });

  describe("NatSpec context", () => {
    it("offers NatSpec tags inside a /// line", () => {
      const text = `pragma solidity ^0.8.0;
/// \ncontract A {}`;
      const { doc, provider } = setup("file:///w/B.sol", text);
      // Cursor after the "/// " on line 1.
      const items = provider.provideCompletions(doc, { line: 1, character: 4 });
      const ls = labels(items);
      assert.ok(ls.has("@notice"));
      assert.ok(ls.has("@param"));
      assert.ok(ls.has("@return"));
      assert.ok(ls.has("@dev"));
    });
  });

  describe("import path context", () => {
    it("suggests remappings prefixes when the cursor is inside an import string", () => {
      const text = `import "";\ncontract A {}`;
      const { doc, provider } = setup("file:///w/C.sol", text);
      const items = provider.provideCompletions(doc, { line: 0, character: 8 });
      const ls = labels(items);
      assert.ok(ls.has("forge-std/"), "expected forge-std/ remapping");
      assert.ok(ls.has("@oz/"), "expected @oz/ remapping");
    });
  });

  describe("member access context", () => {
    it("returns msg members for `msg.`", () => {
      const text = `contract A { function f() external view { \n msg. } }`;
      const { doc, provider } = setup("file:///w/D.sol", text);
      // Cursor immediately after `msg.` on line 1 (col 5).
      const items = provider.provideCompletions(doc, { line: 1, character: 5 });
      const ls = labels(items);
      assert.ok(ls.has("sender"));
      assert.ok(ls.has("value"));
      assert.ok(ls.has("data"));
      assert.ok(ls.has("sig"));
    });

    it("returns abi members for `abi.`", () => {
      const text = `contract A { function f() external { \n abi. } }`;
      const { doc, provider } = setup("file:///w/E.sol", text);
      const items = provider.provideCompletions(doc, { line: 1, character: 5 });
      const ls = labels(items);
      assert.ok(ls.has("encode"));
      assert.ok(ls.has("decode"));
      assert.ok(ls.has("encodeWithSelector"));
      assert.ok(ls.has("encodeCall"));
    });

    it("returns a contract's public members for a static `Contract.` lookup", () => {
      // The file is syntactically valid; the user is simply asking for
      // completions immediately after the dot in `Bank.deposit`. The
      // provider reads the *textBefore* slice, so what comes after the
      // cursor is irrelevant — we only need `Bank.` (with a valid
      // surrounding expression) on the line the cursor sits on.
      const text = `pragma solidity ^0.8.0;
contract Bank {
    uint256 public deposit;
    function withdraw() external {}
    function _internal() private {}
}
contract User {
    function f() external view returns (uint256) {
        return Bank.deposit;
    }
}`;
      const { doc, provider } = setup("file:///w/F.sol", text);
      // `        return Bank.deposit;` — "Bank." starts at col 15, dot
      // at col 19; cursor at col 20 is immediately after the dot.
      const items = provider.provideCompletions(doc, { line: 8, character: 20 });
      const ls = labels(items);
      assert.ok(ls.has("deposit"), "public state var should appear");
      assert.ok(ls.has("withdraw"), "external function should appear");
      assert.ok(!ls.has("_internal"), "private function should NOT appear");
    });
  });
});
