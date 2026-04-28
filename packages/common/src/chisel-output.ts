/**
 * Chisel REPL stdout parsing helpers.
 *
 * # Background — why we don't parse a prompt sentinel
 *
 * Foundry's `chisel` interactive shell uses `reedline` for line editing,
 * which only writes the `➜` prompt when stdout is attached to a TTY.
 * `child_process.spawn(...)` with the default piped stdio does NOT
 * provide a TTY — chisel detects this at startup and silently disables
 * its prompt rendering. Empirically (chisel 1.5.0) the visible output
 * for a session driven over a pipe is just the welcome banner once,
 * then for each emitted expression a self-contained block like:
 *
 *     Type: uint256
 *     ├ Hex: 0x2b
 *     ├ Hex (full word): 0x000000…02b
 *     └ Decimal: 43
 *
 * with no prompt before, between, or after. Statements (lines ending
 * in `;`) emit no output at all — they update REPL state silently.
 *
 * So instead of pairing inputs to outputs by prompt boundaries we use
 * a quiet-period heuristic: an evaluation is "complete" when stdout
 * has been silent for a short window after the user pressed enter.
 * The wrapper class `ChiselOutputBuffer` exposes that pattern as a
 * `push(chunk)` / `flushQuiet()` interface so the panel can emit a
 * card per evaluation cycle.
 *
 * `splitChiselOutputByPrompt` is retained as the pure non-streaming
 * counterpart — given a fully buffered stdout string it splits on the
 * one boundary that DOES exist in chisel's output: each "Type: " line
 * starts a new self-contained result. (Errors don't follow the
 * `Type:` shape — see `classifyBody`.)
 *
 * The shape of the public API in this module matches the plan, but
 * the prompt-sentinel parser the plan described turned out to be
 * infeasible against non-TTY chisel — see the prelude in
 * `chisel-output.test.ts` for the empirical traces that informed
 * this design. The end result is the same — per-evaluation
 * `ChiselEvalResult` records — just paired by quiet windows instead
 * of prompt characters.
 */

const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g;

/**
 * Tokens that suggest a body emitted by chisel is an error rather
 * than a normal value. Conservative — only fires on the obvious
 * cases — so a successful eval that happens to mention "error" in
 * its returned string doesn't get mis-classified.
 */
const ERROR_HINTS: readonly RegExp[] = [
  /^Error:/m,
  /\bcompiler error\b/i,
  /\bexecution reverted\b/i,
  /\bpanicked\b/i,
  /\bTraceback\b/,
  /^Failed to /m,
];

/** A single chisel evaluation result extracted from the stdout stream. */
export interface ChiselEvalResult {
  /** Raw text emitted by chisel for this evaluation, ANSI-stripped, trimmed. */
  body: string;
  /** True when chisel emitted output that looks like a compiler / runtime error. */
  isError: boolean;
}

/**
 * Strip ANSI SGR escape codes from a string. Chisel will still emit
 * colour codes in pipe mode if `FORCE_COLOR` is set in the spawned
 * environment — we always strip defensively rather than relying on
 * the panel to set the env correctly.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}

/** Decide whether a chisel result body looks like an error. */
export function classifyBody(body: string): "ok" | "error" {
  for (const re of ERROR_HINTS) {
    if (re.test(body)) return "error";
  }
  return "ok";
}

/**
 * Drop the chisel welcome banner from the start of a stdout string.
 * The banner is exactly:
 *
 *     Welcome to Chisel! Type `!help` to show available commands.
 *
 * (with optional trailing newline). Returns the input unchanged when
 * no banner is present so this is safe to call on partial chunks.
 */
export function stripChiselBanner(text: string): string {
  return text.replace(/^\s*Welcome to Chisel! Type `!help` to show available commands\.\s*\n?/, "");
}

/**
 * Pure helper: given a fully-buffered chisel stdout string (one
 * complete session), return one `ChiselEvalResult` per emitted
 * evaluation block.
 *
 * Splits on the start-of-`Type:` lines that head every successful
 * value-returning evaluation. Anything before the first `Type:` line
 * is treated as banner / prologue and discarded. Anything left over
 * after the last block — typically an error message that doesn't
 * follow the `Type:` shape — is appended as a single trailing result
 * (classified by `classifyBody`).
 */
