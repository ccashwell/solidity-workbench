import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { parseAderynReport, severityLabel, summarizeAderyn } from "@solidity-workbench/common";

describe("parseAderynReport", () => {
  it("returns [] for invalid JSON without throwing", () => {
    assert.deepEqual(parseAderynReport("not-json"), []);
    assert.deepEqual(parseAderynReport(""), []);
  });

  it("returns [] when the top-level shape isn't an object", () => {
    assert.deepEqual(parseAderynReport("null"), []);
    assert.deepEqual(parseAderynReport("[]"), []);
    assert.deepEqual(parseAderynReport("42"), []);
  });

  it("returns [] for a report with no buckets populated", () => {
    assert.deepEqual(parseAderynReport("{}"), []);
    assert.deepEqual(
      parseAderynReport(JSON.stringify({ high_issues: {}, low_issues: {}, nc_issues: {} })),
      [],
    );
  });

  it("parses high / low / nc buckets into a flat finding list", () => {
    const report = {
      high_issues: {
        issues: [
          {
            title: "Reentrancy",
            detector_name: "reentrancy-state-change",
            description: "State change after external call",
            instances: [
              { contract_path: "src/Vault.sol", line_no: 42, src: "100:5:0" },
              { contract_path: "src/Vault.sol", line_no: 58, src: "200:5:0" },
            ],
          },
        ],
      },
      low_issues: {
        issues: [
          {
            title: "Unchecked return",
            detector_name: "unchecked-call",
            description: "Low-level call result not checked",
            instances: [{ contract_path: "src/Router.sol", line_no: 11 }],
          },
        ],
      },
      nc_issues: {
        issues: [
          {
            title: "Missing NatSpec",
            detector_name: "missing-natspec",
            description: "Public function has no NatSpec",
            instances: [{ contract_path: "src/Token.sol", line_no: 7 }],
          },
        ],
      },
    };

    const findings = parseAderynReport(JSON.stringify(report));
    assert.equal(findings.length, 3);

    const high = findings.find((f) => f.severity === "high");
    assert.ok(high);
    assert.equal(high!.detector, "reentrancy-state-change");
    assert.equal(high!.instances.length, 2);
    assert.equal(high!.instances[0].contractPath, "src/Vault.sol");
    assert.equal(high!.instances[0].line, 42);

    const low = findings.find((f) => f.severity === "low");
    assert.ok(low);
    assert.equal(low!.detector, "unchecked-call");
    assert.equal(low!.instances.length, 1);

    const nc = findings.find((f) => f.severity === "nc");
    assert.ok(nc);
    assert.equal(nc!.detector, "missing-natspec");
  });

  it("skips findings whose instance list is empty or malformed", () => {
    const report = {
      high_issues: {
        issues: [
          {
            title: "No instances",
            detector_name: "ghost",
            description: "",
            instances: [],
          },
          {
            title: "Bad instances",
            detector_name: "ghost2",
            description: "",
            instances: [{ contract_path: 123, line_no: "eleven" }],
          },
          {
            title: "Good",
            detector_name: "ok",
            description: "",
            instances: [{ contract_path: "src/A.sol", line_no: 3 }],
          },
        ],
      },
    };
    const findings = parseAderynReport(JSON.stringify(report));
    assert.equal(findings.length, 1);
    assert.equal(findings[0].detector, "ok");
  });

  it("falls back to `title` when `detector_name` is missing (and vice versa)", () => {
    const report = {
      low_issues: {
        issues: [
          {
            title: "Only-Title",
            description: "",
            instances: [{ contract_path: "a.sol", line_no: 1 }],
          },
          {
            detector_name: "only-detector",
            description: "",
            instances: [{ contract_path: "b.sol", line_no: 2 }],
          },
        ],
      },
    };
    const findings = parseAderynReport(JSON.stringify(report));
    assert.equal(findings.length, 2);
    assert.equal(findings[0].title, "Only-Title");
    assert.equal(findings[0].detector, "Only-Title");
    assert.equal(findings[1].title, "only-detector");
    assert.equal(findings[1].detector, "only-detector");
  });

  it("ignores issues with neither title nor detector_name", () => {
    const report = {
      high_issues: {
        issues: [{ description: "ghost", instances: [{ contract_path: "a.sol", line_no: 1 }] }],
      },
    };
    assert.deepEqual(parseAderynReport(JSON.stringify(report)), []);
  });

  it("tolerates unknown top-level keys without affecting known buckets", () => {
    const report = {
      future_issues: {
        issues: [
          { title: "x", detector_name: "x", instances: [{ contract_path: "a.sol", line_no: 1 }] },
        ],
      },
      high_issues: {
        issues: [
          {
            title: "real",
            detector_name: "real",
            description: "",
            instances: [{ contract_path: "a.sol", line_no: 1 }],
          },
        ],
      },
    };
    const findings = parseAderynReport(JSON.stringify(report));
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "high");
  });
});

describe("severityLabel", () => {
  it("maps high → error, low → warning, nc → info", () => {
    assert.equal(severityLabel("high"), "error");
    assert.equal(severityLabel("low"), "warning");
    assert.equal(severityLabel("nc"), "info");
  });
});

describe("summarizeAderyn", () => {
  it("counts findings per severity and computes total", () => {
    const findings = [
      { severity: "high" as const, detector: "a", title: "", description: "", instances: [] },
      { severity: "high" as const, detector: "b", title: "", description: "", instances: [] },
      { severity: "low" as const, detector: "c", title: "", description: "", instances: [] },
      { severity: "nc" as const, detector: "d", title: "", description: "", instances: [] },
    ];
    assert.deepEqual(summarizeAderyn(findings), { high: 2, low: 1, nc: 1, total: 4 });
  });

  it("zero findings produce all-zero counts", () => {
    assert.deepEqual(summarizeAderyn([]), { high: 0, low: 0, nc: 0, total: 0 });
  });
});
