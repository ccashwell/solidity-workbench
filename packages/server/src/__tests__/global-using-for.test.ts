import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import { SolidityParser } from "../parser/solidity-parser.js";
import { SymbolIndex } from "../analyzer/symbol-index.js";
import { HoverProvider } from "../providers/hover.js";
import { DefinitionProvider } from "../providers/definition.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";

const OWNER_FIXTURE = `pragma solidity 0.8.26;

struct Owner {
    address _inner;
}

struct Store {
    Owner owner;
}

using {read, write, onlyOwner} for Owner global;

error NotOwner(address caller);

function read(Owner storage self) view returns (address) {
    return self._inner;
}

/// @notice Sets the owner.
function write(Owner storage self, address newOwner) returns (Owner storage) {
    self._inner = newOwner;
    return self;
}

function onlyOwner(Owner storage self, address caller) view {
    if (caller != self._inner) revert NotOwner(caller);
}

contract Adapter {
    Store store;

    constructor(address owner_) {
        store.owner.write(owner_);
    }
}
`;

function makeFakeWorkspace() {
  return {
    getAllFileUris: () => [],
    uriToPath: (uri: string) => URI.parse(uri).fsPath,
  } as unknown as WorkspaceManager;
}

function setup(uri: string, text: string) {
  const parser = new SolidityParser();
  const idx = new SymbolIndex(parser, makeFakeWorkspace());
  const workspace = makeFakeWorkspace();
  parser.parse(uri, text);
  idx.updateFile(uri);
  return {
    doc: TextDocument.create(uri, "solidity", 1, text),
    parser,
    idx,
    workspace,
  };
}

describe("global using-for free functions", () => {
  it("parses file-level global using directives", () => {
    const parser = new SolidityParser();
    const result = parser.parse("file:///w/Owner.sol", OWNER_FIXTURE);
    assert.equal(result.sourceUnit.usingFor.length, 1);
    assert.equal(result.sourceUnit.usingFor[0].isGlobal, true);
    assert.deepEqual(result.sourceUnit.usingFor[0].functionNames, ["read", "write", "onlyOwner"]);
    assert.equal(result.sourceUnit.usingFor[0].typeName, "Owner");
  });

  it("parses free-function using aliases as exposed member names", () => {
    const parser = new SolidityParser();
    const result = parser.parse(
      "file:///w/Alias.sol",
      `pragma solidity 0.8.26;
struct Data {
    uint256 value;
}
function clear(Data storage self) {}
using {clear as wipe} for Data;
`,
    );
    assert.equal(result.sourceUnit.usingFor.length, 1);
    assert.deepEqual(result.sourceUnit.usingFor[0].functionNames, ["wipe"]);
    assert.deepEqual(result.sourceUnit.usingFor[0].functionAliases, [
      { functionName: "clear", memberName: "wipe" },
    ]);
  });

  it("parses operator using aliases as exposed member names", () => {
    const parser = new SolidityParser();
    const result = parser.parse(
      "file:///w/Operator.sol",
      `pragma solidity 0.8.26;
type Wad is uint256;
function add(Wad left, Wad right) pure returns (Wad) {
    return left;
}
using {add as +} for Wad global;
`,
    );
    assert.equal(result.sourceUnit.usingFor.length, 1);
    assert.equal(result.sourceUnit.usingFor[0].isGlobal, true);
    assert.deepEqual(result.sourceUnit.usingFor[0].functionNames, ["+"]);
    assert.deepEqual(result.sourceUnit.usingFor[0].functionAliases, [
      { functionName: "add", memberName: "+" },
    ]);
  });

  it("preserves namespace-qualified using function references", () => {
    const parser = new SolidityParser();
    const result = parser.parse(
      "file:///w/Namespace.sol",
      `pragma solidity 0.8.26;
import * as Ops from "./Ops.sol";
struct Data {
    uint256 value;
}
using {Ops.clear as wipe} for Data;
`,
    );
    assert.equal(result.sourceUnit.usingFor.length, 1);
    assert.deepEqual(result.sourceUnit.usingFor[0].functionNames, ["wipe"]);
    assert.deepEqual(result.sourceUnit.usingFor[0].functionAliases, [
      { functionName: "Ops.clear", memberName: "wipe" },
    ]);
  });

  it("hovers on a globally bound free function call", () => {
    const uri = "file:///w/Owner.sol";
    const { doc, parser, idx } = setup(uri, OWNER_FIXTURE);
    const provider = new HoverProvider(idx, parser);
    const lines = doc.getText().split("\n");
    const line = lines.findIndex((l) => l.includes("store.owner.write"));
    assert.ok(line >= 0);
    const col = lines[line].indexOf("write");
    const hover = provider.provideHover(doc, { line, character: col + 1 });
    assert.ok(hover, "expected hover on write");
    const value = (hover!.contents as { value: string }).value;
    assert.match(value, /function write/);
    assert.match(value, /Sets the owner/);
  });

  it("goes to definition for a globally bound free function call", () => {
    const uri = "file:///w/Owner.sol";
    const { doc, parser, idx, workspace } = setup(uri, OWNER_FIXTURE);
    const provider = new DefinitionProvider(idx, parser, workspace);
    const lines = doc.getText().split("\n");
    const line = lines.findIndex((l) => l.includes("store.owner.write"));
    const col = lines[line].indexOf("write");
    const def = provider.provideDefinition(doc, { line, character: col + 1 });
    assert.ok(def && !Array.isArray(def), "expected single definition");
    const loc = def as { uri: string; range: { start: { line: number } } };
    assert.equal(loc.uri, uri);
    assert.ok(loc.range.start.line >= 0);
  });
});
