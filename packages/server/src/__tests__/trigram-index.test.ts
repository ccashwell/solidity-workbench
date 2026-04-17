import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { TrigramIndex, scoreName } from "../analyzer/trigram-index.js";

describe("TrigramIndex", () => {
  describe("candidate pruning", () => {
    it("returns every indexed name for an empty query", () => {
      const ix = new TrigramIndex();
      ["Alpha", "Beta", "Gamma"].forEach((n) => ix.add(n));
      const cands = new Set(ix.candidates(""));
      assert.deepEqual(cands, new Set(["Alpha", "Beta", "Gamma"]));
    });

    it("scans every indexed name for a 1- or 2-char query (no trigrams)", () => {
      const ix = new TrigramIndex();
      ["Alpha", "BetaGame", "Gamma"].forEach((n) => ix.add(n));
      // 'a' appears somewhere in all three.
      const cands = new Set(ix.candidates("a"));
      assert.deepEqual(cands, new Set(["Alpha", "BetaGame", "Gamma"]));
    });

    it("prunes via trigram intersection for 3+ char queries", () => {
      const ix = new TrigramIndex();
      ix.add("tokenTransfer");
      ix.add("rawTransfer");
      ix.add("mintAndBurn");
      ix.add("helper");

      const cands = new Set(ix.candidates("transfer"));
      assert.ok(cands.has("tokenTransfer"), "tokenTransfer should be a candidate");
      assert.ok(cands.has("rawTransfer"), "rawTransfer should be a candidate");
      assert.ok(!cands.has("mintAndBurn"), "mintAndBurn has no 'transfer' trigrams");
      assert.ok(!cands.has("helper"), "helper has no 'transfer' trigrams");
    });

    it("returns [] when any query trigram is absent from the index", () => {
      const ix = new TrigramIndex();
      ix.add("Alpha");
      ix.add("Beta");
      // "xyz" trigram doesn't appear in any indexed name.
      assert.deepEqual(ix.candidates("xyz"), []);
    });

    it("is case-insensitive for trigram matching", () => {
      const ix = new TrigramIndex();
      ix.add("TokenTransfer");
      const cands = ix.candidates("TRANS");
      assert.ok(cands.includes("TokenTransfer"));
    });
  });

  describe("add / remove lifecycle", () => {
    it("`add` is idempotent — re-indexing doesn't inflate postings", () => {
      const ix = new TrigramIndex();
      for (let i = 0; i < 10; i++) ix.add("tokenTransfer");
      assert.equal(ix.size, 1);
      const cands = ix.candidates("transfer");
      assert.equal(cands.length, 1);
    });

    it("`remove` drops the name from future candidate sets", () => {
      const ix = new TrigramIndex();
      ix.add("Alpha");
      ix.add("Alligator");
      assert.ok(ix.candidates("alph").includes("Alpha"));
      ix.remove("Alpha");
      assert.ok(!ix.candidates("alph").includes("Alpha"));
      assert.ok(ix.candidates("allig").includes("Alligator"));
    });

    it("`remove` is safe for never-indexed names", () => {
      const ix = new TrigramIndex();
      assert.doesNotThrow(() => ix.remove("NotThere"));
    });

    it("`clear` wipes both the name set and the posting lists", () => {
      const ix = new TrigramIndex();
      ix.add("Alpha");
      ix.clear();
      assert.equal(ix.size, 0);
      assert.deepEqual(ix.candidates("alph"), []);
    });
  });
});

describe("scoreName ranking", () => {
  it("exact match beats every other tier", () => {
    const exact = scoreName("transfer", "transfer");
    const prefix = scoreName("transferFrom", "transfer");
    const substring = scoreName("doTransferNow", "transfer");
    const fuzzy = scoreName("tokenTransfer", "tkTr");
    assert.ok(exact > prefix && prefix > substring && substring > fuzzy);
  });

  it("prefix match beats plain substring match", () => {
    assert.ok(scoreName("transferFrom", "transfer") > scoreName("doTransferNow", "transfer"));
  });

  it("prefers the shorter name within a tier", () => {
    assert.ok(
      scoreName("transferX", "transfer") > scoreName("transferXYZZZZZZ", "transfer"),
      "tighter prefix should beat longer prefix",
    );
  });

  it("empty query passes every candidate with a non-zero score", () => {
    assert.ok(scoreName("Anything", "") > 0);
  });

  it("returns 0 for names that don't even contain the characters in order", () => {
    assert.equal(scoreName("Foo", "xyz"), 0);
  });

  it("matches ordered subsequence as a fuzzy fallback", () => {
    assert.ok(scoreName("tokenTransfer", "tkTr") > 0);
    // But still less than any substring match.
    assert.ok(scoreName("tokenTransfer", "tkTr") < scoreName("transfer", "transfer"));
  });

  it("is case-insensitive", () => {
    assert.ok(scoreName("TokenTransfer", "TOKEN") > 0);
    assert.ok(scoreName("TokenTransfer", "token") > 0);
  });
});
