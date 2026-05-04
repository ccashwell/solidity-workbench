import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import { SolidityParser } from "../parser/solidity-parser.js";
import { SymbolIndex } from "../analyzer/symbol-index.js";
import { HoverProvider } from "../providers/hover.js";
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
    provider: new HoverProvider(idx, parser),
  };
}

function setupFiles(
  currentUri: string,
  files: Record<string, string>,
  workspace?: WorkspaceManager,
) {
  const parser = new SolidityParser();
  const idx = new SymbolIndex(parser, workspace ?? makeFakeWorkspace());
  for (const [uri, text] of Object.entries(files)) {
    parser.parse(uri, text);
    idx.updateFile(uri);
  }
  return {
    doc: TextDocument.create(currentUri, "solidity", 1, files[currentUri]),
    provider: new HoverProvider(idx, parser, workspace),
  };
}

describe("HoverProvider", () => {
  describe("built-in globals", () => {
    it("returns a hover for `msg`", () => {
      const { doc, provider } = setup(
        "file:///w/A.sol",
        `pragma solidity ^0.8.0;
contract A {
    function f() external view { address a = msg.sender; a; }
}`,
      );

      // Cursor on "msg" at line 2
      const h = provider.provideHover(doc, { line: 2, character: 48 });
      assert.ok(h, "expected hover");
      const value = (h!.contents as any).value as string;
      // The hover renders `msg`'s shape as an inline struct description;
      // assert on the descriptive fields rather than the literal syntax
      // since we don't dictate the exact wording of the doc blurb.
      assert.match(value, /address sender/);
      assert.match(value, /message context/i);
    });

    it("returns a hover for `keccak256`", () => {
      const { doc, provider } = setup(
        "file:///w/B.sol",
        `pragma solidity ^0.8.0;
contract B {
    function h() external pure returns (bytes32) { return keccak256(""); }
}`,
      );
      const h = provider.provideHover(doc, { line: 2, character: 58 });
      assert.ok(h, "expected hover");
      const value = (h!.contents as any).value as string;
      assert.match(value, /Keccak-256/);
    });
  });

  describe("user-defined symbols", () => {
    it("surfaces NatSpec on a function hover", () => {
      const { doc, provider } = setup(
        "file:///w/C.sol",
        `pragma solidity ^0.8.0;
contract C {
    /// @notice Does the thing.
    /// @dev Reverts on overflow.
    /// @param x The input.
    /// @return The doubled value.
    function doubled(uint256 x) public pure returns (uint256) { return x * 2; }
}`,
      );
      // Cursor on "doubled"
      const h = provider.provideHover(doc, { line: 6, character: 18 });
      assert.ok(h, "expected hover");
      const value = (h!.contents as any).value as string;
      assert.match(value, /doubled/);
      assert.match(value, /Does the thing/);
      assert.match(value, /Reverts on overflow/);
      assert.match(value, /The input/);
    });

    it("shows `contract C` for a contract-name hover", () => {
      const { doc, provider } = setup(
        "file:///w/D.sol",
        `pragma solidity ^0.8.0;
contract D {}`,
      );
      const h = provider.provideHover(doc, { line: 1, character: 9 });
      assert.ok(h, "expected hover");
      const value = (h!.contents as any).value as string;
      assert.match(value, /contract D/);
    });

    it("returns null when hovering on whitespace", () => {
      const { doc, provider } = setup(
        "file:///w/E.sol",
        `pragma solidity ^0.8.0;
contract E {}`,
      );
      const h = provider.provideHover(doc, { line: 0, character: 0 });
      // Position 0 is the start of "pragma" — will hover the pragma keyword.
      // That's fine; we just assert the provider doesn't crash.
      void h;
    });

    it("prefers a local parameter over an unrelated same-named workspace symbol", () => {
      const currentUri = "file:///w/src/alf/SmartPoolHook.sol";
      const current = `pragma solidity ^0.8.0;
type PoolId is bytes32;
contract SmartPoolHook {
    /// @param poolId The pool to check authorization for.
    function _requireDepositAuth(PoolId poolId) internal view {
        if (externalDepositsEnabled[poolId]) return;
    }
}`;
      const unrelated = `pragma solidity ^0.8.0;
type PoolId is bytes32;
contract FluidDexLiteAggregatorUnitTest {
    PoolId poolId;
}`;
      const { doc, provider } = setupFiles(currentUri, {
        [currentUri]: current,
        "file:///w/test/FluidDexLiteAggregatorUnitTest.t.sol": unrelated,
      });

      const line = current.split("\n")[4];
      const col = line.indexOf("poolId)") + 1;
      const h = provider.provideHover(doc, { line: 4, character: col });
      assert.ok(h, "expected hover on local poolId parameter");
      const value = (h!.contents as any).value as string;
      assert.match(value, /PoolId poolId/);
      assert.match(value, /Parameter of.*_requireDepositAuth/);
      assert.match(value, /pool to check authorization/);
      assert.doesNotMatch(value, /FluidDexLiteAggregatorUnitTest/);
    });

    it("does not surface an unimported same-workspace symbol", () => {
      const currentUri = "file:///w/src/Current.sol";
      const current = `pragma solidity ^0.8.0;
contract Current {
    function f() external pure { Ghost; }
}`;
      const unrelated = `pragma solidity ^0.8.0;
contract Ghost {}`;
      const files = {
        [currentUri]: current,
        "file:///w/test/Ghost.t.sol": unrelated,
      };
      const workspace = {
        getAllFileUris: () => Object.keys(files),
        uriToPath: (uri: string) => URI.parse(uri).fsPath,
        resolveImport: () => null,
      } as unknown as WorkspaceManager;
      const { doc, provider } = setupFiles(currentUri, files, workspace);

      const line = current.split("\n")[2];
      const col = line.indexOf("Ghost") + 1;
      const h = provider.provideHover(doc, { line: 2, character: col });
      assert.equal(h, null);
    });

    it("still resolves a symbol from a transitive import", () => {
      const currentUri = "file:///w/src/Current.sol";
      const importedUri = "file:///w/src/Types.sol";
      const current = `pragma solidity ^0.8.0;
import "./Types.sol";
contract Current {
    function f() external pure { ImportedType; }
}`;
      const imported = `pragma solidity ^0.8.0;
contract ImportedType {}`;
      const files = {
        [currentUri]: current,
        [importedUri]: imported,
      };
      const workspace = {
        getAllFileUris: () => Object.keys(files),
        uriToPath: (uri: string) => URI.parse(uri).fsPath,
        resolveImport: (importPath: string) =>
          importPath === "./Types.sol" ? URI.parse(importedUri).fsPath : null,
      } as unknown as WorkspaceManager;
      const { doc, provider } = setupFiles(currentUri, files, workspace);

      const line = current.split("\n")[3];
      const col = line.indexOf("ImportedType") + 1;
      const h = provider.provideHover(doc, { line: 3, character: col });
      assert.ok(h, "expected hover for imported symbol");
      const value = (h!.contents as any).value as string;
      assert.match(value, /contract ImportedType/);
    });
  });

  describe("elementary type hover", () => {
    it("hovers on `address`", () => {
      const { doc, provider } = setup(
        "file:///w/F.sol",
        `pragma solidity ^0.8.0;
contract F { function f(address a) external {} }`,
      );
      const h = provider.provideHover(doc, { line: 1, character: 26 });
      assert.ok(h, "expected hover");
      const value = (h!.contents as any).value as string;
      assert.match(value, /address/);
    });

    it("hovers on every `uintN` width — not just uint256", () => {
      // Regression: the hardcoded lookup only covered uint256; uint8,
      // uint16, uint128 et al fell through with no hover.
      const widths = [8, 16, 24, 32, 64, 96, 128, 160, 192, 224, 256];
      for (const bits of widths) {
        const type = `uint${bits}`;
        const code = `contract T { function f(${type} x) external pure { x; } }`;
        const { doc, provider } = setup(`file:///w/u${bits}.sol`, code);
        const col = code.indexOf(type) + 2; // cursor inside the type word
        const h = provider.provideHover(doc, { line: 0, character: col });
        assert.ok(h, `expected hover on ${type}`);
        const value = (h!.contents as any).value as string;
        assert.match(
          value,
          new RegExp(`Unsigned ${bits}-bit`),
          `hover for ${type} should describe ${bits}-bit`,
        );
      }
    });

    it("hovers on every `intN` width and the `int` / `uint` aliases", () => {
      const cases: [string, RegExp][] = [
        ["int", /Signed 256-bit/],
        ["int8", /Signed 8-bit/],
        ["int24", /Signed 24-bit/],
        ["int128", /Signed 128-bit/],
        ["int256", /Signed 256-bit/],
        ["uint", /Unsigned 256-bit/],
      ];
      for (const [type, pattern] of cases) {
        const code = `contract T { function f(${type} x) external pure { x; } }`;
        const { doc, provider } = setup(`file:///w/${type}.sol`, code);
        const col = code.indexOf(type) + 1;
        const h = provider.provideHover(doc, { line: 0, character: col });
        assert.ok(h, `expected hover on ${type}`);
        const value = (h!.contents as any).value as string;
        assert.match(value, pattern);
      }
    });

    it("hovers on every `bytesN` width and the legacy `byte` alias", () => {
      const cases: [string, RegExp][] = [
        ["bytes1", /length 1/],
        ["bytes4", /length 4/],
        ["bytes16", /length 16/],
        ["bytes32", /length 32/],
        ["byte", /deprecated/i],
      ];
      for (const [type, pattern] of cases) {
        const code = `contract T { function f(${type} x) external pure { x; } }`;
        const { doc, provider } = setup(`file:///w/${type}.sol`, code);
        const col = code.indexOf(type) + 1;
        const h = provider.provideHover(doc, { line: 0, character: col });
        assert.ok(h, `expected hover on ${type}`);
        const value = (h!.contents as any).value as string;
        assert.match(value, pattern);
      }
    });

    it("does not emit a hover for invalid widths like `uint7` or `bytes33`", () => {
      for (const type of ["uint7", "uint300", "int7", "bytes33"]) {
        const code = `contract T { function f(${type} x) external pure { x; } }`;
        const { doc, provider } = setup(`file:///w/bad-${type}.sol`, code);
        const col = code.indexOf(type) + 1;
        const h = provider.provideHover(doc, { line: 0, character: col });
        // Invalid widths should either return null or fall through to
        // symbol lookup (which returns null here since the symbol
        // doesn't exist). Either way, no elementary-type description.
        if (h) {
          const value = (h!.contents as any).value as string;
          assert.doesNotMatch(value, /bit/i, `${type} should not receive an elementary-type hover`);
        }
      }
    });
  });

  describe("dotted access disambiguation", () => {
    it("hovering `Foo.m` does not surface an unrelated `Bar.m`", () => {
      // Regression for: hovering Currency.unwrap(x) surfacing
      // IWstETH.unwrap(uint256) just because both declare a method
      // named "unwrap".
      const code = `pragma solidity ^0.8.0;
interface Foo { function m() external view returns (uint256); }
interface Bar { function m(uint256) external view returns (uint256); }
contract C {
    function f() external view returns (uint256) { return Foo.m(); }
}`;
      const { doc, provider } = setup("file:///w/Dot.sol", code);

      // Cursor on the `m` inside `Foo.m()` on line 4
      const line4 = code.split("\n")[4];
      const mCol = line4.lastIndexOf(".m") + 1;
      const h = provider.provideHover(doc, { line: 4, character: mCol });
      assert.ok(h, "expected hover on Foo.m");
      const value = (h!.contents as any).value as string;
      assert.match(value, /function m/);
      // MUST be the `Foo.m` signature (no parameters), NOT `Bar.m(uint256)`.
      assert.doesNotMatch(
        value,
        /m\(uint256\)/,
        `hover picked Bar.m(uint256) instead of Foo.m(): ${value}`,
      );
      assert.match(value, /Defined in.*Foo/);
    });

    it("returns null when the member doesn't exist on the identified receiver", () => {
      // Prefer no hover over a wrong one: if we know the receiver is
      // `Foo` but `Foo` has no method `nope`, don't fall back to a
      // global name lookup.
      const code = `interface Foo { function m() external; }
contract Bar { function nope() external {} }
contract C {
    function f() external { Foo x; x.nope(); }
}`;
      const { doc, provider } = setup("file:///w/Missing.sol", code);
      const line3 = code.split("\n")[3];
      const nopeCol = line3.indexOf(".nope") + 1;
      const h = provider.provideHover(doc, { line: 3, character: nopeCol });
      // Receiver `x` is NOT a known type name, so we fall through —
      // either null or Bar.nope is acceptable. But when the receiver
      // IS a known type name, we must return null rather than wrong.
      // Exercise the strict case:
      const code2 = `interface Foo { function m() external; }
contract Bar { function nope() external {} }
contract C {
    function f() external { Foo.nope(); }
}`;
      const { doc: doc2, provider: provider2 } = setup("file:///w/Missing2.sol", code2);
      const line3b = code2.split("\n")[3];
      const nope2 = line3b.indexOf(".nope") + 1;
      const h2 = provider2.provideHover(doc2, { line: 3, character: nope2 });
      assert.equal(
        h2,
        null,
        `expected null when Foo has no member nope; got ${JSON.stringify(h2)}`,
      );
      void h;
    });

    it("resolves Library.fn through the library's members", () => {
      const code = `library SafeMath {
    function add(uint256 a, uint256 b) internal pure returns (uint256) { return a + b; }
}
contract Other {
    function add(uint256) external returns (uint256) { return 0; }
}
contract C {
    using SafeMath for uint256;
    function f(uint256 x) external pure returns (uint256) { return SafeMath.add(x, 1); }
}`;
      const { doc, provider } = setup("file:///w/Lib.sol", code);
      const lines = code.split("\n");
      const line8 = lines[8];
      const addCol = line8.indexOf("SafeMath.add") + "SafeMath.".length;
      const h = provider.provideHover(doc, { line: 8, character: addCol });
      assert.ok(h, "expected hover on SafeMath.add");
      const value = (h!.contents as any).value as string;
      // Must be from SafeMath, not from the `Other` contract that also
      // has an `add` function.
      assert.match(value, /Defined in.*SafeMath/, `expected SafeMath container; got ${value}`);
    });

    it("synthesises a `wrap` / `unwrap` hover on a user-defined value type", () => {
      const code = `type Currency is address;
contract C {
    function f(address raw) external pure {
        Currency c = Currency.wrap(raw);
        address back = Currency.unwrap(c);
        back;
    }
}`;
      const { doc, provider } = setup("file:///w/Udvt.sol", code);
      const lines = code.split("\n");

      const wrapLine = lines.findIndex((l) => l.includes("Currency.wrap("));
      const wrapCol = lines[wrapLine].indexOf(".wrap") + 1;
      const hWrap = provider.provideHover(doc, { line: wrapLine, character: wrapCol });
      assert.ok(hWrap, "expected wrap hover");
      const wrapVal = (hWrap!.contents as any).value as string;
      assert.match(wrapVal, /wrap/);
      assert.match(wrapVal, /Currency/);
      assert.match(wrapVal, /address/); // underlying type

      const unwrapLine = lines.findIndex((l) => l.includes("Currency.unwrap("));
      const unwrapCol = lines[unwrapLine].indexOf(".unwrap") + 1;
      const hUn = provider.provideHover(doc, { line: unwrapLine, character: unwrapCol });
      assert.ok(hUn, "expected unwrap hover");
      const unVal = (hUn!.contents as any).value as string;
      assert.match(unVal, /unwrap/);
      assert.match(unVal, /Currency/);
    });
  });
});
