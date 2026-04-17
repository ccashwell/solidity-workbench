import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  extractEvents,
  eventSignature,
  generateSubgraphScaffold,
  paramFieldName,
  type AbiEvent,
} from "@solidity-workbench/common";

const ERC20_ABI = [
  {
    type: "function",
    name: "transfer",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Approval",
    inputs: [
      { name: "owner", type: "address", indexed: true },
      { name: "spender", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
  {
    type: "constructor",
    inputs: [{ name: "name_", type: "string" }],
  },
  {
    type: "error",
    name: "Forbidden",
    inputs: [],
  },
];

describe("extractEvents", () => {
  it("returns only `event` entries, ignoring functions / errors / constructors", () => {
    const events = extractEvents(ERC20_ABI);
    assert.equal(events.length, 2);
    assert.deepEqual(
      events.map((e) => e.name),
      ["Transfer", "Approval"],
    );
  });

  it("tolerates malformed entries without throwing", () => {
    const events = extractEvents([
      null,
      "nope",
      42,
      { type: "event" },
      { type: "event", name: 123 },
    ]);
    assert.deepEqual(events, []);
  });
});

describe("eventSignature", () => {
  it("renders indexed params with the `indexed` keyword", () => {
    const ev: AbiEvent = {
      type: "event",
      name: "Transfer",
      inputs: [
        { name: "from", type: "address", indexed: true },
        { name: "to", type: "address", indexed: true },
        { name: "value", type: "uint256", indexed: false },
      ],
    };
    assert.equal(eventSignature(ev), "Transfer(indexed address,indexed address,uint256)");
  });

  it("flattens tuple components into parentheses", () => {
    const ev: AbiEvent = {
      type: "event",
      name: "Swap",
      inputs: [
        {
          name: "key",
          type: "tuple",
          components: [
            { name: "token0", type: "address" },
            { name: "token1", type: "address" },
            { name: "fee", type: "uint24" },
          ],
        },
        { name: "amount", type: "int256" },
      ],
    };
    assert.equal(eventSignature(ev), "Swap((address,address,uint24),int256)");
  });

  it("handles tuple[] arrays", () => {
    const ev: AbiEvent = {
      type: "event",
      name: "Batch",
      inputs: [
        {
          name: "orders",
          type: "tuple[]",
          components: [
            { name: "seller", type: "address" },
            { name: "amount", type: "uint256" },
          ],
        },
      ],
    };
    assert.equal(eventSignature(ev), "Batch((address,uint256)[])");
  });
});

describe("paramFieldName", () => {
  it("uses the named parameter when present", () => {
    assert.equal(paramFieldName({ name: "recipient", type: "address" }, 0), "recipient");
  });

  it("synthesises `argN` when the parameter is unnamed", () => {
    assert.equal(paramFieldName({ name: "", type: "address" }, 0), "arg0");
    assert.equal(paramFieldName({ type: "uint256" }, 3), "arg3");
  });
});

describe("generateSubgraphScaffold", () => {
  it("emits exactly three files at the canonical paths", () => {
    const { files } = generateSubgraphScaffold({ contractName: "Token" }, ERC20_ABI);
    const paths = Object.keys(files).sort();
    assert.deepEqual(paths, ["schema.graphql", "src/token.ts", "subgraph.yaml"]);
  });

  it("writes the contract name, network, address, and startBlock into the manifest", () => {
    const { files } = generateSubgraphScaffold(
      {
        contractName: "Token",
        network: "base",
        address: "0x1234567890123456789012345678901234567890",
        startBlock: 12345678,
      },
      ERC20_ABI,
    );
    const manifest = files["subgraph.yaml"];
    assert.match(manifest, /network: base/);
    assert.match(manifest, /address: "0x1234567890123456789012345678901234567890"/);
    assert.match(manifest, /startBlock: 12345678/);
    assert.match(manifest, /name: Token/);
    assert.match(manifest, /abi: Token/);
    assert.match(manifest, /file: \.\/abis\/Token\.json/);
  });

  it("references the mapping file at src/<camelCaseContract>.ts", () => {
    const { files } = generateSubgraphScaffold({ contractName: "Token" }, ERC20_ABI);
    assert.match(files["subgraph.yaml"], /file: \.\/src\/token\.ts/);
    assert.ok(files["src/token.ts"]);
  });

  it("emits one eventHandlers entry and one schema entity per event", () => {
    const { files, events } = generateSubgraphScaffold({ contractName: "Token" }, ERC20_ABI);
    assert.deepEqual(events, ["Transfer", "Approval"]);

    const manifest = files["subgraph.yaml"];
    assert.match(
      manifest,
      /event: Transfer\(indexed address,indexed address,uint256\)\s+handler: handleTransfer/,
    );
    assert.match(
      manifest,
      /event: Approval\(indexed address,indexed address,uint256\)\s+handler: handleApproval/,
    );

    const schema = files["schema.graphql"];
    assert.match(schema, /type Transfer @entity\(immutable: true\)/);
    assert.match(schema, /type Approval @entity\(immutable: true\)/);
    assert.match(schema, /from: Bytes!/);
    assert.match(schema, /value: BigInt!/);
  });

  it("generates handlers that access event.params by the original parameter names", () => {
    const { files } = generateSubgraphScaffold({ contractName: "Token" }, ERC20_ABI);
    const mapping = files["src/token.ts"];
    assert.match(mapping, /handleTransfer/);
    assert.match(mapping, /entity\.from = event\.params\.from/);
    assert.match(mapping, /entity\.to = event\.params\.to/);
    assert.match(mapping, /entity\.value = event\.params\.value/);
    assert.match(mapping, /entity\.save\(\)/);
    assert.match(mapping, /import \{[\s\S]*Transfer as TransferEvent/);
    assert.match(mapping, /from "\.\.\/generated\/Token\/Token"/);
    assert.match(mapping, /from "\.\.\/generated\/schema"/);
  });

  it("falls back to argN for unnamed parameters", () => {
    const abi = [
      {
        type: "event",
        name: "Anon",
        inputs: [{ type: "address", indexed: true }, { type: "uint256" }],
      },
    ];
    const { files } = generateSubgraphScaffold({ contractName: "Thing" }, abi);
    const schema = files["schema.graphql"];
    assert.match(schema, /arg0: Bytes!/);
    assert.match(schema, /arg1: BigInt!/);

    const mapping = files["src/thing.ts"];
    assert.match(mapping, /entity\.arg0 = event\.params\.arg0/);
    assert.match(mapping, /entity\.arg1 = event\.params\.arg1/);
  });

  it("flags tuple params with TODO comments instead of emitting wrong assignments", () => {
    const abi = [
      {
        type: "event",
        name: "Complex",
        inputs: [
          {
            name: "key",
            type: "tuple",
            components: [
              { name: "token0", type: "address" },
              { name: "fee", type: "uint24" },
            ],
          },
          { name: "value", type: "uint256" },
        ],
      },
    ];
    const { files, eventsWithTupleWarnings } = generateSubgraphScaffold(
      { contractName: "Pool" },
      abi,
    );
    assert.deepEqual(eventsWithTupleWarnings, ["Complex"]);

    const schema = files["schema.graphql"];
    assert.match(schema, /key: Bytes! # TODO: encode tuple per your domain/);
    assert.match(schema, /value: BigInt!/);

    const mapping = files["src/pool.ts"];
    assert.match(mapping, /TODO: encode tuple param `key` \(tuple\)/);
    // Scalar sibling still emits a real assignment.
    assert.match(mapping, /entity\.value = event\.params\.value/);
  });

  it("emits a usable stub when the ABI has no events", () => {
    const { files, events } = generateSubgraphScaffold({ contractName: "Empty" }, [
      { type: "function", name: "noop" },
    ]);
    assert.deepEqual(events, []);
    assert.match(files["schema.graphql"], /type Stub @entity/);
    assert.match(files["subgraph.yaml"], /# No events detected/);
  });

  it("maps scalar arrays to [T!]! in the schema", () => {
    const abi = [
      {
        type: "event",
        name: "Bulk",
        inputs: [
          { name: "recipients", type: "address[]" },
          { name: "amounts", type: "uint256[]" },
        ],
      },
    ];
    const { files } = generateSubgraphScaffold({ contractName: "Bulker" }, abi);
    const schema = files["schema.graphql"];
    assert.match(schema, /recipients: \[Bytes!\]!/);
    assert.match(schema, /amounts: \[BigInt!\]!/);
  });
});
