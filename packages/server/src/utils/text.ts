import type { Position, Range } from "vscode-languageserver/node.js";

/**
 * Shared text utilities for the LSP server.
 * Eliminates duplication of getWordAtPosition, keyword checks, etc.
 */

export interface WordAtPosition {
  text: string;
  range: Range;
}

/**
 * Get the word at a given position in a text document.
 * A "word" is a contiguous sequence of [a-zA-Z0-9_$] characters.
 */
export function getWordAtPosition(text: string, position: Position): WordAtPosition | null {
  const lines = text.split("\n");
  if (position.line >= lines.length) return null;
  const line = lines[position.line];
  if (position.character > line.length) return null;

  let start = position.character;
  let end = position.character;
  while (start > 0 && /[\w$]/.test(line[start - 1])) start--;
  while (end < line.length && /[\w$]/.test(line[end])) end++;

  if (start === end) return null;

  return {
    text: line.slice(start, end),
    range: {
      start: { line: position.line, character: start },
      end: { line: position.line, character: end },
    },
  };
}

/**
 * Get the raw word string at a position (no range info).
 */
export function getWordTextAtPosition(
  text: string,
  line: number,
  character: number,
): string | null {
  const result = getWordAtPosition(text, { line, character });
  return result?.text ?? null;
}

/**
 * Solidity keywords — used across multiple providers for filtering.
 */
export const SOLIDITY_KEYWORDS = new Set([
  "pragma",
  "import",
  "contract",
  "interface",
  "library",
  "abstract",
  "function",
  "modifier",
  "event",
  "error",
  "struct",
  "enum",
  "mapping",
  "constructor",
  "receive",
  "fallback",
  "public",
  "private",
  "internal",
  "external",
  "pure",
  "view",
  "payable",
  "virtual",
  "override",
  "immutable",
  "constant",
  "memory",
  "storage",
  "calldata",
  "if",
  "else",
  "for",
  "while",
  "do",
  "break",
  "continue",
  "return",
  "try",
  "catch",
  "revert",
  "require",
  "assert",
  "emit",
  "new",
  "delete",
  "type",
  "assembly",
  "unchecked",
  "using",
  "is",
  "as",
  "true",
  "false",
  "this",
  "super",
  "bool",
  "address",
  "string",
  "bytes",
  "uint",
  "int",
  "uint256",
  "int256",
  "msg",
  "block",
  "tx",
  "abi",
]);

/**
 * Keywords that look like function calls but aren't
 * (for call hierarchy, inlay hints, etc.)
 */
export const CALL_LIKE_KEYWORDS = new Set([
  "if",
  "else",
  "for",
  "while",
  "do",
  "return",
  "require",
  "assert",
  "revert",
  "emit",
  "new",
  "delete",
  "type",
  "try",
  "catch",
  "mapping",
  "assembly",
  "unchecked",
  "super",
  "this",
]);

/**
 * Built-in Solidity types (for filtering type casts from function calls).
 */
export function isSolidityBuiltinType(name: string): boolean {
  return /^(uint|int|bytes|bool|address|string)\d*$/.test(name) || name === "byte";
}

/**
 * Check if a position is inside a string literal on a given line.
 */
export function isInsideString(line: string, position: number): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < position; i++) {
    if (line[i] === "'" && !inDouble && (i === 0 || line[i - 1] !== "\\")) {
      inSingle = !inSingle;
    } else if (line[i] === '"' && !inSingle && (i === 0 || line[i - 1] !== "\\")) {
      inDouble = !inDouble;
    }
  }
  return inSingle || inDouble;
}

/**
 * Find the start of a line comment (//) outside of strings.
 * Returns -1 if no line comment found.
 */
export function findLineCommentStart(line: string): number {
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < line.length - 1; i++) {
    const ch = line[i];
    const next = line[i + 1];

    if (ch === "'" && !inDouble && (i === 0 || line[i - 1] !== "\\")) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle && (i === 0 || line[i - 1] !== "\\")) {
      inDouble = !inDouble;
    } else if (ch === "/" && next === "/" && !inSingle && !inDouble) {
      return i;
    }
  }

  return -1;
}
