import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { CompletionItemKind } from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import { SolidityParser } from "../parser/solidity-parser.js";
import { SymbolIndex } from "../analyzer/symbol-index.js";
import { SemanticResolver } from "../analyzer/semantic-resolver.js";
import { CompletionProvider } from "../providers/completion.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";

function makeFakeWorkspace() {
  return {
    getAllFileUris: () => [],
    uriToPath: (uri: string) => URI.parse(uri).fsPath,
    getRemappings: () => [
      { prefix: "forge-std/", path: "/project/lib/forge-std/src/" },
      { prefix: "@oz/", path: "/project/lib/openzeppelin-contracts/contracts/" },
    ],
  } as unknown as WorkspaceManager;
}

function setup(uri: string, text: string) {
  const parser = new SolidityParser();
  const idx = new SymbolIndex(parser, makeFakeWorkspace());
  parser.parse(uri, text);
  idx.updateFile(uri);
  return {
    doc: TextDocument.create(uri, "solidity", 1, text),
    provider: new CompletionProvider(idx, parser, makeFakeWorkspace()),
  };
}

function setupFiles(currentUri: string, files: Record<string, string>) {
  const uris = Object.keys(files);
  const workspace = makeWorkspace(uris);
  const parser = new SolidityParser();
  const idx = new SymbolIndex(parser, workspace);
  for (const [uri, text] of Object.entries(files)) {
    parser.parse(uri, text);
    idx.updateFile(uri);
  }
  const resolver = new SemanticResolver(parser, workspace, idx);
  return {
    doc: TextDocument.create(currentUri, "solidity", 1, files[currentUri]),
    provider: new CompletionProvider(idx, parser, workspace, resolver),
  };
}

function makeWorkspace(uris: string[]): WorkspaceManager {
  return {
    getAllFileUris: () => uris.slice(),
    uriToPath: (uri: string) => URI.parse(uri).fsPath,
    resolveImport: (importPath: string, fromFile: string) => {
      const from = URI.file(fromFile);
      const fromPath = from.fsPath;
      const slash = fromPath.lastIndexOf("/");
      const base = slash >= 0 ? fromPath.slice(0, slash + 1) : "";
      const normalized = new URL(importPath, URI.file(base).toString()).toString();
      return uris.includes(normalized) ? URI.parse(normalized).fsPath : null;
    },
    getRemappings: () => [],
  } as unknown as WorkspaceManager;
}

function labels(items: { label: string }[]): Set<string> {
  return new Set(items.map((i) => i.label));
}

