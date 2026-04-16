import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { parseLcov, summarizeBranches } from "@solidity-workbench/common";

describe("parseLcov", () => {
  it("parses a single-file record with DA / BRDA / LF / LH", () => {
    const text = `TN:
SF:src/Counter.sol
FN:7,Counter.increment
FNDA:3,Counter.increment
FNF:1
FNH:1
DA:7,3
DA:8,3
DA:9,0
BRDA:7,0,0,3
BRDA:7,0,1,0
LF:3
LH:2
BRF:2
BRH:1
end_of_record
`;
    const result = parseLcov(text);
    assert.equal(result.size, 1);
    const cov = result.get("src/Counter.sol");
    assert.ok(cov, "expected coverage for src/Counter.sol");
    assert.equal(cov!.lineTotal, 3);
    assert.equal(cov!.lineHit, 2);
    assert.equal(cov!.branchTotal, 2);
    assert.equal(cov!.branchHit, 1);
    assert.equal(cov!.lines.get(7), 3);
    assert.equal(cov!.lines.get(8), 3);
    assert.equal(cov!.lines.get(9), 0);
    assert.equal(cov!.branches.length, 2);
  });

  it("derives LF / LH when they're absent from the trace", () => {
    const text = `SF:src/A.sol
DA:1,5
DA:2,0
DA:3,0
DA:4,7
end_of_record
`;
    const result = parseLcov(text);
    const cov = result.get("src/A.sol");
    assert.ok(cov);
    // 4 DA records total → lineTotal 4
    assert.equal(cov!.lineTotal, 4);
    // 2 records with hits > 0 → lineHit 2
    assert.equal(cov!.lineHit, 2);
  });

  it("accumulates hits when a line appears in multiple DA records", () => {
    const text = `SF:src/B.sol
DA:10,2
DA:10,3
end_of_record
`;
    const cov = parseLcov(text).get("src/B.sol")!;
    assert.equal(cov.lines.get(10), 5);
  });

  it("normalises BRDA `-` taken values to 0", () => {
    const text = `SF:src/C.sol
BRDA:1,0,0,-
BRDA:1,0,1,3
end_of_record
`;
    const cov = parseLcov(text).get("src/C.sol")!;
    assert.equal(cov.branches.length, 2);
    assert.equal(cov.branches[0].taken, 0);
    assert.equal(cov.branches[1].taken, 3);
  });

  it("parses multiple file records separated by end_of_record", () => {
    const text = `SF:src/One.sol
DA:1,1
end_of_record
SF:src/Two.sol
DA:2,0
end_of_record
`;
    const result = parseLcov(text);
    assert.equal(result.size, 2);
    assert.ok(result.has("src/One.sol"));
    assert.ok(result.has("src/Two.sol"));
  });

  it("ignores stray content outside of SF records", () => {
    const text = `# this is a comment
TN:some-test-name
DA:1,1
SF:src/D.sol
DA:1,5
end_of_record
`;
    // `DA:1,1` before the first SF is dropped; only the DA after SF counts.
    const cov = parseLcov(text).get("src/D.sol")!;
    assert.equal(cov.lines.get(1), 5);
    assert.equal(cov.lines.size, 1);
  });

  it("tolerates CRLF line endings", () => {
    const text = "SF:src/E.sol\r\nDA:1,1\r\nend_of_record\r\n";
    const cov = parseLcov(text).get("src/E.sol");
    assert.ok(cov);
    assert.equal(cov!.lines.get(1), 1);
  });

  it("handles an empty trace gracefully", () => {
    assert.equal(parseLcov("").size, 0);
  });
});

describe("summarizeBranches", () => {
  it("buckets a line as fully-covered when every branch is taken", () => {
    const out = summarizeBranches([
      { line: 1, branchId: "0/0", taken: 2 },
      { line: 1, branchId: "0/1", taken: 1 },
    ]);
    assert.equal(out.get(1), "fully");
  });

  it("buckets a line as partial when some branches are taken and some aren't", () => {
    const out = summarizeBranches([
      { line: 2, branchId: "0/0", taken: 3 },
      { line: 2, branchId: "0/1", taken: 0 },
    ]);
    assert.equal(out.get(2), "partial");
  });

  it("buckets a line as missed when no branches are taken", () => {
    const out = summarizeBranches([
      { line: 3, branchId: "0/0", taken: 0 },
      { line: 3, branchId: "0/1", taken: 0 },
    ]);
    assert.equal(out.get(3), "missed");
  });

  it("handles lines with a single branch record", () => {
    const full = summarizeBranches([{ line: 4, branchId: "0/0", taken: 5 }]);
    assert.equal(full.get(4), "fully");

    const missed = summarizeBranches([{ line: 5, branchId: "0/0", taken: 0 }]);
    assert.equal(missed.get(5), "missed");
  });

  it("returns an empty map for empty input", () => {
    assert.equal(summarizeBranches([]).size, 0);
  });
});
