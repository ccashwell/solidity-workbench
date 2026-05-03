/**
 * Tests for the Wake JSON detector report parser. Wake's output shape
 * has shifted across releases — these fixtures cover the canonical
 * `{ "detections": [...] }` form, the older bare-array form, and the
 * field-name fallbacks the parser supports for backwards compat.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  parseWakeReport,
  summarizeWake,
  wakeSeverityLabel,
  type WakeFinding,
} from "@solidity-workbench/common";

describe("parseWakeReport", () => {
  it("parses the canonical { detections: [...] } shape", () => {
    const json = JSON.stringify({
      detections: [
        {
          detector_name: "reentrancy",
          impact: "high",
          confidence: "high",
          message: "external call before state update",
          source_unit_name: "src/Vault.sol",
          line_from: 42,
          col_from: 9,
        },
      ],
    });
    const findings = parseWakeReport(json);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].detector, "reentrancy");
    assert.equal(findings[0].impact, "high");
    assert.equal(findings[0].confidence, "high");
    assert.equal(findings[0].instances.length, 1);
    assert.equal(findings[0].instances[0].contractPath, "src/Vault.sol");
    assert.equal(findings[0].instances[0].line, 42);
    assert.equal(findings[0].instances[0].column, 9);
  });

  it("parses a bare-array top level (older Wake)", () => {
    const json = JSON.stringify([
      {
        detector_name: "unsafe-delegatecall",
        impact: "high",
        message: "...",
        source_unit_name: "src/Proxy.sol",
        line_from: 8,
      },
    ]);
    const findings = parseWakeReport(json);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].detector, "unsafe-delegatecall");
  });

  it("collects subdetections as additional instances and dedupes by (path, line, col)", () => {
    const json = JSON.stringify({
      detections: [
        {
          detector_name: "missing-event",
          impact: "low",
          message: "...",
          source_unit_name: "src/A.sol",
          line_from: 10,
          col_from: 4,
          subdetections: [
            { source_unit_name: "src/A.sol", line_from: 20, col_from: 4 },
            { source_unit_name: "src/A.sol", line_from: 10, col_from: 4 }, // duplicate of inline
            { source_unit_name: "src/B.sol", line_from: 5, col_from: 1 },
          ],
        },
      ],
    });
    const findings = parseWakeReport(json);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].instances.length, 3);
    assert.deepEqual(
      findings[0].instances.map((i) => `${i.contractPath}:${i.line}:${i.column}`),
      ["src/A.sol:10:4", "src/A.sol:20:4", "src/B.sol:5:1"],
    );
  });

  it("supports the `location.start: [line, col]` shape", () => {
    const json = JSON.stringify({
      detections: [
        {
          detector_name: "shadowing-state",
          impact: "warning",
          message: "...",
          source_unit_name: "src/C.sol",
          location: { start: [12, 3], end: [12, 18] },
        },
      ],
    });
    const findings = parseWakeReport(json);
    assert.equal(findings.length, 1);
    const inst = findings[0].instances[0];
    assert.equal(inst.line, 12);
    assert.equal(inst.column, 3);
    assert.equal(inst.endLine, 12);
    assert.equal(inst.endColumn, 18);
  });

  it("falls back across detector / impact / message field aliases", () => {
    const json = JSON.stringify({
      detections: [
        {
          name: "boolean-equality",
          severity: "low",
          description: "x == true is redundant",
          source_unit_name: "src/D.sol",
          line_from: 3,
        },
      ],
    });
    const findings = parseWakeReport(json);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].detector, "boolean-equality");
    assert.equal(findings[0].impact, "low");
    assert.equal(findings[0].message, "x == true is redundant");
  });

  it("normalises informational variants to `info`", () => {
    const json = JSON.stringify({
      detections: [
        {
          detector_name: "x",
          impact: "Informational",
          message: "",
          source_unit_name: "f.sol",
          line_from: 1,
        },
        {
          detector_name: "y",
          impact: "INFO",
          message: "",
          source_unit_name: "f.sol",
          line_from: 2,
        },
      ],
    });
    const findings = parseWakeReport(json);
    assert.equal(findings.length, 2);
    for (const f of findings) assert.equal(f.impact, "info");
  });

  it("drops detections without a location", () => {
    const json = JSON.stringify({
      detections: [
        { detector_name: "x", impact: "high", message: "no location here" },
      ],
    });
    assert.deepEqual(parseWakeReport(json), []);
  });

  it("drops detections with unknown impact", () => {
    const json = JSON.stringify({
      detections: [
        {
          detector_name: "x",
          impact: "catastrophic",
          message: "...",
          source_unit_name: "f.sol",
          line_from: 1,
        },
      ],
    });
    assert.deepEqual(parseWakeReport(json), []);
  });

  it("returns [] for invalid / non-conforming JSON", () => {
    assert.deepEqual(parseWakeReport("{not json"), []);
    assert.deepEqual(parseWakeReport("null"), []);
    assert.deepEqual(parseWakeReport("123"), []);
    assert.deepEqual(parseWakeReport(JSON.stringify({})), []);
  });

  it("defaults missing confidence to medium", () => {
    const json = JSON.stringify({
      detections: [
        {
          detector_name: "x",
          impact: "low",
          message: "",
          source_unit_name: "f.sol",
          line_from: 1,
        },
      ],
    });
    const findings = parseWakeReport(json);
    assert.equal(findings[0].confidence, "medium");
  });
});

describe("wakeSeverityLabel", () => {
  it("maps impact tiers to LSP severity labels", () => {
    assert.equal(wakeSeverityLabel("high"), "error");
    assert.equal(wakeSeverityLabel("medium"), "warning");
    assert.equal(wakeSeverityLabel("low"), "warning");
    assert.equal(wakeSeverityLabel("warning"), "warning");
    assert.equal(wakeSeverityLabel("info"), "info");
  });
});

describe("summarizeWake", () => {
  it("counts findings per impact tier", () => {
    const findings: WakeFinding[] = [
      { detector: "a", impact: "high", confidence: "high", message: "", instances: [] },
      { detector: "b", impact: "high", confidence: "low", message: "", instances: [] },
      { detector: "c", impact: "medium", confidence: "medium", message: "", instances: [] },
      { detector: "d", impact: "low", confidence: "medium", message: "", instances: [] },
      { detector: "e", impact: "info", confidence: "low", message: "", instances: [] },
    ];
    assert.deepEqual(summarizeWake(findings), {
      high: 2,
      medium: 1,
      low: 1,
      warning: 0,
      info: 1,
      total: 5,
    });
  });
});
