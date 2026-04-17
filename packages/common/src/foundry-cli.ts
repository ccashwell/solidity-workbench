/**
 * Helpers for building Foundry CLI invocations consistently across
 * the extension surface. VSCode-free so the shared formatting rules
 * can be exercised from the server's `node --test` runner.
 */

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
