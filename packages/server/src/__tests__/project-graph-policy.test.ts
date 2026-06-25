import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { shouldDrainRelationshipsForGraphQuery } from "../analyzer/project-graph-policy.js";

describe("project graph query policy", () => {
  it("drains full relationship indexing only for whole-workspace incoming queries", () => {
    assert.equal(shouldDrainRelationshipsForGraphQuery("callers", "auto"), true);
    assert.equal(shouldDrainRelationshipsForGraphQuery("impact", "auto"), true);
    assert.equal(shouldDrainRelationshipsForGraphQuery("callees", "auto"), false);
  });

  it("respects disabled relationship indexing for callers and impact queries", () => {
    assert.equal(shouldDrainRelationshipsForGraphQuery("callers", "disabled"), false);
    assert.equal(shouldDrainRelationshipsForGraphQuery("impact", "disabled"), false);
    assert.equal(shouldDrainRelationshipsForGraphQuery("callees", "disabled"), false);
  });

  it("allows manual mode queries to build complete incoming relationship results on demand", () => {
    assert.equal(shouldDrainRelationshipsForGraphQuery("callers", "manual"), true);
    assert.equal(shouldDrainRelationshipsForGraphQuery("impact", "manual"), true);
    assert.equal(shouldDrainRelationshipsForGraphQuery("callees", "manual"), false);
  });
});
