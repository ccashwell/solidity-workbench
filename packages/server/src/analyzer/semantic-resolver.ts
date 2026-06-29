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

export interface VisibleSymbolFilterOptions {
  includeNamespaceImports?: boolean;
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
  private allContractsCache: ResolvedContract[] | null = null;
  private contractsByNameCache = new Map<string, ResolvedContract[]>();
  private contractsByIdCache = new Map<string, ResolvedContract>();
  private inheritanceChainCache = new Map<string, ResolvedContract[]>();
  private importedSymbolCache = new Map<string, { name: string; uri: string } | undefined>();

  constructor(
    private parser: SolidityParser,
    private workspace: WorkspaceManager,
    private symbolIndex?: SymbolIndex,
  ) {}

  invalidate(uri?: string): void {
    if (uri) this.reachableCache.delete(uri);
    else this.reachableCache.clear();
    this.allContractsCache = null;
    this.contractsByNameCache.clear();
    this.contractsByIdCache.clear();
    this.inheritanceChainCache.clear();
    this.importedSymbolCache.clear();
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
    if (this.allContractsCache) return this.allContractsCache.slice();

    const contracts: ResolvedContract[] = [];
    for (const uri of this.workspace.getAllFileUris()) {
      const result = this.parser.get(uri);
      if (!result) continue;
      for (const contract of result.sourceUnit.contracts) {
        contracts.push(this.toResolvedContract(uri, contract));
      }
    }
    this.allContractsCache = contracts;
    this.contractsByNameCache.clear();
    this.contractsByIdCache.clear();
    for (const entry of contracts) {
      const byName = this.contractsByNameCache.get(entry.contract.name) ?? [];
      byName.push(entry);
      this.contractsByNameCache.set(entry.contract.name, byName);
      this.contractsByIdCache.set(entry.id, entry);
    }
    return contracts.slice();
  }

  getContractsByName(name: string): ResolvedContract[] {
    if (!this.allContractsCache) this.getAllContracts();
    return (this.contractsByNameCache.get(name) ?? []).slice();
  }

  resolveContract(name: string, fromUri?: string): ResolvedContract | undefined {
    if (fromUri) {
      const imported = this.resolveImportedSymbol(name, fromUri);
      if (imported) {
        const exact = this.getAllContracts().find(
          (entry) => entry.uri === imported.uri && entry.contract.name === imported.name,
        );
        if (exact) return exact;
      }
    }

    const candidates = this.getContractsByName(name);
    if (candidates.length === 0) return undefined;

    if (fromUri) {
      const sameFile = candidates.find((entry) => entry.uri === fromUri);
      if (sameFile) return sameFile;

      const reachable = this.collectReachableUris(fromUri);
      const imported = candidates.find((entry) => reachable.has(entry.uri));
      if (imported) return imported;

      return undefined;
    }

    if (candidates.length === 1) return candidates[0];
    return candidates[0];
  }

  resolveContractById(id: string): ResolvedContract | undefined {
    if (!this.allContractsCache) this.getAllContracts();
    return this.contractsByIdCache.get(id);
  }

  resolveBaseContract(fromUri: string, baseName: string): ResolvedContract | undefined {
    return this.resolveContract(baseName, fromUri);
  }

