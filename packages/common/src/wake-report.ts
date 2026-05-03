/**
 * Parser for Wake (Ackee Blockchain) JSON detector reports.
 *
 * Wake is a Python-based Solidity static-analysis framework. Its
 * machine-readable output (`wake detect all --output-format json`)
 * emits a list of detections, each with an `impact` severity, a
 * `confidence` rating, a `message`, and one-or-more source-location
 * "subdetections". Wake's JSON shape has evolved across releases, so
 * this parser accepts a small handful of historically-used field
 * names per attribute and documents the canonical mapping below.
 *
 * Like the Aderyn parser, this module is intentionally VSCode-free —
 * the `extension/src/analysis/wake.ts` wrapper maps the parsed shape
 * onto `vscode.Diagnostic`. Keeping the JSON-touching code here
 * lets the server's `node --test` runner exercise it directly.
 */

/**
 * Wake's tri-state-plus impact level. The `info`/`warning` tiers are
 * present on some detectors and treated as `info` and `low`
 * respectively by VSCode (see `severityLabel`).
 */
export type WakeImpact = "high" | "medium" | "low" | "warning" | "info";

/** Wake's confidence rating for the finding. Surfaced verbatim in the diagnostic message. */
export type WakeConfidence = "high" | "medium" | "low";

/** A normalized Wake finding. */
export interface WakeFinding {
  detector: string;
  impact: WakeImpact;
  confidence: WakeConfidence;
  message: string;
  instances: WakeInstance[];
}

/**
 * A single source-location flagged by a detector. Wake reports
 * source paths as `source_unit_name` (relative to the project root
 * when invoked at the root). Line numbers are 1-based; columns are
 * 1-based. The `endLine` / `endColumn` are present for multi-line
 * spans; renderers can fall back to the start position alone.
 */
export interface WakeInstance {
  contractPath: string;
  line: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

/**
 * Map a Wake impact to the tri-state severity VSCode / LSP exposes.
 * High → error, medium/low/warning → warning, info → information.
 *
 * Renamed from a generic `severityLabel` to avoid colliding with the
 * same-named Aderyn helper at the flat re-export layer.
 */
export function wakeSeverityLabel(impact: WakeImpact): "error" | "warning" | "info" {
  switch (impact) {
    case "high":
      return "error";
    case "medium":
    case "low":
    case "warning":
      return "warning";
    case "info":
      return "info";
  }
}

/**
 * Parse a Wake JSON detector report into a flat list of findings.
 *
 * The top level may be either:
 *   - A bare array of detections (older Wake), or
 *   - `{ "detections": [...] }` (newer Wake).
 *
 * Returns `[]` when the input doesn't parse, doesn't match either
 * shape, or contains zero usable instances. Detections that lack a
 * detector name, severity, or any location are dropped silently —
 * they cannot produce a useful diagnostic.
 *
 * Per-detection field-name fallbacks (handled defensively to absorb
 * minor schema drift across Wake versions):
 *   - detector:    `detector_name` | `detector` | `name`
 *   - impact:      `impact` | `severity`
 *   - confidence:  `confidence` (default "medium")
 *   - message:     `message` | `description` | `title`
 *   - locations:   `subdetections` | `instances` | `locations`
 *                  + the detection itself if it carries inline
 *                    location fields (`source_unit_name`, `line_from`,
 *                    etc.)
 */
export function parseWakeReport(json: string): WakeFinding[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }

  let detections: unknown;
  if (Array.isArray(raw)) {
    detections = raw;
  } else if (raw && typeof raw === "object") {
    detections = (raw as Record<string, unknown>).detections;
  }
  if (!Array.isArray(detections)) return [];

  const findings: WakeFinding[] = [];
  for (const entry of detections) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;

    const detector = readString(e, ["detector_name", "detector", "name"]);
    const impact = normalizeImpact(readString(e, ["impact", "severity"]));
    if (!detector || !impact) continue;

    const confidence = normalizeConfidence(readString(e, ["confidence"]));
    const message = readString(e, ["message", "description", "title"]) ?? "";

    const instances = collectInstances(e);
    if (instances.length === 0) continue;

    findings.push({ detector, impact, confidence, message, instances });
  }

  return findings;
}

