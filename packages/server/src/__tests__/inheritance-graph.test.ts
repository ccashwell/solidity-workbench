import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { URI } from "vscode-uri";
import { GraphIndex } from "../analyzer/graph-index.js";
import { SemanticResolver } from "../analyzer/semantic-resolver.js";
import { SymbolIndex } from "../analyzer/symbol-index.js";
import { SolidityParser } from "../parser/solidity-parser.js";
import { InheritanceGraphProvider } from "../providers/inheritance-graph.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";

describe("InheritanceGraphProvider", () => {
  it("filters scoped tiers and resolves duplicate bases through imports", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inheritance-graph-test-"));
    try {
      const files = {
        "src/Base.sol": `pragma solidity ^0.8.24;
contract Base {}
`,
        "src/Child.sol": `pragma solidity ^0.8.24;
import "./Base.sol";
contract Child is Base {}
`,
        "src/UsesDep.sol": `pragma solidity ^0.8.24;
import "../lib/Dep.sol";
contract UsesDep is Dep {}
`,
        "lib/Dep.sol": `pragma solidity ^0.8.24;
contract Dep {}
`,
        "test/Base.sol": `pragma solidity ^0.8.24;
contract Base {}
`,
      };

      const uris: string[] = [];
      const parser = new SolidityParser();
      for (const [name, contents] of Object.entries(files)) {
        const filePath = path.join(tmpDir, name);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, contents, "utf-8");
        const uri = URI.file(filePath).toString();
        uris.push(uri);
        parser.parse(uri, contents);
      }

      const workspace: Pick<
        WorkspaceManager,
        "getAllFileUris" | "getFileTier" | "resolveImport" | "uriToPath"
      > = {
        getAllFileUris: () => uris.slice(),
        getFileTier: (uri: string) =>
          URI.parse(uri).fsPath.includes("/test/")
            ? "tests"
            : URI.parse(uri).fsPath.includes("/lib/")
              ? "deps"
              : "project",
        resolveImport: (importPath: string, fromFile: string) => {
          const target = path.resolve(path.dirname(fromFile), importPath);
          return fs.existsSync(target) ? target : null;
        },
        uriToPath: (uri: string) => URI.parse(uri).fsPath,
      };

      const symbolIndex = new SymbolIndex(parser, workspace as WorkspaceManager);
      for (const uri of uris) symbolIndex.updateFile(uri);
      const resolver = new SemanticResolver(parser, workspace as WorkspaceManager, symbolIndex);
      const graphIndex = new GraphIndex(
        parser,
        workspace as WorkspaceManager,
        resolver,
        symbolIndex,
      );
      graphIndex.rebuildWorkspace();
      const provider = new InheritanceGraphProvider(
        parser,
        workspace as WorkspaceManager,
        resolver,
        graphIndex,
      );
      const childPath = path.join(tmpDir, "src/Child.sol");
      const graph = provider.provideInheritanceGraph({
        contractPath: childPath,
        contractName: "Child",
      });

      const child = graph.nodes.find((n) => n.name === "Child");
      assert.ok(child, "expected Child node");
      assert.equal(graph.focusId, child.id);
      assert.equal(child.tier, "project");
      assert.equal(child.selectionRange.start.line, 2);

      const srcBase = graph.nodes.find(
        (n) => n.name === "Base" && n.filePath.endsWith("src/Base.sol"),
      );
      assert.ok(srcBase, "expected imported src/Base node");

      const edge = graph.edges.find((e) => e.from === child.id);
      assert.equal(edge?.to, srcBase.id);

      const testBase = graph.nodes.find(
        (n) => n.name === "Base" && n.filePath.endsWith("test/Base.sol"),
      );
      assert.equal(testBase, undefined, "test contracts should be excluded by default");
      const depBase = graph.nodes.find((n) => n.name === "Dep");
      assert.equal(depBase, undefined, "dependency contracts should be excluded by default");

      const graphWithTests = provider.provideInheritanceGraph({
        contractPath: childPath,
        contractName: "Child",
        includeTests: true,
      });
      const includedTestBase = graphWithTests.nodes.find(
        (n) => n.name === "Base" && n.filePath.endsWith("test/Base.sol"),
      );
      assert.equal(includedTestBase?.tier, "tests");

      const testFocusGraph = provider.provideInheritanceGraph({
        contractPath: path.join(tmpDir, "test/Base.sol"),
        contractName: "Base",
      });
      assert.equal(testFocusGraph.focusId, undefined);

      const includedTestFocusGraph = provider.provideInheritanceGraph({
        contractPath: path.join(tmpDir, "test/Base.sol"),
        contractName: "Base",
        includeTests: true,
      });
      assert.equal(includedTestFocusGraph.focusId, includedTestBase?.id);

      const graphWithDeps = provider.provideInheritanceGraph({
        contractPath: path.join(tmpDir, "src/UsesDep.sol"),
        contractName: "UsesDep",
        includeDependencies: true,
      });
      const includedDep = graphWithDeps.nodes.find((n) => n.name === "Dep");
      assert.equal(includedDep?.tier, "deps");
      const usesDep = graphWithDeps.nodes.find((n) => n.name === "UsesDep");
      assert.ok(usesDep, "expected UsesDep node");
      assert.equal(graphWithDeps.edges.find((e) => e.from === usesDep.id)?.to, includedDep?.id);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
