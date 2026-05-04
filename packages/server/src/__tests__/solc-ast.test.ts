import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { extractFunctions, findEnclosingFunction } from "@solidity-workbench/common";

describe("extractFunctions", () => {
  it("walks a compactAST source unit and surfaces functions with parameters", () => {
    const ast = {
      nodeType: "SourceUnit",
      nodes: [
        {
          nodeType: "ContractDefinition",
          name: "Counter",
          nodes: [
            {
              nodeType: "FunctionDefinition",
              name: "increment",
              src: "100:200:0",
              parameters: {
                nodeType: "ParameterList",
                parameters: [
                  {
                    nodeType: "VariableDeclaration",
                    name: "amount",
                    src: "120:7:0",
                    typeDescriptions: { typeString: "uint256" },
                  },
                ],
              },
              body: {
                nodeType: "Block",
                statements: [],
              },
            },
          ],
        },
      ],
    };
    const fns = extractFunctions(ast);
    assert.equal(fns.length, 1);
    assert.equal(fns[0].name, "increment");
    assert.equal(fns[0].fileIndex, 0);
    assert.equal(fns[0].startByte, 100);
    assert.equal(fns[0].endByte, 300);
    assert.equal(fns[0].parameters.length, 1);
    assert.equal(fns[0].parameters[0].name, "amount");
    assert.equal(fns[0].parameters[0].type, "uint256");
  });

  it("extracts locally-declared variables from the function body in source order", () => {
    const ast = {
      nodeType: "SourceUnit",
      nodes: [
        {
          nodeType: "ContractDefinition",
          name: "C",
          nodes: [
            {
              nodeType: "FunctionDefinition",
              name: "f",
              src: "0:200:0",
              parameters: { nodeType: "ParameterList", parameters: [] },
              body: {
                nodeType: "Block",
                statements: [
                  {
                    nodeType: "VariableDeclarationStatement",
                    declarations: [
                      {
                        nodeType: "VariableDeclaration",
                        name: "a",
                        src: "10:6:0",
                        typeDescriptions: { typeString: "uint256" },
                      },
                    ],
                  },
                  {
                    nodeType: "VariableDeclarationStatement",
                    declarations: [
                      {
                        nodeType: "VariableDeclaration",
                        name: "b",
                        src: "30:7:0",
                        typeDescriptions: { typeString: "address" },
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const fn = extractFunctions(ast)[0];
    assert.equal(fn.locals.length, 2);
    assert.deepEqual(
      fn.locals.map((l) => ({ name: l.name, type: l.type, declaredAtByte: l.declaredAtByte })),
      [
        { name: "a", type: "uint256", declaredAtByte: 10 },
        { name: "b", type: "address", declaredAtByte: 30 },
      ],
    );
  });

  it("returns [] for non-object input or trees without functions", () => {
    assert.deepEqual(extractFunctions(null), []);
    assert.deepEqual(extractFunctions("not an ast"), []);
    assert.deepEqual(extractFunctions({ nodeType: "SourceUnit", nodes: [] }), []);
  });

  it("handles legacyAST trees that use `children` instead of `nodes`", () => {
    const ast = {
      nodeType: "SourceUnit",
      children: [
        {
          nodeType: "ContractDefinition",
          name: "C",
          children: [
            {
              nodeType: "FunctionDefinition",
              name: "old_style",
              src: "10:50:0",
              parameters: { nodeType: "ParameterList", parameters: [] },
              body: { nodeType: "Block", statements: [] },
            },
          ],
        },
      ],
    };
    const fns = extractFunctions(ast);
    assert.equal(fns.length, 1);
    assert.equal(fns[0].name, "old_style");
  });
});

describe("findEnclosingFunction", () => {
  const fns = extractFunctions({
    nodeType: "SourceUnit",
    nodes: [
      {
        nodeType: "ContractDefinition",
        name: "C",
        nodes: [
          {
            nodeType: "FunctionDefinition",
            name: "outer",
            src: "10:200:0",
            parameters: { nodeType: "ParameterList", parameters: [] },
            body: { nodeType: "Block", statements: [] },
          },
          {
            nodeType: "FunctionDefinition",
            name: "other",
            src: "300:50:0",
            parameters: { nodeType: "ParameterList", parameters: [] },
            body: { nodeType: "Block", statements: [] },
          },
          {
            nodeType: "FunctionDefinition",
            name: "in_other_file",
            src: "5:50:1",
            parameters: { nodeType: "ParameterList", parameters: [] },
            body: { nodeType: "Block", statements: [] },
          },
        ],
      },
    ],
  });

  it("returns the function whose byte range contains the offset", () => {
    assert.equal(findEnclosingFunction(fns, 0, 50)?.name, "outer");
    assert.equal(findEnclosingFunction(fns, 0, 320)?.name, "other");
  });

  it("returns null for offsets outside any function", () => {
    assert.equal(findEnclosingFunction(fns, 0, 250), null); // gap between outer & other
    assert.equal(findEnclosingFunction(fns, 99, 50), null); // wrong file
  });

  it("respects fileIndex when matching", () => {
    assert.equal(findEnclosingFunction(fns, 1, 30)?.name, "in_other_file");
    // Same byte offset in fileIndex 0 falls inside `outer`.
    assert.equal(findEnclosingFunction(fns, 0, 30)?.name, "outer");
  });
});
