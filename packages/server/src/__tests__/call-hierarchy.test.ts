import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { URI } from "vscode-uri";
import { SymbolKind } from "vscode-languageserver/node.js";
import type { CallHierarchyItem } from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import { SolidityParser } from "../parser/solidity-parser.js";
import { SymbolIndex } from "../analyzer/symbol-index.js";
import { GraphIndex } from "../analyzer/graph-index.js";
import { SemanticResolver } from "../analyzer/semantic-resolver.js";
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
  parser: SolidityParser;
  symbolIndex: SymbolIndex;
  workspace: WorkspaceManager;
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
    parser,
    symbolIndex,
    workspace: workspace as WorkspaceManager,
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
    it("prepares call-site roots only from files visible to the current source", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "call-hierarchy-prepare-test-"));
      try {
        const files = {
          "src/Helpers.sol": `function helper() pure returns (uint256) {
    return 1;
}
`,
          "src/Use.sol": `import "./Helpers.sol";
contract Use {
    function run() external pure returns (uint256) {
        return helper();
    }
}
`,
          "test/Helpers.sol": `function helper() pure returns (uint256) {
    return 2;
}
`,
        };
        const uris: string[] = [];
        for (const [name, contents] of Object.entries(files)) {
          const filePath = path.join(tmpDir, name);
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(filePath, contents, "utf-8");
          uris.push(URI.file(filePath).toString());
        }

        const workspace: Pick<WorkspaceManager, "getAllFileUris" | "uriToPath" | "resolveImport"> =
          {
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
          const text = fs.readFileSync(URI.parse(uri).fsPath, "utf-8");
          parser.parse(uri, text);
          symbolIndex.updateFile(uri);
        }
        const resolver = new SemanticResolver(parser, workspace as WorkspaceManager, symbolIndex);
        const provider = new CallHierarchyProvider(
          symbolIndex,
          workspace as WorkspaceManager,
          parser,
          resolver,
        );
        const useUri = URI.file(path.join(tmpDir, "src/Use.sol")).toString();
        const useText = fs.readFileSync(URI.parse(useUri).fsPath, "utf-8");
        const doc = TextDocument.create(useUri, "solidity", 1, useText);
        const line = useText.split("\n").findIndex((candidate) => candidate.includes("helper()"));

        const items = provider.prepareCallHierarchy(doc, {
          line,
          character: useText.split("\n")[line].indexOf("helper") + 1,
        });

        assert.equal(items.length, 1, `expected only source helper, got ${JSON.stringify(items)}`);
        assert.equal(items[0].name, "helper");
        assert.ok(items[0].uri.endsWith("/src/Helpers.sol"));
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

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

    it("does not use same-named test inheritance chains for source incoming calls", async () => {
      const scoped = setupFixture({
        "test/Base.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract TestParent {
    function foo() external {}
}

contract Base is TestParent {}
`,
        "test/UseTestParent.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Base.sol";

contract UseTestParent {
    function run(TestParent parent) external {
        parent.foo();
    }
}
`,
        "src/Base.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract SourceParent {}

contract Base is SourceParent {
    function foo() external {}
}
`,
      });
      try {
        const resolver = new SemanticResolver(scoped.parser, scoped.workspace, scoped.symbolIndex);
        const provider = new CallHierarchyProvider(
          scoped.symbolIndex,
          scoped.workspace,
          scoped.parser,
          resolver,
        );
        const srcBaseUri = URI.file(path.join(scoped.tmpDir, "src/Base.sol")).toString();

        const calls = await provider.getIncomingCalls({
          name: "foo",
          kind: SymbolKind.Function,
          uri: srcBaseUri,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          detail: "Base",
        });

        assert.ok(
          calls.every((call) => call.from.name !== "run"),
          `source Base.foo must not inherit callers through test/Base.sol; got ${calls
            .map((call) => call.from.name)
            .join(", ")}`,
        );
      } finally {
        teardownFixture(scoped);
      }
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

    it("serves outgoing calls from the graph index when available", async () => {
      const graphBacked = setupFixture({
        "A.sol": A_SOL,
        "B.sol": B_SOL,
        "C.sol": C_SOL,
      });
      try {
        const resolver = new SemanticResolver(
          graphBacked.parser,
          graphBacked.workspace,
          graphBacked.symbolIndex,
        );
        const graphIndex = new GraphIndex(
          graphBacked.parser,
          graphBacked.workspace,
          resolver,
          graphBacked.symbolIndex,
        );
        graphIndex.rebuildWorkspace();
        const provider = new CallHierarchyProvider(
          graphBacked.symbolIndex,
          graphBacked.workspace,
          graphBacked.parser,
          resolver,
          graphIndex,
        );

        const calls = await provider.getOutgoingCalls({
          name: "useB",
          kind: SymbolKind.Function,
          uri: graphBacked.bUri,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          detail: "B",
        });

        assert.equal(calls.length, 1);
        assert.equal(calls[0].to.name, "transfer");
        assert.equal(calls[0].to.detail, "A");
        assert.equal(calls[0].fromRanges.length, 1);
      } finally {
        teardownFixture(graphBacked);
      }
    });

    it("uses focused graph indexing for outgoing calls while graph relationships are partial", async () => {
      const graphBacked = setupFixture({
        "A.sol": A_SOL,
        "B.sol": B_SOL,
        "C.sol": C_SOL,
      });
      try {
        const resolver = new SemanticResolver(
          graphBacked.parser,
          graphBacked.workspace,
          graphBacked.symbolIndex,
        );
        const graphIndex = new GraphIndex(
          graphBacked.parser,
          graphBacked.workspace,
          resolver,
          graphBacked.symbolIndex,
        );
        graphIndex.rebuildWorkspaceDeclarations();
        assert.equal(graphIndex.getStats().relationshipIndexComplete, false);

        const provider = new CallHierarchyProvider(
          graphBacked.symbolIndex,
          graphBacked.workspace,
          graphBacked.parser,
          resolver,
          graphIndex,
        );

        const outgoing = await provider.getOutgoingCalls({
          name: "useB",
          kind: SymbolKind.Function,
          uri: graphBacked.bUri,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          detail: "B",
        });

        assert.equal(outgoing.length, 1);
        assert.equal(outgoing[0].to.name, "transfer");
        assert.equal(outgoing[0].to.detail, "A");
        assert.equal(graphIndex.getStats().relationshipIndexComplete, false);

        const incoming = await provider.getIncomingCalls({
          name: "transfer",
          kind: SymbolKind.Function,
          uri: graphBacked.aUri,
          range: { start: { line: 3, character: 4 }, end: { line: 6, character: 5 } },
          selectionRange: { start: { line: 4, character: 13 }, end: { line: 4, character: 21 } },
          detail: "A",
        });
        const incomingNames = incoming.map((call) => call.from.name).sort();
        assert.deepEqual(incomingNames, ["useA", "useB", "useC"]);
        assert.equal(
          graphIndex.getStats().relationshipIndexComplete,
          true,
          "incoming calls should drain the shared graph index instead of falling back to the legacy scanner",
        );
      } finally {
        teardownFixture(graphBacked);
      }
    });

    it("keeps graph-backed outgoing lookup within the interactive budget", async () => {
      const repeatedCalls = Array.from({ length: 120 }, () => "        target.transfer();").join(
        "\n",
      );
      const graphBacked = setupFixture({
        "A.sol": A_SOL,
        "Busy.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./A.sol";

contract Busy {
    function scan(A target) external {
${repeatedCalls}
    }
}
`,
      });
      try {
        const resolver = new SemanticResolver(
          graphBacked.parser,
          graphBacked.workspace,
          graphBacked.symbolIndex,
        );
        const graphIndex = new GraphIndex(
          graphBacked.parser,
          graphBacked.workspace,
          resolver,
          graphBacked.symbolIndex,
        );
        graphIndex.rebuildWorkspace();
        const provider = new CallHierarchyProvider(
          graphBacked.symbolIndex,
          graphBacked.workspace,
          graphBacked.parser,
          resolver,
          graphIndex,
        );

        const started = Date.now();
        const calls = await provider.getOutgoingCalls({
          name: "scan",
          kind: SymbolKind.Function,
          uri: URI.file(path.join(graphBacked.tmpDir, "Busy.sol")).toString(),
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          detail: "Busy",
        });
        const elapsedMs = Date.now() - started;

        assert.ok(
          elapsedMs < 100,
          `expected graph-backed outgoing lookup under 100ms, got ${elapsedMs}ms`,
        );
        assert.equal(calls.length, 1);
        assert.equal(calls[0].to.name, "transfer");
        assert.equal(calls[0].to.detail, "A");
        assert.equal(calls[0].fromRanges.length, 120);
      } finally {
        teardownFixture(graphBacked);
      }
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
    function previewRedeem(uint256 shares) external view returns (uint256 assets);
}
`,
        "src/PoolVault.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./IERC4626.sol";

abstract contract MultiAssetVault {}

abstract contract PoolVault is MultiAssetVault {
    mapping(uint256 => mapping(address => IERC4626)) public vaults;

    function _effectiveBalance(uint256 poolId) internal view returns (uint256 bal) {
        IERC4626 vault = vaults[poolId][address(0)];
        if (address(vault) != address(0)) {
            uint256 shares = 1;
            bal += vault.previewRedeem(shares);
        }
    }

    function _assetBalanceV4(uint256 poolId) internal view returns (uint256 bal) {
        IERC4626 vault = vaults[poolId][address(0)];
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

    function previewRedeem(uint256 shares) public view returns (uint256 assets) {
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

        const preview = calls.find((call) => call.to.name === "previewRedeem");
        assert.ok(preview, "expected previewRedeem outgoing call");
        assert.equal(preview.to.detail, "IERC4626");
        assert.notEqual(preview.to.detail, "MockERC4626");

        const assetCalls = await erc4626.provider.getOutgoingCalls({
          name: "_assetBalanceV4",
          kind: SymbolKind.Function,
          uri: poolVaultUri,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          detail: "PoolVault",
        });
        const convert = assetCalls.find((call) => call.to.name === "convertToAssets");
        assert.ok(convert, "expected convertToAssets outgoing call");
        assert.equal(convert.to.detail, "IERC4626");
        assert.notEqual(convert.to.detail, "MockERC4626");

        const resolver = new SemanticResolver(
          erc4626.parser,
          erc4626.workspace,
          erc4626.symbolIndex,
        );
        const graphIndex = new GraphIndex(
          erc4626.parser,
          erc4626.workspace,
          resolver,
          erc4626.symbolIndex,
        );
        graphIndex.rebuildWorkspace();
        const graphBackedProvider = new CallHierarchyProvider(
          erc4626.symbolIndex,
          erc4626.workspace,
          erc4626.parser,
          resolver,
          graphIndex,
        );

        const graphAssetCalls = await graphBackedProvider.getOutgoingCalls({
          name: "_assetBalanceV4",
          kind: SymbolKind.Function,
          uri: poolVaultUri,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          detail: "PoolVault",
        });
        const graphConvert = graphAssetCalls.find((call) => call.to.name === "convertToAssets");
        assert.ok(graphConvert, "expected graph-backed convertToAssets outgoing call");
        assert.equal(graphConvert.to.detail, "IERC4626");
        assert.notEqual(graphConvert.to.detail, "MockERC4626");

        const interfaceUri = URI.file(path.join(erc4626.tmpDir, "src/IERC4626.sol")).toString();
        const graphConvertCallers = await graphBackedProvider.getIncomingCalls({
          name: "convertToAssets",
          kind: SymbolKind.Function,
          uri: interfaceUri,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          detail: "IERC4626",
        });
        assert.ok(
          graphConvertCallers.some((call) => call.from.name === "_assetBalanceV4"),
          "expected graph-backed callers of IERC4626.convertToAssets to include _assetBalanceV4",
        );

        const mockUri = URI.file(path.join(erc4626.tmpDir, "test/MockERC4626.sol")).toString();
        const mockConvertCallers = await graphBackedProvider.getIncomingCalls({
          name: "convertToAssets",
          kind: SymbolKind.Function,
          uri: mockUri,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          detail: "MockERC4626",
        });
        assert.ok(
          mockConvertCallers.every((call) => call.from.name !== "_assetBalanceV4"),
          "did not expect graph-backed callers of MockERC4626.convertToAssets to include _assetBalanceV4",
        );
      } finally {
        teardownFixture(erc4626);
      }
    });

    it("resolves calls through state variable receiver types", async () => {
      const stateReceiver = setupFixture({
        "src/IAsset.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAsset {
    function transfer(address to, uint256 amount) external returns (bool);
}
`,
        "src/Vault.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./IAsset.sol";

contract Vault {
    IAsset internal asset;

    function pay(address to, uint256 amount) external {
        asset.transfer(to, amount);
    }
}
`,
        "test/MockAsset.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockAsset {
    function transfer(address to) external returns (bool) {
        to;
        return true;
    }
}
`,
      });

      try {
        const vaultUri = URI.file(path.join(stateReceiver.tmpDir, "src/Vault.sol")).toString();
        const calls = await stateReceiver.provider.getOutgoingCalls({
          name: "pay",
          kind: SymbolKind.Function,
          uri: vaultUri,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          detail: "Vault",
        });
        const transfer = calls.find((call) => call.to.name === "transfer");
        assert.ok(transfer, "expected state-variable receiver transfer call");
        assert.equal(transfer.to.detail, "IAsset");
        assert.notEqual(transfer.to.detail, "MockAsset");
      } finally {
        teardownFixture(stateReceiver);
      }
    });

    it("drops only the changed file's call sites on invalidate, leaving other callers intact", async () => {
      // Regression test for the per-keystroke invalidate hot path:
      // `invalidateFile` used to walk every callee name in the
      // workspace map and rebuild each entry's array. We replaced
      // that with an inverse `incomingByFile` index so the walk is
      // O(file) instead of O(workspace). This test pins the
      // resulting correctness contract: rewriting B.sol to drop the
      // call to `transfer` and then invalidating only B must remove
      // useB from A.transfer's incoming list — and must NOT also
      // remove useC, which lives in a different file.
      const local = setupFixture({
        "A.sol": A_SOL,
        "B.sol": B_SOL,
        "C.sol": C_SOL,
      });
      try {
        const before = await local.provider.getIncomingCalls(transferItem(local.aUri, "A"));
        const beforeNames = before.map((c) => c.from.name).sort();
        assert.ok(
          beforeNames.includes("useB") && beforeNames.includes("useC"),
          `expected useB and useC as initial callers, got [${beforeNames.join(", ")}]`,
        );

        // Rewrite B.sol so `useB` no longer calls `transfer`. In the
        // real LSP flow, `documents.onDidChangeContent` re-parses
        // BEFORE invoking `invalidateFile`; we mimic that here so
        // the next call hierarchy query indexes against the fresh
        // AST. Without re-parsing, indexCallsInFile would walk the
        // stale cached AST that still contains the call.
        const bPath = path.join(local.tmpDir, "B.sol");
        const newB = B_SOL.replace("a.transfer();", "uint256 _x = 1; _x;");
        fs.writeFileSync(bPath, newB, "utf-8");
        local.parser.parse(local.bUri, newB);
        local.symbolIndex.updateFile(local.bUri);
        local.provider.invalidateFile(local.bUri);

        const after = await local.provider.getIncomingCalls(transferItem(local.aUri, "A"));
        const afterNames = after.map((c) => c.from.name).sort();
        assert.ok(
          !afterNames.includes("useB"),
          `useB should be gone once B.sol no longer calls transfer; got [${afterNames.join(", ")}]`,
        );
        assert.ok(
          afterNames.includes("useC"),
          `useC must remain after invalidating B.sol — that's the per-file invalidation contract; got [${afterNames.join(", ")}]`,
        );
        assert.ok(
          afterNames.includes("useA"),
          `useA must remain after invalidating B.sol; got [${afterNames.join(", ")}]`,
        );
      } finally {
        teardownFixture(local);
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
