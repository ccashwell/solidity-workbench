import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { URI } from "vscode-uri";
import { SolidityParser } from "../parser/solidity-parser.js";
import { SymbolIndex } from "../analyzer/symbol-index.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";

/**
 * Minimal stub of {@link WorkspaceManager}.  `SymbolIndex` only calls
 * `getAllFileUris()` and `uriToPath(uri)` on the workspace, so a tiny fake is
 * enough to exercise the full indexing pipeline without bringing up a real
 * foundry project.
 */
function makeFakeWorkspace(uris: string[] = []): WorkspaceManager {
  return {
    getAllFileUris: () => uris,
    uriToPath: (uri: string) => URI.parse(uri).fsPath,
  } as unknown as WorkspaceManager;
}

/** Parse `text` and feed it into the symbol index at the given fake URI. */
function indexText(parser: SolidityParser, idx: SymbolIndex, uri: string, text: string): void {
  parser.parse(uri, text);
  idx.updateFile(uri);
}

describe("SymbolIndex", () => {
  describe("contract-level symbols", () => {
    it("indexes a contract definition", () => {
      const parser = new SolidityParser();
      const idx = new SymbolIndex(parser, makeFakeWorkspace());
      indexText(
        parser,
        idx,
        "file:///w/Foo.sol",
        `
pragma solidity ^0.8.24;
contract Foo {
    uint256 public x;
}
`,
      );

      const syms = idx.findSymbols("Foo");
      assert.equal(syms.length, 1);
      assert.equal(syms[0].kind, "contract");
      assert.equal(syms[0].containerName, undefined);
      assert.equal(syms[0].filePath, "file:///w/Foo.sol");
    });

    it("tags state variables with the containing contract", () => {
      const parser = new SolidityParser();
      const idx = new SymbolIndex(parser, makeFakeWorkspace());
      indexText(
        parser,
        idx,
        "file:///w/Foo.sol",
        `
pragma solidity ^0.8.24;
contract Foo { uint256 public counter; }
`,
      );

      const syms = idx.findSymbols("counter");
      assert.equal(syms.length, 1);
      assert.equal(syms[0].kind, "stateVariable");
      assert.equal(syms[0].containerName, "Foo");
    });
  });

  describe("file-level declarations", () => {
    it("indexes free functions with no containerName", () => {
      const parser = new SolidityParser();
      const idx = new SymbolIndex(parser, makeFakeWorkspace());
      indexText(
        parser,
        idx,
        "file:///w/math.sol",
        `
pragma solidity ^0.8.24;

function add(uint256 a, uint256 b) pure returns (uint256) {
    return a + b;
}
`,
      );

      const syms = idx.findSymbols("add");
      assert.equal(syms.length, 1, "should find exactly one 'add' symbol");
      assert.equal(syms[0].kind, "function");
      assert.equal(syms[0].containerName, undefined, "free functions have no containerName");
      assert.ok(syms[0].detail, "free function should have a signature detail");
      assert.ok(syms[0].detail!.includes("uint256"));
    });

    it("indexes file-level custom errors", () => {
      const parser = new SolidityParser();
      const idx = new SymbolIndex(parser, makeFakeWorkspace());
      indexText(
        parser,
        idx,
        "file:///w/errs.sol",
        `
pragma solidity ^0.8.24;

error MyError(uint256 x);
`,
      );

      const syms = idx.findSymbols("MyError");
      assert.equal(syms.length, 1);
      assert.equal(syms[0].kind, "error");
      assert.equal(syms[0].containerName, undefined);
    });

    it("indexes user-defined value types", () => {
      const parser = new SolidityParser();
      const idx = new SymbolIndex(parser, makeFakeWorkspace());
      indexText(
        parser,
        idx,
        "file:///w/fixed.sol",
        `
pragma solidity ^0.8.24;

type Fixed is uint256;
`,
      );

      const syms = idx.findSymbols("Fixed");
      assert.equal(syms.length, 1);
      assert.equal(syms[0].kind, "userDefinedValueType");
      assert.equal(syms[0].containerName, undefined);
      assert.equal(syms[0].detail, "uint256");
    });
  });

  describe("cross-file symbols", () => {
    it("keeps same-named functions in different contracts distinct", () => {
      const parser = new SolidityParser();
      const idx = new SymbolIndex(parser, makeFakeWorkspace());

      indexText(
        parser,
        idx,
        "file:///w/A.sol",
        `
pragma solidity ^0.8.24;
contract A {
    function transfer(address to, uint256 amt) external {}
}
`,
      );
      indexText(
        parser,
        idx,
        "file:///w/B.sol",
        `
pragma solidity ^0.8.24;
contract B {
    function transfer(address to, uint256 amt) external {}
}
`,
      );

      const syms = idx.findSymbols("transfer");
      assert.equal(syms.length, 2);
      const containers = syms.map((s) => s.containerName).sort();
      assert.deepEqual(containers, ["A", "B"]);
    });

    it("removes stale symbols when a file is re-indexed", () => {
      const parser = new SolidityParser();
      const idx = new SymbolIndex(parser, makeFakeWorkspace());

      indexText(parser, idx, "file:///w/X.sol", `contract OldName {}`);
      assert.equal(idx.findSymbols("OldName").length, 1);

      indexText(parser, idx, "file:///w/X.sol", `contract NewName {}`);
      assert.equal(idx.findSymbols("OldName").length, 0, "old symbol should be evicted");
      assert.equal(idx.findSymbols("NewName").length, 1);
    });
  });

  describe("reference index integration", () => {
    it("records reference occurrences from function bodies", () => {
      const parser = new SolidityParser();
      const idx = new SymbolIndex(parser, makeFakeWorkspace());
      indexText(
        parser,
        idx,
        "file:///w/Counter.sol",
        `
pragma solidity ^0.8.24;
contract Counter {
    uint256 public count;
    function bump() external {
        count = count + 1;
    }
}
`,
      );

      assert.ok(
        idx.referenceCount("count") > 0,
        "identifier used in a function body should be in the reference index",
      );
      assert.ok(idx.hasReferences("count"));
      const refs = idx.findReferences("count");
      assert.ok(refs.length >= 3, "'count' appears ≥3 times (decl + 2 uses)");
    });

    it("cleans up reference entries on onFileClosed", () => {
      const parser = new SolidityParser();
      const idx = new SymbolIndex(parser, makeFakeWorkspace());
      const uri = "file:///w/Counter.sol";
      indexText(
        parser,
        idx,
        uri,
        `
pragma solidity ^0.8.24;
contract Counter { uint256 public myUniqueVar; }
`,
      );
      assert.ok(idx.referenceCount("myUniqueVar") > 0);

      idx.onFileClosed(uri);
      assert.equal(idx.referenceCount("myUniqueVar"), 0);
      assert.equal(idx.hasReferences("myUniqueVar"), false);
    });
  });

  describe("indexFile via disk", () => {
    it("reads files from disk and populates both symbol and reference indexes", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "solidx-"));
      const filePath = path.join(tmp, "DiskOnly.sol");
      fs.writeFileSync(
        filePath,
        `
pragma solidity ^0.8.24;
contract DiskOnly {
    uint256 public diskVar;
    function read() external view returns (uint256) { return diskVar; }
}
`,
      );
      const uri = URI.file(filePath).toString();

      const parser = new SolidityParser();
      const idx = new SymbolIndex(parser, makeFakeWorkspace([uri]));
      await idx.indexFile(uri);

      assert.equal(idx.findSymbols("DiskOnly").length, 1);
      assert.equal(idx.findSymbols("diskVar").length, 1);
      assert.ok(idx.referenceCount("diskVar") >= 2, "diskVar used in decl + return");

      fs.rmSync(tmp, { recursive: true, force: true });
    });
  });

  describe("findWorkspaceSymbols ranking", () => {
    const seed = (parser: SolidityParser, idx: SymbolIndex) => {
      indexText(
        parser,
        idx,
        "file:///w/A.sol",
        `contract Token {
    function transfer(address to, uint256 amount) external returns (bool) { to; amount; return true; }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) { from; to; amount; return true; }
}
contract Router {
    function doTransferNow(uint256 x) external pure returns (uint256) { return x; }
}
contract Helper {
    function unrelated() external pure {}
}`,
      );
    };

    it("ranks an exact match ahead of prefix, substring, and fuzzy matches", () => {
      const parser = new SolidityParser();
      const idx = new SymbolIndex(parser, makeFakeWorkspace());
      seed(parser, idx);

      const results = idx.findWorkspaceSymbols("transfer");
      assert.ok(results.length >= 3, `expected 3+ matches; got ${results.length}`);
      // First result must be the exact-name "transfer" function; it
      // could appear as "Token.transfer" because we prefix with the
      // container name in the emitted WorkspaceSymbol.
      assert.ok(
        /^(Token\.)?transfer$/.test(results[0].name),
        `exact match should rank first; got ${results[0].name}`,
      );
      // doTransferNow is only a substring match — it must rank after
      // the exact and prefix matches.
      const doTransferIdx = results.findIndex((r) => r.name.endsWith("doTransferNow"));
      const exactIdx = results.findIndex((r) => /(^|\.)transfer$/.test(r.name));
      const prefixIdx = results.findIndex((r) => /transferFrom$/.test(r.name));
      assert.ok(exactIdx >= 0 && prefixIdx >= 0 && doTransferIdx >= 0);
      assert.ok(exactIdx < prefixIdx, "exact should precede prefix");
      assert.ok(prefixIdx < doTransferIdx, "prefix should precede substring");
    });

    it("prunes non-matches via the trigram index", () => {
      const parser = new SolidityParser();
      const idx = new SymbolIndex(parser, makeFakeWorkspace());
      seed(parser, idx);
      // 'unrelated' exists; 'zzzzz' does not. The query 'zzzzz' has
      // trigrams none of the indexed names contain, so the result
      // must be empty without a full linear scan.
      assert.deepEqual(idx.findWorkspaceSymbols("zzzzz"), []);
    });

    it("returns an empty array for a query whose trigrams none of the names contain", () => {
      const parser = new SolidityParser();
      const idx = new SymbolIndex(parser, makeFakeWorkspace());
      seed(parser, idx);
      assert.deepEqual(idx.findWorkspaceSymbols("qqqq"), []);
    });

    it("short 1–2 char queries fall back to a name scan and still return matches", () => {
      const parser = new SolidityParser();
      const idx = new SymbolIndex(parser, makeFakeWorkspace());
      seed(parser, idx);
      // 'ok' is a 2-char query — below the trigram threshold.
      const results = idx.findWorkspaceSymbols("ok");
      // Token contains 'ok' as a substring.
      assert.ok(
        results.some((r) => r.name.includes("Token")),
        `got ${JSON.stringify(results)}`,
      );
    });

    it("drops a name from search results after its last occurrence is removed", () => {
      const parser = new SolidityParser();
      const idx = new SymbolIndex(parser, makeFakeWorkspace());
      indexText(
        parser,
        idx,
        "file:///w/Only.sol",
        `contract OnlyHolder { uint256 public uniqueMarker; }`,
      );
      assert.ok(idx.findWorkspaceSymbols("uniqueMarker").length >= 1);

      // Reindex the file with the symbol removed. The trigram entry
      // for "uniqueMarker" should be dropped on the transition.
      indexText(parser, idx, "file:///w/Only.sol", `contract OnlyHolder {}`);
      assert.equal(
        idx.findWorkspaceSymbols("uniqueMarker").length,
        0,
        "removed symbol must no longer appear in workspace-symbol search",
      );
    });
  });
});
