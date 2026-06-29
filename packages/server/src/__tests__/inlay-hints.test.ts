import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import { SolidityParser } from "../parser/solidity-parser.js";
import { SymbolIndex } from "../analyzer/symbol-index.js";
import { SemanticResolver } from "../analyzer/semantic-resolver.js";
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

function setupFiles(currentUri: string, files: Record<string, string>) {
  const uris = Object.keys(files);
  const workspace = {
    getAllFileUris: () => uris.slice(),
    uriToPath: (uri: string) => URI.parse(uri).fsPath,
    resolveImport: (importPath: string, fromFile: string) => {
      const slash = fromFile.lastIndexOf("/");
      const base = slash >= 0 ? fromFile.slice(0, slash + 1) : "";
      const normalized = new URL(importPath, URI.file(base).toString()).toString();
      return uris.includes(normalized) ? URI.parse(normalized).fsPath : null;
    },
  } as unknown as WorkspaceManager;
  const parser = new SolidityParser();
  const idx = new SymbolIndex(parser, workspace);
  for (const [uri, text] of Object.entries(files)) {
    parser.parse(uri, text);
    idx.updateFile(uri);
  }
  const resolver = new SemanticResolver(parser, workspace, idx);
  return {
    doc: TextDocument.create(currentUri, "solidity", 1, files[currentUri]),
    provider: new InlayHintsProvider(idx, parser, resolver),
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

  it("emits parameter-name hints for multi-line calls", () => {
    const text = `pragma solidity ^0.8.0;
contract A {
    function transfer(address to, uint256 amount) public returns (bool) {
        return true;
    }
    function trigger() external {
        transfer(
            address(0x1),
            100
        );
    }
}`;
    const { doc, provider } = setup("file:///w/Multi.sol", text);
    const hints = provider.provideInlayHints(doc, {
      start: { line: 0, character: 0 },
      end: { line: text.split("\n").length, character: 0 },
    });

    const labels = hints.map((h) => h.label);
    assert.ok(labels.includes("to:"), `expected "to:" hint, got ${JSON.stringify(labels)}`);
    assert.ok(labels.includes("amount:"), `expected "amount:" hint, got ${JSON.stringify(labels)}`);
    const amount = hints.find((h) => h.label === "amount:");
    assert.deepEqual(amount?.position, { line: 8, character: 12 });
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

  it("scopes unqualified internal calls to the enclosing contract", () => {
    const text = `pragma solidity ^0.8.0;
contract Other {
    function _open(uint256 equity) private {}
}

contract MarginRouter {
    struct OpenParams {
        uint256 collateral;
    }

    function _open(OpenParams params) private returns (address) {
        return address(0);
    }

    function openPosition(OpenParams input) external returns (address) {
        return _open(input);
    }
}`;
    const { doc, provider } = setup("file:///w/MarginRouter.sol", text);
    const hints = provider.provideInlayHints(doc, {
      start: { line: 0, character: 0 },
      end: { line: text.split("\n").length, character: 0 },
    });

    const labels = hints.map((h) => h.label).filter((l): l is string => typeof l === "string");
    assert.ok(
      labels.includes("params:"),
      `expected "params:" for MarginRouter._open, got ${JSON.stringify(labels)}`,
    );
    assert.ok(
      !labels.includes("equity:"),
      `must not pick Other._open's parameter name, got ${JSON.stringify(labels)}`,
    );
  });

  it("resolves unqualified inherited calls through the imported base contract", () => {
    const baseUri = "file:///w/src/Base.sol";
    const childUri = "file:///w/src/Child.sol";
    const testBaseUri = "file:///w/test/Base.sol";
    const files = {
      [baseUri]: `pragma solidity ^0.8.24;
contract Base {
    function sourceOpen(uint256 sourceAmount) internal pure returns (uint256) {
        return sourceAmount;
    }
}`,
      [childUri]: `pragma solidity ^0.8.24;
import "./Base.sol";
contract Child is Base {
    function run() external pure returns (uint256) {
        return sourceOpen(1);
    }
}`,
      [testBaseUri]: `pragma solidity ^0.8.24;
contract Base {
    function sourceOpen(address wrongAccount) internal pure returns (address) {
        return wrongAccount;
    }
}`,
    };
    const { doc, provider } = setupFiles(childUri, files);
    const hints = provider.provideInlayHints(doc, {
      start: { line: 0, character: 0 },
      end: { line: files[childUri].split("\n").length, character: 0 },
    });

    const labels = hints.map((h) => h.label);
    assert.ok(
      labels.includes("sourceAmount:"),
      `expected source Base.sourceOpen parameter, got ${JSON.stringify(labels)}`,
    );
    assert.ok(
      !labels.includes("wrongAccount:"),
      `must not use same-name test Base.sourceOpen parameter, got ${JSON.stringify(labels)}`,
    );
  });

  describe("comment handling", () => {
    it("does not emit hints for the `event Bootstrap` NatSpec example", () => {
      // Exact prose from a real-world report: a vault contract whose
      // event NatSpec used parenthesised, colon-prefixed annotations
      // (`(assets: bootstrap)`, ``sqrt(a: received0 * received1)``)
      // that the regex would otherwise treat as call sites for the
      // `deposit` and `sqrt` functions defined elsewhere in the file.
      const text = `pragma solidity ^0.8.0;
contract V {
    function deposit(uint256 assets, address provider) external returns (uint256) { return assets; }
    function sqrt(uint256 a) internal pure returns (uint256) { return a; }

    /// @notice Emitted on first deposit (assets: bootstrap) -- sets the initial share/asset ratio.
    /// @param vaultId   The vault being bootstrapped.
    /// @param provider  The address that received the bootstrap shares.
    /// @param shares    Total shares minted (\`sqrt(a: received0 * received1)\`).
    /// @param amount0   Asset0 transferred from the bootstrapper (post-FoT receipt).
    /// @param amount1   Asset1 transferred from the bootstrapper (post-FoT receipt).
    event Bootstrap(uint256 vaultId, address provider, uint256 shares, uint256 amount0, uint256 amount1);
}`;
      const { doc, provider } = setup("file:///w/Bs.sol", text);
      const lineCount = text.split("\n").length;
      const hints = provider.provideInlayHints(doc, {
        start: { line: 0, character: 0 },
        end: { line: lineCount, character: 0 },
      });
      assert.equal(
        hints.length,
        0,
        `expected zero hints for prose-only NatSpec, got ${JSON.stringify(hints.map((h) => h.label))}`,
      );
    });

    it("does not emit hints for call-like patterns inside ///, //, or block comments", () => {
      // Real-world trigger: NatSpec for `bootstrap` documents the
      // share-mint formula as `sqrt(a: amount0 * amount1)`. The
      // identifier `sqrt` exists in the symbol index (the contract
      // calls it on line 6), so without comment-awareness the inlay
      // provider would inject `a:` as a hint inside the `///` line.
      const text = `pragma solidity ^0.8.0;
contract M {
    function sqrt(uint256 a) internal pure returns (uint256) { return a; }
    /// One-line: sqrt(a: amount0 * amount1)
    /** Block: sqrt(a: 1) and address(0) */
    /*
     * Multi-line block
     * sqrt(a: 1)
     */
    // Plain: sqrt(a: 1)
    function caller() external pure returns (uint256) {
        return sqrt(1);
    }
}`;
      const { doc, provider } = setup("file:///w/Cm.sol", text);
      const lineCount = text.split("\n").length;
      const hints = provider.provideInlayHints(doc, {
        start: { line: 0, character: 0 },
        end: { line: lineCount, character: 0 },
      });

      // Only the real call `sqrt(1)` should produce a hint.
      const aHints = hints.filter((h) => h.label === "a:");
      assert.equal(
        aHints.length,
        1,
        `expected exactly one "a:" hint (from the real call site), got ${aHints.length}`,
      );
    });
  });

  describe("receiver-aware resolution", () => {
    it("does not emit hints for UDVT `wrap` / `unwrap` builtins", () => {
      // Regression for: hovering / inlay-hinting `Currency.unwrap(x)`
      // surfaced parameter names from an unrelated interface's
      // `unwrap(uint256 _wstETHAmount)` because the lookup was purely
      // by name.
      const text = `pragma solidity ^0.8.0;
type Currency is address;
interface IWstETH {
    function unwrap(uint256 _wstETHAmount) external returns (uint256);
}
contract C {
    function f(Currency currency, Currency other) external pure returns (bool) {
        return Currency.unwrap(currency) == Currency.unwrap(other);
    }
}`;
      const { doc, provider } = setup("file:///w/Udvt.sol", text);
      const hints = provider.provideInlayHints(doc, {
        start: { line: 0, character: 0 },
        end: { line: 20, character: 0 },
      });
      const labels = hints.map((h) => h.label);
      assert.ok(
        !labels.includes("_wstETHAmount:"),
        `UDVT calls should not pick up an unrelated interface's param names; got ${JSON.stringify(labels)}`,
      );
    });

    it("resolves `Library.fn(...)` hints from the library's own params, not a same-named function elsewhere", () => {
      const text = `pragma solidity ^0.8.0;
library SafeMath {
    function add(uint256 a, uint256 b) internal pure returns (uint256) { return a + b; }
}
contract Other {
    function add(uint256 unrelatedName, uint256 anotherName) external returns (uint256) { return 0; }
}
contract C {
    function f(uint256 x) external pure returns (uint256) {
        return SafeMath.add(x, 1);
    }
}`;
      const { doc, provider } = setup("file:///w/Lib.sol", text);
      const hints = provider.provideInlayHints(doc, {
        start: { line: 0, character: 0 },
        end: { line: 20, character: 0 },
      });
      const labels = hints.map((h) => h.label);
      // Must come from SafeMath.add (params a, b), not from Other.add
      // (params unrelatedName, anotherName). The first argument `x`
      // differs from `a`, so we expect `a:`; the second argument `1`
      // differs from `b`, so we expect `b:`.
      assert.ok(
        labels.includes("a:"),
        `expected "a:" from SafeMath.add; got ${JSON.stringify(labels)}`,
      );
      assert.ok(
        labels.includes("b:"),
        `expected "b:" from SafeMath.add; got ${JSON.stringify(labels)}`,
      );
      assert.ok(
        !labels.includes("unrelatedName:"),
        `must not leak param names from Other.add; got ${JSON.stringify(labels)}`,
      );
    });

    it("resolves receiver variable hints through the variable's declared type", () => {
      const text = `pragma solidity ^0.8.0;
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
}
contract C {
    function f(IERC20 token, address alice) external returns (bool) {
        return token.transfer(alice, 100);
    }
}`;
      const { doc, provider } = setup("file:///w/Var.sol", text);
      const hints = provider.provideInlayHints(doc, {
        start: { line: 0, character: 0 },
        end: { line: 20, character: 0 },
      });
      const labels = hints.map((h) => h.label);
      assert.ok(
        labels.includes("to:"),
        `expected "to:" from IERC20.transfer; got ${JSON.stringify(labels)}`,
      );
      assert.ok(
        labels.includes("amount:"),
        `expected "amount:" from IERC20.transfer; got ${JSON.stringify(labels)}`,
      );
    });

    it("scopes static receiver hints to the imported library, not an unreachable test duplicate", () => {
      const helperUri = "file:///w/src/Helper.sol";
      const currentUri = "file:///w/src/User.sol";
      const current = `pragma solidity ^0.8.24;
import {Helper} from "./Helper.sol";

contract User {
    function f() external pure returns (uint256) {
        return Helper.encode(1);
    }
}`;
      const { doc, provider } = setupFiles(currentUri, {
        [helperUri]: `pragma solidity ^0.8.24;
library Helper {
    function encode(uint256 amount) internal pure returns (uint256) {
        return amount;
    }
}
`,
        "file:///w/test/Helper.sol": `pragma solidity ^0.8.24;
library Helper {
    function encode(address account) internal pure returns (uint256) {
        account;
        return 0;
    }
}
`,
        [currentUri]: current,
      });

      const hints = provider.provideInlayHints(doc, {
        start: { line: 0, character: 0 },
        end: { line: current.split("\n").length, character: 0 },
      });
      const labels = hints.map((h) => h.label);
      assert.ok(
        labels.includes("amount:"),
        `expected "amount:" from imported Helper.encode; got ${JSON.stringify(labels)}`,
      );
      assert.ok(
        !labels.includes("account:"),
        `must not leak params from test/Helper.sol; got ${JSON.stringify(labels)}`,
      );
    });

    it("skips the implicit receiver parameter for using-for library calls", () => {
      const text = `pragma solidity ^0.8.0;
interface IERC20 {}
library SafeERC20 {
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
      const { doc, provider } = setup("file:///w/SafeErc20.sol", text);
      const hints = provider.provideInlayHints(doc, {
        start: { line: 0, character: 0 },
        end: { line: 20, character: 0 },
      });
      const labels = hints.map((h) => h.label);
      assert.ok(
        !labels.includes("token:"),
        `implicit receiver should be skipped; got ${JSON.stringify(labels)}`,
      );
      assert.ok(
        labels.includes("to:"),
        `expected "to:" from SafeERC20.safeTransfer; got ${JSON.stringify(labels)}`,
      );
      assert.ok(
        labels.includes("value:"),
        `expected "value:" from SafeERC20.safeTransfer; got ${JSON.stringify(labels)}`,
      );
    });

    it("resolves using-for parameter hints through imported library aliases", () => {
      const libUri = "file:///w/src/DataLib.sol";
      const currentUri = "file:///w/src/UsesUsingAlias.sol";
      const current = `pragma solidity ^0.8.24;
import {Data, DataLib as RenamedDataLib} from "./DataLib.sol";

contract UsesUsingAlias {
    using RenamedDataLib for Data;
    Data internal data;

    function f(uint256 amount) external {
        data.bump(amount);
    }
}`;
      const { doc, provider } = setupFiles(currentUri, {
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
      });

      const hints = provider.provideInlayHints(doc, {
        start: { line: 0, character: 0 },
        end: { line: current.split("\n").length, character: 0 },
      });
      const labels = hints.map((h) => h.label);
      assert.ok(
        !labels.includes("self:"),
        `implicit receiver should be skipped; got ${JSON.stringify(labels)}`,
      );
      assert.ok(
        labels.includes("value:"),
        `expected "value:" from aliased DataLib.bump; got ${JSON.stringify(labels)}`,
      );
    });

    it("does not emit receiver parameter hints from unimported test-only types", () => {
      const currentUri = "file:///w/src/UsesGhost.sol";
      const current = `pragma solidity ^0.8.24;
contract UsesGhost {
    Ghost internal ghost;

    function f() external view {
        ghost.ping(1);
    }
}`;
      const { doc, provider } = setupFiles(currentUri, {
        "file:///w/test/Ghost.sol": `pragma solidity ^0.8.24;
interface Ghost {
    function ping(uint256 value) external view returns (uint256);
}
`,
        [currentUri]: current,
      });

      const hints = provider.provideInlayHints(doc, {
        start: { line: 0, character: 0 },
        end: { line: current.split("\n").length, character: 0 },
      });
      const labels = hints.map((h) => h.label);
      assert.ok(
        !labels.includes("value:"),
        `must not leak params from test/Ghost.sol; got ${JSON.stringify(labels)}`,
      );
    });

    it("skips the implicit receiver parameter for using-for calls on cast expressions", () => {
      const text = `pragma solidity ^0.8.0;
interface IERC20 {}
library SafeERC20 {
    function safeTransfer(IERC20 token, address to, uint256 value) internal {
        token; to; value;
    }
}
contract C {
    using SafeERC20 for IERC20;

    function f(address token, address recipient, uint256 amount) external {
        IERC20(token).safeTransfer(recipient, amount);
    }
}`;
      const { doc, provider } = setup("file:///w/SafeErc20Cast.sol", text);
      const hints = provider.provideInlayHints(doc, {
        start: { line: 0, character: 0 },
        end: { line: 20, character: 0 },
      });
      const labels = hints.map((h) => h.label);
      assert.ok(
        !labels.includes("token:"),
        `implicit receiver should be skipped; got ${JSON.stringify(labels)}`,
      );
      assert.ok(
        labels.includes("to:"),
        `expected "to:" from SafeERC20.safeTransfer; got ${JSON.stringify(labels)}`,
      );
      assert.ok(
        labels.includes("value:"),
        `expected "value:" from SafeERC20.safeTransfer; got ${JSON.stringify(labels)}`,
      );
    });

    it("skips the implicit receiver parameter for using-for calls on nested cast expressions", () => {
      const text = `pragma solidity ^0.8.0;
interface IERC20 {}
interface Initializer {
    function token() external view returns (address);
}
library SafeERC20 {
    function safeTransfer(IERC20 token, address to, uint256 value) internal {
        token; to; value;
    }
}
contract C {
    using SafeERC20 for IERC20;

    struct MintParams {
        address leftoverRecipient;
    }

    function f(Initializer initializer, MintParams memory mp, uint256 amount) external {
        IERC20(initializer.token()).safeTransfer(mp.leftoverRecipient, amount);
    }
}`;
      const { doc, provider } = setup("file:///w/SafeErc20NestedCast.sol", text);
      const hints = provider.provideInlayHints(doc, {
        start: { line: 0, character: 0 },
        end: { line: 30, character: 0 },
      });
      const labels = hints.map((h) => h.label);
      assert.ok(
        !labels.includes("token:"),
        `implicit receiver should be skipped; got ${JSON.stringify(labels)}`,
      );
      assert.ok(
        labels.includes("to:"),
        `expected "to:" from SafeERC20.safeTransfer; got ${JSON.stringify(labels)}`,
      );
      assert.ok(
        labels.includes("value:"),
        `expected "value:" from SafeERC20.safeTransfer; got ${JSON.stringify(labels)}`,
      );
    });

    it("skips the implicit receiver parameter when whitespace appears after the member dot", () => {
      const text = `pragma solidity ^0.8.0;
interface IERC20 {}
interface Initializer {
    function token() external view returns (address);
}
library SafeERC20 {
    function safeTransfer(IERC20 token, address to, uint256 value) internal {
        token; to; value;
    }
}
contract C {
    using SafeERC20 for IERC20;

    function f(Initializer initializer, address recipient, uint256 amount) external {
        IERC20(initializer.token()). safeTransfer(recipient, amount);
    }
}`;
      const { doc, provider } = setup("file:///w/SafeErc20Whitespace.sol", text);
      const hints = provider.provideInlayHints(doc, {
        start: { line: 0, character: 0 },
        end: { line: 30, character: 0 },
      });
      const labels = hints.map((h) => h.label);
      assert.ok(
        !labels.includes("token:"),
        `implicit receiver should be skipped; got ${JSON.stringify(labels)}`,
      );
      assert.ok(
        labels.includes("to:"),
        `expected "to:" from SafeERC20.safeTransfer; got ${JSON.stringify(labels)}`,
      );
      assert.ok(
        labels.includes("value:"),
        `expected "value:" from SafeERC20.safeTransfer; got ${JSON.stringify(labels)}`,
      );
    });

    it("still emits hints for plain unqualified function calls", () => {
      // Make sure the receiver-aware path doesn't suppress hints for
      // the common case of an in-scope function call with no dot.
      // Note: the body lives on its own lines — putting the call on
      // the same line as `function trigger() {` would hit the
      // pre-existing `isDeclarationLine` skip, which is orthogonal to
      // this fix.
      const text = `pragma solidity ^0.8.0;
contract C {
    function set(address owner, uint256 amount) internal {
        owner; amount;
    }
    function trigger() external {
        set(address(0x1), 42);
    }
}`;
      const { doc, provider } = setup("file:///w/Plain.sol", text);
      const hints = provider.provideInlayHints(doc, {
        start: { line: 0, character: 0 },
        end: { line: 12, character: 0 },
      });
      const labels = hints.map((h) => h.label);
      assert.ok(labels.includes("owner:"), `got ${JSON.stringify(labels)}`);
      assert.ok(labels.includes("amount:"), `got ${JSON.stringify(labels)}`);
    });
  });
});
