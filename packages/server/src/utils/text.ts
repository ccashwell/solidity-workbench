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
 * Compute, for each line of `text`, the half-open `[startCol, endCol)`
 * column ranges that fall inside a comment. Handles `//` line, `///`
 * doc, and `/* ... *\/` block comments — including block comments that
 * span multiple lines. String literals are skipped so a `"//"` in a
 * string is not misclassified as a comment.
 *
 * Lines with no comment content are absent from the returned map.
 */
export function findCommentRanges(text: string): Map<number, Array<[number, number]>> {
  const out = new Map<number, Array<[number, number]>>();
  const lines = text.split("\n");
  let inBlock = false;

  for (let l = 0; l < lines.length; l++) {
    const line = lines[l];
    const lineRanges: Array<[number, number]> = [];
    let col = 0;

    while (col < line.length) {
      if (inBlock) {
        const closeIdx = line.indexOf("*/", col);
        if (closeIdx === -1) {
          lineRanges.push([col, line.length]);
          col = line.length;
        } else {
          lineRanges.push([col, closeIdx + 2]);
          col = closeIdx + 2;
          inBlock = false;
        }
        continue;
      }

      const ch = line[col];
      if (ch === '"' || ch === "'") {
        const quote = ch;
        col++;
        while (col < line.length) {
          if (line[col] === "\\") {
            col += 2;
            continue;
          }
          if (line[col] === quote) {
            col++;
            break;
          }
          col++;
        }
        continue;
      }

      const next = col + 1 < line.length ? line[col + 1] : "";
      if (ch === "/" && next === "/") {
        lineRanges.push([col, line.length]);
        col = line.length;
        continue;
      }
      if (ch === "/" && next === "*") {
        const closeIdx = line.indexOf("*/", col + 2);
        if (closeIdx === -1) {
          lineRanges.push([col, line.length]);
          inBlock = true;
          col = line.length;
        } else {
          lineRanges.push([col, closeIdx + 2]);
          col = closeIdx + 2;
        }
        continue;
      }

      col++;
    }

    if (lineRanges.length > 0) out.set(l, lineRanges);
  }

  return out;
}

/**
 * True if `col` falls inside any comment range previously computed by
 * `findCommentRanges` for this line.
 */
export function isPositionInCommentRanges(
  ranges: Map<number, Array<[number, number]>>,
  line: number,
  col: number,
): boolean {
  const list = ranges.get(line);
  if (!list) return false;
  for (const [s, e] of list) {
    if (col >= s && col < e) return true;
  }
  return false;
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
