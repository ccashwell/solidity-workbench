import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { URI } from "vscode-uri";
import { SolidityParser } from "../parser/solidity-parser.js";
import { SymbolIndex } from "../analyzer/symbol-index.js";
import { SemanticResolver } from "../analyzer/semantic-resolver.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";

describe("SemanticResolver", () => {
  it("resolves duplicate base names through the active import graph", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-resolver-test-"));
    try {
      const files = {
        "src/Base.sol": `pragma solidity ^0.8.24;
contract Base {
    function ping() internal {}
}
`,
        "src/Child.sol": `pragma solidity ^0.8.24;
import "./Base.sol";
contract Child is Base {}
`,
        "test/Base.sol": `pragma solidity ^0.8.24;
contract Base {
    function ping() internal {}
}
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
      const index = new SymbolIndex(parser, workspace as WorkspaceManager);
      for (const uri of uris) index.updateFile(uri);

      const resolver = new SemanticResolver(parser, workspace as WorkspaceManager, index);
      const childUri = URI.file(path.join(tmpDir, "src/Child.sol")).toString();
      const srcBasePath = path.join(tmpDir, "src/Base.sol");
      const testBasePath = path.join(tmpDir, "test/Base.sol");

      const base = resolver.resolveBaseContract(childUri, "Base");
      assert.ok(base, "expected imported Base to resolve");
      assert.equal(base.filePath, srcBasePath);
      assert.notEqual(base.filePath, testBasePath);

      const chain = resolver.getInheritanceChain("Child", childUri);
      assert.deepEqual(
        chain.map((entry) => entry.filePath),
        [path.join(tmpDir, "src/Child.sol"), srcBasePath],
      );

      const ping = resolver.findMemberInInheritanceChain("Child", "ping", childUri);
      assert.ok(ping, "expected inherited ping member");
      assert.equal(ping.filePath, URI.file(srcBasePath).toString());

      const subtypes = resolver.getSubtypes(base);
      assert.deepEqual(
        subtypes.map((entry) => entry.contract.name),
        ["Child"],
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
