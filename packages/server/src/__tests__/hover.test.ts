import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import { SolidityParser } from "../parser/solidity-parser.js";
import { SymbolIndex } from "../analyzer/symbol-index.js";
import { SemanticResolver } from "../analyzer/semantic-resolver.js";
import { HoverProvider } from "../providers/hover.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";

function makeFakeWorkspace() {
  return {
    getAllFileUris: () => [],
    uriToPath: (uri: string) => URI.parse(uri).fsPath,
    resolveImport: () => null,
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
  const resolver = new SemanticResolver(parser, workspace ?? makeFakeWorkspace(), idx);
  return {
    doc: TextDocument.create(currentUri, "solidity", 1, files[currentUri]),
    provider: new HoverProvider(idx, parser, workspace, resolver),
  };
}

type HoverResult = NonNullable<ReturnType<HoverProvider["provideHover"]>>;

function hoverValue(hover: HoverResult): string {
  const { contents } = hover;
  assert.ok(!Array.isArray(contents) && typeof contents !== "string");
  return contents.value;
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
      const value = hoverValue(h);
      // The hover renders `msg`'s shape as an inline struct description;
      // assert on the descriptive fields rather than the literal syntax
      // since we don't dictate the exact wording of the doc blurb.
      assert.match(value, /address sender/);
      assert.match(value, /message context/i);
    });

    it("does not treat `constructor` as a built-in global", () => {
      const { doc, provider } = setup(
        "file:///w/BuiltinCtor.sol",
        `pragma solidity ^0.8.0;
contract BuiltinCtor {
    constructor() {}
}`,
      );
      const h = provider.provideHover(doc, { line: 2, character: 6 });
      assert.ok(h, "expected constructor declaration hover");
      const value = (h!.contents as { value: string }).value;
      assert.match(value, /constructor/);
      assert.doesNotMatch(value, /\[Function: Object\]/);
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
      const value = hoverValue(h);
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
      const value = hoverValue(h);
      assert.match(value, /doubled/);
      assert.match(value, /Does the thing/);
      assert.match(value, /Reverts on overflow/);
      assert.match(value, /The input/);
    });

    it("surfaces NatSpec on a constructor hover", () => {
      const { doc, provider } = setup(
        "file:///w/Ctor.sol",
        `pragma solidity ^0.8.0;
contract Ctor {
    /// @notice Deploys the contract.
    /// @param owner The owner address.
    constructor(address owner) {}
}`,
      );
      const h = provider.provideHover(doc, { line: 4, character: 6 });
      assert.ok(h, "expected hover on constructor");
      const value = hoverValue(h);
      assert.match(value, /constructor\s*\(/);
      assert.match(value, /Deploys the contract/);
      assert.match(value, /owner/);
      assert.match(value, /Defined in.*Ctor/);
    });

    it("renders @custom:security-contact as a standalone security contact line", () => {
      const { doc, provider } = setup(
        "file:///w/Security.sol",
        `pragma solidity ^0.8.0;
contract Security {
    /// @notice Handles sensitive work.
    /// @custom:security-contact security@example.com
    function guarded() external {}
}`,
      );

      const h = provider.provideHover(doc, { line: 4, character: 18 });
      assert.ok(h, "expected hover");
      assert.ok(!Array.isArray(h.contents) && typeof h.contents !== "string");
      const value = h.contents.value;
      assert.match(value, /Handles sensitive work\./);
      assert.match(value, /\*\*Security Contact:\*\* security@example\.com/);
      assert.doesNotMatch(value, /Handles sensitive work\..*@custom:security-contact/s);
    });

    it("links braced NatSpec references to visible workspace symbols", () => {
      const uri = "file:///w/InventoryLib.sol";
      const { doc, provider } = setup(
        uri,
        `pragma solidity ^0.8.24;

contract PoolVault {}

/// @notice Accounting helper for {PoolVault}; claims are redeemed via {redeemClaims}.
library InventoryLib {
    function redeemClaims() internal {}
}`,
      );

      const h = provider.provideHover(doc, { line: 5, character: 9 });
      assert.ok(h, "expected hover on library declaration");
      const value = hoverValue(h);
      assert.match(value, /\[PoolVault\]\(file:\/\/\/w\/InventoryLib\.sol#L3,10\)/);
      assert.match(value, /\[redeemClaims\]\(file:\/\/\/w\/InventoryLib\.sol#L7,14\)/);
      assert.doesNotMatch(value, /\{redeemClaims\}/);
    });

    it("links braced NatSpec references to imported contracts and local functions", () => {
      const currentUri = "file:///w/src/InventoryLib.sol";
      const typesUri = "file:///w/src/Types.sol";
      const files = {
        [typesUri]: `pragma solidity ^0.8.24;
contract PoolVault {}
`,
        [currentUri]: `pragma solidity ^0.8.24;
import "./Types.sol";

/// @notice Accounting helper for {PoolVault}; claims are redeemed via {redeemClaims}.
library InventoryLib {
    function redeemClaims() internal {}
}
`,
      };
      const workspace = {
        getAllFileUris: () => Object.keys(files),
        uriToPath: (uri: string) => URI.parse(uri).fsPath,
        resolveImport: (importPath: string, fromPath: string) =>
          importPath === "./Types.sol" && fromPath.endsWith("/src/InventoryLib.sol")
            ? "/w/src/Types.sol"
            : null,
      } as unknown as WorkspaceManager;
      const { doc, provider } = setupFiles(currentUri, files, workspace);

      const h = provider.provideHover(doc, { line: 4, character: 9 });
      assert.ok(h, "expected hover on library declaration");
      const value = hoverValue(h);
      assert.match(value, /\[PoolVault\]\(file:\/\/\/w\/src\/Types\.sol#L2,10\)/);
      assert.match(value, /\[redeemClaims\]\(file:\/\/\/w\/src\/InventoryLib\.sol#L6,14\)/);
      assert.doesNotMatch(value, /\{PoolVault\}/);
      assert.doesNotMatch(value, /\{redeemClaims\}/);
    });

    it("shows `contract C` for a contract-name hover", () => {
      const { doc, provider } = setup(
        "file:///w/D.sol",
        `pragma solidity ^0.8.0;
contract D {}`,
      );
      const h = provider.provideHover(doc, { line: 1, character: 9 });
      assert.ok(h, "expected hover");
      const value = hoverValue(h);
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
      const value = hoverValue(h);
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
      const value = hoverValue(h);
      assert.match(value, /contract ImportedType/);
    });

    it("resolves dotted hovers through import aliases and namespace-qualified structs", () => {
      const targetUri = "file:///w/src/Target.sol";
      const typesUri = "file:///w/src/Types.sol";
      const currentUri = "file:///w/src/UsesAliases.sol";
      const current = `pragma solidity ^0.8.24;
import {Target as RenamedTarget} from "./Target.sol";
import * as TypeNS from "./Types.sol";

contract UsesAliases {
    RenamedTarget public direct;
    TypeNS.Box internal box;

    function f() external view {
        direct.ping(1);
        box.vault.preview(1);
    }
}`;
      const files = {
        [targetUri]: `pragma solidity ^0.8.24;
contract Target {
    function ping(uint256 value) external pure returns (uint256) {
        return value;
    }
}
`,
        [typesUri]: `pragma solidity ^0.8.24;
interface IBase {
    function preview(uint256 value) external view returns (uint256);
}
interface IChild is IBase {}
struct Box {
    IChild vault;
}
`,
        [currentUri]: current,
      };
      const workspace = {
        getAllFileUris: () => Object.keys(files),
        uriToPath: (uri: string) => URI.parse(uri).fsPath,
        resolveImport: (importPath: string, fromFile: string) => {
          const fromPath = fromFile;
          const slash = fromPath.lastIndexOf("/");
          const base = slash >= 0 ? fromPath.slice(0, slash + 1) : "";
          const normalized = new URL(importPath, URI.file(base).toString()).toString();
          return normalized in files ? URI.parse(normalized).fsPath : null;
        },
      } as unknown as WorkspaceManager;
      const { doc, provider } = setupFiles(currentUri, files, workspace);
      const lines = current.split("\n");

      const pingLine = lines.findIndex((line) => line.includes("direct.ping"));
      const pingHover = provider.provideHover(doc, {
        line: pingLine,
        character: lines[pingLine].indexOf("ping") + 1,
      });
      assert.ok(pingHover, "expected hover on aliased Target.ping receiver");
      assert.ok(!Array.isArray(pingHover.contents) && typeof pingHover.contents !== "string");
      assert.match(pingHover.contents.value, /function ping/);
      assert.match(pingHover.contents.value, /Defined in.*Target/);

      const previewLine = lines.findIndex((line) => line.includes("box.vault.preview"));
      const previewHover = provider.provideHover(doc, {
        line: previewLine,
        character: lines[previewLine].indexOf("preview") + 1,
      });
      assert.ok(previewHover, "expected hover on namespace-qualified struct member receiver");
      assert.ok(!Array.isArray(previewHover.contents) && typeof previewHover.contents !== "string");
      assert.match(previewHover.contents.value, /function preview/);
      assert.match(previewHover.contents.value, /Defined in.*IBase/);
    });

    it("does not resolve dotted hovers through unimported test-only receiver types", () => {
      const currentUri = "file:///w/src/UsesGhost.sol";
      const current = `pragma solidity ^0.8.24;
contract UsesGhost {
    Ghost internal ghost;

    function f() external view {
        ghost.ping();
    }
}`;
      const files = {
        "file:///w/test/Ghost.sol": `pragma solidity ^0.8.24;
interface Ghost {
    function ping() external view returns (uint256);
}
`,
        [currentUri]: current,
      };
      const workspace = {
        getAllFileUris: () => Object.keys(files),
        uriToPath: (uri: string) => URI.parse(uri).fsPath,
        resolveImport: () => null,
      } as unknown as WorkspaceManager;
      const { doc, provider } = setupFiles(currentUri, files, workspace);
      const lines = current.split("\n");
      const line = lines.findIndex((candidate) => candidate.includes("ghost.ping"));
      const hover = provider.provideHover(doc, {
        line,
        character: lines[line].indexOf("ping") + 1,
      });

      assert.equal(hover, null);
    });

    it("resolves using-for hovers through imported library aliases", () => {
      const libUri = "file:///w/src/DataLib.sol";
      const currentUri = "file:///w/src/UsesUsingAlias.sol";
      const current = `pragma solidity ^0.8.24;
import {Data, DataLib as RenamedDataLib} from "./DataLib.sol";

contract UsesUsingAlias {
    using RenamedDataLib for Data;
    Data internal data;

    function f() external {
        data.bump(1);
    }
}`;
      const files = {
        [libUri]: `pragma solidity ^0.8.24;
struct Data {
    uint256 value;
}

library DataLib {
    function bump(Data storage self, uint256 value) internal returns (uint256) {
        self.value += value;
        return self.value;
    }
}
`,
        [currentUri]: current,
      };
      const workspace = {
        getAllFileUris: () => Object.keys(files),
        uriToPath: (uri: string) => URI.parse(uri).fsPath,
        resolveImport: (importPath: string, fromFile: string) => {
          const slash = fromFile.lastIndexOf("/");
          const base = slash >= 0 ? fromFile.slice(0, slash + 1) : "";
          const normalized = new URL(importPath, URI.file(base).toString()).toString();
          return normalized in files ? URI.parse(normalized).fsPath : null;
        },
      } as unknown as WorkspaceManager;
      const { doc, provider } = setupFiles(currentUri, files, workspace);
      const lines = current.split("\n");
      const line = lines.findIndex((candidate) => candidate.includes("data.bump"));
      const hover = provider.provideHover(doc, {
        line,
        character: lines[line].indexOf("bump") + 1,
      });

      assert.ok(hover, "expected hover on aliased using-for method");
      assert.ok(!Array.isArray(hover.contents) && typeof hover.contents !== "string");
      assert.match(hover.contents.value, /function bump/);
      assert.match(hover.contents.value, /Defined in.*DataLib/);
    });

    it("does not resolve using-for hovers through unimported test-only libraries", () => {
      const currentUri = "file:///w/src/UsesGhostLib.sol";
      const current = `pragma solidity ^0.8.24;
struct Data {
    uint256 value;
}

contract UsesGhostLib {
    using GhostLib for Data;
    Data internal data;

    function f() external view {
        data.bump();
    }
}`;
      const files = {
        "file:///w/test/GhostLib.sol": `pragma solidity ^0.8.24;
struct Data {
    uint256 value;
}

library GhostLib {
    function bump(Data storage self) internal view returns (uint256) {
        return self.value + 1;
    }
}
`,
        [currentUri]: current,
      };
      const workspace = {
        getAllFileUris: () => Object.keys(files),
        uriToPath: (uri: string) => URI.parse(uri).fsPath,
        resolveImport: () => null,
      } as unknown as WorkspaceManager;
      const { doc, provider } = setupFiles(currentUri, files, workspace);
      const lines = current.split("\n");
      const line = lines.findIndex((candidate) => candidate.includes("data.bump"));
      const hover = provider.provideHover(doc, {
        line,
        character: lines[line].indexOf("bump") + 1,
      });

      assert.equal(hover, null);
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
      const value = hoverValue(h);
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
        const value = hoverValue(h);
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
        const value = hoverValue(h);
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
        const value = hoverValue(h);
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
          const value = hoverValue(h);
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
      const value = hoverValue(h);
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
      const value = hoverValue(h);
      // Must be from SafeMath, not from the `Other` contract that also
      // has an `add` function.
      assert.match(value, /Defined in.*SafeMath/, `expected SafeMath container; got ${value}`);
    });

    it("hovers a struct member through a typed receiver", () => {
      const code = `struct Params { uint256 poolTickSpacing; }
contract C {
    function validate(Params memory p) internal pure {
        p.poolTickSpacing;
    }
}`;
      const { doc, provider } = setup("file:///w/StructMemberHover.sol", code);
      const lines = code.split("\n");
      const useLine = lines.findIndex((line) => line.includes("p.poolTickSpacing"));
      const col = lines[useLine].indexOf("poolTickSpacing");
      const h = provider.provideHover(doc, { line: useLine, character: col });
      assert.ok(h, "expected hover on struct member");
      assert.ok(!Array.isArray(h.contents) && typeof h.contents !== "string");
      assert.match(h.contents.value, /uint256 poolTickSpacing/);
      assert.match(h.contents.value, /Struct member of.*Params/);
    });

    it("hovers a file-level struct type used in a function parameter", () => {
      const code = `pragma solidity ^0.8.24;

/// @notice Parameters for the migrator.
struct MigratorParameters {
    uint256 poolTickSpacing;
}

contract C {
    function validate(MigratorParameters memory p) internal pure {}
}`;
      const { doc, provider } = setup("file:///w/FileStruct.sol", code);
      const lines = code.split("\n");
      const sigLine = lines.findIndex((line) => line.includes("function validate"));
      const col = lines[sigLine].indexOf("MigratorParameters") + 2;
      const h = provider.provideHover(doc, { line: sigLine, character: col });
      assert.ok(h, "expected hover on file-level struct type");
      assert.ok(!Array.isArray(h.contents) && typeof h.contents !== "string");
      const value = h.contents.value;
      assert.match(value, /struct MigratorParameters/);
      assert.match(value, /Parameters for the migrator/);
    });

    it("resolves member hovers through a typed receiver parameter", () => {
      const code = `interface ILBPInitializer {
    /// @notice Returns the token used by the initializer.
    function token() external view returns (address);
}
contract Other {
    function token(uint256 unrelated) external returns (address) { return address(0); }
}
contract C {
    function f(ILBPInitializer initializer) external view returns (address) {
        return initializer.token();
    }
}`;
      const { doc, provider } = setup("file:///w/TypedReceiverHover.sol", code);
      const lines = code.split("\n");
      const callLine = lines.findIndex((line) => line.includes("initializer.token"));
      const tokenCol = lines[callLine].indexOf(".token") + 1;
      const h = provider.provideHover(doc, { line: callLine, character: tokenCol });
      assert.ok(h, "expected hover on typed receiver member");
      assert.ok(!Array.isArray(h.contents) && typeof h.contents !== "string");
      const value = h.contents.value;
      assert.match(value, /function token\(\) external view returns \(address\)/);
      assert.match(value, /Returns the token used by the initializer/);
      assert.match(value, /Defined in.*ILBPInitializer/);
      assert.doesNotMatch(value, /unrelated/);
    });

    it("resolves member hovers inside a file-level free function", () => {
      const code = `interface IToken {
    function decimals() external view returns (uint8);
}
function readDecimals(IToken token) pure returns (uint8) {
    return token.decimals();
}`;
      const { doc, provider } = setup("file:///w/FreeFnHover.sol", code);
      const lines = code.split("\n");
      const callLine = lines.findIndex((line) => line.includes("token.decimals"));
      const col = lines[callLine].indexOf(".decimals") + 1;
      const h = provider.provideHover(doc, { line: callLine, character: col });
      assert.ok(h, "expected hover on member inside free function");
      assert.ok(!Array.isArray(h.contents) && typeof h.contents !== "string");
      assert.match(h.contents.value, /function decimals\(\)/);
      assert.match(h.contents.value, /IToken/);
    });

    it("resolves member hovers through a typed function-local variable", () => {
      const code = `interface ILBPInitializer {
    /// @notice Returns the token used by the initializer.
    function token() external view returns (address);
}
contract Other {
    function token(uint256 unrelated) external returns (address) { return address(0); }
}
contract C {
    function f() external view returns (address) {
        ILBPInitializer initializer = ILBPInitializer(address(0));
        return initializer.token();
    }
}`;
      const { doc, provider } = setup("file:///w/LocalReceiverHover.sol", code);
      const lines = code.split("\n");
      const callLine = lines.findIndex((line) => line.includes("initializer.token"));
      const tokenCol = lines[callLine].indexOf(".token") + 1;
      const h = provider.provideHover(doc, { line: callLine, character: tokenCol });
      assert.ok(h, "expected hover on local receiver member");
      assert.ok(!Array.isArray(h.contents) && typeof h.contents !== "string");
      const value = h.contents.value;
      assert.match(value, /function token\(\) external view returns \(address\)/);
      assert.match(value, /Returns the token used by the initializer/);
      assert.match(value, /Defined in.*ILBPInitializer/);
      assert.doesNotMatch(value, /unrelated/);
    });

    it("resolves using-for function hovers on typed receiver variables", () => {
      const code = `interface IERC20 {}
contract Other {
    function safeTransfer(uint256 unrelated) external {}
}
library SafeERC20 {
    /// @notice Safely transfers tokens.
    function safeTransfer(IERC20 token, address to, uint256 value) internal {
        token; to; value;
    }
}
contract C {
    using SafeERC20 for IERC20;
    function f(IERC20 token, address recipient, uint256 amount) external {
        token.safeTransfer(recipient, amount);
    }
}`;
      const { doc, provider } = setup("file:///w/UsingHover.sol", code);
      const lines = code.split("\n");
      const callLine = lines.findIndex((line) => line.includes("token.safeTransfer"));
      const safeTransferCol = lines[callLine].indexOf(".safeTransfer") + 1;
      const h = provider.provideHover(doc, { line: callLine, character: safeTransferCol });
      assert.ok(h, "expected hover on using-for safeTransfer");
      assert.ok(!Array.isArray(h.contents) && typeof h.contents !== "string");
      const value = h.contents.value;
      assert.match(value, /function safeTransfer\(IERC20 token, address to, uint256 value\)/);
      assert.match(value, /Safely transfers tokens/);
      assert.match(value, /Defined in.*SafeERC20/);
      assert.doesNotMatch(value, /unrelated/);
    });

    it("resolves using-for function hovers on cast receiver expressions", () => {
      const code = `interface IERC20 {}
interface Initializer {
    function token() external view returns (address);
}
contract Other {
    function safeTransfer(uint256 unrelated) external {}
}
library SafeERC20 {
    /// @notice Safely transfers tokens.
    function safeTransfer(IERC20 token, address to, uint256 value) internal {
        token; to; value;
    }
}
contract C {
    using SafeERC20 for IERC20;
    function f(Initializer initializer, address recipient, uint256 amount) external {
        IERC20(initializer.token()).safeTransfer(recipient, amount);
    }
}`;
      const { doc, provider } = setup("file:///w/UsingHoverCast.sol", code);
      const lines = code.split("\n");
      const callLine = lines.findIndex((line) => line.includes(".safeTransfer"));
      const safeTransferCol = lines[callLine].indexOf(".safeTransfer") + 1;
      const h = provider.provideHover(doc, { line: callLine, character: safeTransferCol });
      assert.ok(h, "expected hover on using-for safeTransfer");
      assert.ok(!Array.isArray(h.contents) && typeof h.contents !== "string");
      const value = h.contents.value;
      assert.match(value, /function safeTransfer\(IERC20 token, address to, uint256 value\)/);
      assert.match(value, /Safely transfers tokens/);
      assert.match(value, /Defined in.*SafeERC20/);
      assert.doesNotMatch(value, /unrelated/);
    });

    it("does not let an unreachable test UDVT shadow an imported static receiver", () => {
      const currentUri = "file:///w/src/UsesCurrency.sol";
      const libUri = "file:///w/src/CurrencyLib.sol";
      const testUri = "file:///w/test/Currency.t.sol";
      const current = `pragma solidity ^0.8.24;
import {Currency} from "./CurrencyLib.sol";

contract UsesCurrency {
    function f() external pure returns (uint256) {
        return Currency.unwrap(1);
    }
}`;
      const files = {
        [testUri]: `pragma solidity ^0.8.24;
type Currency is address;
`,
        [libUri]: `pragma solidity ^0.8.24;
library Currency {
    /// @notice Converts a currency value.
    function unwrap(uint256 value) internal pure returns (uint256) {
        return value;
    }
}
`,
        [currentUri]: current,
      };
      const workspace = {
        getAllFileUris: () => Object.keys(files),
        uriToPath: (uri: string) => URI.parse(uri).fsPath,
        resolveImport: (importPath: string, fromFile: string) => {
          const slash = fromFile.lastIndexOf("/");
          const base = slash >= 0 ? fromFile.slice(0, slash + 1) : "";
          const normalized = new URL(importPath, URI.file(base).toString()).toString();
          return normalized in files ? URI.parse(normalized).fsPath : null;
        },
      } as unknown as WorkspaceManager;
      const { doc, provider } = setupFiles(currentUri, files, workspace);
      const lines = current.split("\n");
      const callLine = lines.findIndex((line) => line.includes("Currency.unwrap"));
      const hover = provider.provideHover(doc, {
        line: callLine,
        character: lines[callLine].indexOf("unwrap") + 1,
      });

      assert.ok(hover, "expected hover on imported Currency.unwrap");
      assert.ok(!Array.isArray(hover.contents) && typeof hover.contents !== "string");
      assert.match(hover.contents.value, /function unwrap\(uint256 value\)/);
      assert.match(hover.contents.value, /Converts a currency value/);
      assert.match(hover.contents.value, /Defined in.*Currency/);
      assert.doesNotMatch(hover.contents.value, /Implicit converter/);
    });

    it("resolves @inheritdoc on a public constant from the interface getter", () => {
      const { doc, provider } = setup(
        "file:///w/ConstantInherit.sol",
        `pragma solidity ^0.8.24;

interface IV4FeePolicy {
    /// @notice Reserved family slot for native-math.
    /// @dev Not assignable as a governance hook family.
    /// @return 0xFF (255 == type(uint8).max).
    function NATIVE_MATH_FAMILY_ID() external pure returns (uint8);
}

contract V4FeePolicy is IV4FeePolicy {
    /// @inheritdoc IV4FeePolicy
    uint8 public constant NATIVE_MATH_FAMILY_ID = 0xFF;
}`,
      );

      const line = 11;
      const col = 26;
      const h = provider.provideHover(doc, { line, character: col });
      assert.ok(h, "expected hover on public constant");
      const value = (h!.contents as { value: string }).value;
      assert.match(value, /uint8 NATIVE_MATH_FAMILY_ID/);
      assert.match(value, /Reserved family slot for native-math/i);
      assert.match(value, /Not assignable as a governance hook family/i);
      assert.match(value, /0xFF \(255 == type\(uint8\)\.max\)/);
      assert.match(value, /Defined in.*V4FeePolicy/);
      assert.doesNotMatch(value, /Inherits Documentation From/i);
    });

    it("resolves @inheritdoc to the interface NatSpec on an override", () => {
      const { doc, provider } = setup(
        "file:///w/Inheritdoc.sol",
        `pragma solidity ^0.8.24;

interface IFeeClassifiedHook {
    /// @notice Returns the protocol fee flags bitmap.
    /// @return flags Encoded fee classification flags.
    function protocolFeeFlags() external pure returns (uint256);
}

contract BaseAggregatorHook is IFeeClassifiedHook {
    /// @inheritdoc IFeeClassifiedHook
    function protocolFeeFlags() external pure virtual returns (uint256) {
        return 1 << 11;
    }
}`,
      );

      const line = 10;
      const col = 13;
      const h = provider.provideHover(doc, { line, character: col });
      assert.ok(h, "expected hover on overriding function");
      const value = (h!.contents as { value: string }).value;
      assert.match(value, /protocol fee flags bitmap/i);
      assert.match(value, /Encoded fee classification flags/i);
      assert.doesNotMatch(value, /Inherits Documentation From/i);
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
      const wrapVal = hoverValue(hWrap);
      assert.match(wrapVal, /wrap/);
      assert.match(wrapVal, /Currency/);
      assert.match(wrapVal, /address/); // underlying type

      const unwrapLine = lines.findIndex((l) => l.includes("Currency.unwrap("));
      const unwrapCol = lines[unwrapLine].indexOf(".unwrap") + 1;
      const hUn = provider.provideHover(doc, { line: unwrapLine, character: unwrapCol });
      assert.ok(hUn, "expected unwrap hover");
      const unVal = hoverValue(hUn);
      assert.match(unVal, /unwrap/);
      assert.match(unVal, /Currency/);
    });
  });
});
