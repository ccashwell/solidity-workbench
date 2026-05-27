import type { NatspecComment, SolSymbol } from "@solidity-workbench/common";
import type { SymbolIndex } from "../analyzer/symbol-index.js";

/** True when NatSpec has displayable content beyond a bare `@inheritdoc` tag. */
export function hasNatspecBody(natspec: NatspecComment): boolean {
  if (natspec.notice?.trim() || natspec.dev?.trim()) return true;
  if (natspec.params && Object.keys(natspec.params).length > 0) return true;
  if (natspec.returns && Object.keys(natspec.returns).length > 0) return true;
  if (natspec.custom) {
    for (const [tag, value] of Object.entries(natspec.custom)) {
      if (tag !== "inheritdoc" && value.trim()) return true;
    }
  }
  return false;
}

/**
 * Resolve `@inheritdoc` to the parent declaration's NatSpec (recursively).
 * Local `@notice` / `@dev` / `@param` / `@return` override inherited values.
 */
export function resolveEffectiveNatspec(
  sym: SolSymbol,
  index: SymbolIndex,
  visited: Set<string> = new Set(),
): NatspecComment | undefined {
  const natspec = sym.natspec;
  if (!natspec) return undefined;

  const inheritRef = natspec.custom?.inheritdoc?.trim();
  const needsInherit = inheritRef !== undefined || !hasNatspecBody(natspec);

  let inherited: NatspecComment | undefined;
  if (needsInherit) {
    const sourceSym = findInheritdocSource(sym, inheritRef, index);
    if (sourceSym) {
      const key = `${sourceSym.filePath}#${sourceSym.containerName ?? ""}#${sourceSym.name ?? ""}`;
      if (!visited.has(key)) {
        visited.add(key);
        inherited = resolveEffectiveNatspec(sourceSym, index, visited);
      }
    }
  }

  if (!inherited) {
    return hasNatspecBody(natspec) ? stripInheritdocTag(natspec) : undefined;
  }

  return mergeNatspec(inherited, natspec);
}

function stripInheritdocTag(natspec: NatspecComment): NatspecComment {
  if (!natspec.custom?.inheritdoc) return natspec;
  const custom = { ...natspec.custom };
  delete custom.inheritdoc;
  return {
    ...natspec,
    custom: Object.keys(custom).length > 0 ? custom : undefined,
  };
}

function mergeNatspec(parent: NatspecComment, child: NatspecComment): NatspecComment {
  const custom: Record<string, string> = { ...parent.custom, ...child.custom };
  delete custom.inheritdoc;

  const params = { ...parent.params, ...child.params };
  const returns = { ...parent.returns, ...child.returns };

  return {
    title: child.title ?? parent.title,
    author: child.author ?? parent.author,
    notice: child.notice ?? parent.notice,
    dev: child.dev ?? parent.dev,
    params: Object.keys(params).length > 0 ? params : undefined,
    returns: Object.keys(returns).length > 0 ? returns : undefined,
    custom: Object.keys(custom).length > 0 ? custom : undefined,
  };
}

function findInheritdocSource(
  sym: SolSymbol,
  inheritRef: string | undefined,
  index: SymbolIndex,
): SolSymbol | null {
  const memberName = sym.name;
  const containerName = sym.containerName;
  if (!memberName || !containerName) return null;

  let targetContract: string | undefined;
  let targetMember = memberName;

  if (inheritRef) {
    const dot = inheritRef.lastIndexOf(".");
    if (dot >= 0) {
      targetContract = inheritRef.slice(0, dot);
      targetMember = inheritRef.slice(dot + 1);
    } else {
      targetContract = inheritRef;
    }
  }

  const searchContracts: string[] = [];
  if (targetContract) {
    searchContracts.push(targetContract);
  } else {
    for (const contract of index.getInheritanceChain(containerName)) {
      if (contract.name !== containerName) {
        searchContracts.push(contract.name);
      }
    }
  }

  for (const contractName of searchContracts) {
    const hit = pickMemberSymbol(index, contractName, targetMember, sym);
    if (hit) return hit;
  }

  return null;
}

function pickMemberSymbol(
  index: SymbolIndex,
  contractName: string,
  memberName: string,
  context: SolSymbol,
): SolSymbol | null {
  const candidates = index
    .findSymbols(memberName)
    .filter(
      (s) =>
        s.containerName === contractName &&
        (s.kind === "function" ||
          s.kind === "modifier" ||
          s.kind === "event" ||
          s.kind === "error" ||
          s.kind === "stateVariable"),
    );

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  if (context.detail) {
    const exact = candidates.find((s) => s.detail === context.detail);
    if (exact) return exact;
  }
  return candidates[0];
}
