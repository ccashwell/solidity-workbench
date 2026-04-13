import type { Location, Range } from "vscode-languageserver/node.js";

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
   */
  indexFile(uri: string, text: string): void {
    // Remove old entries for this file
    this.removeFile(uri);

    const identifiers = new Set<string>();
    const lines = text.split("\n");
    const identRe = /\b([a-zA-Z_$][\w$]*)\b/g;

    let inBlockComment = false;

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      const line = lines[lineNum];

      // Track block comments
      if (inBlockComment) {
        if (line.includes("*/")) {
          inBlockComment = false;
        }
        continue;
      }
      if (line.includes("/*") && !line.includes("*/")) {
        inBlockComment = true;
        // Index the part before the comment
        const codePart = line.slice(0, line.indexOf("/*"));
        this.indexLine(codePart, lineNum, uri, identifiers);
        continue;
      }

      // Skip pure line comments
      const trimmed = line.trimStart();
      if (trimmed.startsWith("//")) continue;

      // Handle inline comments
      const commentIdx = this.findCommentStart(line);
      const codePart = commentIdx >= 0 ? line.slice(0, commentIdx) : line;

      this.indexLine(codePart, lineNum, uri, identifiers);
    }

    this.fileSymbols.set(uri, identifiers);
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
