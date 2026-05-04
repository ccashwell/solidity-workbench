/**
 * Tests for the forge artifact parser. Fixtures here mirror the
 * shapes Foundry has emitted across versions: the canonical nested
 * `{ object, sourceMap }` form, the rare flat-string form, the
 * `evm.bytecode` legacy nesting, and the three places the
 * compilation source list can hide (metadata.sources / top-level
 * sources / top-level sourceList).
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { parseForgeArtifact } from "@solidity-workbench/common";

describe("parseForgeArtifact", () => {
  it("parses the canonical { object, sourceMap } shape", () => {
    const json = JSON.stringify({
      bytecode: { object: "0x6080", sourceMap: "1:2:0:-:0" },
      deployedBytecode: { object: "0xfe", sourceMap: "10:20:0:-:0" },
      metadata: JSON.stringify({
        sources: { "src/A.sol": {}, "src/B.sol": {} },
      }),
    });
    const artifact = parseForgeArtifact(json);
    assert.ok(artifact);
    assert.equal(artifact!.deployedBytecode, "0xfe");
    assert.equal(artifact!.deployedSourceMap, "10:20:0:-:0");
    assert.equal(artifact!.bytecode, "0x6080");
    assert.equal(artifact!.bytecodeSourceMap, "1:2:0:-:0");
    assert.deepEqual(artifact!.sources, ["src/A.sol", "src/B.sol"]);
  });

  it("accepts the flat-string bytecode form with a parallel sourceMap key", () => {
    const json = JSON.stringify({
      bytecode: "0xab",
      bytecodeSourceMap: "1:2:0:-:0",
      deployedBytecode: "0xcd",
      deployedBytecodeSourceMap: "3:4:0:-:0",
    });
    const artifact = parseForgeArtifact(json);
    assert.ok(artifact);
    assert.equal(artifact!.bytecode, "0xab");
    assert.equal(artifact!.bytecodeSourceMap, "1:2:0:-:0");
    assert.equal(artifact!.deployedBytecode, "0xcd");
    assert.equal(artifact!.deployedSourceMap, "3:4:0:-:0");
  });

  it("falls back to evm.deployedBytecode when the top-level field is missing", () => {
    const json = JSON.stringify({
      evm: {
        bytecode: { object: "0x60", sourceMap: "" },
        deployedBytecode: { object: "0xfe", sourceMap: "1:0:0:-:0" },
      },
    });
    const artifact = parseForgeArtifact(json);
    assert.ok(artifact);
    assert.equal(artifact!.deployedBytecode, "0xfe");
    assert.equal(artifact!.deployedSourceMap, "1:0:0:-:0");
  });

  it("uses the metadata's sources object key order as the file-index basis", () => {
    // Metadata key order maps directly to source-map fileIndex.
    const json = JSON.stringify({
      deployedBytecode: { object: "0xfe", sourceMap: "1:0:2:-:0" },
      metadata: JSON.stringify({
        sources: {
          "src/Counter.sol": {},
          "src/Vault.sol": {},
          "src/lib/Math.sol": {},
        },
      }),
    });
    const artifact = parseForgeArtifact(json);
    assert.deepEqual(artifact!.sources, [
      "src/Counter.sol",
      "src/Vault.sol",
      "src/lib/Math.sol",
    ]);
  });

  it("falls back to a top-level `sources` array when metadata is absent", () => {
    const json = JSON.stringify({
      deployedBytecode: { object: "0xfe", sourceMap: "" },
      sources: ["a.sol", "b.sol"],
    });
    const artifact = parseForgeArtifact(json);
    assert.deepEqual(artifact!.sources, ["a.sol", "b.sol"]);
  });

  it("falls back to a top-level `sourceList` array as a last resort", () => {
    const json = JSON.stringify({
      deployedBytecode: { object: "0xfe", sourceMap: "" },
      sourceList: ["x.sol"],
    });
    const artifact = parseForgeArtifact(json);
    assert.deepEqual(artifact!.sources, ["x.sol"]);
  });

  it("returns [] for the sources list when nothing is recoverable", () => {
    const json = JSON.stringify({
      deployedBytecode: { object: "0xfe", sourceMap: "" },
    });
    const artifact = parseForgeArtifact(json);
    assert.deepEqual(artifact!.sources, []);
  });

  it("returns null when deployedBytecode is missing or empty", () => {
    assert.equal(parseForgeArtifact(JSON.stringify({})), null);
    assert.equal(
      parseForgeArtifact(JSON.stringify({ deployedBytecode: { object: "", sourceMap: "" } })),
      null,
    );
  });

  it("returns null for invalid JSON", () => {
    assert.equal(parseForgeArtifact("{not json"), null);
    assert.equal(parseForgeArtifact("null"), null);
    assert.equal(parseForgeArtifact("123"), null);
  });

  it("tolerates an already-parsed metadata object (some forge versions)", () => {
    const json = JSON.stringify({
      deployedBytecode: { object: "0xfe", sourceMap: "" },
      metadata: { sources: { "src/A.sol": {} } },
    });
    const artifact = parseForgeArtifact(json);
    assert.deepEqual(artifact!.sources, ["src/A.sol"]);
  });
});
