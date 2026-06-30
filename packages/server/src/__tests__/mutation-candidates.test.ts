import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { URI } from "vscode-uri";
import { MutationCandidatesProvider } from "../providers/mutation-candidates.js";
import type { SolcBridge, SolcSourceUnit } from "../compiler/solc-bridge.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";

describe("MutationCandidatesProvider", () => {
  it("builds mutation candidates from solc BinaryOperation nodes, not mapping arrows", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mutation-candidates-"));
    try {
      const filePath = path.join(root, "src/Vault.sol");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const source = [
        "contract Vault {",
        "    mapping(bytes32 id => mapping(uint256 blockNumber => uint256 notional)) internal liquidated;",
        "    function withdraw(uint256 amount, uint256 balance) external pure {",
        "        require(amount <= balance);",
        "    }",
        "}",
        "",
      ].join("\n");
      fs.writeFileSync(filePath, source, "utf-8");

      const expression = "amount <= balance";
      const expressionStart = source.indexOf(expression);
      const leftStart = expressionStart;
      const rightStart = source.indexOf("balance", expressionStart);
      const contractStart = source.indexOf("contract Vault");
      const functionStart = source.indexOf("function withdraw");

      const ast: SolcSourceUnit = {
        id: 0,
        filePath,
        ast: {
          nodeType: "SourceUnit",
          src: `0:${source.length}:0`,
          nodes: [
            {
              nodeType: "ContractDefinition",
              name: "Vault",
              src: `${contractStart}:${source.indexOf("\n}", contractStart) - contractStart + 2}:0`,
              nodes: [
                {
                  nodeType: "VariableDeclaration",
                  name: "liquidated",
                  src: `${source.indexOf("mapping(")}:${source.indexOf(";", source.indexOf("mapping(")) - source.indexOf("mapping(")}:0`,
                },
                {
                  nodeType: "FunctionDefinition",
                  name: "withdraw",
                  src: `${functionStart}:${source.indexOf("    }", functionStart) - functionStart + 5}:0`,
                  body: {
                    nodeType: "Block",
                    statements: [
                      {
                        nodeType: "ExpressionStatement",
                        expression: {
                          nodeType: "FunctionCall",
                          arguments: [
                            {
                              nodeType: "BinaryOperation",
                              operator: "<=",
                              src: `${expressionStart}:${expression.length}:0`,
                              leftExpression: {
                                nodeType: "Identifier",
                                name: "amount",
                                src: `${leftStart}:6:0`,
                              },
                              rightExpression: {
                                nodeType: "Identifier",
                                name: "balance",
                                src: `${rightStart}:7:0`,
                              },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      };

      const workspace = {
        getAllFileUris: () => [URI.file(filePath).toString()],
      } as unknown as WorkspaceManager;
      const solcBridge = {
        getAst: (nextPath: string) => (nextPath === filePath ? ast : undefined),
        buildAndExtractAst: async () => new Map([[filePath, ast]]),
      } as unknown as SolcBridge;

      const provider = new MutationCandidatesProvider(workspace, solcBridge);
      const result = await provider.provideMutationCandidates({
        forgeRootUri: URI.file(root).toString(),
        targetFileUri: URI.file(filePath).toString(),
        includeTests: false,
        maxMutants: 10,
      });

      assert.equal(result.source, "solc");
      assert.equal(result.candidates.length, 1);
      assert.equal(result.candidates[0].original, "<=");
      assert.equal(result.candidates[0].replacement, "<");
      assert.equal(result.candidates[0].contractName, "Vault");
      assert.equal(result.candidates[0].functionName, "withdraw");
      assert.match(result.candidates[0].lineText, /require\(amount <= balance\)/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
