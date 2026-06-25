import { URI } from "vscode-uri";
import type { GetInheritanceGraphParams, InheritanceGraphResult } from "@solidity-workbench/common";
import type { GraphIndex, SolidityGraphNode } from "../analyzer/graph-index.js";
import { SemanticResolver } from "../analyzer/semantic-resolver.js";
import type { SolidityParser } from "../parser/solidity-parser.js";
import type { ResolvedContract } from "../analyzer/semantic-resolver.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";

export class InheritanceGraphProvider {
  constructor(
    parser: SolidityParser,
    workspace: WorkspaceManager,
    private resolver: SemanticResolver = new SemanticResolver(parser, workspace),
    private graphIndex?: GraphIndex,
  ) {}

  provideInheritanceGraph(params: GetInheritanceGraphParams): InheritanceGraphResult {
    if (this.graphIndex) {
      return this.provideGraphIndexBackedGraph(params);
    }

    const nodes = new Map<string, InheritanceGraphResult["nodes"][number]>();
    const edges: InheritanceGraphResult["edges"] = [];
    for (const entry of this.resolver.getAllContracts()) {
      if (!this.includeResolvedContract(entry, params)) continue;
      nodes.set(entry.id, this.resolvedContractToResultNode(entry));
    }

    for (const entry of this.resolver.getAllContracts()) {
      if (!nodes.has(entry.id)) continue;
      for (const base of entry.contract.baseContracts) {
        const resolved = this.resolver.resolveBaseContract(entry.uri, base.baseName);
        if (resolved && !this.includeResolvedContract(resolved, params)) continue;
        const to = resolved?.id ?? this.resolver.externalContractId(base.baseName);
        if (!nodes.has(to)) {
          nodes.set(to, this.missingNode(base.baseName, to));
        }
        edges.push({ from: entry.id, to, baseName: base.baseName });
      }
    }

    const focusId = this.resolveFocusId(params);
    return {
      focusId: focusId && nodes.has(focusId) ? focusId : undefined,
      nodes: Array.from(nodes.values()).sort((a, b) => a.name.localeCompare(b.name)),
      edges,
    };
  }

  private resolveFocusId(params: GetInheritanceGraphParams): string | undefined {
    if (!params.contractName) return undefined;
    const fromUri = params.contractPath ? URI.file(params.contractPath).toString() : undefined;
    const resolved = this.resolver.resolveContract(params.contractName, fromUri);
    return resolved && this.includeResolvedContract(resolved, params) ? resolved.id : undefined;
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

  private provideGraphIndexBackedGraph(params: GetInheritanceGraphParams): InheritanceGraphResult {
    const nodes = new Map<string, InheritanceGraphResult["nodes"][number]>();
    const allNodes = new Map<string, SolidityGraphNode>();

    for (const node of this.graphIndex!.getContractNodes()) {
      allNodes.set(node.id, node);
      if (!this.includeTier(node.tier, params)) continue;
      nodes.set(node.id, this.graphNodeToResultNode(node));
    }

    const edges: InheritanceGraphResult["edges"] = [];
    for (const edge of this.graphIndex!.getEdges("inherits")) {
      const baseName = typeof edge.metadata?.baseName === "string" ? edge.metadata.baseName : "";
      const sourceNode = allNodes.get(edge.source);
      if (!sourceNode || !nodes.has(edge.source)) continue;
      const resolvedTarget = baseName
        ? this.resolver.resolveBaseContract(sourceNode.uri, baseName)
        : undefined;
      if (resolvedTarget && !this.includeResolvedContract(resolvedTarget, params)) continue;
      const targetId = resolvedTarget?.id ?? edge.target;
      const targetNode = allNodes.get(targetId);
      if (targetNode && !this.includeTier(targetNode.tier, params)) continue;
      if (resolvedTarget && !nodes.has(targetId)) {
        nodes.set(targetId, this.resolvedContractToResultNode(resolvedTarget));
      } else if (!nodes.has(targetId)) {
        nodes.set(targetId, this.missingNode(baseName || targetId, targetId));
      }
      edges.push({ from: edge.source, to: targetId, baseName });
    }

    const focusId = this.resolveFocusId(params);
    return {
      focusId: focusId && nodes.has(focusId) ? focusId : undefined,
      nodes: Array.from(nodes.values()).sort((a, b) => a.name.localeCompare(b.name)),
      edges,
    };
  }

  private graphNodeToResultNode(node: SolidityGraphNode): InheritanceGraphResult["nodes"][number] {
    return {
      id: node.id,
      name: node.name,
      filePath: node.filePath,
      uri: node.uri,
      kind: node.kind,
      tier: node.tier,
      range: node.range,
      selectionRange: node.selectionRange,
    };
  }

  private resolvedContractToResultNode(
    entry: ResolvedContract,
  ): InheritanceGraphResult["nodes"][number] {
    return {
      id: entry.id,
      name: entry.contract.name,
      filePath: entry.filePath,
      uri: entry.uri,
      kind: entry.contract.kind,
      tier: entry.tier,
      range: entry.contract.range,
      selectionRange: entry.contract.nameRange,
    };
  }

  private includeResolvedContract(
    entry: ResolvedContract,
    params: GetInheritanceGraphParams,
  ): boolean {
    return this.includeTier(entry.tier, params);
  }

  private includeTier(
    tier: InheritanceGraphResult["nodes"][number]["tier"],
    params: GetInheritanceGraphParams,
  ): boolean {
    if (tier === "tests" && params.includeTests !== true) return false;
    if (tier === "deps" && params.includeDependencies !== true) return false;
    return true;
  }
}
