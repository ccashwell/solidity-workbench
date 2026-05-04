/**
 * Tests for the solc sourceMap decoder and program-counter ↔
 * instruction-index helpers. Cases here exercise the compression
 * rules documented in the Solidity manual — empty fields inheriting
 * from the previous entry, trailing-field omission, the file-index
 * `-1` sentinel — plus the bytecode walk that translates a PC into
 * an instruction index when PUSH operands intervene.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  parseSourceMap,
  buildPcToInstructionIndex,
  resolveSourcePosition,
} from "@solidity-workbench/common";

describe("parseSourceMap", () => {
  it("returns [] for an empty input", () => {
    assert.deepEqual(parseSourceMap(""), []);
  });

  it("parses a single fully-specified entry", () => {
    const map = parseSourceMap("12:34:0:i:2");
    assert.equal(map.length, 1);
    assert.deepEqual(map[0], {
      start: 12,
      length: 34,
      fileIndex: 0,
      jump: "i",
      modifierDepth: 2,
    });
  });

  it("inherits omitted fields from the previous entry", () => {
    // Three entries: full, only `start`, only `jump`.
    const map = parseSourceMap("1:2:0:-:0;5;:::o");
    assert.deepEqual(map[0], { start: 1, length: 2, fileIndex: 0, jump: "-", modifierDepth: 0 });
    // Second entry: start changes, everything else inherits.
    assert.deepEqual(map[1], { start: 5, length: 2, fileIndex: 0, jump: "-", modifierDepth: 0 });
    // Third entry: jump changes, everything else inherits.
    assert.deepEqual(map[2], { start: 5, length: 2, fileIndex: 0, jump: "o", modifierDepth: 0 });
  });

  it("treats consecutive semicolons as duplicate entries", () => {
    const map = parseSourceMap("7:8:1:i:0;;;");
    assert.equal(map.length, 4);
    for (const e of map) {
      assert.deepEqual(e, { start: 7, length: 8, fileIndex: 1, jump: "i", modifierDepth: 0 });
    }
  });

  it("handles trailing-field omission (compressed canonical form)", () => {
    // No modifierDepth field at all — should default to 0 for the
    // first entry, then inherit on subsequent entries.
    const map = parseSourceMap("1:2:0:-;5");
    assert.equal(map[0].modifierDepth, 0);
    assert.equal(map[1].modifierDepth, 0);
  });

  it("recognises the fileIndex = -1 sentinel for generated code", () => {
    const map = parseSourceMap("0:0:-1:-:0");
    assert.equal(map[0].fileIndex, -1);
  });

  it("falls back to previous values on garbled numeric fields rather than throwing", () => {
    const map = parseSourceMap("1:2:0:-:0;abc:def:ghi:jkl:mno");
    assert.equal(map.length, 2);
    // Garbage parses as fallback to entry[0].
    assert.deepEqual(map[1], map[0]);
  });
});

describe("buildPcToInstructionIndex", () => {
  it("treats each non-PUSH byte as its own instruction", () => {
    // Three opcodes, no PUSH: STOP STOP STOP -> [0, 1, 2].
    const map = buildPcToInstructionIndex("000000");
    assert.deepEqual(Array.from(map), [0, 1, 2]);
  });

  it("rolls PUSH operand bytes onto the same instruction index as the PUSH itself", () => {
    // PUSH2 0xCAFE, then STOP:
    //   pc 0 = PUSH2 (instr 0)
    //   pc 1 = first operand byte (still instr 0)
    //   pc 2 = second operand byte (still instr 0)
    //   pc 3 = STOP (instr 1)
    const map = buildPcToInstructionIndex("0x61cafe00");
    assert.deepEqual(Array.from(map), [0, 0, 0, 1]);
  });

  it("handles PUSH32 (0x7f) — 32 operand bytes onto one instruction", () => {
    // PUSH32 followed by 32 0x00 bytes, then STOP.
    const hex = "0x7f" + "00".repeat(32) + "00";
    const map = buildPcToInstructionIndex(hex);
    // 33 PCs (0..32) all map to instruction 0; PC 33 to instruction 1.
    for (let i = 0; i <= 32; i++) {
      assert.equal(map[i], 0, `pc ${i} should map to instruction 0`);
    }
    assert.equal(map[33], 1);
  });

  it("treats PUSH0 (0x5f) as a single byte with no operand", () => {
    // PUSH0, STOP:
    //   pc 0 = PUSH0 (instr 0)
    //   pc 1 = STOP (instr 1)
    const map = buildPcToInstructionIndex("5f00");
    assert.deepEqual(Array.from(map), [0, 1]);
  });

  it("strips a `0x` / `0X` prefix transparently", () => {
    const a = buildPcToInstructionIndex("000000");
    const b = buildPcToInstructionIndex("0x000000");
    const c = buildPcToInstructionIndex("0X000000");
    assert.deepEqual(Array.from(a), Array.from(b));
    assert.deepEqual(Array.from(b), Array.from(c));
  });

  it("throws on odd-length input rather than silently truncating", () => {
    assert.throws(() => buildPcToInstructionIndex("abc"), /odd length/);
  });
});

describe("resolveSourcePosition", () => {
  it("returns the entry corresponding to a PC", () => {
    // PUSH1 0xFF, STOP — instructions [0, 1], with two source map entries.
    const sourceMap = parseSourceMap("10:5:0:-:0;20:6:0:-:0");
    const pcMap = buildPcToInstructionIndex("60ff00");
    // PC 0 (PUSH1) -> instruction 0 -> first sourceMap entry.
    assert.deepEqual(resolveSourcePosition(0, pcMap, sourceMap), {
      start: 10,
      length: 5,
      fileIndex: 0,
      jump: "-",
      modifierDepth: 0,
    });
    // PC 2 (STOP) -> instruction 1 -> second entry.
    assert.deepEqual(resolveSourcePosition(2, pcMap, sourceMap), {
      start: 20,
      length: 6,
      fileIndex: 0,
      jump: "-",
      modifierDepth: 0,
    });
  });

  it("returns null when the PC is out of range", () => {
    const sourceMap = parseSourceMap("10:5:0:-:0");
    const pcMap = buildPcToInstructionIndex("00");
    assert.equal(resolveSourcePosition(-1, pcMap, sourceMap), null);
    assert.equal(resolveSourcePosition(100, pcMap, sourceMap), null);
  });

  it("returns null for compiler-generated opcodes (fileIndex = -1)", () => {
    const sourceMap = parseSourceMap("0:0:-1:-:0");
    const pcMap = buildPcToInstructionIndex("00");
    assert.equal(resolveSourcePosition(0, pcMap, sourceMap), null);
  });

  it("returns null when the sourceMap is shorter than the bytecode (recoverable)", () => {
    const sourceMap = parseSourceMap("10:5:0:-:0"); // one entry only
    const pcMap = buildPcToInstructionIndex("0000"); // two instructions
    // PC 0 resolves; PC 1 has no map entry.
    assert.notEqual(resolveSourcePosition(0, pcMap, sourceMap), null);
    assert.equal(resolveSourcePosition(1, pcMap, sourceMap), null);
  });
});
