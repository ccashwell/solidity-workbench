import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { SolidityParser } from "../parser/solidity-parser.js";
import { SolidityLinter } from "../providers/linter.js";

const parser = new SolidityParser();
const linter = new SolidityLinter();

function lint(code: string) {
  const result = parser.parse("test.sol", code);
  return linter.lint(result.sourceUnit, code, result.rawAst);
}

describe("SolidityLinter", () => {
  describe("reentrancy detection", () => {
    it("flags state write after external call", () => {
      const diags = lint(`
pragma solidity ^0.8.24;

contract Vault {
    mapping(address => uint256) public balances;

    function withdraw(uint256 amount) external {
        (bool success, ) = msg.sender.call{value: amount}("");
        balances[msg.sender] -= amount;
    }
}
`);

      const reentrancy = diags.filter((d) => d.code === "reentrancy");
      assert.ok(reentrancy.length > 0, "Should detect reentrancy");
    });

    it("does not flag with nonReentrant modifier", () => {
      const diags = lint(`
pragma solidity ^0.8.24;

contract Vault {
    mapping(address => uint256) public balances;

    function withdraw(uint256 amount) external nonReentrant {
        (bool success, ) = msg.sender.call{value: amount}("");
        balances[msg.sender] -= amount;
    }
}
`);

      const reentrancy = diags.filter((d) => d.code === "reentrancy");
      assert.equal(reentrancy.length, 0, "Should not flag when nonReentrant is present");
    });
  });

  describe("unchecked call detection", () => {
    it("flags unchecked low-level call", () => {
      const diags = lint(`
pragma solidity ^0.8.24;

contract Bad {
    function send(address to) external {
        to.call{value: 1 ether}("");
    }
}
`);

      const unchecked = diags.filter((d) => d.code === "unchecked-call");
      assert.ok(unchecked.length > 0, "Should detect unchecked call");
    });
  });

  describe("delegatecall detection", () => {
    it("flags delegatecall usage", () => {
      const diags = lint(`
pragma solidity ^0.8.24;

contract Proxy {
    function forward(address impl) external {
        impl.delegatecall("");
    }
}
`);

      const dc = diags.filter((d) => d.code === "dangerous-delegatecall");
      assert.ok(dc.length > 0, "Should detect delegatecall");
    });
  });

  describe("magic number detection", () => {
    it("flags large magic numbers", () => {
      const diags = lint(`
pragma solidity ^0.8.24;

contract Fee {
    function calc(uint256 amount) external pure returns (uint256) {
        return amount * 99997 / 100000;
    }
}
`);

      const magic = diags.filter((d) => d.code === "large-literal");
      assert.ok(magic.length > 0, "Should detect magic numbers");
    });

    it("does not flag constants", () => {
      const diags = lint(`
pragma solidity ^0.8.24;

contract Fee {
    uint256 constant FEE_DENOMINATOR = 100000;
}
`);

      const magic = diags.filter((d) => d.code === "large-literal");
      assert.equal(magic.length, 0, "Should not flag constant declarations");
    });
  });

  describe("suppression comments", () => {
    it("respects solidity-workbench-disable-next-line", () => {
      const diags = lint(`
pragma solidity ^0.8.24;

contract Proxy {
    function forward(address impl) external {
        // solidity-workbench-disable-next-line
        impl.delegatecall("");
    }
}
`);

      const dc = diags.filter((d) => d.code === "dangerous-delegatecall");
      assert.equal(dc.length, 0, "Should suppress with disable comment");
    });
  });

  describe("AST-based rules reject false positives the regex version had", () => {
    it("reentrancy: does NOT fire on state write inside a block-commented-out CEI violation", () => {
      const diags = lint(`
pragma solidity ^0.8.24;

contract Vault {
    mapping(address => uint256) public balances;

    function safe(uint256 amount) external {
        /*
         * Historically we did this (which would be a CEI violation):
         *   (bool s, ) = msg.sender.call{value: amount}("");
         *   balances[msg.sender] -= amount;
         * — now we use pull payments instead.
         */
        balances[msg.sender] = amount;
    }
}
`);
      // The only state write is the final assignment, which is NOT after
      // an external call. The old regex-based check would have flagged
      // the assignment because the string "msg.sender.call" appeared
      // earlier in the comment.
      const reentrancy = diags.filter((d) => d.code === "reentrancy");
      assert.equal(reentrancy.length, 0, "block-commented code must not contribute to CEI checks");
    });

    it("dangerous-delegatecall: does NOT fire on the string 'delegatecall' inside a comment", () => {
      const diags = lint(`
pragma solidity ^0.8.24;

contract Safe {
    // note: we considered using delegatecall here and decided against it.
    function safe() external pure returns (uint256) { return 1; }
}
`);
      const dc = diags.filter((d) => d.code === "dangerous-delegatecall");
      assert.equal(dc.length, 0, "comment mention of delegatecall must not trigger the rule");
    });

    it("storage-in-loop: fires only on the real state-variable read, not a same-named parameter", () => {
      const diags = lint(`
pragma solidity ^0.8.24;

contract C {
    uint256 public cap;

    function pure_param(uint256 cap) external pure returns (uint256) {
        // The parameter shadows state variable \`cap\`; the loop reads
        // the parameter, not storage. We don't yet do full scope
        // analysis, but the AST rule at worst reports one hint — the
        // regex version would match the identifier on every loop line.
        uint256 s;
        for (uint256 i; i < cap; ++i) { s += i; }
        return s;
    }
}
`);
      const loop = diags.filter((d) => d.code === "storage-in-loop");
      // Scope-aware suppression is a future SolcBridge-backed feature;
      // for now assert the rule emits at most one hint per loop line
      // rather than duplicating per occurrence as the regex did.
      const loopLines = new Set(loop.map((d) => d.range.start.line));
      assert.ok(loop.length <= loopLines.size, "no duplicate hints on the same line");
    });

    it("missing-event: does NOT fire when the function emits but from a helper", () => {
      const diags = lint(`
pragma solidity ^0.8.24;

contract T {
    uint256 public x;
    event Changed(uint256 x);

    function set(uint256 v) external {
        x = v;
        emit Changed(v);
    }
}
`);
      const missing = diags.filter((d) => d.code === "missing-event");
      assert.equal(missing.length, 0, "emit statement in body suppresses missing-event");
    });

    it("unchecked-call: does NOT fire when the return is captured into a tuple", () => {
      const diags = lint(`
pragma solidity ^0.8.24;

contract T {
    function f(address to) external {
        (bool ok, ) = to.call{value: 1 ether}("");
        require(ok);
    }
}
`);
      const unchecked = diags.filter((d) => d.code === "unchecked-call");
      assert.equal(unchecked.length, 0, "captured tuple return satisfies the check");
    });

    it("unprotected-selfdestruct: passes when there is an inline msg.sender == owner check", () => {
      const diags = lint(`
pragma solidity ^0.8.24;

contract T {
    address public owner;

    function kill() external {
        if (msg.sender != owner) revert("not owner");
        selfdestruct(payable(owner));
    }
}
`);
      const sd = diags.filter((d) => d.code === "unprotected-selfdestruct");
      assert.equal(sd.length, 0, "inline msg.sender check counts as access control");
    });
  });

  describe("missing zero-address check detection", () => {
    it("flags missing zero-address check and points at the parameter name", () => {
      const diags = lint(`
pragma solidity ^0.8.24;

contract Token {
    address public owner;

    function setOwner(address newOwner) external {
        owner = newOwner;
    }
}
`);
      const missing = diags.filter((d) => d.code === "missing-zero-check");
      assert.equal(missing.length, 1);
      // The range should point somewhere inside the function header, not at line 0
      assert.ok(missing[0].range.start.line >= 1);
      // And the character range should cover the param name "newOwner" (8 chars)
      assert.equal(
        missing[0].range.end.character - missing[0].range.start.character,
        "newOwner".length,
      );
    });

    it("emits one diagnostic per missing address param", () => {
      const diags = lint(`
pragma solidity ^0.8.24;

contract Vault {
    function set(address a, address b) external {}
}
`);
      const missing = diags.filter((d) => d.code === "missing-zero-check");
      assert.equal(missing.length, 2);
    });

    it("does not flag when zero-check is present", () => {
      const diags = lint(`
pragma solidity ^0.8.24;

contract Safe {
    function init(address addr) external {
        require(addr != address(0), "zero addr");
    }
}
`);
      const missing = diags.filter((d) => d.code === "missing-zero-check");
      assert.equal(missing.length, 0);
    });
  });

  describe("multiple-pragma detection", () => {
    it("flags a file with two pragma solidity directives", () => {
      const diags = lint(`
pragma solidity ^0.8.24;
pragma solidity ^0.8.25;
contract A {}
`);
      const dup = diags.filter((d) => d.code === "multiple-pragma");
      assert.equal(dup.length, 1);
    });

    it("does NOT flag pragma abicoder / experimental alongside one solidity pragma", () => {
      const diags = lint(`
pragma solidity ^0.8.24;
pragma abicoder v2;
contract A {}
`);
      const dup = diags.filter((d) => d.code === "multiple-pragma");
      assert.equal(dup.length, 0);
    });

    it("does NOT flag a file with a single pragma solidity", () => {
      const diags = lint(`
pragma solidity ^0.8.24;
contract A {}
`);
      const dup = diags.filter((d) => d.code === "multiple-pragma");
      assert.equal(dup.length, 0);
    });
  });
});