describe("CompletionProvider", () => {
  describe("keyword + type completions (default context)", () => {
    it("includes common Solidity keywords and value types", () => {
      const text = `pragma solidity ^0.8.0;
contract A { function f() external { \n    } }`;
      const { doc, provider } = setup("file:///w/A.sol", text);

      // Cursor on the empty body line (line 2).
      const items = provider.provideCompletions(doc, { line: 2, character: 4 });
      const ls = labels(items);

      // Keywords
      for (const kw of ["if", "else", "for", "while", "require", "emit"]) {
        assert.ok(ls.has(kw), `expected keyword '${kw}' in completions`);
      }

      // Types
      for (const ty of ["uint256", "address", "bool", "bytes32"]) {
        assert.ok(ls.has(ty), `expected type '${ty}' in completions`);
      }
    });

    it("includes user-defined symbols from the current file", () => {
      const text = `pragma solidity ^0.8.0;
contract Widget {
    uint256 public size;
    function resize() external {}
}
contract Gadget {
    function use() external {
        \n    }
}`;
      const { doc, provider } = setup("file:///w/Widget.sol", text);
      const items = provider.provideCompletions(doc, { line: 7, character: 4 });
      const ls = labels(items);

      // User-defined contracts appear as type completions.
      assert.ok(ls.has("Widget"));
      assert.ok(ls.has("Gadget"));
    });

    it("includes imported file-level declarations without leaking imported contract members", () => {
      const files = {
        "file:///w/Events.sol": `pragma solidity ^0.8.24;
/// @notice Emitted when claims are redeemed.
event FileClaimed(address indexed account);
function globalHelper() pure returns (uint256) { return 1; }
contract Imported {
    function memberOnly() external {}
}
`,
        "file:///w/User.sol": `pragma solidity ^0.8.24;
import "./Events.sol";
contract User {
    function run() external {
        emit FileClaimed(address(0));
    }
}`,
      };
      const { doc, provider } = setupFiles("file:///w/User.sol", files);
      const items = provider.provideCompletions(doc, { line: 4, character: 13 });
      const ls = labels(items);

      assert.ok(ls.has("FileClaimed"), "expected imported file-level event completion");
      assert.ok(ls.has("globalHelper"), "expected imported file-level function completion");
      assert.ok(ls.has("Imported"), "expected imported contract/type completion");
      assert.equal(
        ls.has("memberOnly"),
        false,
        "imported contract members should not become unqualified completions",
      );

      const eventItem = items.find((item) => item.label === "FileClaimed");
      assert.equal(eventItem?.kind, CompletionItemKind.Event);
      const resolved = provider.resolveCompletion({ ...eventItem! });
      assert.ok(
        resolved.documentation && typeof resolved.documentation !== "string",
        "expected markdown documentation for imported event completion",
      );
      assert.match(resolved.documentation.value, /claims are redeemed/);
    });

    it("does not offer unreachable test-only types in general completions", () => {
      const currentUri = "file:///w/src/User.sol";
      const files = {
        "file:///w/src/Types.sol": `pragma solidity ^0.8.24;
contract ProductionVault {}
struct ProductionParams {
    uint256 amount;
}
`,
        "file:///w/test/Mocks.sol": `pragma solidity ^0.8.24;
contract MockVault {}
struct MockParams {
    address account;
}
`,
        [currentUri]: `pragma solidity ^0.8.24;
import {ProductionVault, ProductionParams} from "./Types.sol";

contract User {
    function run() external {

    }
}`,
      };
      const { doc, provider } = setupFiles(currentUri, files);
      const items = provider.provideCompletions(doc, { line: 5, character: 8 });
      const ls = labels(items);

      assert.ok(ls.has("ProductionVault"), "expected imported production contract");
      assert.ok(ls.has("ProductionParams"), "expected imported production struct");
      assert.equal(ls.has("MockVault"), false, "unreachable test contract should not complete");
      assert.equal(ls.has("MockParams"), false, "unreachable test struct should not complete");
    });

    it("includes the Foundry test snippets", () => {
      const { doc, provider } = setup(
        "file:///w/X.t.sol",
        `pragma solidity ^0.8.0;
contract XTest { \n }`,
      );
      const items = provider.provideCompletions(doc, { line: 1, character: 16 });
      const ls = labels(items);
      assert.ok(ls.has("test"), "expected `test` snippet");
      assert.ok(ls.has("testFuzz"), "expected `testFuzz` snippet");
      assert.ok(ls.has("setUp"), "expected `setUp` snippet");
    });
  });

  describe("NatSpec context", () => {
    it("offers NatSpec tags inside a /// line", () => {
      const text = `pragma solidity ^0.8.0;
/// \ncontract A {}`;
      const { doc, provider } = setup("file:///w/B.sol", text);
      // Cursor after the "/// " on line 1.
      const items = provider.provideCompletions(doc, { line: 1, character: 4 });
      const ls = labels(items);
      assert.ok(ls.has("@notice"));
      assert.ok(ls.has("@param"));
      assert.ok(ls.has("@return"));
      assert.ok(ls.has("@dev"));
    });
  });

  describe("import path context", () => {
    it("suggests remappings prefixes when the cursor is inside an import string", () => {
      const text = `import "";\ncontract A {}`;
      const { doc, provider } = setup("file:///w/C.sol", text);
      const items = provider.provideCompletions(doc, { line: 0, character: 8 });
      const ls = labels(items);
      assert.ok(ls.has("forge-std/"), "expected forge-std/ remapping");
      assert.ok(ls.has("@oz/"), "expected @oz/ remapping");
    });

    it("does not suggest test contracts in source-file import completions", () => {
      const currentUri = "file:///w/src/App.sol";
      const files = {
        "file:///w/src/ProductionVault.sol": `pragma solidity ^0.8.24;
contract ProductionVault {}
`,
        "file:///w/test/MockVault.sol": `pragma solidity ^0.8.24;
contract MockVault {}
`,
        [currentUri]: `pragma solidity ^0.8.24;
import "";
contract App {}
`,
      };
      const { doc, provider } = setupFiles(currentUri, files);
      const items = provider.provideCompletions(doc, { line: 1, character: 8 });
      const ls = labels(items);

      assert.ok(ls.has("ProductionVault"), "expected source contract import completion");
      assert.equal(ls.has("MockVault"), false, "source imports must not suggest test contracts");
    });

    it("allows test contracts in test-file import completions", () => {
      const currentUri = "file:///w/test/App.t.sol";
      const files = {
        "file:///w/test/MockVault.sol": `pragma solidity ^0.8.24;
contract MockVault {}
`,
        [currentUri]: `pragma solidity ^0.8.24;
import "";
contract AppTest {}
`,
      };
      const { doc, provider } = setupFiles(currentUri, files);
      const items = provider.provideCompletions(doc, { line: 1, character: 8 });
      const ls = labels(items);

      assert.ok(ls.has("MockVault"), "test imports should suggest test contracts");
    });
  });

  describe("member access context", () => {
    it("returns msg members for `msg.`", () => {
      const text = `contract A { function f() external view { \n msg. } }`;
      const { doc, provider } = setup("file:///w/D.sol", text);
      // Cursor immediately after `msg.` on line 1 (col 5).
      const items = provider.provideCompletions(doc, { line: 1, character: 5 });
      const ls = labels(items);
      assert.ok(ls.has("sender"));
      assert.ok(ls.has("value"));
      assert.ok(ls.has("data"));
      assert.ok(ls.has("sig"));
    });

    it("returns abi members for `abi.`", () => {
      const text = `contract A { function f() external { \n abi. } }`;
      const { doc, provider } = setup("file:///w/E.sol", text);
      const items = provider.provideCompletions(doc, { line: 1, character: 5 });
      const ls = labels(items);
      assert.ok(ls.has("encode"));
      assert.ok(ls.has("decode"));
      assert.ok(ls.has("encodeWithSelector"));
      assert.ok(ls.has("encodeCall"));
    });

    it("returns address members for variables declared as address", () => {
      const text = `pragma solidity ^0.8.0;
contract A {
    function f(address owner) external view returns (uint256) {
        return owner.balance;
    }
}`;
      const { doc, provider } = setup("file:///w/AddressMembers.sol", text);
      const items = provider.provideCompletions(doc, { line: 3, character: 21 });
      const ls = labels(items);
      assert.ok(ls.has("balance"), "address-typed receiver should expose balance");
      assert.ok(ls.has("call"), "address-typed receiver should expose call");
    });

    it("does not infer address members from variable names alone", () => {
      const text = `pragma solidity ^0.8.0;
contract A {
    function f(uint256 owner) external pure returns (uint256) {
        return owner.balance;
    }
}`;
      const { doc, provider } = setup("file:///w/NotAddressMembers.sol", text);
      const items = provider.provideCompletions(doc, { line: 3, character: 21 });
      const ls = labels(items);
      assert.equal(ls.has("balance"), false, "uint256 named owner must not expose address members");
      assert.equal(ls.has("call"), false, "uint256 named owner must not expose address members");
    });

    it("returns a contract's public members for a static `Contract.` lookup", () => {
      // The file is syntactically valid; the user is simply asking for
      // completions immediately after the dot in `Bank.deposit`. The
      // provider reads the *textBefore* slice, so what comes after the
      // cursor is irrelevant — we only need `Bank.` (with a valid
      // surrounding expression) on the line the cursor sits on.
      const text = `pragma solidity ^0.8.0;
contract Bank {
    uint256 public deposit;
    function withdraw() external {}
    function _internal() private {}
}
contract User {
    function f() external view returns (uint256) {
        return Bank.deposit;
    }
}`;
      const { doc, provider } = setup("file:///w/F.sol", text);
      // `        return Bank.deposit;` — "Bank." starts at col 15, dot
      // at col 19; cursor at col 20 is immediately after the dot.
      const items = provider.provideCompletions(doc, { line: 8, character: 20 });
      const ls = labels(items);
      assert.ok(ls.has("deposit"), "public state var should appear");
      assert.ok(ls.has("withdraw"), "external function should appear");
      assert.ok(!ls.has("_internal"), "private function should NOT appear");
    });

    it("returns struct members for a variable of a file-level struct type", () => {
      const text = `pragma solidity ^0.8.24;
struct Params {
    uint256 spacing;
}
contract C {
    function f(Params memory p) external pure returns (uint256) {
        return p.spacing;
    }
}`;
      const { doc, provider } = setup("file:///w/FileStruct.sol", text);
      const lines = text.split("\n");
      const line = lines.findIndex((l) => l.includes("p.spacing"));
      const col = lines[line].indexOf("p.") + 2;
      const items = provider.provideCompletions(doc, { line, character: col });
      const ls = labels(items);
      assert.ok(ls.has("spacing"), "file-level struct member should complete on typed variable");
    });

    it("returns contract members after an explicit type cast", () => {
      const text = `pragma solidity ^0.8.0;
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
}
contract User {
    function f(address token) external {
        IERC20(token).
    }
}`;
      const { doc, provider } = setup("file:///w/Cast.sol", text);
      const items = provider.provideCompletions(doc, { line: 6, character: 22 });
      const ls = labels(items);
      assert.ok(ls.has("transfer"), "cast receiver should expose IERC20.transfer");
    });

    it("resolves member completions through import aliases and namespace-qualified structs", () => {
      const targetUri = "file:///w/src/Target.sol";
      const typesUri = "file:///w/src/Types.sol";
      const currentUri = "file:///w/src/UsesAliases.sol";
      const current = `pragma solidity ^0.8.24;
import {Target as RenamedTarget} from "./Target.sol";
import {Box as RenamedBox, IChild as ChildVault} from "./Types.sol";
import * as TypeNS from "./Types.sol";

contract UsesAliases {
    RenamedTarget public direct;
    RenamedBox internal box;
    TypeNS.Box internal namespacedBox;

    function f() external view {
        direct.ping(1);
        box.vault;
        namespacedBox.vault;
        box.vault.preview(1);
        namespacedBox.vault.preview(1);
    }
}`;
      const { doc, provider } = setupFiles(currentUri, {
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
      });

      const lines = current.split("\n");
      const completionsAfter = (needle: string) => {
        const line = lines.findIndex((candidate) => candidate.includes(needle));
        const character = lines[line].indexOf(needle) + needle.length;
        return labels(provider.provideCompletions(doc, { line, character }));
      };

      assert.ok(
        completionsAfter("direct.").has("ping"),
        "renamed contract-typed receiver should expose Target.ping",
      );
      assert.ok(
        completionsAfter("box.").has("vault"),
        "renamed struct-typed receiver should expose Box.vault",
      );
      assert.ok(
        completionsAfter("namespacedBox.").has("vault"),
        "namespace-qualified struct receiver should expose Box.vault",
      );
      assert.ok(
        completionsAfter("box.vault.").has("preview"),
        "struct member receiver should resolve inherited interface members",
      );
      assert.ok(
        completionsAfter("namespacedBox.vault.").has("preview"),
        "namespace-qualified struct member receiver should resolve inherited interface members",
      );
    });

    it("resolves member completion docs from the selected declaration file", () => {
      const currentUri = "file:///w/src/Pool.sol";
      const current = `pragma solidity ^0.8.24;
import {IVault as RenamedVault} from "./IVault.sol";

contract Pool {
    RenamedVault internal vault;

    function f() external view {
        vault.convertToAssets(1);
    }
}`;
      const { doc, provider } = setupFiles(currentUri, {
        "file:///w/test/IVault.sol": `pragma solidity ^0.8.24;
interface IVault {
    /// @notice Test-only conversion docs.
    function convertToAssets(uint256 shares) external view returns (uint256 assets);
}
`,
        "file:///w/src/IVault.sol": `pragma solidity ^0.8.24;
interface IVault {
    /// @notice Source conversion docs.
    function convertToAssets(uint256 shares) external view returns (uint256 assets);
}
`,
        [currentUri]: current,
      });

      const lines = current.split("\n");
      const line = lines.findIndex((candidate) => candidate.includes("vault.convertToAssets"));
      const character = lines[line].indexOf("vault.") + "vault.".length;
      const items = provider.provideCompletions(doc, { line, character });
      const item = items.find((candidate) => candidate.label === "convertToAssets");
      assert.ok(item, "expected convertToAssets member completion");

      const resolved = provider.resolveCompletion({ ...item });
      assert.ok(
        resolved.documentation && typeof resolved.documentation !== "string",
        "expected markdown documentation on resolved member completion",
      );
      assert.match(resolved.documentation.value, /Source conversion docs/);
      assert.doesNotMatch(resolved.documentation.value, /Test-only conversion docs/);
    });

    it("does not resolve member completions from unimported test-only receiver types", () => {
      const currentUri = "file:///w/src/UsesGhost.sol";
      const current = `pragma solidity ^0.8.24;
contract UsesGhost {
    Ghost internal ghost;

    function f() external view {
        ghost.ping();
    }
}`;
      const { doc, provider } = setupFiles(currentUri, {
        "file:///w/test/Ghost.sol": `pragma solidity ^0.8.24;
interface Ghost {
    function ping() external view returns (uint256);
}
`,
        [currentUri]: current,
      });

      const lines = current.split("\n");
      const line = lines.findIndex((candidate) => candidate.includes("ghost.ping"));
      const character = lines[line].indexOf("ghost.") + "ghost.".length;
      const ls = labels(provider.provideCompletions(doc, { line, character }));

      assert.equal(ls.has("ping"), false, "unimported test-only receiver must not complete");
    });

    it("resolves using-for completions through imported library aliases", () => {
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

      const lines = current.split("\n");
      const line = lines.findIndex((candidate) => candidate.includes("data.bump"));
      const character = lines[line].indexOf("data.") + "data.".length;
      const ls = labels(provider.provideCompletions(doc, { line, character }));
      assert.ok(
        ls.has("bump"),
        "aliased using-for library should contribute extension-method completions",
      );
    });
  });
});
