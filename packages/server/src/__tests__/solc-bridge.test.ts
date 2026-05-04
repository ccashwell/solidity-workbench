import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import { SolcBridge } from "../compiler/solc-bridge.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";

interface SolcBridgeInternals {
  extractAsts(output: unknown): void;
  findNodeById(node: unknown, id: number): unknown | null;
}

describe("SolcBridge", () => {
  it("resolves referenced declarations through the declaration-id cache", () => {
    const root = path.join(process.cwd(), "fixture-root");
    const workspace = {
      root,
      runForge: async () => ({ exitCode: 0, stdout: "{}", stderr: "" }),
    } as unknown as WorkspaceManager;
    const bridge = new SolcBridge(workspace);
    const internals = bridge as unknown as SolcBridgeInternals;
    const sourcePath = path.join(root, "src/Use.sol");
    const targetPath = path.join(root, "src/Target.sol");

    internals.extractAsts({
      sources: {
        "src/Use.sol": {
          id: 0,
          ast: {
            nodeType: "SourceUnit",
            nodes: [
              {
                nodeType: "Identifier",
                id: 2,
                name: "foo",
                referencedDeclaration: 1,
                src: "10:3:0",
              },
            ],
          },
        },
        "src/Target.sol": {
          id: 1,
          ast: {
            nodeType: "SourceUnit",
            nodes: [
              {
                nodeType: "FunctionDefinition",
                id: 1,
                name: "foo",
                src: "20:3:1",
              },
            ],
          },
        },
      },
    });

    const originalFindNodeById = internals.findNodeById.bind(bridge);
    let declarationScans = 0;
    internals.findNodeById = (node: unknown, id: number) => {
      declarationScans++;
      return originalFindNodeById(node, id);
    };

    const resolved = bridge.resolveReference(sourcePath, 11);

    assert.deepEqual(resolved, { filePath: targetPath, offset: 20, length: 3 });
    assert.equal(declarationScans, 0, "resolveReference should not scan ASTs by declaration id");
  });
});
