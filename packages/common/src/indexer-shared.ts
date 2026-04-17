/**
 * Shared primitives used by every indexer-scaffold generator
 * (`subgraph-scaffold`, `ponder-scaffold`, `envio-scaffold`). Keeps ABI
 * normalization, canonical-signature rendering, parameter naming, and
 * path-stem helpers in one place so the three generators stay in
 * lockstep when an ABI quirk needs to be handled uniformly.
 *
 * This module is VSCode-free so every generator can be tested from
 * the server's `node --test` runner.
 */

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
 * Keep only well-formed `event` entries from an ABI. Unknown / malformed
 * shapes are silently dropped so the generator callers don't need to
 * pre-validate.
 */
export function extractEvents(abi: unknown[]): AbiEvent[] {
  if (!Array.isArray(abi)) return [];
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
 * Canonical Solidity event signature. Used by both the subgraph
 * manifest's `eventHandlers.event` key and Envio's `config.yaml`
 * `events` entries. Matches how `forge inspect` / Etherscan render
 * signatures: indexed params carry the `indexed` keyword, struct
 * params are recursively flattened into `(type1,type2,...)` form,
 * and trailing `[]` / `[N]` array suffixes are preserved.
 */
export function eventSignature(ev: AbiEvent, options: { includeIndexed?: boolean } = {}): string {
  const includeIndexed = options.includeIndexed ?? true;
  const parts = ev.inputs.map((p) => {
    const t = canonicalParamType(p);
    return includeIndexed && p.indexed ? `indexed ${t}` : t;
  });
  return `${ev.name}(${parts.join(",")})`;
}

export function canonicalParamType(p: AbiParameter): string {
  if (p.type.startsWith("tuple") && p.components) {
    const inner = p.components.map(canonicalParamType).join(",");
    const suffix = p.type.slice("tuple".length);
    return `(${inner})${suffix}`;
  }
  return p.type;
}

export function isTupleType(type: string): boolean {
  return type.startsWith("tuple");
}

/**
 * If a parameter has a name, use it verbatim; otherwise synthesise a
 * stable name like `arg0`, `arg1`. Every generator relies on a
 * predictable field name when the ABI parameter is unnamed.
 */
export function paramFieldName(p: AbiParameter, index: number): string {
  return p.name && p.name.length > 0 ? p.name : `arg${index}`;
}

/**
 * `MyContract` → `myContract`. Used for generating e.g.
 * `src/myContract.ts` file stems in the subgraph and Ponder
 * scaffolds so they don't clash with the matching entity /
 * config file.
 */
export function toCamelFile(name: string): string {
  if (!name) return "contract";
  return name[0].toLowerCase() + name.slice(1);
}

/**
 * Lossless check for scalar array types — `address[]`, `uint256[3]`,
 * etc. Returns the element type and the bracket suffix, or `null`
 * when the input is not an array type.
 */
export function parseArrayType(type: string): { element: string; suffix: string } | null {
  const m = type.match(/^(.+?)(\[\d*\])+$/);
  if (!m) return null;
  const element = m[1];
  const suffix = type.slice(element.length);
  return { element, suffix };
}

/**
 * Chain id for a handful of well-known networks, used when an
 * indexer backend wants a numeric chain id instead of a slug. Defaults
 * to `1` (mainnet) when the network isn't recognized.
 */
export function chainIdForNetwork(network: string): number {
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
