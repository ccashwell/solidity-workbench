import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import { SolidityParser } from "../parser/solidity-parser.js";
import { SymbolIndex } from "../analyzer/symbol-index.js";
import { SignatureHelpProvider } from "../providers/signature-help.js";
import { SemanticResolver } from "../analyzer/semantic-resolver.js";
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
    provider: new SignatureHelpProvider(idx, parser),
  };
}

function setupFiles(files: Record<string, string>) {
  const parser = new SolidityParser();
  const filePaths = new Set(Object.keys(files).map((name) => path.join("/w", name)));
  const uris = Object.keys(files).map((name) => URI.file(path.join("/w", name)).toString());
  const workspace = {
    getAllFileUris: () => uris.slice(),
    uriToPath: (uri: string) => URI.parse(uri).fsPath,
    resolveImport: (importPath: string, fromFile: string) => {
      const target = path.resolve(path.dirname(fromFile), importPath);
      return filePaths.has(target) ? target : null;
    },
  } as unknown as WorkspaceManager;
  const idx = new SymbolIndex(parser, workspace);
  const docs: Record<string, TextDocument> = {};

  for (const [name, text] of Object.entries(files)) {
    const uri = URI.file(path.join("/w", name)).toString();
    parser.parse(uri, text);
    idx.updateFile(uri);
    docs[name] = TextDocument.create(uri, "solidity", 1, text);
  }

  const resolver = new SemanticResolver(parser, workspace, idx);
  return {
    docs,
    provider: new SignatureHelpProvider(idx, parser, resolver),
  };
}

describe("SignatureHelpProvider", () => {
  describe("built-in functions", () => {
    it("returns a signature for `require(` open paren", () => {
      const text = `pragma solidity ^0.8.0;
contract A {
    function f() external pure { require( }
}`;
      const { doc, provider } = setup("file:///w/A.sol", text);
      // Position cursor right after the `(` in require(
      // line 2, col ... find position of "(" after require
      const line = text.split("\n")[2];
      const openParen = line.indexOf("require(") + "require(".length;
      const sig = provider.provideSignatureHelp(doc, { line: 2, character: openParen });
      assert.ok(sig, "expected signature help");
      assert.equal(sig!.signatures.length, 1);
      assert.match(sig!.signatures[0].label, /require/);
      assert.equal(sig!.activeParameter, 0);
    });

    it("advances activeParameter on each comma", () => {
      const text = `pragma solidity ^0.8.0;
contract B {
    function f(bytes32 h) external pure { ecrecover(h, 27, h, }
}`;
      const { doc, provider } = setup("file:///w/B.sol", text);
      const line = text.split("\n")[2];
      // Cursor right after the third comma in ecrecover
      const afterThirdComma = line.indexOf("h, }");
      const sig = provider.provideSignatureHelp(doc, { line: 2, character: afterThirdComma + 2 });
      assert.ok(sig);
      assert.match(sig!.signatures[0].label, /ecrecover/);
      // ecrecover(hash, v, r, s) — after 3 commas we should be on param 3
      assert.equal(sig!.activeParameter, 3);
    });
  });

  describe("user-defined functions", () => {
    it("returns the user function signature with types", () => {
      // Uses a COMPLETE source (closed parens) so the parser's tolerant
      // mode registers the `transfer` declaration even while the cursor
      // sits between `(` and `)` conceptually. We place the cursor
      // one char past the open paren on the call line.
      const text = `pragma solidity ^0.8.0;
contract C {
    function transfer(address to, uint256 amount) public returns (bool) {
        to; amount;
        return true;
    }
    function trigger() external {
        transfer(address(0), 100);
    }
}`;
      const { doc, provider } = setup("file:///w/C.sol", text);
      const lines = text.split("\n");
      const callLine = lines.findIndex(
        (l, i) => i > 2 /* skip the declaration */ && l.includes("transfer("),
      );
      assert.ok(callLine > 2, "expected a post-declaration call line");
      const col = lines[callLine].indexOf("transfer(") + "transfer(".length;

      const sig = provider.provideSignatureHelp(doc, { line: callLine, character: col });
      assert.ok(sig, "expected signature help");
      assert.ok(sig!.signatures.length >= 1);
      const label = sig!.signatures[0].label;
      assert.match(label, /transfer\(/);
      assert.match(label, /address to/);
      assert.match(label, /uint256 amount/);
    });

    it("returns signatures for file-level free functions", () => {
      const text = `pragma solidity ^0.8.24;
function add(uint256 a, uint256 b) pure returns (uint256) {
    return a + b;
}
contract C {
    function f() external pure {
        add(1, 2);
    }
}`;
      const { doc, provider } = setup("file:///w/FreeFnSig.sol", text);
      const lines = text.split("\n");
      const callLine = lines.findIndex((l) => l.includes("add(1"));
      const col = lines[callLine].indexOf("add(") + "add(".length;
      const sig = provider.provideSignatureHelp(doc, { line: callLine, character: col });
      assert.ok(sig, "expected signature help for free function");
      assert.match(sig!.signatures[0].label, /add\(uint256 a, uint256 b\)/);
    });

    it("returns signatures for file-level events", () => {
      const text = `pragma solidity ^0.8.24;
event FileClaimed(address indexed account, uint256 amount);

contract C {
    function f() external {
        emit FileClaimed(address(0), 1);
    }
}`;
      const { doc, provider } = setup("file:///w/FileEventSig.sol", text);
      const lines = text.split("\n");
      const callLine = lines.findIndex((l) => l.includes("FileClaimed(address"));
      const col = lines[callLine].indexOf("FileClaimed(") + "FileClaimed(".length;
      const sig = provider.provideSignatureHelp(doc, { line: callLine, character: col });
      assert.ok(sig, "expected signature help for file-level event");
      assert.match(
        sig!.signatures[0].label,
        /event FileClaimed\(address indexed account, uint256 amount\)/,
      );
    });

    it("resolves receiver variables declared with imported interface aliases", () => {
      const files = {
        "src/IVault.sol": `pragma solidity ^0.8.24;
interface IVault {
    function convertToAssets(uint256 shares) external view returns (uint256 assets);
}`,
        "test/IVault.sol": `pragma solidity ^0.8.24;
interface IVault {
    function convertToAssets(address account) external view returns (uint256 assets);
}`,
        "src/Pool.sol": `pragma solidity ^0.8.24;
import { IVault as RenamedVault } from "./IVault.sol";
contract Pool {
    function f(RenamedVault vault, uint256 shares) external view {
        vault.convertToAssets(shares);
    }
}`,
      };
      const { docs, provider } = setupFiles(files);
      const text = files["src/Pool.sol"];
      const lines = text.split("\n");
      const callLine = lines.findIndex((line) => line.includes("convertToAssets"));
      const col = lines[callLine].indexOf("convertToAssets(") + "convertToAssets(".length;
      const sig = provider.provideSignatureHelp(docs["src/Pool.sol"], {
        line: callLine,
        character: col,
      });

      assert.ok(sig, "expected signature help for aliased receiver type");
      assert.equal(sig!.signatures.length, 1);
      assert.match(sig!.signatures[0].label, /convertToAssets\(uint256 shares\)/);
    });
  });

  describe("robustness", () => {
    it("returns null when the cursor isn't inside any call", () => {
      const text = `pragma solidity ^0.8.0;
contract D { function f() external {} }`;
      const { doc, provider } = setup("file:///w/D.sol", text);
      const sig = provider.provideSignatureHelp(doc, { line: 1, character: 0 });
      assert.equal(sig, null);
    });
  });
});
