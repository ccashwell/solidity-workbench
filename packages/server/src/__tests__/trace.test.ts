/**
 * Tests for the EVM trace parser and `TraceCursor`. The JSON shape
 * matches geth's `debug_traceTransaction` (and Anvil's RPC and
 * `cast run --json`) — the de-facto standard structured-step trace
 * format the DAP adapter consumes.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { parseTraceJson, TraceCursor, type TraceStep } from "@solidity-workbench/common";

function step(overrides: Partial<TraceStep> = {}): TraceStep {
  return {
    pc: 0,
    op: "STOP",
    depth: 1,
    gas: 0,
    gasCost: 0,
    stack: [],
    memory: [],
    storage: {},
    ...overrides,
  };
}

describe("parseTraceJson", () => {
  it("parses the canonical { structLogs: [...] } envelope", () => {
    const json = JSON.stringify({
      gas: 21000,
      failed: false,
      returnValue: "0x",
      structLogs: [
        {
          pc: 0,
          op: "PUSH1",
          depth: 1,
          gas: 999990,
          gasCost: 3,
          stack: [],
          memory: [],
          storage: {},
        },
        {
          pc: 2,
          op: "MSTORE",
          depth: 1,
          gas: 999987,
          gasCost: 6,
          stack: ["0080", "0040"],
          memory: ["00".repeat(32)],
          storage: {},
        },
      ],
    });
    const trace = parseTraceJson(json);
    assert.ok(trace);
    assert.equal(trace!.gas, 21000);
    assert.equal(trace!.failed, false);
    assert.equal(trace!.steps.length, 2);
    assert.equal(trace!.steps[0].op, "PUSH1");
    assert.equal(trace!.steps[1].pc, 2);
    assert.deepEqual(trace!.steps[1].stack, ["0080", "0040"]);
  });

  it("parses the alternate { steps: [...] } shape", () => {
    const json = JSON.stringify({
      steps: [{ pc: 0, op: "STOP", depth: 1, gas: 0, gasCost: 0 }],
    });
    const trace = parseTraceJson(json);
    assert.ok(trace);
    assert.equal(trace!.steps.length, 1);
    assert.equal(trace!.steps[0].op, "STOP");
  });

  it("parses a bare-array form", () => {
    const json = JSON.stringify([
      { pc: 0, op: "STOP", depth: 1 },
      { pc: 1, op: "STOP", depth: 1 },
    ]);
    const trace = parseTraceJson(json);
    assert.ok(trace);
    assert.equal(trace!.steps.length, 2);
  });

  it("falls back across pc / op field aliases", () => {
    const json = JSON.stringify({
      structLogs: [
        { programCounter: 0, opName: "PUSH0", depth: 1 },
        { pc: 1, opcode: "STOP", depth: 1 },
      ],
    });
    const trace = parseTraceJson(json);
    assert.ok(trace);
    assert.equal(trace!.steps[0].pc, 0);
    assert.equal(trace!.steps[0].op, "PUSH0");
    assert.equal(trace!.steps[1].op, "STOP");
  });

  it("accepts numeric gas as either a number or a hex string", () => {
    const json = JSON.stringify({
      structLogs: [
        { pc: 0, op: "STOP", gas: "0x186a0", gasCost: "3" },
      ],
    });
    const trace = parseTraceJson(json);
    assert.ok(trace);
    assert.equal(trace!.steps[0].gas, 0x186a0);
    assert.equal(trace!.steps[0].gasCost, 3);
  });

  it("defaults missing optional fields (depth, stack, memory, storage)", () => {
    const json = JSON.stringify({
      structLogs: [{ pc: 0, op: "STOP" }],
    });
    const trace = parseTraceJson(json);
    assert.ok(trace);
    const s = trace!.steps[0];
    assert.equal(s.depth, 1);
    assert.deepEqual(s.stack, []);
    assert.deepEqual(s.memory, []);
    assert.deepEqual(s.storage, {});
  });

  it("captures the per-step error field when present", () => {
    const json = JSON.stringify({
      structLogs: [{ pc: 5, op: "REVERT", error: "execution reverted" }],
    });
    const trace = parseTraceJson(json);
    assert.equal(trace!.steps[0].error, "execution reverted");
  });

  it("drops malformed steps but keeps well-formed ones", () => {
    const json = JSON.stringify({
      structLogs: [
        { pc: 0, op: "STOP" },
        { /* missing pc and op */ },
        { pc: 5, op: "ADD" },
      ],
    });
    const trace = parseTraceJson(json);
    assert.equal(trace!.steps.length, 2);
    assert.deepEqual(
      trace!.steps.map((s) => s.pc),
      [0, 5],
    );
  });

  it("returns null for invalid / empty / non-conforming JSON", () => {
    assert.equal(parseTraceJson("{not json"), null);
    assert.equal(parseTraceJson("null"), null);
    assert.equal(parseTraceJson(JSON.stringify({})), null);
    assert.equal(parseTraceJson(JSON.stringify({ structLogs: [] })), null);
    // Bare array of garbage parses to no steps -> null.
    assert.equal(parseTraceJson(JSON.stringify([{ wrong: "shape" }])), null);
  });
});

