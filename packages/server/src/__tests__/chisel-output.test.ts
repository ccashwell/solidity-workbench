/**
 * Tests for `chisel-output.ts` — the helpers that turn chisel stdout
 * into per-evaluation `ChiselEvalResult` records.
 *
 * # Empirical preamble
 *
 * The 0.3.2 implementation plan called for a prompt-boundary parser
 * keyed off chisel's `➜` prompt. That works against a TTY, but
 * `child_process.spawn` doesn't provide one, and chisel's reedline
 * frontend silently disables prompt rendering when stdout is not a
 * TTY. A direct probe with `node child_process.spawn("chisel", [],
 * { stdio: ["pipe", "pipe", "pipe"] })` confirmed:
 *
 *   STDOUT[0]: "Welcome to Chisel! Type `!help` to show available commands.\n"
 *   STDIN: "uint256 x = 42;\n"   (no output — statements are silent)
 *   STDIN: "x + 1\n"
 *   STDOUT[1]: "Type: uint256\n├ Hex: 0x2b\n├ Hex (full word): 0x000…02b\n└ Decimal: 43\n"
 *
 * No prompt sentinel anywhere. The `ChiselPanel` therefore pairs
 * inputs to outputs via a quiet-window heuristic instead, and these
 * tests exercise the pure-string side of that — banner stripping,
 * `Type:`-block splitting, ANSI handling, error classification, and
 * the streaming `ChiselOutputBuffer` helper.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  ChiselOutputBuffer,
  classifyBody,
  splitChiselOutputByPrompt,
  stripAnsi,
  stripChiselBanner,
} from "@solidity-workbench/common";

describe("stripAnsi", () => {
  it("removes SGR escape codes", () => {
    assert.equal(stripAnsi("\x1b[32mhello\x1b[0m world"), "hello world");
  });

  it("removes nested colour resets without eating regular text", () => {
    assert.equal(
      stripAnsi("Type: \x1b[1;32muint256\x1b[0m\n└ Decimal: 42"),
      "Type: uint256\n└ Decimal: 42",
    );
  });

  it("is a no-op on plain text", () => {
    assert.equal(stripAnsi("plain string"), "plain string");
  });
});

describe("stripChiselBanner", () => {
  it("removes the welcome line + trailing newline", () => {
    const text = "Welcome to Chisel! Type `!help` to show available commands.\nrest";
    assert.equal(stripChiselBanner(text), "rest");
  });

  it("returns the input unchanged when no banner is present", () => {
    assert.equal(stripChiselBanner("Type: uint256\n└ Decimal: 42"), "Type: uint256\n└ Decimal: 42");
  });

  it("tolerates leading whitespace before the banner", () => {
    assert.equal(
      stripChiselBanner("\nWelcome to Chisel! Type `!help` to show available commands.\n"),
      "",
    );
  });
});

describe("classifyBody", () => {
  it("returns 'error' for compiler errors", () => {
    assert.equal(classifyBody("Error: Failed to execute edited contract!"), "error");
    assert.equal(classifyBody("compiler error: expected `;`"), "error");
  });

  it("returns 'error' for execution reverts and panics", () => {
    assert.equal(classifyBody("execution reverted: SafeMath: subtraction overflow"), "error");
    assert.equal(classifyBody("Type: uint256\n└ Panicked at 0x0"), "error");
  });

  it("returns 'ok' for normal value blocks", () => {
    assert.equal(classifyBody("Type: uint256\n├ Hex: 0x2b\n└ Decimal: 43"), "ok");
    assert.equal(classifyBody("Type: address\n└ Data: 0x000…dEaD"), "ok");
  });

  it("does not mis-classify the word 'error' inside a returned string value", () => {
    // The classifier only fires on whole-token / start-of-line markers.
    assert.equal(classifyBody('Type: string\n└ Data: "some error message stored on chain"'), "ok");
  });
});

describe("splitChiselOutputByPrompt", () => {
  it("returns no results for an empty buffer", () => {
    assert.deepEqual(splitChiselOutputByPrompt(""), []);
  });

  it("parses a single complete evaluation block", () => {
    const text = `Type: uint256
├ Hex: 0x2b
├ Hex (full word): 0x000000000000000000000000000000000000000000000000000000000000002b
└ Decimal: 43
`;
    const results = splitChiselOutputByPrompt(text);
    assert.equal(results.length, 1);
    assert.equal(results[0].isError, false);
    assert.match(results[0].body, /^Type: uint256/);
    assert.match(results[0].body, /Decimal: 43$/);
  });

  it("parses two evaluations in a single buffer", () => {
    const text = `Type: uint256
└ Decimal: 1
Type: address
└ Data: 0x000000000000000000000000000000000000dEaD
`;
    const results = splitChiselOutputByPrompt(text);
    assert.equal(results.length, 2);
    assert.match(results[0].body, /Decimal: 1/);
    assert.match(results[1].body, /0x000000000000000000000000000000000000dEaD/);
  });

  it("strips the welcome banner before splitting", () => {
    const text = `Welcome to Chisel! Type \`!help\` to show available commands.
Type: uint256
└ Decimal: 1
`;
    const results = splitChiselOutputByPrompt(text);
    assert.equal(results.length, 1);
    assert.match(results[0].body, /Decimal: 1/);
  });

  it("handles ANSI-coloured output (banner + colored Type header)", () => {
    const text = `Welcome to Chisel! Type \`\x1b[32m!help\x1b[0m\` to show available commands.
\x1b[1;32mType:\x1b[0m uint256
└ Decimal: 7
`;
    const results = splitChiselOutputByPrompt(text);
    assert.equal(results.length, 1);
    assert.match(results[0].body, /Type: uint256/);
    assert.match(results[0].body, /Decimal: 7/);
  });

  it("classifies an error block as isError=true", () => {
    const text = `Error: Failed to execute edited contract!
`;
    const results = splitChiselOutputByPrompt(text);
    assert.equal(results.length, 1);
    assert.equal(results[0].isError, true);
  });

  it("classifies a Type-block whose body contains an error marker", () => {
    // Chisel can emit `Type:` framing followed by an error trailer; we
    // don't try to split those into two results, but `classifyBody`
    // marks the combined block as an error so the panel can colour it
    // accordingly.
    const text = `Type: uint256
└ execution reverted: SafeMath: subtraction overflow
`;
    const results = splitChiselOutputByPrompt(text);
    assert.equal(results.length, 1);
    assert.equal(results[0].isError, true);
  });
});

describe("ChiselOutputBuffer streaming", () => {
  it("withholds results until the welcome banner has been consumed", () => {
    const buf = new ChiselOutputBuffer();

    const r1 = buf.push("Welcome to Chisel! Type `!help` to show available commands.\n");
    assert.equal(r1.ready, true);
    assert.equal(buf.isReady(), true);

    // No pending body yet — banner consumed silently.
    assert.equal(buf.flushQuiet(), null);
  });

  it("ready fires only on the first banner-consuming push", () => {
    const buf = new ChiselOutputBuffer();
    const r1 = buf.push("Welcome to Chisel! Type `!help` to show available commands.\n");
    assert.equal(r1.ready, true);
    const r2 = buf.push("Type: uint256\n└ Decimal: 1\n");
    assert.equal(r2.ready, false);
  });

  it("returns no result when buffer is empty before banner arrives", () => {
    const buf = new ChiselOutputBuffer();
    buf.push("partial banner without newline");
    assert.equal(buf.flushQuiet(), null);
    assert.equal(buf.isReady(), false);
  });

  it("flushQuiet returns the buffered evaluation body once banner is seen", () => {
    const buf = new ChiselOutputBuffer();
    buf.push("Welcome to Chisel! Type `!help` to show available commands.\n");
    buf.push("Type: uint256\n├ Hex: 0x2b\n└ Decimal: 43\n");
    const result = buf.flushQuiet();
    assert.ok(result, "expected a result");
    assert.equal(result!.isError, false);
    assert.match(result!.body, /Type: uint256/);
    assert.match(result!.body, /Decimal: 43/);
  });

  it("flushQuiet returns null after draining (no double-emit)", () => {
    const buf = new ChiselOutputBuffer();
    buf.push("Welcome to Chisel! Type `!help` to show available commands.\n");
    buf.push("Type: uint256\n└ Decimal: 1\n");
    assert.ok(buf.flushQuiet());
    assert.equal(buf.flushQuiet(), null);
  });

  it("accumulates output across multiple chunks within one quiet window", () => {
    const buf = new ChiselOutputBuffer();
    buf.push("Welcome to Chisel! Type `!help` to show available commands.\n");
    buf.push("Type: uint256\n├ Hex: 0x2b\n");
    buf.push("├ Hex (full word): 0x0000…02b\n└ Decimal: 43\n");
    const result = buf.flushQuiet();
    assert.ok(result);
    assert.match(result!.body, /Hex: 0x2b/);
    assert.match(result!.body, /Decimal: 43/);
  });

  it("classifies a streamed error body correctly", () => {
    const buf = new ChiselOutputBuffer();
    buf.push("Welcome to Chisel! Type `!help` to show available commands.\n");
    buf.push("Error: Failed to execute edited contract!\n");
    const result = buf.flushQuiet();
    assert.ok(result);
    assert.equal(result!.isError, true);
  });

  it("strips ANSI in streamed chunks", () => {
    const buf = new ChiselOutputBuffer();
    buf.push("Welcome to Chisel! Type `\x1b[32m!help\x1b[0m` to show available commands.\n");
    buf.push("\x1b[1;32mType:\x1b[0m uint256\n└ Decimal: 9\n");
    const result = buf.flushQuiet();
    assert.ok(result);
    // Use a non-literal escape construction so the lint rule
    // `no-control-regex` doesn't flag the regex source.
    assert.equal(result!.body.includes("\x1b"), false);
    assert.match(result!.body, /Type: uint256/);
  });

  it("hasPending tracks unflushed output", () => {
    const buf = new ChiselOutputBuffer();
    buf.push("Welcome to Chisel! Type `!help` to show available commands.\n");
    assert.equal(buf.hasPending(), false);
    buf.push("Type: uint256\n└ Decimal: 1\n");
    assert.equal(buf.hasPending(), true);
    buf.flushQuiet();
    assert.equal(buf.hasPending(), false);
  });

  it("splitNow drains multiple blocks at once (used on subprocess exit)", () => {
    const buf = new ChiselOutputBuffer();
    buf.push("Welcome to Chisel! Type `!help` to show available commands.\n");
    buf.push("Type: uint256\n└ Decimal: 1\nType: address\n└ Data: 0xdEaD\n");
    const results = buf.splitNow();
    assert.equal(results.length, 2);
    assert.match(results[0].body, /Decimal: 1/);
    assert.match(results[1].body, /0xdEaD/);
    // Buffer drained.
    assert.equal(buf.hasPending(), false);
  });

  it("splitNow returns empty when only the banner has been seen", () => {
    const buf = new ChiselOutputBuffer();
    buf.push("Welcome to Chisel! Type `!help` to show available commands.\n");
    assert.deepEqual(buf.splitNow(), []);
  });
});
