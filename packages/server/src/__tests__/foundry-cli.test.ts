import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  findForgeRoot,
  forgeVerbosityFlag,
  parseForgeDurationMs,
  stripForgeTestSignature,
} from "@solidity-workbench/common";

describe("forgeVerbosityFlag", () => {
  it("returns an empty string for 0 so callers can omit the flag entirely", () => {
    assert.equal(forgeVerbosityFlag(0), "");
  });

  it("builds `-v`, `-vv`, `-vvv`, `-vvvv`, `-vvvvv` for levels 1..5", () => {
    assert.equal(forgeVerbosityFlag(1), "-v");
    assert.equal(forgeVerbosityFlag(2), "-vv");
    assert.equal(forgeVerbosityFlag(3), "-vvv");
    assert.equal(forgeVerbosityFlag(4), "-vvvv");
    assert.equal(forgeVerbosityFlag(5), "-vvvvv");
  });

  // Regression for: `forge test ... --v` failing with
  // `error: unexpected argument '--v' found`. The old implementation
  // was `"-".repeat(n) + "v"`, which produced `--v` at level 2.
  it("never produces a multi-dash flag like `--v` or `---v`", () => {
    for (let n = 0; n <= 10; n++) {
      const flag = forgeVerbosityFlag(n);
      assert.ok(
        flag === "" || /^-v+$/.test(flag),
        `verbosity ${n} produced invalid forge flag: "${flag}"`,
      );
    }
  });

  it("clamps levels above 5 to `-vvvvv`", () => {
    assert.equal(forgeVerbosityFlag(6), "-vvvvv");
    assert.equal(forgeVerbosityFlag(99), "-vvvvv");
    assert.equal(forgeVerbosityFlag(Number.POSITIVE_INFINITY), "-vvvvv");
  });

  it("clamps negative levels to the empty string", () => {
    assert.equal(forgeVerbosityFlag(-1), "");
    assert.equal(forgeVerbosityFlag(Number.NEGATIVE_INFINITY), "");
  });

  it("floors fractional levels", () => {
    assert.equal(forgeVerbosityFlag(2.9), "-vv");
    assert.equal(forgeVerbosityFlag(0.9), "");
  });
});

describe("stripForgeTestSignature", () => {
  it("drops everything from the first `(` onward", () => {
    assert.equal(stripForgeTestSignature("test_Increment()"), "test_Increment");
    assert.equal(stripForgeTestSignature("testFuzz_Bound(uint256,uint256,uint256)"), "testFuzz_Bound");
    assert.equal(
      stripForgeTestSignature("test_RevertWhen_Something(address,uint256)"),
      "test_RevertWhen_Something",
    );
  });

  it("returns names without parens unchanged (already-bare labels)", () => {
    assert.equal(stripForgeTestSignature("test_Increment"), "test_Increment");
    assert.equal(stripForgeTestSignature(""), "");
  });
});

