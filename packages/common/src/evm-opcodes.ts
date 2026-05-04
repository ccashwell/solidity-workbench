/**
 * EVM opcode table + linear disassembler. Used by the DAP debug
 * adapter to satisfy VSCode's `disassemble` request: given a
 * starting offset and a count, return a window of decoded
 * instructions with mnemonics, operand bytes, and the program
 * counter that addresses each instruction.
 *
 * The opcode table covers everything live as of Cancun (March
 * 2024) plus the Pectra / Prague additions through 2026 that have
 * a stable opcode assignment. Anything unknown is rendered as
 * `INVALID(0xNN)` so disassembly of malformed or future bytecode
 * still produces a readable listing.
 */

/**
 * Reverse-mapping table: opcode byte → mnemonic. PUSH1..PUSH32 and
 * DUP1..DUP16 / SWAP1..SWAP16 are filled in programmatically below.
 */
const NAMED_OPCODES: Record<number, string> = {
  0x00: "STOP",
  0x01: "ADD",
  0x02: "MUL",
  0x03: "SUB",
  0x04: "DIV",
  0x05: "SDIV",
  0x06: "MOD",
  0x07: "SMOD",
  0x08: "ADDMOD",
  0x09: "MULMOD",
  0x0a: "EXP",
  0x0b: "SIGNEXTEND",
  0x10: "LT",
  0x11: "GT",
  0x12: "SLT",
  0x13: "SGT",
  0x14: "EQ",
  0x15: "ISZERO",
  0x16: "AND",
  0x17: "OR",
  0x18: "XOR",
  0x19: "NOT",
  0x1a: "BYTE",
  0x1b: "SHL",
  0x1c: "SHR",
  0x1d: "SAR",
  0x20: "KECCAK256",
  0x30: "ADDRESS",
  0x31: "BALANCE",
  0x32: "ORIGIN",
  0x33: "CALLER",
  0x34: "CALLVALUE",
  0x35: "CALLDATALOAD",
  0x36: "CALLDATASIZE",
  0x37: "CALLDATACOPY",
  0x38: "CODESIZE",
  0x39: "CODECOPY",
  0x3a: "GASPRICE",
  0x3b: "EXTCODESIZE",
  0x3c: "EXTCODECOPY",
  0x3d: "RETURNDATASIZE",
  0x3e: "RETURNDATACOPY",
  0x3f: "EXTCODEHASH",
  0x40: "BLOCKHASH",
  0x41: "COINBASE",
  0x42: "TIMESTAMP",
  0x43: "NUMBER",
  0x44: "PREVRANDAO",
  0x45: "GASLIMIT",
  0x46: "CHAINID",
  0x47: "SELFBALANCE",
  0x48: "BASEFEE",
  0x49: "BLOBHASH",
  0x4a: "BLOBBASEFEE",
  0x50: "POP",
  0x51: "MLOAD",
  0x52: "MSTORE",
  0x53: "MSTORE8",
  0x54: "SLOAD",
  0x55: "SSTORE",
  0x56: "JUMP",
  0x57: "JUMPI",
  0x58: "PC",
  0x59: "MSIZE",
  0x5a: "GAS",
  0x5b: "JUMPDEST",
  0x5c: "TLOAD",
  0x5d: "TSTORE",
  0x5e: "MCOPY",
  0x5f: "PUSH0",
  0xa0: "LOG0",
  0xa1: "LOG1",
  0xa2: "LOG2",
  0xa3: "LOG3",
  0xa4: "LOG4",
  0xf0: "CREATE",
  0xf1: "CALL",
  0xf2: "CALLCODE",
  0xf3: "RETURN",
  0xf4: "DELEGATECALL",
  0xf5: "CREATE2",
  0xfa: "STATICCALL",
  0xfd: "REVERT",
  0xfe: "INVALID",
  0xff: "SELFDESTRUCT",
};

for (let i = 1; i <= 32; i++) NAMED_OPCODES[0x60 + i - 1] = `PUSH${i}`;
for (let i = 1; i <= 16; i++) NAMED_OPCODES[0x80 + i - 1] = `DUP${i}`;
for (let i = 1; i <= 16; i++) NAMED_OPCODES[0x90 + i - 1] = `SWAP${i}`;

/** Display name for a single opcode byte. Falls back to a hex literal for unknown ranges. */
export function opcodeMnemonic(byte: number): string {
  return NAMED_OPCODES[byte] ?? `INVALID(0x${byte.toString(16).padStart(2, "0").toUpperCase()})`;
}

/**
 * One disassembled instruction. `pc` is the byte offset where the
 * opcode begins; `bytes` is the full encoding (1 byte for most
 * opcodes, 1 + N for PUSH1..PUSH32). `immediate` is set only for
 * the PUSH family — for everything else it's `null`.
 */
export interface Instruction {
  pc: number;
  opcode: number;
  mnemonic: string;
  /**
   * Inline immediate for PUSH instructions, hex without `0x`
   * prefix. Exactly `width` bytes long. `null` for non-PUSH ops.
   */
  immediate: string | null;
}

/**
 * Walk `bytecodeHex` from `pc=0` to the end and return the linear
 * disassembly. PUSH operand bytes are folded onto the PUSH itself
 * (one Instruction with `immediate` set). The returned array is in
 * ascending PC order.
 *
 * Pure (no I/O); the DAP adapter caches the result per artifact
 * and slices windows out for `disassemble` requests.
 */
export function disassemble(bytecodeHex: string): Instruction[] {
  const bytes = hexToBytes(bytecodeHex);
  const out: Instruction[] = [];
  let pc = 0;
  while (pc < bytes.length) {
    const opcode = bytes[pc];
    const mnemonic = opcodeMnemonic(opcode);

    // PUSH0 (0x5f, EIP-3855) is a member of the push family but
    // takes zero immediate bytes — emit `immediate: ""` for it so
    // PUSH0 / PUSH1 / ... / PUSH32 all uniformly have a string.
    if (opcode === 0x5f) {
      out.push({ pc, opcode, mnemonic, immediate: "" });
      pc += 1;
      continue;
    }

    if (opcode >= 0x60 && opcode <= 0x7f) {
      const width = opcode - 0x60 + 1;
      const start = pc + 1;
      const end = Math.min(start + width, bytes.length);
      const immediateBytes = bytes.subarray(start, end);
      const immediate = bytesToHex(immediateBytes);
      out.push({ pc, opcode, mnemonic, immediate });
      pc = start + width;
      continue;
    }

    out.push({ pc, opcode, mnemonic, immediate: null });
    pc += 1;
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const stripped = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (stripped.length % 2 !== 0) {
    throw new Error("Bytecode hex string has odd length");
  }
  const out = new Uint8Array(stripped.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(stripped.substr(i * 2, 2), 16);
    if (!Number.isFinite(byte)) {
      throw new Error(`Invalid hex byte at offset ${i * 2}: '${stripped.substr(i * 2, 2)}'`);
    }
    out[i] = byte;
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}
