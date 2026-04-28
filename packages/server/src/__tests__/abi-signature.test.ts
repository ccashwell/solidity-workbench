/**
 * Tests for the ABI signature helpers. These produce the strings the
 * Remote Chain UI hands to `cast call` (canonical form) and shows in
 * the function picker (display form).
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  formatFunctionDisplaySignature,
  formatFunctionSignature,
  formatFunctionSignatureWithReturns,
  isReadOnly,
  type AbiFunctionFragment,
} from "@solidity-workbench/common";

const fn = (
  name: string,
  inputs: AbiFunctionFragment["inputs"] = [],
  rest: Partial<AbiFunctionFragment> = {},
): AbiFunctionFragment => ({
  type: "function",
  name,
  inputs,
  outputs: [],
  stateMutability: "nonpayable",
  ...rest,
});

describe("formatFunctionSignature — primitives", () => {
  it("emits a no-arg signature", () => {
    assert.equal(formatFunctionSignature(fn("name")), "name()");
  });

  it("emits a single-arg signature", () => {
    assert.equal(
      formatFunctionSignature(fn("balanceOf", [{ name: "account", type: "address" }])),
      "balanceOf(address)",
    );
  });

  it("emits a multi-arg signature in declaration order", () => {
    assert.equal(
      formatFunctionSignature(
        fn("transfer", [
          { name: "to", type: "address" },
          { name: "amount", type: "uint256" },
        ]),
      ),
      "transfer(address,uint256)",
    );
  });

  it("ignores parameter names for the canonical form", () => {
    const a = fn("foo", [{ name: "alice", type: "uint256" }]);
    const b = fn("foo", [{ name: "", type: "uint256" }]);
    assert.equal(formatFunctionSignature(a), formatFunctionSignature(b));
  });
});

describe("formatFunctionSignature — arrays", () => {
  it("preserves dynamic-array suffix", () => {
    assert.equal(
      formatFunctionSignature(fn("setHashes", [{ name: "hashes", type: "bytes32[]" }])),
      "setHashes(bytes32[])",
    );
  });

  it("preserves fixed-array suffix", () => {
    assert.equal(
      formatFunctionSignature(fn("fixed", [{ name: "vals", type: "uint256[3]" }])),
      "fixed(uint256[3])",
    );
  });

  it("preserves multi-dimensional arrays", () => {
    assert.equal(
      formatFunctionSignature(fn("matrix", [{ name: "m", type: "uint256[][2]" }])),
      "matrix(uint256[][2])",
    );
  });
});

describe("formatFunctionSignature — tuples", () => {
  it("inlines a single-tuple param", () => {
    const sig = formatFunctionSignature(
      fn("swap", [
        {
          name: "params",
          type: "tuple",
          components: [
            { name: "to", type: "address" },
            { name: "amount", type: "uint256" },
            { name: "data", type: "bytes" },
          ],
        },
      ]),
    );
    assert.equal(sig, "swap((address,uint256,bytes))");
  });

  it("nests tuples", () => {
    const sig = formatFunctionSignature(
      fn("multi", [
        {
          name: "outer",
          type: "tuple",
          components: [
            {
              name: "inner",
              type: "tuple",
              components: [
                { name: "owner", type: "address" },
                { name: "amount", type: "uint256" },
              ],
            },
            { name: "ts", type: "uint256" },
          ],
        },
      ]),
    );
    assert.equal(sig, "multi(((address,uint256),uint256))");
  });

  it("handles arrays of tuples", () => {
    const sig = formatFunctionSignature(
      fn("multi", [
        {
          name: "items",
          type: "tuple[]",
          components: [
            { name: "owner", type: "address" },
            { name: "amount", type: "uint256" },
          ],
        },
        { name: "deadline", type: "uint256" },
      ]),
    );
    assert.equal(sig, "multi((address,uint256)[],uint256)");
  });

  it("handles a tuple of (array of tuples, scalar)", () => {
    const sig = formatFunctionSignature(
      fn("multi", [
        {
          name: "outer",
          type: "tuple",
          components: [
            {
              name: "items",
              type: "tuple[]",
              components: [
                { name: "owner", type: "address" },
                { name: "amount", type: "uint256" },
              ],
            },
            { name: "deadline", type: "uint256" },
          ],
        },
      ]),
    );
    assert.equal(sig, "multi(((address,uint256)[],uint256))");
  });

  it("handles a mix of scalars, tuple arrays, and trailing primitives", () => {
    const sig = formatFunctionSignature(
      fn("complex", [
        { name: "owner", type: "address" },
        {
          name: "ops",
          type: "tuple[]",
          components: [
            { name: "amount", type: "uint256" },
            { name: "salt", type: "bytes32" },
          ],
        },
        { name: "fee", type: "uint128" },
      ]),
    );
    assert.equal(sig, "complex(address,(uint256,bytes32)[],uint128)");
  });
});

describe("formatFunctionDisplaySignature", () => {
  it("emits parameter names alongside types", () => {
    const sig = formatFunctionDisplaySignature(
      fn("transfer", [
        { name: "to", type: "address" },
        { name: "amount", type: "uint256" },
      ]),
    );
    assert.equal(sig, "transfer(address to, uint256 amount)");
  });

  it("falls back to bare types when names are empty", () => {
    const sig = formatFunctionDisplaySignature(
      fn("foo", [
        { name: "", type: "address" },
        { name: "amount", type: "uint256" },
      ]),
    );
    assert.equal(sig, "foo(address, uint256 amount)");
  });

  it("displays tuples with named components", () => {
    const sig = formatFunctionDisplaySignature(
      fn("swap", [
        {
          name: "params",
          type: "tuple",
          components: [
            { name: "to", type: "address" },
            { name: "amount", type: "uint256" },
          ],
        },
      ]),
    );
    assert.equal(sig, "swap((address to, uint256 amount) params)");
  });
});

describe("formatFunctionSignatureWithReturns", () => {
  it("appends a single output type", () => {
    const sig = formatFunctionSignatureWithReturns(
      fn("decimals", [], { stateMutability: "view", outputs: [{ name: "", type: "uint8" }] }),
    );
    assert.equal(sig, "decimals()(uint8)");
  });

  it("appends multiple output types", () => {
    const sig = formatFunctionSignatureWithReturns(
      fn("getReserves", [], {
        stateMutability: "view",
        outputs: [
          { name: "_reserve0", type: "uint112" },
          { name: "_reserve1", type: "uint112" },
          { name: "_blockTimestampLast", type: "uint32" },
        ],
      }),
    );
    assert.equal(sig, "getReserves()(uint112,uint112,uint32)");
  });

  it("returns the bare signature when there are no outputs", () => {
    const sig = formatFunctionSignatureWithReturns(
      fn("set", [{ name: "x", type: "uint256" }], { stateMutability: "nonpayable" }),
    );
    assert.equal(sig, "set(uint256)");
  });

  it("handles tuple outputs", () => {
    const sig = formatFunctionSignatureWithReturns(
      fn("getPair", [], {
        stateMutability: "view",
        outputs: [
          {
            name: "p",
            type: "tuple",
            components: [
              { name: "a", type: "address" },
              { name: "b", type: "address" },
            ],
          },
        ],
      }),
    );
    assert.equal(sig, "getPair()((address,address))");
  });
});

describe("isReadOnly", () => {
  it("is true for view", () => {
    assert.equal(isReadOnly(fn("x", [], { stateMutability: "view" })), true);
  });

  it("is true for pure", () => {
    assert.equal(isReadOnly(fn("x", [], { stateMutability: "pure" })), true);
  });

  it("is false for nonpayable", () => {
    assert.equal(isReadOnly(fn("x", [], { stateMutability: "nonpayable" })), false);
  });

  it("is false for payable", () => {
    assert.equal(isReadOnly(fn("x", [], { stateMutability: "payable" })), false);
  });

  it("is false for non-function fragments (events, errors, constructors)", () => {
    assert.equal(isReadOnly({ type: "event", name: "Transfer" } as AbiFunctionFragment), false);
    assert.equal(isReadOnly({ type: "error", name: "Bad" } as AbiFunctionFragment), false);
    assert.equal(isReadOnly({ type: "constructor" } as AbiFunctionFragment), false);
  });
});

describe("error cases", () => {
  it("formatFunctionSignature throws on a constructor fragment", () => {
    assert.throws(() =>
      formatFunctionSignature({ type: "constructor", inputs: [] } as AbiFunctionFragment),
    );
  });

  it("formatFunctionSignature throws on a function with no name", () => {
    assert.throws(() => formatFunctionSignature({ type: "function", inputs: [] }));
  });

  it("formatFunctionDisplaySignature throws on an event fragment", () => {
    assert.throws(() =>
      formatFunctionDisplaySignature({
        type: "event",
        name: "Transfer",
        inputs: [],
      } as AbiFunctionFragment),
    );
  });
});
