import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { generatePonderScaffold } from "@solidity-workbench/common";

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
  { type: "function", name: "transfer", inputs: [] },
];

describe("generatePonderScaffold", () => {
  it("emits the canonical Ponder file set", () => {
    const { files } = generatePonderScaffold({ contractName: "Token" }, ERC20_ABI);
    const paths = Object.keys(files).sort();
    assert.deepEqual(paths, [
      ".env.example",
      "README.md",
      "abis/TokenAbi.ts",
      "package.json",
      "ponder.config.ts",
      "ponder.schema.ts",
      "src/index.ts",
    ]);
  });

  it("writes a `createConfig`-style ponder.config.ts with the resolved chain id", () => {
    const { files } = generatePonderScaffold(
      {
        contractName: "Token",
        network: "base",
        address: "0x1234567890123456789012345678901234567890",
        startBlock: 12345678,
      },
      ERC20_ABI,
    );
    const config = files["ponder.config.ts"];
    assert.match(config, /import \{ createConfig \} from "ponder";/);
    assert.match(config, /import \{ TokenAbi \} from "\.\/abis\/TokenAbi";/);
    assert.match(config, /chains: \{/);
    assert.match(config, /base: \{\s*id: 8453/);
    assert.match(config, /rpc: process\.env\.PONDER_RPC_URL_8453/);
    assert.match(config, /Token: \{\s*abi: TokenAbi,\s*chain: "base"/);
    assert.match(config, /address: "0x1234567890123456789012345678901234567890"/);
    assert.match(config, /startBlock: 12345678/);
  });

  it("generates one onchainTable per event with Drizzle column types", () => {
    const { files, events } = generatePonderScaffold({ contractName: "Token" }, ERC20_ABI);
    assert.deepEqual(events, ["Transfer", "Approval"]);

    const schema = files["ponder.schema.ts"];
    assert.match(schema, /import \{ onchainTable \} from "ponder";/);
    assert.match(schema, /export const transfer = onchainTable\("transfer", \(t\) => \(\{/);
    assert.match(schema, /export const approval = onchainTable\("approval", \(t\) => \(\{/);
    // address → t.hex().notNull()
    assert.match(schema, /from: t\.hex\(\)\.notNull\(\)/);
    // uint256 → t.bigint().notNull()
    assert.match(schema, /value: t\.bigint\(\)\.notNull\(\)/);
    // metadata columns
    assert.match(schema, /blockNumber: t\.bigint\(\)\.notNull\(\)/);
    assert.match(schema, /transactionHash: t\.hex\(\)\.notNull\(\)/);
    // id column is primaryKey
    assert.match(schema, /id: t\.hex\(\)\.primaryKey\(\)/);
  });

  it("uses snake_case table names even when the event is PascalCase with long words", () => {
    const abi = [
      {
        type: "event",
        name: "CountChangedOnceMore",
        inputs: [{ name: "v", type: "uint256" }],
      },
    ];
    const { files } = generatePonderScaffold({ contractName: "Counter" }, abi);
    assert.match(
      files["ponder.schema.ts"],
      /export const countChangedOnceMore = onchainTable\("count_changed_once_more", \(t\) => \(\{/,
    );
  });

  it("registers a ponder.on handler per event that inserts into the matching table", () => {
    const { files } = generatePonderScaffold({ contractName: "Token" }, ERC20_ABI);
    const handlers = files["src/index.ts"];
    assert.match(handlers, /import \{ ponder \} from "ponder:registry";/);
    assert.match(handlers, /from "\.\.\/ponder\.schema";/);
    assert.match(handlers, /ponder\.on\("Token:Transfer", async \(\{ event, context \}\) => \{/);
    assert.match(handlers, /ponder\.on\("Token:Approval", async \(\{ event, context \}\) => \{/);
    assert.match(handlers, /context\.db\.insert\(transfer\)\.values\(\{/);
    assert.match(handlers, /from: event\.args\.from/);
    assert.match(handlers, /to: event\.args\.to/);
    assert.match(handlers, /value: event\.args\.value/);
    assert.match(handlers, /event\.transaction\.hash/);
    assert.match(handlers, /event\.log\.logIndex/);
  });

  it("emits abis/<Contract>Abi.ts as `as const` so viem can infer event shapes", () => {
    const { files } = generatePonderScaffold({ contractName: "Token" }, ERC20_ABI);
    const abiModule = files["abis/TokenAbi.ts"];
    assert.match(abiModule, /export const TokenAbi = \[/);
    assert.match(abiModule, /\] as const;/);
    // Actual ABI entries shown verbatim
    assert.match(abiModule, /"Transfer"/);
    assert.match(abiModule, /"Approval"/);
  });

  it("flags tuple params with TODO markers in both schema and handlers", () => {
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
    const { files, eventsWithTupleWarnings } = generatePonderScaffold(
      { contractName: "Pool" },
      abi,
    );
    assert.deepEqual(eventsWithTupleWarnings, ["Complex"]);
    assert.match(files["ponder.schema.ts"], /key: t\.json\(\)\.notNull\(\)/);
    assert.match(files["ponder.schema.ts"], /TODO: tuple tuple/);
    assert.match(files["src/index.ts"], /TODO: encode tuple/);
    // Scalar sibling still emits a real assignment.
    assert.match(files["src/index.ts"], /value: event\.args\.value/);
  });

  it("maps array-of-scalar types to Drizzle `.array().notNull()`", () => {
    const abi = [
      {
        type: "event",
        name: "Batch",
        inputs: [
          { name: "recipients", type: "address[]" },
          { name: "amounts", type: "uint256[]" },
        ],
      },
    ];
    const { files } = generatePonderScaffold({ contractName: "Bulker" }, abi);
    const schema = files["ponder.schema.ts"];
    assert.match(schema, /recipients: t\.hex\(\)\.array\(\)\.notNull\(\)/);
    assert.match(schema, /amounts: t\.bigint\(\)\.array\(\)\.notNull\(\)/);
  });

  it("produces a usable stub when the ABI has no events", () => {
    const { files, events } = generatePonderScaffold({ contractName: "Empty" }, [
      { type: "function", name: "noop" },
    ]);
    assert.deepEqual(events, []);
    assert.match(files["ponder.schema.ts"], /export const stub = onchainTable\("stub"/);
    // Handler file is still valid TypeScript (no handlers registered).
    assert.match(files["src/index.ts"], /import \{ ponder \} from "ponder:registry";/);
  });

  it("package.json declares modern Ponder + viem dependencies", () => {
    const { files } = generatePonderScaffold({ contractName: "Thing" }, ERC20_ABI);
    const pkg = JSON.parse(files["package.json"]);
    assert.equal(pkg.name, "thing-ponder");
    assert.equal(pkg.private, true);
    assert.equal(pkg.type, "module");
    assert.match(pkg.dependencies.ponder, /^\^0\.[0-9]+/);
    assert.ok(pkg.dependencies.viem);
    assert.equal(pkg.scripts.dev, "ponder dev");
  });
});
