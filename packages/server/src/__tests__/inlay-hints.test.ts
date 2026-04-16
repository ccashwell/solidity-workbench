import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import { SolidityParser } from "../parser/solidity-parser.js";
import { SymbolIndex } from "../analyzer/symbol-index.js";
import { InlayHintsProvider } from "../providers/inlay-hints.js";
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
    provider: new InlayHintsProvider(idx, parser),
  };
}

describe("InlayHintsProvider", () => {
  it("emits parameter-name hints at known-function call sites", () => {
    const text = `pragma solidity ^0.8.0;
contract A {
    function transfer(address to, uint256 amount) public returns (bool) {
        to; amount;
        return true;
    }
    function trigger() external {
        transfer(address(0x1), 100);
    }
}`;
    const { doc, provider } = setup("file:///w/A.sol", text);
    const lineCount = text.split("\n").length;
    const hints = provider.provideInlayHints(doc, {
      start: { line: 0, character: 0 },
      end: { line: lineCount, character: 0 },
    });

    // We should see two hints inside the trigger() call — one per param.
    const labels = hints.map((h) => h.label).filter((l): l is string => typeof l === "string");
    assert.ok(labels.includes("to:"), `expected "to:" hint, got ${JSON.stringify(labels)}`);
    assert.ok(labels.includes("amount:"), `expected "amount:" hint, got ${JSON.stringify(labels)}`);
  });

  it("does not emit hints when the argument matches the parameter name", () => {
    const text = `pragma solidity ^0.8.0;
contract B {
    function set(uint256 value) public { value; }
    function trigger(uint256 value) external { set(value); }
}`;
    const { doc, provider } = setup("file:///w/B.sol", text);
    const hints = provider.provideInlayHints(doc, {
      start: { line: 0, character: 0 },
      end: { line: 10, character: 0 },
    });
    // The only argument is "value" which equals the param name → no hint.
    const labels = hints.map((h) => h.label);
    assert.equal(labels.length, 0, `expected zero hints but got ${JSON.stringify(labels)}`);
  });

  it("skips call-like keywords (require/assert/revert)", () => {
    const text = `pragma solidity ^0.8.0;
contract C {
    function f(bool ok) external pure {
        require(ok, "nope");
        assert(ok);
    }
}`;
    const { doc, provider } = setup("file:///w/C.sol", text);
    const hints = provider.provideInlayHints(doc, {
      start: { line: 0, character: 0 },
      end: { line: 10, character: 0 },
    });
    // No user-defined function named `require` / `assert` is in the
    // index, and both appear in CALL_LIKE_KEYWORDS, so no hints.
    assert.equal(hints.length, 0);
  });

  it("does not throw on empty files", () => {
    const { doc, provider } = setup("file:///w/D.sol", "");
    const hints = provider.provideInlayHints(doc, {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    });
    assert.deepEqual(hints, []);
  });
});
