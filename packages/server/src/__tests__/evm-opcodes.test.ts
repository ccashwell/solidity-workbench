import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { disassemble, opcodeMnemonic } from "@solidity-workbench/common";

describe("opcodeMnemonic", () => {
  it("knows the canonical instruction set", () => {
    assert.equal(opcodeMnemonic(0x00), "STOP");
    assert.equal(opcodeMnemonic(0x01), "ADD");
    assert.equal(opcodeMnemonic(0x55), "SSTORE");
    assert.equal(opcodeMnemonic(0xfd), "REVERT");
    assert.equal(opcodeMnemonic(0xff), "SELFDESTRUCT");
  });

  it("emits PUSH1..PUSH32 / DUP1..DUP16 / SWAP1..SWAP16 mnemonics", () => {
    assert.equal(opcodeMnemonic(0x60), "PUSH1");
    assert.equal(opcodeMnemonic(0x7f), "PUSH32");
    assert.equal(opcodeMnemonic(0x5f), "PUSH0");
    assert.equal(opcodeMnemonic(0x80), "DUP1");
    assert.equal(opcodeMnemonic(0x8f), "DUP16");
    assert.equal(opcodeMnemonic(0x90), "SWAP1");
    assert.equal(opcodeMnemonic(0x9f), "SWAP16");
  });

  it("renders unknown opcodes as INVALID(0xNN) rather than throwing", () => {
    assert.equal(opcodeMnemonic(0x0c), "INVALID(0x0C)");
    assert.equal(opcodeMnemonic(0xef), "INVALID(0xEF)");
  });
});

describe("disassemble", () => {
  it("emits one Instruction per opcode for a sequence of single-byte ops", () => {
    // STOP STOP ADD STOP -> 4 instructions at PCs 0,1,2,3.
    const insts = disassemble("00000100");
    assert.deepEqual(
      insts.map((i) => `${i.pc}:${i.mnemonic}`),
      ["0:STOP", "1:STOP", "2:ADD", "3:STOP"],
    );
    for (const i of insts) assert.equal(i.immediate, null);
  });

  it("rolls PUSH operand bytes into the PUSH instruction with `immediate`", () => {
    // PUSH2 0xCAFE, STOP.
    const insts = disassemble("0x61cafe00");
    assert.equal(insts.length, 2);
    assert.equal(insts[0].mnemonic, "PUSH2");
    assert.equal(insts[0].immediate, "cafe");
    assert.equal(insts[0].pc, 0);
    assert.equal(insts[1].mnemonic, "STOP");
    assert.equal(insts[1].pc, 3);
  });

  it("handles PUSH32 (32 operand bytes)", () => {
    const hex = "7f" + "ab".repeat(32) + "00";
    const insts = disassemble(hex);
    assert.equal(insts.length, 2);
    assert.equal(insts[0].mnemonic, "PUSH32");
    assert.equal(insts[0].immediate, "ab".repeat(32));
    assert.equal(insts[1].mnemonic, "STOP");
    assert.equal(insts[1].pc, 33);
  });

  it("handles a truncated PUSH at the end of the bytecode (defensive)", () => {
    // PUSH4 with only 2 bytes of payload remaining — the
    // disassembler emits the PUSH4 with whatever bytes it found
    // rather than throwing.
    const insts = disassemble("0x63abcd");
    assert.equal(insts.length, 1);
    assert.equal(insts[0].mnemonic, "PUSH4");
    assert.equal(insts[0].immediate, "abcd");
  });

  it("emits PUSH0 with an empty immediate", () => {
    const insts = disassemble("5f00");
    assert.equal(insts[0].mnemonic, "PUSH0");
    assert.equal(insts[0].immediate, "");
    assert.equal(insts[1].mnemonic, "STOP");
  });

  it("strips a 0x / 0X prefix transparently", () => {
    const a = disassemble("00");
    const b = disassemble("0x00");
    const c = disassemble("0X00");
    assert.deepEqual(a, b);
    assert.deepEqual(b, c);
  });

  it("throws on odd-length input rather than silently truncating", () => {
    assert.throws(() => disassemble("abc"), /odd length/);
  });
});
