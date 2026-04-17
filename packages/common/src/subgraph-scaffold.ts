/**
 * Subgraph scaffold generator — Graph Protocol backend.
 *
 * Given a contract name and its ABI, emit the canonical files of a
 * minimal subgraph: manifest, GraphQL schema, and AssemblyScript
 * mapping. The ABI itself is copied alongside by the extension
 * command; the pure generator here only produces source files.
 *
 * Shared ABI / signature helpers live in `./indexer-shared.ts` so the
 * Ponder and Envio backends emit byte-identical canonical signatures
 * for the same events.
 */

import {
  extractEvents,
  eventSignature,
  isTupleType,
  paramFieldName,
  parseArrayType,
  toCamelFile,
  type AbiEvent,
  type AbiParameter,
} from "./indexer-shared.js";

// Re-export the shared ABI / event primitives under their historical
// module path so downstream callers keep working without an import
// churn when helpers moved.
export {
  extractEvents,
  eventSignature,
  paramFieldName,
  type AbiEvent,
  type AbiParameter,
} from "./indexer-shared.js";

export interface SubgraphScaffoldOptions {
  contractName: string;
  /** The Graph network slug, e.g. `mainnet`, `base`, `arbitrum-one`. */
  network?: string;
  /** 0x-prefixed deployed contract address. */
  address?: string;
  /** Block to start indexing from. */
  startBlock?: number;
  /** Subgraph manifest spec version. */
  specVersion?: string;
  /** `mapping.apiVersion` for the Graph node. */
  apiVersion?: string;
}

export interface SubgraphScaffoldResult {
  /** Map of relative file path → generated contents. */
  files: Record<string, string>;
  /** Event names that were included in the scaffold. */
  events: string[];
  /** Event names whose tuple params were flagged with TODO markers. */
  eventsWithTupleWarnings: string[];
}

export function generateSubgraphScaffold(
  options: SubgraphScaffoldOptions,
  abi: unknown[],
): SubgraphScaffoldResult {
  const events = extractEvents(abi);
  const eventsWithTupleWarnings = events
    .filter((e) => e.inputs.some((p) => isTupleType(p.type)))
    .map((e) => e.name);

  const lowerName = toCamelFile(options.contractName);

  const files: Record<string, string> = {
    "subgraph.yaml": generateManifest(options, events),
    "schema.graphql": generateSchema(events),
    [`src/${lowerName}.ts`]: generateMapping(options.contractName, events),
  };

  return {
    files,
    events: events.map((e) => e.name),
    eventsWithTupleWarnings,
  };
}

// ── Manifest ─────────────────────────────────────────────────────────

function generateManifest(opts: SubgraphScaffoldOptions, events: AbiEvent[]): string {
  const {
    contractName,
    network = "mainnet",
    address = "0x0000000000000000000000000000000000000000",
    startBlock = 0,
    specVersion = "1.0.0",
    apiVersion = "0.0.7",
  } = opts;

  const fileRef = `src/${toCamelFile(contractName)}.ts`;
  const entityList =
    events.length === 0 ? "        - Stub" : events.map((e) => `        - ${e.name}`).join("\n");
  const eventHandlers =
    events.length === 0
      ? "        # No events detected in ABI — add call or block handlers manually."
      : events
          .map(
            (e) => `        - event: ${eventSignature(e)}\n` + `          handler: handle${e.name}`,
          )
          .join("\n");

  return `specVersion: ${specVersion}
indexerHints:
  prune: auto
schema:
  file: ./schema.graphql
dataSources:
  - kind: ethereum
    name: ${contractName}
    network: ${network}
    source:
      address: "${address}"
      abi: ${contractName}
      startBlock: ${startBlock}
    mapping:
      kind: ethereum/events
      apiVersion: ${apiVersion}
      language: wasm/assemblyscript
      entities:
${entityList}
      abis:
        - name: ${contractName}
          file: ./abis/${contractName}.json
      eventHandlers:
${eventHandlers}
      file: ./${fileRef}
`;
}

// ── Schema ────────────────────────────────────────────────────────────

function generateSchema(events: AbiEvent[]): string {
  if (events.length === 0) {
    return `# No events found in the ABI. Add your entity types here.
type Stub @entity(immutable: true) {
  id: Bytes!
  blockNumber: BigInt!
  blockTimestamp: BigInt!
  transactionHash: Bytes!
}
`;
  }

  const entities = events.map((e) => {
    const fields: string[] = ["  id: Bytes!"];
    for (const [i, p] of e.inputs.entries()) {
      const fieldName = paramFieldName(p, i);
      const gql = solidityTypeToGraphql(p);
      fields.push(`  ${fieldName}: ${gql}`);
    }
    fields.push("  blockNumber: BigInt!");
    fields.push("  blockTimestamp: BigInt!");
    fields.push("  transactionHash: Bytes!");
    return `type ${e.name} @entity(immutable: true) {\n${fields.join("\n")}\n}`;
  });
  return entities.join("\n\n") + "\n";
}

function solidityTypeToGraphql(p: AbiParameter): string {
  if (isTupleType(p.type)) return "Bytes! # TODO: encode tuple per your domain";
  const arr = parseArrayType(p.type);
  if (arr) {
    const elemGql = scalarGraphqlType(arr.element);
    return `[${elemGql.replace(/!$/, "")}!]!`;
  }
  return scalarGraphqlType(p.type);
}

function scalarGraphqlType(type: string): string {
  if (type === "address") return "Bytes!";
  if (type === "bool") return "Boolean!";
  if (type === "string") return "String!";
  if (type === "bytes" || /^bytes\d+$/.test(type)) return "Bytes!";
  if (/^u?int\d*$/.test(type)) return "BigInt!";
  return "Bytes!";
}

// ── AssemblyScript mapping ───────────────────────────────────────────

function generateMapping(contractName: string, events: AbiEvent[]): string {
  if (events.length === 0) {
    return `// No events found in the ABI. Add your handlers here.\n`;
  }

  const importedEvents = events.map((e) => `${e.name} as ${e.name}Event`).join(",\n  ");
  const importedEntities = events.map((e) => e.name).join(",\n  ");

  const handlers = events
    .map((e) => {
      const body = e.inputs
        .map((p, i) => {
          const fieldName = paramFieldName(p, i);
          const paramAccess = p.name ?? `${fieldName}`;
          if (isTupleType(p.type)) {
            return `  // TODO: encode tuple param \`${paramAccess}\` (${p.type}) into \`entity.${fieldName}\``;
          }
          return `  entity.${fieldName} = event.params.${paramAccess};`;
        })
        .join("\n");
      return `export function handle${e.name}(event: ${e.name}Event): void {
  let entity = new ${e.name}(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  );

${body}

  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;

  entity.save();
}`;
    })
    .join("\n\n");

  return `import {
  ${importedEvents}
} from "../generated/${contractName}/${contractName}";
import {
  ${importedEntities}
} from "../generated/schema";

${handlers}
`;
}
