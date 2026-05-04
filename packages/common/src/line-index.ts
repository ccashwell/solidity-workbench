/**
 * LineIndex maps between byte offsets (as reported by solc) and LSP
 * Position objects. Correctly handles CRLF line endings and UTF-8
 * multibyte characters.
 *
 * solc emits source locations as UTF-8 byte offsets. LSP Position uses
 * zero-based line plus UTF-16 code-unit character offset (i.e. the
 * natural JavaScript string index). The naive "split on \n, use
 * .length" approach is wrong on two axes:
 *
 *  1. `\r` bytes are silently dropped, so CRLF files are off-by-one
 *     per preceding line.
 *  2. `.length` counts UTF-16 code units, not UTF-8 bytes, so any
 *     non-ASCII character causes drift.
 *
 * This class walks the text once, records the byte offset of every
 * line start, and resolves byte offsets by decoding the relevant
 * prefix of the enclosing line back to a JS string.
 *
 * Lives in `@solidity-workbench/common` so both the LSP server (for
 * mapping forge-build diagnostics) and the extension's DAP debug
 * adapter (for mapping source-map byte ranges to file:line) can
 * share one canonical implementation.
 */
export class LineIndex {
  private readonly lineStartBytes: number[];
  private readonly lineTexts: string[];
  private readonly totalBytes: number;

  private constructor(lineStartBytes: number[], lineTexts: string[], totalBytes: number) {
    this.lineStartBytes = lineStartBytes;
    this.lineTexts = lineTexts;
    this.totalBytes = totalBytes;
  }

  /**
   * Build a LineIndex by walking the text once. Both "\n" and "\r\n"
   * are treated as a single line terminator; a lone "\r" is also
   * treated as a terminator (rare, but seen in legacy files).
   */
  static fromText(text: string): LineIndex {
    const lineStartBytes: number[] = [0];
    const lineTexts: string[] = [];

    let lineStartChar = 0;
    let byteOffset = 0;
    let i = 0;

    while (i < text.length) {
      const ch = text[i];
      if (ch === "\r" || ch === "\n") {
        const lineText = text.slice(lineStartChar, i);
        lineTexts.push(lineText);
        byteOffset += Buffer.byteLength(lineText, "utf8");

        if (ch === "\r" && i + 1 < text.length && text[i + 1] === "\n") {
          byteOffset += 2;
          i += 2;
        } else {
          byteOffset += 1;
          i += 1;
        }

        lineStartBytes.push(byteOffset);
        lineStartChar = i;
      } else {
        i += 1;
      }
    }

    const finalLine = text.slice(lineStartChar);
    lineTexts.push(finalLine);
    byteOffset += Buffer.byteLength(finalLine, "utf8");

    return new LineIndex(lineStartBytes, lineTexts, byteOffset);
  }

  /**
   * Convert a UTF-8 byte offset to an LSP Position.
   * Position.character is a UTF-16 code-unit offset (JS string index).
   *
   * Clamping rules:
   *  - offset <= 0 → line 0, character 0
   *  - offset >= total bytes → last line, last character
   *  - offset inside a CRLF terminator → end of the preceding line
   *  - offset past a line's content but before the next line's start
   *    → end of that line (treated as the terminator region)
   */
  positionAt(byteOffset: number): { line: number; character: number } {
    if (byteOffset <= 0) {
      return { line: 0, character: 0 };
    }

    if (byteOffset >= this.totalBytes) {
      const lastLine = this.lineTexts.length - 1;
      return { line: lastLine, character: this.lineTexts[lastLine].length };
    }

    let lo = 0;
    let hi = this.lineStartBytes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (this.lineStartBytes[mid] <= byteOffset) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }

    const line = lo;
    const lineStart = this.lineStartBytes[line];
    const inLineByteOffset = byteOffset - lineStart;
    const lineText = this.lineTexts[line];
    const lineByteLen = Buffer.byteLength(lineText, "utf8");

    if (inLineByteOffset >= lineByteLen) {
      return { line, character: lineText.length };
    }

    const lineBuffer = Buffer.from(lineText, "utf8");
    const prefix = lineBuffer.subarray(0, inLineByteOffset).toString("utf8");
    return { line, character: prefix.length };
  }
}
