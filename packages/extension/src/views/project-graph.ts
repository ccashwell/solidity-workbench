import * as vscode from "vscode";
import * as crypto from "node:crypto";
import type { LanguageClient } from "vscode-languageclient/node";
import {
  GetProjectGraph,
  GetProjectGraphNeighborhood,
  GetProjectGraphPath,
  GetProjectGraphStats,
  QueryProjectGraph,
  RebuildProjectGraph,
  SearchProjectGraph,
  ServerStateNotification,
  type ProjectGraphEdge,
  type ProjectGraphEdgeQuality,
  type ProjectGraphEdgeKind,
  type ProjectGraphIndexStatus,
  type ProjectGraphNode,
  type ProjectGraphNodeKind,
  type ProjectGraphPathResult,
  type ProjectGraphQueryKind,
  type ProjectGraphQueryMissReason,
  type ProjectGraphQueryResult,
  type ProjectGraphResolutionConfidence,
  type ProjectGraphResult,
  type ProjectGraphSearchMatch,
  type ProjectGraphSearchResult,
  type ProjectGraphStatsResult,
  type ServerStateParams,
} from "@solidity-workbench/common";

const EDGE_KIND_ITEMS: { label: ProjectGraphEdgeKind; description: string }[] = [
  { label: "contains", description: "declaration containment" },
  { label: "imports", description: "file imports" },
  { label: "inherits", description: "contract inheritance" },
  { label: "implements", description: "interface implementation" },
  { label: "overrides", description: "base member overrides" },
  { label: "calls", description: "function and modifier calls" },
  { label: "externalCall", description: "receiver-typed external calls" },
  { label: "delegateCall", description: "low-level delegate calls" },
  { label: "creates", description: "contract creation expressions" },
  { label: "usesModifier", description: "modifier usage" },
  { label: "reads", description: "state reads" },
  { label: "writes", description: "state writes" },
  { label: "emits", description: "event emissions" },
  { label: "revertsWith", description: "custom error reverts" },
  { label: "usesType", description: "type references" },
];

type ProjectGraphExportFormat = "json" | "dot" | "graphml" | "codegraph-json";

const INTERACTIVE_GRAPH_NODE_LIMIT = 750;
export const PROJECT_GRAPH_DEFAULT_RENDERED_NODE_LIMIT = 240;
export const PROJECT_GRAPH_RENDER_NODE_LIMIT_STEP = 240;
export const PROJECT_GRAPH_MAX_RENDERED_NODE_LIMIT = 2400;
const RESOLUTION_CONFIDENCE_VALUES: ProjectGraphResolutionConfidence[] = [
  "solc",
  "parser",
  "heuristic",
  "unknown",
];

export type ProjectGraphNodeKindFilter = "all" | ProjectGraphNodeKind;

export const PROJECT_GRAPH_NODE_KIND_FILTER_ITEMS: readonly {
  label: string;
  value: ProjectGraphNodeKindFilter;
}[] = [
  { label: "All Node Kinds", value: "all" },
  { label: "Files", value: "file" },
  { label: "Contracts", value: "contract" },
  { label: "Interfaces", value: "interface" },
  { label: "Libraries", value: "library" },
  { label: "Functions", value: "function" },
  { label: "Constructors", value: "constructor" },
  { label: "Receive", value: "receive" },
  { label: "Fallback", value: "fallback" },
  { label: "Modifiers", value: "modifier" },
  { label: "Events", value: "event" },
  { label: "Errors", value: "error" },
  { label: "State Variables", value: "stateVariable" },
  { label: "File Constants", value: "fileConstant" },
  { label: "Structs", value: "struct" },
  { label: "Enums", value: "enum" },
  { label: "User-Defined Value Types", value: "userDefinedValueType" },
];

export function projectGraphNodeMatchesKindFilter(
  node: Pick<ProjectGraphNode, "kind">,
  filter: ProjectGraphNodeKindFilter,
): boolean {
  return filter === "all" || node.kind === filter;
}

export const PROJECT_GRAPH_CALLABLE_NODE_KINDS: ProjectGraphNodeKind[] = [
  "function",
  "constructor",
  "receive",
  "fallback",
  "modifier",
];

export const PROJECT_GRAPH_CALLER_TARGET_NODE_KINDS: ProjectGraphNodeKind[] = [
  ...PROJECT_GRAPH_CALLABLE_NODE_KINDS,
  "stateVariable",
];

export function projectGraphQueryTargetKinds(
  kind: ProjectGraphQueryKind,
): ProjectGraphNodeKind[] | undefined {
  if (kind === "impact") return undefined;
  return kind === "callers"
    ? PROJECT_GRAPH_CALLER_TARGET_NODE_KINDS
    : PROJECT_GRAPH_CALLABLE_NODE_KINDS;
}

export function projectGraphQueryMissLabel(
  kind: ProjectGraphQueryKind,
  reason?: ProjectGraphQueryMissReason,
): string {
  if (reason === "targetKindMismatch") {
    return kind === "impact"
      ? "No project graph query target found."
      : kind === "callers"
        ? "Project graph callers queries require a function, constructor, receive/fallback, modifier, or state-variable getter target."
        : "Project graph callees queries require a function, constructor, receive/fallback, or modifier target.";
  }
  return kind === "impact"
    ? "No project graph query target found."
    : kind === "callers"
      ? "No project graph callers target found."
      : "No callable project graph query target found.";
}

export function normalizeProjectGraphRenderedNodeLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return PROJECT_GRAPH_DEFAULT_RENDERED_NODE_LIMIT;
  }
  return Math.max(
    PROJECT_GRAPH_DEFAULT_RENDERED_NODE_LIMIT,
    Math.min(PROJECT_GRAPH_MAX_RENDERED_NODE_LIMIT, value),
  );
}

export function expandProjectGraphRenderedNodeLimit(current: number): number {
  return Math.min(
    PROJECT_GRAPH_MAX_RENDERED_NODE_LIMIT,
    normalizeProjectGraphRenderedNodeLimit(current) + PROJECT_GRAPH_RENDER_NODE_LIMIT_STEP,
  );
}

export interface ProjectGraphRenderedNodeState {
  ids: string[];
  candidateCount: number;
  hiddenCount: number;
}

export function projectGraphRenderedNodeState(
  nodeIds: string[],
  renderedNodeLimit: number,
): ProjectGraphRenderedNodeState {
  const limit = normalizeProjectGraphRenderedNodeLimit(renderedNodeLimit);
  const ids = nodeIds.slice(0, limit);
  return {
    ids,
    candidateCount: nodeIds.length,
    hiddenCount: Math.max(0, nodeIds.length - ids.length),
  };
}

export interface ProjectGraphShowMoreControlState {
  hidden: boolean;
  disabled: boolean;
  text: string;
  title: string;
}

export function projectGraphShowMoreControlState(
  hiddenCount: number,
  renderedNodeLimit: number,
): ProjectGraphShowMoreControlState {
  const hidden = hiddenCount <= 0;
  const disabled =
    !hidden &&
    normalizeProjectGraphRenderedNodeLimit(renderedNodeLimit) >=
      PROJECT_GRAPH_MAX_RENDERED_NODE_LIMIT;
  const increment = Math.min(PROJECT_GRAPH_RENDER_NODE_LIMIT_STEP, Math.max(0, hiddenCount));
  return {
    hidden,
    disabled,
    text: disabled ? "Max" : "More +" + increment,
    title: disabled
      ? "Maximum rendered node limit reached; narrow the graph with filters"
      : "Render " + increment + " more hidden graph nodes",
  };
}

interface ExportGraphNode {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  uri: string;
  filePath: string;
  tier: string;
  containerId?: string;
  containerName?: string;
  detail?: string;
  metadata?: ProjectGraphNode["metadata"];
  range?: ProjectGraphNode["range"];
  selectionRange?: ProjectGraphNode["selectionRange"];
}

export interface ProjectGraphRelationshipStatus {
  state: "unknown" | "complete" | "partial";
  label: string;
  detail: string;
  indexed?: number;
  total?: number;
  pending?: number;
}

export interface ProjectGraphCompilerStatusSummary {
  state: "unknown" | "ready" | "stale" | "parserOnly";
  label: string;
  detail: string;
  staleFileCount?: number;
}

export interface ProjectGraphEdgeQualityStatus {
  label: string;
  detail: string;
  counts: Partial<Record<ProjectGraphResolutionConfidence, number>>;
  unresolved: number;
}

export interface ProjectGraphResultDiagnostics {
  state: "ok" | "partial" | "warning";
  label: string;
  detail: string;
}

const EXPORT_FORMAT_ITEMS: {
  label: string;
  description: string;
  format: ProjectGraphExportFormat;
}[] = [
  { label: "JSON", description: "Solidity Workbench graph payload", format: "json" },
  { label: "DOT", description: "Graphviz directed graph", format: "dot" },
  { label: "GraphML", description: "Generic graph-tool interchange", format: "graphml" },
  {
    label: "CodeGraph JSON",
    description: "Agent-oriented nodes and edges JSON",
    format: "codegraph-json",
  },
];

export function serializeProjectGraphForExport(
  graph: ProjectGraphResult,
  format: ProjectGraphExportFormat,
  stats?: ProjectGraphStatsResult,
): { language: string; content: string } {
  switch (format) {
    case "dot":
      return { language: "dot", content: projectGraphToDot(graph) };
    case "graphml":
      return { language: "xml", content: projectGraphToGraphMl(graph) };
    case "codegraph-json":
      return {
        language: "json",
        content: JSON.stringify(projectGraphToCodeGraphJson(graph, stats), null, 2),
      };
    case "json":
    default:
      return {
        language: "json",
        content: JSON.stringify(projectGraphToJson(graph, stats), null, 2),
      };
  }
}

export function summarizeProjectGraphRelationshipStatus(
  stats?: ProjectGraphStatsResult,
): ProjectGraphRelationshipStatus {
  if (!stats || stats.relationshipIndexComplete === undefined) {
    return {
      state: "unknown",
      label: "relationship status unknown",
      detail: "Relationship indexing status was not included with this graph payload.",
    };
  }

  const indexed = stats.relationshipFilesIndexed ?? 0;
  const total = stats.relationshipFilesTotal ?? 0;
  const pending = stats.pendingRelationshipFiles ?? Math.max(0, total - indexed);
  if (stats.relationshipIndexComplete) {
    return {
      state: "complete",
      label: "edges ready",
      detail: "All discovered Solidity files have relationship edges indexed.",
      indexed,
      total,
      pending: 0,
    };
  }

  return {
    state: "partial",
    label: total > 0 ? `indexing edges ${indexed}/${total}` : "indexing edges",
    detail:
      "Relationship edges are still indexing. Focused neighborhoods are available, but full-workspace edges may be partial until indexing completes or the graph is rebuilt.",
    indexed,
    total,
    pending,
  };
}

export function summarizeProjectGraphCompilerStatus(
  stats?: ProjectGraphStatsResult,
): ProjectGraphCompilerStatusSummary {
  const status = stats?.compilerStatus;
  if (!status) {
    return {
      state: "unknown",
      label: "compiler status unknown",
      detail: "Compiler AST cache status was not included with this graph payload.",
    };
  }
  if (!status.available) {
    return {
      state: "parserOnly",
      label: "parser-only graph",
      detail:
        "No compiler AST cache is available yet. Save or build the project to enable compiler-backed resolution.",
    };
  }
  if (status.stale) {
    const count = status.staleFileCount ?? status.staleFiles?.length ?? 0;
    return {
      state: "stale",
      label: count > 0 ? `compiler stale ${count}` : "compiler stale",
      detail:
        "Compiler AST cache is stale for one or more files. Save or rebuild to refresh compiler-backed graph resolution.",
      staleFileCount: count,
    };
  }
  return {
    state: "ready",
    label: "compiler ready",
    detail: "Compiler AST cache matches the cached source fingerprints.",
    staleFileCount: 0,
  };
}

