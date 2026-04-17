import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { generateEnvioScaffold } from "@solidity-workbench/common";

const ERC20_ABI = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256" },
    ],
  },
  {
    type: "event",
    name: "Approval",
    inputs: [
      { name: "owner", type: "address", indexed: true },
      { name: "spender", type: "address", indexed: true },
      { name: "value", type: "uint256" },
    ],
  },
];

describe("generateEnvioScaffold", () => {
  it("emits the canonical Envio file set", () => {
    const { files } = generateEnvioScaffold({ contractName: "Token" }, ERC20_ABI);
    const paths = Object.keys(files).sort();
    assert.deepEqual(paths, [
      ".env.example",
      "README.md",
      "config.yaml",
      "package.json",
      "schema.graphql",
      "src/EventHandlers.ts",
    ]);
  });

  it("writes config.yaml with the expected network + contract shape", () => {
    const { files } = generateEnvioScaffold(
      {
        contractName: "Token",
        network: "arbitrum-one",
        address: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        startBlock: 100_000_000,
      },
      ERC20_ABI,
    );
    const config = files["config.yaml"];
    assert.match(config, /name: token\nd?/);
    assert.match(config, /ecosystem: evm/);
    assert.match(config, /- id: 42161/);
    assert.match(config, /start_block: 100000000/);
    assert.match(config, /- name: Token/);
    assert.match(config, /- "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"/);
    assert.match(config, /handler: src\/EventHandlers\.ts/);
    assert.match(config, /abi_file_path: abis\/Token\.json/);
  });

  it("renders each event's canonical signature without the `indexed` keyword", () => {
    // Envio infers `indexed` from the ABI itself, so the signature
    // string in config.yaml should be the unindexed shape.
    const { files } = generateEnvioScaffold({ contractName: "Token" }, ERC20_ABI);
    const config = files["config.yaml"];
    assert.match(config, /- event: "Transfer\(address,address,uint256\)"/);
    assert.match(config, /- event: "Approval\(address,address,uint256\)"/);
    // Sanity: no stray "indexed" anywhere in the signature lines.
    assert.doesNotMatch(
      config,
      /- event: ".*indexed/,
      "Envio signatures must drop the indexed keyword; ABI tells Envio which params are indexed",
    );
  });

  it("emits one GraphQL entity per event with ID + scalar fields", () => {
    const { files, events } = generateEnvioScaffold({ contractName: "Token" }, ERC20_ABI);
    assert.deepEqual(events, ["Transfer", "Approval"]);
    const schema = files["schema.graphql"];
    assert.match(schema, /type Transfer \{/);
    assert.match(schema, /type Approval \{/);
    assert.match(schema, /id: ID!/);
    // address → String! under Envio conventions
    assert.match(schema, /from: String!/);
    // uint256 → BigInt!
    assert.match(schema, /value: BigInt!/);
    assert.match(schema, /blockNumber: BigInt!/);
    assert.match(schema, /transactionHash: String!/);
  });

  it("registers a <Contract>.<Event>.handler for every event", () => {
    const { files } = generateEnvioScaffold({ contractName: "Token" }, ERC20_ABI);
    const handlers = files["src/EventHandlers.ts"];
    assert.match(handlers, /from "generated";/);
    assert.match(
      handlers,
      /Token\.Transfer\.handler\(async \(\{ event, context \}\) => \{/,
    );
    assert.match(
      handlers,
      /Token\.Approval\.handler\(async \(\{ event, context \}\) => \{/,
    );
    assert.match(handlers, /context\.Transfer\.set\(entity\)/);
    assert.match(handlers, /context\.Approval\.set\(entity\)/);
    // Primary-key id uses chainId + blockNumber + logIndex to guarantee uniqueness
    assert.match(handlers, /\$\{event\.chainId\}/);
    assert.match(handlers, /\$\{event\.logIndex\}/);
    // BigInt coercion for block metadata
    assert.match(handlers, /BigInt\(event\.block\.number\)/);
    assert.match(handlers, /BigInt\(event\.block\.timestamp\)/);
  });

  it("serializes tuple params via JSON.stringify with a TODO marker", () => {
    const abi = [
      {
        type: "event",
        name: "Complex",
        inputs: [
          {
            name: "key",
            type: "tuple",
            components: [{ name: "a", type: "address" }],
          },
          { name: "value", type: "uint256" },
        ],
      },
    ];
    const { files, eventsWithTupleWarnings } = generateEnvioScaffold(
      { contractName: "Pool" },
      abi,
    );
    assert.deepEqual(eventsWithTupleWarnings, ["Complex"]);
    assert.match(files["src/EventHandlers.ts"], /key: JSON\.stringify\(event\.params\.key\)/);
    assert.match(files["src/EventHandlers.ts"], /TODO: encode tuple/);
    // Scalar sibling still gets a plain assignment.
    assert.match(files["src/EventHandlers.ts"], /value: event\.params\.value/);
    // Schema reserves String! for the tuple column with a TODO note.
    assert.match(files["schema.graphql"], /key: String! # TODO: encode tuple/);
  });

  it("handles unnamed parameters via argN fallback", () => {
    const abi = [
      {
        type: "event",
        name: "Anon",
        inputs: [
          { type: "address", indexed: true },
          { type: "uint256" },
        ],
      },
    ];
    const { files } = generateEnvioScaffold({ contractName: "Thing" }, abi);
    assert.match(files["schema.graphql"], /arg0: String!/);
    assert.match(files["schema.graphql"], /arg1: BigInt!/);
    assert.match(files["src/EventHandlers.ts"], /arg0: event\.params\.arg0/);
    assert.match(files["src/EventHandlers.ts"], /arg1: event\.params\.arg1/);
  });

  it("emits a usable stub when the ABI has no events", () => {
    const { files, events } = generateEnvioScaffold({ contractName: "Empty" }, [
      { type: "function", name: "noop" },
    ]);
    assert.deepEqual(events, []);
    assert.match(files["config.yaml"], /# No events detected/);
    assert.match(files["schema.graphql"], /type Stub \{/);
    assert.match(files["src/EventHandlers.ts"], /export \{\};/);
  });

  it("package.json declares modern Envio dependencies", () => {
    const { files } = generateEnvioScaffold({ contractName: "Thing" }, ERC20_ABI);
    const pkg = JSON.parse(files["package.json"]);
    assert.equal(pkg.name, "thing-envio");
    assert.equal(pkg.private, true);
    assert.equal(pkg.type, "module");
    assert.ok(pkg.dependencies.envio);
    assert.equal(pkg.scripts.codegen, "envio codegen");
    assert.equal(pkg.scripts.dev, "envio dev");
  });
});
