/**
 * Ponder indexer scaffold generator.
 *
 * Ponder (https://ponder.sh) is a TypeScript-first EVM indexer that
 * runs locally against SQLite or Postgres. It uses three files plus
 * an ABI module:
 *
 *   ponder.config.ts     - chains, contracts, start block, ABI refs
 *   ponder.schema.ts     - `onchainTable` entries (Drizzle-style)
 *   src/index.ts         - ponder.on("<Contract>:<Event>", handler)
 *   abis/<Contract>Abi.ts - TypeScript `as const` ABI export
 *
 * The scaffold here tracks the post-0.8 API surface — `chains` (not
 * `networks`), `rpc` (not `transport`), and `onchainTable` (not
 * `createSchema`). Column types are mapped to Drizzle's `t.hex()` /
 * `t.bigint()` / `t.boolean()` / `t.text()` set; tuple / struct
 * params get a `t.json()` column with a TODO since their shape
 * depends on the contract's semantics.
 */

import {
  extractEvents,
  isTupleType,
  paramFieldName,
  parseArrayType,
  type AbiEvent,
  type AbiParameter,
} from "./indexer-shared.js";

export interface PonderScaffoldOptions {
  contractName: string;
  /** Network slug resolved to a chain id via `chainIdForNetwork`. */
  network?: string;
  /** 0x-prefixed deployed contract address. */
  address?: string;
  /** Block to start indexing from. */
  startBlock?: number;
}

export interface PonderScaffoldResult {
  files: Record<string, string>;
  events: string[];
  eventsWithTupleWarnings: string[];
}

/**
 * Entrypoint: produce every file a fresh Ponder project needs, keyed
 * by workspace-relative path. Callers are expected to also copy the
 * raw JSON ABI alongside (the extension does this so users can
 * regenerate `abis/<Contract>Abi.ts` from a canonical source).
 */
export function generatePonderScaffold(
  options: PonderScaffoldOptions,
  abi: unknown[],
): PonderScaffoldResult {
  const events = extractEvents(abi);
  const eventsWithTupleWarnings = events
    .filter((e) => e.inputs.some((p) => isTupleType(p.type)))
    .map((e) => e.name);

  const files: Record<string, string> = {
    "ponder.config.ts": generateConfig(options, abi),
    "ponder.schema.ts": generateSchema(events),
    "src/index.ts": generateHandlers(options.contractName, events),
    [`abis/${options.contractName}Abi.ts`]: generateAbiModule(options.contractName, abi),
    "package.json": generatePackageJson(options.contractName),
    ".env.example": generateEnvExample(),
    "README.md": generateReadme(options.contractName),
  };

  return {
    files,
    events: events.map((e) => e.name),
    eventsWithTupleWarnings,
  };
}

// ── ponder.config.ts ─────────────────────────────────────────────────

function generateConfig(opts: PonderScaffoldOptions, abi: unknown[]): string {
  const {
    contractName,
    network = "mainnet",
    address = "0x0000000000000000000000000000000000000000",
    startBlock = 0,
  } = opts;
  const chainId = chainIdFor(network);
  const abiImport = `${contractName}Abi`;

  void abi; // ABI is stored in the separate abis/<Contract>Abi.ts module.

  return `import { createConfig } from "ponder";

import { ${abiImport} } from "./abis/${abiImport}";

export default createConfig({
  chains: {
    ${network}: {
      id: ${chainId},
      rpc: process.env.PONDER_RPC_URL_${chainId} ?? "",
    },
  },
  contracts: {
    ${contractName}: {
      abi: ${abiImport},
      chain: "${network}",
      address: "${address}",
      startBlock: ${startBlock},
    },
  },
});
`;
}

// ── ponder.schema.ts ─────────────────────────────────────────────────

function generateSchema(events: AbiEvent[]): string {
  if (events.length === 0) {
    return `import { onchainTable } from "ponder";

// No events detected in the ABI. Replace this stub with tables for
// whatever the indexer should track.
export const stub = onchainTable("stub", (t) => ({
  id: t.hex().primaryKey(),
  blockNumber: t.bigint().notNull(),
  blockTimestamp: t.bigint().notNull(),
  transactionHash: t.hex().notNull(),
}));
`;
  }

  const tables = events
    .map((e) => {
      const columns = e.inputs
        .map((p, i) => {
          const fieldName = paramFieldName(p, i);
          const column = solidityTypeToDrizzle(p);
          return `  ${fieldName}: ${column},`;
        })
        .join("\n");
      const tableName = snakeCase(e.name);
      return `export const ${lowerFirst(e.name)} = onchainTable("${tableName}", (t) => ({
  id: t.hex().primaryKey(),
${columns}
  blockNumber: t.bigint().notNull(),
  blockTimestamp: t.bigint().notNull(),
  transactionHash: t.hex().notNull(),
}));`;
    })
    .join("\n\n");

  return `import { onchainTable } from "ponder";

${tables}
`;
}

/**
 * Map a Solidity ABI type to the Drizzle column-builder fragment the
 * Ponder `onchainTable` callback expects. Every column is annotated
 * `.notNull()` so the generated row shape is concrete — Ponder's
 * TypeScript inference relies on it. Tuple params fall through to
 * `t.json()` with a TODO marker; array-of-scalar types become
 * `.array()`.
 */
