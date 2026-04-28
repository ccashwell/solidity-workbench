/**
 * Pure helpers for working with Solidity ABI fragments — used by the
 * Remote Chain UI to render function pickers, build the canonical
 * signatures `cast` accepts, and gate read-only invocation. Everything
 * here is VSCode-free so the server's `node --test` runner can
 * exercise it.
 *
 * # Notes on tuple / array encoding
 *
 * Tuples are flattened as `(t1,t2,...)` to match the Solidity ABI
 * specification's canonical encoding — that's what `cast call` wants
 * for the function signature argument. Nested tuples nest the parens
 * (e.g. `((address,uint256),uint256)`). Arrays preserve their `[]` /
 * `[N]` suffix and bind tighter than the tuple grouping (e.g. an
 * array of tuples renders as `(a,b)[]`).
 *
 * The struct's outer name (`internalType: "struct Foo"`) is
 * intentionally NOT used — the canonical signature is purely
 * structural. See the OpenZeppelin / forge ABI specs for the
 * authoritative rules.
 */

/** Minimal ABI parameter shape — matches the JSON forge emits. */
export interface AbiParam {
  /** Solidity-level identifier; may be empty for unnamed params. */
  name: string;
  /** Solidity type. For tuples this is "tuple" (or "tuple[]" / "tuple[N]"). */
  type: string;
  /** Present when the param is a tuple — describes its component types. */
  components?: AbiParam[];
  /** Forge sometimes embeds the human-readable type here (e.g. "struct Foo"). */
  internalType?: string;
}

/** Recognised ABI fragment kinds. */
export type AbiFragmentType =
  | "function"
  | "constructor"
  | "receive"
  | "fallback"
  | "event"
  | "error";

/** Minimal ABI function-fragment shape. */
export interface AbiFunctionFragment {
  type: AbiFragmentType;
  name?: string;
  inputs?: AbiParam[];
  outputs?: AbiParam[];
  stateMutability?: "view" | "pure" | "nonpayable" | "payable";
}

/**
 * Resolve a single param's canonical type token. Handles tuples (with
 * or without an array suffix), arrays of arrays, and primitive types.
 */
function canonicalType(param: AbiParam): string {
  const raw = param.type;
  if (!raw.startsWith("tuple")) return raw;

  // Anything trailing `tuple` is the array suffix — e.g. "tuple[]",
  // "tuple[3]", "tuple[][2]". Preserve it verbatim.
  const suffix = raw.slice("tuple".length);
  const components = param.components ?? [];
  const inner = components.map(canonicalType).join(",");
  return `(${inner})${suffix}`;
}

/**
 * Same as `canonicalType` but emits `(name1: type1, name2: type2)`
 * for tuples when the component params have names — used for
 * human-readable display in the function picker. Names are kept as
 * they appear in the ABI (no transformation).
 */
function displayType(param: AbiParam): string {
  const raw = param.type;
  if (!raw.startsWith("tuple")) return raw;
  const suffix = raw.slice("tuple".length);
  const components = param.components ?? [];
  const parts = components.map((c) => {
    const t = displayType(c);
    return c.name ? `${t} ${c.name}` : t;
  });
  return `(${parts.join(", ")})${suffix}`;
}

/**
 * Build the canonical signature `cast` accepts, e.g.
 * `transfer(address,uint256)`. Tuples render as `(t1,t2)`; arrays
 * preserve `[]` / `[N]`.
 *
 * Throws on non-function fragments and on functions missing a name.
 */
export function formatFunctionSignature(fragment: AbiFunctionFragment): string {
  if (fragment.type !== "function") {
    throw new Error(
      `formatFunctionSignature only supports function fragments, got "${fragment.type}".`,
    );
  }
  if (!fragment.name) {
    throw new Error("Function fragment is missing a name.");
  }
  const inputs = (fragment.inputs ?? []).map(canonicalType).join(",");
  return `${fragment.name}(${inputs})`;
}

/**
 * Build the human-friendly signature with parameter names included,
 * e.g. `transfer(address to, uint256 amount)`. Used as a UI label;
 * not safe to feed to `cast` (cast wants the structural form).
 */
export function formatFunctionDisplaySignature(fragment: AbiFunctionFragment): string {
  if (fragment.type !== "function") {
    throw new Error(
      `formatFunctionDisplaySignature only supports function fragments, got "${fragment.type}".`,
    );
  }
  if (!fragment.name) {
    throw new Error("Function fragment is missing a name.");
  }
  const parts = (fragment.inputs ?? []).map((p) => {
    const t = displayType(p);
    return p.name ? `${t} ${p.name}` : t;
  });
  return `${fragment.name}(${parts.join(", ")})`;
}

/**
 * Build the cast-style signature with output types appended, e.g.
 * `decimals()(uint8)` — when this form is passed to `cast call`,
 * cast decodes the return value inline and prints the human form
 * instead of raw hex.
 *
 * Returns the bare signature (no trailing `()`) when the function
 * has no outputs.
 */
export function formatFunctionSignatureWithReturns(fragment: AbiFunctionFragment): string {
  const base = formatFunctionSignature(fragment);
  const outputs = (fragment.outputs ?? []).map(canonicalType).join(",");
  if (!outputs) return base;
  return `${base}(${outputs})`;
}

/** True when the fragment is invokable read-only (view or pure). */
export function isReadOnly(fragment: AbiFunctionFragment): boolean {
  if (fragment.type !== "function") return false;
  return fragment.stateMutability === "view" || fragment.stateMutability === "pure";
}
