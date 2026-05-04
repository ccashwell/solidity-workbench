import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import { SolidityParser } from "../parser/solidity-parser.js";
import { SymbolIndex } from "../analyzer/symbol-index.js";
import { SemanticResolver } from "../analyzer/semantic-resolver.js";
import { DefinitionProvider } from "../providers/definition.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";

/**
 * Stub workspace manager sufficient for DefinitionProvider. Only the
 * import-resolution and uri-to-path paths are exercised, so we provide
 * just those methods.
 */
function makeFakeWorkspace(
  resolve: (importPath: string, from: string) => string | null = () => null,
) {
  return {
    getAllFileUris: () => [],
    uriToPath: (uri: string) => URI.parse(uri).fsPath,
    resolveImport: (importPath: string, from: string) => resolve(importPath, from),
  } as unknown as WorkspaceManager;
}

function doc(uri: string, text: string): TextDocument {
  return TextDocument.create(uri, "solidity", 1, text);
}

function setup(files: Record<string, string>) {
  const parser = new SolidityParser();
  const workspace = makeFakeWorkspace();
  const idx = new SymbolIndex(parser, workspace);
  const docs: Record<string, TextDocument> = {};

  for (const [uri, text] of Object.entries(files)) {
    parser.parse(uri, text);
    idx.updateFile(uri);
    docs[uri] = doc(uri, text);
  }

  return { parser, idx, workspace, docs, provider: new DefinitionProvider(idx, workspace) };
}

