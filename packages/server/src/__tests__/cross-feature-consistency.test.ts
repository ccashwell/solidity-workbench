import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SymbolKind } from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import { GraphIndex } from "../analyzer/graph-index.js";
import { SemanticResolver } from "../analyzer/semantic-resolver.js";
import { SymbolIndex } from "../analyzer/symbol-index.js";
import { SolidityParser } from "../parser/solidity-parser.js";
import { CallHierarchyProvider } from "../providers/call-hierarchy.js";
import { CompletionProvider } from "../providers/completion.js";
import { DefinitionProvider } from "../providers/definition.js";
import { HoverProvider } from "../providers/hover.js";
import { SignatureHelpProvider } from "../providers/signature-help.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";

describe("cross-feature semantic consistency", () => {
  it("resolves typed receiver calls to the same imported interface across graph and LSP providers", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-consistency-"));
    try {
      const files = {
        "src/IERC4626.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC4626 {
    function convertToAssets(uint256 shares) external view returns (uint256 assets);
}
`,
        "src/PoolVault.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./IERC4626.sol";

abstract contract PoolVault {
    mapping(uint256 => mapping(address => IERC4626)) public vaults;

    function _assetBalanceV4(uint256 poolId) internal view returns (uint256 bal) {
        IERC4626 vault = vaults[poolId][address(0)];
        uint256 shares = 1;
        bal += vault.convertToAssets(shares);
    }
}
`,
        "test/MockERC4626.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockERC4626 {
    function convertToAssets(address account) external view returns (uint256 assets) {
        account;
        return 0;
    }
}
`,
      };

      const uris: string[] = [];
      const parser = new SolidityParser();
      const docs: Record<string, TextDocument> = {};
      for (const [name, contents] of Object.entries(files)) {
        const filePath = path.join(tmpDir, name);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, contents, "utf-8");
        const uri = URI.file(filePath).toString();
        uris.push(uri);
        parser.parse(uri, contents);
        docs[name] = TextDocument.create(uri, "solidity", 1, contents);
      }

      const workspace = makeWorkspace(tmpDir, uris);
      const symbolIndex = new SymbolIndex(parser, workspace);
      for (const uri of uris) symbolIndex.updateFile(uri);
      const resolver = new SemanticResolver(parser, workspace, symbolIndex);
      const graph = new GraphIndex(parser, workspace, resolver, symbolIndex);
      graph.rebuildWorkspace();

      const definitionProvider = new DefinitionProvider(symbolIndex, parser, workspace, resolver);
      const hoverProvider = new HoverProvider(symbolIndex, parser, workspace, resolver);
      const signatureProvider = new SignatureHelpProvider(symbolIndex, parser, resolver);
      const callHierarchyProvider = new CallHierarchyProvider(
        symbolIndex,
        workspace,
        parser,
        resolver,
        graph,
      );

      const poolDoc = docs["src/PoolVault.sol"];
      const poolText = files["src/PoolVault.sol"];
      const callLine = poolText.split("\n").findIndex((line) => line.includes("convertToAssets"));
      const callColumn = poolText.split("\n")[callLine].indexOf("convertToAssets");
      const callPosition = { line: callLine, character: callColumn + 1 };
      const signaturePosition = {
        line: callLine,
        character: callColumn + "convertToAssets(".length,
      };

      const interfaceNode = graph
        .getNodes()
        .find((node) => node.name === "convertToAssets" && node.containerName === "IERC4626");
      const mockNode = graph
        .getNodes()
        .find((node) => node.name === "convertToAssets" && node.containerName === "MockERC4626");
      const callerNode = graph
        .getNodes()
        .find((node) => node.name === "_assetBalanceV4" && node.containerName === "PoolVault");
      assert.ok(interfaceNode, "expected IERC4626.convertToAssets graph node");
      assert.ok(mockNode, "expected MockERC4626.convertToAssets graph node");
      assert.ok(callerNode, "expected PoolVault._assetBalanceV4 graph node");

      const graphCalls = graph.getOutgoingEdges(callerNode.id, "calls");
      assert.ok(
        graphCalls.some((edge) => edge.target === interfaceNode.id),
        "Project Graph should target IERC4626.convertToAssets",
      );
      assert.ok(
        graphCalls.every((edge) => edge.target !== mockNode.id),
        "Project Graph must not target MockERC4626.convertToAssets",
      );

      const definition = definitionProvider.provideDefinition(poolDoc, callPosition);
      assert.ok(definition, "expected definition for receiver call");
      const definitionLocation = Array.isArray(definition) ? definition[0] : definition;
      assert.ok("uri" in definitionLocation, "expected Location definition");
      assert.equal(
        definitionLocation.uri,
        URI.file(path.join(tmpDir, "src/IERC4626.sol")).toString(),
      );

      const hover = hoverProvider.provideHover(poolDoc, callPosition);
      assert.ok(hover && typeof hover.contents === "object" && "value" in hover.contents);
      assert.match(hover.contents.value, /convertToAssets/);
      assert.match(hover.contents.value, /Defined in.*IERC4626/);
      assert.doesNotMatch(hover.contents.value, /MockERC4626/);

      const signature = signatureProvider.provideSignatureHelp(poolDoc, signaturePosition);
      assert.ok(signature, "expected signature help for receiver call");
      assert.equal(signature.signatures.length, 1);
      assert.match(signature.signatures[0].label, /convertToAssets\(uint256 shares\)/);
      assert.doesNotMatch(signature.signatures[0].label, /address account/);

      const outgoing = await callHierarchyProvider.getOutgoingCalls({
        name: "_assetBalanceV4",
        kind: SymbolKind.Function,
        uri: poolDoc.uri,
        range: callerNode.range,
        selectionRange: callerNode.selectionRange,
        detail: "PoolVault",
      });
      const callHierarchyTarget = outgoing.find((call) => call.to.name === "convertToAssets");
      assert.ok(callHierarchyTarget, "expected call hierarchy target");
      assert.equal(callHierarchyTarget.to.detail, "IERC4626");
      assert.notEqual(callHierarchyTarget.to.detail, "MockERC4626");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolves imported using-for aliases consistently across graph and LSP providers", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-consistency-"));
    try {
      const files = {
        "src/DataTypes.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

struct Data {
    uint256 value;
}
`,
        "src/DataLib.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./DataTypes.sol";

library DataLib {
    function bump(Data storage self, uint256 by) internal returns (uint256 next) {
        self.value += by;
        return self.value;
    }
}
`,
        "src/UsesData.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Data } from "./DataTypes.sol";
import { DataLib as RenamedDataLib } from "./DataLib.sol";

contract UsesData {
    using RenamedDataLib for Data;

    Data internal data;

    function run(uint256 by) external returns (uint256) {
        return data.bump(by);
    }
}
`,
        "test/DataLib.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library DataLib {
    function bump(uint256 self) internal pure returns (uint256) {
        return self;
    }
}
`,
      };

      const uris: string[] = [];
      const parser = new SolidityParser();
      const docs: Record<string, TextDocument> = {};
      for (const [name, contents] of Object.entries(files)) {
        const filePath = path.join(tmpDir, name);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, contents, "utf-8");
        const uri = URI.file(filePath).toString();
        uris.push(uri);
        parser.parse(uri, contents);
        docs[name] = TextDocument.create(uri, "solidity", 1, contents);
      }

      const workspace = makeWorkspace(tmpDir, uris);
      const symbolIndex = new SymbolIndex(parser, workspace);
      for (const uri of uris) symbolIndex.updateFile(uri);
      const resolver = new SemanticResolver(parser, workspace, symbolIndex);
      const graph = new GraphIndex(parser, workspace, resolver, symbolIndex);
      graph.rebuildWorkspace();

      const definitionProvider = new DefinitionProvider(symbolIndex, parser, workspace, resolver);
      const hoverProvider = new HoverProvider(symbolIndex, parser, workspace, resolver);
      const signatureProvider = new SignatureHelpProvider(symbolIndex, parser, resolver);
      const callHierarchyProvider = new CallHierarchyProvider(
        symbolIndex,
        workspace,
        parser,
        resolver,
        graph,
      );

      const usesDoc = docs["src/UsesData.sol"];
      const usesText = files["src/UsesData.sol"];
      const callLine = usesText.split("\n").findIndex((line) => line.includes("data.bump"));
      const callColumn = usesText.split("\n")[callLine].indexOf("bump");
      const callPosition = { line: callLine, character: callColumn + 1 };
      const signaturePosition = { line: callLine, character: callColumn + "bump(".length };

      const srcBump = graph
        .getNodes()
        .find(
          (node) =>
            node.name === "bump" && node.containerName === "DataLib" && node.tier === "project",
        );
      const testBump = graph
        .getNodes()
        .find(
          (node) =>
            node.name === "bump" && node.containerName === "DataLib" && node.tier === "tests",
        );
      const runNode = graph
        .getNodes()
        .find((node) => node.name === "run" && node.containerName === "UsesData");
      assert.ok(srcBump, "expected project DataLib.bump graph node");
      assert.ok(testBump, "expected test DataLib.bump graph node");
      assert.ok(runNode, "expected UsesData.run graph node");

      const graphCalls = graph.getOutgoingEdges(runNode.id, "calls");
      assert.ok(
        graphCalls.some((edge) => edge.target === srcBump.id),
        "Project Graph should target imported DataLib.bump",
      );
      assert.ok(
        graphCalls.every((edge) => edge.target !== testBump.id),
        "Project Graph must not target test DataLib.bump",
      );

      const definition = definitionProvider.provideDefinition(usesDoc, callPosition);
      assert.ok(definition, "expected definition for using-for call");
      const definitionLocation = Array.isArray(definition) ? definition[0] : definition;
      assert.ok("uri" in definitionLocation, "expected Location definition");
      assert.equal(
        definitionLocation.uri,
        URI.file(path.join(tmpDir, "src/DataLib.sol")).toString(),
      );

      const hover = hoverProvider.provideHover(usesDoc, callPosition);
      assert.ok(hover && typeof hover.contents === "object" && "value" in hover.contents);
      assert.match(hover.contents.value, /bump/);
      assert.match(hover.contents.value, /Defined in.*DataLib/);

      const signature = signatureProvider.provideSignatureHelp(usesDoc, signaturePosition);
      assert.ok(signature, "expected signature help for using-for call");
      assert.equal(signature.signatures.length, 1);
      assert.match(signature.signatures[0].label, /bump\(uint256 by\)/);
      assert.doesNotMatch(signature.signatures[0].label, /uint256 self/);

      const outgoing = await callHierarchyProvider.getOutgoingCalls({
        name: "run",
        kind: SymbolKind.Function,
        uri: usesDoc.uri,
        range: runNode.range,
        selectionRange: runNode.selectionRange,
        detail: "UsesData",
      });
      const callHierarchyTarget = outgoing.find((call) => call.to.name === "bump");
      assert.ok(callHierarchyTarget, "expected call hierarchy target");
      assert.equal(
        callHierarchyTarget.to.uri,
        URI.file(path.join(tmpDir, "src/DataLib.sol")).toString(),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolves imported free-function using-for member aliases consistently", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-consistency-"));
    try {
      const files = {
        "src/DataTypes.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

struct Data {
    uint256 value;
}
`,
        "src/FreeOps.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./DataTypes.sol";

/// @notice Clears the stored value.
function clear(Data storage self, uint256 replacement) returns (uint256 oldValue) {
    oldValue = self.value;
    self.value = replacement;
}
`,
        "src/UsesFreeOps.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Data } from "./DataTypes.sol";
import { clear } from "./FreeOps.sol";

using {clear as wipe} for Data;

contract UsesFreeOps {
    Data internal data;

    function run(uint256 replacement) external returns (uint256) {
        return data.wipe(replacement);
    }
}
`,
        "test/FreeOps.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

function clear(uint256 self) pure returns (uint256) {
    return self;
}
`,
      };

      const uris: string[] = [];
      const parser = new SolidityParser();
      const docs: Record<string, TextDocument> = {};
      for (const [name, contents] of Object.entries(files)) {
        const filePath = path.join(tmpDir, name);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, contents, "utf-8");
        const uri = URI.file(filePath).toString();
        uris.push(uri);
        parser.parse(uri, contents);
        docs[name] = TextDocument.create(uri, "solidity", 1, contents);
      }

      const workspace = makeWorkspace(tmpDir, uris);
      const symbolIndex = new SymbolIndex(parser, workspace);
      for (const uri of uris) symbolIndex.updateFile(uri);
      const resolver = new SemanticResolver(parser, workspace, symbolIndex);
      const graph = new GraphIndex(parser, workspace, resolver, symbolIndex);
      graph.rebuildWorkspace();

      const definitionProvider = new DefinitionProvider(symbolIndex, parser, workspace, resolver);
      const hoverProvider = new HoverProvider(symbolIndex, parser, workspace, resolver);
      const signatureProvider = new SignatureHelpProvider(symbolIndex, parser, resolver);
      const completionProvider = new CompletionProvider(symbolIndex, parser, workspace, resolver);
      const callHierarchyProvider = new CallHierarchyProvider(
        symbolIndex,
        workspace,
        parser,
        resolver,
        graph,
      );

      const usesDoc = docs["src/UsesFreeOps.sol"];
      const usesText = files["src/UsesFreeOps.sol"];
      const callLine = usesText.split("\n").findIndex((line) => line.includes("data.wipe"));
      const callColumn = usesText.split("\n")[callLine].indexOf("wipe");
      const callPosition = { line: callLine, character: callColumn + 1 };
      const signaturePosition = { line: callLine, character: callColumn + "wipe(".length };
      const completionPosition = {
        line: callLine,
        character: usesText.split("\n")[callLine].indexOf("data.") + "data.".length,
      };

      const sourceClear = graph
        .getNodes()
        .find((node) => node.name === "clear" && node.filePath.endsWith("src/FreeOps.sol"));
      const testClear = graph
        .getNodes()
        .find((node) => node.name === "clear" && node.filePath.endsWith("test/FreeOps.sol"));
      const runNode = graph
        .getNodes()
        .find((node) => node.name === "run" && node.containerName === "UsesFreeOps");
      assert.ok(sourceClear, "expected imported source clear graph node");
      assert.ok(testClear, "expected same-name test clear graph node");
      assert.ok(runNode, "expected UsesFreeOps.run graph node");

      const graphCalls = graph.getOutgoingEdges(runNode.id, "calls");
      assert.ok(
        graphCalls.some((edge) => edge.target === sourceClear.id),
        "Project Graph should target imported clear() through data.wipe()",
      );
      assert.ok(
        graphCalls.every((edge) => edge.target !== testClear.id),
        "Project Graph must not target same-name test clear()",
      );

      const definition = definitionProvider.provideDefinition(usesDoc, callPosition);
      assert.ok(definition, "expected definition for using-for alias call");
      const definitionLocation = Array.isArray(definition) ? definition[0] : definition;
      assert.ok("uri" in definitionLocation, "expected Location definition");
      assert.equal(
        definitionLocation.uri,
        URI.file(path.join(tmpDir, "src/FreeOps.sol")).toString(),
      );

      const hover = hoverProvider.provideHover(usesDoc, callPosition);
      assert.ok(hover && typeof hover.contents === "object" && "value" in hover.contents);
      assert.match(hover.contents.value, /clear/);
      assert.match(hover.contents.value, /Clears the stored value/);
      assert.doesNotMatch(hover.contents.value, /test\/FreeOps/);

      const signature = signatureProvider.provideSignatureHelp(usesDoc, signaturePosition);
      assert.ok(signature, "expected signature help for using-for alias call");
      assert.equal(signature.signatures.length, 1);
      assert.match(signature.signatures[0].label, /clear\(uint256 replacement\)/);
      assert.doesNotMatch(signature.signatures[0].label, /Data storage self/);

      const completionLabels = completionProvider
        .provideCompletions(usesDoc, completionPosition)
        .map((item) => item.label);
      assert.ok(completionLabels.includes("wipe"), "expected completion for exposed alias");
      assert.equal(completionLabels.includes("clear"), false, "did not expect raw function name");

      const outgoing = await callHierarchyProvider.getOutgoingCalls({
        name: "run",
        kind: SymbolKind.Function,
        uri: usesDoc.uri,
        range: runNode.range,
        selectionRange: runNode.selectionRange,
        detail: "UsesFreeOps",
      });
      const callHierarchyTarget = outgoing.find((call) => call.to.name === "clear");
      assert.ok(callHierarchyTarget, "expected call hierarchy target");
      assert.equal(
        callHierarchyTarget.to.uri,
        URI.file(path.join(tmpDir, "src/FreeOps.sol")).toString(),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

function makeWorkspace(tmpDir: string, uris: string[]): WorkspaceManager {
  return {
    getAllFileUris: () => uris.slice(),
    getFileTier: (uri: string) => (URI.parse(uri).fsPath.includes("/src/") ? "project" : "tests"),
    resolveImport: (importPath: string, fromFile: string) => {
      const target = path.resolve(path.dirname(fromFile), importPath);
      return fs.existsSync(target) ? target : null;
    },
    uriToPath: (uri: string) => URI.parse(uri).fsPath,
    root: tmpDir,
  } as unknown as WorkspaceManager;
}
