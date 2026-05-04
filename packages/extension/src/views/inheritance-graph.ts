import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";
import {
  GetInheritanceGraph,
  type GetInheritanceGraphParams,
  type InheritanceGraphResult,
} from "@solidity-workbench/common";

/**
 * Inheritance Graph — interactive webview visualizing the contract
 * inheritance hierarchy as a directed graph.
 */
export class InheritanceGraphPanel {
  private panel: vscode.WebviewPanel | undefined;

  constructor(private client: LanguageClient) {}

  activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.commands.registerCommand("solidity-workbench.inheritanceGraph", () =>
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

    const focus = this.findActiveContract();
    const params: GetInheritanceGraphParams = {
      contractPath: focus?.filePath,
      contractName: focus?.name,
    };

    const graph = await this.client.sendRequest<InheritanceGraphResult>(
      GetInheritanceGraph,
      params,
    );
    if (graph.nodes.length === 0) {
      vscode.window.showInformationMessage("No contracts found in the workspace.");
      return;
    }

    if (this.panel) {
      this.panel.reveal();
    } else {
      this.panel = vscode.window.createWebviewPanel(
        "solidity-workbench-inheritance-graph",
        "Inheritance Graph",
        vscode.ViewColumn.Beside,
        { enableScripts: true },
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });

      this.panel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.type === "navigate" && typeof msg.uri === "string") {
          const uri = vscode.Uri.parse(msg.uri);
          const doc = await vscode.workspace.openTextDocument(uri);
          const selection =
            msg.selectionRange && typeof msg.selectionRange.start?.line === "number"
              ? new vscode.Selection(
                  msg.selectionRange.start.line,
                  msg.selectionRange.start.character,
                  msg.selectionRange.end.line,
                  msg.selectionRange.end.character,
                )
              : undefined;
          await vscode.window.showTextDocument(doc, { preview: true, selection });
        }
      });
    }

    this.panel.webview.html = this.buildHtml(graph);
  }

  private findActiveContract(): { name: string; filePath: string } | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== "solidity") return undefined;

    const text = editor.document.getText();
    const cursorOffset = editor.document.offsetAt(editor.selection.active);
    const contracts = this.extractContractRanges(text);
    const active =
      contracts.find((c) => c.start <= cursorOffset && cursorOffset <= c.end) ?? contracts[0];
    if (!active) return undefined;
    return { name: active.name, filePath: editor.document.uri.fsPath };
  }

  private extractContractRanges(text: string): { name: string; start: number; end: number }[] {
    const contracts: { name: string; start: number; end: number }[] = [];
    const re = /(?:abstract\s+)?(?:contract|interface|library)\s+([A-Za-z_$][\w$]*)\b/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const bodyStart = text.indexOf("{", re.lastIndex);
      contracts.push({
        name: match[1],
        start: match.index,
        end: bodyStart >= 0 ? this.findMatchingBrace(text, bodyStart) : re.lastIndex,
      });
    }
    return contracts;
  }

  private findMatchingBrace(text: string, start: number): number {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") {
        depth--;
        if (depth === 0) return i;
      }
    }
    return text.length;
  }

  private buildHtml(graph: InheritanceGraphResult): string {
    const graphJson = JSON.stringify(graph).replace(/</g, "\\u003c");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
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
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    overflow: hidden;
    background: var(--bg);
    color: var(--fg);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
  }
  .shell { display: grid; grid-template-rows: auto 1fr; height: 100vh; }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--border);
    min-width: 0;
  }
  .title { font-weight: 600; white-space: nowrap; }
  .stats { color: var(--muted); white-space: nowrap; }
  .spacer { flex: 1; }
  .controls {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  input[type="search"] {
    width: min(320px, 25vw);
    background: var(--input);
    color: var(--fg);
    border: 1px solid var(--border);
    padding: 5px 8px;
    outline: none;
  }
  input[type="search"]:focus { border-color: var(--accent); }
  label {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--muted);
    white-space: nowrap;
  }
  button {
    border: 1px solid var(--border);
    background: var(--button);
    color: var(--button-fg);
    padding: 5px 9px;
    cursor: pointer;
  }
  button:hover { border-color: var(--accent); }
  button.compact {
    min-width: 30px;
    padding-inline: 7px;
  }
  .zoom {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    min-width: 42px;
    text-align: center;
  }
  .canvas {
    position: relative;
    overflow: auto;
    height: 100%;
    cursor: grab;
  }
  .canvas.panning {
    cursor: grabbing;
    user-select: none;
  }
  svg { display: block; transform-origin: 0 0; }
  .lane-label {
    fill: var(--muted);
    font-size: 11px;
    text-anchor: middle;
  }
  .edge {
    fill: none;
    stroke: var(--muted);
    stroke-width: 1.4;
    opacity: 0.55;
  }
  .edge.highlight { stroke: var(--accent); opacity: 0.95; stroke-width: 2.2; }
  .node { cursor: pointer; }
  .node rect {
    stroke-width: 1.5;
    filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.25));
  }
  .node .name {
    fill: white;
    font-size: 13px;
    font-weight: 600;
    text-anchor: middle;
    pointer-events: none;
  }
  .node .meta {
    fill: rgba(255,255,255,0.72);
    font-size: 10px;
    text-anchor: middle;
    pointer-events: none;
  }
  .contract { fill: #2563eb; stroke: #60a5fa; }
  .interface { fill: #0f766e; stroke: #5eead4; }
  .library { fill: #7c3aed; stroke: #c4b5fd; }
  .abstract { fill: #a16207; stroke: #fde68a; }
  .unknown { fill: #4b5563; stroke: #9ca3af; stroke-dasharray: 4 3; }
  .focus rect { stroke: #ffffff; stroke-width: 3; }
  .dim { opacity: 0.23; }
  .empty {
    padding: 28px;
    color: var(--muted);
  }
</style>
</head>
<body>
  <div class="shell">
    <div class="toolbar">
      <span class="title">Inheritance Graph</span>
      <span class="stats" id="stats"></span>
      <input id="search" type="search" placeholder="Filter contracts">
      <label><input id="focused" type="checkbox" checked> Focus</label>
      <label><input id="tests" type="checkbox"> Tests</label>
      <label><input id="deps" type="checkbox"> Deps</label>
      <div class="spacer"></div>
      <div class="controls">
        <button class="compact" id="zoomOut" title="Zoom out">-</button>
        <span class="zoom" id="zoomLabel">100%</span>
        <button class="compact" id="zoomIn" title="Zoom in">+</button>
        <button id="fit" title="Fit graph to the current panel">Fit</button>
        <button id="reset" title="Reset zoom and scroll">Reset</button>
      </div>
    </div>
    <div class="canvas" id="canvas"></div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const graph = ${graphJson};
    const state = {
      search: "",
      focused: Boolean(graph.focusId),
      tests: false,
      deps: false,
      zoom: 1,
      autoFit: true,
    };
    let svgSize = { width: 0, height: 0 };
    let isPanning = false;
    let panStart = { x: 0, y: 0, left: 0, top: 0 };

    const els = {
      canvas: document.getElementById("canvas"),
      stats: document.getElementById("stats"),
      search: document.getElementById("search"),
      focused: document.getElementById("focused"),
      tests: document.getElementById("tests"),
      deps: document.getElementById("deps"),
      fit: document.getElementById("fit"),
      reset: document.getElementById("reset"),
      zoomIn: document.getElementById("zoomIn"),
      zoomOut: document.getElementById("zoomOut"),
      zoomLabel: document.getElementById("zoomLabel"),
    };
    els.focused.checked = state.focused;
    els.focused.disabled = !graph.focusId;

    const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
    const ancestors = new Set();
    const descendants = new Set();
    if (graph.focusId) {
      walk(graph.focusId, "up", ancestors);
      walk(graph.focusId, "down", descendants);
    }

    function walk(id, direction, out) {
      for (const edge of graph.edges) {
        const next = direction === "up" && edge.from === id
          ? edge.to
          : direction === "down" && edge.to === id
            ? edge.from
            : null;
        if (!next || out.has(next)) continue;
        out.add(next);
        walk(next, direction, out);
      }
    }

    function visibleNode(node) {
      if (!state.tests && node.tier === "tests") return false;
      if (!state.deps && node.tier === "deps") return false;
      if (state.focused && graph.focusId) {
        if (node.id !== graph.focusId && !ancestors.has(node.id) && !descendants.has(node.id)) {
          return false;
        }
      }
      if (state.search) {
        return node.name.toLowerCase().includes(state.search);
      }
      return true;
    }

    function render() {
      const visibleNodes = graph.nodes.filter(visibleNode);
      const visibleIds = new Set(visibleNodes.map((n) => n.id));
      const visibleEdges = graph.edges.filter((e) => visibleIds.has(e.from) && visibleIds.has(e.to));
      els.stats.textContent = visibleNodes.length + " nodes, " + visibleEdges.length + " edges";

      if (visibleNodes.length === 0) {
        els.canvas.innerHTML = '<div class="empty">No matching contracts.</div>';
        return;
      }

      const levels = computeLevels(visibleNodes, visibleEdges);
      const groups = new Map();
      for (const node of visibleNodes) {
        const level = levels.get(node.id) ?? 0;
        const list = groups.get(level) ?? [];
        list.push(node);
        groups.set(level, list);
      }
      for (const list of groups.values()) {
        list.sort((a, b) => a.name.localeCompare(b.name));
      }

      const nodeWidth = 190;
      const nodeHeight = 50;
      const xGap = 38;
      const yGap = 96;
      const pad = 48;
      const maxLevel = Math.max(...groups.keys());
      const maxCount = Math.max(...Array.from(groups.values()).map((g) => g.length));
      const width = Math.max(920, pad * 2 + maxCount * nodeWidth + (maxCount - 1) * xGap);
      const height = Math.max(520, pad * 2 + (maxLevel + 1) * nodeHeight + maxLevel * yGap);
      const positions = new Map();

      for (const [level, list] of groups) {
        const rowWidth = list.length * nodeWidth + Math.max(0, list.length - 1) * xGap;
        let x = (width - rowWidth) / 2;
        const y = pad + level * (nodeHeight + yGap);
        for (const node of list) {
          positions.set(node.id, { x, y });
          x += nodeWidth + xGap;
        }
      }

      const highlighted = new Set([graph.focusId, ...ancestors, ...descendants]);
      const edges = visibleEdges.map((edge) => {
        const from = positions.get(edge.to);
        const to = positions.get(edge.from);
        if (!from || !to) return "";
        const x1 = from.x + nodeWidth / 2;
        const y1 = from.y + nodeHeight;
        const x2 = to.x + nodeWidth / 2;
        const y2 = to.y;
        const midY = (y1 + y2) / 2;
        const cls = highlighted.has(edge.from) && highlighted.has(edge.to) ? "edge highlight" : "edge";
        return '<path class="' + cls + '" d="M' + x1 + ',' + y1 + ' C' + x1 + ',' + midY + ' ' + x2 + ',' + midY + ' ' + x2 + ',' + y2 + '" marker-end="url(#arrow)"></path>';
      }).join("");

      const lanes = Array.from(groups.keys()).map((level) => {
        const y = pad + level * (nodeHeight + yGap) - 18;
        return '<text class="lane-label" x="' + width / 2 + '" y="' + y + '">' + laneLabel(level, maxLevel) + '</text>';
      }).join("");

      const nodes = visibleNodes.map((node) => {
        const p = positions.get(node.id);
        const cls = ["node", node.kind, node.id === graph.focusId ? "focus" : "", graph.focusId && !highlighted.has(node.id) ? "dim" : ""].filter(Boolean).join(" ");
        const meta = (node.missing ? "unresolved" : node.kind) + " - " + node.tier;
        return '<g class="' + cls + '" data-id="' + escAttr(node.id) + '">' +
          '<title>' + esc(node.name) + (node.filePath ? "\\n" + esc(node.filePath) : "") + '</title>' +
          '<rect x="' + p.x + '" y="' + p.y + '" width="' + nodeWidth + '" height="' + nodeHeight + '" rx="6"></rect>' +
          '<text class="name" x="' + (p.x + nodeWidth / 2) + '" y="' + (p.y + 21) + '">' + esc(trimLabel(node.name, 22)) + '</text>' +
          '<text class="meta" x="' + (p.x + nodeWidth / 2) + '" y="' + (p.y + 38) + '">' + esc(meta) + '</text>' +
          '</g>';
      }).join("");

      els.canvas.innerHTML = '<svg width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">' +
        '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="var(--muted)"></path></marker></defs>' +
        lanes + edges + nodes + '</svg>';
      svgSize = { width, height };
      if (state.autoFit) fitToView(false);
      else applyZoom();

      for (const el of els.canvas.querySelectorAll(".node")) {
        el.addEventListener("click", () => {
          const node = nodesById.get(el.dataset.id);
          if (!node || !node.uri) return;
          vscode.postMessage({ type: "navigate", uri: node.uri, selectionRange: node.selectionRange });
        });
      }
    }

    function applyZoom() {
      const svg = els.canvas.querySelector("svg");
      if (!svg) return;
      svg.style.width = Math.round(svgSize.width * state.zoom) + "px";
      svg.style.height = Math.round(svgSize.height * state.zoom) + "px";
      els.zoomLabel.textContent = Math.round(state.zoom * 100) + "%";
    }

    function setZoom(nextZoom, anchor) {
      const previous = state.zoom;
      state.zoom = Math.max(0.25, Math.min(2.5, nextZoom));
      state.autoFit = false;
      applyZoom();
      if (!anchor || previous === 0) return;
      const ratio = state.zoom / previous;
      els.canvas.scrollLeft = (els.canvas.scrollLeft + anchor.x) * ratio - anchor.x;
      els.canvas.scrollTop = (els.canvas.scrollTop + anchor.y) * ratio - anchor.y;
    }

    function fitToView(smooth) {
      if (svgSize.width === 0 || svgSize.height === 0) return;
      const xScale = (els.canvas.clientWidth - 32) / svgSize.width;
      const yScale = (els.canvas.clientHeight - 32) / svgSize.height;
      state.zoom = Math.max(0.25, Math.min(1.25, xScale, yScale));
      state.autoFit = true;
      applyZoom();
      els.canvas.scrollTo({
        left: 0,
        top: 0,
        behavior: smooth ? "smooth" : "auto",
      });
    }

    function resetView() {
      state.zoom = 1;
      state.autoFit = false;
      applyZoom();
      els.canvas.scrollTo({ left: 0, top: 0, behavior: "smooth" });
    }

    function computeLevels(nodes, edges) {
      const levels = new Map();
      const parents = new Map(nodes.map((n) => [n.id, []]));
      for (const edge of edges) {
        if (parents.has(edge.from)) parents.get(edge.from).push(edge.to);
      }
      function level(id, stack = new Set()) {
        if (levels.has(id)) return levels.get(id);
        if (stack.has(id)) return 0;
        stack.add(id);
        const ps = parents.get(id) ?? [];
        const value = ps.length === 0 ? 0 : Math.max(...ps.map((p) => level(p, stack))) + 1;
        stack.delete(id);
        levels.set(id, value);
        return value;
      }
      for (const node of nodes) level(node.id);
      return levels;
    }

    function laneLabel(level, maxLevel) {
      if (level === 0) return "Base contracts";
      if (level === maxLevel) return "Most-derived contracts";
      return "Level " + level;
    }
    function trimLabel(value, max) {
      return value.length <= max ? value : value.slice(0, max - 1) + "...";
    }
    function esc(value) {
      return String(value).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
    }
    function escAttr(value) {
      return esc(value).replace(/'/g, "&#39;");
    }

    els.search.addEventListener("input", () => {
      state.search = els.search.value.trim().toLowerCase();
      render();
    });
    els.focused.addEventListener("change", () => { state.focused = els.focused.checked; render(); });
    els.tests.addEventListener("change", () => { state.tests = els.tests.checked; render(); });
    els.deps.addEventListener("change", () => { state.deps = els.deps.checked; render(); });
    els.zoomOut.addEventListener("click", () => {
      setZoom(state.zoom - 0.15, { x: els.canvas.clientWidth / 2, y: els.canvas.clientHeight / 2 });
    });
    els.zoomIn.addEventListener("click", () => {
      setZoom(state.zoom + 0.15, { x: els.canvas.clientWidth / 2, y: els.canvas.clientHeight / 2 });
    });
    els.fit.addEventListener("click", () => fitToView(true));
    els.reset.addEventListener("click", resetView);
    els.canvas.addEventListener("wheel", (event) => {
      if (!event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      setZoom(state.zoom + (event.deltaY < 0 ? 0.1 : -0.1), {
        x: event.clientX - els.canvas.getBoundingClientRect().left,
        y: event.clientY - els.canvas.getBoundingClientRect().top,
      });
    }, { passive: false });
    els.canvas.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest(".node")) return;
      isPanning = true;
      panStart = {
        x: event.clientX,
        y: event.clientY,
        left: els.canvas.scrollLeft,
        top: els.canvas.scrollTop,
      };
      els.canvas.classList.add("panning");
      els.canvas.setPointerCapture(event.pointerId);
    });
    els.canvas.addEventListener("pointermove", (event) => {
      if (!isPanning) return;
      els.canvas.scrollLeft = panStart.left - (event.clientX - panStart.x);
      els.canvas.scrollTop = panStart.top - (event.clientY - panStart.y);
    });
    els.canvas.addEventListener("pointerup", (event) => {
      isPanning = false;
      els.canvas.classList.remove("panning");
      els.canvas.releasePointerCapture(event.pointerId);
    });
    window.addEventListener("resize", () => {
      if (state.autoFit) fitToView(false);
    });

    render();
  </script>
</body>
</html>`;
  }
}
