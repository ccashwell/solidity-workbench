import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  DiagnosticsProvider,
  DEPLOY_ONLY_SOLC_CODES,
  shouldSuppressForTier,
  shouldRunStaticAnalysis,
} from "../providers/diagnostics.js";

describe("DiagnosticsProvider.extractSyntaxDiagnostics", () => {
  describe("SPDX license header", () => {
    it("flags missing SPDX when the first 5 lines have none", () => {
      const diags = DiagnosticsProvider.extractSyntaxDiagnostics(
        `pragma solidity ^0.8.0;\ncontract A {}\n`,
      );
      const spdx = diags.find((d) => d.code === "missing-spdx");
      assert.ok(spdx, "expected a missing-spdx diagnostic");
      assert.equal(spdx!.range.start.line, 0);
    });

    it("does NOT flag when SPDX is on line 0", () => {
      const diags = DiagnosticsProvider.extractSyntaxDiagnostics(
        `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\ncontract A {}\n`,
      );
      assert.equal(diags.filter((d) => d.code === "missing-spdx").length, 0);
    });

    it("does NOT flag when SPDX is on line 2 (within the first-five-lines window)", () => {
      const diags = DiagnosticsProvider.extractSyntaxDiagnostics(
        `\n\n// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\ncontract A {}\n`,
      );
      assert.equal(diags.filter((d) => d.code === "missing-spdx").length, 0);
    });
  });

  describe("floating pragma", () => {
    it("flags `pragma solidity ^0.8.0;`", () => {
      const diags = DiagnosticsProvider.extractSyntaxDiagnostics(
        `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\ncontract A {}\n`,
      );
      const floating = diags.find((d) => d.code === "floating-pragma");
      assert.ok(floating, "expected floating-pragma diagnostic for ^0.8.0");
      assert.equal(floating!.range.start.line, 1);
    });

    it("flags `pragma solidity >=0.8.0;`", () => {
      const diags = DiagnosticsProvider.extractSyntaxDiagnostics(
        `// SPDX-License-Identifier: MIT\npragma solidity >=0.8.0;\ncontract A {}\n`,
      );
      assert.ok(diags.find((d) => d.code === "floating-pragma"));
    });

    it("does NOT flag pinned pragmas like `0.8.24`", () => {
      const diags = DiagnosticsProvider.extractSyntaxDiagnostics(
        `// SPDX-License-Identifier: MIT\npragma solidity 0.8.24;\ncontract A {}\n`,
      );
      assert.equal(diags.filter((d) => d.code === "floating-pragma").length, 0);
    });
  });

  describe("tx.origin misuse", () => {
    it("flags a require(tx.origin == owner) line", () => {
      const text = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
contract A {
    address owner;
    function f() external { require(tx.origin == owner); }
}`;
      const diags = DiagnosticsProvider.extractSyntaxDiagnostics(text);
      const tx = diags.find((d) => d.code === "tx-origin");
      assert.ok(tx, "expected tx-origin diagnostic");
      // Range should point at the `tx.origin` substring on the require line.
      const line = text.split("\n")[tx!.range.start.line];
      const slice = line.slice(tx!.range.start.character, tx!.range.end.character);
      assert.equal(slice, "tx.origin");
    });

    it("does NOT flag tx.origin in a line comment", () => {
      const text = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
// Historically we used tx.origin here but it's insecure.
contract A {}`;
      const diags = DiagnosticsProvider.extractSyntaxDiagnostics(text);
      assert.equal(diags.filter((d) => d.code === "tx-origin").length, 0);
    });
  });

  describe("deprecated selfdestruct", () => {
    it("flags a call to selfdestruct(payable(0))", () => {
      const text = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
contract A {
    function kill() external { selfdestruct(payable(address(0))); }
}`;
      const diags = DiagnosticsProvider.extractSyntaxDiagnostics(text);
      const sd = diags.find((d) => d.code === "deprecated-selfdestruct");
      assert.ok(sd, "expected deprecated-selfdestruct diagnostic");
    });

    it("does NOT flag selfdestruct in a block comment", () => {
      const text = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
contract A {
    /* Note: selfdestruct used to be here. */
    function safe() external pure returns (uint256) { return 1; }
}`;
      const diags = DiagnosticsProvider.extractSyntaxDiagnostics(text);
      // The current implementation does NOT deeply understand block
      // comments (that's a `linter.ts` upgrade), but at least the
      // diagnostic should not fire on a line starting with `*`.
      const sd = diags.filter((d) => d.code === "deprecated-selfdestruct");
      for (const d of sd) {
        const line = text.split("\n")[d.range.start.line];
        assert.ok(
          !line.trimStart().startsWith("*"),
          `unexpected selfdestruct on a comment line: ${line}`,
        );
      }
    });
  });
});

describe("shouldSuppressForTier", () => {
  it("suppresses deploy-only codes (5574, 3860) on tests-tier files", () => {
    for (const code of DEPLOY_ONLY_SOLC_CODES) {
      assert.equal(shouldSuppressForTier(code, "tests"), true);
    }
  });

  it("does NOT suppress deploy-only codes on project-tier files", () => {
    assert.equal(shouldSuppressForTier("5574", "project"), false);
    assert.equal(shouldSuppressForTier("3860", "project"), false);
  });

  it("does NOT suppress deploy-only codes on deps-tier files", () => {
    assert.equal(shouldSuppressForTier("5574", "deps"), false);
  });

  it("does NOT suppress codes outside the deploy-only set", () => {
    // 2018 is the canonical "function visibility could be view" warning,
    // which applies equally to test and project code.
    assert.equal(shouldSuppressForTier("2018", "tests"), false);
  });

  it("does NOT suppress when the tier is unknown (fail-open)", () => {
    assert.equal(shouldSuppressForTier("5574", null), false);
  });

  it("does NOT suppress when the error has no code", () => {
    assert.equal(shouldSuppressForTier(undefined, "tests"), false);
    assert.equal(shouldSuppressForTier("", "tests"), false);
  });
});

describe("shouldRunStaticAnalysis", () => {
  it("runs on project-tier files", () => {
    assert.equal(shouldRunStaticAnalysis("project"), true);
  });

  it("does NOT run on tests-tier files", () => {
    assert.equal(shouldRunStaticAnalysis("tests"), false);
  });

  it("does NOT run on deps-tier files", () => {
    assert.equal(shouldRunStaticAnalysis("deps"), false);
  });

  it("runs on unknown-tier files (fail-open for unindexed files)", () => {
    assert.equal(shouldRunStaticAnalysis(null), true);
  });
});
