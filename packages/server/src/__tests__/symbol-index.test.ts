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
});
