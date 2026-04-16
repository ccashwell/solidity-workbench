import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import type { Diagnostic } from "vscode-languageserver/node.js";
import { DiagnosticSeverity } from "vscode-languageserver/node.js";
import { SolidityParser } from "../parser/solidity-parser.js";
import { SymbolIndex } from "../analyzer/symbol-index.js";
import { CodeActionsProvider } from "../providers/code-actions.js";
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
    provider: new CodeActionsProvider(idx, parser),
    idx,
    parser,
  };
}

describe("CodeActionsProvider", () => {
  describe("quick fixes driven by diagnostics", () => {
    it("offers an Add SPDX quick-fix when the diagnostic code is 'missing-spdx'", () => {
      const { doc, provider } = setup(
        "file:///w/A.sol",
        `pragma solidity ^0.8.0;\ncontract A {}\n`,
      );

      const diag: Diagnostic = {
        severity: DiagnosticSeverity.Warning,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
        message: "Missing SPDX license identifier.",
        source: "solidity-workbench",
        code: "missing-spdx",
      };

      const actions = provider.provideCodeActions(
        doc,
        {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
        { diagnostics: [diag] },
      );

      const add = actions.find((a) => a.title.includes("SPDX"));
      assert.ok(add, "expected an Add SPDX quick fix");
      assert.equal(add!.isPreferred, true);
      const edit = add!.edit!.changes!["file:///w/A.sol"][0];
      assert.match(edit.newText, /SPDX-License-Identifier: MIT/);
    });

    it("offers a replace-tx.origin quick-fix for tx-origin diagnostics", () => {
      const text = `pragma solidity ^0.8.0;
contract A {
    function f() external { require(tx.origin == address(0)); }
}`;
      const { doc, provider } = setup("file:///w/B.sol", text);

      const lines = text.split("\n");
      const col = lines[2].indexOf("tx.origin");
      const diag: Diagnostic = {
        severity: DiagnosticSeverity.Warning,
        range: {
          start: { line: 2, character: col },
          end: { line: 2, character: col + "tx.origin".length },
        },
        message: "Avoid using tx.origin for authorization.",
        source: "solidity-workbench",
        code: "tx-origin",
      };

      const actions = provider.provideCodeActions(doc, diag.range, { diagnostics: [diag] });
      const replace = actions.find((a) => a.title.toLowerCase().includes("msg.sender"));
      assert.ok(replace, "expected a replace-tx.origin quick fix");
      const edit = replace!.edit!.changes!["file:///w/B.sol"][0];
      assert.equal(edit.newText, "msg.sender");
    });
  });

  describe("context-aware refactorings", () => {
    it("offers Add NatSpec on an undocumented function", () => {
      const text = `pragma solidity ^0.8.0;
contract C {
    function add(uint256 a, uint256 b) public pure returns (uint256) {
        return a + b;
    }
}`;
      const { doc, provider } = setup("file:///w/C.sol", text);

      const actions = provider.provideCodeActions(
        doc,
        // Cursor on the `function add(...)` line.
        { start: { line: 2, character: 4 }, end: { line: 2, character: 4 } },
        { diagnostics: [] },
      );

      const addNatspec = actions.find((a) => a.title.toLowerCase().includes("natspec"));
      assert.ok(addNatspec, "expected an Add NatSpec refactor");

      const edit = addNatspec!.edit!.changes!["file:///w/C.sol"][0];
      assert.match(edit.newText, /@notice/);
      assert.match(edit.newText, /@param a/);
      assert.match(edit.newText, /@param b/);
      assert.match(edit.newText, /@return/);
    });

    it("does NOT re-offer Add NatSpec when the function already has NatSpec", () => {
      const text = `pragma solidity ^0.8.0;
contract D {
    /// @notice Adds two values.
    function add(uint256 a, uint256 b) public pure returns (uint256) {
        return a + b;
    }
}`;
      const { doc, provider } = setup("file:///w/D.sol", text);

      const actions = provider.provideCodeActions(
        doc,
        { start: { line: 3, character: 4 }, end: { line: 3, character: 4 } },
        { diagnostics: [] },
      );

      const addNatspec = actions.find((a) => a.title.toLowerCase().includes("natspec"));
      assert.equal(addNatspec, undefined);
    });
  });

  describe("implement-interface code action", () => {
    it("stubs missing methods when the contract extends an interface", () => {
      // Parser + index must know about IFoo so the code action can
      // consult the base interface's function list.
      const text = `pragma solidity ^0.8.0;

interface IFoo {
    function bar(uint256 x) external returns (bool);
    function baz() external view returns (address);
}

contract Foo is IFoo {
    // both methods unimplemented
}`;
      const { doc, provider } = setup("file:///w/Impl.sol", text);

      const actions = provider.provideCodeActions(
        doc,
        // Cursor inside the Foo contract body.
        { start: { line: 7, character: 9 }, end: { line: 7, character: 9 } },
        { diagnostics: [] },
      );

      const impl = actions.find((a) => a.title.startsWith("Implement IFoo"));
      assert.ok(impl, `expected an Implement IFoo action; got ${actions.map((a) => a.title)}`);

      const edit = impl!.edit!.changes!["file:///w/Impl.sol"][0];
      assert.match(edit.newText, /function bar\(uint256 x\) external override returns \(bool\)/);
      assert.match(edit.newText, /function baz\(\) external view override returns \(address\)/);
    });
  });
});