function readString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function normalizeImpact(raw: string | undefined): WakeImpact | undefined {
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  switch (lower) {
    case "high":
    case "medium":
    case "low":
    case "warning":
    case "info":
      return lower;
    case "informational":
    case "information":
      return "info";
    default:
      return undefined;
  }
}

function normalizeConfidence(raw: string | undefined): WakeConfidence {
  if (!raw) return "medium";
  const lower = raw.toLowerCase();
  if (lower === "high" || lower === "medium" || lower === "low") return lower;
  return "medium";
}

/**
 * Wake encodes locations in two interleaved patterns we have to
 * support:
 *   - Inline on the detection object — `source_unit_name`, `line_from`,
 *     `line_to`, `col_from`, `col_to`, or the older `location.start: [line, col]`.
 *   - Nested under `subdetections` / `instances` / `locations` — each
 *     element is shaped like the inline pattern above.
 *
 * We collect from both sources, dedupe by `(path, line, column)`, and
 * return the union. Empty arrays result in zero instances and the
 * detection is dropped by the caller.
 */
function collectInstances(detection: Record<string, unknown>): WakeInstance[] {
  const seen = new Set<string>();
  const out: WakeInstance[] = [];

  const tryPush = (inst: WakeInstance | null): void => {
    if (!inst) return;
    const key = `${inst.contractPath}:${inst.line}:${inst.column ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(inst);
  };

  tryPush(parseInstance(detection));

  for (const key of ["subdetections", "instances", "locations"] as const) {
    const arr = detection[key];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (item && typeof item === "object") {
        tryPush(parseInstance(item as Record<string, unknown>));
      }
    }
  }

  return out;
}

/**
 * Parse a single location entry. Accepts inline fields
 * (`source_unit_name` / `line_from` / `col_from`) or a nested
 * `location` object with `start: [line, col]` / `end: [line, col]`,
 * which is what some Wake versions emit. Returns `null` when no
 * recognisable path or line is found.
 */
function parseInstance(obj: Record<string, unknown>): WakeInstance | null {
  const contractPath = readString(obj, ["source_unit_name", "file", "path", "contract_path"]);
  if (!contractPath) return null;

  const lineInline = readNumber(obj, ["line_from", "line", "start_line", "lineFrom", "line_no"]);
  const endLineInline = readNumber(obj, ["line_to", "end_line", "lineTo"]);
  const columnInline = readNumber(obj, ["col_from", "column", "start_col", "colFrom"]);
  const endColumnInline = readNumber(obj, ["col_to", "end_col", "colTo"]);

  let line = lineInline;
  let endLine = endLineInline;
  let column = columnInline;
  let endColumn = endColumnInline;

  // `location: { start: [line, col], end: [line, col] }` shape.
  const location = obj.location;
  if (location && typeof location === "object") {
    const loc = location as Record<string, unknown>;
    line ??= readArrayNumber(loc.start, 0);
    column ??= readArrayNumber(loc.start, 1);
    endLine ??= readArrayNumber(loc.end, 0);
    endColumn ??= readArrayNumber(loc.end, 1);
  }

  if (line === undefined || line < 1) return null;
  return {
    contractPath,
    line,
    column: column !== undefined && column >= 1 ? column : undefined,
    endLine: endLine !== undefined && endLine >= 1 ? endLine : undefined,
    endColumn: endColumn !== undefined && endColumn >= 1 ? endColumn : undefined,
  };
}

function readNumber(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function readArrayNumber(value: unknown, index: number): number | undefined {
  if (!Array.isArray(value)) return undefined;
  const v = value[index];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Count findings at each impact tier. Convenience helper used by the
 * extension's status-bar / output-channel summary line.
 */
export function summarizeWake(findings: WakeFinding[]): {
  high: number;
  medium: number;
  low: number;
  warning: number;
  info: number;
  total: number;
} {
  let high = 0;
  let medium = 0;
  let low = 0;
  let warning = 0;
  let info = 0;
  for (const f of findings) {
    switch (f.impact) {
      case "high":
        high += 1;
        break;
      case "medium":
        medium += 1;
        break;
      case "low":
        low += 1;
        break;
      case "warning":
        warning += 1;
        break;
      case "info":
        info += 1;
        break;
    }
  }
  return { high, medium, low, warning, info, total: high + medium + low + warning + info };
}
