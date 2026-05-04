import type { Range } from "vscode-languageserver/node.js";

/**
 * Inverted index for fast reference lookups.
 *
 * Instead of scanning all files on every "find references" query,
 * we pre-build an index mapping symbol names to their occurrence locations.
 * The index is updated incrementally as files change.
 *
 * Structure: symbolName → [{ uri, range }, ...]
 */
export class ReferenceIndex {
  /** symbolName → occurrences */
  private index: Map<string, ReferenceEntry[]> = new Map();
  /** uri → set of symbol names found in that file */
  private fileSymbols: Map<string, Set<string>> = new Map();

  /**
   * Index all identifier occurrences in a file.
   *
   * Each line is first stripped of any block-commented regions (including
   * `/* ... *\/` contained entirely on one line and multi-line spans), then
   * stripped of any trailing `//` line comment, and the surviving code is
   * fed to the identifier regex.  Block-commented characters are replaced
   * with spaces rather than removed so that column offsets line up with the
   * original source — important because the resulting ranges are reported
   * back verbatim to LSP clients.
   */
  indexFile(uri: string, text: string): void {
    this.removeFile(uri);

    const identifiers = new Set<string>();
    const lines = text.split("\n");

    let inBlockComment = false;

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      const { code, stillInBlock } = this.stripBlockComments(lines[lineNum], inBlockComment);
      inBlockComment = stillInBlock;

      // Strip any trailing line comment.  The code already has block-commented
      // regions blanked out, so findCommentStart won't get confused by a `//`
      // that was itself inside a block comment.
      const commentIdx = this.findCommentStart(code);
      const codePart = commentIdx >= 0 ? code.slice(0, commentIdx) : code;

      this.indexLine(codePart, lineNum, uri, identifiers);
    }

    this.fileSymbols.set(uri, identifiers);
  }

  /**
   * Replace every `/* ... *\/` span on a line with spaces, preserving the
   * line's total length and every non-comment character's column.
   *
   * @param line     raw line text
   * @param inBlock  true if we entered the line already inside a block comment
   * @returns `{ code, stillInBlock }` where `code` is the masked text and
   *          `stillInBlock` indicates whether the block comment is still
   *          open at end of line.
   */
  private stripBlockComments(
    line: string,
    inBlock: boolean,
  ): { code: string; stillInBlock: boolean } {
    let out = "";
    let i = 0;
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf("*/", i);
        if (end === -1) {
          out += " ".repeat(line.length - i);
          return { code: out, stillInBlock: true };
        }
        out += " ".repeat(end + 2 - i);
        i = end + 2;
        inBlock = false;
      } else {
        const start = line.indexOf("/*", i);
        if (start === -1) {
          out += line.slice(i);
          return { code: out, stillInBlock: false };
        }
        out += line.slice(i, start);
        i = start;
        inBlock = true;
      }
    }
    return { code: out, stillInBlock: inBlock };
  }

  /**
   * Remove all entries for a file (called before re-indexing).
   */
  removeFile(uri: string): void {
    const symbols = this.fileSymbols.get(uri);
    if (!symbols) return;

    for (const name of symbols) {
      const entries = this.index.get(name);
      if (entries) {
        const filtered = entries.filter((e) => e.uri !== uri);
        if (filtered.length > 0) {
          this.index.set(name, filtered);
        } else {
          this.index.delete(name);
        }
      }
    }

    this.fileSymbols.delete(uri);
  }

  /**
   * Look up all references to a symbol name.
   */
  findReferences(name: string): ReferenceEntry[] {
    return this.index.get(name) ?? [];
  }

  /**
   * Check if a symbol exists anywhere in the index.
   */
  has(name: string): boolean {
    return this.index.has(name);
  }

  /**
   * Get the count of references to a symbol (fast, no array copy).
   */
  referenceCount(name: string): number {
    return this.index.get(name)?.length ?? 0;
  }

  private indexLine(line: string, lineNum: number, uri: string, identifiers: Set<string>): void {
    const identRe = /\b([a-zA-Z_$][\w$]*)\b/g;
    let match: RegExpExecArray | null;

    while ((match = identRe.exec(line)) !== null) {
      const name = match[1];
      const col = match.index;

      // Skip if inside a string literal
      if (this.isInString(line, col)) continue;

      identifiers.add(name);

      const entries = this.index.get(name) ?? [];
      entries.push({
        uri,
        range: {
          start: { line: lineNum, character: col },
          end: { line: lineNum, character: col + name.length },
        },
      });
      this.index.set(name, entries);
    }
  }

  private findCommentStart(line: string): number {
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < line.length - 1; i++) {
      if (line[i] === "'" && !inDouble && (i === 0 || line[i - 1] !== "\\")) {
        inSingle = !inSingle;
      } else if (line[i] === '"' && !inSingle && (i === 0 || line[i - 1] !== "\\")) {
        inDouble = !inDouble;
      } else if (line[i] === "/" && line[i + 1] === "/" && !inSingle && !inDouble) {
        return i;
      }
    }
    return -1;
  }

  private isInString(line: string, pos: number): boolean {
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < pos; i++) {
      if (line[i] === "'" && !inDouble && (i === 0 || line[i - 1] !== "\\")) {
        inSingle = !inSingle;
      } else if (line[i] === '"' && !inSingle && (i === 0 || line[i - 1] !== "\\")) {
        inDouble = !inDouble;
      }
    }
    return inSingle || inDouble;
  }
}

export interface ReferenceEntry {
  uri: string;
  range: Range;
}
