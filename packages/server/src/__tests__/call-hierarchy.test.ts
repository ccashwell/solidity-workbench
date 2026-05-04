import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { URI } from "vscode-uri";
import { SymbolKind } from "vscode-languageserver/node.js";
import type { CallHierarchyItem } from "vscode-languageserver/node.js";
import { SolidityParser } from "../parser/solidity-parser.js";
import { SymbolIndex } from "../analyzer/symbol-index.js";
import { CallHierarchyProvider } from "../providers/call-hierarchy.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";
import type { SolcBridge } from "../compiler/solc-bridge.js";

/**
 * The fixture is intentionally minimal: two contracts `A` and `B` each with
 * an identically-named `transfer` function. The bug these tests guard against
 * is that calls to `A.transfer` used to leak into the incoming-calls list for
 * `B.transfer` (and vice versa) because the call index was keyed by bare
 * function name.
 */
const A_SOL = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract A {
    function transfer() external {
        uint256 noop = 1;
        noop;
    }

    function useA() external {
        this.transfer();
    }
}
`;

const B_SOL = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./A.sol";

contract B {
    function transfer() external {
        uint256 noop = 2;
        noop;
    }

    function useB(A a) external {
        a.transfer();
    }
}
`;

const C_SOL = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./A.sol";

