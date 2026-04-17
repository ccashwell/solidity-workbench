/**
 * Parser for Aderyn (by Cyfrin) JSON reports.
 *
 * Aderyn is a Rust-based Solidity static analyzer. Its JSON output
 * (written via `aderyn --output report.json`) groups findings by
 * severity into `high_issues`, `low_issues`, and `nc_issues`
 * ("non-critical"). Each issue carries a detector name, a description,
 * and a list of instance locations.
 *
 * This module is intentionally VSCode-free: it's consumed by the
 * `extension/src/analysis/aderyn.ts` wrapper, which maps the parsed
 * shape onto `vscode.Diagnostic`. Keeping the parse + severity logic
 * here means we can exercise it from the server's `node --test`
 * runner (mirroring how the LCOV parser is organized).
 */

/**
 * Severity tier as Aderyn reports it. Maps 1:1 onto the top-level
 * JSON keys (`high_issues`, `low_issues`, `nc_issues`).
 */
export type AderynSeverity = "high" | "low" | "nc";

/**
 * A normalized Aderyn finding. One finding may have many instances;
 * consumers typically emit one diagnostic per instance, treating the
 * other instances as related-information links.
 */
export interface AderynFinding {
  severity: AderynSeverity;
  /** Aderyn detector identifier (e.g. `"reentrancy-state-change"`). */
  detector: string;
  /** Human-readable finding title. */
  title: string;
  /** Markdown-flavored detector description. */
  description: string;
  instances: AderynInstance[];
}

/**
 * A single code location flagged by the detector. `contractPath` is
 * whatever Aderyn wrote (relative to the project root when Aderyn was
 * invoked at the root, absolute otherwise). `line` is 1-based to
 * match Aderyn's `line_no` field; callers convert to 0-based for LSP.
 */
export interface AderynInstance {
  contractPath: string;
  line: number;
}

/**
 * Mapping from Aderyn's severity buckets to the tri-state severity
 * level VSCode / LSP exposes. `nc` becomes `info` because non-critical
 * issues are almost always stylistic / documentation nits.
 */
export function severityLabel(severity: AderynSeverity): "error" | "warning" | "info" {
  switch (severity) {
    case "high":
      return "error";
    case "low":
      return "warning";
    case "nc":
      return "info";
  }
}

/**
 * Parse an Aderyn JSON report into a flat list of findings.
 *
 * Returns `[]` when the input isn't valid JSON, lacks the expected
 * top-level shape, or contains zero findings. Empty or malformed
 * instance lists are skipped silently — a detector with no locations
 * can't produce a useful diagnostic anyway.
 *
 * The parser tolerates minor schema drift: unknown severity buckets
 * are ignored, missing `detector_name` falls back to `title`, and
 * missing `title` falls back to `detector_name`. This keeps us
 * resilient across Aderyn versions without silent data corruption.
 */
export function parseAderynReport(json: string): AderynFinding[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!raw || typeof raw !== "object") return [];

  const report = raw as Record<string, unknown>;
  const findings: AderynFinding[] = [];

  const buckets: { key: string; severity: AderynSeverity }[] = [
    { key: "high_issues", severity: "high" },
    { key: "low_issues", severity: "low" },
    { key: "nc_issues", severity: "nc" },
  ];

  for (const { key, severity } of buckets) {
    const bucket = report[key];
    if (!bucket || typeof bucket !== "object") continue;
    const issues = (bucket as { issues?: unknown }).issues;
    if (!Array.isArray(issues)) continue;

    for (const entry of issues) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;

      const title = typeof e.title === "string" ? e.title : undefined;
      const detector = typeof e.detector_name === "string" ? e.detector_name : undefined;
      const description = typeof e.description === "string" ? e.description : "";

      const effectiveTitle = title ?? detector;
      const effectiveDetector = detector ?? title;
      if (!effectiveTitle || !effectiveDetector) continue;

      const instances = parseInstances(e.instances);
      if (instances.length === 0) continue;

      findings.push({
        severity,
        detector: effectiveDetector,
        title: effectiveTitle,
        description,
        instances,
      });
    }
  }

  return findings;
}

function parseInstances(raw: unknown): AderynInstance[] {
  if (!Array.isArray(raw)) return [];
  const out: AderynInstance[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const contractPath = typeof e.contract_path === "string" ? e.contract_path : undefined;
    const line = typeof e.line_no === "number" ? e.line_no : undefined;
    if (!contractPath || line === undefined || line < 1) continue;
    out.push({ contractPath, line });
  }
  return out;
}

/**
 * Count findings at each severity. Convenience helper for status-bar
 * / summary output.
 */
export function summarizeAderyn(findings: AderynFinding[]): {
  high: number;
  low: number;
  nc: number;
  total: number;
} {
  let high = 0;
  let low = 0;
  let nc = 0;
  for (const f of findings) {
    switch (f.severity) {
      case "high":
        high += 1;
        break;
      case "low":
        low += 1;
        break;
      case "nc":
        nc += 1;
        break;
    }
  }
  return { high, low, nc, total: high + low + nc };
}
