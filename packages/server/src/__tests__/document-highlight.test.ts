import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { TextDocument } from "vscode-languageserver-textdocument";
import { DocumentHighlightKind } from "vscode-languageserver/node.js";
import { URI } from "vscode-uri";
import { SolidityParser } from "../parser/solidity-parser.js";
import { SymbolIndex } from "../analyzer/symbol-index.js";
import { DocumentHighlightProvider } from "../providers/document-highlight.js";
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
    provider: new DocumentHighlightProvider(idx, parser),
  };
}

describe("DocumentHighlightProvider", () => {
  it("returns highlights for every occurrence of the word-at-cursor", () => {
    const text = `contract C {
    uint256 public count;
    function bump() external {
        count = count + 1;
    }
}`;
    const { doc, provider } = setup("file:///C.sol", text);
    // Cursor on `count` in the declaration on line 1.
    const col = text.split("\n")[1].indexOf("count");
    const hits = provider.provideDocumentHighlights(doc, { line: 1, character: col });
    assert.ok(hits.length >= 3, `expected ≥3 highlights for count; got ${hits.length}`);
  });

  it("never highlights identifiers that happen to appear inside `///` natspec comments", () => {
    // The regression this provider exists to solve: the built-in
    // VSCode fallback highlights every word occurrence including ones
    // in comments. Our reference index is comment-aware, so we should
    // never return a highlight on a natspec line.
    const text = `contract C {
    /// @notice Thrown when a non-owner tries to reset
    error NotOwner(address caller);

    function reset() external {
        emit Reset();
    }

    event Reset();
}`;
    const { doc, provider } = setup("file:///C.sol", text);
    const lines = text.split("\n");
    // Cursor on `reset` in the function declaration on line 4.
    const fnLine = lines.findIndex((l) => /function reset\(\)/.test(l));
    const col = lines[fnLine].indexOf("reset");
    const hits = provider.provideDocumentHighlights(doc, { line: fnLine, character: col });

    // Assert no highlight lands on the natspec line (line 1 — which
    // contains the word `reset` inside `/// @notice …`).
    const natspecLine = lines.findIndex((l) => /\/\/\/ @notice/.test(l));
    for (const h of hits) {
      assert.notEqual(
        h.range.start.line,
        natspecLine,
        `highlight leaked into natspec comment at line ${natspecLine}: ${JSON.stringify(h)}`,
      );
    }
  });

  it("never highlights identifiers that happen to appear inside `//` line comments", () => {
    const text = `contract C {
    uint256 public count;
    function f() external {
        // reset count before doing anything
        count = 0;
    }
}`;
    const { doc, provider } = setup("file:///C.sol", text);
    const lines = text.split("\n");
    const col = lines[1].indexOf("count");
    const hits = provider.provideDocumentHighlights(doc, { line: 1, character: col });
    const commentLine = lines.findIndex((l) => /^\s*\/\/ reset/.test(l));
    for (const h of hits) {
      assert.notEqual(
        h.range.start.line,
        commentLine,
        `highlight leaked into // comment at line ${commentLine}`,
      );
    }
  });

  it("never highlights identifiers that appear inside string literals", () => {
    const text = `contract C {
    function f() external pure returns (string memory) {
        return "reset complete";
    }
    function reset() external {}
}`;
    const { doc, provider } = setup("file:///C.sol", text);
    const lines = text.split("\n");
    const fnLine = lines.findIndex((l) => /function reset\(\)/.test(l));
    const col = lines[fnLine].indexOf("reset");
    const hits = provider.provideDocumentHighlights(doc, { line: fnLine, character: col });

    const stringLine = lines.findIndex((l) => /"reset complete"/.test(l));
    for (const h of hits) {
      assert.notEqual(
        h.range.start.line,
        stringLine,
        `highlight leaked into string literal at line ${stringLine}`,
      );
    }
  });

  it("returns every highlight as DocumentHighlightKind.Read", () => {
    // We don't attempt to distinguish Write (declaration / assignment)
    // from Read because the mapped AST's nameRange heuristic isn't
    // accurate enough to claim Write reliably. Uniform Read matches
    // the visual style of VSCode's legacy fallback.
    const text = `contract C {
    uint256 public count;
    function bump() external { count = count + 1; }
}`;
    const { doc, provider } = setup("file:///C.sol", text);
    const col = text.split("\n")[1].indexOf("count");
    const hits = provider.provideDocumentHighlights(doc, { line: 1, character: col });

    assert.ok(hits.length > 0);
    for (const h of hits) {
      assert.equal(h.kind, DocumentHighlightKind.Read, "all highlights should be Read");
    }
  });

  it("returns [] when the cursor is on whitespace or punctuation", () => {
    const text = `contract C { uint256 public count; }`;
    const { doc, provider } = setup("file:///C.sol", text);
    // Column 0 is the 'c' of 'contract'; shift to whitespace after }.
    const hits = provider.provideDocumentHighlights(doc, {
      line: 0,
      character: text.length,
    });
    assert.deepEqual(hits, []);
  });

  it("only returns highlights within the current file", () => {
    const parser = new SolidityParser();
    const idx = new SymbolIndex(parser, makeFakeWorkspace());
    const aUri = "file:///A.sol";
    const bUri = "file:///B.sol";
    parser.parse(aUri, `contract A { function ping() external pure {} }`);
    idx.updateFile(aUri);
    parser.parse(bUri, `contract B { function ping() external pure {} }`);
    idx.updateFile(bUri);

    const docA = TextDocument.create(
      aUri,
      "solidity",
      1,
      `contract A { function ping() external pure {} }`,
    );
    const provider = new DocumentHighlightProvider(idx, parser);
    const col = docA.getText().indexOf("ping");
    const hits = provider.provideDocumentHighlights(docA, { line: 0, character: col });
    // A and B both define ping; the highlight list must not include
    // occurrences from B.sol.
    assert.ok(hits.length >= 1);
    // DocumentHighlight doesn't carry a URI — it's implicitly the
    // document the request was against. We assert all lines are
    // within docA's line count as a proxy.
    for (const h of hits) {
      assert.ok(h.range.start.line < docA.lineCount);
    }
  });

  it("prefers SolcBridge semantic references when available", () => {
    const text = `contract C {
    uint256 public count;
    function f() external {
        count = count + 1;
    }
    function g() external {
        uint256 count = 0;
        count;
    }
}`;
    const { doc, provider } = setup("file:///C.sol", text);
    const firstUse = text.indexOf("count = count + 1");
    provider.setSolcBridge({
      findReferencesAt: () => ({
        declaration: null,
        references: [{ filePath: "/C.sol", offset: firstUse, length: "count".length }],
      }),
    } as any);

    const hits = provider.provideDocumentHighlights(doc, {
      line: 1,
      character: text.split("\n")[1].indexOf("count"),
    });

    assert.equal(hits.length, 1);
    assert.equal(hits[0].range.start.line, 3);
  });
});