export function summarizeProjectGraphEdgeQuality(
  stats?: ProjectGraphStatsResult,
): ProjectGraphEdgeQualityStatus {
  const counts = stats?.edgesByResolutionConfidence ?? {};
  const unresolved = stats?.unresolvedEdgeCount ?? 0;
  const solc = counts.solc ?? 0;
  const parser = counts.parser ?? 0;
  const heuristic = counts.heuristic ?? 0;
  const unknown = counts.unknown ?? 0;
  const known = solc + parser + heuristic + unknown;
  const label = known > 0 ? `edge quality ${solc}/${known} solc` : "edge quality unknown";
  const detail =
    `solc=${solc}, parser=${parser}, heuristic=${heuristic}, unknown=${unknown}` +
    (unresolved > 0 ? `, unresolved=${unresolved}` : ", unresolved=0");
  return { label, detail, counts, unresolved };
}

export function summarizeProjectGraphResultDiagnostics(result?: {
  indexStatus?: ProjectGraphIndexStatus;
  edgeQuality?: ProjectGraphEdgeQuality;
  truncated?: boolean;
}): ProjectGraphResultDiagnostics | undefined {
  if (!result) return undefined;
  const details: string[] = [];
  let state: ProjectGraphResultDiagnostics["state"] = "ok";

  if (result.truncated) {
    state = "partial";
    details.push("Result was truncated by the interactive node cap.");
  }

  const status = result.indexStatus;
  if (status?.partial) {
    state = "partial";
    const indexed = status.relationshipFilesIndexed ?? 0;
    const total = status.relationshipFilesTotal ?? 0;
    const pending = status.pendingRelationshipFiles ?? Math.max(0, total - indexed);
    const progress =
      total > 0
        ? `${indexed}/${total} relationship files indexed${pending > 0 ? `, ${pending} pending` : ""}`
        : "relationship indexing is incomplete";
    details.push(`Result may be incomplete: ${progress}.`);
  }

  const lowConfidence = result.edgeQuality?.lowConfidenceEdgeCount ?? 0;
  const unresolved = result.edgeQuality?.unresolvedEdgeCount ?? 0;
  if (lowConfidence > 0) {
    if (state === "ok") state = "warning";
    const lowConfidenceEdges = `${lowConfidence} low-confidence ${lowConfidence === 1 ? "edge" : "edges"}`;
    details.push(
      unresolved > 0
        ? `${lowConfidenceEdges}, including ${unresolved} unresolved ${unresolved === 1 ? "target" : "targets"}.`
        : `${lowConfidenceEdges} ${lowConfidence === 1 ? "needs" : "need"} verification.`,
    );
  } else if (unresolved > 0) {
    if (state === "ok") state = "warning";
    details.push(
      `${unresolved} unresolved edge ${unresolved === 1 ? "target needs" : "targets need"} verification.`,
    );
  }

  if (details.length === 0) return undefined;
  return {
    state,
    label: state === "partial" ? "Partial graph result" : "Graph result needs review",
    detail: details.join(" "),
  };
}

function projectGraphToJson(graph: ProjectGraphResult, stats?: ProjectGraphStatsResult): unknown {
  const nodes = exportGraphNodes(graph);
  return {
    ...graph,
    stats,
    relationshipStatus: summarizeProjectGraphRelationshipStatus(stats),
    compilerStatus: summarizeProjectGraphCompilerStatus(stats),
    edgeQuality: summarizeProjectGraphEdgeQuality(stats),
    nodes: nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      name: node.name,
      qualifiedName: node.qualifiedName,
      uri: node.uri,
      filePath: node.filePath,
      tier: node.tier,
      range: node.range ?? zeroRange(),
      selectionRange: node.selectionRange ?? zeroRange(),
      containerId: node.containerId,
      containerName: node.containerName,
      detail: node.detail,
      metadata: node.metadata,
    })),
  };
}

function projectGraphToDot(graph: ProjectGraphResult): string {
  const nodes = exportGraphNodes(graph);
  const lines = [
    "digraph SolidityProjectGraph {",
    "  graph [rankdir=LR];",
    '  node [shape=box, style="rounded,filled", fillcolor="#1f2937", fontcolor="#f9fafb"];',
    '  edge [color="#6b7280", fontcolor="#374151"];',
  ];
  for (const node of nodes) {
    const label = `${node.qualifiedName}\\n${node.kind}`;
    lines.push(
      `  ${dotId(node.id)} [label=${dotString(label)}, tooltip=${dotString(node.filePath)}];`,
    );
  }
  for (const edge of graph.edges) {
    lines.push(`  ${dotId(edge.source)} -> ${dotId(edge.target)} [label=${dotString(edge.kind)}];`);
  }
  lines.push("}");
  return lines.join("\n");
}

function projectGraphToGraphMl(graph: ProjectGraphResult): string {
  const nodes = exportGraphNodes(graph);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<graphml xmlns="http://graphml.graphdrawing.org/xmlns">',
    '  <key id="kind" for="all" attr.name="kind" attr.type="string"/>',
    '  <key id="name" for="node" attr.name="name" attr.type="string"/>',
    '  <key id="qualifiedName" for="node" attr.name="qualifiedName" attr.type="string"/>',
    '  <key id="filePath" for="node" attr.name="filePath" attr.type="string"/>',
    '  <key id="tier" for="node" attr.name="tier" attr.type="string"/>',
    '  <key id="metadata" for="all" attr.name="metadata" attr.type="string"/>',
    '  <graph id="SolidityProjectGraph" edgedefault="directed">',
  ];
  for (const node of nodes) {
    lines.push(`    <node id=${xmlAttr(node.id)}>`);
    lines.push(`      <data key="kind">${xmlText(node.kind)}</data>`);
    lines.push(`      <data key="name">${xmlText(node.name)}</data>`);
    lines.push(`      <data key="qualifiedName">${xmlText(node.qualifiedName)}</data>`);
    lines.push(`      <data key="filePath">${xmlText(node.filePath)}</data>`);
    lines.push(`      <data key="tier">${xmlText(node.tier)}</data>`);
    if (node.metadata && Object.keys(node.metadata).length > 0) {
      lines.push(`      <data key="metadata">${xmlText(JSON.stringify(node.metadata))}</data>`);
    }
    lines.push("    </node>");
  }
  graph.edges.forEach((edge, index) => {
    lines.push(
      `    <edge id=${xmlAttr(`e${index}`)} source=${xmlAttr(edge.source)} target=${xmlAttr(edge.target)}>`,
    );
    lines.push(`      <data key="kind">${xmlText(edge.kind)}</data>`);
    if (edge.metadata && Object.keys(edge.metadata).length > 0) {
      lines.push(`      <data key="metadata">${xmlText(JSON.stringify(edge.metadata))}</data>`);
    }
    lines.push("    </edge>");
  });
  lines.push("  </graph>", "</graphml>");
  return lines.join("\n");
}

function projectGraphToCodeGraphJson(
  graph: ProjectGraphResult,
  stats?: ProjectGraphStatsResult,
): unknown {
  const nodes = exportGraphNodes(graph).map((node) => ({
    id: node.id,
    kind: node.kind,
    name: node.name,
    qualifiedName: node.qualifiedName,
    path: node.filePath,
    uri: node.uri,
    tier: node.tier,
    containerId: node.containerId,
    containerName: node.containerName,
    detail: node.detail,
    metadata: node.metadata,
    range: node.range,
    selectionRange: node.selectionRange,
    line: node.selectionRange ? node.selectionRange.start.line + 1 : undefined,
    column: node.selectionRange ? node.selectionRange.start.character + 1 : undefined,
  }));
  const edges = graph.edges.map((edge) => codeGraphEdge(edge));
  return {
    schema: "solidity-workbench-codegraph-export",
    version: 1,
    generator: "solidity-workbench",
    graph: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      focusId: graph.focusId,
      truncated: graph.truncated,
      relationshipIndexComplete: stats?.relationshipIndexComplete,
      relationshipFilesIndexed: stats?.relationshipFilesIndexed,
      relationshipFilesTotal: stats?.relationshipFilesTotal,
      pendingRelationshipFiles: stats?.pendingRelationshipFiles,
      relationshipStatus: summarizeProjectGraphRelationshipStatus(stats),
      compilerStatus: stats?.compilerStatus,
      compilerStatusSummary: summarizeProjectGraphCompilerStatus(stats),
      edgeQuality: summarizeProjectGraphEdgeQuality(stats),
      performance: stats?.performance,
    },
    nodes,
    edges,
  };
}

function exportGraphNodes(graph: ProjectGraphResult): ExportGraphNode[] {
  const nodes = new Map<string, ExportGraphNode>(
    graph.nodes.map((node) => [
      node.id,
      {
        id: node.id,
        kind: node.kind,
        name: node.name,
        qualifiedName: node.qualifiedName,
        uri: node.uri,
        filePath: node.filePath,
        tier: node.tier,
        containerId: node.containerId,
        containerName: node.containerName,
        detail: node.detail,
        metadata: node.metadata,
        range: node.range,
        selectionRange: node.selectionRange,
      },
    ]),
  );
  for (const edge of graph.edges) {
    if (!nodes.has(edge.source)) nodes.set(edge.source, syntheticExportNode(edge.source));
    if (!nodes.has(edge.target)) nodes.set(edge.target, syntheticExportNode(edge.target));
  }
  return Array.from(nodes.values());
}

function syntheticExportNode(id: string): ExportGraphNode {
  const name = id.startsWith("external:") ? id.slice("external:".length) : id;
  return {
    id,
    kind: "external",
    name,
    qualifiedName: name,
    uri: "",
    filePath: "",
    tier: "unknown",
  };
}

function zeroRange(): ProjectGraphNode["range"] {
  return {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 0 },
  };
}

function codeGraphEdge(edge: ProjectGraphEdge): unknown {
  return {
    source: edge.source,
    target: edge.target,
    kind: edge.kind,
    range: edge.range,
    resolutionConfidence: edge.resolutionConfidence,
    unresolvedTarget: edge.unresolvedTarget,
    evidence: edge.evidence,
    metadata: edge.metadata,
    provenance: "solidity-workbench",
  };
}

function dotId(value: string): string {
  return dotString(value);
}

function dotString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function xmlAttr(value: string): string {
  return `"${xmlText(value)}"`;
}

function xmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export class ProjectGraphExporter {
  constructor(private client: LanguageClient) {}

  activate(context: vscode.ExtensionContext): void {
    this.context = context;
    this.rememberActiveSolidityPosition();
    context.subscriptions.push(
      this.client.onNotification(ServerStateNotification, (state: ServerStateParams) => {
        void this.applyServerStateToProjectGraph(state);
      }),
      vscode.commands.registerCommand("solidity-workbench.projectGraph", () =>
        this.showProjectGraph(),
      ),
      vscode.commands.registerCommand("solidity-workbench.projectGraphCursor", () =>
        this.showProjectGraph({ cursorNeighborhood: true }),
      ),
      vscode.commands.registerCommand("solidity-workbench.exportProjectGraph", () =>
        this.exportProjectGraph(),
      ),
      vscode.commands.registerCommand("solidity-workbench.searchProjectGraph", () =>
        this.searchProjectGraph(),
      ),
      vscode.commands.registerCommand("solidity-workbench.queryProjectGraph", () =>
        this.queryProjectGraph(),
      ),
      vscode.commands.registerCommand("solidity-workbench.projectGraphStats", () =>
        this.showProjectGraphStats(),
      ),
      vscode.commands.registerCommand("solidity-workbench.rebuildProjectGraph", () =>
        this.rebuildProjectGraph(),
      ),
      vscode.commands.registerCommand("solidity-workbench.clearProjectGraphCache", () =>
        this.clearProjectGraphCache(),
      ),
      vscode.window.onDidChangeActiveTextEditor(() => this.rememberActiveSolidityPosition()),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor.document.languageId === "solidity") {
          this.lastSolidityPosition = {
            uri: event.textEditor.document.uri,
            position: event.selections[0]?.active ?? event.textEditor.selection.active,
          };
        }
      }),
    );
  }

  private panel: vscode.WebviewPanel | undefined;
  private context: vscode.ExtensionContext | undefined;
  private lastSolidityPosition: { uri: vscode.Uri; position: vscode.Position } | undefined;
  private projectGraphIndexingVisible = false;

  private async showProjectGraph(options: { cursorNeighborhood?: boolean } = {}): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showWarningMessage("Open a workspace first.");
      return;
    }

    const focused = this.activeSolidityPosition();
    let graph = focused
      ? await this.client.sendRequest<ProjectGraphResult>(GetProjectGraphNeighborhood, {
          uri: focused.uri.toString(),
          position: focused.position,
          depth: 2,
          edgeKinds: [
            "imports",
            "inherits",
            "implements",
            "overrides",
            "calls",
            "externalCall",
            "delegateCall",
            "creates",
            "usesModifier",
            "usesType",
          ],
          direction: "both",
          maxNodes: 240,
        })
      : undefined;
    if (!graph || graph.nodes.length === 0) {
      graph = await this.client.sendRequest<ProjectGraphResult>(GetProjectGraph, {
        maxNodes: INTERACTIVE_GRAPH_NODE_LIMIT,
      });
    }
    if (graph.nodes.length === 0) {
      vscode.window.showInformationMessage("No Solidity graph data found in the workspace.");
      return;
    }
    const graphStats = await this.getProjectGraphStats();

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
    } else {
      this.panel = vscode.window.createWebviewPanel(
        "solidity-workbench-project-graph",
        "Project Graph",
        vscode.ViewColumn.Beside,
        { enableScripts: true },
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.projectGraphIndexingVisible = false;
      });
      this.panel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.type === "navigate" && typeof msg.uri === "string") {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(msg.uri));
          const range = msg.selectionRange;
          const selection =
            range && typeof range.start?.line === "number"
              ? new vscode.Selection(
                  range.start.line,
                  range.start.character,
                  range.end.line,
                  range.end.character,
                )
              : undefined;
          await vscode.window.showTextDocument(doc, { preview: true, selection });
          return;
        }

        if (msg.type === "loadWorkspace") {
          const fullGraph = await this.client.sendRequest<ProjectGraphResult>(GetProjectGraph, {
            maxNodes: INTERACTIVE_GRAPH_NODE_LIMIT,
          });
          const stats = await this.getProjectGraphStats();
          if (this.panel) {
            await this.panel.webview.postMessage({
              type: "setGraph",
              graph: fullGraph,
              stats,
              focusId: this.findActiveNodeHint(fullGraph),
              scope: "all",
            });
          }
          return;
        }

        if (msg.type === "loadCursor") {
          await this.postCursorNeighborhood();
          return;
        }

        if (msg.type === "searchGraph" && typeof msg.query === "string") {
          const query = msg.query.trim();
          if (!query) {
            await this.postProjectGraphStatus("Enter a symbol query first.");
            return;
          }
          const result = await this.client.sendRequest<ProjectGraphSearchResult>(
            SearchProjectGraph,
            {
              query,
              includeEdges: true,
              edgeDirection: "both",
              maxResults: 80,
              maxEdgesPerNode: 24,
            },
          );
          if (result.matches.length === 0) {
            await this.postProjectGraphStatus(`No project graph matches for '${query}'.`);
            return;
          }
          const stats = await this.getProjectGraphStats();
          const searchGraph = this.searchResultToProjectGraph(result);
          if (this.panel) {
            await this.panel.webview.postMessage({
              type: "setGraph",
              graph: searchGraph,
              stats,
              focusId: searchGraph.focusId,
              scope: "all",
              status: this.graphResultStatus(result, `Search: ${query}`),
              resultDiagnostics: summarizeProjectGraphResultDiagnostics(result),
              clearQuery: true,
            });
          }
          return;
        }

        if (msg.type === "queryGraph" && typeof msg.kind === "string") {
          const kind = this.parseProjectGraphQueryKind(msg.kind);
          if (!kind) {
            await this.postProjectGraphStatus("Choose a supported graph query.");
            return;
          }
          const query = typeof msg.query === "string" ? msg.query.trim() : "";
          const target =
            typeof msg.targetId === "string" && msg.targetId ? { nodeId: msg.targetId } : undefined;
          if (!target && !query) {
            await this.postProjectGraphStatus("Select a graph node or enter a symbol query first.");
            return;
          }
          const result = await this.client.sendRequest<ProjectGraphQueryResult>(QueryProjectGraph, {
            kind,
            target,
            query: target ? undefined : query,
            targetKinds: projectGraphQueryTargetKinds(kind),
            maxNodes: 240,
          });
          if (!result.found) {
            await this.postProjectGraphStatus(projectGraphQueryMissLabel(kind, result.missReason));
            return;
          }
          const stats = await this.getProjectGraphStats();
          if (this.panel) {
            await this.panel.webview.postMessage({
              type: "setGraph",
              graph: result,
              stats,
              focusId: result.targetId ?? result.focusId,
              scope: "all",
              status: this.graphResultStatus(result, this.graphQueryLabel(kind)),
              resultDiagnostics: summarizeProjectGraphResultDiagnostics(result),
              clearQuery: true,
            });
          }
          return;
        }

        if (msg.type === "rebuild") {
          await this.rebuildProjectGraph();
          return;
        }

        if (msg.type === "clearCache") {
          await this.clearProjectGraphCache();
          return;
        }

        if (
          msg.type === "findPath" &&
          typeof msg.fromId === "string" &&
          typeof msg.toId === "string"
        ) {
          const edgeKinds = Array.isArray(msg.edgeKinds)
            ? msg.edgeKinds.filter(
                (kind: unknown): kind is ProjectGraphEdgeKind =>
                  typeof kind === "string" && EDGE_KIND_ITEMS.some((item) => item.label === kind),
              )
            : undefined;
          const pathGraph = await this.client.sendRequest<ProjectGraphPathResult>(
            GetProjectGraphPath,
            {
              from: { nodeId: msg.fromId },
              to: { nodeId: msg.toId },
              direction: "both",
              edgeKinds,
              maxDepth: 16,
            },
          );
          if (!pathGraph.found) {
            if (this.panel) {
              await this.panel.webview.postMessage({
                type: "status",
                message: "No project graph path found.",
              });
            }
            return;
          }
          if (this.panel) {
            const stats = await this.getProjectGraphStats();
            await this.panel.webview.postMessage({
              type: "setGraph",
              graph: pathGraph,
              stats,
              focusId: pathGraph.focusId,
              scope: "all",
              resultDiagnostics: summarizeProjectGraphResultDiagnostics(pathGraph),
            });
          }
        }
      });
    }

    this.panel.webview.html = this.buildHtml(
      graph,
      graph.focusId ?? this.findActiveNodeHint(graph),
      graphStats,
    );

    if (options.cursorNeighborhood && focused) {
      await this.postCursorNeighborhood();
    }
  }

  private async exportProjectGraph(): Promise<void> {
    const format = await vscode.window.showQuickPick(EXPORT_FORMAT_ITEMS, {
      title: "Export Solidity Project Graph",
      placeHolder: "Choose an export format",
    });
    if (!format) return;

    const selected = await vscode.window.showQuickPick(
      [{ label: "all", description: "all graph edges" }, ...EDGE_KIND_ITEMS],
      {
        title: "Export Solidity Project Graph",
        placeHolder: "Choose edge kinds to include",
        canPickMany: true,
      },
    );
    if (!selected) return;

    const includeAll = selected.length === 0 || selected.some((item) => item.label === "all");
    const edgeKinds = includeAll
      ? undefined
      : selected
          .map((item) => item.label)
          .filter((label): label is ProjectGraphEdgeKind => label !== "all");

    const [graph, stats] = await Promise.all([
      this.client.sendRequest<ProjectGraphResult>(GetProjectGraph, {
        edgeKinds,
      }),
      this.getProjectGraphStats(),
    ]);
    const serialized = serializeProjectGraphForExport(graph, format.format, stats);
    const doc = await vscode.workspace.openTextDocument({
      language: serialized.language,
      content: serialized.content,
    });
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  private async searchProjectGraph(): Promise<void> {
    const query = await vscode.window.showInputBox({
      title: "Search Solidity Project Graph",
      placeHolder: "Contract, function, event, error, file, or qualified name",
      prompt: "Search indexed Solidity declarations.",
    });
    if (!query?.trim()) return;

    const result = await this.client.sendRequest<ProjectGraphSearchResult>(SearchProjectGraph, {
      query,
      includeEdges: true,
      edgeDirection: "both",
      maxResults: 80,
      maxEdgesPerNode: 12,
    });
    if (result.matches.length === 0) {
      vscode.window.showInformationMessage(`No project graph matches for '${query}'.`);
      return;
    }

    const selected = await vscode.window.showQuickPick(
      result.matches.map((match) => this.toGraphSearchQuickPick(match, result)),
      {
        title: result.truncated
          ? `Search Solidity Project Graph (first 80 matches${this.graphResultTitleSuffix(result)})`
          : `Search Solidity Project Graph${this.graphResultTitleSuffix(result)}`,
        placeHolder: "Select a declaration to open",
        matchOnDescription: true,
        matchOnDetail: true,
      },
    );
    if (!selected) return;
    await this.openProjectGraphNode(selected.match.node);
  }

  private async queryProjectGraph(): Promise<void> {
    const pickedKind = await vscode.window.showQuickPick(
      [
        { label: "Callers", description: "Incoming call-like edges", queryKind: "callers" },
        { label: "Callees", description: "Outgoing call-like edges", queryKind: "callees" },
        { label: "Impact", description: "Incoming dependency radius", queryKind: "impact" },
      ] satisfies (vscode.QuickPickItem & { queryKind: ProjectGraphQueryKind })[],
      {
        title: "Query Solidity Project Graph",
        placeHolder: "Choose the graph query",
      },
    );
    if (!pickedKind) return;

    const focused = this.activeSolidityPosition();
    const useCursor = focused
      ? await vscode.window.showQuickPick(
          [
            { label: "Cursor Symbol", description: "Use active Solidity cursor", value: true },
            { label: "Search Query", description: "Type a graph symbol query", value: false },
          ],
          {
            title: "Query Solidity Project Graph",
            placeHolder: "Choose query target",
          },
        )
      : undefined;
    if (focused && !useCursor) return;

    const textQuery =
      !focused || useCursor?.value === false
        ? await vscode.window.showInputBox({
            title: "Query Solidity Project Graph",
            placeHolder: "Contract.function, function, event, error, or type name",
            prompt: "The best ranked project graph match will be queried.",
          })
        : undefined;
    if (!focused && !textQuery?.trim()) return;

    const result = await this.client.sendRequest<ProjectGraphQueryResult>(QueryProjectGraph, {
      kind: pickedKind.queryKind,
      target:
        focused && useCursor?.value !== false
          ? { uri: focused.uri.toString(), position: focused.position }
          : undefined,
      query: textQuery,
      targetKinds: projectGraphQueryTargetKinds(pickedKind.queryKind),
      maxNodes: 120,
    });

    if (!result.found) {
      vscode.window.showInformationMessage(
        projectGraphQueryMissLabel(pickedKind.queryKind, result.missReason),
      );
      return;
    }

    const selectableNodes = this.queryResultNodes(result);
    if (selectableNodes.length === 0) {
      vscode.window.showInformationMessage(`No ${pickedKind.label.toLowerCase()} found.`);
      return;
    }

    const selected = await vscode.window.showQuickPick(
      selectableNodes.map((node) => ({
        label: node.qualifiedName,
        description: `${node.kind} · ${node.tier}`,
        detail: [node.filePath, this.graphResultDetail(result)].filter(Boolean).join(" · "),
        node,
      })),
      {
        title: result.truncated
          ? `${pickedKind.label} (truncated${this.graphResultTitleSuffix(result)})`
          : `${pickedKind.label} for project graph target${this.graphResultTitleSuffix(result)}`,
        placeHolder: "Select a declaration to open",
        matchOnDescription: true,
        matchOnDetail: true,
      },
    );
    if (!selected) return;
    await this.openProjectGraphNode(selected.node);
  }

  private async showProjectGraphStats(): Promise<void> {
    const startedAt = Date.now();
    const stats = await this.getProjectGraphStats();
    const requestDurationMs = Date.now() - startedAt;
    const doc = await vscode.workspace.openTextDocument({
      language: "json",
      content: JSON.stringify({ ...stats, requestDurationMs }, null, 2),
    });
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  private toGraphSearchQuickPick(
    match: ProjectGraphSearchMatch,
    result: ProjectGraphSearchResult,
  ): vscode.QuickPickItem & { match: ProjectGraphSearchMatch } {
    const edgeCount = match.edges?.length ?? 0;
    const edgeLabel = match.edgesTruncated ? `${edgeCount}+ edges` : `${edgeCount} edges`;
    return {
      label: match.node.qualifiedName,
      description: `${match.node.kind} · ${match.node.tier}`,
      detail: [match.node.filePath, edgeCount > 0 ? edgeLabel : "", this.graphResultDetail(result)]
        .filter(Boolean)
        .join(" · "),
      match,
    };
  }

  private graphResultTitleSuffix(result: {
    indexStatus?: ProjectGraphIndexStatus;
    edgeQuality?: ProjectGraphEdgeQuality;
  }): string {
    const detail = this.graphResultDetail(result);
    return detail ? ` · ${detail}` : "";
  }

  private graphResultDetail(result: {
    indexStatus?: ProjectGraphIndexStatus;
    edgeQuality?: ProjectGraphEdgeQuality;
  }): string {
    const parts: string[] = [];
    const status = result.indexStatus;
    if (status?.partial) {
      const indexed = status.relationshipFilesIndexed ?? 0;
      const total = status.relationshipFilesTotal ?? 0;
      parts.push(total > 0 ? `partial index ${indexed}/${total}` : "partial index");
    }

    const lowConfidence = result.edgeQuality?.lowConfidenceEdgeCount ?? 0;
    const unresolved = result.edgeQuality?.unresolvedEdgeCount ?? 0;
    if (lowConfidence > 0) {
      parts.push(
        unresolved > 0
          ? `${lowConfidence} low-confidence edges, ${unresolved} unresolved`
          : `${lowConfidence} low-confidence edges`,
      );
    }
    return parts.join(" · ");
  }

  private queryResultNodes(result: ProjectGraphQueryResult): ProjectGraphNode[] {
    const nodesById = new Map(result.nodes.map((node) => [node.id, node]));
    const relatedIds = new Set<string>();
    for (const edge of result.edges) {
      if (result.kind === "callees" && edge.source === result.targetId) {
        relatedIds.add(edge.target);
        continue;
      }
      if (result.kind !== "callees" && edge.target === result.targetId) {
        relatedIds.add(edge.source);
      }
    }
    const related = Array.from(relatedIds)
      .map((id) => nodesById.get(id))
      .filter((node): node is ProjectGraphNode => Boolean(node));
    return related.length > 0
      ? related
      : result.nodes.filter((node) => node.id !== result.targetId);
  }

  private searchResultToProjectGraph(result: ProjectGraphSearchResult): ProjectGraphResult {
    const nodes = new Map<string, ProjectGraphNode>();
    const edges = new Map<string, ProjectGraphEdge>();
    for (const match of result.matches) {
      nodes.set(match.node.id, match.node);
      for (const node of match.relatedNodes ?? []) {
        nodes.set(node.id, node);
      }
      for (const edge of match.edges ?? []) {
        edges.set(this.projectGraphEdgeKey(edge), edge);
      }
    }
    const included = new Set(nodes.keys());
    return {
      nodes: Array.from(nodes.values()),
      edges: Array.from(edges.values()).filter(
        (edge) => included.has(edge.source) && included.has(edge.target),
      ),
      focusId: result.matches[0]?.node.id,
      truncated: result.truncated,
    };
  }

  private projectGraphEdgeKey(edge: ProjectGraphEdge): string {
    const line = edge.range?.start.line ?? "";
    const character = edge.range?.start.character ?? "";
    return `${edge.source}->${edge.kind}->${edge.target}@${line}:${character}`;
  }

  private parseProjectGraphQueryKind(value: string): ProjectGraphQueryKind | undefined {
    return value === "callers" || value === "callees" || value === "impact" ? value : undefined;
  }

  private graphQueryLabel(kind: ProjectGraphQueryKind): string {
    switch (kind) {
      case "callers":
        return "Callers";
      case "callees":
        return "Callees";
      case "impact":
        return "Impact";
    }
  }

  private graphResultStatus(
    result: {
      indexStatus?: ProjectGraphIndexStatus;
      edgeQuality?: ProjectGraphEdgeQuality;
      truncated?: boolean;
    },
    prefix: string,
  ): string {
    return [prefix, result.truncated ? "truncated" : "", this.graphResultDetail(result)]
      .filter(Boolean)
      .join(" · ");
  }

  private async postProjectGraphStatus(message: string): Promise<void> {
    if (!this.panel) return;
    await this.panel.webview.postMessage({ type: "status", message });
  }

  private async applyServerStateToProjectGraph(state: ServerStateParams): Promise<void> {
    if (!this.panel) return;
    if (state.phase === "indexing") {
      this.projectGraphIndexingVisible = true;
      const indexed = Math.max(0, state.filesIndexed);
      const total = Math.max(0, state.filesTotal);
      const suffix = total > 0 ? ` ${indexed}/${total}` : "";
      await this.postProjectGraphStatus(`Indexing project graph relationships${suffix}...`);
      return;
    }
    if (state.phase === "idle" && this.projectGraphIndexingVisible) {
      this.projectGraphIndexingVisible = false;
      await this.postProjectGraphStatus("Project graph indexing complete.");
    }
  }

  private async openProjectGraphNode(node: ProjectGraphNode): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(node.uri));
    const range = node.selectionRange;
    const selection = new vscode.Selection(
      range.start.line,
      range.start.character,
      range.end.line,
      range.end.character,
    );
    await vscode.window.showTextDocument(doc, { preview: true, selection });
  }

  private async getProjectGraphStats(): Promise<ProjectGraphStatsResult> {
    return this.client.sendRequest<ProjectGraphStatsResult>(GetProjectGraphStats);
  }

  private async rebuildProjectGraph(): Promise<void> {
    const stats = await this.runBlockingProjectGraphRebuild("Rebuilding Solidity project graph");
    if (this.panel) {
      await this.postCursorNeighborhood(stats);
    }
    if (stats.rebuildCanceled) {
      vscode.window.showWarningMessage(
        `Project graph rebuild canceled: ${stats.nodeCount} nodes, ${stats.edgeCount} edges indexed so far.`,
      );
      return;
    }
    vscode.window.showInformationMessage(
      `Project graph rebuilt: ${stats.nodeCount} nodes, ${stats.edgeCount} edges.`,
    );
  }

  private async clearProjectGraphCache(): Promise<void> {
    if (!this.context) return;
    const graphCacheUri = vscode.Uri.joinPath(this.context.globalStorageUri, "graph-index");
    await vscode.workspace.fs.delete(graphCacheUri, { recursive: true, useTrash: false }).then(
      () => undefined,
      () => undefined,
    );
    const stats = await this.runBlockingProjectGraphRebuild(
      "Clearing Solidity project graph cache",
    );
    if (this.panel) {
      await this.postCursorNeighborhood(stats);
    }
    if (stats.rebuildCanceled) {
      vscode.window.showWarningMessage(
        `Project graph cache cleared. Rebuild canceled with ${stats.nodeCount} graph nodes indexed so far.`,
      );
      return;
    }
    vscode.window.showInformationMessage(
      `Project graph cache cleared. Reindexed ${stats.nodeCount} graph nodes.`,
    );
  }

  private async runBlockingProjectGraphRebuild(title: string): Promise<ProjectGraphStatsResult> {
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title,
        cancellable: true,
      },
      (_progress, token) =>
        this.client.sendRequest<ProjectGraphStatsResult>(
          RebuildProjectGraph,
          {
            relationships: "blocking",
          },
          token,
        ),
    );
  }

  private async postCursorNeighborhood(stats?: ProjectGraphStatsResult): Promise<void> {
    const focused = this.activeSolidityPosition();
    if (!focused) {
      if (this.panel) {
        await this.panel.webview.postMessage({
          type: "status",
          message: "Open a Solidity file or place the cursor in one first.",
        });
      }
      return;
    }

    const graph = await this.client.sendRequest<ProjectGraphResult>(GetProjectGraphNeighborhood, {
      uri: focused.uri.toString(),
      position: focused.position,
      depth: 2,
      edgeKinds: [
        "imports",
        "inherits",
        "implements",
        "overrides",
        "calls",
        "externalCall",
        "delegateCall",
        "creates",
        "usesModifier",
        "usesType",
      ],
      direction: "both",
      maxNodes: 240,
    });
    if (this.panel) {
      await this.panel.webview.postMessage({
        type: "setGraph",
        graph,
        stats: stats ?? (await this.getProjectGraphStats()),
        focusId: graph.focusId ?? this.findActiveNodeHint(graph),
        scope: "neighbors",
      });
    }
  }

  private findActiveNodeHint(graph: ProjectGraphResult): string | undefined {
    const active = this.activeSolidityPosition();
    if (!active) return undefined;
    const uri = active.uri.toString();
    const position = active.position;
    const candidates = graph.nodes.filter(
      (node) => node.uri === uri && this.positionInRange(position, node.range),
    );
    candidates.sort((a, b) => this.rangeSize(a.range) - this.rangeSize(b.range));
    return candidates[0]?.id;
  }

  private activeSolidityPosition(): { uri: vscode.Uri; position: vscode.Position } | undefined {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === "solidity") {
      this.lastSolidityPosition = { uri: editor.document.uri, position: editor.selection.active };
      return this.lastSolidityPosition;
    }
    return this.lastSolidityPosition;
  }

  private rememberActiveSolidityPosition(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== "solidity") return;
    this.lastSolidityPosition = { uri: editor.document.uri, position: editor.selection.active };
  }

  private positionInRange(position: vscode.Position, range: ProjectGraphNode["range"]): boolean {
    const afterStart =
      position.line > range.start.line ||
      (position.line === range.start.line && position.character >= range.start.character);
    const beforeEnd =
      position.line < range.end.line ||
      (position.line === range.end.line && position.character <= range.end.character);
    return afterStart && beforeEnd;
  }

  private rangeSize(range: ProjectGraphNode["range"]): number {
    return (
      (range.end.line - range.start.line) * 100_000 +
      Math.max(0, range.end.character - range.start.character)
    );
  }

  private buildHtml(
    graph: ProjectGraphResult,
    focusId?: string,
    graphStats?: ProjectGraphStatsResult,
  ): string {
    const graphJson = JSON.stringify({ graph, focusId, stats: graphStats }).replace(
      /</g,
      "\\u003c",
    );
    const edgeItemsJson = JSON.stringify(EDGE_KIND_ITEMS).replace(/</g, "\\u003c");
    const confidenceItemsJson = JSON.stringify(RESOLUTION_CONFIDENCE_VALUES).replace(
      /</g,
      "\\u003c",
    );
    const nodeKindItemsJson = JSON.stringify(PROJECT_GRAPH_NODE_KIND_FILTER_ITEMS).replace(
      /</g,
      "\\u003c",
    );
    const nonce = crypto.randomBytes(16).toString("base64");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-foreground);
    --muted: var(--vscode-descriptionForeground);
    --border: var(--vscode-panel-border);
    --button: var(--vscode-button-secondaryBackground);
    --button-fg: var(--vscode-button-secondaryForeground);
    --input: var(--vscode-input-background);
    --accent: var(--vscode-focusBorder);
    --list-hover: var(--vscode-list-hoverBackground);
    --list-active: var(--vscode-list-activeSelectionBackground);
    --list-active-fg: var(--vscode-list-activeSelectionForeground);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    height: 100vh;
    overflow: hidden;
    background: var(--bg);
    color: var(--fg);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
  }
  .shell {
    display: grid;
    grid-template-rows: auto auto 1fr;
    height: 100vh;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding: 8px 10px;
    border-bottom: 1px solid var(--border);
  }
  .title { font-weight: 600; white-space: nowrap; }
  .stats {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .readiness {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .readiness.partial {
    color: var(--vscode-editorWarning-foreground, var(--muted));
  }
  .status-banner {
    display: none;
    padding: 7px 10px;
    border-bottom: 1px solid var(--border);
    background: var(--vscode-inputValidation-warningBackground, var(--vscode-editorWidget-background));
    color: var(--vscode-inputValidation-warningForeground, var(--fg));
  }
  .status-banner.visible {
    display: block;
  }
  .result-banner {
    display: none;
    padding: 7px 10px;
    border-bottom: 1px solid var(--border);
    background: var(--vscode-editorWidget-background);
    color: var(--fg);
  }
  .result-banner.visible {
    display: block;
  }
  .result-banner.partial {
    background: var(--vscode-inputValidation-warningBackground, var(--vscode-editorWidget-background));
    color: var(--vscode-inputValidation-warningForeground, var(--fg));
  }
  .result-banner.warning {
    color: var(--vscode-editorWarning-foreground, var(--fg));
  }
  .spacer { flex: 1; }
  input[type="search"] {
    width: min(340px, 24vw);
    min-width: 170px;
    background: var(--input);
    color: var(--fg);
    border: 1px solid var(--border);
    padding: 5px 8px;
    outline: none;
  }
  input[type="search"]:focus { border-color: var(--accent); }
  select {
    background: var(--input);
    color: var(--fg);
    border: 1px solid var(--border);
    padding: 5px 8px;
    outline: none;
  }
  button {
    border: 1px solid var(--border);
    background: var(--button);
    color: var(--button-fg);
    padding: 5px 8px;
    cursor: pointer;
  }
  button:hover { border-color: var(--accent); }
  button.active {
    border-color: var(--accent);
    color: var(--fg);
  }
  .compact {
    width: 30px;
    padding-inline: 0;
  }
  .zoom {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    min-width: 44px;
    text-align: center;
  }
  .content {
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(240px, 300px) 1fr;
  }
  .sidebar {
    min-width: 0;
    overflow: auto;
    border-right: 1px solid var(--border);
  }
  .edge-list {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2px 8px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--border);
  }
  label {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--muted);
    min-width: 0;
    white-space: nowrap;
  }
  .node-list {
    display: grid;
    gap: 1px;
    padding: 6px 0;
  }
  .details {
    display: grid;
    gap: 8px;
    padding: 10px;
    border-bottom: 1px solid var(--border);
  }
  .details-title {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .details-meta {
    color: var(--muted);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .details-actions {
    display: flex;
    gap: 6px;
    min-width: 0;
  }
  .edge-summary {
    display: grid;
    gap: 4px;
  }
  .edge-row {
    display: grid;
    grid-template-columns: minmax(72px, 92px) 1fr minmax(58px, 74px);
    gap: 6px;
    border: 0;
    background: transparent;
    color: var(--fg);
    text-align: left;
    padding: 4px 0;
    cursor: pointer;
    width: 100%;
  }
  .edge-row:hover { color: var(--accent); }
  .edge-row.unresolved {
    border-left: 2px solid var(--vscode-editorWarning-foreground, #d97706);
    padding-left: 6px;
  }
  .edge-row.low-confidence {
    opacity: 0.92;
  }
  .edge-kind {
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .edge-target {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .edge-quality {
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: right;
    font-size: 11px;
  }
  .edge-quality.warning {
    color: var(--vscode-editorWarning-foreground, #d97706);
  }
  .edge-evidence {
    grid-column: 2 / 4;
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 6px;
    align-items: center;
    min-width: 0;
    color: var(--muted);
    font-size: 11px;
  }
  .edge-evidence-text {
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11px;
  }
  .edge-warning {
    grid-column: 1 / 4;
    color: var(--vscode-editorWarning-foreground, #d97706);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .edge-evidence-actions {
    display: flex;
    gap: 4px;
  }
  .edge-evidence-actions button {
    border: 1px solid var(--border);
    background: var(--button);
    color: var(--button-fg);
    font-size: 10px;
    line-height: 1;
    padding: 2px 5px;
  }
  .edge-evidence-actions button:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }
  .node-row {
    display: grid;
    grid-template-columns: 18px 1fr;
    gap: 7px;
    align-items: center;
    width: 100%;
    border: 0;
    background: transparent;
    color: var(--fg);
    text-align: left;
    padding: 6px 10px;
  }
  .node-row:hover { background: var(--list-hover); }
  .node-row.active {
    background: var(--list-active);
    color: var(--list-active-fg);
  }
  .row-text {
    display: grid;
    gap: 2px;
    min-width: 0;
  }
  .swatch {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    justify-self: center;
  }
  .swatch.file { background: #94a3b8; }
  .swatch.contract { background: #93c5fd; }
  .swatch.interface { background: #5eead4; }
  .swatch.library { background: #c4b5fd; }
  .swatch.function, .swatch.constructor, .swatch.receive, .swatch.fallback, .swatch.modifier { background: #fcd34d; }
  .swatch.event { background: #f9a8d4; }
  .swatch.error { background: #fca5a5; }
  .swatch.stateVariable, .swatch.fileConstant, .swatch.struct, .swatch.enum, .swatch.userDefinedValueType { background: #86efac; }
  .row-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-meta {
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11px;
  }
  .badge-row {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    min-width: 0;
  }
  .node-badge {
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--muted);
    font-size: 10px;
    line-height: 1;
    padding: 2px 5px;
    white-space: nowrap;
  }
  .node-badge.getter {
    border-color: var(--accent);
    color: var(--accent);
  }
  .canvas {
    min-width: 0;
    overflow: auto;
    cursor: grab;
    position: relative;
  }
  .canvas.panning {
    cursor: grabbing;
    user-select: none;
  }
  svg {
    display: block;
    transform-origin: 0 0;
  }
  .lane-label {
    fill: var(--muted);
    font-size: 11px;
    text-anchor: middle;
  }
  .edge {
    fill: none;
    stroke: var(--muted);
    stroke-width: 1.35;
    opacity: 0.42;
  }
  .edge.solc { opacity: 0.58; }
  .edge.parser { stroke-dasharray: 5 4; }
  .edge.heuristic, .edge.unknown { stroke-dasharray: 2 5; opacity: 0.34; }
  .edge.unresolved { stroke: var(--vscode-editorWarning-foreground, #d97706); opacity: 0.72; }
  .edge.active {
    stroke: var(--accent);
    opacity: 0.95;
    stroke-width: 2.2;
  }
  .node {
    cursor: pointer;
  }
  .node rect {
    stroke-width: 1.4;
    filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.28));
  }
  .node text {
    pointer-events: none;
  }
  .node .name {
    fill: white;
    font-size: 12px;
    font-weight: 600;
    text-anchor: middle;
  }
  .node .meta {
    fill: rgba(255,255,255,0.72);
    font-size: 10px;
    text-anchor: middle;
  }
  .file { fill: #475569; stroke: #94a3b8; }
  .contract { fill: #2563eb; stroke: #93c5fd; }
  .interface { fill: #0f766e; stroke: #5eead4; }
  .library { fill: #6d28d9; stroke: #c4b5fd; }
  .function, .constructor, .receive, .fallback, .modifier { fill: #b45309; stroke: #fcd34d; }
  .event { fill: #be185d; stroke: #f9a8d4; }
  .error { fill: #b91c1c; stroke: #fca5a5; }
  .stateVariable, .fileConstant, .struct, .enum, .userDefinedValueType { fill: #15803d; stroke: #86efac; }
  .focus rect { stroke: #ffffff; stroke-width: 3; }
  .dim { opacity: 0.2; }
  .empty {
    padding: 28px;
    color: var(--muted);
  }
</style>
</head>
<body>
<div class="shell">
  <div class="toolbar">
    <span class="title">Project Graph</span>
    <span class="stats" id="stats"></span>
    <span class="readiness" id="readiness"></span>
    <input id="search" type="search" placeholder="Filter symbols">
    <select id="scope">
      <option value="neighbors">Neighborhood</option>
      <option value="all">All Nodes</option>
      <option value="project">Project</option>
      <option value="contracts">Contracts</option>
      <option value="callables">Callables</option>
      <option value="state">State & Types</option>
    </select>
    <select id="nodeKind" title="Filter nodes by declaration kind"></select>
    <select id="quality" title="Filter edges by resolution quality">
      <option value="all">All Edge Quality</option>
      <option value="solc">Solc-confirmed</option>
      <option value="parser">Parser-resolved</option>
      <option value="heuristic">Heuristic</option>
      <option value="unresolved">Unresolved</option>
      <option value="unknown">Unknown</option>
    </select>
    <button id="serverSearch" title="Search the indexed project graph using the filter text">Search</button>
    <select id="serverQueryKind" title="Choose graph query">
      <option value="callers">Callers</option>
      <option value="callees">Callees</option>
      <option value="impact">Impact</option>
    </select>
    <button id="serverQuery" title="Run graph query for the selected node or filter text">Query</button>
    <span class="spacer"></span>
    <button class="compact" id="zoomOut" title="Zoom out">−</button>
    <span class="zoom" id="zoomLabel"></span>
    <button class="compact" id="zoomIn" title="Zoom in">+</button>
    <button id="fit" title="Fit to graph">Fit</button>
    <button id="showMoreNodes" title="Render more hidden graph nodes" hidden>More</button>
    <button id="pathMode" title="Find a graph path from the focused node">Path</button>
    <button id="cursor" title="Load a server-computed neighborhood from the current Solidity cursor">Cursor</button>
    <button id="workspace" title="Load full workspace graph">Workspace</button>
    <button class="compact" id="rebuild" title="Rebuild graph index">↻</button>
    <button class="compact" id="clearCache" title="Clear graph cache and rebuild">⌫</button>
  </div>
  <div class="status-banner" id="statusBanner"></div>
  <div class="result-banner" id="resultBanner"></div>
  <div class="content">
    <aside class="sidebar">
      <div class="edge-list" id="edgeList"></div>
      <div class="details" id="details"></div>
      <div class="node-list" id="nodeList"></div>
    </aside>
    <main class="canvas" id="canvas">
      <svg id="graph" role="img"></svg>
    </main>
  </div>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const payload = ${graphJson};
  const edgeItems = ${edgeItemsJson};
  const confidenceItems = ${confidenceItemsJson};
  const nodeKindItems = ${nodeKindItemsJson};
  const persisted = vscode.getState ? (vscode.getState() || {}) : {};
  const scopeValues = new Set(["neighbors", "all", "project", "contracts", "callables", "state"]);
  const qualityValues = new Set(["all", "solc", "parser", "heuristic", "unresolved", "unknown"]);
  const nodeKindValues = new Set(nodeKindItems.map((item) => item.value));
  let graph = payload.graph;
  let graphStats = payload.stats || null;
  let resultDiagnostics = payload.resultDiagnostics || null;
  let activeId = persisted.activeId && graph.nodes.some((node) => node.id === persisted.activeId)
    ? persisted.activeId
    : payload.focusId || "";
  let query = typeof persisted.query === "string" ? persisted.query : "";
  let scope = typeof persisted.scope === "string" && scopeValues.has(persisted.scope) ? persisted.scope : (activeId ? "neighbors" : "all");
  let nodeKind = typeof persisted.nodeKind === "string" && nodeKindValues.has(persisted.nodeKind) ? persisted.nodeKind : "all";
  let quality = typeof persisted.quality === "string" && qualityValues.has(persisted.quality) ? persisted.quality : "all";
  let zoom = typeof persisted.zoom === "number" ? Math.max(0.45, Math.min(1.8, persisted.zoom)) : 1;
  let pathMode = Boolean(persisted.pathMode);
  const defaultRenderedNodeLimit = ${PROJECT_GRAPH_DEFAULT_RENDERED_NODE_LIMIT};
  const renderNodeLimitStep = ${PROJECT_GRAPH_RENDER_NODE_LIMIT_STEP};
  const maxRenderedNodeLimit = ${PROJECT_GRAPH_MAX_RENDERED_NODE_LIMIT};
  let renderedNodeLimit = typeof persisted.renderedNodeLimit === "number"
    ? Math.max(defaultRenderedNodeLimit, Math.min(maxRenderedNodeLimit, persisted.renderedNodeLimit))
    : defaultRenderedNodeLimit;
  const defaultEdges = new Set(["imports", "inherits", "implements", "overrides", "calls", "externalCall", "delegateCall", "creates", "usesModifier", "usesType"]);
  const persistedEdges = Array.isArray(persisted.visibleEdges) ? persisted.visibleEdges.filter((kind) => edgeItems.some((item) => item.label === kind)) : [];
  const visibleEdges = new Set(persistedEdges.length > 0 ? persistedEdges : defaultEdges);
  let nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const canvas = document.getElementById("canvas");
  const svg = document.getElementById("graph");
  const stats = document.getElementById("stats");
  const readiness = document.getElementById("readiness");
  const statusBanner = document.getElementById("statusBanner");
  const resultBanner = document.getElementById("resultBanner");
  const nodeList = document.getElementById("nodeList");
  const edgeList = document.getElementById("edgeList");
  const details = document.getElementById("details");
  const search = document.getElementById("search");
  const scopeSelect = document.getElementById("scope");
  const nodeKindSelect = document.getElementById("nodeKind");
  const qualitySelect = document.getElementById("quality");
  const serverQueryKind = document.getElementById("serverQueryKind");
  const zoomLabel = document.getElementById("zoomLabel");
  const pathModeButton = document.getElementById("pathMode");
  const showMoreNodesButton = document.getElementById("showMoreNodes");
  const laneDefs = [
    { key: "file", label: "Files", x: 90 },
    { key: "type", label: "Contracts & Types", x: 350 },
    { key: "callable", label: "Callables", x: 610 },
    { key: "state", label: "State, Events, Errors", x: 870 },
  ];

  function nodeLane(node) {
    if (node.kind === "file") return "file";
    if (node.kind === "contract" || node.kind === "interface" || node.kind === "library" || node.kind === "struct" || node.kind === "enum" || node.kind === "userDefinedValueType") return "type";
    if (node.kind === "function" || node.kind === "constructor" || node.kind === "receive" || node.kind === "fallback" || node.kind === "modifier") return "callable";
    return "state";
  }

  function matchesScope(node) {
    if (scope === "neighbors") return true;
    if (scope === "project") return node.tier === "project";
    if (scope === "contracts") return node.kind === "contract" || node.kind === "interface" || node.kind === "library";
    if (scope === "callables") return nodeLane(node) === "callable";
    if (scope === "state") return nodeLane(node) === "state" || node.kind === "struct" || node.kind === "enum" || node.kind === "userDefinedValueType";
    return true;
  }

  function matchesNodeKind(node) {
    return nodeKind === "all" || node.kind === nodeKind;
  }

  function matchesNodeKindById(id) {
    const node = nodesById.get(id);
    return Boolean(node && matchesNodeKind(node));
  }

  function searchable(node) {
    return [node.name, node.qualifiedName, node.kind, node.containerName, node.filePath, node.tier, nodeMetadataSearchText(node)].filter(Boolean).join(" ").toLowerCase();
  }

  function nodeMetadata(node) {
    return node.metadata && typeof node.metadata === "object" ? node.metadata : {};
  }

  function nodeBadges(node) {
    const metadata = nodeMetadata(node);
    const badges = [];
    if (typeof metadata.visibility === "string" && metadata.visibility) {
      badges.push({ label: metadata.visibility, className: "visibility" });
    }
    if (metadata.publicGetter === true) {
      const argc = typeof metadata.getterArgumentCount === "number" ? metadata.getterArgumentCount : 0;
      badges.push({ label: argc > 0 ? "getter +" + argc : "getter", className: "getter" });
    }
    return badges;
  }

  function nodeBadgeText(node) {
    return nodeBadges(node).map((badge) => badge.label).join(" · ");
  }

  function nodeMetadataSearchText(node) {
    const metadata = nodeMetadata(node);
    return [
      nodeBadgeText(node),
      metadata.publicGetter === true ? "public getter" : "",
    ].filter(Boolean).join(" ");
  }

  function appendNodeBadges(parent, node) {
    const badges = nodeBadges(node);
    if (badges.length === 0) return;
    const row = document.createElement("div");
    row.className = "badge-row";
    for (const badge of badges) {
      const el = document.createElement("span");
      el.className = "node-badge " + badge.className;
      el.textContent = badge.label;
      row.append(el);
    }
    parent.append(row);
  }

  function setGraph(nextGraph, nextFocusId, nextScope, nextStats, nextResultDiagnostics) {
    graph = nextGraph;
    graphStats = nextStats || graphStats;
    resultDiagnostics = nextResultDiagnostics || null;
    nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
    if (nextFocusId && nodesById.has(nextFocusId)) {
      activeId = nextFocusId;
    } else if (!nodesById.has(activeId)) {
      activeId = graph.focusId && nodesById.has(graph.focusId) ? graph.focusId : "";
    }
    if (nextScope) {
      scope = nextScope;
      scopeSelect.value = scope;
    }
    saveUiState();
    render();
  }

  function setStatus(message) {
    stats.textContent = message;
  }

  function relationshipStatusText() {
    const parts = [];
    if (graphStats && graphStats.relationshipIndexComplete !== undefined) {
      if (graphStats.relationshipIndexComplete) {
        parts.push("edges ready");
      } else {
        const indexed = graphStats.relationshipFilesIndexed ?? 0;
        const total = graphStats.relationshipFilesTotal ?? 0;
        const pending = graphStats.pendingRelationshipFiles ?? Math.max(0, total - indexed);
        parts.push(total <= 0 ? "indexing edges" : "indexing edges " + indexed + "/" + total + (pending > 0 ? " pending " + pending : ""));
      }
    }
    const compiler = compilerStatusText();
    if (compiler) parts.push(compiler);
    return parts.join(" · ");
  }

  function relationshipStatusDetail() {
    const details = [];
    if (graphStats && graphStats.relationshipIndexComplete === false) {
      const indexed = graphStats.relationshipFilesIndexed ?? 0;
      const total = graphStats.relationshipFilesTotal ?? 0;
      const pending = graphStats.pendingRelationshipFiles ?? Math.max(0, total - indexed);
      const progress = total > 0
        ? indexed + "/" + total + " files indexed" + (pending > 0 ? ", " + pending + " pending" : "")
        : "relationship indexing in progress";
      details.push(progress + ". Focused neighborhoods force-index the active file, but full-workspace relationship edges may be partial. Use Rebuild to finish indexing now.");
    }
    const compiler = compilerStatusDetail();
    if (compiler) details.push(compiler);
    return details.join(" ");
  }

  function compilerStatusText() {
    const status = graphStats && graphStats.compilerStatus;
    if (!status) return "";
    if (!status.available) return "parser-only";
    if (status.stale) return "compiler stale" + (status.staleFileCount ? " " + status.staleFileCount : "");
    return "compiler ready";
  }

  function compilerStatusDetail() {
    const status = graphStats && graphStats.compilerStatus;
    if (!status) return "";
    if (!status.available) {
      return "No compiler AST cache is available yet; save or build to enable compiler-backed graph resolution.";
    }
    if (!status.stale) return "";
    const count = status.staleFileCount ?? (Array.isArray(status.staleFiles) ? status.staleFiles.length : 0);
    const files = Array.isArray(status.staleFiles) && status.staleFiles.length > 0
      ? " Stale files: " + status.staleFiles.slice(0, 3).map((file) => file.split(/[\\/]/).slice(-2).join("/")).join(", ") + (status.staleFiles.length > 3 ? ", ..." : "") + "."
      : "";
    return "Compiler AST cache is stale" + (count > 0 ? " for " + count + " file" + (count === 1 ? "" : "s") : "") + "; save or rebuild to refresh compiler-backed resolution." + files;
  }

  function resultDiagnosticsText() {
    if (!resultDiagnostics || !resultDiagnostics.detail) return "";
    return resultDiagnostics.label + ": " + resultDiagnostics.detail;
  }

  function edgeQualityText() {
    if (!graphStats || !graphStats.edgesByResolutionConfidence) return "";
    const counts = graphStats.edgesByResolutionConfidence;
    const solc = counts.solc ?? 0;
    const parser = counts.parser ?? 0;
    const heuristic = counts.heuristic ?? 0;
    const unknown = counts.unknown ?? 0;
    const total = solc + parser + heuristic + unknown;
    const unresolved = graphStats.unresolvedEdgeCount ?? 0;
    if (total <= 0) return "";
    return "quality " + solc + "/" + total + " solc" + (unresolved > 0 ? " · unresolved " + unresolved : "");
  }

  function edgeConfidence(edge) {
    return confidenceItems.includes(edge.resolutionConfidence) ? edge.resolutionConfidence : "unknown";
  }

  function edgeIsUnresolved(edge) {
    return edge.unresolvedTarget === true || (edge.metadata && edge.metadata.unresolvedTarget === true);
  }

  function edgeMatchesQuality(edge) {
    if (quality === "all") return true;
    if (quality === "unresolved") return edgeIsUnresolved(edge);
    return edgeConfidence(edge) === quality;
  }

  function visibleNodeState() {
    const q = query.trim().toLowerCase();
    const direct = new Set();
    if (scope === "neighbors" && activeId) {
      direct.add(activeId);
      const frontier = new Set([activeId]);
      for (let depth = 0; depth < 2; depth++) {
        const next = new Set();
        for (const edge of graph.edges) {
          if (!visibleEdges.has(edge.kind)) continue;
          if (!edgeMatchesQuality(edge)) continue;
          if (frontier.has(edge.source) && matchesNodeKindById(edge.target)) next.add(edge.target);
          if (frontier.has(edge.target) && matchesNodeKindById(edge.source)) next.add(edge.source);
        }
        for (const id of next) {
          direct.add(id);
          frontier.add(id);
        }
      }
      if (q) {
        for (const id of Array.from(direct)) {
          const node = nodesById.get(id);
          if (
            node &&
            id !== activeId &&
            (!searchable(node).includes(q) || !matchesNodeKind(node))
          ) {
            direct.delete(id);
          }
        }
      }
    } else {
      for (const node of graph.nodes) {
        if (!matchesScope(node)) continue;
        if (!matchesNodeKind(node)) continue;
        if (q && !searchable(node).includes(q)) continue;
        direct.add(node.id);
      }
    }

    if (scope === "neighbors" && activeId) {
      const sorted = Array.from(direct)
        .map((id) => nodesById.get(id))
        .filter(Boolean)
        .sort(compareNodes);
      return cappedNodeState(sorted);
    }

    const connected = new Set(direct);
    for (const edge of graph.edges) {
      if (!visibleEdges.has(edge.kind)) continue;
      if (!edgeMatchesQuality(edge)) continue;
      if (direct.has(edge.source) && matchesNodeKindById(edge.target)) connected.add(edge.target);
      if (direct.has(edge.target) && matchesNodeKindById(edge.source)) connected.add(edge.source);
    }

    const sorted = Array.from(connected)
      .map((id) => nodesById.get(id))
      .filter(Boolean)
      .sort(compareNodes);
    return cappedNodeState(sorted);
  }

  function cappedNodeState(nodes) {
    const capped = nodes.slice(0, renderedNodeLimit);
    return {
      ids: new Set(capped.map((node) => node.id)),
      candidateCount: nodes.length,
      hiddenCount: Math.max(0, nodes.length - capped.length),
    };
  }

  function graphStatsText(nodeState, visibleGraphEdges) {
    const hiddenText = nodeState.hiddenCount > 0
      ? " · " + nodeState.hiddenCount + " hidden by render cap"
      : "";
    return nodeState.ids.size + "/" + nodeState.candidateCount + " rendered nodes" + hiddenText + " · " + visibleGraphEdges.length + "/" + graph.edges.length + " edges" + (graph.truncated ? " · truncated" : "") + (edgeQualityText() ? " · " + edgeQualityText() : "");
  }

  function resetRenderedNodeLimit() {
    renderedNodeLimit = defaultRenderedNodeLimit;
  }

  function updateShowMoreButton(nodeState) {
    const hidden = nodeState.hiddenCount > 0;
    showMoreNodesButton.hidden = !hidden;
    showMoreNodesButton.disabled = hidden && renderedNodeLimit >= maxRenderedNodeLimit;
    showMoreNodesButton.textContent = showMoreNodesButton.disabled
      ? "Max"
      : "More +" + Math.min(renderNodeLimitStep, nodeState.hiddenCount);
    showMoreNodesButton.title = showMoreNodesButton.disabled
      ? "Maximum rendered node limit reached; narrow the graph with filters"
      : "Render " + Math.min(renderNodeLimitStep, nodeState.hiddenCount) + " more hidden graph nodes";
  }

  function compareNodes(a, b) {
    const laneOrder = { file: 0, type: 1, callable: 2, state: 3 };
    const tierOrder = { project: 0, tests: 1, deps: 2, unknown: 3 };
    return (laneOrder[nodeLane(a)] - laneOrder[nodeLane(b)]) ||
      ((tierOrder[a.tier] ?? 9) - (tierOrder[b.tier] ?? 9)) ||
      a.qualifiedName.localeCompare(b.qualifiedName);
  }

  function layoutNodes(ids) {
    const lanes = new Map(laneDefs.map((lane) => [lane.key, []]));
    const nodes = Array.from(ids).map((id) => nodesById.get(id)).filter(Boolean).sort(compareNodes);
    for (const node of nodes) lanes.get(nodeLane(node)).push(node);

    const positions = new Map();
    for (const lane of laneDefs) {
      const laneNodes = lanes.get(lane.key);
      laneNodes.forEach((node, index) => {
        positions.set(node.id, { x: lane.x, y: 70 + index * 76 });
      });
    }
    return positions;
  }

  function renderEdgeControls() {
    edgeList.innerHTML = "";
    for (const item of edgeItems) {
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = visibleEdges.has(item.label);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) visibleEdges.add(item.label);
        else visibleEdges.delete(item.label);
        resetRenderedNodeLimit();
        saveUiState();
        render();
      });
      label.append(checkbox, item.label);
      edgeList.append(label);
    }
  }

  function renderNodeKindOptions() {
    nodeKindSelect.innerHTML = "";
    for (const item of nodeKindItems) {
      const option = document.createElement("option");
      option.value = item.value;
      option.textContent = item.label;
      nodeKindSelect.append(option);
    }
    nodeKindSelect.value = nodeKind;
  }

  function renderList(ids) {
    const nodes = Array.from(ids).map((id) => nodesById.get(id)).filter(Boolean).sort(compareNodes);
    nodeList.innerHTML = "";
    for (const node of nodes) {
      const row = document.createElement("button");
      row.className = "node-row" + (node.id === activeId ? " active" : "");
      row.title = node.qualifiedName;
      row.addEventListener("click", () => {
        if (pathMode && activeId && activeId !== node.id) {
          findPath(node.id);
          return;
        }
        activeId = node.id;
        resetRenderedNodeLimit();
        saveUiState();
        navigate(node);
        render();
      });
      const swatch = document.createElement("span");
      swatch.className = "swatch " + node.kind;
      const text = document.createElement("span");
      text.className = "row-text";
      const name = document.createElement("span");
      name.className = "row-name";
      name.textContent = node.qualifiedName;
      const meta = document.createElement("span");
      meta.className = "row-meta";
      meta.textContent = node.kind + " · " + node.tier;
      text.append(name, meta);
      appendNodeBadges(text, node);
      row.append(swatch, text);
      nodeList.append(row);
    }
  }

  function renderDetails(ids, visibleGraphEdges) {
    details.innerHTML = "";
    const node = nodesById.get(activeId);
    if (!node) {
      const empty = document.createElement("div");
      empty.className = "details-meta";
      empty.textContent = "Select a node to inspect edges.";
      details.append(empty);
      return;
    }

    const title = document.createElement("div");
    title.className = "details-title";
    title.title = node.qualifiedName;
    title.textContent = node.qualifiedName;
    const meta = document.createElement("div");
    meta.className = "details-meta";
    meta.title = node.filePath || "";
    meta.textContent = node.kind + " · " + node.tier + (node.containerName ? " · " + node.containerName : "");
    details.append(title, meta);
    appendNodeBadges(details, node);

    const actions = document.createElement("div");
    actions.className = "details-actions";
    const open = document.createElement("button");
    open.textContent = "Open";
    open.addEventListener("click", () => navigate(node));
    const focus = document.createElement("button");
    focus.textContent = "Focus";
    focus.addEventListener("click", () => {
      scope = "neighbors";
      scopeSelect.value = scope;
      resetRenderedNodeLimit();
      saveUiState();
      render();
    });
    actions.append(open, focus);
    details.append(actions);

    const summary = document.createElement("div");
    summary.className = "edge-summary";
    const related = visibleGraphEdges
      .filter((edge) => edge.source === node.id || edge.target === node.id)
      .slice(0, 24);
    for (const edge of related) {
      const otherId = edge.source === node.id ? edge.target : edge.source;
      const other = nodesById.get(otherId);
      if (!other || !ids.has(other.id)) continue;
      const row = document.createElement("div");
      row.className = "edge-row";
      if (edgeIsUnresolved(edge)) row.classList.add("unresolved");
      if (edgeIsLowConfidence(edge)) row.classList.add("low-confidence");
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.title = edgeTitle(edge, other);
      const focusOther = () => {
        activeId = other.id;
        resetRenderedNodeLimit();
        saveUiState();
        render();
      };
      row.addEventListener("click", focusOther);
      row.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        focusOther();
      });
      const kind = document.createElement("span");
      kind.className = "edge-kind";
      kind.textContent = (edge.source === node.id ? "→ " : "← ") + edge.kind;
      const target = document.createElement("span");
      target.className = "edge-target";
      target.textContent = other.qualifiedName;
      const confidence = document.createElement("span");
      confidence.className = "edge-quality";
      if (edgeNeedsTrustWarning(edge)) confidence.classList.add("warning");
      confidence.textContent = edgeQualityLabel(edge);
      const warningLabel = edgeTrustWarningLabel(edge);
      const warning = document.createElement("div");
      warning.className = "edge-warning";
      warning.textContent = warningLabel;
      const evidence = document.createElement("div");
      evidence.className = "edge-evidence";
      const evidenceText = document.createElement("span");
      evidenceText.className = "edge-evidence-text";
      evidenceText.textContent = edgeEvidenceLabel(edge);
      evidence.append(evidenceText);
      const evidenceActions = edgeEvidenceActions(edge);
      if (evidenceActions) evidence.append(evidenceActions);
      row.append(kind, target, confidence, evidence);
      if (warningLabel) row.append(warning);
      summary.append(row);
    }
    if (!summary.childElementCount) {
      const empty = document.createElement("div");
      empty.className = "details-meta";
      empty.textContent = "No visible edges for current filters.";
      summary.append(empty);
    }
    details.append(summary);
  }

  function edgeTitle(edge, other) {
    const evidence = edge.evidence
      ? "\\n" + [edge.evidence.summary, edge.evidence.source, edge.evidence.target].filter(Boolean).join("\\n")
      : "";
    const metadata = edge.metadata && Object.keys(edge.metadata).length
      ? "\\n" + JSON.stringify(edge.metadata, null, 2)
      : "";
    return edge.kind + " · " + other.qualifiedName + "\\n" + edgeQualityLabel(edge) + evidence + metadata;
  }

  function edgeQualityLabel(edge) {
    return (edgeIsUnresolved(edge) ? "unresolved/" : "") + edgeConfidence(edge);
  }

  function edgeIsLowConfidence(edge) {
    const confidence = edgeConfidence(edge);
    return confidence === "heuristic" || confidence === "unknown";
  }

  function edgeNeedsTrustWarning(edge) {
    return edgeIsUnresolved(edge) || edgeIsLowConfidence(edge);
  }

  function edgeTrustWarningLabel(edge) {
    if (edgeIsUnresolved(edge)) return "Unresolved target - source edge is known, target declaration was not resolved.";
    const confidence = edgeConfidence(edge);
    if (confidence === "heuristic") return "Heuristic resolution - verify before relying on this edge.";
    if (confidence === "unknown") return "Unknown resolution - structural edge without resolver confidence.";
    return "";
  }

  function edgeEvidenceLabel(edge) {
    if (edge.evidence && typeof edge.evidence.summary === "string") {
      return edge.evidence.summary;
    }
    return edge.kind;
  }

  function edgeEvidenceActions(edge) {
    if (!edge.evidence) return null;
    const actions = document.createElement("span");
    actions.className = "edge-evidence-actions";
    addEvidenceAction(actions, "Source", edge.evidence.sourceUri, edge.evidence.sourceRange);
    addEvidenceAction(actions, "Target", edge.evidence.targetUri, edge.evidence.targetRange);
    return actions.childElementCount > 0 ? actions : null;
  }

  function addEvidenceAction(container, label, uri, range) {
    if (typeof uri !== "string" || !uri) return;
    const button = document.createElement("button");
    button.textContent = label;
    button.title = "Open " + label.toLowerCase() + " location";
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      navigateRange(uri, range);
    });
    container.append(button);
  }

  function render() {
    const nodeState = visibleNodeState();
    const ids = nodeState.ids;
    const positions = layoutNodes(ids);
    const visibleGraphEdges = graph.edges.filter((edge) => visibleEdges.has(edge.kind) && edgeMatchesQuality(edge) && positions.has(edge.source) && positions.has(edge.target));
    const maxY = Math.max(360, ...Array.from(positions.values()).map((pos) => pos.y + 52));
    const width = 1040;
    svg.setAttribute("width", String(width * zoom));
    svg.setAttribute("height", String(maxY * zoom));
    svg.setAttribute("viewBox", "0 0 " + width + " " + maxY);
    svg.style.transform = "scale(" + zoom + ")";
    svg.innerHTML = "";

    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    defs.innerHTML = '<marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 z" fill="var(--muted)"></path></marker>';
    svg.append(defs);

    for (const lane of laneDefs) {
      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("class", "lane-label");
      label.setAttribute("x", String(lane.x));
      label.setAttribute("y", "24");
      label.textContent = lane.label;
      svg.append(label);
    }

    for (const edge of visibleGraphEdges) {
      const source = positions.get(edge.source);
      const target = positions.get(edge.target);
      const active = edge.source === activeId || edge.target === activeId;
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("class", "edge " + edgeConfidence(edge) + (edgeIsUnresolved(edge) ? " unresolved" : "") + (active ? " active" : ""));
      const sx = source.x + 95;
      const sy = source.y + 26;
      const tx = target.x - 95;
      const ty = target.y + 26;
      const cx = Math.max(40, Math.abs(tx - sx) * 0.45);
      path.setAttribute("d", "M" + sx + "," + sy + " C" + (sx + cx) + "," + sy + " " + (tx - cx) + "," + ty + " " + tx + "," + ty);
      path.setAttribute("marker-end", "url(#arrow)");
      const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
      title.textContent = edge.kind + " · " + edgeQualityLabel(edge);
      path.append(title);
      svg.append(path);
    }

    for (const [id, pos] of positions) {
      const node = nodesById.get(id);
      const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
      const connected = !activeId || id === activeId || visibleGraphEdges.some((edge) => edge.source === activeId && edge.target === id || edge.target === activeId && edge.source === id);
      group.setAttribute("class", "node " + node.kind + (id === activeId ? " focus" : "") + (connected ? "" : " dim"));
      group.setAttribute("transform", "translate(" + (pos.x - 95) + "," + pos.y + ")");
      group.addEventListener("click", () => {
        if (pathMode && activeId && activeId !== id) {
          findPath(id);
          return;
        }
        activeId = id;
        resetRenderedNodeLimit();
        saveUiState();
        navigate(node);
        render();
      });
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("class", node.kind);
      rect.setAttribute("width", "190");
      rect.setAttribute("height", "52");
      rect.setAttribute("rx", "6");
      const name = document.createElementNS("http://www.w3.org/2000/svg", "text");
      name.setAttribute("class", "name");
      name.setAttribute("x", "95");
      name.setAttribute("y", "22");
      name.textContent = truncate(node.name, 24);
      const meta = document.createElementNS("http://www.w3.org/2000/svg", "text");
      meta.setAttribute("class", "meta");
      meta.setAttribute("x", "95");
      meta.setAttribute("y", "38");
      meta.textContent = truncate([node.containerName || node.kind, nodeBadgeText(node)].filter(Boolean).join(" · "), 26);
      group.append(rect, name, meta);
      svg.append(group);
    }

    stats.textContent = graphStatsText(nodeState, visibleGraphEdges);
    updateShowMoreButton(nodeState);
    readiness.textContent = relationshipStatusText();
    const partialRelationships = Boolean(graphStats && graphStats.relationshipIndexComplete === false);
    const staleCompiler = Boolean(graphStats && graphStats.compilerStatus && graphStats.compilerStatus.stale);
    readiness.classList.toggle("partial", partialRelationships || staleCompiler);
    readiness.title = relationshipStatusDetail() || "Relationship edges are indexed.";
    statusBanner.textContent = relationshipStatusDetail();
    statusBanner.classList.toggle("visible", partialRelationships || staleCompiler);
    const diagnosticsText = resultDiagnosticsText();
    resultBanner.textContent = diagnosticsText;
    resultBanner.classList.toggle("visible", diagnosticsText.length > 0);
    resultBanner.classList.toggle(
      "partial",
      Boolean(resultDiagnostics && resultDiagnostics.state === "partial"),
    );
    resultBanner.classList.toggle(
      "warning",
      Boolean(resultDiagnostics && resultDiagnostics.state === "warning"),
    );
    zoomLabel.textContent = Math.round(zoom * 100) + "%";
    pathModeButton.classList.toggle("active", pathMode);
    saveUiState();
    renderDetails(ids, visibleGraphEdges);
    renderList(ids);
  }

  function truncate(value, max) {
    return value.length > max ? value.slice(0, max - 1) + "…" : value;
  }

  function navigate(node) {
    vscode.postMessage({ type: "navigate", uri: node.uri, selectionRange: node.selectionRange });
  }

  function navigateRange(uri, range) {
    vscode.postMessage({ type: "navigate", uri, selectionRange: range });
  }

  function findPath(toId) {
    vscode.postMessage({
      type: "findPath",
      fromId: activeId,
      toId,
      edgeKinds: Array.from(visibleEdges),
    });
  }

  function setZoom(next) {
    zoom = Math.max(0.45, Math.min(1.8, next));
    saveUiState();
    render();
  }

  search.addEventListener("input", () => {
    query = search.value;
    resetRenderedNodeLimit();
    saveUiState();
    render();
  });
  scopeSelect.addEventListener("change", () => {
    scope = scopeSelect.value;
    resetRenderedNodeLimit();
    saveUiState();
    render();
  });
  qualitySelect.addEventListener("change", () => {
    quality = qualitySelect.value;
    resetRenderedNodeLimit();
    saveUiState();
    render();
  });
  nodeKindSelect.addEventListener("change", () => {
    nodeKind = nodeKindSelect.value;
    resetRenderedNodeLimit();
    saveUiState();
    render();
  });
  scopeSelect.value = scope;
  qualitySelect.value = quality;
  search.value = query;
  document.getElementById("zoomOut").addEventListener("click", () => setZoom(zoom - 0.1));
  document.getElementById("zoomIn").addEventListener("click", () => setZoom(zoom + 0.1));
  document.getElementById("fit").addEventListener("click", () => {
    setZoom(1);
    canvas.scrollTo({ top: 0, left: 0 });
  });
  showMoreNodesButton.addEventListener("click", () => {
    renderedNodeLimit = Math.min(maxRenderedNodeLimit, renderedNodeLimit + renderNodeLimitStep);
    saveUiState();
    render();
  });
  pathModeButton.addEventListener("click", () => {
    pathMode = !pathMode;
    saveUiState();
    render();
  });
  document.getElementById("serverSearch").addEventListener("click", () => {
    const serverQuery = search.value.trim();
    if (!serverQuery) {
      setStatus("Enter a symbol query first.");
      return;
    }
    setStatus("Searching project graph…");
    vscode.postMessage({ type: "searchGraph", query: serverQuery });
  });
  document.getElementById("serverQuery").addEventListener("click", () => {
    const serverQuery = search.value.trim();
    if (!activeId && !serverQuery) {
      setStatus("Select a graph node or enter a symbol query first.");
      return;
    }
    setStatus("Querying project graph…");
    vscode.postMessage({
      type: "queryGraph",
      kind: serverQueryKind.value,
      targetId: activeId || undefined,
      query: serverQuery,
    });
  });
  document.getElementById("workspace").addEventListener("click", () => {
    vscode.postMessage({ type: "loadWorkspace" });
  });
  document.getElementById("cursor").addEventListener("click", () => {
    vscode.postMessage({ type: "loadCursor" });
  });
  document.getElementById("rebuild").addEventListener("click", () => {
    setStatus("Rebuilding project graph…");
    vscode.postMessage({ type: "rebuild" });
  });
  document.getElementById("clearCache").addEventListener("click", () => {
    setStatus("Clearing graph cache…");
    vscode.postMessage({ type: "clearCache" });
  });

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.type === "setGraph" && message.graph) {
      if (message.clearQuery === true) {
        query = "";
        search.value = "";
      }
      resetRenderedNodeLimit();
      setGraph(message.graph, message.focusId, message.scope, message.stats, message.resultDiagnostics);
      if (typeof message.status === "string") setStatus(message.status);
      return;
    }
    if (message.type === "status" && typeof message.message === "string") {
      setStatus(message.message);
    }
  });

  let panStart = null;
  canvas.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".node")) return;
    panStart = { x: event.clientX, y: event.clientY, left: canvas.scrollLeft, top: canvas.scrollTop };
    canvas.classList.add("panning");
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!panStart) return;
    canvas.scrollLeft = panStart.left - (event.clientX - panStart.x);
    canvas.scrollTop = panStart.top - (event.clientY - panStart.y);
  });
  canvas.addEventListener("pointerup", (event) => {
    panStart = null;
    canvas.classList.remove("panning");
    canvas.releasePointerCapture(event.pointerId);
  });

  function saveUiState() {
    if (!vscode.setState) return;
    vscode.setState({
      activeId,
      query,
      scope,
      nodeKind,
      quality,
      zoom,
      pathMode,
      renderedNodeLimit,
      visibleEdges: Array.from(visibleEdges),
    });
  }

  renderEdgeControls();
  renderNodeKindOptions();
  render();
</script>
</body>
</html>`;
  }
}
