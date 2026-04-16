import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { ReferenceIndex } from "../analyzer/reference-index.js";

describe("ReferenceIndex", () => {
  describe("indexFile / findReferences", () => {
    it("finds all word-boundary occurrences of an identifier", () => {
      const idx = new ReferenceIndex();
      idx.indexFile(
        "file:///w/a.sol",
        `
uint256 x = 1;
x = x + 2;
y = x;
`,
      );

      const refs = idx.findReferences("x");
      // 4 occurrences: declaration + "x = x + 2" (two of them) + "= x"
      assert.equal(refs.length, 4, `expected 4 occurrences of 'x', got ${refs.length}`);
      for (const r of refs) {
        assert.equal(r.uri, "file:///w/a.sol");
        assert.equal(r.range.end.character - r.range.start.character, 1);
      }
    });

    it("respects word boundaries (does not match substrings)", () => {
      const idx = new ReferenceIndex();
      idx.indexFile(
        "file:///w/a.sol",
        `
uint256 x = 1;
uint256 xyz = 2;
uint256 ax = 3;
`,
      );

      const refs = idx.findReferences("x");
      assert.equal(refs.length, 1, "only the standalone 'x' should match");
    });

    it("does not return entries for unknown names", () => {
      const idx = new ReferenceIndex();
      idx.indexFile("file:///w/a.sol", `contract Foo {}`);
      assert.deepEqual(idx.findReferences("doesNotExist"), []);
      assert.equal(idx.referenceCount("doesNotExist"), 0);
      assert.equal(idx.has("doesNotExist"), false);
    });
  });

  describe("comment & string filtering", () => {
    it("skips identifiers inside single-line block comments", () => {
      const idx = new ReferenceIndex();
      idx.indexFile(
        "file:///w/a.sol",
        `
uint256 y = 1;
/* x = 1 */
`,
      );

      assert.equal(idx.referenceCount("x"), 0, "'x' only appears inside a block comment");
      assert.ok(idx.referenceCount("y") > 0);
    });

    it("skips identifiers inside multi-line block comments", () => {
      const idx = new ReferenceIndex();
      idx.indexFile(
        "file:///w/a.sol",
        `
uint256 y = 1;
/*
 * x is documented here
 * and referenced here: x
 */
uint256 z = 2;
`,
      );

      assert.equal(idx.referenceCount("x"), 0, "'x' is only inside a multi-line block comment");
      assert.ok(idx.referenceCount("y") > 0);
      assert.ok(idx.referenceCount("z") > 0);
    });

    it("skips identifiers inside line comments", () => {
      const idx = new ReferenceIndex();
      idx.indexFile(
        "file:///w/a.sol",
        `
uint256 y = 1;
// x is unused
uint256 z = 2; // x also mentioned here
`,
      );

      assert.equal(idx.referenceCount("x"), 0, "'x' only appears in line comments");
      assert.ok(idx.referenceCount("y") > 0);
      assert.ok(idx.referenceCount("z") > 0);
    });

    it("skips identifiers inside string literals", () => {
      const idx = new ReferenceIndex();
      idx.indexFile(
        "file:///w/a.sol",
        `
string memory s = "my x value";
uint256 y = 1;
`,
      );

      assert.equal(idx.referenceCount("x"), 0, "'x' only appears inside a string literal");
      assert.ok(idx.referenceCount("y") > 0);
    });
  });

  describe("removeFile", () => {
    it("removes all entries for a single file", () => {
      const idx = new ReferenceIndex();
      idx.indexFile(
        "file:///w/a.sol",
        `
uint256 onlyInA = 1;
uint256 shared = 2;
`,
      );
      idx.indexFile(
        "file:///w/b.sol",
        `
uint256 shared = 3;
`,
      );

      assert.equal(idx.referenceCount("onlyInA"), 1);
      assert.equal(idx.referenceCount("shared"), 2);

      idx.removeFile("file:///w/a.sol");

      assert.equal(idx.referenceCount("onlyInA"), 0, "entries unique to A should be gone");
      assert.equal(idx.has("onlyInA"), false);
      assert.equal(idx.referenceCount("shared"), 1, "entries in B should be preserved");
      assert.equal(idx.findReferences("shared")[0].uri, "file:///w/b.sol");
    });

    it("is idempotent and safe on files that were never indexed", () => {
      const idx = new ReferenceIndex();
      idx.removeFile("file:///nonexistent.sol");
      idx.indexFile("file:///w/a.sol", `uint256 foo = 1;`);
      idx.removeFile("file:///w/a.sol");
      idx.removeFile("file:///w/a.sol");
      assert.equal(idx.referenceCount("foo"), 0);
    });

    it("re-indexing the same file replaces rather than appends", () => {
      const idx = new ReferenceIndex();
      const uri = "file:///w/a.sol";
      idx.indexFile(uri, `uint256 first = 1;`);
      assert.equal(idx.referenceCount("first"), 1);

      idx.indexFile(uri, `uint256 second = 2;`);
      assert.equal(idx.referenceCount("first"), 0, "old identifiers should be dropped");
      assert.equal(idx.referenceCount("second"), 1);
    });
  });
});