  resolveImportedSymbol(name: string, fromUri: string): { name: string; uri: string } | undefined {
    const cacheKey = `${fromUri}\0${name}`;
    if (this.importedSymbolCache.has(cacheKey)) return this.importedSymbolCache.get(cacheKey);

    const result = this.parser.get(fromUri);
    if (!result) {
      this.importedSymbolCache.set(cacheKey, undefined);
      return undefined;
    }

    let fsPath: string;
    try {
      fsPath = this.workspace.uriToPath(fromUri);
    } catch {
      this.importedSymbolCache.set(cacheKey, undefined);
      return undefined;
    }

    const scoped = name.includes(".") ? name.split(".") : null;
    for (const imp of result.sourceUnit.imports) {
      let targetPath: string | null;
      try {
        targetPath = this.workspace.resolveImport(imp.path, fsPath);
      } catch {
        targetPath = null;
      }
      if (!targetPath) continue;
      const targetUri = URI.file(targetPath).toString();

      if (scoped && imp.unitAlias === scoped[0] && scoped[1]) {
        const resolved = { name: scoped[1], uri: targetUri };
        this.importedSymbolCache.set(cacheKey, resolved);
        return resolved;
      }

      if (scoped) continue;
      for (const alias of imp.symbolAliases ?? []) {
        const visibleName = alias.alias ?? alias.symbol;
        if (visibleName === name) {
          const resolved = { name: alias.symbol, uri: targetUri };
          this.importedSymbolCache.set(cacheKey, resolved);
          return resolved;
        }
      }

      const isPlainImport = !imp.unitAlias && (imp.symbolAliases ?? []).length === 0;
      if (isPlainImport) {
        const targetUnit = this.parser.get(targetUri)?.sourceUnit;
        if (
          targetUnit?.contracts.some((contract) => contract.name === name) ||
          targetUnit?.freeFunctions.some((fn) => fn.name === name) ||
          targetUnit?.events.some((event) => event.name === name) ||
          targetUnit?.errors.some((error) => error.name === name) ||
          targetUnit?.structs.some((struct) => struct.name === name) ||
          targetUnit?.enums.some((en) => en.name === name) ||
          targetUnit?.userDefinedValueTypes.some((udvt) => udvt.name === name) ||
          targetUnit?.fileConstants.some((constant) => constant.name === name)
        ) {
          const resolved = { name, uri: targetUri };
          this.importedSymbolCache.set(cacheKey, resolved);
          return resolved;
        }
      }
    }

    this.importedSymbolCache.set(cacheKey, undefined);
    return undefined;
  }

  getInheritanceChain(name: string, fromUri?: string): ResolvedContract[] {
    const root = this.resolveContract(name, fromUri);
    if (!root) return [];
    return this.getInheritanceChainFor(root);
  }

  getInheritanceChainFor(root: ResolvedContract): ResolvedContract[] {
    const cached = this.inheritanceChainCache.get(root.id);
    if (cached) return cached.slice();

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
    this.inheritanceChainCache.set(root.id, chain);
    return chain.slice();
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

  filterVisibleSymbols<T extends { filePath: string }>(
    currentUri: string,
    symbols: T[],
    options: VisibleSymbolFilterOptions = {},
  ): T[] {
    const reachable = this.collectReachableUris(currentUri);
    const includeNamespaceImports = options.includeNamespaceImports ?? true;
    return symbols.filter((sym) => {
      if (sym.filePath === currentUri) return true;
      if (!reachable.has(sym.filePath)) return false;

      const symbol = sym as T & { containerName?: string; name?: string };
      if (symbol.containerName || !symbol.name) return true;

      const imported = this.resolveImportedSymbol(symbol.name, currentUri);
      if (imported?.name === symbol.name && imported.uri === sym.filePath) return true;
      return (
        includeNamespaceImports &&
        this.hasNamespaceImportedTopLevelSymbol(currentUri, sym.filePath, symbol.name)
      );
    });
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

  private hasNamespaceImportedTopLevelSymbol(
    currentUri: string,
    symbolUri: string,
    symbolName: string,
  ): boolean {
    const result = this.parser.get(currentUri);
    if (!result) return false;

    let fsPath: string;
    try {
      fsPath = this.workspace.uriToPath(currentUri);
    } catch {
      return false;
    }

    for (const imp of result.sourceUnit.imports) {
      if (!imp.unitAlias) continue;

      let targetPath: string | null;
      try {
        targetPath = this.workspace.resolveImport(imp.path, fsPath);
      } catch {
        targetPath = null;
      }
      if (!targetPath) continue;
      const targetUri = URI.file(targetPath).toString();
      if (targetUri !== symbolUri) continue;

      const unit = this.parser.get(targetUri)?.sourceUnit;
      return (
        unit?.contracts.some((contract) => contract.name === symbolName) ||
        unit?.freeFunctions.some((fn) => fn.name === symbolName) ||
        unit?.events.some((event) => event.name === symbolName) ||
        unit?.errors.some((error) => error.name === symbolName) ||
        unit?.structs.some((struct) => struct.name === symbolName) ||
        unit?.enums.some((en) => en.name === symbolName) ||
        unit?.userDefinedValueTypes.some((udvt) => udvt.name === symbolName) ||
        unit?.fileConstants.some((constant) => constant.name === symbolName) ||
        false
      );
    }

    return false;
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
