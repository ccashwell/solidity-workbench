/**
 * Parser for the `storageLayout` block of a forge / solc artifact.
 *
 * Each compiled contract's artifact (`out/<File>.sol/<Contract>.json`)
 * carries a `storageLayout` describing where the contract's state
 * variables live in storage:
 *
 *   {
 *     "storageLayout": {
 *       "storage": [
 *         { "label": "count", "slot": "0", "offset": 0, "type": "t_uint256" },
 *         { "label": "owner", "slot": "1", "offset": 0, "type": "t_address" }
 *       ],
 *       "types": {
 *         "t_uint256": { "label": "uint256", "numberOfBytes": "32" },
 *         "t_address": { "label": "address",  "numberOfBytes": "20" }
 *       }
 *     }
 *   }
 *
 * Multiple entries can share a slot when the compiler has packed
 * them; offset (in bytes) within the slot disambiguates. The DAP
 * adapter uses this to pretty-print the structlog-emitted storage
 * diff (which only knows raw `slot → value` pairs) as named
 * variables in the Variables panel.
 */

export interface StorageLayoutEntry {
  /** Source-level identifier for the storage variable. */
  label: string;
  /** 1-based slot number, decoded from `slot: "0"`-style strings. */
  slot: bigint;
  /** Byte offset within the slot (0..31), 0 for the canonical "starts at the beginning" case. */
  offset: number;
  /** Resolved Solidity type label (e.g. `uint256`, `mapping(address => uint256)`). */
  type: string;
  /** Width of the slot occupied by this entry, in bytes (max 32). */
  numberOfBytes: number;
}

export interface StorageLayout {
  /** Entries in declaration order, suitable for direct rendering. */
  entries: StorageLayoutEntry[];
  /** Convenience index from slot string (`"0"`) to the entries that occupy it. */
  bySlot: Map<string, StorageLayoutEntry[]>;
}

/**
 * Parse the `storageLayout` portion of an already-parsed forge
 * artifact JSON. Accepts either the artifact root (with a
 * `storageLayout` key) or the storageLayout object itself, since
 * different code paths arrive with different parents.
 *
 * Returns `null` for invalid / missing input. Empty layouts (e.g.
 * a contract with no state variables) yield a `StorageLayout` with
 * empty `entries` and `bySlot` so callers don't have to special-case.
 */
export function parseStorageLayout(input: unknown): StorageLayout | null {
  if (!input || typeof input !== "object") return null;
  const root = input as Record<string, unknown>;

  const layout =
    root.storageLayout && typeof root.storageLayout === "object"
      ? (root.storageLayout as Record<string, unknown>)
      : root;
  if (!layout || typeof layout !== "object") return null;

  const storage = layout.storage;
  const types = layout.types;
  if (!Array.isArray(storage)) return null;

  const typeLookup = new Map<string, { label: string; numberOfBytes: number }>();
  if (types && typeof types === "object") {
    for (const [typeId, value] of Object.entries(types as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const t = value as Record<string, unknown>;
      const label = typeof t.label === "string" ? t.label : typeId.replace(/^t_/, "");
      const nob = typeof t.numberOfBytes === "string" ? Number.parseInt(t.numberOfBytes, 10) : 32;
      typeLookup.set(typeId, { label, numberOfBytes: Number.isFinite(nob) ? nob : 32 });
    }
  }

  const entries: StorageLayoutEntry[] = [];
  const bySlot = new Map<string, StorageLayoutEntry[]>();

  for (const raw of storage) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    const label = typeof e.label === "string" ? e.label : "";
    const slotStr = typeof e.slot === "string" || typeof e.slot === "number" ? String(e.slot) : "";
    const offset = typeof e.offset === "number" ? e.offset : 0;
    const typeId = typeof e.type === "string" ? e.type : "";
    if (!label || !slotStr || !typeId) continue;

    let slot: bigint;
    try {
      slot = BigInt(slotStr);
    } catch {
      continue;
    }
    const typeMeta = typeLookup.get(typeId);
    const entry: StorageLayoutEntry = {
      label,
      slot,
      offset,
      type: typeMeta?.label ?? typeId.replace(/^t_/, ""),
      numberOfBytes: typeMeta?.numberOfBytes ?? 32,
    };
    entries.push(entry);
    const slotKey = entry.slot.toString();
    const list = bySlot.get(slotKey) ?? [];
    list.push(entry);
    bySlot.set(slotKey, list);
  }

  return { entries, bySlot };
}

/**
 * Look up the named storage variables that occupy `slot`. Tolerant
 * of the leading-zero / `0x` prefixing that geth-style traces emit
 * (`"0x0000...0001"` is normalised to `"1"` before lookup).
 */
export function lookupSlot(layout: StorageLayout, rawSlot: string): StorageLayoutEntry[] {
  const normalized = normaliseSlot(rawSlot);
  return layout.bySlot.get(normalized) ?? [];
}

function normaliseSlot(rawSlot: string): string {
  let s = rawSlot.trim();
  if (s.startsWith("0x") || s.startsWith("0X")) s = s.slice(2);
  s = s.replace(/^0+/, "");
  return s.length === 0 ? "0" : BigInt("0x" + s).toString();
}
