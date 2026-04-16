import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { URI } from "vscode-uri";
import { SolidityParser } from "../parser/solidity-parser.js";
import { listTests } from "../providers/list-tests.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";

/**
 * `listTests` only asks the workspace for `getAllFileUris` and
 * `uriToPath`. For this suite we pre-parse every file so the provider
 * takes the parser-cache fast path — no filesystem access is required.
 */
function makeWorkspaceWith(uris: string[]): WorkspaceManager {
  return {
    getAllFileUris: () => uris,
    uriToPath: (uri: string) => URI.parse(uri).fsPath,
  } as unknown as WorkspaceManager;
}

describe("listTests", () => {
  it("returns one entry per test contract with its tests", () => {
    const parser = new SolidityParser();
    const uriA = "file:///w/test/Counter.t.sol";
    const uriB = "file:///w/test/Other.t.sol";
    parser.parse(
      uriA,
      `pragma solidity ^0.8.0;
contract CounterTest {
    function setUp() public {}
    function test_one() public pure { return; }
    function testFuzz_two(uint256 x) public pure { x; }
}`,
    );
    parser.parse(
      uriB,
      `pragma solidity ^0.8.0;
contract OtherTest {
    function test_ok() public pure {}
    function invariant_sorted() public pure {}
}`,
    );

    const workspace = makeWorkspaceWith([uriA, uriB]);
    const result = listTests(workspace, parser, {});

    assert.equal(result.contracts.length, 2);

    const counter = result.contracts.find((c) => c.name === "CounterTest")!;
    assert.ok(counter);
    const names = counter.tests.map((t) => t.name).sort();
    // setUp IS returned — the client filters it out, not the server.
    assert.deepEqual(names, ["setUp", "testFuzz_two", "test_one"]);

    const setUpKind = counter.tests.find((t) => t.name === "setUp")!.kind;
    const fuzzKind = counter.tests.find((t) => t.name === "testFuzz_two")!.kind;
    assert.equal(setUpKind, "setUp");
    assert.equal(fuzzKind, "testFuzz");

    const other = result.contracts.find((c) => c.name === "OtherTest")!;
    assert.ok(other);
    const invariant = other.tests.find((t) => t.name === "invariant_sorted")!;
    assert.equal(invariant.kind, "invariant");
  });

  it("filters by folderUri when provided", () => {
    const parser = new SolidityParser();
    const uriA = "file:///w/tests/A.t.sol";
    const uriB = "file:///w/other/B.t.sol";
    parser.parse(uriA, `pragma solidity ^0.8.0; contract AT { function test_a() public {} }`);
    parser.parse(uriB, `pragma solidity ^0.8.0; contract BT { function test_b() public {} }`);

    const workspace = makeWorkspaceWith([uriA, uriB]);
    const result = listTests(workspace, parser, { folderUri: "file:///w/tests" });

    assert.equal(result.contracts.length, 1);
    assert.equal(result.contracts[0].name, "AT");
  });

  it("ignores contracts that have no test-like functions", () => {
    const parser = new SolidityParser();
    const uri = "file:///w/src/Lib.sol";
    parser.parse(
      uri,
      `pragma solidity ^0.8.0;
library Lib { function helper(uint256 x) internal pure returns (uint256) { return x; } }`,
    );

    const workspace = makeWorkspaceWith([uri]);
    const result = listTests(workspace, parser, {});
    assert.equal(result.contracts.length, 0);
  });

  it("handles braces inside strings without miscounting the contract body", () => {
    // This is the regression case that motivated moving off regex parsing.
    const parser = new SolidityParser();
    const uri = "file:///w/test/Hairy.t.sol";
    parser.parse(
      uri,
      `pragma solidity ^0.8.0;
contract HairyTest {
    string private constant JSON = "{{}}{{"; // braces inside a string
    function test_isFine() public pure { return; }
}`,
    );

    const workspace = makeWorkspaceWith([uri]);
    const result = listTests(workspace, parser, {});
    assert.equal(result.contracts.length, 1);
    assert.equal(result.contracts[0].tests.length, 1);
    assert.equal(result.contracts[0].tests[0].name, "test_isFine");
  });
});
