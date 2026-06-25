import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SolcBridge } from "../compiler/solc-bridge.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";

interface SolcBridgeInternals {
  extractAsts(output: unknown): void;
  findNodeById(node: unknown, id: number): unknown | null;
}

describe("SolcBridge", () => {
  it("compiles single files with forge build positional paths", async () => {
    const root = path.join(process.cwd(), "fixture-root");
    let args: string[] = [];
    const workspace = {
      root,
      runForge: async (nextArgs: string[]) => {
        args = nextArgs;
        return { exitCode: 0, stdout: "{}", stderr: "" };
      },
    } as unknown as WorkspaceManager;
    const bridge = new SolcBridge(workspace);
    const sourcePath = path.join(root, "src/Use.sol");

    await bridge.compileSingle(sourcePath);

    assert.deepEqual(args, ["build", "--json", sourcePath]);
  });

  it("loads full-project ASTs from Foundry build-info output", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "solc-bridge-build-info-"));
    try {
      const sourcePath = path.join(root, "src/Use.sol");
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(sourcePath, "contract Use { function run() external {} }\n", "utf-8");
      let args: string[] = [];
      let buildInfoPath = "";
      const workspace = {
        root,
        runForge: async (nextArgs: string[]) => {
          args = nextArgs;
          buildInfoPath = nextArgs[nextArgs.indexOf("--build-info-path") + 1];
          fs.writeFileSync(
            path.join(buildInfoPath, "build-info.json"),
            JSON.stringify({
              output: {
                sources: {
                  "src/Use.sol": {
                    id: 0,
                    ast: {
                      nodeType: "SourceUnit",
                      src: "0:43:0",
                      nodes: [
                        {
                          nodeType: "ContractDefinition",
                          id: 1,
                          name: "Use",
                          src: "0:42:0",
                          nodes: [
                            {
                              nodeType: "FunctionDefinition",
                              id: 2,
                              name: "run",
                              src: "15:25:0",
                            },
                          ],
                        },
                      ],
                    },
                  },
                },
                contracts: {
                  "src/Use.sol": {
                    Use: {
                      evm: {
                        methodIdentifiers: {
                          "run()": "c0406226",
                        },
                      },
                    },
                  },
                },
              },
            }),
            "utf-8",
          );
          return {
            exitCode: 0,
            stdout: JSON.stringify({ sources: {}, contracts: {} }),
            stderr: "",
          };
        },
      } as unknown as WorkspaceManager;
      const bridge = new SolcBridge(workspace);

      const asts = await bridge.buildAndExtractAst();

      assert.ok(args.includes("--ast"));
      assert.ok(args.includes("--build-info"));
      assert.ok(args.includes("--build-info-path"));
      const sourceUnit = asts.get(sourcePath);
      assert.ok(sourceUnit);
      const firstNode = sourceUnit.ast.nodes?.[0];
      assert.ok(firstNode);
      assert.equal(firstNode.name, "Use");
      assert.deepEqual(bridge.getCachedMethodIdentifiers("Use"), { "run()": "c0406226" });
      assert.equal(bridge.getCacheStatus().available, true);
      assert.equal(bridge.getCacheStatus().stale, false);
      assert.equal(typeof bridge.getCacheStatus().lastBuildTimeMs, "number");
      fs.writeFileSync(sourcePath, "contract Use { function changed() external {} }\n", "utf-8");
      bridge.invalidateFile(sourcePath);
      const staleStatus = bridge.getCacheStatus();
      assert.equal(staleStatus.stale, true);
      assert.equal(staleStatus.staleFileCount, 1);
      assert.deepEqual(staleStatus.staleFiles, [sourcePath]);
      assert.equal(fs.existsSync(buildInfoPath), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

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
    const info = bridge.getDeclarationInfoAt(sourcePath, 11);

    assert.deepEqual(resolved, { filePath: targetPath, offset: 20, length: 3 });
    assert.deepEqual(info, {
      declarationId: 1,
      declarationFilePath: targetPath,
      declarationOffset: 20,
      declarationLength: 3,
      nodeType: "FunctionDefinition",
      name: "foo",
    });
    assert.equal(declarationScans, 0, "resolveReference should not scan ASTs by declaration id");
  });

  it("prefers the narrowest AST node at an offset", () => {
    const root = path.join(process.cwd(), "fixture-root");
    const workspace = {
      root,
      runForge: async () => ({ exitCode: 0, stdout: "{}", stderr: "" }),
    } as unknown as WorkspaceManager;
    const bridge = new SolcBridge(workspace);
    const internals = bridge as unknown as SolcBridgeInternals;
    const sourcePath = path.join(root, "src/Use.sol");

    internals.extractAsts({
      sources: {
        "src/Use.sol": {
          id: 0,
          ast: {
            nodeType: "SourceUnit",
            nodes: [
              {
                nodeType: "ContractDefinition",
                id: 1,
                name: "Use",
                src: "0:200:0",
                nodes: [
                  {
                    nodeType: "FunctionDefinition",
                    id: 2,
                    name: "run",
                    src: "20:120:0",
                    body: {
                      nodeType: "Block",
                      id: 3,
                      src: "50:80:0",
                      statements: [
                        {
                          nodeType: "ExpressionStatement",
                          id: 4,
                          src: "70:20:0",
                          expression: {
                            nodeType: "Identifier",
                            id: 5,
                            name: "total",
                            referencedDeclaration: 6,
                            src: "76:5:0",
                          },
                        },
                      ],
                    },
                  },
                  {
                    nodeType: "VariableDeclaration",
                    id: 6,
                    name: "total",
                    src: "160:5:0",
                  },
                ],
              },
            ],
          },
        },
      },
    });

    assert.deepEqual(bridge.getDeclarationInfoAt(sourcePath, 78), {
      declarationId: 6,
      declarationFilePath: sourcePath,
      declarationOffset: 160,
      declarationLength: 5,
      nodeType: "VariableDeclaration",
      name: "total",
    });
  });

  it("maps editor offsets to solc byte offsets across UTF-8 text", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "solc-bridge-utf8-"));
    try {
      const sourcePath = path.join(root, "src/Use.sol");
      const text = `pragma solidity ^0.8.24;
/// ─────────────────────────────
contract Use {
    uint256 total;
    function run() external view returns (uint256) {
        return total;
    }
}
`;
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(sourcePath, text, "utf-8");

      const workspace = {
        root,
        runForge: async () => ({ exitCode: 0, stdout: "{}", stderr: "" }),
      } as unknown as WorkspaceManager;
      const bridge = new SolcBridge(workspace);
      const internals = bridge as unknown as SolcBridgeInternals;
      const documentRefOffset = text.lastIndexOf("total");
      const documentDeclOffset = text.indexOf("total");
      const solcRefOffset = Buffer.byteLength(text.slice(0, documentRefOffset), "utf8");
      const solcDeclOffset = Buffer.byteLength(text.slice(0, documentDeclOffset), "utf8");
      assert.notEqual(
        solcRefOffset,
        documentRefOffset,
        "fixture must contain multibyte text before the reference",
      );

      internals.extractAsts({
        sources: {
          "src/Use.sol": {
            id: 0,
            ast: {
              nodeType: "SourceUnit",
              src: `0:${Buffer.byteLength(text, "utf8")}:0`,
              nodes: [
                {
                  nodeType: "ContractDefinition",
                  id: 1,
                  name: "Use",
                  src: `${Buffer.byteLength(text.slice(0, text.indexOf("contract")), "utf8")}:${Buffer.byteLength(
                    text.slice(text.indexOf("contract")),
                    "utf8",
                  )}:0`,
                  nodes: [
                    {
                      nodeType: "VariableDeclaration",
                      id: 2,
                      name: "total",
                      src: `${solcDeclOffset}:5:0`,
                    },
                    {
                      nodeType: "FunctionDefinition",
                      id: 3,
                      name: "run",
                      src: `${Buffer.byteLength(text.slice(0, text.indexOf("function run")), "utf8")}:${Buffer.byteLength(
                        text.slice(text.indexOf("function run")),
                        "utf8",
                      )}:0`,
                      body: {
                        nodeType: "Block",
                        id: 4,
                        src: `${Buffer.byteLength(text.slice(0, text.indexOf("{\n        return")), "utf8")}:45:0`,
                        statements: [
                          {
                            nodeType: "ExpressionStatement",
                            id: 5,
                            src: `${solcRefOffset - "return ".length}:13:0`,
                            expression: {
                              nodeType: "Identifier",
                              id: 6,
                              name: "total",
                              referencedDeclaration: 2,
                              src: `${solcRefOffset}:5:0`,
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              ],
            },
          },
        },
      });

      assert.deepEqual(bridge.resolveReference(sourcePath, documentRefOffset), {
        filePath: sourcePath,
        offset: documentDeclOffset,
        length: 5,
      });
      assert.deepEqual(bridge.getDeclarationInfoAt(sourcePath, documentRefOffset), {
        declarationId: 2,
        declarationFilePath: sourcePath,
        declarationOffset: documentDeclOffset,
        declarationLength: 5,
        nodeType: "VariableDeclaration",
        name: "total",
      });
      assert.deepEqual(bridge.findReferencesAt(sourcePath, documentRefOffset), {
        declaration: { filePath: sourcePath, offset: documentDeclOffset, length: 5 },
        references: [{ filePath: sourcePath, offset: documentRefOffset, length: 5 }],
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
