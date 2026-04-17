/**
 * Helpers for building Foundry CLI invocations consistently across
 * the extension surface. VSCode-free so the shared formatting rules
 * can be exercised from the server's `node --test` runner.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Build the `forge test` verbosity flag from a numeric level.
 *
 * Forge uses a single-dash short flag with a variable number of `v`s:
 * `-v`, `-vv`, `-vvv`, `-vvvv`, `-vvvvv`. A common mistake is to
 * construct `"-".repeat(n) + "v"` (which produces `--v` for n=2), and
 * forge rejects that with `error: unexpected argument '--v' found`.
 * Wrap the right shape here so every call site uses it.
 *
 * Returns an empty string for `verbosity <= 0` so callers can omit
 * the flag entirely. Values above 5 are clamped because our
 * `test.verbosity` setting enum caps there; forge itself accepts
 * arbitrarily many `v`s.
 */
export function forgeVerbosityFlag(verbosity: number): string {
  const n = Math.min(5, Math.max(0, Math.floor(verbosity)));
  if (n === 0) return "";
  return "-" + "v".repeat(n);
}

/**
 * Strip the parameter signature off a forge test name:
 * `testFuzz_Bound(uint256,uint256,uint256)` → `testFuzz_Bound`.
 *
 * Used to reconcile forge's `--json` output (which keys every test
 * result by the Solidity signature including parens and param types)
 * against labels we display in VSCode's Test Explorer (which carry
 * only the bare identifier).
 */
export function stripForgeTestSignature(name: string): string {
  const idx = name.indexOf("(");
  return idx === -1 ? name : name.slice(0, idx);
}

/**
 * Parse the duration forge emits alongside each test result into a
 * millisecond count.
 *
 * Supports both the modern human-readable form forge 1.x uses —
 * `"2ms 860µs 417ns"`, `"37s"`, `"442µs 458ns"` — and the legacy
 * `{ secs, nanos }` object shape older forge versions emitted.
 * Returns `undefined` when the shape is unrecognized so callers
 * fall through to "no timing info".
 *
 * Components can appear in any order; we sum everything we match.
 * The regexes are anchored with explicit word boundaries so `ms`
 * doesn't accidentally match the leading `m` of "minutes" and vice
 * versa.
 */
export function parseForgeDurationMs(duration: unknown): number | undefined {
  if (typeof duration === "string") {
    const parts: [RegExp, number][] = [
      [/(\d+(?:\.\d+)?)\s*h(?:ours?)?\b/, 3_600_000],
      // `m` for minutes — the negative lookahead keeps it from eating
      // the `m` in `ms`.
      [/(\d+(?:\.\d+)?)\s*m(?:in(?:utes?)?)?(?=\s|$)/, 60_000],
      [/(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?(?=\s|$)/, 1_000],
      [/(\d+(?:\.\d+)?)\s*ms\b/, 1],
      [/(\d+(?:\.\d+)?)\s*[µu]s\b/, 1 / 1_000],
      [/(\d+(?:\.\d+)?)\s*ns\b/, 1 / 1_000_000],
    ];
    let totalMs = 0;
    let matched = false;
    for (const [re, scale] of parts) {
      const m = duration.match(re);
      if (m) {
        totalMs += parseFloat(m[1]) * scale;
        matched = true;
      }
    }
    return matched ? totalMs : undefined;
  }
  if (duration && typeof duration === "object") {
    const d = duration as { secs?: number; nanos?: number };
    if (typeof d.secs === "number" || typeof d.nanos === "number") {
      return (d.secs ?? 0) * 1_000 + (d.nanos ?? 0) / 1_000_000;
    }
  }
  return undefined;
}

/**
 * Walk up from a starting file path looking for the nearest
 * `foundry.toml`. Returns the directory that contains it, or `null`
 * when no `foundry.toml` is found before reaching the filesystem root.
 *
 * Why this exists: commands like the Test Explorer need to spawn
 * `forge` in the project root for the file being acted on — not the
 * VSCode workspace root. In a monorepo where the workspace root sits
 * above the Foundry project (this repo's `test/fixtures/sample-
 * project/`, for example), running forge at the workspace root picks
 * up the wrong `foundry.toml` (or none at all) and silently emits an
 * empty result set, producing the "test run did not record any
 * output" experience.
 *
 * Choosing the *nearest* config is intentional: an outer stub config
 * used to keep the workspace root from behaving like a forge project
 * must never override the real project config sitting next to the
 * test file.
 */
export function findForgeRoot(startPath: string): string | null {
  let dir = path.dirname(startPath);
  for (let i = 0; i < 32; i++) {
    if (fs.existsSync(path.join(dir, "foundry.toml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}
