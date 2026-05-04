import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { URI } from "vscode-uri";
import { SolidityParser } from "../parser/solidity-parser.js";
import { InheritanceGraphProvider } from "../providers/inheritance-graph.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";

describe("InheritanceGraphProvider", () => {
  it("builds a parser-backed graph and resolves duplicate bases through imports", () => {
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
          URI.parse(uri).fsPath.includes("/test/") ? "tests" : "project",
        resolveImport: (importPath: string, fromFile: string) => {
          const target = path.resolve(path.dirname(fromFile), importPath);
          return fs.existsSync(target) ? target : null;
        },
        uriToPath: (uri: string) => URI.parse(uri).fsPath,
      };

      const provider = new InheritanceGraphProvider(parser, workspace as WorkspaceManager);
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
      assert.equal(testBase?.tier, "tests");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
