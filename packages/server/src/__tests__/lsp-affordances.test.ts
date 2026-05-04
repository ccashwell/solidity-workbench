import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import { FoldingRangeKind } from "vscode-languageserver/node.js";
import { SolidityParser } from "../parser/solidity-parser.js";
import { SymbolIndex } from "../analyzer/symbol-index.js";
import { FoldingRangesProvider } from "../providers/folding-ranges.js";
import { SelectionRangesProvider } from "../providers/selection-ranges.js";
import { DocumentLinksProvider } from "../providers/document-links.js";
import { ImplementationProvider } from "../providers/implementation.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";

function makeFakeWorkspace(resolve: (importPath: string) => string | null = () => null) {
  return {
    getAllFileUris: () => [],
    uriToPath: (uri: string) => URI.parse(uri).fsPath,
    resolveImport: (importPath: string) => resolve(importPath),
  } as unknown as WorkspaceManager;
}

function setup(text: string, uri = "file:///w/A.sol", workspace = makeFakeWorkspace()) {
  const parser = new SolidityParser();
  const idx = new SymbolIndex(parser, workspace);
  parser.parse(uri, text);
  idx.updateFile(uri);
  return {
    doc: TextDocument.create(uri, "solidity", 1, text),
    parser,
    idx,
    workspace,
  };
}

describe("additional LSP affordance providers", () => {
  it("returns declaration, import, and comment folding ranges", () => {
    const text = `pragma solidity ^0.8.0;
import "./A.sol";
import "./B.sol";

/* long
   comment */
contract C {
    function f() external {
    }
}`;
    const { doc, parser } = setup(text);
    const ranges = new FoldingRangesProvider(parser).provideFoldingRanges(doc);

    assert.ok(
      ranges.some((r) => r.kind === FoldingRangeKind.Imports),
      "expected import fold",
    );
    assert.ok(
      ranges.some((r) => r.kind === FoldingRangeKind.Comment),
      "expected comment fold",
    );
    assert.ok(
      ranges.some((r) => r.startLine === 6 && r.endLine === 9),
      "expected contract fold",
    );
    assert.ok(
      ranges.some((r) => r.startLine === 7 && r.endLine === 8),
      "expected function fold",
    );
  });

  it("turns import strings into document links", () => {
    const text = `pragma solidity ^0.8.0;
import { Token } from "./Token.sol";
contract C {}`;
    const workspace = makeFakeWorkspace((p) => (p === "./Token.sol" ? "/w/Token.sol" : null));
    const { doc, parser } = setup(text, "file:///w/C.sol", workspace);

    const links = new DocumentLinksProvider(parser, workspace).provideDocumentLinks(doc);
    assert.equal(links.length, 1);
    assert.equal(links[0].target, "file:///w/Token.sol");
    assert.equal(links[0].range.start.line, 1);
    assert.equal(links[0].range.start.character, text.split("\n")[1].indexOf("./Token.sol"));
  });

  it("builds selection ranges from word to declaration to document", () => {
    const text = `pragma solidity ^0.8.0;
contract C {
    function frob(uint256 x) external {
        x;
    }
}`;
    const { doc, parser } = setup(text);
    const line = text.split("\n")[2];
    const col = line.indexOf("frob");
    const ranges = new SelectionRangesProvider(parser).provideSelectionRanges(doc, [
      { line: 2, character: col },
    ]);

    assert.equal(ranges.length, 1);
    assert.deepEqual(ranges[0].range, {
      start: { line: 2, character: col },
      end: { line: 2, character: col + "frob".length },
    });
    assert.ok(ranges[0].parent, "expected parent line/declaration ranges");
    assert.ok(ranges[0].parent?.parent, "expected nested parent ranges");
  });

  it("finds concrete implementations for interface methods", () => {
    const text = `pragma solidity ^0.8.0;
interface IFoo {
    function ping(uint256 x) external returns (bool);
}
contract Foo is IFoo {
    function ping(uint256 x) external override returns (bool) {
        return x > 0;
    }
}`;
    const { doc, idx } = setup(text);
    const line = text.split("\n")[2];
    const col = line.indexOf("ping");
    const impl = new ImplementationProvider(idx).provideImplementation(doc, {
      line: 2,
      character: col,
    });

    assert.ok(impl, "expected implementation locations");
    const locs = Array.isArray(impl) ? impl : [impl];
    assert.equal(locs.length, 1);
    assert.equal((locs[0] as any).range.start.line, 5);
  });
});
