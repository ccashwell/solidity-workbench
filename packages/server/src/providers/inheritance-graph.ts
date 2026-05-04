import { URI } from "vscode-uri";
import type { GetInheritanceGraphParams, InheritanceGraphResult } from "@solidity-workbench/common";
import { SemanticResolver } from "../analyzer/semantic-resolver.js";
import type { SolidityParser } from "../parser/solidity-parser.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";

export class InheritanceGraphProvider {
  constructor(
    parser: SolidityParser,
    workspace: WorkspaceManager,
    private resolver: SemanticResolver = new SemanticResolver(parser, workspace),
  ) {}

  provideInheritanceGraph(params: GetInheritanceGraphParams): InheritanceGraphResult {
    const nodes = new Map<string, InheritanceGraphResult["nodes"][number]>();
    const edges: InheritanceGraphResult["edges"] = [];
    for (const entry of this.resolver.getAllContracts()) {
      nodes.set(entry.id, {
        id: entry.id,
        name: entry.contract.name,
        filePath: entry.filePath,
        uri: entry.uri,
        kind: entry.contract.kind,
        tier: entry.tier,
        range: entry.contract.range,
        selectionRange: entry.contract.nameRange,
      });
    }

    for (const entry of this.resolver.getAllContracts()) {
      for (const base of entry.contract.baseContracts) {
        const resolved = this.resolver.resolveBaseContract(entry.uri, base.baseName);
        const to = resolved?.id ?? this.resolver.externalContractId(base.baseName);
        if (!nodes.has(to)) {
          nodes.set(to, this.missingNode(base.baseName, to));
        }
        edges.push({ from: entry.id, to, baseName: base.baseName });
      }
    }

    return {
      focusId: this.resolveFocusId(params),
      nodes: Array.from(nodes.values()).sort((a, b) => a.name.localeCompare(b.name)),
      edges,
    };
  }

  private resolveFocusId(params: GetInheritanceGraphParams): string | undefined {
    if (!params.contractName) return undefined;
    const fromUri = params.contractPath ? URI.file(params.contractPath).toString() : undefined;
    return this.resolver.resolveContract(params.contractName, fromUri)?.id;
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
}
