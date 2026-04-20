import * as vscode from "vscode";
import * as fs from "node:fs";

/**
 * Inheritance Graph — interactive webview visualizing the contract
 * inheritance hierarchy as a directed acyclic graph.
 *
 * Features:
 * - Parses all .sol files in the workspace to build the full graph
 * - Renders an interactive HTML/CSS graph (no external deps)
 * - Color-codes by kind: contract, interface, library, abstract
 * - Click a node to navigate to the contract definition
 * - Shows the full hierarchy for a selected contract
 */
export class InheritanceGraphPanel {
  private panel: vscode.WebviewPanel | undefined;

  activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.commands.registerCommand("solforge.inheritanceGraph", () =>
        this.showGraph(context),
      ),
    );
  }

  private async showGraph(_context: vscode.ExtensionContext): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showWarningMessage("Open a workspace first.");
      return;
    }

    const graph = await this.buildGraph(workspaceFolder.uri.fsPath);
    if (graph.nodes.length === 0) {
      vscode.window.showInformationMessage("No contracts found in the workspace.");
      return;
    }

    if (this.panel) {
      this.panel.reveal();
    } else {
      this.panel = vscode.window.createWebviewPanel(
        "solforge-inheritance-graph",
        "Inheritance Graph",
        vscode.ViewColumn.Beside,
        { enableScripts: true },
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });
    }

    this.panel.webview.html = this.buildHtml(graph);

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === "navigate" && msg.filePath) {
        const uri = vscode.Uri.file(msg.filePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: true });
      }
    });
  }

  private async buildGraph(_rootPath: string): Promise<ContractGraph> {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const nodeMap = new Map<string, GraphNode>();

    const solFiles = await vscode.workspace.findFiles("**/*.sol", "**/node_modules/**");

    for (const fileUri of solFiles) {
      try {
        const content = fs.readFileSync(fileUri.fsPath, "utf-8");
        this.extractContracts(content, fileUri.fsPath, nodeMap, edges);
      } catch {
        // Skip unreadable files
      }
    }

    nodes.push(...nodeMap.values());
    return { nodes, edges };
  }

  private extractContracts(
    content: string,
    filePath: string,
    nodeMap: Map<string, GraphNode>,
    edges: GraphEdge[],
  ): void {
    const contractRe =
      /(?:abstract\s+)?(contract|interface|library)\s+(\w+)(?:\s+is\s+([^{]+))?/g;
    let match: RegExpExecArray | null;

    while ((match = contractRe.exec(content)) !== null) {
      const kind = content.slice(match.index).startsWith("abstract") ? "abstract" : match[1];
      const name = match[2];
      const bases = match[3];

      if (!nodeMap.has(name)) {
        nodeMap.set(name, {
          name,
          kind: kind as GraphNode["kind"],
          filePath,
          line: content.slice(0, match.index).split("\n").length - 1,
        });
      }

      if (bases) {
        const baseNames = bases
          .split(",")
          .map((b) => b.trim().split("(")[0].trim())
          .filter(Boolean);
        for (const baseName of baseNames) {
          edges.push({ from: name, to: baseName });
          if (!nodeMap.has(baseName)) {
            nodeMap.set(baseName, {
              name: baseName,
              kind: "contract",
              filePath: "",
              line: 0,
            });
          }
        }
      }
    }
  }

  private buildHtml(graph: ContractGraph): string {
    const levels = this.computeLevels(graph);
    const maxLevel = Math.max(...Array.from(levels.values()), 0);

    const levelGroups = new Map<number, GraphNode[]>();
    for (const node of graph.nodes) {
      const level = levels.get(node.name) ?? 0;
      const group = levelGroups.get(level) ?? [];
      group.push(node);
      levelGroups.set(level, group);
    }

    const nodePositions = new Map<string, { x: number; y: number }>();
    const nodeWidth = 180;
    const nodeHeight = 44;
    const levelGap = 100;
    const nodeGap = 30;

    for (let level = 0; level <= maxLevel; level++) {
      const nodes = levelGroups.get(level) ?? [];
      const totalWidth = nodes.length * nodeWidth + (nodes.length - 1) * nodeGap;
      let startX = -totalWidth / 2;

      for (const node of nodes) {
        nodePositions.set(node.name, {
          x: startX + nodeWidth / 2,
          y: level * (nodeHeight + levelGap),
        });
        startX += nodeWidth + nodeGap;
      }
    }

    const svgWidth = Math.max(
      800,
      ...Array.from(nodePositions.values()).map((p) => Math.abs(p.x) * 2 + nodeWidth + 100),
    );
    const svgHeight = (maxLevel + 1) * (nodeHeight + levelGap) + 100;
    const offsetX = svgWidth / 2;
    const offsetY = 50;

    const edgesSvg = graph.edges
      .map((edge) => {
        const from = nodePositions.get(edge.from);
        const to = nodePositions.get(edge.to);
        if (!from || !to) return "";
        const x1 = from.x + offsetX;
        const y1 = from.y + nodeHeight + offsetY;
        const x2 = to.x + offsetX;
        const y2 = to.y + offsetY;
        const midY = (y1 + y2) / 2;
        return `<path d="M${x1},${y1} C${x1},${midY} ${x2},${midY} ${x2},${y2}" class="edge" marker-end="url(#arrow)"/>`;
      })
      .join("\n");

    const nodesSvg = graph.nodes
      .map((node) => {
        const pos = nodePositions.get(node.name);
        if (!pos) return "";
        const x = pos.x + offsetX - nodeWidth / 2;
        const y = pos.y + offsetY;
        const colorClass = `node-${node.kind}`;
        const clickData = node.filePath
          ? `onclick="navigate('${this.escapeJs(node.filePath)}')" style="cursor:pointer"`
          : "";
        return `<g ${clickData}>
          <rect x="${x}" y="${y}" width="${nodeWidth}" height="${nodeHeight}" rx="6" class="node-rect ${colorClass}"/>
          <text x="${x + nodeWidth / 2}" y="${y + 18}" class="node-name">${this.escapeHtml(node.name)}</text>
          <text x="${x + nodeWidth / 2}" y="${y + 34}" class="node-kind">${node.kind}</text>
        </g>`;
      })
      .join("\n");

    return `<!DOCTYPE html>
<html>
<head>
<style>
  body { margin: 0; padding: 0; overflow: auto; background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
  .toolbar { padding: 8px 16px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; align-items: center; gap: 12px; }
  .toolbar h3 { margin: 0; }
  .stats { opacity: 0.7; font-size: 0.9em; }
  svg { display: block; margin: 16px auto; }
  .edge { fill: none; stroke: var(--vscode-foreground); stroke-width: 1.5; opacity: 0.4; }
  .node-rect { stroke-width: 2; }
  .node-contract { fill: #2d5aa0; stroke: #4a9eff; }
  .node-interface { fill: #1a6e3a; stroke: #4ec96e; }
  .node-library { fill: #7a4a8e; stroke: #c678dd; }
  .node-abstract { fill: #6e5c1a; stroke: #e5c07b; }
  .node-name { fill: #fff; font-size: 13px; font-weight: bold; text-anchor: middle; }
  .node-kind { fill: #fff; font-size: 10px; text-anchor: middle; opacity: 0.7; }
  .legend { display: flex; gap: 16px; padding: 8px 16px; font-size: 0.85em; opacity: 0.8; }
  .legend-item { display: flex; align-items: center; gap: 4px; }
  .legend-swatch { width: 14px; height: 14px; border-radius: 3px; }
</style>
</head>
<body>
  <div class="toolbar">
    <h3>Inheritance Graph</h3>
    <span class="stats">${graph.nodes.length} contracts, ${graph.edges.length} inheritance edges</span>
  </div>
  <div class="legend">
    <div class="legend-item"><div class="legend-swatch" style="background:#2d5aa0;border:2px solid #4a9eff"></div>contract</div>
    <div class="legend-item"><div class="legend-swatch" style="background:#1a6e3a;border:2px solid #4ec96e"></div>interface</div>
    <div class="legend-item"><div class="legend-swatch" style="background:#7a4a8e;border:2px solid #c678dd"></div>library</div>
    <div class="legend-item"><div class="legend-swatch" style="background:#6e5c1a;border:2px solid #e5c07b"></div>abstract</div>
  </div>
  <svg width="${svgWidth}" height="${svgHeight}">
    <defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--vscode-foreground)" opacity="0.4"/>
      </marker>
    </defs>
    ${edgesSvg}
    ${nodesSvg}
  </svg>
  <script>
    const vscode = acquireVsCodeApi();
    function navigate(filePath) {
      vscode.postMessage({ type: 'navigate', filePath });
    }
  </script>
</body>
</html>`;
  }

  private computeLevels(graph: ContractGraph): Map<string, number> {
    const levels = new Map<string, number>();

    // inheritsFrom[X] = the contracts X inherits from
    const inheritsFrom = new Map<string, string[]>();
    for (const node of graph.nodes) {
      inheritsFrom.set(node.name, []);
    }
    for (const edge of graph.edges) {
      const parents = inheritsFrom.get(edge.from) ?? [];
      parents.push(edge.to);
      inheritsFrom.set(edge.from, parents);
    }

    // Topological sort: base contracts (no inheritance) at level 0
    const visited = new Set<string>();

    const computeLevel = (name: string): number => {
      if (levels.has(name)) return levels.get(name)!;
      if (visited.has(name)) return 0;
      visited.add(name);

      const parents = inheritsFrom.get(name) ?? [];
      if (parents.length === 0) {
        levels.set(name, 0);
        return 0;
      }

      const maxParent = Math.max(...parents.map((p) => computeLevel(p)));
      const level = maxParent + 1;
      levels.set(name, level);
      return level;
    };

    for (const node of graph.nodes) {
      computeLevel(node.name);
    }

    return levels;
  }

  private escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  private escapeJs(text: string): string {
    return text.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  }
}

interface GraphNode {
  name: string;
  kind: "contract" | "interface" | "library" | "abstract";
  filePath: string;
  line: number;
}

interface GraphEdge {
  from: string;
  to: string;
}

interface ContractGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
