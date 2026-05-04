import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { parseStorageLayout, lookupSlot } from "@solidity-workbench/common";

describe("parseStorageLayout", () => {
  it("parses the canonical storageLayout block from a forge artifact", () => {
    const artifact = {
      storageLayout: {
        storage: [
          { label: "count", slot: "0", offset: 0, type: "t_uint256" },
          { label: "owner", slot: "1", offset: 0, type: "t_address" },
        ],
        types: {
          t_uint256: { label: "uint256", numberOfBytes: "32" },
          t_address: { label: "address", numberOfBytes: "20" },
        },
      },
    };
    const layout = parseStorageLayout(artifact);
    assert.ok(layout);
    assert.equal(layout!.entries.length, 2);
    assert.equal(layout!.entries[0].label, "count");
    assert.equal(layout!.entries[0].slot, 0n);
    assert.equal(layout!.entries[0].type, "uint256");
    assert.equal(layout!.entries[1].type, "address");
    assert.equal(layout!.entries[1].numberOfBytes, 20);
  });

  it("groups packed variables (multiple entries per slot) under bySlot", () => {
    const layout = parseStorageLayout({
      storageLayout: {
        storage: [
          { label: "a", slot: "0", offset: 0, type: "t_uint128" },
          { label: "b", slot: "0", offset: 16, type: "t_uint128" },
          { label: "c", slot: "1", offset: 0, type: "t_uint256" },
        ],
        types: {
          t_uint128: { label: "uint128", numberOfBytes: "16" },
          t_uint256: { label: "uint256", numberOfBytes: "32" },
        },
      },
    });
    assert.ok(layout);
    assert.equal(layout!.bySlot.get("0")?.length, 2);
    assert.equal(layout!.bySlot.get("1")?.length, 1);
  });

  it("accepts the storageLayout object passed directly (without artifact wrapper)", () => {
    const layout = parseStorageLayout({
      storage: [{ label: "x", slot: "0", offset: 0, type: "t_uint256" }],
      types: { t_uint256: { label: "uint256", numberOfBytes: "32" } },
    });
    assert.ok(layout);
    assert.equal(layout!.entries[0].label, "x");
  });

  it("falls back to type-id label when types[] is missing or incomplete", () => {
    const layout = parseStorageLayout({
      storageLayout: {
        storage: [{ label: "x", slot: "0", offset: 0, type: "t_uint256" }],
      },
    });
    assert.equal(layout!.entries[0].type, "uint256"); // strips `t_`
    assert.equal(layout!.entries[0].numberOfBytes, 32); // default
  });

  it("returns null for missing or non-object input", () => {
    assert.equal(parseStorageLayout(null), null);
    assert.equal(parseStorageLayout("string"), null);
    assert.equal(parseStorageLayout({ storageLayout: null }), null);
  });

  it("returns an empty layout (entries / bySlot empty) when storage is []", () => {
    const layout = parseStorageLayout({ storageLayout: { storage: [], types: {} } });
    assert.ok(layout);
    assert.equal(layout!.entries.length, 0);
    assert.equal(layout!.bySlot.size, 0);
  });

  it("drops entries with malformed slot values", () => {
    const layout = parseStorageLayout({
      storageLayout: {
        storage: [
          { label: "ok", slot: "0", offset: 0, type: "t_uint256" },
          { label: "bad", slot: "not-a-number", offset: 0, type: "t_uint256" },
        ],
      },
    });
    assert.equal(layout!.entries.length, 1);
    assert.equal(layout!.entries[0].label, "ok");
  });
});

describe("lookupSlot", () => {
  const layout = parseStorageLayout({
    storageLayout: {
      storage: [
        { label: "count", slot: "0", offset: 0, type: "t_uint256" },
        { label: "owner", slot: "1", offset: 0, type: "t_address" },
      ],
      types: {
        t_uint256: { label: "uint256", numberOfBytes: "32" },
        t_address: { label: "address", numberOfBytes: "20" },
      },
    },
  })!;

  it("matches a plain decimal slot", () => {
    assert.equal(lookupSlot(layout, "0")[0]?.label, "count");
    assert.equal(lookupSlot(layout, "1")[0]?.label, "owner");
  });

  it("normalises 0x-prefixed and zero-padded slot strings", () => {
    assert.equal(lookupSlot(layout, "0x0")[0]?.label, "count");
    assert.equal(
      lookupSlot(layout, "0x0000000000000000000000000000000000000000000000000000000000000001")[0]
        ?.label,
      "owner",
    );
  });

  it("returns [] for slots that aren't in the layout", () => {
    assert.deepEqual(lookupSlot(layout, "99"), []);
  });
});