describe("TraceCursor", () => {
  const STEPS: TraceStep[] = [
    step({ pc: 0, op: "PUSH1", depth: 1 }),
    step({ pc: 2, op: "PUSH1", depth: 1 }),
    step({ pc: 4, op: "ADD", depth: 1 }),
    step({ pc: 5, op: "CALL", depth: 1 }),
    step({ pc: 0, op: "PUSH1", depth: 2 }),
    step({ pc: 2, op: "STOP", depth: 2 }),
    step({ pc: 6, op: "STOP", depth: 1 }),
  ];

  it("starts at index 0 with `current` returning the first step", () => {
    const c = new TraceCursor(STEPS);
    assert.equal(c.index, 0);
    assert.equal(c.current?.op, "PUSH1");
    assert.equal(c.isAtStart, true);
    assert.equal(c.isAtEnd, false);
  });

  it("`next` advances and returns false at the end", () => {
    const c = new TraceCursor(STEPS);
    for (let i = 0; i < STEPS.length; i++) {
      assert.equal(c.next(), true);
    }
    assert.equal(c.next(), false);
    assert.equal(c.isAtEnd, true);
    assert.equal(c.current, null);
  });

  it("`previous` walks back and returns false at the start", () => {
    const c = new TraceCursor(STEPS);
    c.next();
    c.next();
    assert.equal(c.index, 2);
    assert.equal(c.previous(), true);
    assert.equal(c.previous(), true);
    assert.equal(c.previous(), false);
    assert.equal(c.index, 0);
  });

  it("`seek` clamps to the valid range", () => {
    const c = new TraceCursor(STEPS);
    c.seek(-5);
    assert.equal(c.index, 0);
    c.seek(99);
    assert.equal(c.index, STEPS.length);
    assert.equal(c.isAtEnd, true);
  });

  it("`findNext` lands on the next match and `-1` if none ahead", () => {
    const c = new TraceCursor(STEPS);
    const callIdx = c.findNext((s) => s.op === "CALL");
    assert.equal(callIdx, 3);
    assert.equal(c.index, 3);

    // From there, find the next STOP at depth 1 (the deeper STOP at
    // depth 2 should NOT match — predicate ignores it).
    const exitIdx = c.findNext((s) => s.op === "STOP" && s.depth === 1);
    assert.equal(exitIdx, 6);

    // Nothing further matches.
    assert.equal(c.findNext(() => true), -1);
    assert.equal(c.isAtEnd, true);
  });

  it("`findPrevious` walks backwards from the cursor", () => {
    const c = new TraceCursor(STEPS);
    c.seek(STEPS.length); // at end
    const callIdx = c.findPrevious((s) => s.op === "CALL");
    assert.equal(callIdx, 3);
    // Before that, the most recent ADD.
    const addIdx = c.findPrevious((s) => s.op === "ADD");
    assert.equal(addIdx, 2);
    // No further matches walking back from before index 0.
    c.findPrevious((s) => s.op === "ADD"); // moves to 0
    assert.equal(c.findPrevious(() => true), -1);
    assert.equal(c.index, 0);
  });

  it("`reset` returns to the entry step", () => {
    const c = new TraceCursor(STEPS);
    c.seek(4);
    c.reset();
    assert.equal(c.index, 0);
    assert.equal(c.isAtStart, true);
  });
});
