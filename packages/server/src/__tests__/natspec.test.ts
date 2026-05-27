import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { URI } from "vscode-uri";
import { SolidityParser } from "../parser/solidity-parser.js";
import { SymbolIndex } from "../analyzer/symbol-index.js";
import { resolveEffectiveNatspec } from "../utils/natspec.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";

function makeFakeWorkspace() {
  return {
    getAllFileUris: () => [],
    uriToPath: (uri: string) => URI.parse(uri).fsPath,
  } as unknown as WorkspaceManager;
}

describe("resolveEffectiveNatspec", () => {
  it("merges interface notice into an @inheritdoc override", () => {
    const uri = "file:///w/Inheritdoc.sol";
    const parser = new SolidityParser();
    const idx = new SymbolIndex(parser, makeFakeWorkspace());
    const text = `pragma solidity ^0.8.24;

interface IFoo {
    /// @notice Parent notice
    function foo() external pure returns (uint256);
}

contract C is IFoo {
    /// @inheritdoc IFoo
    function foo() external pure returns (uint256) { return 1; }
}`;
    parser.parse(uri, text);
    idx.updateFile(uri);

    const sym = idx.findSymbols("foo").find((s) => s.containerName === "C");
    assert.ok(sym);
    const effective = resolveEffectiveNatspec(sym!, idx);
    assert.equal(effective?.notice, "Parent notice");
    assert.equal(effective?.custom?.inheritdoc, undefined);
  });
});
