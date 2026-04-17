/**
 * Subgraph scaffold generator.
 *
 * Given a contract name and its ABI, emit the four canonical files of
 * a minimal Graph Protocol subgraph — manifest, GraphQL schema,
 * AssemblyScript mappings, and the ABI copy:
 *
 *   subgraph.yaml
 *   schema.graphql
 *   src/<contract>.ts
 *   abis/<contract>.json
 *
 * The scaffold is event-driven: every `event` in the ABI produces one
 * entity in the schema plus a `handle<Event>` mapping function. Call
 * handlers and block handlers are intentionally out of scope — they're
 * rare and would clutter the starter template. Complex tuple
 * parameters (structs) are kept in the handler signature but emitted
 * with a `// TODO` comment because the GraphQL entity encoding
 * depends on domain semantics.
 *
 * This module is VSCode-free so it can be tested from the server's
 * `node --test` runner (mirrors how the LCOV + Aderyn parsers are
 * organized).
 */

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

export interface AbiParameter {
  name?: string;
  type: string;
  indexed?: boolean;
  components?: AbiParameter[];
  internalType?: string;
}

export interface AbiEvent {
  type: "event";
  name: string;
  inputs: AbiParameter[];
  anonymous?: boolean;
}

/**
 * Generate a complete subgraph scaffold for `contractName` from the
 * ABI entries. Unknown entry types (functions, constructors, errors)
 * are ignored; only `event` entries contribute.
 */
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

/**
 * Keep only `event` entries. Filter out entries with malformed shape
 * so the caller doesn't need to defensively pre-validate the ABI.
 */
export function extractEvents(abi: unknown[]): AbiEvent[] {
  const out: AbiEvent[] = [];
  for (const entry of abi) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (e.type !== "event" || typeof e.name !== "string") continue;
    const inputs = Array.isArray(e.inputs) ? (e.inputs as AbiParameter[]) : [];
    out.push({
      type: "event",
      name: e.name,
      inputs: inputs.map(normalizeParam),
      anonymous: e.anonymous === true,
    });
  }
  return out;
}

function normalizeParam(p: AbiParameter): AbiParameter {
  return {
    name: typeof p.name === "string" && p.name.length > 0 ? p.name : undefined,
    type: typeof p.type === "string" ? p.type : "bytes",
    indexed: p.indexed === true,
    components: Array.isArray(p.components) ? p.components.map(normalizeParam) : undefined,
    internalType: typeof p.internalType === "string" ? p.internalType : undefined,
  };
}

/**
 * Canonical Solidity event signature used by `eventHandlers.event` in
 * the subgraph manifest. Matches how `forge inspect` / Etherscan
 * render it, including the `indexed` keyword on topic params.
 */
export function eventSignature(ev: AbiEvent): string {
  const parts = ev.inputs.map((p) => {
    const t = canonicalParamType(p);
    return p.indexed ? `indexed ${t}` : t;
  });
  return `${ev.name}(${parts.join(",")})`;
}

function canonicalParamType(p: AbiParameter): string {
  if (p.type.startsWith("tuple") && p.components) {
    const inner = p.components.map(canonicalParamType).join(",");
    const suffix = p.type.slice("tuple".length); // e.g. "[]" for tuple[]
    return `(${inner})${suffix}`;
  }
  return p.type;
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

/**
 * Map a Solidity-ABI type string to the GraphQL scalar the subgraph
 * schema should declare. Tuples and arrays-of-tuples fall through to
 * `Bytes!` with a TODO comment; the mapping layer leaves a placeholder
 * for those as well. Scalar arrays are supported.
 */
function solidityTypeToGraphql(p: AbiParameter): string {
  if (isTupleType(p.type)) return "Bytes! # TODO: encode tuple per your domain";
  const arrayMatch = p.type.match(/^(.+?)(\[\d*\])+$/);
  if (arrayMatch) {
    const elemType = arrayMatch[1];
    const elemGql = scalarGraphqlType(elemType);
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
  return "Bytes!"; // conservative default
}

function isTupleType(type: string): boolean {
  return type.startsWith("tuple");
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

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * If a parameter has a name, use it verbatim; otherwise synthesise a
 * stable name like `arg0`, `arg1`. AssemblyScript field names and
 * GraphQL field names must agree, so we centralize the naming.
 */
export function paramFieldName(p: AbiParameter, index: number): string {
  return p.name && p.name.length > 0 ? p.name : `arg${index}`;
}

/**
 * Convert a PascalCase contract name to a camelCase file stem for
 * `src/<stem>.ts`. `MyContract` → `myContract`.
 */
function toCamelFile(name: string): string {
  if (!name) return "contract";
  return name[0].toLowerCase() + name.slice(1);
}
