import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import { FoldingRangeKind } from "vscode-languageserver/node.js";
import { SolidityParser } from "../parser/solidity-parser.js";
import { SymbolIndex } from "../analyzer/symbol-index.js";
import { FoldingRangesProvider } from "../providers/folding-ranges.js";
import { SelectionRangesProvider } from "../providers/selection-ranges.js";
import { DocumentLinksProvider } from "../providers/document-links.js";
import { ImplementationProvider } from "../providers/implementation.js";
import { TypeHierarchyProvider } from "../providers/type-hierarchy.js";
import { SemanticResolver } from "../analyzer/semantic-resolver.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";

function makeFakeWorkspace(
  resolve: (importPath: string, fromFile: string) => string | null = () => null,
  uris: string[] = [],
) {
  return {
    getAllFileUris: () => uris.slice(),
    uriToPath: (uri: string) => URI.parse(uri).fsPath,
    resolveImport: (importPath: string, fromFile: string) => resolve(importPath, fromFile),
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

interface TestLocation {
  range: { start: { line: number } };
}

function asTestLocation(value: unknown): TestLocation {
  return value as TestLocation;
}

function setupFiles(files: Record<string, string>) {
  const parser = new SolidityParser();
  const filePaths = new Set(Object.keys(files).map((name) => path.join("/w", name)));
  const uris = Object.keys(files).map((name) => URI.file(path.join("/w", name)).toString());
  const workspace = makeFakeWorkspace((importPath, fromFile) => {
    const target = path.resolve(path.dirname(fromFile), importPath);
    return filePaths.has(target) ? target : null;
  }, uris);
  const idx = new SymbolIndex(parser, workspace);
  const docs: Record<string, TextDocument> = {};

  for (const [name, text] of Object.entries(files)) {
    const uri = URI.file(path.join("/w", name)).toString();
    parser.parse(uri, text);
    idx.updateFile(uri);
    docs[name] = TextDocument.create(uri, "solidity", 1, text);
  }

  const resolver = new SemanticResolver(parser, workspace, idx);
  return { docs, parser, idx, resolver, workspace };
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

  it("returns folding ranges for file-level declarations", () => {
    const text = `pragma solidity ^0.8.24;

struct FileState {
    uint256 total;
}

event FileClaimed(
    address indexed account,
    uint256 amount
);

function fileHelper(
    uint256 amount
) pure returns (uint256) {
    return amount + 1;
}

contract C {}`;
    const { doc, parser } = setup(text, "file:///w/FileLevel.sol");
    const ranges = new FoldingRangesProvider(parser).provideFoldingRanges(doc);

    assert.ok(
      ranges.some((r) => r.startLine === 2 && r.endLine === 4),
      "expected file-level struct fold",
    );
    assert.ok(
      ranges.some((r) => r.startLine === 6 && r.endLine === 9),
      "expected file-level event fold",
    );
    assert.ok(
      ranges.some((r) => r.startLine === 11 && r.endLine === 15),
      "expected file-level function fold",
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

  it("turns braced NatSpec symbol references into document links", () => {
    const files = {
      "src/Types.sol": `pragma solidity ^0.8.24;
contract PoolVault {}
`,
      "src/InventoryLib.sol": `pragma solidity ^0.8.24;
import "./Types.sol";

/// @notice Accounting helper for {PoolVault}; claims are redeemed via {redeemClaims}.
/// Unknown refs like {doesNotExist} stay plain text.
library InventoryLib {
    function redeemClaims() internal {}
}
`,
    };
    const { docs, parser, idx, resolver, workspace } = setupFiles(files);
    const doc = docs["src/InventoryLib.sol"];

    const links = new DocumentLinksProvider(parser, workspace, idx, resolver).provideDocumentLinks(
      doc,
    );
    const poolVault = links.find((link) => link.tooltip === "Open PoolVault");
    const redeemClaims = links.find((link) => link.tooltip === "Open InventoryLib.redeemClaims");

    assert.ok(poolVault, "expected PoolVault NatSpec document link");
    assert.equal(poolVault.target, "file:///w/src/Types.sol#L2,10");
    assert.equal(poolVault.range.start.line, 3);
    assert.equal(
      poolVault.range.start.character,
      files["src/InventoryLib.sol"].split("\n")[3].indexOf("{PoolVault}"),
    );

    assert.ok(redeemClaims, "expected redeemClaims NatSpec document link");
    assert.equal(redeemClaims.target, "file:///w/src/InventoryLib.sol#L7,14");
    assert.equal(redeemClaims.range.start.line, 3);
    assert.equal(
      redeemClaims.range.start.character,
      files["src/InventoryLib.sol"].split("\n")[3].indexOf("{redeemClaims}"),
    );
    assert.equal(
      links.some((link) => link.tooltip?.includes("doesNotExist")),
      false,
      "unknown braced NatSpec text should not become a link",
    );
  });

  it("turns braced references in block NatSpec into document links", () => {
    const text = `pragma solidity ^0.8.24;

/**
 * @notice See {redeemClaims}.
 */
library InventoryLib {
    function redeemClaims() internal {}
}
`;
    const { doc, parser, idx, workspace } = setup(text, "file:///w/InventoryLib.sol");

    const links = new DocumentLinksProvider(parser, workspace, idx).provideDocumentLinks(doc);

    assert.equal(links.length, 1);
    assert.equal(links[0].target, "file:///w/InventoryLib.sol#L7,14");
    assert.equal(links[0].range.start.line, 3);
    assert.equal(links[0].range.start.character, text.split("\n")[3].indexOf("{redeemClaims}"));
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

  it("builds selection ranges for file-level events", () => {
    const text = `pragma solidity ^0.8.24;

event FileClaimed(
    address indexed account,
    uint256 amount
);

contract C {}`;
    const { doc, parser } = setup(text, "file:///w/FileEvent.sol");
    const line = text.split("\n")[2];
    const col = line.indexOf("FileClaimed");
    const ranges = new SelectionRangesProvider(parser).provideSelectionRanges(doc, [
      { line: 2, character: col + 1 },
    ]);

    assert.deepEqual(ranges[0].range, {
      start: { line: 2, character: col },
      end: { line: 2, character: col + "FileClaimed".length },
    });
    assert.deepEqual(ranges[0].parent?.parent?.range, {
      start: { line: 2, character: 0 },
      end: { line: 5, character: 1 },
    });
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
    assert.equal(asTestLocation(locs[0]).range.start.line, 5);
  });

  it("finds implementations through imported interface aliases", () => {
    const files = {
      "src/I.sol": `pragma solidity ^0.8.24;
interface IFoo {
    function ping(uint256 x) external returns (bool);
}`,
      "src/Impl.sol": `pragma solidity ^0.8.24;
import { IFoo as RenamedIFoo } from "./I.sol";
contract Foo is RenamedIFoo {
    function ping(uint256 x) external override returns (bool) {
        return x > 0;
    }
}`,
      "test/I.sol": `pragma solidity ^0.8.24;
interface IFoo {
    function ping(uint256 x) external returns (bool);
}`,
      "src/Consumer.sol": `pragma solidity ^0.8.24;
import { IFoo as AliasFoo } from "./I.sol";
contract Consumer {
    AliasFoo foo;
}`,
    };
    const { docs, idx, resolver } = setupFiles(files);
    const doc = docs["src/Consumer.sol"];
    const line = files["src/Consumer.sol"].split("\n")[3];
    const col = line.indexOf("AliasFoo");
    const impl = new ImplementationProvider(idx, resolver).provideImplementation(doc, {
      line: 3,
      character: col,
    });

    assert.ok(impl, "expected implementation locations");
    const locs = Array.isArray(impl) ? impl : [impl];
    assert.equal(locs.length, 1);
    assert.equal(locs[0].uri, URI.file("/w/src/Impl.sol").toString());
    assert.equal(locs[0].range.start.line, 2);
  });

  it("prepares type hierarchy items through imported base aliases", () => {
    const files = {
      "src/Base.sol": `pragma solidity ^0.8.24;
contract Base {}`,
      "src/Child.sol": `pragma solidity ^0.8.24;
import { Base as RenamedBase } from "./Base.sol";
contract Child is RenamedBase {}`,
      "test/Base.sol": `pragma solidity ^0.8.24;
contract Base {}`,
    };
    const { docs, parser, idx, resolver } = setupFiles(files);
    const provider = new TypeHierarchyProvider(idx, parser, resolver);
    const doc = docs["src/Child.sol"];
    const line = files["src/Child.sol"].split("\n")[2];
    const col = line.indexOf("RenamedBase");

    const prepared = provider.prepareTypeHierarchy(doc, { line: 2, character: col });
    assert.equal(prepared.length, 1);
    assert.equal(prepared[0].name, "Base");
    assert.equal(prepared[0].uri, URI.file("/w/src/Base.sol").toString());

    const subtypes = provider.getSubtypes(prepared[0]);
    assert.deepEqual(
      subtypes.map((item) => `${item.uri}#${item.name}`),
      [`${URI.file("/w/src/Child.sol").toString()}#Child`],
    );
  });

  it("does not prepare type hierarchy for unimported test-only symbols in source files", () => {
    const files = {
      "src/Current.sol": `pragma solidity ^0.8.24;
contract Current {
    function f() external pure { Ghost; }
}`,
      "test/Ghost.sol": `pragma solidity ^0.8.24;
contract Ghost {}`,
    };
    const { docs, parser, idx, resolver } = setupFiles(files);
    const provider = new TypeHierarchyProvider(idx, parser, resolver);
    const doc = docs["src/Current.sol"];
    const line = files["src/Current.sol"].split("\n")[2];
    const col = line.indexOf("Ghost");

    const prepared = provider.prepareTypeHierarchy(doc, { line: 2, character: col });
    assert.deepEqual(prepared, []);
  });
});
