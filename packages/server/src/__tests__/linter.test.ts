import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { SolidityParser } from "../parser/solidity-parser.js";
import { SolidityLinter } from "../providers/linter.js";

const parser = new SolidityParser();
const linter = new SolidityLinter();

function lint(code: string) {
  const result = parser.parse("test.sol", code);
  return linter.lint(result.sourceUnit, code);
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
    it("respects solforge-disable-next-line", () => {
      const diags = lint(`
pragma solidity ^0.8.24;

contract Proxy {
    function forward(address impl) external {
        // solforge-disable-next-line
        impl.delegatecall("");
    }
}
`);

      const dc = diags.filter((d) => d.code === "dangerous-delegatecall");
      assert.equal(dc.length, 0, "Should suppress with disable comment");
    });
  });
});
