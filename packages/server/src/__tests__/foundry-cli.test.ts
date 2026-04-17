import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { forgeVerbosityFlag } from "@solidity-workbench/common";

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