function solidityTypeToDrizzle(p: AbiParameter): string {
  if (isTupleType(p.type)) {
    return `t.json().notNull() /* TODO: tuple ${p.type} — shape this to your domain */`;
  }
  const arr = parseArrayType(p.type);
  if (arr) {
    const inner = scalarDrizzleColumn(arr.element);
    return `${inner}.array().notNull()`;
  }
  return `${scalarDrizzleColumn(p.type)}.notNull()`;
}

function scalarDrizzleColumn(type: string): string {
  if (type === "address") return "t.hex()";
  if (type === "bool") return "t.boolean()";
  if (type === "string") return "t.text()";
  if (type === "bytes" || /^bytes\d+$/.test(type)) return "t.hex()";
  if (/^u?int\d*$/.test(type)) return "t.bigint()";
  return "t.hex()";
}

// ── src/index.ts (handlers) ──────────────────────────────────────────

function generateHandlers(contractName: string, events: AbiEvent[]): string {
  if (events.length === 0) {
    return `// No events detected in the ABI. Register handlers via \`ponder.on\` here.
import { ponder } from "ponder:registry";

void ponder;
`;
  }

  const imports = events
    .map((e) => lowerFirst(e.name))
    .concat([])
    .join(",\n  ");
  const handlers = events
    .map((e) => {
      const assignments = e.inputs
        .map((p, i) => {
          const fieldName = paramFieldName(p, i);
          const paramAccess = p.name ?? fieldName;
          if (isTupleType(p.type)) {
            return `    ${fieldName}: event.args.${paramAccess} as unknown, // TODO: encode tuple to JSON`;
          }
          return `    ${fieldName}: event.args.${paramAccess},`;
        })
        .join("\n");
      return `ponder.on("${contractName}:${e.name}", async ({ event, context }) => {
  await context.db.insert(${lowerFirst(e.name)}).values({
    id: \`\${event.transaction.hash}-\${event.log.logIndex}\`,
${assignments}
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
  });
});`;
    })
    .join("\n\n");

  return `import { ponder } from "ponder:registry";

import {
  ${imports},
} from "../ponder.schema";

${handlers}
`;
}

// ── abis/<Contract>Abi.ts ────────────────────────────────────────────

function generateAbiModule(contractName: string, abi: unknown[]): string {
  const json = JSON.stringify(abi, null, 2);
  return `// Auto-generated by Solidity Workbench from the Forge artifact.
// Keep as \`as const\` so Ponder / viem can infer the event signatures.
export const ${contractName}Abi = ${json} as const;
`;
}

// ── package.json ─────────────────────────────────────────────────────

function generatePackageJson(contractName: string): string {
  const json = {
    name: `${kebabCase(contractName)}-ponder`,
    private: true,
    type: "module",
    scripts: {
      dev: "ponder dev",
      start: "ponder start",
      codegen: "ponder codegen",
      serve: "ponder serve",
    },
    dependencies: {
      hono: "^4.0.0",
      ponder: "^0.8.0",
      viem: "^2.21.0",
    },
    devDependencies: {
      "@types/node": "^20.0.0",
      typescript: "^5.3.0",
    },
  };
  return JSON.stringify(json, null, 2) + "\n";
}

// ── .env.example ─────────────────────────────────────────────────────

function generateEnvExample(): string {
  return `# Ponder RPC URL per chain id. Add additional PONDER_RPC_URL_<chainId>
# lines as you add chains to ponder.config.ts.
PONDER_RPC_URL_1=https://eth.llamarpc.com
`;
}

// ── README.md ────────────────────────────────────────────────────────

function generateReadme(contractName: string): string {
  return `# ${contractName} — Ponder indexer

Generated by Solidity Workbench.

## Quick start

\`\`\`bash
cp .env.example .env.local   # edit PONDER_RPC_URL_<chainId>
pnpm install
pnpm dev                     # local dev server on :42069
\`\`\`

The scaffold maps every event in the contract ABI to an \`onchainTable\`
entity plus a matching \`ponder.on\` handler. Tuple / struct parameters
are typed as \`t.json()\` with \`TODO\` markers — fill those in with
whatever JSON shape makes sense for your domain.

See https://ponder.sh for the full Ponder reference.
`;
}

// ── helpers ──────────────────────────────────────────────────────────

function lowerFirst(s: string): string {
  return s.length === 0 ? s : s[0].toLowerCase() + s.slice(1);
}

/**
 * PascalCase `CountChanged` → snake_case `count_changed`. Used for
 * Ponder's `onchainTable(name, …)` first argument so the SQL table
 * name follows the idiomatic convention.
 */
function snakeCase(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

function kebabCase(s: string): string {
  return snakeCase(s).replace(/_/g, "-");
}

// Keep the network → chain-id resolution local to this module to
// avoid cross-imports. The list mirrors `indexer-shared.chainIdForNetwork`
// but stays trimmed to the networks Ponder's free tier commonly uses.
function chainIdFor(network: string): number {
  switch (network) {
    case "mainnet":
    case "ethereum":
      return 1;
    case "optimism":
      return 10;
    case "base":
      return 8453;
    case "arbitrum-one":
    case "arbitrum":
      return 42161;
    case "polygon":
    case "matic":
      return 137;
    case "bsc":
      return 56;
    case "avalanche":
      return 43114;
    case "sepolia":
      return 11155111;
    case "base-sepolia":
      return 84532;
    default:
      return 1;
  }
}
