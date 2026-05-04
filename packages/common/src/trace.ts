/**
 * EVM execution-trace parser + cursor for the Solidity Workbench
 * DAP debug adapter (stage 2).
 *
 * The trace format is the de-facto standard `structLogs` shape
 * emitted by:
 *   - geth's `debug_traceTransaction` RPC
 *   - Anvil's `debug_traceTransaction` (same shape)
 *   - `cast run --json <txhash>` (Foundry passes through Anvil's
 *     output)
 *   - `cast run --debug --json` for replays under the in-process
 *     EVM
 *
 * One JSON document yields one transaction's trace: a top-level
 * envelope with `gas`, `failed`, `returnValue`, and a `structLogs`
 * array of per-opcode step records. We accept three shapes
 * defensively (canonical envelope, alternate `steps:` key, and a
 * bare array of steps) and tolerate missing optional fields per
 * step — `memory`, `storage`, and `stack` are commonly omitted on
 * shallow traces or by Foundry when the user opts out via
 * `--no-storage` / similar flags.
 */

/**
 * One step in the trace — the state of the EVM *before* the opcode
 * named by `op` runs at program counter `pc`.
 */
export interface TraceStep {
  /** Program counter at which `op` begins. */
  pc: number;
  /** Mnemonic for the opcode (e.g. `"PUSH1"`, `"SLOAD"`, `"CALL"`). */
  op: string;
  /** Call depth — 1 for the entry transaction, ++ on each CALL/CREATE. */
  depth: number;
  /** Remaining gas before `op` executes. */
  gas: number;
  /** Static gas cost of `op` (excluding dynamic memory / refund adjustments). */
  gasCost: number;
  /** EVM stack, top-of-stack last. Words are 32-byte hex without `0x` prefix. */
  stack: string[];
  /** Memory laid out as 32-byte words; `[]` when memory wasn't captured. */
  memory: string[];
  /** Storage diff for the active contract; `{}` when storage wasn't captured. */
  storage: Record<string, string>;
  /** When present, an EVM error / revert reason for this step. */
  error?: string;
}

/**
 * Trace envelope parsed from one `debug_traceTransaction`-style
 * JSON document. `failed` indicates whether the transaction
 * reverted; `returnValue` is the top-level call's return data.
 */
export interface Trace {
  gas: number;
  failed: boolean;
  returnValue: string;
  steps: TraceStep[];
}

/**
 * Parse a JSON trace document into a normalised `Trace`. Returns
 * `null` for invalid input rather than throwing — callers (the DAP
 * adapter) can render a "trace not available" frame and let the
 * user retry.
 *
 * Accepted top-level shapes:
 *
 *   1. `{ gas, failed, returnValue, structLogs: [...] }`
 *      — geth / anvil canonical
 *   2. `{ steps: [...] }`
 *      — some `cast run` versions emit this
 *   3. `[ <step>, <step>, ... ]`
 *      — bare-array form (rare; trace-only dumps)
 *
 * Per-step field-name fallbacks handled defensively:
 *   - pc       — `pc` | `programCounter`
 *   - op       — `op` | `opName` | `opcode`
 *   - depth    — `depth` (defaults to 1 when absent)
 *   - gas      — `gas` | `gasLeft`
 *   - gasCost  — `gasCost` | `cost`
 *   - stack    — `stack` (array of hex strings)
 *   - memory   — `memory` (array of hex words)
 *   - storage  — `storage` (object: slot → value, both hex)
 *   - error    — `error` (string)
 */
export function parseTraceJson(json: string): Trace | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }

  if (Array.isArray(raw)) {
    const steps = raw.map(parseStep).filter((s): s is TraceStep => s !== null);
    return steps.length === 0 ? null : { gas: 0, failed: false, returnValue: "", steps };
  }
  if (!raw || typeof raw !== "object") return null;

  const obj = raw as Record<string, unknown>;
  const stepsArr =
    (Array.isArray(obj.structLogs) && obj.structLogs) ||
    (Array.isArray(obj.steps) && obj.steps) ||
    null;
  if (!stepsArr) return null;

  const steps = stepsArr.map(parseStep).filter((s): s is TraceStep => s !== null);
  if (steps.length === 0) return null;

  return {
    gas: readNumber(obj, ["gas"]) ?? 0,
    failed: typeof obj.failed === "boolean" ? obj.failed : false,
    returnValue: typeof obj.returnValue === "string" ? obj.returnValue : "",
    steps,
  };
}