contract C is A {
    function useC(A baseA) external {
        baseA.transfer();
    }
}
`;

interface Fixture {
  tmpDir: string;
  aUri: string;
  bUri: string;
  cUri: string;
  provider: CallHierarchyProvider;
}

function setupFixture(files: Record<string, string>): Fixture {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "call-hierarchy-test-"));
  const uris: string[] = [];
  const uriByName: Record<string, string> = {};

  for (const [name, contents] of Object.entries(files)) {
    const filePath = path.join(tmpDir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents, "utf-8");
    const uri = URI.file(filePath).toString();
    uris.push(uri);
    uriByName[name] = uri;
  }

  const workspace: Pick<WorkspaceManager, "getAllFileUris" | "uriToPath" | "resolveImport"> = {
    getAllFileUris: () => uris.slice(),
    uriToPath: (uri: string) => URI.parse(uri).fsPath,
    resolveImport: (importPath: string, fromFile: string) => {
      if (!importPath.startsWith(".")) return null;
      const target = path.resolve(path.dirname(fromFile), importPath);
      return fs.existsSync(target) ? target : null;
    },
  };

  const parser = new SolidityParser();
  const symbolIndex = new SymbolIndex(parser, workspace as WorkspaceManager);

  for (const uri of uris) {
    const filePath = workspace.uriToPath(uri);
    const text = fs.readFileSync(filePath, "utf-8");
    parser.parse(uri, text);
    symbolIndex.updateFile(uri);
  }

  const provider = new CallHierarchyProvider(symbolIndex, workspace as WorkspaceManager, parser);

  return {
    tmpDir,
    aUri: uriByName["A.sol"] ?? "",
    bUri: uriByName["B.sol"] ?? "",
    cUri: uriByName["C.sol"] ?? "",
    provider,
  };
}

function teardownFixture(fixture: Fixture): void {
  fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
}

function transferItem(uri: string, container: string): CallHierarchyItem {
  return {
    name: "transfer",
    kind: SymbolKind.Function,
    uri,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    detail: container,
  };
}

describe("CallHierarchyProvider", () => {
  let fixture: Fixture;

  before(() => {
    fixture = setupFixture({
      "A.sol": A_SOL,
      "B.sol": B_SOL,
      "C.sol": C_SOL,
    });
  });

  after(() => {
    teardownFixture(fixture);
  });

  describe("getIncomingCalls", () => {
    it("attributes `this.X()` and qualified `a.X()` calls to the right contract", async () => {
      const calls = await fixture.provider.getIncomingCalls(transferItem(fixture.aUri, "A"));
      const callerNames = calls.map((c) => c.from.name).sort();

      assert.ok(
        callerNames.includes("useA"),
        `expected useA (via this.transfer()) in callers, got [${callerNames.join(", ")}]`,
      );
      assert.ok(
        callerNames.includes("useB"),
        `expected useB (via a.transfer() on A-typed parameter) in callers, got [${callerNames.join(
          ", ",
        )}]`,
      );

      // The declaration line of A.transfer itself must not appear as a caller
      // of A.transfer — that would indicate the old signature-line false
      // positive.
      for (const c of calls) {
        assert.notEqual(
          c.from.name,
          "transfer",
          "transfer should not be listed as a caller of itself",
        );
      }
    });

    it("does not contaminate B.transfer with callers of A.transfer", async () => {
      const calls = await fixture.provider.getIncomingCalls(transferItem(fixture.bUri, "B"));
      const callerNames = calls.map((c) => c.from.name);
      assert.deepEqual(
        callerNames,
        [],
        `expected no callers for B.transfer in fixture, got [${callerNames.join(", ")}]`,
      );
    });

    it("resolves parameter-typed receivers through the inheritance chain", async () => {
      // `useC(A baseA)` calls `baseA.transfer()` — the receiver resolves to
      // type `A`, and the target `A.transfer` matches directly. This test
      // also guards that the parameter resolution still finds `baseA` even
      // when the enclosing contract inherits from `A`.
      const calls = await fixture.provider.getIncomingCalls(transferItem(fixture.aUri, "A"));
      const callerNames = calls.map((c) => c.from.name);
      assert.ok(
        callerNames.includes("useC"),
        `expected useC to call A.transfer via parameter-type resolution, got [${callerNames.join(
          ", ",
        )}]`,
      );
    });

    it("associates each caller with the exact source range of the call", async () => {
      const calls = await fixture.provider.getIncomingCalls(transferItem(fixture.aUri, "A"));
      const useB = calls.find((c) => c.from.name === "useB");
      assert.ok(useB, "expected useB caller entry");
      assert.equal(useB.fromRanges.length, 1, "useB should have a single call range");

      const range = useB.fromRanges[0];
      const bText = fs.readFileSync(URI.parse(fixture.bUri).fsPath, "utf-8");
      const lines = bText.split("\n");
      const snippet = lines[range.start.line].slice(range.start.character, range.end.character);
      assert.equal(
        snippet,
        "transfer",
        `recorded call range should point at the callee name; got "${snippet}" on line ${range.start.line}`,
      );
    });
  });

  describe("getOutgoingCalls", () => {
    it("returns the calls made from within a function body", async () => {
      const useBItem: CallHierarchyItem = {
        name: "useB",
        kind: SymbolKind.Function,
        uri: fixture.bUri,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        detail: "B",
      };

      const calls = await fixture.provider.getOutgoingCalls(useBItem);
      const calleeNames = calls.map((c) => c.to.name);
      assert.ok(
        calleeNames.includes("transfer"),
        `expected useB's outgoing calls to include transfer, got [${calleeNames.join(", ")}]`,
      );

      const transfer = calls.find((c) => c.to.name === "transfer");
      assert.ok(transfer, "expected transfer outgoing call");
      const incoming = await fixture.provider.getIncomingCalls(transfer.to);
      const incomingNames = incoming.map((c) => c.from.name);
      assert.ok(
        incomingNames.includes("useB"),
        `expected switching to callers of returned transfer item to include useB, got [${incomingNames.join(
          ", ",
        )}]`,
      );
    });

    it("uses semantic targets for outgoing calls when SolcBridge resolves the callee", async () => {
      const exact = setupFixture({
        "Exact.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract A {
    function transfer() external {}
}

contract B {
    function transfer() external {}
    function use(A a) external {
        a.transfer();
    }
}
`,
      });
      try {
        const exactPath = path.join(exact.tmpDir, "Exact.sol");
        const exactUri = URI.file(exactPath).toString();
        const text = fs.readFileSync(exactPath, "utf-8");
        const targetStart = text.indexOf("function transfer() external {}") + "function ".length;
        exact.provider.setSolcBridge({
          resolveReference: () => ({
            filePath: exactPath,
            offset: targetStart,
            length: "transfer".length,
          }),
        } as unknown as SolcBridge);

        const calls = await exact.provider.getOutgoingCalls({
          name: "use",
          kind: SymbolKind.Function,
          uri: exactUri,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          detail: "B",
        });

        assert.equal(calls.length, 1);
        assert.equal(calls[0].to.name, "transfer");
        assert.equal(calls[0].to.detail, "A");
      } finally {
        teardownFixture(exact);
      }
    });

    it("resolves calls through local variable receiver types before global same-name methods", async () => {
      const erc4626 = setupFixture({
        "src/IERC4626.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC4626 {
    function convertToAssets(uint256 shares) external view returns (uint256 assets);
}
`,
        "src/PoolVault.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./IERC4626.sol";

abstract contract MultiAssetVault {}

abstract contract PoolVault is MultiAssetVault {
    mapping(uint256 => IERC4626) public vaults;

    function _effectiveBalance(uint256 poolId) internal view returns (uint256 bal) {
        IERC4626 vault = vaults[poolId];
        if (address(vault) != address(0)) {
            uint256 shares = 1;
            bal += vault.convertToAssets(shares);
        }
    }
}
`,
        "test/MockERC4626.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockERC4626 {
    function convertToAssets(uint256 shares) public view returns (uint256 assets) {
        return shares;
    }
}
`,
      });

      try {
        const poolVaultUri = URI.file(path.join(erc4626.tmpDir, "src/PoolVault.sol")).toString();
        const calls = await erc4626.provider.getOutgoingCalls({
          name: "_effectiveBalance",
          kind: SymbolKind.Function,
          uri: poolVaultUri,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          detail: "PoolVault",
        });

        const convert = calls.find((call) => call.to.name === "convertToAssets");
        assert.ok(convert, "expected convertToAssets outgoing call");
        assert.equal(convert.to.detail, "IERC4626");
        assert.notEqual(convert.to.detail, "MockERC4626");
      } finally {
        teardownFixture(erc4626);
      }
    });

    it("answers outgoing calls from the active import graph before reading unrelated files", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "call-hierarchy-scope-test-"));
      try {
        const files = {
          "A.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract A {
    function transfer() external {}
}
`,
          "UseA.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./A.sol";

contract UseA {
    function run(A a) external {
        a.transfer();
    }
}
`,
          "Unrelated.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract Unrelated {
    function transfer() external {}
}
`,
        };

        const uris: string[] = [];
        for (const [name, contents] of Object.entries(files)) {
          const filePath = path.join(tmpDir, name);
          fs.writeFileSync(filePath, contents, "utf-8");
          uris.push(URI.file(filePath).toString());
        }

        const unrelatedUri = URI.file(path.join(tmpDir, "Unrelated.sol")).toString();
        const touched: string[] = [];
        const workspace: Pick<WorkspaceManager, "getAllFileUris" | "uriToPath" | "resolveImport"> =
          {
            getAllFileUris: () => uris.slice(),
            uriToPath: (uri: string) => {
              touched.push(uri);
              return URI.parse(uri).fsPath;
            },
            resolveImport: (importPath: string, fromFile: string) => {
              if (!importPath.startsWith(".")) return null;
              const target = path.resolve(path.dirname(fromFile), importPath);
              return fs.existsSync(target) ? target : null;
            },
          };

        const parser = new SolidityParser();
        const symbolIndex = new SymbolIndex(parser, workspace as WorkspaceManager);
        for (const name of ["A.sol", "UseA.sol"]) {
          const filePath = path.join(tmpDir, name);
          const uri = URI.file(filePath).toString();
          parser.parse(uri, fs.readFileSync(filePath, "utf-8"));
          symbolIndex.updateFile(uri);
        }

        const provider = new CallHierarchyProvider(
          symbolIndex,
          workspace as WorkspaceManager,
          parser,
        );
        const useAUri = URI.file(path.join(tmpDir, "UseA.sol")).toString();
        const calls = await provider.getOutgoingCalls({
          name: "run",
          kind: SymbolKind.Function,
          uri: useAUri,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          detail: "UseA",
        });

        assert.equal(calls.length, 1);
        assert.equal(calls[0].to.detail, "A");
        assert.ok(
          !touched.includes(unrelatedUri),
          "outgoing calls should not synchronously read unrelated workspace files",
        );

        await provider.getIncomingCalls(
          transferItem(URI.file(path.join(tmpDir, "A.sol")).toString(), "A"),
        );
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