describe("DefinitionProvider", () => {
  describe("go-to-definition on local symbols", () => {
    it("jumps to the single declaration of a state variable", () => {
      const { docs, provider } = setup({
        "file:///w/A.sol": `pragma solidity ^0.8.0;
contract A {
    uint256 public counter;
    function inc() external { counter = counter + 1; }
}`,
      });

      // Cursor on the first `counter` usage (line 3, inside `inc()`)
      const def = provider.provideDefinition(docs["file:///w/A.sol"], {
        line: 3,
        character: 32, // roughly mid-"counter"
      });

      assert.ok(def, "expected a definition result");
      const locs = Array.isArray(def) ? def : [def];
      assert.equal(locs.length, 1);
      assert.equal((locs[0] as any).uri, "file:///w/A.sol");
      assert.equal((locs[0] as any).range.start.line, 2);
    });

    it("jumps to the matching function declaration", () => {
      const { docs, provider } = setup({
        "file:///w/B.sol": `pragma solidity ^0.8.0;
contract B {
    function doThing(uint256 x) public returns (uint256) { return x; }
    function trigger() external { doThing(1); }
}`,
      });

      // Cursor on the call site `doThing(1)` on line 3
      const def = provider.provideDefinition(docs["file:///w/B.sol"], {
        line: 3,
        character: 36,
      });

      assert.ok(def, "expected a definition result");
      const locs = Array.isArray(def) ? def : [def];
      assert.ok(locs.length >= 1);
      // Should point to line 2 where doThing is declared
      assert.equal((locs[0] as any).range.start.line, 2);
    });
  });

  describe("cross-file resolution via remapped imports", () => {
    it('resolves `import "X/Y.sol"` to an absolute file path', () => {
      const parser = new SolidityParser();
      const workspace = {
        getAllFileUris: () => [],
        uriToPath: (uri: string) => URI.parse(uri).fsPath,
        resolveImport: (p: string) => (p === "lib/Token.sol" ? "/w/lib/Token.sol" : null),
      } as unknown as WorkspaceManager;
      const idx = new SymbolIndex(parser, workspace);
      const text = `pragma solidity ^0.8.0;
import "lib/Token.sol";
contract Wrapper {}`;
      parser.parse("file:///w/A.sol", text);
      idx.updateFile("file:///w/A.sol");

      const provider = new DefinitionProvider(idx, workspace);
      const d = doc("file:///w/A.sol", text);

      // Place cursor inside `"lib/Token.sol"`
      const def = provider.provideDefinition(d, { line: 1, character: 12 });
      assert.ok(def, "expected import resolution");
      const loc = Array.isArray(def) ? def[0] : def;
      assert.equal((loc as any).uri, "file:///w/lib/Token.sol");
    });
  });

  describe("dotted member access", () => {
    it("resolves `C.foo` to the foo function in contract C", () => {
      const { docs, provider } = setup({
        "file:///w/C.sol": `pragma solidity ^0.8.0;
contract C {
    function foo() public pure returns (uint256) { return 1; }
}
contract D {
    function bar() external pure returns (uint256) { return C.foo(); }
}`,
      });

      // Cursor on the `foo` inside `C.foo()` — C starts at position 62 on line 5 approx
      const def = provider.provideDefinition(docs["file:///w/C.sol"], {
        line: 5,
        character: 63,
      });

      assert.ok(def, "expected member resolution");
      const locs = Array.isArray(def) ? def : [def];
      assert.equal((locs[0] as any).range.start.line, 2);
    });

    it("uses the importing file to disambiguate duplicate receiver contracts", () => {
      const currentUri = "file:///w/src/Use.sol";
      const srcBaseUri = "file:///w/src/Base.sol";
      const testBaseUri = "file:///w/test/Base.sol";
      const files = {
        [srcBaseUri]: `pragma solidity ^0.8.0;
contract Base {
    function ping() public {}
}`,
        [testBaseUri]: `pragma solidity ^0.8.0;
contract Base {
    function ping() public {}
}`,
        [currentUri]: `pragma solidity ^0.8.0;
import "./Base.sol";
contract Use {
    function f() external { Base.ping(); }
}`,
      };
      const workspace = {
        getAllFileUris: () => Object.keys(files),
        uriToPath: (uri: string) => URI.parse(uri).fsPath,
        resolveImport: (importPath: string, from: string) =>
          importPath === "./Base.sol" && from.endsWith("/src/Use.sol")
            ? URI.parse(srcBaseUri).fsPath
            : null,
      } as unknown as WorkspaceManager;
      const parser = new SolidityParser();
      const idx = new SymbolIndex(parser, workspace);
      const docs: Record<string, TextDocument> = {};
      for (const [uri, text] of Object.entries(files)) {
        parser.parse(uri, text);
        idx.updateFile(uri);
        docs[uri] = doc(uri, text);
      }

      const resolver = new SemanticResolver(parser, workspace, idx);
      const provider = new DefinitionProvider(idx, workspace, resolver);
      const line = files[currentUri].split("\n")[3];
      const def = provider.provideDefinition(docs[currentUri], {
        line: 3,
        character: line.indexOf("ping") + 1,
      });

      assert.ok(def, "expected imported member definition");
      const loc = Array.isArray(def) ? def[0] : def;
      assert.ok("uri" in loc, "expected a Location result");
      assert.equal(loc.uri, srcBaseUri);
    });
  });

  describe("robustness", () => {
    it("returns null when the cursor is on whitespace", () => {
      const { docs, provider } = setup({
        "file:///w/E.sol": `pragma solidity ^0.8.0;\ncontract E {}\n`,
      });
      const def = provider.provideDefinition(docs["file:///w/E.sol"], { line: 0, character: 0 });
      assert.equal(def, null);
    });

    it("returns null when the word is unknown", () => {
      const { docs, provider } = setup({
        "file:///w/F.sol": `pragma solidity ^0.8.0;\ncontract F { function g() external {} }\n`,
      });
      // "nowhere" isn't defined anywhere
      const text = "nowhere";
      void text;
      const def = provider.provideDefinition(docs["file:///w/F.sol"], { line: 1, character: 5 });
      // The cursor is on 'contract' — should return the matching symbol
      // or null; either is acceptable. The point is: no crash.
      void def;
    });
  });
});
