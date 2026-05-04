import { URI } from "vscode-uri";
import type {
  ContractDefinition,
  SolSymbol,
  SourceRange,
  SymbolKind,
} from "@solidity-workbench/common";
import type { SolidityParser } from "../parser/solidity-parser.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";
import type { SymbolIndex } from "./symbol-index.js";

export interface ResolvedContract {
  id: string;
  uri: string;
  filePath: string;
  contract: ContractDefinition;
  tier: "project" | "tests" | "deps" | "unknown";
}

/**
 * Shared semantic resolver for parser-backed, import-aware lookups.
 *
 * `SymbolIndex` is intentionally fast and name-keyed, which is ideal
 * for workspace search but lossy when a Foundry workspace has the
 * same contract name in `src/`, `test/`, and `lib/`. This resolver
 * keeps the identity as `uri#contractName` and resolves inheritance
 * through the importing file's reachable graph before falling back to
 * global name matches.
 */
export class SemanticResolver {
  private reachableCache = new Map<string, Set<string>>();

  constructor(
    private parser: SolidityParser,
    private workspace: WorkspaceManager,
    private symbolIndex?: SymbolIndex,
  ) {}

  invalidate(uri?: string): void {
    if (uri) this.reachableCache.delete(uri);
    else this.reachableCache.clear();
  }

  contractId(uri: string, name: string): string {
    return `${uri}#${name}`;
  }

  externalContractId(name: string): string {
    return `external:${name}`;
  }

  uriFromContractId(id: string): string {
    const hash = id.lastIndexOf("#");
    return hash >= 0 ? id.slice(0, hash) : "";
  }

  getAllContracts(): ResolvedContract[] {
    const contracts: ResolvedContract[] = [];
    for (const uri of this.workspace.getAllFileUris()) {
      const result = this.parser.get(uri);
      if (!result) continue;
      for (const contract of result.sourceUnit.contracts) {
        contracts.push(this.toResolvedContract(uri, contract));
      }
    }
    return contracts;
  }

  getContractsByName(name: string): ResolvedContract[] {
    return this.getAllContracts().filter((entry) => entry.contract.name === name);
  }

  resolveContract(name: string, fromUri?: string): ResolvedContract | undefined {
    const candidates = this.getContractsByName(name);
    if (candidates.length === 0) return undefined;
    if (candidates.length === 1) return candidates[0];

    if (fromUri) {
      const sameFile = candidates.find((entry) => entry.uri === fromUri);
      if (sameFile) return sameFile;

      const reachable = this.collectReachableUris(fromUri);
      const imported = candidates.find((entry) => reachable.has(entry.uri));
      if (imported) return imported;

      const project = candidates.find((entry) => entry.tier === "project");
      if (project) return project;
    }

    return candidates[0];
  }

  resolveContractById(id: string): ResolvedContract | undefined {
    return this.getAllContracts().find((entry) => entry.id === id);
  }

  resolveBaseContract(fromUri: string, baseName: string): ResolvedContract | undefined {
    return this.resolveContract(baseName, fromUri);
  }

  getInheritanceChain(name: string, fromUri?: string): ResolvedContract[] {
    const root = this.resolveContract(name, fromUri);
    if (!root) return [];
    return this.getInheritanceChainFor(root);
  }

  getInheritanceChainFor(root: ResolvedContract): ResolvedContract[] {
    const chain: ResolvedContract[] = [];
    const visited = new Set<string>();

    const walk = (entry: ResolvedContract): void => {
      if (visited.has(entry.id)) return;
      visited.add(entry.id);
      chain.push(entry);

      for (const base of entry.contract.baseContracts) {
        const resolved = this.resolveBaseContract(entry.uri, base.baseName);
        if (resolved) walk(resolved);
      }
    };

    walk(root);
    return chain;
  }

  getSubtypes(target: ResolvedContract): ResolvedContract[] {
    const subtypes: ResolvedContract[] = [];
    for (const candidate of this.getAllContracts()) {
      for (const base of candidate.contract.baseContracts) {
        const resolved = this.resolveBaseContract(candidate.uri, base.baseName);
        if (resolved?.id === target.id) {
          subtypes.push(candidate);
          break;
        }
      }
    }
    return subtypes;
  }

  findMemberInInheritanceChain(
    receiverName: string,
    memberName: string,
    fromUri?: string,
  ): SolSymbol | null {
    for (const entry of this.getInheritanceChain(receiverName, fromUri)) {
      const sym = this.findMemberInContract(entry, memberName);
      if (sym) return sym;
    }
    return null;
  }

