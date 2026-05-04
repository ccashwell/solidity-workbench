/**
 * Parser for Foundry compilation artifacts (`out/<File>.sol/<Contract>.json`).
 *
 * Forge artifacts wrap solc's `--combined-json` output with some
 * extras (build-info pointer, source list, method identifiers).
 * The DAP debug adapter needs four pieces:
 *
 *   - Deployed bytecode (the runtime code the EVM actually
 *     executes, post-constructor).
 *   - Deployed sourceMap (the compressed `s:l:f:j:m;...` string
 *     for the runtime instruction sequence).
 *   - Creation bytecode + sourceMap (for stepping through the
 *     constructor; not yet wired into the adapter but parsed
 *     here for forward-compatibility).
 *   - The compilation's source list, ordered by source-map
 *     `fileIndex`. This is what makes a `fileIndex: 2` map back
 *     to `src/Bar.sol`.
 *
 * Forge has serialised these slightly differently across versions
 * — the parser tolerates `bytecode` / `evm.bytecode` /
 * `bytecodeObject` aliases at the top level, and falls back across
 * `metadata.sources` (canonical), a top-level `sources` array, and
 * a top-level `sourceList` array for the source-list resolution.
 *
 * Returns `null` on unparseable input. Callers should treat that
 * as "I can't debug this artifact" rather than throwing — a
 * malformed artifact almost always means the project hasn't been
 * built yet.
 */

/** Decoded artifact ready for the source-resolver / debug adapter. */
export interface ForgeArtifact {
  deployedBytecode: string;
  deployedSourceMap: string;
  bytecode: string;
  bytecodeSourceMap: string;
  /**
   * Source paths ordered by source-map `fileIndex`. Index 0 is the
   * first source, etc. Length equals the highest `fileIndex` + 1
   * present in the metadata; some entries may be empty strings if
   * the metadata didn't disclose every source.
   */
  sources: string[];
}

/**
 * Parse a forge artifact JSON string. Returns `null` for invalid
 * input or when the artifact lacks the deployed bytecode + sourceMap
 * (which is what the debug adapter actually needs).
 */
export function parseForgeArtifact(json: string): ForgeArtifact | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  const deployed = readBytecode(obj, "deployedBytecode");
  const creation = readBytecode(obj, "bytecode");
  if (!deployed) return null;

  return {
    deployedBytecode: deployed.object,
    deployedSourceMap: deployed.sourceMap,
    bytecode: creation?.object ?? "",
    bytecodeSourceMap: creation?.sourceMap ?? "",
    sources: extractSources(obj),
  };
}

interface RawBytecode {
  object: string;
  sourceMap: string;
}

/**
 * Forge's artifact has the bytecode / deployedBytecode under one of:
 *   - `<key>: { object: "0x...", sourceMap: "..." }`     (canonical)
 *   - `<key>: "0x..."` + `<key>SourceMap: "..."`         (rare)
 *   - `evm.<key>: { object, sourceMap }`                 (some legacy outputs)
 */
function readBytecode(obj: Record<string, unknown>, key: string): RawBytecode | null {
  const candidates: unknown[] = [obj[key]];
  const evm = obj.evm as Record<string, unknown> | undefined;
  if (evm) candidates.push(evm[key]);

  for (const cand of candidates) {
    if (!cand) continue;
    if (typeof cand === "string") {
      const sourceMap =
        typeof obj[`${key}SourceMap`] === "string" ? (obj[`${key}SourceMap`] as string) : "";
      if (cand.length === 0) continue;
      return { object: cand, sourceMap };
    }
    if (typeof cand === "object") {
      const c = cand as Record<string, unknown>;
      const object = typeof c.object === "string" ? c.object : "";
      const sourceMap = typeof c.sourceMap === "string" ? c.sourceMap : "";
      if (object.length === 0) continue;
      return { object, sourceMap };
    }
  }
  return null;
}

/**
 * Build the source list, ordered by source-map `fileIndex`. Tries
 * three sources in order:
 *
 *   1. `metadata.sources` (canonical solc metadata): an object
 *      whose keys are the source paths in the order solc compiled
 *      them. The order IS the fileIndex.
 *   2. `sources: ["src/Foo.sol", ...]` — some forge versions emit
 *      this directly.
 *   3. `sourceList: [...]` — historical name for the same.
 *
 * Returns `[]` when none of the above is present; callers without
 * a sources list will degrade to "(unknown file index N)" rather
 * than failing.
 */
function extractSources(obj: Record<string, unknown>): string[] {
  // Forge stores `metadata` as a JSON-encoded string most of the
  // time, but a parsed object on some versions. Handle both.
  const metadata = obj.metadata;
  let metadataObj: Record<string, unknown> | null = null;
  if (typeof metadata === "string") {
    try {
      metadataObj = JSON.parse(metadata) as Record<string, unknown>;
    } catch {
      // fall through
    }
  } else if (metadata && typeof metadata === "object") {
    metadataObj = metadata as Record<string, unknown>;
  }

  if (metadataObj && metadataObj.sources && typeof metadataObj.sources === "object") {
    return Object.keys(metadataObj.sources as Record<string, unknown>);
  }

  if (Array.isArray(obj.sources)) {
    return obj.sources.filter((s): s is string => typeof s === "string");
  }
  if (Array.isArray(obj.sourceList)) {
    return obj.sourceList.filter((s): s is string => typeof s === "string");
  }

  return [];
}
