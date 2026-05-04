/**
 * Tests for the Mythril JSON analysis report parser. Mythril's
 * output shape varies by invocation count — fixtures here exercise
 * the single-target object form, the multi-target keyed-by-filename
 * form, and the bare-array form some versions emit.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  parseMythrilReport,
  summarizeMythril,
  mythrilSeverityLabel,
  type MythrilFinding,
} from "@solidity-workbench/common";

describe("parseMythrilReport", () => {
  it("parses the single-target `{ issues: [...] }` shape", () => {
    const json = JSON.stringify({
      error: null,
      issues: [
        {
          title: "External Call To User-Supplied Address",
          description: "Long Mythril description...",
          severity: "Low",
          "swc-id": "107",
          filename: "src/Vault.sol",
          lineno: 42,
          contract: "Vault",
          function: "withdraw(uint256)",
        },
      ],
      success: true,
    });
    const findings = parseMythrilReport(json);
    assert.equal(findings.length, 1);
    const f = findings[0];
    assert.equal(f.title, "External Call To User-Supplied Address");
    assert.equal(f.severity, "low");
    assert.equal(f.swcId, "107");
    assert.equal(f.contractPath, "src/Vault.sol");
    assert.equal(f.line, 42);
    assert.equal(f.contract, "Vault");
    assert.equal(f.function, "withdraw(uint256)");
  });

  it("parses the multi-target keyed-by-filename shape, falling back to the key for filename", () => {
    const json = JSON.stringify({
      "src/A.sol": {
        success: true,
        issues: [{ title: "Reentrancy", severity: "High", "swc-id": "107", lineno: 10 }],
      },
      "src/B.sol": {
        success: true,
        issues: [
          {
            title: "Unchecked Call",
            severity: "Medium",
            filename: "src/B.sol",
            lineno: 5,
          },
        ],
      },
    });
    const findings = parseMythrilReport(json);
    assert.equal(findings.length, 2);
    const a = findings.find((f) => f.contractPath === "src/A.sol");
    const b = findings.find((f) => f.contractPath === "src/B.sol");
    assert.ok(a && b);
    assert.equal(a!.severity, "high");
    assert.equal(a!.line, 10);
    assert.equal(b!.severity, "medium");
    assert.equal(b!.line, 5);
  });

  it("parses the bare-array form some Mythril wrappers emit", () => {
    const json = JSON.stringify([
      {
        title: "Assert Violation",
        severity: "High",
        filename: "src/X.sol",
        lineno: 1,
      },
    ]);
    const findings = parseMythrilReport(json);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].title, "Assert Violation");
  });

  it("normalises Mythril's mixed-case severity labels", () => {
    const json = JSON.stringify({
      issues: [
        { title: "a", severity: "HIGH", filename: "f.sol", lineno: 1 },
        { title: "b", severity: "Medium", filename: "f.sol", lineno: 2 },
        { title: "c", severity: "low", filename: "f.sol", lineno: 3 },
        { title: "d", severity: "Informational", filename: "f.sol", lineno: 4 },
        { title: "e", severity: "Info", filename: "f.sol", lineno: 5 },
      ],
    });
    const findings = parseMythrilReport(json);
    assert.deepEqual(
      findings.map((f) => f.severity),
      ["high", "medium", "low", "informational", "informational"],
    );
  });

  it("falls back across SWC-id field aliases", () => {
    const json = JSON.stringify({
      issues: [
        { title: "a", severity: "Low", filename: "f.sol", lineno: 1, "swc-id": "100" },
        { title: "b", severity: "Low", filename: "f.sol", lineno: 2, swcID: "101" },
        { title: "c", severity: "Low", filename: "f.sol", lineno: 3, swc_id: "102" },
        { title: "d", severity: "Low", filename: "f.sol", lineno: 4 },
      ],
    });
    const findings = parseMythrilReport(json);
    assert.deepEqual(
      findings.map((f) => f.swcId),
      ["100", "101", "102", null],
    );
  });

  it("drops issues missing a title, severity, filename, or line", () => {
    const json = JSON.stringify({
      issues: [
        { severity: "Low", filename: "f.sol", lineno: 1 }, // no title
        { title: "x", filename: "f.sol", lineno: 1 }, // no severity
        { title: "x", severity: "Low", lineno: 1 }, // no filename
        { title: "x", severity: "Low", filename: "f.sol" }, // no line
        { title: "x", severity: "Low", filename: "f.sol", lineno: 0 }, // line < 1
        { title: "x", severity: "exterminate", filename: "f.sol", lineno: 1 }, // unknown sev
      ],
    });
    assert.deepEqual(parseMythrilReport(json), []);
  });

  it("returns [] for invalid / non-conforming JSON", () => {
    assert.deepEqual(parseMythrilReport("{not json"), []);
    assert.deepEqual(parseMythrilReport("null"), []);
    assert.deepEqual(parseMythrilReport("123"), []);
    assert.deepEqual(parseMythrilReport(JSON.stringify({})), []);
  });
});

describe("mythrilSeverityLabel", () => {
  it("maps severity tiers to LSP severity labels", () => {
    assert.equal(mythrilSeverityLabel("high"), "error");
    assert.equal(mythrilSeverityLabel("medium"), "warning");
    assert.equal(mythrilSeverityLabel("low"), "warning");
    assert.equal(mythrilSeverityLabel("informational"), "info");
  });
});

describe("summarizeMythril", () => {
  it("counts findings per severity tier", () => {
    const findings: MythrilFinding[] = [
      { title: "a", description: "", severity: "high", swcId: null, contractPath: "f", line: 1 },
      { title: "b", description: "", severity: "high", swcId: null, contractPath: "f", line: 2 },
      { title: "c", description: "", severity: "medium", swcId: null, contractPath: "f", line: 3 },
      { title: "d", description: "", severity: "low", swcId: null, contractPath: "f", line: 4 },
      {
        title: "e",
        description: "",
        severity: "informational",
        swcId: null,
        contractPath: "f",
        line: 5,
      },
    ];
    assert.deepEqual(summarizeMythril(findings), {
      high: 2,
      medium: 1,
      low: 1,
      informational: 1,
      total: 5,
    });
  });
});
