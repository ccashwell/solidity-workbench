/**
 * Solidity source-map decoder + program-counter ↔ instruction-index
 * mapping. Foundational piece of the Solidity Workbench DAP debug
 * adapter: every step the user takes resolves an EVM program counter
 * back to a Solidity source position via these helpers.
 *
 * Solc emits a `sourceMap` string per compiled artifact (one for the
 * creation bytecode under `evm.bytecode.sourceMap`, one for the
 * runtime bytecode under `evm.deployedBytecode.sourceMap`). The
 * format and decoding rules are documented at:
 *
 *     https://docs.soliditylang.org/en/latest/internals/source_mappings.html
 *
 * Briefly:
 *
 *   sourceMap := entry (";" entry)*
 *   entry     := s ":" l ":" f ":" j ":" m
 *
 * where each field MAY be omitted to inherit the previous entry's
 * value, and trailing fields may be dropped entirely. The entries
 * are aligned 1-to-1 with the *instruction sequence* of the
 * bytecode — NOT the program counter, since PUSH opcodes carry
 * inline operand bytes that don't have their own entries. Resolving
 * a PC to a source position therefore requires walking the bytecode
 * once to build a PC → instruction-index table.
 *
 * `f === -1` is the canonical signal for "this opcode has no
 * associated source" (compiler-generated helpers, immutable
 * placeholders, etc.). Callers should treat that as "skip" rather
 * than producing a spurious source frame.
 */

export type JumpKind = "i" | "o" | "-";

/**
 * One decompressed source-map entry. Aligned with the instruction at
 * `instructionIndex` in the bytecode (NOT with a program counter).
 */
export interface SourceMapEntry {
  /** Byte offset of the originating source range. */
  start: number;
  /** Byte length of the originating source range. */
  length: number;
  /** Index into the compilation's `sources` array, or `-1` for none. */
  fileIndex: number;
  /** `i` = function-call entry, `o` = function-call return, `-` = regular. */
  jump: JumpKind;
  /** Solidity 0.6.0+ modifier depth. `0` for code outside any modifier. */
  modifierDepth: number;
}

const DEFAULT_ENTRY: SourceMapEntry = {
  start: 0,
  length: 0,
  fileIndex: -1,
  jump: "-",
  modifierDepth: 0,
};

/**
 * Decompress a solc `sourceMap` string into one entry per
 * instruction. Each empty field inherits from the previous entry;
 * trailing-field omission is also handled. Returns `[]` for an empty
 * input (which is what solc emits for interfaces / abstract
 * contracts that have no bytecode).
 *
 * The parser is permissive: malformed numeric fields fall back to
 * the previous entry's value rather than throwing, since real-world
 * artifacts occasionally include odd whitespace or stray characters
 * around the boundaries.
 */
export function parseSourceMap(input: string): SourceMapEntry[] {
  if (input.length === 0) return [];
  const segments = input.split(";");
  const out: SourceMapEntry[] = [];
  let prev: SourceMapEntry = DEFAULT_ENTRY;
  for (const seg of segments) {
    const fields = seg.split(":");
    const start = parseField(fields[0], prev.start);
    const length = parseField(fields[1], prev.length);
    const fileIndex = parseField(fields[2], prev.fileIndex);
    const jump = parseJump(fields[3], prev.jump);
    const modifierDepth = parseField(fields[4], prev.modifierDepth);
    const entry: SourceMapEntry = { start, length, fileIndex, jump, modifierDepth };
    out.push(entry);
    prev = entry;
  }
  return out;
}

function parseField(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseJump(value: string | undefined, fallback: JumpKind): JumpKind {
  if (value === undefined || value === "") return fallback;
  if (value === "i" || value === "o" || value === "-") return value;
  return fallback;
}

// ── Program-counter ↔ instruction-index mapping ─────────────────────

/** PUSH1..PUSH32 occupy opcodes 0x60..0x7f. */
const PUSH1 = 0x60;
const PUSH32 = 0x7f;
/** PUSH0 (EIP-3855, Shanghai) takes a 0-byte operand. */
const PUSH0 = 0x5f;

/**
 * Given the deployed bytecode as a hex string (with or without a
 * `0x` prefix), return an array `pcToInstructionIndex` such that
 * `pcToInstructionIndex[pc]` is the instruction index for the
 * opcode whose first byte sits at program counter `pc`. PCs that
 * fall in the middle of a PUSH's inline operand bytes map back to
 * the index of the PUSH itself — the natural reading for "what
 * source position does the PC correspond to."
 *
 * The output array length equals the bytecode length so callers can
 * index by PC without a bounds check after a successful disassembly.
 */
export function buildPcToInstructionIndex(bytecodeHex: string): number[] {
  const bytes = hexToBytes(bytecodeHex);
  const result = new Array<number>(bytes.length).fill(0);
  let instructionIndex = 0;
  let pc = 0;
  while (pc < bytes.length) {
    const opcode = bytes[pc];
    let width = 1;
    if (opcode >= PUSH1 && opcode <= PUSH32) {
      width = 1 + (opcode - PUSH1 + 1);
    } else if (opcode === PUSH0) {
      width = 1;
    }
    for (let i = 0; i < width && pc + i < bytes.length; i++) {
      result[pc + i] = instructionIndex;
    }
    pc += width;
    instructionIndex += 1;
  }
  return result;
}

/**
 * Look up the source-map entry that corresponds to program counter
 * `pc`. Returns `null` when:
 *
 *   - `pc` is out of range for the supplied PC table, or
 *   - the resolved instruction index has no entry (sourceMap shorter
 *     than the bytecode — unusual but recoverable), or
 *   - the entry's `fileIndex` is `-1` (compiler-generated helper).
 *
 * The `null` return is what most callers want: a debug adapter
 * should skip generated opcodes rather than freeze the user on a
 * missing-source line.
 */
export function resolveSourcePosition(
  pc: number,
  pcMap: number[],
  sourceMap: SourceMapEntry[],
): SourceMapEntry | null {
  if (pc < 0 || pc >= pcMap.length) return null;
  const idx = pcMap[pc];
  const entry = sourceMap[idx];
  if (!entry) return null;
  if (entry.fileIndex < 0) return null;
  return entry;
}

/**
 * Strip an optional `0x` / `0X` prefix and decode the remaining hex
 * digits to a Uint8Array. Throws on odd-length inputs because that
 * would silently truncate the last nibble.
 */
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