describe("parseForgeDurationMs", () => {
  // Regression: the Test Explorer reported nothing back because the
  // old implementation read `result.duration.secs` on a string value.
  // The real forge 1.x output is a composite human-readable string.
  it("parses the `Nms Nµs Nns` composite forge 1.x emits for fast tests", () => {
    // "442µs 458ns" → 0.442 + 0.000458 ≈ 0.442458 ms
    const ms = parseForgeDurationMs("442µs 458ns")!;
    assert.ok(Math.abs(ms - 0.442458) < 1e-9, `expected ≈0.442458 ms, got ${ms}`);
  });

  it("parses the ms+µs+ns combo used for slower tests", () => {
    // "2ms 860µs 417ns" → 2 + 0.860 + 0.000417 ≈ 2.860417 ms
    const ms = parseForgeDurationMs("2ms 860µs 417ns")!;
    assert.ok(Math.abs(ms - 2.860417) < 1e-9, `expected ≈2.860417 ms, got ${ms}`);
  });

  it("parses plain `37s` seconds output without eating it as milliseconds", () => {
    assert.equal(parseForgeDurationMs("37s"), 37_000);
  });

  it("parses minutes without confusing them with milliseconds", () => {
    assert.equal(parseForgeDurationMs("1m 30s"), 90_000);
    assert.equal(parseForgeDurationMs("2ms"), 2);
  });

  it("accepts the ASCII `us` alias for microseconds", () => {
    assert.equal(parseForgeDurationMs("5us"), 0.005);
  });

  it("returns undefined for unrecognized shapes rather than zero", () => {
    assert.equal(parseForgeDurationMs(""), undefined);
    assert.equal(parseForgeDurationMs("nonsense"), undefined);
    assert.equal(parseForgeDurationMs(null), undefined);
    assert.equal(parseForgeDurationMs(42), undefined);
    assert.equal(parseForgeDurationMs({}), undefined);
  });

  it("supports the legacy `{ secs, nanos }` shape from older forge", () => {
    assert.equal(parseForgeDurationMs({ secs: 2, nanos: 0 }), 2_000);
    // 1 second + 500 million nanos = 1.5 seconds = 1500 ms
    assert.equal(parseForgeDurationMs({ secs: 1, nanos: 500_000_000 }), 1_500);
    // nanos-only
    assert.equal(parseForgeDurationMs({ nanos: 1_234_567 }), 1.234567);
  });
});

describe("findForgeRoot", () => {
  // Regression for: Test Explorer running forge at the workspace
  // root (which contained a `foundry.toml` stub pointing at
  // non-existent src/test dirs) instead of at the actual project
  // root one directory below, resulting in an empty JSON output and
  // a "test run did not record any output" UI message.
  it("returns the directory containing the nearest foundry.toml", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sw-forge-root-"));
    try {
      const project = path.join(tmp, "project");
      const testDir = path.join(project, "test");
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(path.join(project, "foundry.toml"), "[profile.default]\n");
      const testFile = path.join(testDir, "Counter.t.sol");
      fs.writeFileSync(testFile, "contract CounterTest {}");
      assert.equal(findForgeRoot(testFile), project);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("prefers the NEAREST foundry.toml when nested configs exist", () => {
    // Simulates this repo's layout: an outer stub foundry.toml at
    // the workspace root + the real one inside test/fixtures/
    // sample-project/. The nearest (inner) one must win.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sw-forge-nested-"));
    try {
      const outer = tmp;
      const inner = path.join(outer, "sub", "project");
      fs.mkdirSync(path.join(inner, "test"), { recursive: true });
      fs.writeFileSync(path.join(outer, "foundry.toml"), "# outer stub\n");
      fs.writeFileSync(path.join(inner, "foundry.toml"), "# inner real\n");
      const testFile = path.join(inner, "test", "Counter.t.sol");
      fs.writeFileSync(testFile, "contract CounterTest {}");
      assert.equal(findForgeRoot(testFile), inner);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns null when no foundry.toml is found anywhere up the chain", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sw-forge-none-"));
    try {
      const deep = path.join(tmp, "a", "b", "c");
      fs.mkdirSync(deep, { recursive: true });
      const file = path.join(deep, "Counter.t.sol");
      fs.writeFileSync(file, "");
      // There's no foundry.toml in the tempdir hierarchy — the walk
      // tops out before finding anything real. The function should
      // return null rather than reporting some unrelated higher
      // directory.
      //
      // (On real systems the walk continues to the root, so there's a
      // tiny chance a user's HOME / root has a foundry.toml and this
      // returns that. The assertion just checks the "no config
      // anywhere under our tree" contract for the tempdir itself.)
      const result = findForgeRoot(file);
      assert.ok(
        result === null || !result.startsWith(tmp),
        `result leaked into tempdir hierarchy: ${result}`,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("handles a file that sits directly in a foundry project root", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sw-forge-flat-"));
    try {
      fs.writeFileSync(path.join(tmp, "foundry.toml"), "");
      const file = path.join(tmp, "Top.sol");
      fs.writeFileSync(file, "");
      assert.equal(findForgeRoot(file), tmp);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