  findMemberInContract(entry: ResolvedContract, memberName: string): SolSymbol | null {
    const contract = entry.contract;

    for (const fn of contract.functions) {
      if (fn.name === memberName) {
        return this.symbolFromMember(memberName, "function", entry, fn.range, fn.nameRange);
      }
    }
    for (const mod of contract.modifiers) {
      if (mod.name === memberName) {
        return this.symbolFromMember(memberName, "modifier", entry, mod.range, mod.nameRange);
      }
    }
    for (const variable of contract.stateVariables) {
      if (variable.name === memberName) {
        return this.symbolFromMember(
          memberName,
          "stateVariable",
          entry,
          variable.range,
          variable.nameRange,
        );
      }
    }
    for (const event of contract.events) {
      if (event.name === memberName) {
        return this.symbolFromMember(memberName, "event", entry, event.range, event.nameRange);
      }
    }
    for (const error of contract.errors) {
      if (error.name === memberName) {
        return this.symbolFromMember(memberName, "error", entry, error.range, error.nameRange);
      }
    }
    for (const struct of contract.structs) {
      if (struct.name === memberName) {
        return this.symbolFromMember(memberName, "struct", entry, struct.range, struct.nameRange);
      }
    }
    for (const en of contract.enums) {
      if (en.name === memberName) {
        return this.symbolFromMember(memberName, "enum", entry, en.range, en.nameRange);
      }
    }

    return null;
  }

  filterVisibleSymbols<T extends { filePath: string }>(currentUri: string, symbols: T[]): T[] {
    const reachable = this.collectReachableUris(currentUri);
    return symbols.filter((sym) => reachable.has(sym.filePath));
  }

  collectReachableUris(uri: string): Set<string> {
    const cached = this.reachableCache.get(uri);
    if (cached) return new Set(cached);

    const visited = this.collectReachableUrisInner(uri, new Set());
    this.reachableCache.set(uri, new Set(visited));
    return visited;
  }

  private collectReachableUrisInner(uri: string, visited: Set<string>): Set<string> {
    if (visited.size === 0) {
      const cached = this.reachableCache.get(uri);
      if (cached) return new Set(cached);
    }

    if (visited.has(uri)) return visited;
    visited.add(uri);

    const result = this.parser.get(uri);
    if (!result) return visited;

    let fsPath: string;
    try {
      fsPath = this.workspace.uriToPath(uri);
    } catch {
      return visited;
    }

    for (const imp of result.sourceUnit.imports) {
      const targetPath = this.workspace.resolveImport(imp.path, fsPath);
      if (!targetPath) continue;
      this.collectReachableUrisInner(URI.file(targetPath).toString(), visited);
    }

    return visited;
  }

  stripTypeDecorations(typeName: string | undefined): string | undefined {
    if (!typeName) return undefined;
    return typeName
      .replace(/\s+(memory|storage|calldata|payable)\b/g, "")
      .replace(/\[[^\]]*\]/g, "")
      .trim()
      .split(/\s+/)[0];
  }

  private toResolvedContract(uri: string, contract: ContractDefinition): ResolvedContract {
    return {
      id: this.contractId(uri, contract.name),
      uri,
      filePath: this.safeUriToPath(uri),
      contract,
      tier: this.getFileTier(uri),
    };
  }

  private symbolFromMember(
    name: string,
    kind: SymbolKind,
    entry: ResolvedContract,
    range: SourceRange,
    nameRange: SourceRange,
  ): SolSymbol {
    const indexed = this.symbolIndex
      ?.findSymbols(name)
      .find(
        (sym) =>
          sym.filePath === entry.uri &&
          sym.containerName === entry.contract.name &&
          sym.kind === kind &&
          sym.nameRange.start.line === nameRange.start.line &&
          sym.nameRange.start.character === nameRange.start.character,
      );
    if (indexed) return indexed;

    return {
      name,
      kind,
      filePath: entry.uri,
      range,
      nameRange,
      containerName: entry.contract.name,
    };
  }

  private getFileTier(uri: string): ResolvedContract["tier"] {
    const getFileTier = (this.workspace as Partial<WorkspaceManager>).getFileTier;
    return getFileTier?.call(this.workspace, uri) ?? "unknown";
  }

  private safeUriToPath(uri: string): string {
    try {
      return this.workspace.uriToPath(uri);
    } catch {
      return "";
    }
  }
}
