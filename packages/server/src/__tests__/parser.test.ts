import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { SolidityParser } from "../parser/solidity-parser.js";

const parser = new SolidityParser();

describe("SolidityParser", () => {
  describe("basic contract parsing", () => {
    it("parses a simple contract", () => {
      const result = parser.parse(
        "test.sol",
        `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract Counter {
    uint256 public count;

    function increment() external {
        count++;
    }
}
`,
      );

      assert.equal(result.errors.length, 0);
      assert.equal(result.sourceUnit.pragmas.length, 1);
      assert.equal(result.sourceUnit.pragmas[0].name, "solidity");
      assert.equal(result.sourceUnit.contracts.length, 1);

      const contract = result.sourceUnit.contracts[0];
      assert.equal(contract.name, "Counter");
      assert.equal(contract.kind, "contract");
      assert.equal(contract.functions.length, 1);
      assert.equal(contract.functions[0].name, "increment");
      assert.equal(contract.functions[0].visibility, "external");
    });

    it("parses an interface", () => {
      const result = parser.parse(
        "test.sol",
        `
pragma solidity ^0.8.24;

interface ICounter {
    function increment() external;
    function count() external view returns (uint256);
}
`,
      );

      assert.equal(result.errors.length, 0);
      const iface = result.sourceUnit.contracts[0];
      assert.equal(iface.name, "ICounter");
      assert.equal(iface.kind, "interface");
      assert.equal(iface.functions.length, 2);
      assert.equal(iface.functions[1].mutability, "view");
    });

    it("parses a library", () => {
      const result = parser.parse(
        "test.sol",
        `
pragma solidity ^0.8.24;

library Math {
    function add(uint256 a, uint256 b) internal pure returns (uint256) {
        return a + b;
    }
}
`,
      );

      assert.equal(result.errors.length, 0);
      const lib = result.sourceUnit.contracts[0];
      assert.equal(lib.kind, "library");
      assert.equal(lib.functions[0].visibility, "internal");
      assert.equal(lib.functions[0].mutability, "pure");
    });

    it("parses an abstract contract", () => {
      const result = parser.parse(
        "test.sol",
        `
pragma solidity ^0.8.24;

abstract contract Base {
    function foo() external virtual;
}
`,
      );

      assert.equal(result.errors.length, 0);
      const contract = result.sourceUnit.contracts[0];
      assert.equal(contract.kind, "abstract");
      assert.equal(contract.functions[0].isVirtual, true);
      assert.equal(contract.functions[0].body, false);
    });
  });

  describe("inheritance", () => {
    it("parses single inheritance", () => {
      const result = parser.parse(
        "test.sol",
        `
pragma solidity ^0.8.24;

contract Child is Parent {
    function foo() external override {}
}
`,
      );

      const contract = result.sourceUnit.contracts[0];
      assert.equal(contract.baseContracts.length, 1);
      assert.equal(contract.baseContracts[0].baseName, "Parent");
      assert.equal(contract.functions[0].isOverride, true);
    });

    it("parses multiple inheritance", () => {
      const result = parser.parse(
        "test.sol",
        `
pragma solidity ^0.8.24;

contract Pool is IPool, Fees, NoDelegateCall, ReentrancyGuard {
}
`,
      );

      const contract = result.sourceUnit.contracts[0];
      assert.equal(contract.baseContracts.length, 4);
      assert.deepEqual(
        contract.baseContracts.map((b) => b.baseName),
        ["IPool", "Fees", "NoDelegateCall", "ReentrancyGuard"],
      );
    });

    it("parses multiline inheritance", () => {
      const result = parser.parse(
        "test.sol",
        `
pragma solidity ^0.8.24;

contract Pool
    is
    IPool,
    Fees,
    NoDelegateCall
{
}
`,
      );

      const contract = result.sourceUnit.contracts[0];
      assert.equal(contract.baseContracts.length, 3);
    });
  });

  describe("function parsing", () => {
    it("parses constructor", () => {
      const result = parser.parse(
        "test.sol",
        `
pragma solidity ^0.8.24;

contract Token {
    constructor(string memory name, uint256 supply) {
    }
}
`,
      );

      const ctor = result.sourceUnit.contracts[0].functions[0];
      assert.equal(ctor.kind, "constructor");
      assert.equal(ctor.name, null);
      assert.equal(ctor.parameters.length, 2);
      assert.equal(ctor.parameters[0].typeName, "string");
      assert.equal(ctor.parameters[0].storageLocation, "memory");
      assert.equal(ctor.parameters[1].typeName, "uint256");
    });

    it("parses receive and fallback", () => {
      const result = parser.parse(
        "test.sol",
        `
pragma solidity ^0.8.24;

contract Wallet {
    receive() external payable {}
    fallback() external payable {}
}
`,
      );

      const funcs = result.sourceUnit.contracts[0].functions;
      assert.equal(funcs.length, 2);
      assert.equal(funcs[0].kind, "receive");
      assert.equal(funcs[1].kind, "fallback");
    });

    it("parses function with modifiers", () => {
      const result = parser.parse(
        "test.sol",
        `
pragma solidity ^0.8.24;

contract Vault {
    function withdraw(uint256 amount) external nonReentrant onlyOwner returns (bool success) {
        return true;
    }
}
`,
      );

      const func = result.sourceUnit.contracts[0].functions[0];
      assert.equal(func.name, "withdraw");
      assert.equal(func.visibility, "external");
      assert.ok(func.modifiers.includes("nonReentrant"));
      assert.ok(func.modifiers.includes("onlyOwner"));
      assert.equal(func.returnParameters.length, 1);
      assert.equal(func.returnParameters[0].typeName, "bool");
    });
  });

  describe("state variables", () => {
    it("parses various state variable types", () => {
      const result = parser.parse(
        "test.sol",
        `
pragma solidity ^0.8.24;

contract Vars {
    uint256 public count;
    address private owner;
    bool internal initialized;
    mapping(address => uint256) public balances;
    mapping(address => mapping(uint256 => bool)) public nested;
    uint256 public constant MAX = 100;
    address public immutable deployer;
}
`,
      );

      const vars = result.sourceUnit.contracts[0].stateVariables;
      assert.ok(vars.length >= 5);

      const countVar = vars.find((v) => v.name === "count");
      assert.ok(countVar);
      assert.equal(countVar.visibility, "public");

      const ownerVar = vars.find((v) => v.name === "owner");
      assert.ok(ownerVar);
      assert.equal(ownerVar.visibility, "private");
    });

    it("parses nested mapping types correctly", () => {
      const result = parser.parse(
        "test.sol",
        `
pragma solidity ^0.8.24;

contract Maps {
    mapping(address => mapping(bytes32 => uint256)) public deep;
}
`,
      );

      const vars = result.sourceUnit.contracts[0].stateVariables;
      const deepVar = vars.find((v) => v.name === "deep");
      assert.ok(deepVar);
      assert.ok(deepVar.typeName.includes("mapping"));
    });
  });

  describe("events and errors", () => {
    it("parses events with indexed parameters", () => {
      const result = parser.parse(
        "test.sol",
        `
pragma solidity ^0.8.24;

contract Token {
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
}
`,
      );

      const events = result.sourceUnit.contracts[0].events;
      assert.equal(events.length, 2);
      assert.equal(events[0].name, "Transfer");
      assert.equal(events[0].parameters.length, 3);
      assert.equal(events[0].parameters[0].indexed, true);
    });

    it("parses custom errors", () => {
      const result = parser.parse(
        "test.sol",
        `
pragma solidity ^0.8.24;

contract Vault {
    error InsufficientBalance(uint256 available, uint256 required);
    error Unauthorized();
}
`,
      );

      const errors = result.sourceUnit.contracts[0].errors;
      assert.equal(errors.length, 2);
      assert.equal(errors[0].name, "InsufficientBalance");
      assert.equal(errors[0].parameters.length, 2);
      assert.equal(errors[1].name, "Unauthorized");
      assert.equal(errors[1].parameters.length, 0);
    });
  });

  describe("structs and enums", () => {
    it("parses struct definitions", () => {
      const result = parser.parse(
        "test.sol",
        `
pragma solidity ^0.8.24;

contract Pool {
    struct Position {
        uint128 liquidity;
        uint256 feeGrowthInside0LastX128;
        uint256 feeGrowthInside1LastX128;
    }
}
`,
      );

      const structs = result.sourceUnit.contracts[0].structs;
      assert.equal(structs.length, 1);
      assert.equal(structs[0].name, "Position");
      assert.equal(structs[0].members.length, 3);
    });

    it("parses enum definitions", () => {
      const result = parser.parse(
        "test.sol",
        `
pragma solidity ^0.8.24;

contract Token {
    enum Status { Active, Paused, Deprecated }
}
`,
      );

      const enums = result.sourceUnit.contracts[0].enums;
      assert.equal(enums.length, 1);
      assert.equal(enums[0].name, "Status");
      assert.equal(enums[0].members.length, 3);
    });
  });

  describe("imports", () => {
    it("parses named imports", () => {
      const result = parser.parse(
        "test.sol",
        `
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20, Address} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
`,
      );

      assert.equal(result.sourceUnit.imports.length, 2);
      assert.equal(
        result.sourceUnit.imports[0].path,
        "@openzeppelin/contracts/token/ERC20/IERC20.sol",
      );
    });

    it("parses simple imports", () => {
      const result = parser.parse(
        "test.sol",
        `
pragma solidity ^0.8.24;

import "./Counter.sol";
`,
      );

      assert.equal(result.sourceUnit.imports.length, 1);
      assert.equal(result.sourceUnit.imports[0].path, "./Counter.sol");
    });
  });

  describe("error recovery", () => {
    it("recovers from incomplete code", () => {
      const result = parser.parse(
        "test.sol",
        `
pragma solidity ^0.8.24;

contract Broken {
    function foo() external {
        // incomplete
`,
      );

      // Should not throw — parser uses tolerant mode
      assert.ok(result.sourceUnit);
    });

    it("recovers from syntax errors", () => {
      const result = parser.parse("test.sol", `contract { }`);

      // Should produce errors but still return a result
      assert.ok(result);
      assert.ok(result.errors.length > 0 || result.sourceUnit.contracts.length === 0);
    });
  });

  describe("modifiers", () => {
    it("parses modifier definitions", () => {
      const result = parser.parse(
        "test.sol",
        `
pragma solidity ^0.8.24;

contract Access {
    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "Paused");
        _;
    }
}
`,
      );

      const mods = result.sourceUnit.contracts[0].modifiers;
      assert.equal(mods.length, 2);
      assert.equal(mods[0].name, "onlyOwner");
      assert.equal(mods[1].name, "whenNotPaused");
    });
  });

  describe("type name serialization", () => {
    it("serializes complex types in function parameters", () => {
      const result = parser.parse(
        "test.sol",
        `
pragma solidity ^0.8.24;

contract Types {
    function process(
        address payable recipient,
        uint256[] memory amounts,
        bytes32[4] storage keys,
        mapping(address => uint256) storage balances
    ) external {}
}
`,
      );

      const params = result.sourceUnit.contracts[0].functions[0].parameters;
      assert.ok(params.length >= 2);
      assert.ok(params[0].typeName.includes("address"));
      assert.ok(params[1].typeName.includes("uint256"));
    });
  });

  describe("free functions", () => {
    it("parses file-level functions", () => {
      const result = parser.parse(
        "test.sol",
        `
pragma solidity ^0.8.24;

function add(uint256 a, uint256 b) pure returns (uint256) {
    return a + b;
}
`,
      );

      assert.equal(result.sourceUnit.freeFunctions.length, 1);
      assert.equal(result.sourceUnit.freeFunctions[0].name, "add");
      assert.equal(result.sourceUnit.freeFunctions[0].mutability, "pure");
    });
  });

  describe("caching", () => {
    it("caches parse results", () => {
      parser.parse("cache-test.sol", "contract A {}");
      const cached = parser.get("cache-test.sol");
      assert.ok(cached);
      assert.equal(cached.sourceUnit.contracts[0].name, "A");
    });

    it("updates cache on re-parse", () => {
      parser.parse("update-test.sol", "contract A {}");
      parser.parse("update-test.sol", "contract B {}");
      const cached = parser.get("update-test.sol");
      assert.ok(cached);
      assert.equal(cached.sourceUnit.contracts[0].name, "B");
    });
  });

  describe("natspec extraction", () => {
    it("extracts @notice from a triple-slash comment on a contract", () => {
      const result = parser.parse(
        "natspec-contract.sol",
        `
/// @notice A simple counter
contract Counter {}
`,
      );

      const contract = result.sourceUnit.contracts[0];
      assert.ok(contract.natspec, "contract should have natspec");
      assert.equal(contract.natspec.notice, "A simple counter");
    });

    it("extracts multi-tag triple-slash docblock on a function", () => {
      const result = parser.parse(
        "natspec-function.sol",
        `
pragma solidity ^0.8.24;

contract C {
    /// @notice Do something
    /// @dev Only admin
    /// @param x The input
    /// @return result The output
    function foo(uint256 x) external returns (uint256 result) {}
}
`,
      );

      const func = result.sourceUnit.contracts[0].functions[0];
      assert.ok(func.natspec, "function should have natspec");
      assert.equal(func.natspec.notice, "Do something");
      assert.equal(func.natspec.dev, "Only admin");
      assert.equal(func.natspec.params?.x, "The input");
      assert.equal(func.natspec.returns?.result, "The output");
    });

    it("extracts natspec from a block comment (/** ... */) form", () => {
      const result = parser.parse(
        "natspec-block.sol",
        `
pragma solidity ^0.8.24;

contract C {
    /**
     * @notice Transfer tokens
     * @param to Destination address
     * @param amount Number of tokens
     */
    function transfer(address to, uint256 amount) external {}
}
`,
      );

      const func = result.sourceUnit.contracts[0].functions[0];
      assert.ok(func.natspec);
      assert.equal(func.natspec.notice, "Transfer tokens");
      assert.equal(func.natspec.params?.to, "Destination address");
      assert.equal(func.natspec.params?.amount, "Number of tokens");
    });

    it("extracts @custom:tag values", () => {
      const result = parser.parse(
        "natspec-custom.sol",
        `
pragma solidity ^0.8.24;

contract C {
    /// @custom:security High risk
    function dangerous() external {}
}
`,
      );

      const func = result.sourceUnit.contracts[0].functions[0];
      assert.ok(func.natspec);
      assert.equal(func.natspec.custom?.security, "High risk");
    });

    it("joins untagged continuation lines onto the most recent section", () => {
      const result = parser.parse(
        "natspec-continuation.sol",
        `
pragma solidity ^0.8.24;

contract C {
    /// @notice This function does
    /// many important things
    function f() external {}
}
`,
      );

      const func = result.sourceUnit.contracts[0].functions[0];
      assert.ok(func.natspec);
      // Continuation joins with `\n`, not a literal space — Markdown
      // renders a single newline as a soft wrap (visually a space)
      // while preserving the structure for lists / headings the
      // author intended on adjacent lines. See the multi-paragraph
      // and structured-markdown tests below for the cases where the
      // distinction is observable.
      assert.equal(func.natspec.notice, "This function does\nmany important things");
    });

    it("preserves paragraph breaks across blank `///` separator lines", () => {
      const result = parser.parse(
        "natspec-paragraphs.sol",
        `
pragma solidity ^0.8.24;

/// @notice First paragraph of long-form documentation.
///
/// Second paragraph after a blank separator line.
///
/// Third paragraph still flowing prose.
contract C {}
`,
      );

      const contract = result.sourceUnit.contracts[0];
      assert.ok(contract.natspec);
      assert.equal(
        contract.natspec.notice,
        "First paragraph of long-form documentation.\n" +
          "\n" +
          "Second paragraph after a blank separator line.\n" +
          "\n" +
          "Third paragraph still flowing prose.",
      );
    });

    it("preserves markdown structure (headings, lists) inside notice", () => {
      const result = parser.parse(
        "natspec-markdown.sol",
        `
pragma solidity ^0.8.24;

/// @notice Top-level summary.
///
/// ## Lifecycle
/// 1. Acquire lock
/// 2. Settle deltas
/// 3. Release lock
contract C {}
`,
      );

      const contract = result.sourceUnit.contracts[0];
      assert.ok(contract.natspec);
      assert.equal(
        contract.natspec.notice,
        "Top-level summary.\n" +
          "\n" +
          "## Lifecycle\n" +
          "1. Acquire lock\n" +
          "2. Settle deltas\n" +
          "3. Release lock",
      );
    });

    it("returns undefined natspec when no docblock precedes the declaration", () => {
      const result = parser.parse(
        "natspec-none.sol",
        `
pragma solidity ^0.8.24;

contract NoDocs {}
`,
      );

      const contract = result.sourceUnit.contracts[0];
      assert.equal(contract.natspec, undefined);
    });

    it("allows blank lines between preceding imports/pragmas and the natspec block", () => {
      const result = parser.parse(
        "natspec-import-gap.sol",
        `
pragma solidity ^0.8.24;
import "./foo.sol";

/// @notice Hello
contract X {}
`,
      );

      const contract = result.sourceUnit.contracts[0];
      assert.ok(contract.natspec);
      assert.equal(contract.natspec.notice, "Hello");
    });

    it("extracts natspec for events and errors", () => {
      const result = parser.parse(
        "natspec-event-error.sol",
        `
pragma solidity ^0.8.24;

contract C {
    /// @notice Emitted on transfer
    event T();
    /// @notice Thrown on fail
    error E();
}
`,
      );

      const contract = result.sourceUnit.contracts[0];
      const evt = contract.events[0];
      const err = contract.errors[0];

      assert.ok(evt.natspec, "event should have natspec");
      assert.equal(evt.natspec.notice, "Emitted on transfer");

      assert.ok(err.natspec, "error should have natspec");
      assert.equal(err.natspec.notice, "Thrown on fail");
    });

    it("stores @inheritdoc under custom.inheritdoc", () => {
      const result = parser.parse(
        "natspec-inheritdoc.sol",
        `
pragma solidity ^0.8.24;

contract C {
    /// @inheritdoc IFoo
    function foo() external {}
}
`,
      );

      const func = result.sourceUnit.contracts[0].functions[0];
      assert.ok(func.natspec);
      assert.equal(func.natspec.custom?.inheritdoc, "IFoo");
    });

    it("does not treat a regular /* ... */ comment as natspec", () => {
      const result = parser.parse(
        "natspec-regular-block.sol",
        `
pragma solidity ^0.8.24;

/* Just a regular comment, not NatSpec */
contract Plain {}
`,
      );

      const contract = result.sourceUnit.contracts[0];
      assert.equal(contract.natspec, undefined);
    });
  });
});