function parseStep(raw: unknown): TraceStep | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  const pc = readNumber(o, ["pc", "programCounter"]);
  const op = readString(o, ["op", "opName", "opcode"]);
  if (pc === undefined || pc < 0 || !op) return null;

  return {
    pc,
    op,
    depth: readNumber(o, ["depth"]) ?? 1,
    gas: readNumber(o, ["gas", "gasLeft"]) ?? 0,
    gasCost: readNumber(o, ["gasCost", "cost"]) ?? 0,
    stack: readStringArray(o.stack),
    memory: readStringArray(o.memory),
    storage: readStorage(o.storage),
    ...(typeof o.error === "string" ? { error: o.error } : {}),
  };
}

function readNumber(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    // Some emitters serialise gas as a hex string ("0xff..."); accept both.
    if (typeof v === "string") {
      const parsed =
        v.startsWith("0x") || v.startsWith("0X") ? Number.parseInt(v, 16) : Number.parseInt(v, 10);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function readString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function readStorage(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

// ── Cursor ─────────────────────────────────────────────────────────

/**
 * Stateful navigator over a `TraceStep[]`. The DAP adapter holds
 * one cursor per active debug session and advances it in response
 * to the user's `next` / `stepIn` / `stepOut` / `continue` requests.
 *
 * Navigation primitives are cheap (index moves only); higher-level
 * "step over to the next source line" semantics compose `findNext`
 * with a predicate built from the source-map module — the cursor
 * itself is intentionally source-map-agnostic.
 */
export class TraceCursor {
  private _index = 0;

  constructor(public readonly steps: ReadonlyArray<TraceStep>) {}

  /** Current step, or `null` if the cursor is past the end. */
  get current(): TraceStep | null {
    return this.steps[this._index] ?? null;
  }

  /** 0-based index of the cursor. May equal `steps.length` (end). */
  get index(): number {
    return this._index;
  }

  /** Total number of steps the cursor was constructed with. */
  get length(): number {
    return this.steps.length;
  }

  /** True when there are no further steps to advance to. */
  get isAtEnd(): boolean {
    return this._index >= this.steps.length;
  }

  /** True when the cursor is at the entry step (index 0). */
  get isAtStart(): boolean {
    return this._index === 0;
  }

  /** Move forward one step. Returns `false` if already at the end. */
  next(): boolean {
    if (this.isAtEnd) return false;
    this._index += 1;
    return true;
  }

  /** Move back one step. Returns `false` if already at the start. */
  previous(): boolean {
    if (this._index === 0) return false;
    this._index -= 1;
    return true;
  }

  /** Reset to the entry step. */
  reset(): void {
    this._index = 0;
  }

  /**
   * Jump to a specific step index. Clamped to `[0, steps.length]`
   * so callers never end up in an invalid state.
   */
  seek(index: number): void {
    if (index < 0) index = 0;
    if (index > this.steps.length) index = this.steps.length;
    this._index = index;
  }

  /**
   * Advance until `predicate(step)` returns true. Leaves the cursor
   * on the matching step if found; returns the step's index. When no
   * match exists ahead of the current position the cursor moves to
   * the end and the function returns `-1`.
   */
  findNext(predicate: (step: TraceStep) => boolean): number {
    for (let i = this._index + 1; i < this.steps.length; i++) {
      if (predicate(this.steps[i])) {
        this._index = i;
        return i;
      }
    }
    this._index = this.steps.length;
    return -1;
  }

  /**
   * Search backwards from the position before the cursor for the
   * most recent step matching `predicate`. Mirrors `findNext` —
   * leaves the cursor on the match or at index 0 if none.
   */
  findPrevious(predicate: (step: TraceStep) => boolean): number {
    for (let i = this._index - 1; i >= 0; i--) {
      if (predicate(this.steps[i])) {
        this._index = i;
        return i;
      }
    }
    this._index = 0;
    return -1;
  }
}