export function splitChiselOutputByPrompt(text: string): ChiselEvalResult[] {
  const cleaned = stripAnsi(text);
  const withoutBanner = stripChiselBanner(cleaned);

  // Split on each `Type:` block header (kept with its block via lookahead).
  const blocks = withoutBanner.split(/(?=^Type:\s)/m).filter((b) => b.trim().length > 0);

  return blocks.map((block) => {
    const body = block.trim();
    return {
      body,
      isError: classifyBody(body) === "error",
    };
  });
}

/**
 * Streaming buffer used by the `ChiselPanel` to convert chisel
 * stdout chunks into per-evaluation results. The pairing strategy is
 * documented in the file header: an evaluation completes when
 * stdout has been quiet for `quietMs` milliseconds after the
 * caller's last input, OR when the buffer is explicitly flushed
 * (subprocess exit, panel disposal).
 *
 * Usage from the panel side:
 *
 * ```
 * const buf = new ChiselOutputBuffer();
 * proc.stdout.on("data", (chunk) => {
 *   buf.push(chunk.toString());
 *   scheduleFlush();
 * });
 * // when the user hits "Run":
 * buf.markExpressionSent();
 * proc.stdin.write(expr + "\n");
 * // after `quietMs` of stdout silence:
 * const result = buf.flushQuiet();
 * if (result) postResult(result);
 * ```
 *
 * The buffer is also used standalone in unit tests via the
 * synchronous `splitNow()` method.
 */
export class ChiselOutputBuffer {
  private pending = "";
  /** True until the welcome banner has been seen + stripped. */
  private seenBanner = false;
  /** Set to true when the first non-banner output arrives (= chisel ready). */
  private hasEmittedReady = false;

  /**
   * Append a stdout chunk to the buffer.
   *
   * Returns `true` exactly once — when the welcome banner has been
   * fully consumed and chisel is ready to accept evaluations. The
   * caller uses this to enable the textarea / forward a queued
   * `sendSelection`.
   */
  push(chunk: string): { ready: boolean } {
    this.pending += stripAnsi(chunk);

    let ready = false;
    if (!this.seenBanner) {
      const stripped = stripChiselBanner(this.pending);
      if (stripped.length < this.pending.length) {
        // Banner was found and stripped.
        this.pending = stripped;
        this.seenBanner = true;
        if (!this.hasEmittedReady) {
          this.hasEmittedReady = true;
          ready = true;
        }
      } else {
        // No banner yet — keep buffering. Don't emit results until
        // we've seen one (chisel always prints it before any eval).
        return { ready: false };
      }
    } else if (!this.hasEmittedReady) {
      this.hasEmittedReady = true;
      ready = true;
    }

    return { ready };
  }

  /**
   * Drain whatever's currently in the buffer as a single result.
   * Called when stdout has been quiet for the configured window
   * after a user's last input — see file header.
   *
   * Returns `null` when there's nothing to drain (for example when
   * the user evaluated a statement like `uint256 x = 42;` which
   * chisel acknowledges silently).
   */
  flushQuiet(): ChiselEvalResult | null {
    if (!this.seenBanner) return null;
    const body = this.pending.trim();
    this.pending = "";
    if (body.length === 0) return null;
    return {
      body,
      isError: classifyBody(body) === "error",
    };
  }

  /** Has chisel finished printing its banner? */
  isReady(): boolean {
    return this.hasEmittedReady;
  }

  /** True when there's pending buffered output not yet drained. */
  hasPending(): boolean {
    return this.pending.trim().length > 0;
  }

  /**
   * Drain everything currently in the buffer and parse it as a
   * sequence of results. Used by tests to validate multi-block
   * inputs without simulating the streaming quiet-window timer.
   * Subprocess-exit handlers also call this to flush any trailing
   * partial output.
   */
  splitNow(): ChiselEvalResult[] {
    if (!this.seenBanner) {
      const stripped = stripChiselBanner(this.pending);
      if (stripped.length < this.pending.length) {
        this.seenBanner = true;
        this.hasEmittedReady = true;
        this.pending = stripped;
      }
    }
    const text = this.pending;
    this.pending = "";
    return splitChiselOutputByPrompt(text);
  }
}
