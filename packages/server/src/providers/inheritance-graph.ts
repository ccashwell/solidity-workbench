import { URI } from "vscode-uri";
import type {
  ContractDefinition,
  GetInheritanceGraphParams,
  InheritanceGraphResult,
} from "@solidity-workbench/common";
import type { SolidityParser } from "../parser/solidity-parser.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";

export class InheritanceGraphProvider {
  constructor(
    private parser: SolidityParser,
    private workspace: WorkspaceManager,
  ) {}

  provideInheritanceGraph(params: GetInheritanceGraphParams): InheritanceGraphResult {
    const nodes = new Map<string, InheritanceGraphResult["nodes"][number]>();
    const edges: InheritanceGraphResult["edges"] = [];
    const contractsByName = new Map<string, string[]>();

    for (const uri of this.workspace.getAllFileUris()) {
      const result = this.parser.get(uri);
      if (!result) continue;

      for (const contract of result.sourceUnit.contracts) {
        const id = this.contractId(uri, contract.name);
        nodes.set(id, {
          id,
          name: contract.name,
          filePath: this.safeUriToPath(uri),
          uri,
          kind: contract.kind,
          tier: this.workspace.getFileTier(uri) ?? "unknown",
          range: contract.range,
          selectionRange: contract.nameRange,
        });

        const byName = contractsByName.get(contract.name) ?? [];
        byName.push(id);
        contractsByName.set(contract.name, byName);
      }
    }

    for (const uri of this.workspace.getAllFileUris()) {
      const result = this.parser.get(uri);
      if (!result) continue;

      for (const contract of result.sourceUnit.contracts) {
        const from = this.contractId(uri, contract.name);
        for (const base of contract.baseContracts) {
          const to =
            this.resolveBaseContract(uri, base.baseName, contractsByName) ??
            this.externalContractId(base.baseName);
          if (!nodes.has(to)) {
            nodes.set(to, this.missingNode(base.baseName, to));
          }
          edges.push({ from, to, baseName: base.baseName });
        }
      }
    }

    return {
      focusId: this.resolveFocusId(params, contractsByName),
      nodes: Array.from(nodes.values()).sort((a, b) => a.name.localeCompare(b.name)),
      edges,
    };
  }

  private resolveFocusId(
    params: GetInheritanceGraphParams,
    contractsByName: Map<string, string[]>,
  ): string | undefined {
    if (!params.contractName) return undefined;

    if (params.contractPath) {
      const uri = URI.file(params.contractPath).toString();
      const id = this.contractId(uri, params.contractName);
      if (contractsByName.get(params.contractName)?.includes(id)) return id;
    }

    return contractsByName.get(params.contractName)?.[0];
  }

  private resolveBaseContract(
    fromUri: string,
    baseName: string,
    contractsByName: Map<string, string[]>,
  ): string | undefined {
    const candidates = contractsByName.get(baseName) ?? [];
    if (candidates.length === 0) return undefined;
    if (candidates.length === 1) return candidates[0];

    const sameFile = candidates.find((id) => id.startsWith(`${fromUri}#`));
    if (sameFile) return sameFile;

    const reachable = this.collectReachableUris(fromUri);
    return candidates.find((id) => reachable.has(this.uriFromContractId(id))) ?? candidates[0];
  }

  private collectReachableUris(uri: string, visited: Set<string> = new Set()): Set<string> {
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
      this.collectReachableUris(URI.file(targetPath).toString(), visited);
    }

    return visited;
  }

  private missingNode(name: string, id: string): InheritanceGraphResult["nodes"][number] {
    return {
      id,
      name,
      filePath: "",
      uri: "",
      kind: "unknown",
      tier: "unknown",
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      missing: true,
    };
  }

  private contractId(uri: string, name: ContractDefinition["name"]): string {
    return `${uri}#${name}`;
  }

  private externalContractId(name: string): string {
    return `external:${name}`;
  }

  private uriFromContractId(id: string): string {
    const hash = id.lastIndexOf("#");
    return hash >= 0 ? id.slice(0, hash) : "";
  }

  private safeUriToPath(uri: string): string {
    try {
      return this.workspace.uriToPath(uri);
    } catch {
      return "";
    }
  }
}
