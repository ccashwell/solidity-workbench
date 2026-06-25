import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { URI } from "vscode-uri";
import { SolidityParser } from "../parser/solidity-parser.js";
import { SymbolIndex } from "../analyzer/symbol-index.js";
import { SemanticResolver } from "../analyzer/semantic-resolver.js";
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

  it("inherits interface getter NatSpec for a public constant", () => {
    const uri = "file:///w/Constants.sol";
    const parser = new SolidityParser();
    const idx = new SymbolIndex(parser, makeFakeWorkspace());
    const text = `pragma solidity ^0.8.24;

interface IV4FeePolicy {
    /// @notice Reserved family slot for native-math.
    /// @return 0xFF
    function NATIVE_MATH_FAMILY_ID() external pure returns (uint8);
}

contract V4FeePolicy is IV4FeePolicy {
    /// @inheritdoc IV4FeePolicy
    uint8 public constant NATIVE_MATH_FAMILY_ID = 0xFF;
}`;
    parser.parse(uri, text);
    idx.updateFile(uri);

    const sym = idx
      .findSymbols("NATIVE_MATH_FAMILY_ID")
      .find((s) => s.kind === "stateVariable" && s.containerName === "V4FeePolicy");
    assert.ok(sym);
    const effective = resolveEffectiveNatspec(sym!, idx);
    assert.equal(effective?.notice, "Reserved family slot for native-math.");
    assert.match(effective?.returns?.[""] ?? "", /0xFF/);
  });

  it("resolves @inheritdoc through the imported interface when duplicate names exist", () => {
    const parser = new SolidityParser();
    const files = {
      "file:///w/test/IFoo.sol": `pragma solidity ^0.8.24;

interface IFoo {
    /// @notice Test-only notice.
    function foo() external;
}
`,
      "file:///w/src/IFoo.sol": `pragma solidity ^0.8.24;

interface IFoo {
    /// @notice Source interface notice.
    function foo() external;
}
`,
      "file:///w/src/C.sol": `pragma solidity ^0.8.24;

import "./IFoo.sol";

contract C is IFoo {
    /// @inheritdoc IFoo
    function foo() external {}
}
`,
    };
    const workspace = {
      getAllFileUris: () => Object.keys(files),
      uriToPath: (uri: string) => URI.parse(uri).fsPath,
      resolveImport: (importPath: string, fromPath: string) =>
        importPath === "./IFoo.sol" && fromPath.endsWith("/w/src/C.sol") ? "/w/src/IFoo.sol" : null,
    } as unknown as WorkspaceManager;
    const idx = new SymbolIndex(parser, workspace);
    for (const [uri, text] of Object.entries(files)) {
      parser.parse(uri, text);
      idx.updateFile(uri);
    }
    const resolver = new SemanticResolver(parser, workspace, idx);

    const sym = idx.findSymbols("foo").find((s) => s.containerName === "C");
    assert.ok(sym);
    const effective = resolveEffectiveNatspec(sym, idx, resolver);
    assert.equal(effective?.notice, "Source interface notice.");
    assert.notEqual(effective?.notice, "Test-only notice.");
  });
});
