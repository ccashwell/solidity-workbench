/**
 * Parser for Mythril JSON analysis reports.
 *
 * Mythril is a Python-based symbolic-execution analyzer (`myth
 * analyze -o json <files>`). Its output shape depends on how many
 * targets you analyze in one invocation:
 *   - Single target: `{ "error": null, "issues": [...], "success": true }`
 *   - Multiple targets: `{ "<filename>": { "issues": [...], ... }, ... }`
 *   - Some versions emit the bare array of issues directly.
 *
 * This module is VSCode-free so the server's `node --test` runner
 * can exercise it; the `extension/src/analysis/mythril.ts` wrapper
 * maps the parsed shape onto `vscode.Diagnostic`.
 */

/**
 * Severity tier as Mythril reports it. Mythril's labels are
 * capitalised in the JSON; we normalise to lowercase for the parsed
 * shape to match the other analyzer parsers.
 */
export type MythrilSeverity = "high" | "medium" | "low" | "informational";

/**
 * A normalized Mythril finding. Each issue maps to one finding; the
 * extension wrapper turns each into a `vscode.Diagnostic`.
 */
export interface MythrilFinding {
  /** Mythril detector title (e.g. `"External Call To User-Supplied Address"`). */
  title: string;
  /** Mythril description text. */
  description: string;
  severity: MythrilSeverity;
  /** SWC registry id when available (`"107"` for the SWC-107 reentrancy class etc.). */
  swcId: string | null;
  /** Source file path Mythril reported. May be absolute or workspace-relative. */
  contractPath: string;
  /** 1-based line number of the issue. */
  line: number;
  /** Affected contract name (when Mythril knows it). */
  contract?: string;
  /** Affected function selector / signature (when Mythril knows it). */
  function?: string;
}

/**
 * Map a Mythril severity to the tri-state severity VSCode / LSP
 * exposes. High → error; Medium / Low → warning; Informational →
 * information.
 *
 * Renamed from a generic `severityLabel` to avoid colliding with
 * the same-named Aderyn helper at the flat re-export layer.
 */
export function mythrilSeverityLabel(
  severity: MythrilSeverity,
): "error" | "warning" | "info" {
  switch (severity) {
    case "high":
      return "error";
    case "medium":
    case "low":
      return "warning";
    case "informational":
      return "info";
  }
}

/**
 * Parse a Mythril JSON report into a flat list of findings. Returns
 * `[]` for invalid JSON, an unrecognized top-level shape, or zero
 * usable issues.
 *
 * Top-level shapes accepted:
 *   1. `{ "issues": [...], "success": ..., "error": ... }`
 *      — single-target invocation
 *   2. `{ "<filename>": { "issues": [...] }, ... }`
 *      — multi-target invocation (filename used as fallback when
 *      the issue itself doesn't carry one)
 *   3. `[ <issue>, <issue>, ... ]`
 *      — bare-array form (some Mythril versions / wrappers)
 *
 * Per-issue field-name fallbacks (defensive against minor schema
 * drift across Mythril versions):
 *   - title:        `title` | `name`
 *   - description:  `description` | `message`
 *   - severity:     `severity`
 *   - swcId:        `swc-id` | `swcID` | `swc_id`
 *   - filename:     `filename` | `source_unit_name` | `file`
 *   - line:         `lineno` | `line` | `line_number`
 */
export function parseMythrilReport(json: string): MythrilFinding[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }

  if (Array.isArray(raw)) {
    return raw.flatMap((entry) => parseIssueEntry(entry, undefined));
  }
  if (!raw || typeof raw !== "object") return [];

  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj.issues)) {
    return obj.issues.flatMap((entry) => parseIssueEntry(entry, undefined));
  }

  const findings: MythrilFinding[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (!value || typeof value !== "object") continue;
    const inner = value as Record<string, unknown>;
    if (!Array.isArray(inner.issues)) continue;
    for (const issue of inner.issues) {
      findings.push(...parseIssueEntry(issue, key));
    }
  }
  return findings;
}

function parseIssueEntry(entry: unknown, filenameFallback: string | undefined): MythrilFinding[] {
  if (!entry || typeof entry !== "object") return [];
  const e = entry as Record<string, unknown>;

  const title = readString(e, ["title", "name"]);
  const severity = normalizeSeverity(readString(e, ["severity"]));
  if (!title || !severity) return [];

  const contractPath =
    readString(e, ["filename", "source_unit_name", "file"]) ?? filenameFallback;
  if (!contractPath) return [];

  const line = readNumber(e, ["lineno", "line", "line_number"]);
  if (line === undefined || line < 1) return [];

  const description = readString(e, ["description", "message"]) ?? "";
  const swcId = readString(e, ["swc-id", "swcID", "swc_id"]) ?? null;
  const contract = readString(e, ["contract"]);
  const fn = readString(e, ["function"]);

  return [
    {
      title,
      description,
      severity,
      swcId,
      contractPath,
      line,
      ...(contract ? { contract } : {}),
      ...(fn ? { function: fn } : {}),
    },
  ];
}

function readString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function readNumber(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function normalizeSeverity(raw: string | undefined): MythrilSeverity | undefined {
  if (!raw) return undefined;
  switch (raw.toLowerCase()) {
    case "high":
      return "high";
    case "medium":
      return "medium";
    case "low":
      return "low";
    case "informational":
    case "info":
    case "information":
      return "informational";
    default:
      return undefined;
  }
}

/** Count findings at each severity tier. Used by the output-channel summary. */
export function summarizeMythril(findings: MythrilFinding[]): {
  high: number;
  medium: number;
  low: number;
  informational: number;
  total: number;
} {
  let high = 0;
  let medium = 0;
  let low = 0;
  let informational = 0;
  for (const f of findings) {
    switch (f.severity) {
      case "high":
        high += 1;
        break;
      case "medium":
        medium += 1;
        break;
      case "low":
        low += 1;
        break;
      case "informational":
        informational += 1;
        break;
    }
  }
  return { high, medium, low, informational, total: high + medium + low + informational };
}
