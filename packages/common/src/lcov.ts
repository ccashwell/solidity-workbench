/**
 * LCOV tracefile parser.
 *
 * Only covers the subset of records that `forge coverage --report lcov`
 * emits: `SF`, `DA`, `BRDA`, `FN`, `FNDA`, `LF`, `LH`, `BRF`, `BRH`,
 * `FNF`, `FNH`, `end_of_record`. Anything else is ignored.
 *
 * The parser is deliberately kept free of VSCode / Node runtime
 * dependencies so it can live in `@solidity-workbench/common`, be
 * unit-tested by the server package's `node --test` runner, and be
 * reused by any other consumer that wants to understand forge
 * coverage output.
 */

export interface FileCoverage {
  /** Path as it appeared in the `SF:` record (typically workspace-relative). */
  file: string;
  /** Map of 1-based line number → hit count. */
  lines: Map<number, number>;
  /** Raw branch records for partial-coverage analysis. */
  branches: BranchRecord[];
  lineTotal: number;
  lineHit: number;
  branchTotal: number;
  branchHit: number;
  fnTotal: number;
  fnHit: number;
}

export interface BranchRecord {
  line: number;
  branchId: string;
  taken: number;
}

/**
 * Parse LCOV tracefile text into a map of file path → FileCoverage.
 *
 * Semantics:
 *   - Every `SF:path` starts a new file record.
 *   - `DA:line,hits` accumulates hits if the same line appears twice.
 *   - `BRDA:line,block,branch,taken` records branch taken-counts; a
 *     taken value of `"-"` is normalised to `0`.
 *   - `end_of_record` commits the current file record. When `LF` / `LH`
 *     haven't been emitted, we derive them from the collected `DA`
 *     records so `FileCoverage.lineTotal` / `.lineHit` are always
 *     populated.
 */
export function parseLcov(text: string): Map<string, FileCoverage> {
  const result = new Map<string, FileCoverage>();
  let current: FileCoverage | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line === "end_of_record") {
      if (current) {
        if (current.lineTotal === 0) current.lineTotal = current.lines.size;
        if (current.lineHit === 0) {
          let hit = 0;
          for (const hits of current.lines.values()) if (hits > 0) hit++;
          current.lineHit = hit;
        }
        result.set(current.file, current);
      }
      current = null;
      continue;
    }

    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;
    const tag = line.slice(0, colonIdx);
    const payload = line.slice(colonIdx + 1);

    if (tag === "SF") {
      current = {
        file: payload,
        lines: new Map(),
        branches: [],
        lineTotal: 0,
        lineHit: 0,
        branchTotal: 0,
        branchHit: 0,
        fnTotal: 0,
        fnHit: 0,
      };
      continue;
    }

    if (!current) continue;

    switch (tag) {
      case "DA": {
        const parts = payload.split(",");
        const lineNo = parseInt(parts[0], 10);
        const hits = parseInt(parts[1] ?? "0", 10);
        if (!Number.isFinite(lineNo)) break;
        current.lines.set(lineNo, (current.lines.get(lineNo) ?? 0) + (hits || 0));
        break;
      }
      case "BRDA": {
        const parts = payload.split(",");
        if (parts.length < 4) break;
        const lineNo = parseInt(parts[0], 10);
        const branchId = `${parts[1]}/${parts[2]}`;
        const takenStr = parts[3];
        const taken = takenStr === "-" ? 0 : parseInt(takenStr, 10);
        if (!Number.isFinite(lineNo)) break;
        current.branches.push({ line: lineNo, branchId, taken: taken || 0 });
        break;
      }
      case "LF":
        current.lineTotal = parseInt(payload, 10) || 0;
        break;
      case "LH":
        current.lineHit = parseInt(payload, 10) || 0;
        break;
      case "BRF":
        current.branchTotal = parseInt(payload, 10) || 0;
        break;
      case "BRH":
        current.branchHit = parseInt(payload, 10) || 0;
        break;
      case "FNF":
        current.fnTotal = parseInt(payload, 10) || 0;
        break;
      case "FNH":
        current.fnHit = parseInt(payload, 10) || 0;
        break;
      default:
        break;
    }
  }

  return result;
}

/**
 * Bucket each branch-bearing line into `fully` / `partial` / `missed`:
 *   - `fully`:   every branch on that line has `taken > 0`
 *   - `partial`: some branches taken, some not
 *   - `missed`:  no branches taken
 */
export function summarizeBranches(
  branches: BranchRecord[],
): Map<number, "fully" | "partial" | "missed"> {
  const byLine = new Map<number, { total: number; taken: number }>();

  for (const br of branches) {
    const entry = byLine.get(br.line) ?? { total: 0, taken: 0 };
    entry.total += 1;
    if (br.taken > 0) entry.taken += 1;
    byLine.set(br.line, entry);
  }

  const out = new Map<number, "fully" | "partial" | "missed">();
  for (const [line, { total, taken }] of byLine) {
    if (taken === 0) out.set(line, "missed");
    else if (taken === total) out.set(line, "fully");
    else out.set(line, "partial");
  }
  return out;
}
