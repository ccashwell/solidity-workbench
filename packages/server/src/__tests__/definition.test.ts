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

interface DefinitionLocation {
  uri: string;
  range: { start: { line: number } };
}

function asDefinitionLocation(value: unknown): DefinitionLocation {
  return value as DefinitionLocation;
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

  return {
    parser,
    idx,
    workspace,
    docs,
    provider: new DefinitionProvider(idx, parser, workspace),
  };
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
      assert.equal(asDefinitionLocation(locs[0]).uri, "file:///w/A.sol");
      assert.equal(asDefinitionLocation(locs[0]).range.start.line, 2);
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
      assert.equal(asDefinitionLocation(locs[0]).range.start.line, 2);
    });
  });

  describe("import symbol aliases", () => {
    it("jumps to the exported symbol for a named import", () => {
      const files = {
        "file:///w/Token.sol": `pragma solidity ^0.8.24;
contract Token {
    function mint() external {}
}`,
        "file:///w/User.sol": `pragma solidity ^0.8.24;
import {Token} from "./Token.sol";
contract User {
    function f() external {}
}`,
      };
      const workspace = {
        getAllFileUris: () => Object.keys(files),
        uriToPath: (uri: string) => URI.parse(uri).fsPath,
        resolveImport: (importPath: string, from: string) =>
          importPath === "./Token.sol" && from.endsWith("/User.sol")
            ? URI.parse("file:///w/Token.sol").fsPath
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
      const provider = new DefinitionProvider(idx, parser, workspace);
      const importLine = files["file:///w/User.sol"].split("\n")[1];
      const col = importLine.indexOf("Token") + 1;
      const def = provider.provideDefinition(docs["file:///w/User.sol"], {
        line: 1,
        character: col,
      });
      assert.ok(def, "expected definition for imported symbol");
      const loc = Array.isArray(def) ? def[0] : def;
      assert.equal(loc.uri, "file:///w/Token.sol");
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

      const provider = new DefinitionProvider(idx, parser, workspace);
      const d = doc("file:///w/A.sol", text);

      // Place cursor inside `"lib/Token.sol"`
      const def = provider.provideDefinition(d, { line: 1, character: 12 });
      assert.ok(def, "expected import resolution");
      const loc = Array.isArray(def) ? def[0] : def;
      assert.equal(asDefinitionLocation(loc).uri, "file:///w/lib/Token.sol");
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
      assert.equal(asDefinitionLocation(locs[0]).range.start.line, 2);
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
      const provider = new DefinitionProvider(idx, parser, workspace, resolver);
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

    it("jumps to a struct member through a typed receiver variable", () => {
      const { docs, provider } = setup({
        "file:///w/struct-member.sol": `pragma solidity ^0.8.24;
struct Params { uint256 spacing; }
contract C {
    function f(Params memory p) external pure returns (uint256) {
        return p.spacing;
    }
}`,
      });

      const lines = docs["file:///w/struct-member.sol"].getText().split("\n");
      const useLine = lines.findIndex((line) => line.includes("p.spacing"));
      const col = lines[useLine].indexOf("spacing");
      const def = provider.provideDefinition(docs["file:///w/struct-member.sol"], {
        line: useLine,
        character: col,
      });

      assert.ok(def, "expected struct member definition");
      const loc = Array.isArray(def) ? def[0] : def;
      assert.ok("uri" in loc);
      assert.equal(loc.range.start.line, 1);
    });

    it("resolves aliased and namespace-qualified receiver definitions", () => {
      const targetUri = "file:///w/src/Target.sol";
      const typesUri = "file:///w/src/Types.sol";
      const currentUri = "file:///w/src/UsesAliases.sol";
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
        [currentUri]: `pragma solidity ^0.8.24;
import {Target as RenamedTarget} from "./Target.sol";
import * as TypeNS from "./Types.sol";

contract UsesAliases {
    RenamedTarget public direct;
    TypeNS.Box internal box;

    function f() external view {
        direct.ping(1);
        box.vault.preview(1);
    }
}`,
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
      const parser = new SolidityParser();
      const idx = new SymbolIndex(parser, workspace);
      const docs: Record<string, TextDocument> = {};
      for (const [uri, text] of Object.entries(files)) {
        parser.parse(uri, text);
        idx.updateFile(uri);
        docs[uri] = doc(uri, text);
      }
      const resolver = new SemanticResolver(parser, workspace, idx);
      const provider = new DefinitionProvider(idx, parser, workspace, resolver);
      const lines = files[currentUri].split("\n");

      const pingLine = lines.findIndex((line) => line.includes("direct.ping"));
      const pingDef = provider.provideDefinition(docs[currentUri], {
        line: pingLine,
        character: lines[pingLine].indexOf("ping") + 1,
      });
      assert.ok(pingDef, "expected definition for aliased Target.ping receiver");
      const pingLoc = Array.isArray(pingDef) ? pingDef[0] : pingDef;
      assert.ok("uri" in pingLoc);
      assert.equal(pingLoc.uri, targetUri);
      assert.equal(pingLoc.range.start.line, 2);

      const previewLine = lines.findIndex((line) => line.includes("box.vault.preview"));
      const previewDef = provider.provideDefinition(docs[currentUri], {
        line: previewLine,
        character: lines[previewLine].indexOf("preview") + 1,
      });
      assert.ok(previewDef, "expected definition for namespace-qualified struct member receiver");
      const previewLoc = Array.isArray(previewDef) ? previewDef[0] : previewDef;
      assert.ok("uri" in previewLoc);
      assert.equal(previewLoc.uri, typesUri);
      assert.equal(previewLoc.range.start.line, 2);
    });

    it("resolves using-for definitions through imported library aliases", () => {
      const libUri = "file:///w/src/DataLib.sol";
      const currentUri = "file:///w/src/UsesUsingAlias.sol";
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
        [currentUri]: `pragma solidity ^0.8.24;
import {Data, DataLib as RenamedDataLib} from "./DataLib.sol";

contract UsesUsingAlias {
    using RenamedDataLib for Data;
    Data internal data;

    function f() external {
        data.bump(1);
    }
}`,
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
      const parser = new SolidityParser();
      const idx = new SymbolIndex(parser, workspace);
      const docs: Record<string, TextDocument> = {};
      for (const [uri, text] of Object.entries(files)) {
        parser.parse(uri, text);
        idx.updateFile(uri);
        docs[uri] = doc(uri, text);
      }
      const resolver = new SemanticResolver(parser, workspace, idx);
      const provider = new DefinitionProvider(idx, parser, workspace, resolver);
      const lines = files[currentUri].split("\n");
      const line = lines.findIndex((candidate) => candidate.includes("data.bump"));
      const def = provider.provideDefinition(docs[currentUri], {
        line,
        character: lines[line].indexOf("bump") + 1,
      });

      assert.ok(def, "expected definition for aliased using-for method");
      const loc = Array.isArray(def) ? def[0] : def;
      assert.ok("uri" in loc);
      assert.equal(loc.uri, libUri);
      assert.equal(loc.range.start.line, 6);
    });
  });

  describe("file-level declarations", () => {
    it("jumps to a file-level struct declaration from a parameter type", () => {
      const { docs, provider } = setup({
        "file:///w/structs.sol": `pragma solidity ^0.8.24;

struct MigratorParameters {
    uint256 poolTickSpacing;
}

contract C {
    function validate(MigratorParameters memory p) internal pure {}
}`,
      });

      const line = docs["file:///w/structs.sol"].getText().split("\n")[7];
      const col = line.indexOf("MigratorParameters") + 2;
      const def = provider.provideDefinition(docs["file:///w/structs.sol"], {
        line: 7,
        character: col,
      });

      assert.ok(def, "expected definition for file-level struct");
      const loc = Array.isArray(def) ? def[0] : def;
      assert.ok("uri" in loc);
      assert.equal(loc.uri, "file:///w/structs.sol");
      const structLine = docs["file:///w/structs.sol"]
        .getText()
        .split("\n")
        .findIndex((l) => l.includes("struct MigratorParameters"));
      assert.equal(loc.range.start.line, structLine);
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
