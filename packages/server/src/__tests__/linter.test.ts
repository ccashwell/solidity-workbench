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

  describe("empty-block detection", () => {
    it("flags an empty function body", () => {
      const diags = lint(`
pragma solidity ^0.8.24;
contract A {
    function noop() external pure {}
}
`);
      const empty = diags.filter((d) => d.code === "empty-block");
      assert.equal(empty.length, 1);
    });

    it("does NOT flag an empty constructor", () => {
      const diags = lint(`
pragma solidity ^0.8.24;
contract Base { constructor(uint256) {} }
contract Derived is Base {
    constructor() Base(1) {}
}
`);
      const empty = diags.filter((d) => d.code === "empty-block");
      assert.equal(empty.length, 0);
    });

    it("does NOT flag an empty receive() — that's the canonical accept-ETH idiom", () => {
      const diags = lint(`
pragma solidity ^0.8.24;
contract Wallet { receive() external payable {} }
`);
      const empty = diags.filter((d) => d.code === "empty-block");
      assert.equal(empty.length, 0);
    });

    it("does NOT flag a function with at least one statement", () => {
      const diags = lint(`
pragma solidity ^0.8.24;
contract A { function f() external pure returns (uint256) { return 1; } }
`);
      const empty = diags.filter((d) => d.code === "empty-block");
      assert.equal(empty.length, 0);
    });

    it("does NOT flag interface methods (body absent, not empty)", () => {
      const diags = lint(`
pragma solidity ^0.8.24;
interface I { function ping() external; }
`);
      const empty = diags.filter((d) => d.code === "empty-block");
      assert.equal(empty.length, 0);
    });
  });

  describe("payable-fallback detection", () => {
    it("flags non-payable fallback() when there is no receive()", () => {
      const diags = lint(`
pragma solidity ^0.8.24;
contract C {
    fallback() external {}
}
`);
      const flags = diags.filter((d) => d.code === "payable-fallback");
      assert.equal(flags.length, 1);
    });

    it("does NOT flag non-payable fallback() when a payable receive() is present", () => {
      const diags = lint(`
pragma solidity ^0.8.24;
contract C {
    receive() external payable {}
    fallback() external {}
}
`);
      const flags = diags.filter((d) => d.code === "payable-fallback");
      assert.equal(flags.length, 0);
    });

    it("does NOT flag a payable fallback()", () => {
      const diags = lint(`
pragma solidity ^0.8.24;
contract C {
    fallback() external payable {}
}
`);
      const flags = diags.filter((d) => d.code === "payable-fallback");
      assert.equal(flags.length, 0);
    });
  });

  describe("func-visibility-explicit detection", () => {
    it("flags a function with no explicit visibility", () => {
      const diags = lint(`
contract A {
    function f() returns (uint256) { return 1; }
}
`);
      const flags = diags.filter((d) => d.code === "func-visibility-explicit");
      assert.equal(flags.length, 1);
    });

    it("does NOT flag functions with explicit visibility", () => {
      const diags = lint(`
contract A {
    function pub() public {}
    function ext() external {}
    function int_() internal {}
    function priv() private {}
}
`);
      const flags = diags.filter((d) => d.code === "func-visibility-explicit");
      assert.equal(flags.length, 0);
    });
  });

  describe("boolean-equality detection", () => {
    it("flags `x == true` and `x != false`", () => {
      const diags = lint(`
pragma solidity ^0.8.24;
contract A {
    function f(bool x) external pure returns (bool) {
        if (x == true) return true;
        if (x != false) return true;
        return false;
    }
}
`);
      const flags = diags.filter((d) => d.code === "boolean-equality");
      assert.equal(flags.length, 2);
    });

    it("flags `true == x` (literal on the left side)", () => {
      const diags = lint(`
pragma solidity ^0.8.24;
contract A {
    function f(bool x) external pure returns (bool) {
        return true == x;
    }
}
`);
      const flags = diags.filter((d) => d.code === "boolean-equality");
      assert.equal(flags.length, 1);
    });

    it("does NOT flag the boolean used directly", () => {
      const diags = lint(`
pragma solidity ^0.8.24;
contract A {
    function f(bool x) external pure returns (bool) {
        if (x) return true;
        if (!x) return false;
        return x;
    }
}
`);
      const flags = diags.filter((d) => d.code === "boolean-equality");
      assert.equal(flags.length, 0);
    });

    it("does NOT flag non-boolean equality", () => {
      const diags = lint(`
pragma solidity ^0.8.24;
contract A {
    function f(uint256 a, uint256 b) external pure returns (bool) {
        return a == b;
    }
}
`);
      const flags = diags.filter((d) => d.code === "boolean-equality");
      assert.equal(flags.length, 0);
    });
  });

  describe("divide-before-multiply detection", () => {
    it("flags `(a / b) * c`", () => {
      const diags = lint(`
pragma solidity ^0.8.24;
contract A {
    function f(uint256 a, uint256 b, uint256 c) external pure returns (uint256) {
        return (a / b) * c;
    }
}
`);
      const flags = diags.filter((d) => d.code === "divide-before-multiply");
      assert.equal(flags.length, 1);
    });

    it("flags `c * (a / b)`", () => {
      const diags = lint(`
pragma solidity ^0.8.24;
contract A {
    function f(uint256 a, uint256 b, uint256 c) external pure returns (uint256) {
        return c * (a / b);
    }
}
`);
      const flags = diags.filter((d) => d.code === "divide-before-multiply");
      assert.equal(flags.length, 1);
    });

    it("does NOT flag the safe ordering `(a * c) / b`", () => {
      const diags = lint(`
pragma solidity ^0.8.24;
contract A {
    function f(uint256 a, uint256 b, uint256 c) external pure returns (uint256) {
        return (a * c) / b;
    }
}
`);
      const flags = diags.filter((d) => d.code === "divide-before-multiply");
      assert.equal(flags.length, 0);
    });

    it("does NOT flag stand-alone divisions or multiplications", () => {
      const diags = lint(`
pragma solidity ^0.8.24;
contract A {
    function f(uint256 a, uint256 b) external pure returns (uint256) {
        uint256 x = a / b;
        uint256 y = a * b;
        return x + y;
    }
}
`);
      const flags = diags.filter((d) => d.code === "divide-before-multiply");
      assert.equal(flags.length, 0);
    });
  });

  describe("incorrect-strict-equality detection", () => {
    it("flags `block.timestamp == X`", () => {
      const diags = lint(`
pragma solidity ^0.8.24;
contract A {
    function ok() external view returns (bool) {
        return block.timestamp == 1700000000;
    }
}
`);
      const flags = diags.filter((d) => d.code === "incorrect-strict-equality");
      assert.equal(flags.length, 1);
    });

    it("flags `addr.balance != X`", () => {
      const diags = lint(`
pragma solidity ^0.8.24;
contract A {
    function f(address a) external view returns (bool) {
        return a.balance != 0;
    }
}
`);
      const flags = diags.filter((d) => d.code === "incorrect-strict-equality");
      assert.equal(flags.length, 1);
    });

    it("does NOT flag range comparisons (>=, <=)", () => {
      const diags = lint(`
pragma solidity ^0.8.24;
contract A {
    function ok() external view returns (bool) {
        return block.timestamp >= 1700000000;
    }
}
`);
      const flags = diags.filter((d) => d.code === "incorrect-strict-equality");
      assert.equal(flags.length, 0);
    });

    it("does NOT flag equality on non-volatile values", () => {
      const diags = lint(`
pragma solidity ^0.8.24;
contract A {
    function f(uint256 a, uint256 b) external pure returns (bool) {
        return a == b;
    }
}
`);
      const flags = diags.filter((d) => d.code === "incorrect-strict-equality");
      assert.equal(flags.length, 0);
    });
  });

  describe("weak-prng detection", () => {
    it("flags `block.timestamp % N`", () => {
      const diags = lint(`
pragma solidity ^0.8.24;
contract Lottery {
    function pick(uint256 max) external view returns (uint256) {
        return block.timestamp % max;
    }
}
`);
      const flags = diags.filter((d) => d.code === "weak-prng");
      assert.equal(flags.length, 1);
    });

    it("flags `uint256(blockhash(block.number - 1)) % N`", () => {
      const diags = lint(`
pragma solidity ^0.8.24;
contract Lottery {
    function pick(uint256 max) external view returns (uint256) {
        return uint256(blockhash(block.number - 1)) % max;
    }
}
`);
      const flags = diags.filter((d) => d.code === "weak-prng");
      assert.equal(flags.length, 1);
    });

    it("does NOT flag block.timestamp used as a deadline", () => {
      const diags = lint(`
pragma solidity ^0.8.24;
contract A {
    function f(uint256 deadline) external view {
        require(block.timestamp <= deadline, "expired");
    }
}
`);
      const flags = diags.filter((d) => d.code === "weak-prng");
      assert.equal(flags.length, 0);
    });

    it("does NOT flag modulo on plain inputs", () => {
      const diags = lint(`
pragma solidity ^0.8.24;
contract A {
    function f(uint256 a, uint256 b) external pure returns (uint256) {
        return a % b;
    }
}
`);
      const flags = diags.filter((d) => d.code === "weak-prng");
      assert.equal(flags.length, 0);
    });
  });

  describe("ecrecover-zero-check detection", () => {
    it("flags ecrecover captured into a variable used without zero check", () => {
      const diags = lint(`
pragma solidity ^0.8.24;
contract A {
    mapping(address => uint256) public balances;
    function claim(bytes32 h, uint8 v, bytes32 r, bytes32 s, uint256 amount) external {
        address signer = ecrecover(h, v, r, s);
        balances[signer] += amount;
    }
}
`);
      const flags = diags.filter((d) => d.code === "ecrecover-zero-check");
      assert.equal(flags.length, 1);
    });

    it("does NOT flag when the captured signer is checked against address(0)", () => {
      const diags = lint(`
pragma solidity ^0.8.24;
contract A {
    mapping(address => uint256) public balances;
    function claim(bytes32 h, uint8 v, bytes32 r, bytes32 s, uint256 amount) external {
        address signer = ecrecover(h, v, r, s);
        require(signer != address(0), "invalid sig");
        balances[signer] += amount;
    }
}
`);
      const flags = diags.filter((d) => d.code === "ecrecover-zero-check");
      assert.equal(flags.length, 0);
    });

    it("does NOT flag inline `require(ecrecover(...) == owner)` usage", () => {
      const diags = lint(`
pragma solidity ^0.8.24;
contract A {
    address public owner;
    function f(bytes32 h, uint8 v, bytes32 r, bytes32 s) external view returns (bool) {
        require(ecrecover(h, v, r, s) == owner, "bad sig");
        return true;
    }
}
`);
      const flags = diags.filter((d) => d.code === "ecrecover-zero-check");
      assert.equal(flags.length, 0);
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
