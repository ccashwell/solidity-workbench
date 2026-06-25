import { URI } from "vscode-uri";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ContractDefinition,
  FunctionDefinition,
  ModifierDefinition,
  ProjectGraphEdge,
  ProjectGraphEdgeKind,
  ProjectGraphEdgeEvidence,
  ProjectGraphNode,
  ProjectGraphNodeKind,
  ProjectGraphPathResult,
  ProjectGraphResolutionConfidence,
  ProjectGraphResult,
  ProjectGraphStatsResult,
  SourceRange,
  GetProjectGraphNeighborhoodParams,
  GetProjectGraphPathParams,
  ProjectGraphEndpoint,
  ProjectGraphSearchMatch,
  ProjectGraphSearchResult,
  StateVariableDeclaration,
  EventDefinition,
  ErrorDefinition,
  StructDefinition,
  EnumDefinition,
  UserDefinedValueTypeDefinition,
  FileConstantDefinition,
  SearchProjectGraphParams,
} from "@solidity-workbench/common";
import type { SymbolIndex } from "./symbol-index.js";
import type { SolcBridge } from "../compiler/solc-bridge.js";
import type { SolidityParser } from "../parser/solidity-parser.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";
import type { ResolvedContract, SemanticResolver } from "./semantic-resolver.js";
import { CALL_LIKE_KEYWORDS, extractDottedReceiver, isSolidityBuiltinType } from "../utils/text.js";
import { SOLIDITY_KEYWORDS } from "../utils/text.js";
import { normalizeTypeName, resolveDottedReceiverTypeName } from "../utils/receiver-type.js";
import { findUsingForFunction } from "../utils/using-for.js";

export type SolidityGraphNodeKind = ProjectGraphNodeKind;
export type SolidityGraphEdgeKind = ProjectGraphEdgeKind;
export type SolidityGraphNode = ProjectGraphNode;
export type SolidityGraphEdge = ProjectGraphEdge;
export type GraphDependencyIndexingMode = "disabled" | "declarations" | "relationships";

export interface GraphRelationshipIndexBatchResult {
  filesIndexed: number;
  filesTotal: number;
  filesRemaining: number;
  complete: boolean;
  durationMs: number;
}

interface FunctionBody {
  text: string;
  startLine: number;
  startCharacter: number;
  newlineOffsets: number[];
}

interface RawAstNode {
  type?: string;
  name?: string;
  memberName?: string;
  operator?: string;
  isPrefix?: boolean;
  range?: [number, number];
  loc?: {
    start?: { line?: number; column?: number };
    end?: { line?: number; column?: number };
  };
  children?: RawAstNode[];
  subNodes?: RawAstNode[];
  body?: RawAstNode;
  statements?: RawAstNode[];
  expression?: RawAstNode;
  eventCall?: RawAstNode;
  revertCall?: RawAstNode;
  typeName?: RawAstNode | string;
  arguments?: RawAstNode[];
  left?: RawAstNode;
  right?: RawAstNode;
  base?: RawAstNode;
  index?: RawAstNode;
  condition?: RawAstNode;
  trueBody?: RawAstNode;
  falseBody?: RawAstNode;
  subExpression?: RawAstNode;
  variables?: (RawAstNode | null | undefined)[];
  initialValue?: RawAstNode;
  identifier?: RawAstNode;
}

interface StateVariableTarget {
  name: string;
  filePath: string;
  containerName: string | undefined;
  nameRange: SourceRange;
}

interface ContractIndexContext {
  rawContractNode?: RawAstNode;
  stateTargets: StateVariableTarget[];
}

interface ExpressionContext {
  assignmentTarget?: boolean;
  compoundAssignmentTarget?: boolean;
}

interface SolcDeclarationMetadata {
  solcDeclarationId: number;
  solcDeclarationFilePath?: string;
  solcDeclarationOffset?: number;
  solcDeclarationLength?: number;
  solcNodeType?: string;
  solcName?: string;
  solcTargetUnmapped?: true;
  resolutionConfidence: "solc";
}

interface ResolvedGraphTarget {
  node: SolidityGraphNode;
  metadata: SolcDeclarationMetadata | { resolutionConfidence: "parser" | "heuristic" };
}

const ZERO_RANGE: SourceRange = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 0 },
};

const CACHE_VERSION = 3;

const CALL_TARGET_NODE_KINDS = new Set<SolidityGraphNodeKind>(["function", "modifier"]);
const EVENT_TARGET_NODE_KINDS = new Set<SolidityGraphNodeKind>(["event"]);
const ERROR_TARGET_NODE_KINDS = new Set<SolidityGraphNodeKind>(["error"]);
const STATE_TARGET_NODE_KINDS = new Set<SolidityGraphNodeKind>(["stateVariable"]);
const CONTRACT_TARGET_NODE_KINDS = new Set<SolidityGraphNodeKind>([
  "contract",
  "interface",
  "library",
]);
const TYPE_TARGET_NODE_KINDS = new Set<SolidityGraphNodeKind>([
  "contract",
  "interface",
  "library",
  "struct",
  "enum",
  "userDefinedValueType",
]);
const LOW_LEVEL_EXTERNAL_CALL_NAMES = new Set(["call", "staticcall"]);
const VALID_NODE_KINDS = new Set<SolidityGraphNodeKind>([
  "file",
  "contract",
  "interface",
  "library",
  "function",
  "constructor",
  "receive",
  "fallback",
  "modifier",
  "event",
  "error",
  "stateVariable",
  "fileConstant",
  "struct",
  "enum",
  "userDefinedValueType",
]);
const VALID_EDGE_KINDS = new Set<SolidityGraphEdgeKind>([
  "contains",
  "imports",
  "inherits",
  "implements",
  "overrides",
  "calls",
  "externalCall",
  "delegateCall",
  "creates",
  "usesModifier",
  "reads",
  "writes",
  "emits",
  "revertsWith",
  "usesType",
]);
const VALID_RESOLUTION_CONFIDENCE = new Set<ProjectGraphResolutionConfidence>([
  "solc",
  "parser",
  "heuristic",
  "unknown",
]);

interface GraphIndexCacheFile {
  version: number;
  workspaceFingerprint: string;
  files: GraphIndexCacheFileEntry[];
  createdAt: string;
}

interface GraphIndexCacheFileEntry {
  uri: string;
  filePath: string;
  fingerprint: string;
  relationshipsComplete: boolean;
  nodes: SolidityGraphNode[];
  edges: SolidityGraphEdge[];
}

/**
 * In-memory semantic graph over indexed Solidity files.
 *
 * This intentionally starts as a provider-facing index rather than a durable
 * database. The server already parses and indexes the project for LSP features;
 * GraphIndex normalizes those extracted declarations and relationships into a
 * single queryable shape that providers can share.
 */
export class GraphIndex {
  private nodes = new Map<string, SolidityGraphNode>();
  private edges: SolidityGraphEdge[] = [];
  private edgeKeys = new Set<string>();
  private edgesBySource = new Map<string, SolidityGraphEdge[]>();
  private edgesByTarget = new Map<string, SolidityGraphEdge[]>();
  private edgesByKind = new Map<SolidityGraphEdgeKind, SolidityGraphEdge[]>();
  private importSourcesByTarget = new Map<string, string[]>();
  private nodeIdsByFile = new Map<string, Set<string>>();
  private relationshipIndexedUris = new Set<string>();
  private relationshipQueue: string[] = [];
  private relationshipQueuedUris = new Set<string>();
  private typeNodeIdCache = new Map<string, string | undefined>();
  private memberNodeIdCache = new Map<string, string | undefined>();
  private contractMemberNodeIdCache = new Map<string, string | undefined>();
  private lastRebuildDurationMs: number | null = null;
  private lastUpdateDurationMs: number | null = null;
  private lastCacheRestoreDurationMs: number | null = null;
  private lastCacheWriteDurationMs: number | null = null;
  private cacheHit = false;
  private solcBridge: SolcBridge | null = null;
  private dependencyIndexing: GraphDependencyIndexingMode = "disabled";

  constructor(
    private parser: SolidityParser,
    private workspace: WorkspaceManager,
    private resolver: SemanticResolver,
    private symbolIndex?: SymbolIndex,
  ) {}

  setSolcBridge(bridge: SolcBridge): void {
    this.solcBridge = bridge;
  }

  setDependencyIndexing(mode: GraphDependencyIndexingMode): boolean {
    if (this.dependencyIndexing === mode) return false;
    this.dependencyIndexing = mode;
    this.relationshipQueue = this.relationshipFileUris(this.relationshipQueue);
    this.relationshipQueuedUris = new Set(this.relationshipQueue);
    return true;
  }

  restoreFromCache(cacheDir: string | undefined): boolean {
    const startedAt = Date.now();
    this.cacheHit = false;
    this.lastCacheRestoreDurationMs = null;
    if (!cacheDir) return false;

    try {
      const cachePath = this.cachePath(cacheDir);
      if (!fs.existsSync(cachePath)) return false;
      const raw = fs.readFileSync(cachePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<GraphIndexCacheFile>;
      if (
        parsed.version !== CACHE_VERSION ||
        parsed.workspaceFingerprint !== this.workspaceFingerprint() ||
        !Array.isArray(parsed.files)
      ) {
        return false;
      }

      const currentUris = new Set(this.graphFileUris());
      const restoredEntries: GraphIndexCacheFileEntry[] = [];
      const nodes: SolidityGraphNode[] = [];
      for (const entry of parsed.files) {
        if (!this.isCacheEntry(entry)) continue;
        if (!currentUris.has(entry.uri)) continue;
        const fingerprint = this.fileFingerprint(entry.uri);
        if (!fingerprint || fingerprint !== entry.fingerprint) continue;
        const entryNodes = entry.nodes.filter((node): node is SolidityGraphNode =>
          this.isCacheNode(node),
        );
        if (entryNodes.length === 0) continue;
        restoredEntries.push({ ...entry, nodes: entryNodes });
        nodes.push(...entryNodes);
      }

      const nodeIds = new Set(nodes.map((node) => node.id));
      const edges: SolidityGraphEdge[] = [];
      const relationshipIndexedUris = new Set<string>();
      for (const entry of restoredEntries) {
        let droppedEdge = false;
        for (const edge of entry.edges) {
          if (this.isCacheEdge(edge) && nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
            edges.push(edge);
          } else {
            droppedEdge = true;
          }
        }
        if (entry.relationshipsComplete && !droppedEdge) {
          relationshipIndexedUris.add(entry.uri);
        }
      }

      this.nodes = new Map(nodes.map((node) => [node.id, node]));
      this.edges = edges;
      this.rebuildEdgeIndexes();
      this.rebuildNodeIdsByFile();
      this.relationshipIndexedUris = relationshipIndexedUris;
      this.relationshipQueue = [];
      this.relationshipQueuedUris.clear();
      this.cacheHit = nodes.length > 0;
      this.lastCacheRestoreDurationMs = Date.now() - startedAt;
      return this.cacheHit;
    } catch {
      return false;
    } finally {
      if (this.lastCacheRestoreDurationMs === null) {
        this.lastCacheRestoreDurationMs = Date.now() - startedAt;
      }
    }
  }

  writeCache(cacheDir: string | undefined): void {
    const startedAt = Date.now();
    this.lastCacheWriteDurationMs = null;
    if (!cacheDir) return;

    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      const cachePath = this.cachePath(cacheDir);
      const payload: GraphIndexCacheFile = {
        version: CACHE_VERSION,
        workspaceFingerprint: this.workspaceFingerprint(),
        files: this.cacheFileEntries(),
        createdAt: new Date().toISOString(),
      };
      const tmpPath = `${cachePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(payload), "utf-8");
      fs.renameSync(tmpPath, cachePath);
      this.lastCacheWriteDurationMs = Date.now() - startedAt;
    } catch {
      // The cache is an optimization only. Indexing must keep working
      // even when storage is unavailable or contains stale partial files.
    } finally {
      if (this.lastCacheWriteDurationMs === null) {
        this.lastCacheWriteDurationMs = Date.now() - startedAt;
      }
    }
  }

  rebuildWorkspace(): void {
    const startedAt = Date.now();
    const uris = this.resetWorkspaceGraph();
    this.resolver.invalidate();
    for (const uri of uris) this.updateFile(uri, false, false);
    for (const uri of this.relationshipFileUris(uris)) {
      this.indexFileRelationships(uri);
      this.relationshipIndexedUris.add(uri);
    }
    this.lastRebuildDurationMs = Date.now() - startedAt;
  }

  rebuildWorkspaceDeclarations(): void {
    const startedAt = Date.now();
    const uris = this.resetWorkspaceGraph();
    this.resolver.invalidate();
    for (const uri of uris) this.updateFile(uri, false, false);
    this.enqueueRelationshipFiles(uris);
    this.lastRebuildDurationMs = Date.now() - startedAt;
  }

  ensureWorkspaceDeclarations(): void {
    const startedAt = Date.now();
    const uris = this.prioritizeWorkspaceUris(this.graphFileUris());
    this.resolver.invalidate();
    for (const uri of uris) {
      if (this.nodeIdsByFile.has(uri) && this.nodes.has(this.fileNodeId(uri))) continue;
      this.updateFile(uri, false, false);
    }
    this.enqueueRelationshipFiles(uris.filter((uri) => !this.relationshipIndexedUris.has(uri)));
    this.lastRebuildDurationMs = Date.now() - startedAt;
  }

  indexRelationshipBatch(budgetMs = 30, maxFiles = 25): GraphRelationshipIndexBatchResult {
    const startedAt = Date.now();
    let indexedInBatch = 0;
    const budget = Math.max(1, budgetMs);
    const fileLimit = Math.max(1, maxFiles);

    while (
      this.relationshipQueue.length > 0 &&
      indexedInBatch < fileLimit &&
      (indexedInBatch === 0 || Date.now() - startedAt < budget)
    ) {
      const uri = this.relationshipQueue.shift()!;
      this.relationshipQueuedUris.delete(uri);
      if (this.relationshipIndexedUris.has(uri)) continue;
      if (!this.parser.get(uri)) continue;

      this.indexFileRelationships(uri);
      this.relationshipIndexedUris.add(uri);
      indexedInBatch++;
    }

    const durationMs = Date.now() - startedAt;
    const progress = this.relationshipProgress();
    return {
      filesIndexed: progress.indexed,
      filesTotal: progress.total,
      filesRemaining: progress.remaining,
      complete: this.isRelationshipIndexComplete(),
      durationMs,
    };
  }

  ensureFileRelationships(uri: string): void {
    if (this.relationshipIndexedUris.has(uri)) return;
    if (!this.parser.get(uri)) return;
    this.relationshipQueuedUris.delete(uri);
    this.relationshipQueue = this.relationshipQueue.filter((queuedUri) => queuedUri !== uri);
    this.indexFileRelationships(uri);
    this.relationshipIndexedUris.add(uri);
  }

  isRelationshipIndexComplete(): boolean {
    return this.relationshipProgress().remaining === 0;
  }

  updateFile(uri: string, includeRelationshipEdges = true, invalidateResolver = true): void {
    const startedAt = Date.now();
    this.clearResolutionCaches();
    if (invalidateResolver) this.resolver.invalidate(uri);
    this.clearFileForUpdate(uri);
    const result = this.parser.get(uri);
    if (!result) {
      this.lastUpdateDurationMs = Date.now() - startedAt;
      return;
    }

    const fileNode = this.fileNode(uri);
    this.addNode(fileNode);

    for (const imp of result.sourceUnit.imports) {
      const targetPath = this.resolveImport(uri, imp.path);
      const targetId = targetPath ? this.fileNodeId(URI.file(targetPath).toString()) : "";
      if (!targetId) continue;
      this.addEdge({
        source: fileNode.id,
        target: targetId,
        kind: "imports",
        range: imp.range,
        metadata: { importPath: imp.path },
      });
    }

    for (const fn of result.sourceUnit.freeFunctions) {
      this.indexFunction(uri, fileNode.id, undefined, fn);
    }

    for (const err of result.sourceUnit.errors) {
      this.indexDeclarable(uri, fileNode.id, "error", err.name, err.range, err.nameRange);
    }

    for (const constant of result.sourceUnit.fileConstants) {
      this.indexFileConstant(uri, fileNode.id, constant);
    }

    for (const struct of result.sourceUnit.structs) {
      this.indexStruct(uri, fileNode.id, struct);
    }

    for (const enumDef of result.sourceUnit.enums) {
      this.indexEnum(uri, fileNode.id, enumDef);
    }

    for (const udvt of result.sourceUnit.userDefinedValueTypes) {
      this.indexUserDefinedValueType(uri, fileNode.id, udvt);
    }

    for (const usingFor of result.sourceUnit.usingFor) {
      if (usingFor.libraryName) {
        this.addUsesTypeEdges(fileNode.id, uri, [
          { typeName: usingFor.libraryName, metadata: { usage: "usingLibrary" } },
        ]);
      }
      if (usingFor.typeName) {
        this.addUsesTypeEdges(fileNode.id, uri, [
          { typeName: usingFor.typeName, metadata: { usage: "usingType" } },
        ]);
      }
    }

    for (const contract of result.sourceUnit.contracts) {
      this.indexContractHeader(uri, fileNode.id, contract);
    }

    for (const contract of result.sourceUnit.contracts) {
      this.indexContractMemberDeclarations(uri, this.contractNodeId(uri, contract.name), contract);
    }

    if (includeRelationshipEdges) {
      this.indexFileRelationships(uri);
      this.relationshipIndexedUris.add(uri);
    }
    this.lastUpdateDurationMs = Date.now() - startedAt;
  }

  private indexFileRelationships(uri: string): void {
    const result = this.parser.get(uri);
    if (!result) return;
    const text = this.parser.getText(uri) ?? "";
    for (const contract of result.sourceUnit.contracts) {
      this.indexContract(uri, contract, text);
    }
  }

  updateFileAndDependents(uri: string, includeRelationshipEdges = true): string[] {
    const dependents = this.collectImportDependents(uri);
    this.resolver.invalidate();
    this.updateFile(uri, includeRelationshipEdges, false);
    for (const dependentUri of dependents) {
      this.updateFile(dependentUri, includeRelationshipEdges, false);
    }
    const refreshedUris = [uri, ...dependents];
    if (!includeRelationshipEdges) this.enqueueRelationshipFiles(refreshedUris);
    return refreshedUris;
  }

  removeFile(uri: string, invalidateResolver = true): void {
    const removed = this.nodeIdsByFile.get(uri);
    if (!removed) return;
    this.clearResolutionCaches();
    if (invalidateResolver) this.resolver.invalidate(uri);

    for (const id of removed) this.nodes.delete(id);
    this.edges = this.edges.filter(
      (edge) => !removed.has(edge.source) && !removed.has(edge.target),
    );
    this.rebuildEdgeIndexes();
    this.relationshipIndexedUris.delete(uri);
    this.relationshipQueuedUris.delete(uri);
    this.relationshipQueue = this.relationshipQueue.filter((queuedUri) => queuedUri !== uri);
    this.nodeIdsByFile.delete(uri);
  }

  removeFileAndDependents(uri: string, includeRelationshipEdges = true): string[] {
    const dependents = this.collectImportDependents(uri);
    this.resolver.invalidate();
    this.removeFile(uri, false);
    for (const dependentUri of dependents) {
      this.updateFile(dependentUri, includeRelationshipEdges, false);
    }
    if (!includeRelationshipEdges) this.enqueueRelationshipFiles(dependents);
    return [uri, ...dependents];
  }

  private clearFileForUpdate(uri: string): void {
    const removed = this.nodeIdsByFile.get(uri);
    if (!removed) return;
    this.clearResolutionCaches();

    for (const id of removed) this.nodes.delete(id);
    this.edges = this.edges.filter(
      (edge) => !removed.has(edge.source) && !removed.has(edge.target),
    );
    this.rebuildEdgeIndexes();
    this.relationshipIndexedUris.delete(uri);
    this.relationshipQueuedUris.delete(uri);
    this.relationshipQueue = this.relationshipQueue.filter((queuedUri) => queuedUri !== uri);
    this.nodeIdsByFile.delete(uri);
  }

  getNode(id: string): SolidityGraphNode | undefined {
    return this.nodes.get(id);
  }

  getNodes(): SolidityGraphNode[] {
    return Array.from(this.nodes.values());
  }

  getEdges(kind?: SolidityGraphEdgeKind): SolidityGraphEdge[] {
    return kind ? (this.edgesByKind.get(kind) ?? []).slice() : this.edges.slice();
  }

  getContractNodes(): SolidityGraphNode[] {
    return this.getNodes().filter(
      (node) => node.kind === "contract" || node.kind === "interface" || node.kind === "library",
    );
  }

  getOutgoingEdges(source: string, kind?: SolidityGraphEdgeKind): SolidityGraphEdge[] {
    const edges = this.edgesBySource.get(source) ?? [];
    return kind ? edges.filter((edge) => edge.kind === kind) : edges.slice();
  }

  getIncomingEdges(target: string, kind?: SolidityGraphEdgeKind): SolidityGraphEdge[] {
    const edges = this.edgesByTarget.get(target) ?? [];
    return kind ? edges.filter((edge) => edge.kind === kind) : edges.slice();
  }

  toProjectGraph(edgeKinds?: ProjectGraphEdgeKind[], maxNodes?: number): ProjectGraphResult {
    const allowed = edgeKinds?.length ? new Set<ProjectGraphEdgeKind>(edgeKinds) : null;
    let nodes = this.getNodes();
    let edges = allowed ? this.edges.filter((edge) => allowed.has(edge.kind)) : this.edges;
    const limit = maxNodes === undefined ? undefined : Math.max(1, Math.min(maxNodes, 10_000));
    let truncated = false;
    if (limit !== undefined && nodes.length > limit) {
      truncated = true;
      nodes = this.prioritizeGraphNodes(nodes).slice(0, limit);
      const included = new Set(nodes.map((node) => node.id));
      edges = edges.filter((edge) => included.has(edge.source) && included.has(edge.target));
    }
    return {
      nodes,
      edges: edges.slice(),
      truncated,
    };
  }

  search(params: SearchProjectGraphParams): ProjectGraphSearchResult {
    const rawQuery = params.query.trim();
    if (!rawQuery) return { query: params.query, matches: [] };

    const query = normalizeSearchText(rawQuery);
    const allowedKinds = params.kinds?.length ? new Set<ProjectGraphNodeKind>(params.kinds) : null;
    const maxResults = Math.max(1, Math.min(params.maxResults ?? 50, 500));
    const maxEdgesPerNode = Math.max(0, Math.min(params.maxEdgesPerNode ?? 32, 250));
    const edgeKinds = params.edgeKinds?.length
      ? new Set<ProjectGraphEdgeKind>(params.edgeKinds)
      : null;

    const ranked: ProjectGraphSearchMatch[] = [];
    for (const node of this.nodes.values()) {
      if (allowedKinds && !allowedKinds.has(node.kind)) continue;
      const match = scoreGraphNodeSearch(node, query);
      if (!match) continue;
      ranked.push({
        node,
        score: match.score,
        matchedText: match.matchedText,
      });
    }

    ranked.sort((a, b) => {
      const scoreDelta = b.score - a.score;
      if (scoreDelta !== 0) return scoreDelta;
      const tierDelta = graphTierRank(a.node.tier) - graphTierRank(b.node.tier);
      if (tierDelta !== 0) return tierDelta;
      return a.node.qualifiedName.localeCompare(b.node.qualifiedName);
    });

    const truncated = ranked.length > maxResults;
    const matches = ranked.slice(0, maxResults);
    if (params.includeEdges) {
      for (const match of matches) {
        const adjacent = this.connectedEdges(
          match.node.id,
          params.edgeDirection ?? "both",
          edgeKinds,
        );
        match.edges = adjacent.slice(0, maxEdgesPerNode);
        match.edgesTruncated = adjacent.length > maxEdgesPerNode;
      }
    }

    return { query: params.query, matches, truncated };
  }

  toNeighborhood(params: GetProjectGraphNeighborhoodParams): ProjectGraphResult {
    const root = this.resolveNeighborhoodRoot(params);
    if (!root) return { nodes: [], edges: [] };

    const depth = Math.max(0, Math.min(params.depth ?? 2, 8));
    const maxNodes = Math.max(1, Math.min(params.maxNodes ?? 240, 2_000));
    const direction = params.direction ?? "both";
    const allowedKinds = params.edgeKinds?.length ? new Set(params.edgeKinds) : null;
    const includeContainers = params.includeContainers ?? true;

    const included = new Set<string>([root.id]);
    let frontier = new Set<string>([root.id]);
    let truncated = false;

    for (let hop = 0; hop < depth && frontier.size > 0; hop++) {
      const next = new Set<string>();
      for (const nodeId of frontier) {
        const edges = this.connectedEdges(nodeId, direction, allowedKinds);
        for (const edge of edges) {
          const other = edge.source === nodeId ? edge.target : edge.source;
          if (!this.nodes.has(other) || included.has(other)) continue;
          if (included.size >= maxNodes) {
            truncated = true;
            continue;
          }
          included.add(other);
          next.add(other);
        }
      }
      frontier = next;
    }

    if (includeContainers) {
      for (const nodeId of Array.from(included)) {
        let current = this.nodes.get(nodeId);
        while (current?.containerId && this.nodes.has(current.containerId)) {
          if (included.size >= maxNodes) {
            truncated = true;
            break;
          }
          included.add(current.containerId);
          current = this.nodes.get(current.containerId);
        }
      }
    }

    const edges = this.edges.filter(
      (edge) =>
        included.has(edge.source) &&
        included.has(edge.target) &&
        (!allowedKinds || allowedKinds.has(edge.kind)),
    );
    return {
      nodes: Array.from(included)
        .map((id) => this.nodes.get(id))
        .filter((node): node is SolidityGraphNode => Boolean(node)),
      edges,
      focusId: root.id,
      truncated,
    };
  }

  toShortestPath(params: GetProjectGraphPathParams): ProjectGraphPathResult {
    const from = this.resolveGraphEndpoint(params.from);
    const to = this.resolveGraphEndpoint(params.to);
    if (!from || !to) return { nodes: [], edges: [], fromId: from?.id, toId: to?.id, found: false };
    if (from.id === to.id) {
      return {
        nodes: [from],
        edges: [],
        focusId: from.id,
        fromId: from.id,
        toId: to.id,
        found: true,
      };
    }

    const direction = params.direction ?? "outgoing";
    const allowedKinds = params.edgeKinds?.length ? new Set(params.edgeKinds) : null;
    const maxDepth = Math.max(0, Math.min(params.maxDepth ?? 16, 64));
    const visited = new Set<string>([from.id]);
    const queue: { nodeId: string; depth: number; path: SolidityGraphEdge[] }[] = [
      { nodeId: from.id, depth: 0, path: [] },
    ];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= maxDepth) continue;

      for (const edge of this.connectedEdges(current.nodeId, direction, allowedKinds)) {
        const next = edge.source === current.nodeId ? edge.target : edge.source;
        if (!this.nodes.has(next) || visited.has(next)) continue;
        const path = [...current.path, edge];
        if (next === to.id) {
          return this.pathResult(from.id, to.id, path);
        }
        visited.add(next);
        queue.push({ nodeId: next, depth: current.depth + 1, path });
      }
    }

    return {
      nodes: [from, to],
      edges: [],
      focusId: from.id,
      fromId: from.id,
      toId: to.id,
      found: false,
    };
  }

  getStats(): ProjectGraphStatsResult {
    const nodesByKind = Object.create(null) as ProjectGraphStatsResult["nodesByKind"];
    const edgesByKind = Object.create(null) as ProjectGraphStatsResult["edgesByKind"];
    const edgesByResolutionConfidence = Object.create(null) as NonNullable<
      ProjectGraphStatsResult["edgesByResolutionConfidence"]
    >;
    const filesByTier = Object.create(null) as ProjectGraphStatsResult["filesByTier"];
    let unresolvedEdgeCount = 0;

    for (const node of this.nodes.values()) {
      nodesByKind[node.kind] = (nodesByKind[node.kind] ?? 0) + 1;
      if (node.kind === "file") {
        filesByTier[node.tier] = (filesByTier[node.tier] ?? 0) + 1;
      }
    }

    for (const edge of this.edges) {
      edgesByKind[edge.kind] = (edgesByKind[edge.kind] ?? 0) + 1;
      const confidence = this.edgeResolutionConfidence(edge);
      edgesByResolutionConfidence[confidence] = (edgesByResolutionConfidence[confidence] ?? 0) + 1;
      if (this.isUnresolvedEdge(edge)) unresolvedEdgeCount++;
    }

    const relationshipProgress = this.relationshipProgress();
    return {
      nodeCount: this.nodes.size,
      edgeCount: this.edges.length,
      nodesByKind,
      edgesByKind,
      edgesByResolutionConfidence,
      unresolvedEdgeCount,
      filesByTier,
      lastRebuildDurationMs: this.lastRebuildDurationMs,
      lastUpdateDurationMs: this.lastUpdateDurationMs,
      cacheHit: this.cacheHit,
      lastCacheRestoreDurationMs: this.lastCacheRestoreDurationMs,
      lastCacheWriteDurationMs: this.lastCacheWriteDurationMs,
      relationshipFilesIndexed: relationshipProgress.indexed,
      relationshipFilesTotal: relationshipProgress.total,
      pendingRelationshipFiles: relationshipProgress.remaining,
      relationshipIndexComplete: this.isRelationshipIndexComplete(),
    };
  }

  contractNodeId(uri: string, name: string): string {
    return this.resolver.contractId(uri, name);
  }

  externalNodeId(name: string): string {
    return this.resolver.externalContractId(name);
  }

  private resetWorkspaceGraph(): string[] {
    this.nodes.clear();
    this.edges = [];
    this.clearEdgeIndexes();
    this.clearResolutionCaches();
    this.nodeIdsByFile.clear();
    this.relationshipIndexedUris.clear();
    this.relationshipQueue = [];
    this.relationshipQueuedUris.clear();
    return this.prioritizeWorkspaceUris(this.graphFileUris());
  }

  private enqueueRelationshipFiles(uris: string[]): void {
    for (const uri of this.prioritizeWorkspaceUris(this.relationshipFileUris(uris))) {
      if (this.relationshipIndexedUris.has(uri) || this.relationshipQueuedUris.has(uri)) continue;
      this.relationshipQueue.push(uri);
      this.relationshipQueuedUris.add(uri);
    }
  }

  private relationshipProgress(): { indexed: number; total: number; remaining: number } {
    const currentUris = new Set(this.relationshipFileUris());
    let indexed = 0;
    for (const uri of this.relationshipIndexedUris) {
      if (currentUris.has(uri)) indexed++;
    }
    return {
      indexed,
      total: currentUris.size,
      remaining: Math.max(0, currentUris.size - indexed),
    };
  }

  private prioritizeWorkspaceUris(uris: string[]): string[] {
    const tierRank = (uri: string): number => {
      switch (this.fileTier(uri)) {
        case "project":
          return 0;
        case "tests":
          return 1;
        case "deps":
          return 2;
        default:
          return 3;
      }
    };
    return uris.slice().sort((a, b) => tierRank(a) - tierRank(b) || a.localeCompare(b));
  }

  private graphFileUris(uris: string[] = this.workspace.getAllFileUris()): string[] {
    if (this.dependencyIndexing !== "disabled") return uris;
    return uris.filter((uri) => this.fileTier(uri) !== "deps");
  }

  private relationshipFileUris(uris: string[] = this.graphFileUris()): string[] {
    if (this.dependencyIndexing === "relationships") return this.graphFileUris(uris);
    return this.graphFileUris(uris).filter((uri) => this.fileTier(uri) !== "deps");
  }

  private resolveNeighborhoodRoot(
    params: GetProjectGraphNeighborhoodParams,
  ): SolidityGraphNode | undefined {
    return this.resolveGraphEndpoint({
      nodeId: params.rootId,
      uri: params.uri,
      position: params.position,
    });
  }

  private resolveGraphEndpoint(endpoint: ProjectGraphEndpoint): SolidityGraphNode | undefined {
    if (endpoint.nodeId) return this.nodes.get(endpoint.nodeId);
    if (!endpoint.uri || !endpoint.position) return undefined;
    return this.findInnermostNodeAtPosition(endpoint.uri, endpoint.position);
  }

  private pathResult(
    fromId: string,
    toId: string,
    pathEdges: SolidityGraphEdge[],
  ): ProjectGraphPathResult {
    const ids = new Set<string>([fromId, toId]);
    for (const edge of pathEdges) {
      ids.add(edge.source);
      ids.add(edge.target);
    }
    return {
      nodes: Array.from(ids)
        .map((id) => this.nodes.get(id))
        .filter((node): node is SolidityGraphNode => Boolean(node)),
      edges: pathEdges,
      focusId: fromId,
      fromId,
      toId,
      found: true,
    };
  }

  private prioritizeGraphNodes(nodes: SolidityGraphNode[]): SolidityGraphNode[] {
    const kindRank = (node: SolidityGraphNode): number => {
      switch (node.kind) {
        case "file":
          return 0;
        case "contract":
        case "interface":
        case "library":
          return 1;
        case "struct":
        case "enum":
        case "userDefinedValueType":
          return 2;
        case "function":
        case "constructor":
        case "receive":
        case "fallback":
        case "modifier":
          return 3;
        default:
          return 4;
      }
    };
    const tierRank = (node: SolidityGraphNode): number => {
      switch (node.tier) {
        case "project":
          return 0;
        case "tests":
          return 1;
        case "deps":
          return 2;
        default:
          return 3;
      }
    };
    return nodes.slice().sort((a, b) => {
      return (
        tierRank(a) - tierRank(b) ||
        kindRank(a) - kindRank(b) ||
        a.qualifiedName.localeCompare(b.qualifiedName)
      );
    });
  }

  private findInnermostNodeAtPosition(
    uri: string,
    position: SourceRange["start"],
  ): SolidityGraphNode | undefined {
    return this.getNodes()
      .filter(
        (node) =>
          node.uri === uri && node.kind !== "file" && this.positionInRange(position, node.range),
      )
      .sort((a, b) => this.rangeSize(a.range) - this.rangeSize(b.range))[0];
  }

  private connectedEdges(
    nodeId: string,
    direction: "incoming" | "outgoing" | "both",
    allowedKinds: Set<ProjectGraphEdgeKind> | null,
  ): SolidityGraphEdge[] {
    const sourceEdges = direction !== "incoming" ? (this.edgesBySource.get(nodeId) ?? []) : [];
    const targetEdges = direction !== "outgoing" ? (this.edgesByTarget.get(nodeId) ?? []) : [];
    const combined =
      direction === "both"
        ? this.dedupeEdges([...sourceEdges, ...targetEdges])
        : direction === "incoming"
          ? targetEdges
          : sourceEdges;
    return allowedKinds ? combined.filter((edge) => allowedKinds.has(edge.kind)) : combined.slice();
  }

  private solcDeclarationMetadata(
    uri: string,
    position: SourceRange["start"] | undefined,
  ): SolcDeclarationMetadata | Record<string, never> {
    if (!this.solcBridge || !position) return {};
    const offset = this.sourceOffsetAt(uri, position);
    if (offset === undefined) return {};
    const info = this.solcBridge.getDeclarationInfoAt(this.workspace.uriToPath(uri), offset);
    if (!info) return {};
    return {
      solcDeclarationId: info.declarationId,
      solcDeclarationFilePath: info.declarationFilePath,
      solcDeclarationOffset: info.declarationOffset,
      solcDeclarationLength: info.declarationLength,
      solcNodeType: info.nodeType,
      solcName: info.name,
      resolutionConfidence: "solc",
    };
  }

  private resolutionMetadata(
    uri: string,
    position: SourceRange["start"] | undefined,
    fallback: "parser" | "heuristic",
  ): SolcDeclarationMetadata | { resolutionConfidence: "parser" | "heuristic" } {
    const solc = this.solcDeclarationMetadata(uri, position);
    return Object.keys(solc).length > 0
      ? (solc as SolcDeclarationMetadata)
      : { resolutionConfidence: fallback };
  }

  private resolveGraphTargetWithSolc(
    uri: string,
    position: SourceRange["start"] | undefined,
    parserTarget: SolidityGraphNode,
    fallback: "parser" | "heuristic",
    allowedKinds: Set<SolidityGraphNodeKind>,
  ): ResolvedGraphTarget {
    const metadata = this.resolutionMetadata(uri, position, fallback);
    if (metadata.resolutionConfidence !== "solc") {
      return { node: parserTarget, metadata };
    }

    const solcTarget = this.findNodeForSolcDeclaration(metadata, allowedKinds);
    return {
      node: solcTarget ?? parserTarget,
      metadata: solcTarget
        ? metadata
        : {
            ...metadata,
            solcTargetUnmapped: true,
          },
    };
  }

  private findNodeForSolcDeclaration(
    metadata: SolcDeclarationMetadata,
    allowedKinds: Set<SolidityGraphNodeKind>,
  ): SolidityGraphNode | undefined {
    if (!metadata.solcDeclarationFilePath || metadata.solcDeclarationOffset === undefined) {
      return undefined;
    }

    const uri = URI.file(metadata.solcDeclarationFilePath).toString();
    const text = this.parser.getText(uri);
    if (text === undefined) return undefined;
    const position = this.textOffsetToRange(text, metadata.solcDeclarationOffset, 0).start;
    return this.getNodes()
      .filter(
        (node) =>
          node.uri === uri &&
          allowedKinds.has(node.kind) &&
          this.positionInRange(position, node.range) &&
          (!metadata.solcName || node.name === metadata.solcName),
      )
      .sort((a, b) => this.rangeSize(a.range) - this.rangeSize(b.range))[0];
  }

  private collectImportDependents(uri: string): string[] {
    const dependents: string[] = [];
    const seen = new Set<string>([uri]);
    const queue = [uri];

    while (queue.length > 0) {
      const currentUri = queue.shift()!;
      const currentFileId = this.fileNodeId(currentUri);
      for (const dependentUri of this.importSourcesByTarget.get(currentFileId) ?? []) {
        if (seen.has(dependentUri)) continue;
        seen.add(dependentUri);
        dependents.push(dependentUri);
        queue.push(dependentUri);
      }
    }

    return dependents;
  }

  private positionInRange(position: SourceRange["start"], range: SourceRange): boolean {
    const afterStart =
      position.line > range.start.line ||
      (position.line === range.start.line && position.character >= range.start.character);
    const beforeEnd =
      position.line < range.end.line ||
      (position.line === range.end.line && position.character <= range.end.character);
    return afterStart && beforeEnd;
  }

  private rangeSize(range: SourceRange): number {
    return (
      (range.end.line - range.start.line) * 100_000 +
      Math.max(0, range.end.character - range.start.character)
    );
  }

  private indexContract(uri: string, contract: ContractDefinition, text: string): void {
    const contractId = this.contractNodeId(uri, contract.name);
    const context: ContractIndexContext = {
      rawContractNode: this.findRawContractNode(uri, contract.name),
      stateTargets: this.collectStateVariableTargets(contract, uri),
    };

    for (const usingFor of contract.usingFor) {
      if (usingFor.libraryName) {
        this.addUsesTypeEdges(contractId, uri, [
          { typeName: usingFor.libraryName, metadata: { usage: "usingLibrary" } },
        ]);
      }
      if (usingFor.typeName) {
        this.addUsesTypeEdges(contractId, uri, [
          { typeName: usingFor.typeName, metadata: { usage: "usingType" } },
        ]);
      }
    }

    this.indexContractMemberDeclarations(uri, contractId, contract);

    this.indexOverrideEdges(uri, contract);

    for (const fn of contract.functions) {
      const sourceId = this.memberNodeId(
        uri,
        contract.name,
        fn.kind === "function" ? "function" : fn.kind,
        fn.name ?? fn.kind,
        fn.nameRange,
      );
      if (fn.body) this.indexFunctionBodyEdges(uri, text, contract, fn, sourceId, context);
    }

    for (const mod of contract.modifiers) {
      const sourceId = this.memberNodeId(uri, contract.name, "modifier", mod.name, mod.nameRange);
      this.indexModifierBodyEdgesFromRawAst(uri, text, contract, mod, sourceId, context);
    }
  }

  private indexContractHeader(
    uri: string,
    fileNodeId: string,
    contract: ContractDefinition,
  ): string {
    const contractId = this.contractNodeId(uri, contract.name);
    const kind =
      contract.kind === "interface"
        ? "interface"
        : contract.kind === "library"
          ? "library"
          : "contract";

    this.addNode({
      id: contractId,
      kind,
      name: contract.name,
      qualifiedName: contract.name,
      uri,
      filePath: this.safeUriToPath(uri),
      tier: this.fileTier(uri),
      range: contract.range,
      selectionRange: contract.nameRange,
    });
    this.addEdge({ source: fileNodeId, target: contractId, kind: "contains" });
    for (const base of contract.baseContracts) {
      const resolved = this.resolver.resolveBaseContract(uri, base.baseName);
      this.addEdge({
        source: contractId,
        target: resolved?.id ?? this.externalNodeId(base.baseName),
        kind: "inherits",
        unresolvedTarget: resolved ? undefined : true,
        resolutionConfidence: resolved ? "parser" : "unknown",
        metadata: { baseName: base.baseName, resolved: Boolean(resolved) },
      });
    }
    return contractId;
  }

  private indexContractMemberDeclarations(
    uri: string,
    contractId: string,
    contract: ContractDefinition,
  ): void {
    for (const variable of contract.stateVariables) {
      this.indexStateVariable(uri, contractId, contract.name, variable);
    }

    for (const fn of contract.functions) {
      this.indexFunction(uri, contractId, contract, fn);
    }

    for (const mod of contract.modifiers) {
      this.indexModifier(uri, contractId, contract.name, mod);
    }

    for (const event of contract.events) {
      this.indexEvent(uri, contractId, contract.name, event);
    }

    for (const error of contract.errors) {
      this.indexError(uri, contractId, contract.name, error);
    }

    for (const struct of contract.structs) {
      this.indexStruct(uri, contractId, struct, contract.name);
    }

    for (const enumDef of contract.enums) {
      this.indexEnum(uri, contractId, enumDef, contract.name);
    }
  }

  private indexFunction(
    uri: string,
    parentId: string,
    contract: ContractDefinition | undefined,
    fn: FunctionDefinition,
  ): void {
    const name = fn.name ?? fn.kind;
    if (!name) return;
    const kind =
      fn.kind === "constructor"
        ? "constructor"
        : fn.kind === "receive"
          ? "receive"
          : fn.kind === "fallback"
            ? "fallback"
            : "function";
    const node = this.memberNode(uri, parentId, kind, name, fn.range, fn.nameRange, {
      containerName: contract?.name,
      detail: this.functionSignature(fn),
    });
    this.addNode(node);
    this.addEdge({ source: parentId, target: node.id, kind: "contains" });
    this.addUsesTypeEdges(node.id, uri, [
      ...fn.parameters.map((param) => ({
        typeName: param.typeName,
        range: param.range,
        metadata: { usage: "parameter", parameterName: param.name },
      })),
      ...fn.returnParameters.map((param) => ({
        typeName: param.typeName,
        range: param.range,
        metadata: { usage: "return", parameterName: param.name },
      })),
    ]);

    for (const modifierName of fn.modifiers) {
      const modifier = contract
        ? this.resolver.findMemberInInheritanceChain(contract.name, modifierName, uri)
        : null;
      if (modifier) {
        this.addEdge({
          source: node.id,
          target: this.memberNodeId(
            modifier.filePath,
            modifier.containerName,
            "modifier",
            modifier.name,
            modifier.nameRange,
          ),
          kind: "usesModifier",
          metadata: { modifierName },
        });
      }
    }
  }

  private indexModifier(
    uri: string,
    parentId: string,
    containerName: string,
    mod: ModifierDefinition,
  ): void {
    const node = this.memberNode(uri, parentId, "modifier", mod.name, mod.range, mod.nameRange, {
      containerName,
    });
    this.addNode(node);
    this.addEdge({ source: parentId, target: node.id, kind: "contains" });
    this.addUsesTypeEdges(
      node.id,
      uri,
      mod.parameters.map((param) => ({
        typeName: param.typeName,
        range: param.range,
        metadata: { usage: "parameter", parameterName: param.name },
      })),
    );
  }

  private indexStateVariable(
    uri: string,
    parentId: string,
    containerName: string,
    variable: StateVariableDeclaration,
  ): void {
    const node = this.memberNode(
      uri,
      parentId,
      "stateVariable",
      variable.name,
      variable.range,
      variable.nameRange,
      { containerName, detail: variable.typeName },
    );
    this.addNode(node);
    this.addEdge({ source: parentId, target: node.id, kind: "contains" });
    this.addUsesTypeEdges(node.id, uri, [
      { typeName: variable.typeName, range: variable.range, metadata: { usage: "stateVariable" } },
    ]);
  }

  private indexEvent(
    uri: string,
    parentId: string,
    containerName: string,
    event: EventDefinition,
  ): void {
    const node = this.memberNode(uri, parentId, "event", event.name, event.range, event.nameRange, {
      containerName,
    });
    this.addNode(node);
    this.addEdge({ source: parentId, target: node.id, kind: "contains" });
    this.addUsesTypeEdges(
      node.id,
      uri,
      event.parameters.map((param) => ({
        typeName: param.typeName,
        range: param.range,
        metadata: { usage: "eventParameter", parameterName: param.name },
      })),
    );
  }

  private indexError(
    uri: string,
    parentId: string,
    containerName: string,
    error: ErrorDefinition,
  ): void {
    const node = this.memberNode(uri, parentId, "error", error.name, error.range, error.nameRange, {
      containerName,
    });
    this.addNode(node);
    this.addEdge({ source: parentId, target: node.id, kind: "contains" });
    this.addUsesTypeEdges(
      node.id,
      uri,
      error.parameters.map((param) => ({
        typeName: param.typeName,
        range: param.range,
        metadata: { usage: "errorParameter", parameterName: param.name },
      })),
    );
  }

  private indexStruct(
    uri: string,
    parentId: string,
    struct: StructDefinition,
    containerName?: string,
  ): void {
    const node = this.memberNode(
      uri,
      parentId,
      "struct",
      struct.name,
      struct.range,
      struct.nameRange,
      {
        containerName,
      },
    );
    this.addNode(node);
    this.addEdge({ source: parentId, target: node.id, kind: "contains" });
    this.addUsesTypeEdges(
      node.id,
      uri,
      struct.members.map((member) => ({
        typeName: member.typeName,
        range: member.range,
        metadata: { usage: "structMember", memberName: member.name },
      })),
    );
  }

  private indexEnum(
    uri: string,
    parentId: string,
    enumDef: EnumDefinition,
    containerName?: string,
  ): void {
    const node = this.memberNode(
      uri,
      parentId,
      "enum",
      enumDef.name,
      enumDef.range,
      enumDef.nameRange,
      {
        containerName,
      },
    );
    this.addNode(node);
    this.addEdge({ source: parentId, target: node.id, kind: "contains" });
  }

  private indexFileConstant(uri: string, parentId: string, constant: FileConstantDefinition): void {
    const node = this.memberNode(
      uri,
      parentId,
      "fileConstant",
      constant.name,
      constant.range,
      constant.nameRange,
      { detail: constant.typeName },
    );
    this.addNode(node);
    this.addEdge({ source: parentId, target: node.id, kind: "contains" });
    this.addUsesTypeEdges(node.id, uri, [
      { typeName: constant.typeName, range: constant.range, metadata: { usage: "fileConstant" } },
    ]);
  }

  private indexUserDefinedValueType(
    uri: string,
    parentId: string,
    udvt: UserDefinedValueTypeDefinition,
  ): void {
    const node = this.memberNode(
      uri,
      parentId,
      "userDefinedValueType",
      udvt.name,
      udvt.range,
      udvt.nameRange,
      { detail: udvt.underlyingType },
    );
    this.addNode(node);
    this.addEdge({ source: parentId, target: node.id, kind: "contains" });
  }

  private indexDeclarable(
    uri: string,
    parentId: string,
    kind: SolidityGraphNodeKind,
    name: string,
    range: SourceRange,
    selectionRange: SourceRange,
  ): void {
    const node = this.memberNode(uri, parentId, kind, name, range, selectionRange);
    this.addNode(node);
    this.addEdge({ source: parentId, target: node.id, kind: "contains" });
  }

  private indexOverrideEdges(uri: string, contract: ContractDefinition): void {
    const resolved = this.resolver.resolveContract(contract.name, uri);
    if (!resolved) return;
    const bases = this.resolver.getInheritanceChainFor(resolved).slice(1);
    if (bases.length === 0) return;

    for (const fn of contract.functions) {
      if (!fn.isOverride || !fn.name) continue;
      const sourceId = this.memberNodeId(uri, contract.name, "function", fn.name, fn.nameRange);
      for (const base of bases) {
        const targetFn = base.contract.functions.find((candidate) => candidate.name === fn.name);
        if (!targetFn?.name) continue;
        this.addEdge({
          source: sourceId,
          target: this.memberNodeId(
            base.uri,
            base.contract.name,
            "function",
            targetFn.name,
            targetFn.nameRange,
          ),
          kind: base.contract.kind === "interface" ? "implements" : "overrides",
          range: fn.nameRange,
          metadata: {
            memberName: fn.name,
            baseName: base.contract.name,
            resolutionConfidence: "parser",
          },
        });
      }
    }

    for (const modifier of contract.modifiers) {
      if (!modifier.isOverride) continue;
      const sourceId = this.memberNodeId(
        uri,
        contract.name,
        "modifier",
        modifier.name,
        modifier.nameRange,
      );
      for (const base of bases) {
        const targetModifier = base.contract.modifiers.find(
          (candidate) => candidate.name === modifier.name,
        );
        if (!targetModifier) continue;
        this.addEdge({
          source: sourceId,
          target: this.memberNodeId(
            base.uri,
            base.contract.name,
            "modifier",
            targetModifier.name,
            targetModifier.nameRange,
          ),
          kind: base.contract.kind === "interface" ? "implements" : "overrides",
          range: modifier.nameRange,
          metadata: {
            memberName: modifier.name,
            baseName: base.contract.name,
            resolutionConfidence: "parser",
          },
        });
      }
    }
  }

  private addUsesTypeEdges(
    sourceId: string,
    fromUri: string,
    refs: {
      typeName: string | undefined;
      range?: SourceRange;
      metadata?: Record<string, unknown>;
    }[],
  ): void {
    for (const ref of refs) {
      if (!ref.typeName) continue;
      for (const typeName of this.extractTypeIdentifiers(ref.typeName)) {
        const targetId = this.resolveTypeNodeId(typeName, fromUri);
        if (!targetId || targetId === sourceId) continue;
        const parserTarget = this.nodes.get(targetId);
        if (!parserTarget) continue;
        const resolved = this.resolveGraphTargetWithSolc(
          fromUri,
          ref.range?.start,
          parserTarget,
          "parser",
          TYPE_TARGET_NODE_KINDS,
        );
        this.addEdge({
          source: sourceId,
          target: resolved.node.id,
          kind: "usesType",
          range: ref.range,
          metadata: {
            typeName,
            ...ref.metadata,
            ...resolved.metadata,
          },
        });
      }
    }
  }

  private extractTypeIdentifiers(typeName: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const re = /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(typeName)) !== null) {
      const raw = match[0];
      const leaf = raw.includes(".") ? (raw.split(".").at(-1) ?? raw) : raw;
      if (this.isBuiltinTypeIdentifier(leaf)) continue;
      if (seen.has(raw)) continue;
      seen.add(raw);
      out.push(raw);
    }
    return out;
  }

  private isBuiltinTypeIdentifier(name: string): boolean {
    return SOLIDITY_KEYWORDS.has(name) || isSolidityBuiltinType(name);
  }

  private resolveTypeNodeId(typeName: string, fromUri: string): string | undefined {
    const cacheKey = `${fromUri}\0${typeName}`;
    if (this.typeNodeIdCache.has(cacheKey)) return this.typeNodeIdCache.get(cacheKey);

    const contract = this.resolver.resolveContract(typeName, fromUri);
    if (contract) {
      this.typeNodeIdCache.set(cacheKey, contract.id);
      return contract.id;
    }

    if (!this.symbolIndex) {
      this.typeNodeIdCache.set(cacheKey, undefined);
      return undefined;
    }
    const imported = this.resolver.resolveImportedSymbol(typeName, fromUri);
    const lookupName =
      imported?.name ??
      (typeName.includes(".") ? (typeName.split(".").at(-1) ?? typeName) : typeName);
    const candidates = this.symbolIndex
      .findSymbols(lookupName)
      .filter(
        (symbol) =>
          symbol.kind === "struct" ||
          symbol.kind === "enum" ||
          symbol.kind === "userDefinedValueType",
      );
    if (candidates.length === 0) {
      this.typeNodeIdCache.set(cacheKey, undefined);
      return undefined;
    }

    const chosen =
      (imported ? candidates.find((symbol) => symbol.filePath === imported.uri) : undefined) ??
      candidates.find((symbol) => symbol.filePath === fromUri) ??
      candidates.find((symbol) => this.fileTier(symbol.filePath) === "project") ??
      candidates[0];
    const nodeId = this.memberNodeId(
      chosen.filePath,
      chosen.containerName,
      chosen.kind,
      chosen.name,
      chosen.nameRange,
    );
    this.typeNodeIdCache.set(cacheKey, nodeId);
    return nodeId;
  }

  private indexFunctionBodyEdges(
    uri: string,
    text: string,
    contract: ContractDefinition,
    fn: FunctionDefinition,
    sourceId: string,
    context: ContractIndexContext,
  ): void {
    if (this.indexFunctionBodyEdgesFromRawAst(uri, text, contract, fn, sourceId, context)) {
      return;
    }

    const body = this.functionBody(maskCommentsAndStrings(text), fn.range);
    if (!body) return;

    this.indexCallEdges(uri, contract, sourceId, body);
    this.indexStateAccessEdges(uri, fn, sourceId, body, context.stateTargets);
    this.indexEmitEdges(uri, contract, sourceId, body);
    this.indexRevertEdges(uri, contract, sourceId, body);
  }

  private indexFunctionBodyEdgesFromRawAst(
    uri: string,
    text: string,
    contract: ContractDefinition,
    fn: FunctionDefinition,
    sourceId: string,
    context: ContractIndexContext,
  ): boolean {
    const rawFn = this.findRawFunctionNode(uri, context.rawContractNode, fn);
    if (!rawFn?.body) return false;

    const parameterNames = new Set(
      fn.parameters.map((param) => param.name).filter((name): name is string => Boolean(name)),
    );
    this.indexRawCallableBodyEdges(
      uri,
      text,
      contract,
      sourceId,
      rawFn.body,
      parameterNames,
      context.stateTargets,
    );
    return true;
  }

  private indexModifierBodyEdgesFromRawAst(
    uri: string,
    text: string,
    contract: ContractDefinition,
    mod: ModifierDefinition,
    sourceId: string,
    context: ContractIndexContext,
  ): boolean {
    const rawModifier = this.findRawModifierNode(uri, context.rawContractNode, mod);
    if (!rawModifier?.body) return false;

    const parameterNames = new Set(
      mod.parameters.map((param) => param.name).filter((name): name is string => Boolean(name)),
    );
    this.indexRawCallableBodyEdges(
      uri,
      text,
      contract,
      sourceId,
      rawModifier.body,
      parameterNames,
      context.stateTargets,
    );
    return true;
  }

  private indexRawCallableBodyEdges(
    uri: string,
    text: string,
    contract: ContractDefinition,
    sourceId: string,
    body: RawAstNode,
    parameterNames: Set<string>,
    stateVariableTargets: StateVariableTarget[],
  ): void {
    const localNames = new Set<string>();
    this.collectLocalVariableNames(body, localNames);
    const stateTargets: { variable: StateVariableTarget; targetNode: SolidityGraphNode }[] = [];
    for (const variable of stateVariableTargets) {
      const targetNode = this.nodes.get(
        this.memberNodeId(
          variable.filePath,
          variable.containerName,
          "stateVariable",
          variable.name,
          variable.nameRange,
        ),
      );
      if (targetNode) stateTargets.push({ variable, targetNode });
    }

    const visitExpression = (
      node: RawAstNode | undefined,
      context: ExpressionContext = {},
    ): void => {
      if (!node) return;

      switch (node.type) {
        case "FunctionCall":
          this.indexRawContractCreation(uri, text, sourceId, node);
          this.indexRawFunctionCall(uri, text, contract, sourceId, node);
          if (node.expression?.type === "MemberAccess") {
            visitExpression(node.expression.expression);
          }
          for (const arg of node.arguments ?? []) visitExpression(arg);
          return;
        case "BinaryOperation":
          visitExpression(node.left, {
            assignmentTarget: this.isAssignmentOperator(node.operator),
            compoundAssignmentTarget: this.isCompoundAssignmentOperator(node.operator),
          });
          visitExpression(node.right);
          return;
        case "UnaryOperation":
          visitExpression(node.subExpression, {
            assignmentTarget:
              node.operator === "++" || node.operator === "--" || node.operator === "delete",
            compoundAssignmentTarget: node.operator === "++" || node.operator === "--",
          });
          return;
        case "Identifier":
          this.indexRawStateIdentifier(
            uri,
            text,
            sourceId,
            node,
            stateTargets,
            parameterNames,
            localNames,
            context,
          );
          return;
        case "MemberAccess":
          visitExpression(node.expression, context);
          return;
        case "IndexAccess":
          visitExpression(node.base, context);
          visitExpression(node.index);
          return;
        default:
          this.visitRawChildren(node, visitExpression);
      }
    };

    const visitStatement = (node: RawAstNode | undefined): void => {
      if (!node) return;
      switch (node.type) {
        case "EmitStatement":
          this.indexRawEmit(uri, text, contract, sourceId, node);
          for (const arg of node.eventCall?.arguments ?? []) visitExpression(arg);
          return;
        case "RevertStatement":
          this.indexRawRevert(uri, text, contract, sourceId, node);
          for (const arg of node.revertCall?.arguments ?? []) visitExpression(arg);
          return;
        case "ExpressionStatement":
          visitExpression(node.expression);
          return;
        case "IfStatement":
          visitExpression(node.condition);
          visitStatement(node.trueBody);
          visitStatement(node.falseBody);
          return;
        case "Block":
          for (const stmt of node.statements ?? []) visitStatement(stmt);
          return;
        case "VariableDeclarationStatement":
          visitExpression(node.initialValue);
          return;
        default:
          this.visitRawChildren(node, (child) => {
            if (this.isStatementNode(child)) visitStatement(child);
            else visitExpression(child);
          });
      }
    };

    visitStatement(body);
  }

  private indexCallEdges(
    uri: string,
    contract: ContractDefinition,
    sourceId: string,
    body: FunctionBody,
  ): void {
    const callRe = /(?:\b([a-zA-Z_$][\w$]*)\s*\.\s*)?\b([a-zA-Z_$][\w$]*)\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = callRe.exec(body.text)) !== null) {
      const qualifier = match[1];
      const calleeName = match[2];
      if (CALL_LIKE_KEYWORDS.has(calleeName)) continue;
      if (isSolidityBuiltinType(calleeName)) continue;

      const absoluteStart = match.index + match[0].lastIndexOf(calleeName);
      const range = this.bodyOffsetToRange(body, absoluteStart, calleeName.length);
      const receiver = this.extractReceiverAtCall(body, absoluteStart);
      const target = this.resolveCallTarget(
        uri,
        contract,
        qualifier,
        receiver,
        calleeName,
        range.start,
        undefined,
      );
      if (!target) continue;
      const resolved = this.resolveGraphTargetWithSolc(
        uri,
        range.start,
        target,
        "parser",
        CALL_TARGET_NODE_KINDS,
      );

      this.addEdge({
        source: sourceId,
        target: resolved.node.id,
        kind: "calls",
        range,
        metadata: {
          calleeName,
          qualifier,
          ...resolved.metadata,
        },
      });
    }
  }

  private indexRawFunctionCall(
    uri: string,
    text: string,
    contract: ContractDefinition,
    sourceId: string,
    call: RawAstNode,
  ): void {
    const callee = this.rawCallName(text, call.expression);
    if (!callee) return;
    if (callee.name === "delegatecall") {
      this.indexRawDelegateCall(uri, contract, sourceId, callee);
      return;
    }
    if (LOW_LEVEL_EXTERNAL_CALL_NAMES.has(callee.name)) {
      const receiverType = callee.receiver
        ? this.resolveReceiverType(uri, contract, callee.receiver, callee.range.start)
        : undefined;
      const contractTarget = receiverType
        ? this.resolver.resolveContract(receiverType, uri)
        : undefined;
      const memberTarget = contractTarget
        ? this.resolveMemberNode(contractTarget, callee.name, call.arguments?.length ?? 0)
        : undefined;
      if (!memberTarget) {
        this.indexRawLowLevelExternalCall(uri, sourceId, callee, receiverType);
        return;
      }
    }
    if (CALL_LIKE_KEYWORDS.has(callee.name)) return;
    if (isSolidityBuiltinType(callee.name)) return;

    const target = this.resolveCallTarget(
      uri,
      contract,
      callee.receiverLeaf,
      callee.receiver,
      callee.name,
      callee.range.start,
      call.arguments?.length ?? 0,
    );
    if (!target) return;
    const resolved = this.resolveGraphTargetWithSolc(
      uri,
      callee.range.start,
      target,
      "parser",
      CALL_TARGET_NODE_KINDS,
    );

    this.addEdge({
      source: sourceId,
      target: resolved.node.id,
      kind: "calls",
      range: callee.range,
      metadata: {
        calleeName: callee.name,
        qualifier: callee.receiverLeaf,
        ...resolved.metadata,
      },
    });

    if (this.shouldIndexExternalCall(callee.receiverLeaf, resolved.node)) {
      this.addEdge({
        source: sourceId,
        target: resolved.node.id,
        kind: "externalCall",
        range: callee.range,
        metadata: {
          calleeName: callee.name,
          receiver: callee.receiver,
          receiverLeaf: callee.receiverLeaf,
          ...resolved.metadata,
        },
      });
    }
  }

  private shouldIndexExternalCall(
    receiverLeaf: string | undefined,
    target: SolidityGraphNode,
  ): boolean {
    if (!receiverLeaf || receiverLeaf === "this" || receiverLeaf === "super") return false;
    if (!target.containerId) return false;
    const container = this.nodes.get(target.containerId);
    return container?.kind === "contract" || container?.kind === "interface";
  }

  private indexRawLowLevelExternalCall(
    uri: string,
    sourceId: string,
    callee: {
      name: string;
      receiver: string | null;
      receiverLeaf: string | undefined;
      range: SourceRange;
    },
    receiverType: string | undefined,
  ): void {
    this.addEdge({
      source: sourceId,
      target: sourceId,
      kind: "externalCall",
      range: callee.range,
      metadata: {
        calleeName: callee.name,
        receiver: callee.receiver,
        receiverLeaf: callee.receiverLeaf,
        receiverType,
        lowLevelCall: true,
        unresolvedTarget: true,
        ...this.resolutionMetadata(uri, callee.range.start, "heuristic"),
      },
    });
  }

  private indexRawContractCreation(
    uri: string,
    text: string,
    sourceId: string,
    call: RawAstNode,
  ): void {
    if (call.expression?.type !== "NewExpression") return;
    const typeName = this.rawTypeNameToString(call.expression.typeName);
    if (!typeName) return;
    const target = this.resolver.resolveContract(typeName, uri);
    if (!target) return;
    const range = this.rawNameRange(text, call.expression, "new");
    const parserTarget = this.nodes.get(target.id);
    if (!parserTarget) return;
    const resolved = this.resolveGraphTargetWithSolc(
      uri,
      range.start,
      parserTarget,
      "parser",
      CONTRACT_TARGET_NODE_KINDS,
    );
    this.addEdge({
      source: sourceId,
      target: resolved.node.id,
      kind: "creates",
      range,
      metadata: {
        contractName: typeName,
        ...resolved.metadata,
      },
    });
  }

  private indexRawDelegateCall(
    uri: string,
    contract: ContractDefinition,
    sourceId: string,
    callee: {
      name: string;
      receiver: string | null;
      receiverLeaf: string | undefined;
      range: SourceRange;
    },
  ): void {
    const receiver = callee.receiver ?? callee.receiverLeaf;
    const receiverType = receiver
      ? this.resolveReceiverType(uri, contract, receiver, callee.range.start)
      : undefined;
    const target = receiverType ? this.resolver.resolveContract(receiverType, uri) : undefined;
    const parserTarget = target ? this.nodes.get(target.id) : undefined;
    const resolved = parserTarget
      ? this.resolveGraphTargetWithSolc(
          uri,
          callee.range.start,
          parserTarget,
          "parser",
          CONTRACT_TARGET_NODE_KINDS,
        )
      : undefined;
    this.addEdge({
      source: sourceId,
      target: resolved?.node.id ?? sourceId,
      kind: "delegateCall",
      range: callee.range,
      metadata: {
        receiver,
        receiverType,
        unresolvedTarget: !resolved,
        ...(resolved?.metadata ?? this.resolutionMetadata(uri, callee.range.start, "heuristic")),
      },
    });
  }

  private indexRawEmit(
    uri: string,
    text: string,
    contract: ContractDefinition,
    sourceId: string,
    emitNode: RawAstNode,
  ): void {
    const eventExpression = emitNode.eventCall?.expression;
    if (!eventExpression || eventExpression.type !== "Identifier" || !eventExpression.name) return;
    const target = this.resolveContractMemberGraphNode(
      uri,
      contract.name,
      eventExpression.name,
      "event",
    );
    if (!target) return;
    const range = this.rawNameRange(text, eventExpression, eventExpression.name);
    const resolved = this.resolveGraphTargetWithSolc(
      uri,
      range.start,
      target,
      "parser",
      EVENT_TARGET_NODE_KINDS,
    );
    this.addEdge({
      source: sourceId,
      target: resolved.node.id,
      kind: "emits",
      range,
      metadata: { eventName: eventExpression.name, ...resolved.metadata },
    });
  }

  private indexRawRevert(
    uri: string,
    text: string,
    contract: ContractDefinition,
    sourceId: string,
    revertNode: RawAstNode,
  ): void {
    const errorExpression = revertNode.revertCall?.expression;
    if (!errorExpression || errorExpression.type !== "Identifier" || !errorExpression.name) return;
    const target = this.resolveContractMemberGraphNode(
      uri,
      contract.name,
      errorExpression.name,
      "error",
    );
    if (!target) return;
    const range = this.rawNameRange(text, errorExpression, errorExpression.name);
    const resolved = this.resolveGraphTargetWithSolc(
      uri,
      range.start,
      target,
      "parser",
      ERROR_TARGET_NODE_KINDS,
    );
    this.addEdge({
      source: sourceId,
      target: resolved.node.id,
      kind: "revertsWith",
      range,
      metadata: { errorName: errorExpression.name, ...resolved.metadata },
    });
  }

  private indexRawStateIdentifier(
    uri: string,
    text: string,
    sourceId: string,
    identifier: RawAstNode,
    stateTargets: { variable: StateVariableTarget; targetNode: SolidityGraphNode }[],
    parameterNames: Set<string>,
    localNames: Set<string>,
    context: ExpressionContext,
  ): void {
    if (!identifier.name) return;
    if (parameterNames.has(identifier.name) || localNames.has(identifier.name)) return;

    const target = stateTargets.find((entry) => entry.variable.name === identifier.name);
    if (!target) return;

    const accessKind = context.assignmentTarget ? "writes" : "reads";
    const range = this.rawNameRange(text, identifier, identifier.name);
    const resolved = this.resolveGraphTargetWithSolc(
      uri,
      range.start,
      target.targetNode,
      "parser",
      STATE_TARGET_NODE_KINDS,
    );
    this.addEdge({
      source: sourceId,
      target: resolved.node.id,
      kind: accessKind,
      range,
      metadata: { variableName: identifier.name, ...resolved.metadata },
    });

    if (context.compoundAssignmentTarget) {
      this.addEdge({
        source: sourceId,
        target: resolved.node.id,
        kind: "reads",
        range,
        metadata: { variableName: identifier.name, viaCompoundWrite: true, ...resolved.metadata },
      });
    }
  }

  private indexStateAccessEdges(
    uri: string,
    fn: FunctionDefinition,
    sourceId: string,
    body: FunctionBody,
    stateVariables: StateVariableTarget[],
  ): void {
    if (stateVariables.length === 0) return;

    const shadowed = new Set(fn.parameters.map((param) => param.name).filter(Boolean));
    for (const variable of stateVariables) {
      const targetNode = this.nodes.get(
        this.memberNodeId(
          variable.filePath,
          variable.containerName,
          "stateVariable",
          variable.name,
          variable.nameRange,
        ),
      );
      if (!targetNode || shadowed.has(variable.name)) continue;

      const localShadowStarts = this.localShadowStartOffsets(body.text, variable.name);

      const re = new RegExp(`\\b${escapeRegExp(variable.name)}\\b`, "g");
      let match: RegExpExecArray | null;
      while ((match = re.exec(body.text)) !== null) {
        const matchIndex = match.index;
        if (this.isLocalDeclaration(body.text, variable.name, matchIndex)) continue;
        if (localShadowStarts.some((start) => start < matchIndex)) continue;

        const accessKind = this.classifyStateAccess(body.text, variable.name, matchIndex);
        const range = this.bodyOffsetToRange(body, matchIndex, variable.name.length);
        const resolved = this.resolveGraphTargetWithSolc(
          uri,
          range.start,
          targetNode,
          "parser",
          STATE_TARGET_NODE_KINDS,
        );
        this.addEdge({
          source: sourceId,
          target: resolved.node.id,
          kind: accessKind,
          range,
          metadata: { variableName: variable.name, ...resolved.metadata },
        });

        if (
          accessKind === "writes" &&
          this.isCompoundStateWrite(body.text, variable.name, match.index)
        ) {
          this.addEdge({
            source: sourceId,
            target: resolved.node.id,
            kind: "reads",
            range,
            metadata: { variableName: variable.name, viaCompoundWrite: true, ...resolved.metadata },
          });
        }
      }
    }
  }

  private indexEmitEdges(
    uri: string,
    contract: ContractDefinition,
    sourceId: string,
    body: FunctionBody,
  ): void {
    const emitRe = /\bemit\s+([a-zA-Z_$][\w$]*)\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = emitRe.exec(body.text)) !== null) {
      const eventName = match[1];
      const target = this.resolveContractMemberGraphNode(uri, contract.name, eventName, "event");
      if (!target) continue;
      const start = match.index + match[0].indexOf(eventName);
      const range = this.bodyOffsetToRange(body, start, eventName.length);
      const resolved = this.resolveGraphTargetWithSolc(
        uri,
        range.start,
        target,
        "parser",
        EVENT_TARGET_NODE_KINDS,
      );
      this.addEdge({
        source: sourceId,
        target: resolved.node.id,
        kind: "emits",
        range,
        metadata: { eventName, ...resolved.metadata },
      });
    }
  }

  private indexRevertEdges(
    uri: string,
    contract: ContractDefinition,
    sourceId: string,
    body: FunctionBody,
  ): void {
    const revertRe = /\brevert\s+([a-zA-Z_$][\w$]*)\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = revertRe.exec(body.text)) !== null) {
      const errorName = match[1];
      const target = this.resolveContractMemberGraphNode(uri, contract.name, errorName, "error");
      if (!target) continue;
      const start = match.index + match[0].indexOf(errorName);
      const range = this.bodyOffsetToRange(body, start, errorName.length);
      const resolved = this.resolveGraphTargetWithSolc(
        uri,
        range.start,
        target,
        "parser",
        ERROR_TARGET_NODE_KINDS,
      );
      this.addEdge({
        source: sourceId,
        target: resolved.node.id,
        kind: "revertsWith",
        range,
        metadata: { errorName, ...resolved.metadata },
      });
    }
  }

  private resolveCallTarget(
    uri: string,
    contract: ContractDefinition,
    qualifier: string | undefined,
    receiver: string | null,
    calleeName: string,
    position: SourceRange["start"],
    argumentCount: number | undefined,
  ): SolidityGraphNode | undefined {
    if (qualifier && qualifier !== "this" && qualifier !== "super") {
      const receiverType = this.resolveReceiverType(uri, contract, receiver ?? qualifier, position);
      if (!receiverType) return undefined;

      const usingForTarget = this.resolveUsingForTarget(
        uri,
        contract,
        receiverType,
        calleeName,
        argumentCount,
      );
      if (usingForTarget) return usingForTarget;

      const contractTarget = this.resolver.resolveContract(receiverType, uri);
      if (contractTarget) return this.resolveMemberNode(contractTarget, calleeName, argumentCount);
      return undefined;
    }

    const targetContract =
      qualifier === "super"
        ? this.resolver.resolveBaseContract(uri, contract.baseContracts[0]?.baseName ?? "")
        : this.resolver.resolveContract(contract.name, uri);
    if (!targetContract) return undefined;

    return this.resolveMemberNode(targetContract, calleeName, argumentCount);
  }

  private resolveReceiverType(
    uri: string,
    contract: ContractDefinition,
    receiver: string,
    position: SourceRange["start"],
  ): string | undefined {
    if (receiver === "this") return contract.name;
    if (receiver === "super") return contract.baseContracts[0]?.baseName;

    if (this.symbolIndex) {
      const resolved = resolveDottedReceiverTypeName(
        this.parser,
        this.symbolIndex,
        uri,
        position,
        receiver,
      );
      if (resolved) return normalizeTypeName(resolved);
    }

    return normalizeTypeName(receiver);
  }

  private resolveUsingForTarget(
    uri: string,
    contract: ContractDefinition,
    receiverType: string,
    calleeName: string,
    argumentCount: number | undefined,
  ): SolidityGraphNode | undefined {
    if (!this.symbolIndex) return undefined;
    const hit = findUsingForFunction(
      this.parser,
      this.symbolIndex,
      uri,
      contract,
      receiverType,
      calleeName,
      argumentCount,
      this.resolver,
    );
    if (!hit) return undefined;
    return this.nodes.get(
      this.memberNodeId(
        hit.filePath,
        hit.containerName,
        "function",
        hit.fn.name ?? hit.fn.kind,
        hit.fn.nameRange,
      ),
    );
  }

  private findRawContractNode(uri: string, contractName: string): RawAstNode | undefined {
    const rawAst = this.parser.getRawAst(uri) as RawAstNode | null | undefined;
    if (!rawAst) return undefined;
    return this.rawChildArray(rawAst, "children").find(
      (node) => node.type === "ContractDefinition" && node.name === contractName,
    );
  }

  private findRawFunctionNode(
    uri: string,
    contractNode: RawAstNode | undefined,
    fn: FunctionDefinition,
  ): RawAstNode | undefined {
    if (!contractNode) return undefined;

    return this.rawChildArray(contractNode, "subNodes").find((node) => {
      if (node.type !== "FunctionDefinition") return false;
      if ((node.name ?? null) !== (fn.name ?? null)) return false;
      const rawStart = node.range?.[0];
      const rawEnd = node.range?.[1];
      if (rawStart === undefined || rawEnd === undefined) return true;
      const mappedStart = this.sourceOffsetAt(uri, fn.range.start);
      const mappedEnd = this.sourceOffsetAt(uri, fn.range.end);
      return mappedStart === undefined || mappedEnd === undefined
        ? true
        : rawStart <= mappedStart && rawEnd >= mappedEnd - 1;
    });
  }

  private findRawModifierNode(
    uri: string,
    contractNode: RawAstNode | undefined,
    mod: ModifierDefinition,
  ): RawAstNode | undefined {
    if (!contractNode) return undefined;

    return this.rawChildArray(contractNode, "subNodes").find((node) => {
      if (node.type !== "ModifierDefinition") return false;
      if (node.name !== mod.name) return false;
      const rawStart = node.range?.[0];
      const rawEnd = node.range?.[1];
      if (rawStart === undefined || rawEnd === undefined) return true;
      const mappedStart = this.sourceOffsetAt(uri, mod.range.start);
      const mappedEnd = this.sourceOffsetAt(uri, mod.range.end);
      return mappedStart === undefined || mappedEnd === undefined
        ? true
        : rawStart <= mappedStart && rawEnd >= mappedEnd - 1;
    });
  }

  private rawCallName(
    text: string,
    expression: RawAstNode | undefined,
  ): {
    name: string;
    receiver: string | null;
    receiverLeaf: string | undefined;
    range: SourceRange;
  } | null {
    if (!expression) return null;
    if (expression.type === "Identifier" && expression.name) {
      return {
        name: expression.name,
        receiver: null,
        receiverLeaf: undefined,
        range: this.rawNameRange(text, expression, expression.name),
      };
    }

    if (expression.type === "MemberAccess" && expression.memberName) {
      const receiver = this.rawExpressionToString(expression.expression);
      return {
        name: expression.memberName,
        receiver,
        receiverLeaf: receiver ? receiver.split(".").filter(Boolean).at(-1) : undefined,
        range: this.rawMemberNameRange(text, expression, expression.memberName),
      };
    }

    return null;
  }

  private rawExpressionToString(expression: RawAstNode | undefined): string | null {
    if (!expression) return null;
    if (expression.type === "Identifier" && expression.name) return expression.name;
    if (expression.type === "MemberAccess" && expression.memberName) {
      const receiver = this.rawExpressionToString(expression.expression);
      return receiver ? `${receiver}.${expression.memberName}` : expression.memberName;
    }
    if (expression.type === "IndexAccess") {
      return this.rawExpressionToString(expression.base);
    }
    if (expression.type === "FunctionCall") {
      return this.rawExpressionToString(expression.expression);
    }
    return null;
  }

  private rawTypeNameToString(typeName: RawAstNode | string | undefined): string | undefined {
    if (!typeName) return undefined;
    if (typeof typeName === "string") return typeName;
    if (typeName.name) return typeName.name;
    const namePath = (typeName as { namePath?: unknown }).namePath;
    if (typeof namePath === "string") return namePath.split(".").at(-1) ?? namePath;
    if (typeName.type === "UserDefinedTypeName") {
      const name = (typeName as { name?: unknown }).name;
      if (typeof name === "string") return name.split(".").at(-1) ?? name;
    }
    return undefined;
  }

  private rawNameRange(text: string, node: RawAstNode, name: string): SourceRange {
    const offset = node.range?.[0];
    return offset === undefined ? ZERO_RANGE : this.textOffsetToRange(text, offset, name.length);
  }

  private rawMemberNameRange(text: string, node: RawAstNode, memberName: string): SourceRange {
    const end = node.range?.[1];
    if (end === undefined) return ZERO_RANGE;
    return this.textOffsetToRange(text, end - memberName.length + 1, memberName.length);
  }

  private collectLocalVariableNames(node: RawAstNode | undefined, out: Set<string>): void {
    if (!node) return;
    if (node.type === "VariableDeclaration" && node.name) out.add(node.name);
    for (const variable of this.rawChildArray(node, "variables")) {
      if (!variable) continue;
      if (variable.name) out.add(variable.name);
      if (variable.identifier?.name) out.add(variable.identifier.name);
    }
    this.visitRawChildren(node, (child) => this.collectLocalVariableNames(child, out));
  }

  private visitRawChildren(node: RawAstNode, visit: (node: RawAstNode) => void): void {
    for (const key of ["children", "subNodes", "statements", "arguments", "variables"] as const) {
      for (const child of this.rawChildArray(node, key)) visit(child);
    }
    for (const key of [
      "body",
      "expression",
      "eventCall",
      "revertCall",
      "left",
      "right",
      "base",
      "index",
      "condition",
      "trueBody",
      "falseBody",
      "subExpression",
      "initialValue",
      "identifier",
    ] as const) {
      const child = node[key];
      if (child) visit(child);
    }
  }

  private rawChildArray(
    node: RawAstNode,
    key: "children" | "subNodes" | "statements" | "arguments" | "variables",
  ): RawAstNode[] {
    const value = node[key];
    if (!Array.isArray(value)) return [];
    const children: RawAstNode[] = [];
    for (const child of value) {
      if (isRawAstNode(child)) children.push(child);
    }
    return children;
  }

  private isStatementNode(node: RawAstNode): boolean {
    return Boolean(node.type?.endsWith("Statement") || node.type === "Block");
  }

  private isAssignmentOperator(operator: string | undefined): boolean {
    return operator !== undefined && /^(?:=|\+=|-=|\*=|\/=|%=|\|=|&=|\^=|<<=|>>=)$/.test(operator);
  }

  private isCompoundAssignmentOperator(operator: string | undefined): boolean {
    return operator !== undefined && /^(?:\+=|-=|\*=|\/=|%=|\|=|&=|\^=|<<=|>>=)$/.test(operator);
  }

  private resolveMemberNode(
    contract: ResolvedContract,
    memberName: string,
    argumentCount?: number,
  ): SolidityGraphNode | undefined {
    const cacheKey = `${contract.id}\0${memberName}\0${argumentCount ?? "*"}`;
    if (this.memberNodeIdCache.has(cacheKey)) {
      const cachedId = this.memberNodeIdCache.get(cacheKey);
      return cachedId ? this.nodes.get(cachedId) : undefined;
    }

    if (argumentCount !== undefined) {
      for (const entry of this.resolver.getInheritanceChain(contract.contract.name, contract.uri)) {
        const fn = entry.contract.functions.find(
          (candidate) =>
            candidate.name === memberName && candidate.parameters.length === argumentCount,
        );
        if (fn?.name) {
          const nodeId = this.memberNodeId(
            entry.uri,
            entry.contract.name,
            "function",
            fn.name,
            fn.nameRange,
          );
          this.memberNodeIdCache.set(cacheKey, nodeId);
          return this.nodes.get(nodeId);
        }

        const modifier = entry.contract.modifiers.find(
          (candidate) =>
            candidate.name === memberName && candidate.parameters.length === argumentCount,
        );
        if (modifier) {
          const nodeId = this.memberNodeId(
            entry.uri,
            entry.contract.name,
            "modifier",
            modifier.name,
            modifier.nameRange,
          );
          this.memberNodeIdCache.set(cacheKey, nodeId);
          return this.nodes.get(nodeId);
        }
      }
    }

    const member = this.resolver.findMemberInInheritanceChain(
      contract.contract.name,
      memberName,
      contract.uri,
    );
    if (!member || (member.kind !== "function" && member.kind !== "modifier")) {
      this.memberNodeIdCache.set(cacheKey, undefined);
      return undefined;
    }
    const nodeId = this.memberNodeId(
      member.filePath,
      member.containerName,
      member.kind,
      member.name,
      member.nameRange,
    );
    this.memberNodeIdCache.set(cacheKey, nodeId);
    return this.nodes.get(nodeId);
  }

  private resolveContractMemberGraphNode(
    uri: string,
    contractName: string,
    memberName: string,
    kind: "event" | "error" | "stateVariable",
  ): SolidityGraphNode | undefined {
    const cacheKey = `${uri}\0${contractName}\0${kind}\0${memberName}`;
    if (this.contractMemberNodeIdCache.has(cacheKey)) {
      const cachedId = this.contractMemberNodeIdCache.get(cacheKey);
      return cachedId ? this.nodes.get(cachedId) : undefined;
    }

    const member = this.resolver.findMemberInInheritanceChain(contractName, memberName, uri);
    if (!member || member.kind !== kind) {
      this.contractMemberNodeIdCache.set(cacheKey, undefined);
      return undefined;
    }
    const nodeId = this.memberNodeId(
      member.filePath,
      member.containerName,
      member.kind,
      member.name,
      member.nameRange,
    );
    this.contractMemberNodeIdCache.set(cacheKey, nodeId);
    return this.nodes.get(nodeId);
  }

  private collectStateVariableTargets(
    contract: ContractDefinition,
    uri: string,
  ): {
    name: string;
    filePath: string;
    containerName: string | undefined;
    nameRange: SourceRange;
  }[] {
    const out: {
      name: string;
      filePath: string;
      containerName: string | undefined;
      nameRange: SourceRange;
    }[] = [];

    for (const entry of this.resolver.getInheritanceChain(contract.name, uri)) {
      for (const variable of entry.contract.stateVariables) {
        out.push({
          name: variable.name,
          filePath: entry.uri,
          containerName: entry.contract.name,
          nameRange: variable.nameRange,
        });
      }
    }

    return out;
  }

  private isLocalDeclaration(bodyText: string, name: string, offset: number): boolean {
    const prefix = bodyText.slice(0, offset + name.length);
    const escaped = escapeRegExp(name);
    const declarationRe = new RegExp(
      String.raw`(?:^|[;{}\n])\s*[A-Za-z_$][\w$]*(?:\s*\[[^\]]*\])*\s+(?:(?:memory|storage|calldata)\s+)?${escaped}\b`,
      "g",
    );
    return declarationRe.test(prefix);
  }

  private localShadowStartOffsets(bodyText: string, name: string): number[] {
    const escaped = escapeRegExp(name);
    const declarationRe = new RegExp(
      String.raw`(?:^|[;{}\n])\s*[A-Za-z_$][\w$]*(?:\s*\[[^\]]*\])*\s+(?:(?:memory|storage|calldata)\s+)?${escaped}\b`,
      "g",
    );
    const starts: number[] = [];
    let match: RegExpExecArray | null;
    while ((match = declarationRe.exec(bodyText)) !== null) {
      starts.push(match.index + match[0].lastIndexOf(name));
    }
    return starts;
  }

  private classifyStateAccess(bodyText: string, name: string, offset: number): "reads" | "writes" {
    return this.isStateWrite(bodyText, name, offset) ? "writes" : "reads";
  }

  private isStateWrite(bodyText: string, name: string, offset: number): boolean {
    const before = bodyText.slice(Math.max(0, offset - 16), offset);
    const after = bodyText.slice(offset + name.length);
    return (
      /(?:\+\+|--)\s*$/.test(before) ||
      /\bdelete\s+$/.test(before) ||
      /^\s*(?:\+\+|--|(?:<<|>>|[+\-*/%&|^])?=(?!=))/.test(after)
    );
  }

  private isCompoundStateWrite(bodyText: string, name: string, offset: number): boolean {
    const before = bodyText.slice(Math.max(0, offset - 16), offset);
    const after = bodyText.slice(offset + name.length);
    return /(?:\+\+|--)\s*$/.test(before) || /^\s*(?:\+\+|--|(?:<<|>>|[+\-*/%&|^])=)/.test(after);
  }

  private cachePath(cacheDir: string): string {
    return path.join(cacheDir, `${this.hash(this.workspaceRootKey())}.json`);
  }

  private workspaceRootKey(): string {
    const roots = (this.workspace as Partial<WorkspaceManager>).rootPaths ?? [this.workspace.root];
    return roots.slice().sort().join("\0");
  }

  private workspaceFingerprint(): string {
    const hash = crypto.createHash("sha256");
    hash.update(`graph-index-v${CACHE_VERSION}\0`);
    hash.update(`deps:${this.dependencyIndexing}\0`);
    const roots = (this.workspace as Partial<WorkspaceManager>).rootPaths ?? [this.workspace.root];
    for (const root of roots.slice().sort()) {
      hash.update(`root:${root}\0`);
      this.hashFileStat(hash, path.join(root, "foundry.toml"));
      this.hashFileStat(hash, path.join(root, "remappings.txt"));
    }
    for (const remapping of this.workspace.getRemappings?.() ?? []) {
      hash.update(`remap:${remapping.prefix}=${remapping.path}\0`);
    }
    return hash.digest("hex");
  }

  private fileFingerprint(uri: string): string | undefined {
    try {
      const filePath = this.workspace.uriToPath(uri);
      const stat = fs.statSync(filePath);
      return this.hash(`${uri}\0${filePath}\0${stat.size}\0${stat.mtimeMs}`);
    } catch {
      return undefined;
    }
  }

  private cacheFileEntries(): GraphIndexCacheFileEntry[] {
    const nodesByUri = new Map<string, SolidityGraphNode[]>();
    for (const node of this.nodes.values()) {
      const nodes = nodesByUri.get(node.uri) ?? [];
      nodes.push(node);
      nodesByUri.set(node.uri, nodes);
    }

    const edgesBySourceUri = new Map<string, SolidityGraphEdge[]>();
    for (const edge of this.edges) {
      const sourceUri = this.edgeSourceUri(edge);
      if (!sourceUri) continue;
      const edges = edgesBySourceUri.get(sourceUri) ?? [];
      edges.push(edge);
      edgesBySourceUri.set(sourceUri, edges);
    }

    const entries: GraphIndexCacheFileEntry[] = [];
    for (const uri of this.prioritizeWorkspaceUris(this.graphFileUris())) {
      const fingerprint = this.fileFingerprint(uri);
      if (!fingerprint) continue;
      entries.push({
        uri,
        filePath: this.safeUriToPath(uri),
        fingerprint,
        relationshipsComplete: this.relationshipIndexedUris.has(uri),
        nodes: nodesByUri.get(uri) ?? [],
        edges: edgesBySourceUri.get(uri) ?? [],
      });
    }
    return entries;
  }

  private edgeSourceUri(edge: SolidityGraphEdge): string | undefined {
    const sourceNode = this.nodes.get(edge.source);
    if (sourceNode) return sourceNode.uri;
    if (edge.source.startsWith("file:")) return edge.source.slice("file:".length);
    return undefined;
  }

  private hashFileStat(hash: crypto.Hash, filePath: string): void {
    try {
      const stat = fs.statSync(filePath);
      hash.update(`${filePath}:${stat.size}:${stat.mtimeMs}\0`);
    } catch {
      hash.update(`${filePath}:missing\0`);
    }
  }

  private hash(value: string): string {
    return crypto.createHash("sha256").update(value).digest("hex");
  }

  private rebuildNodeIdsByFile(): void {
    this.nodeIdsByFile.clear();
    for (const node of this.nodes.values()) {
      const fileNodes = this.nodeIdsByFile.get(node.uri) ?? new Set<string>();
      fileNodes.add(node.id);
      this.nodeIdsByFile.set(node.uri, fileNodes);
    }
  }

  private isCacheEntry(entry: unknown): entry is GraphIndexCacheFileEntry {
    if (!entry || typeof entry !== "object") return false;
    const candidate = entry as Partial<GraphIndexCacheFileEntry>;
    return (
      typeof candidate.uri === "string" &&
      typeof candidate.filePath === "string" &&
      typeof candidate.fingerprint === "string" &&
      typeof candidate.relationshipsComplete === "boolean" &&
      Array.isArray(candidate.nodes) &&
      Array.isArray(candidate.edges)
    );
  }

  private isCacheNode(node: unknown): node is SolidityGraphNode {
    if (!node || typeof node !== "object") return false;
    const candidate = node as Partial<SolidityGraphNode>;
    return (
      typeof candidate.id === "string" &&
      typeof candidate.kind === "string" &&
      VALID_NODE_KINDS.has(candidate.kind as SolidityGraphNodeKind) &&
      typeof candidate.name === "string" &&
      typeof candidate.qualifiedName === "string" &&
      typeof candidate.uri === "string" &&
      typeof candidate.filePath === "string" &&
      typeof candidate.tier === "string" &&
      this.isSourceRange(candidate.range) &&
      this.isSourceRange(candidate.selectionRange)
    );
  }

  private isCacheEdge(edge: unknown): edge is SolidityGraphEdge {
    if (!edge || typeof edge !== "object") return false;
    const candidate = edge as Partial<SolidityGraphEdge>;
    return (
      typeof candidate.source === "string" &&
      typeof candidate.target === "string" &&
      typeof candidate.kind === "string" &&
      VALID_EDGE_KINDS.has(candidate.kind as SolidityGraphEdgeKind) &&
      (candidate.resolutionConfidence === undefined ||
        VALID_RESOLUTION_CONFIDENCE.has(candidate.resolutionConfidence)) &&
      (candidate.unresolvedTarget === undefined ||
        typeof candidate.unresolvedTarget === "boolean") &&
      (!candidate.range || this.isSourceRange(candidate.range))
    );
  }

  private isSourceRange(range: unknown): range is SourceRange {
    if (!range || typeof range !== "object") return false;
    const candidate = range as Partial<SourceRange>;
    return this.isPosition(candidate.start) && this.isPosition(candidate.end);
  }

  private isPosition(position: unknown): position is SourceRange["start"] {
    if (!position || typeof position !== "object") return false;
    const candidate = position as Partial<SourceRange["start"]>;
    return typeof candidate.line === "number" && typeof candidate.character === "number";
  }

  private fileNode(uri: string): SolidityGraphNode {
    const filePath = this.safeUriToPath(uri);
    return {
      id: this.fileNodeId(uri),
      kind: "file",
      name: filePath ? (filePath.split(/[\\/]/).pop() ?? uri) : uri,
      qualifiedName: filePath || uri,
      uri,
      filePath,
      tier: this.fileTier(uri),
      range: ZERO_RANGE,
      selectionRange: ZERO_RANGE,
    };
  }

  private fileNodeId(uri: string): string {
    return `file:${uri}`;
  }

  private memberNode(
    uri: string,
    parentId: string,
    kind: SolidityGraphNodeKind,
    name: string,
    range: SourceRange,
    selectionRange: SourceRange,
    extra: Pick<SolidityGraphNode, "containerName" | "detail"> = {},
  ): SolidityGraphNode {
    const id = this.memberNodeId(uri, extra.containerName, kind, name, selectionRange);
    const qualifiedName = extra.containerName ? `${extra.containerName}.${name}` : name;
    return {
      id,
      kind,
      name,
      qualifiedName,
      uri,
      filePath: this.safeUriToPath(uri),
      tier: this.fileTier(uri),
      range,
      selectionRange,
      containerId: parentId,
      containerName: extra.containerName,
      detail: extra.detail,
    };
  }

  private memberNodeId(
    uri: string,
    containerName: string | undefined,
    kind: string,
    name: string,
    selectionRange: SourceRange,
  ): string {
    const container = containerName ? `#${containerName}` : "";
    return `${uri}${container}:${kind}:${name}:${selectionRange.start.line}:${selectionRange.start.character}`;
  }

  private addNode(node: SolidityGraphNode): void {
    this.nodes.set(node.id, node);
    const fileNodes = this.nodeIdsByFile.get(node.uri) ?? new Set<string>();
    fileNodes.add(node.id);
    this.nodeIdsByFile.set(node.uri, fileNodes);
  }

  private addEdge(edge: SolidityGraphEdge): void {
    const normalized = this.normalizeEdge(edge);
    const key = this.edgeKey(normalized);
    if (this.edgeKeys.has(key)) return;
    this.edgeKeys.add(key);
    this.edges.push(normalized);
    this.indexEdge(normalized);
  }

  private normalizeEdge(edge: SolidityGraphEdge): SolidityGraphEdge {
    const resolutionConfidence =
      this.validResolutionConfidence(edge.resolutionConfidence) ??
      this.metadataResolutionConfidence(edge.metadata);
    const unresolvedTarget =
      edge.unresolvedTarget ?? (edge.metadata?.unresolvedTarget === true ? true : undefined);
    const evidence =
      edge.evidence ??
      this.edgeEvidence(edge, resolutionConfidence ?? "unknown", unresolvedTarget === true);

    return {
      ...edge,
      ...(resolutionConfidence ? { resolutionConfidence } : {}),
      ...(unresolvedTarget !== undefined ? { unresolvedTarget } : {}),
      evidence,
    };
  }

  private edgeEvidence(
    edge: SolidityGraphEdge,
    resolver: ProjectGraphResolutionConfidence,
    unresolved: boolean,
  ): ProjectGraphEdgeEvidence {
    const sourceNode = this.nodes.get(edge.source);
    const targetNode = this.nodes.get(edge.target);
    const detail = this.edgeDetail(edge);
    const unresolvedPrefix = unresolved ? "unresolved " : "";
    return {
      summary: `${unresolvedPrefix}${edge.kind}${detail ? `: ${detail}` : ""}`,
      resolver,
      source: sourceNode?.qualifiedName ?? edge.source,
      target: targetNode?.qualifiedName ?? edge.target,
      sourceUri: sourceNode?.uri || this.edgeSourceUri(edge),
      sourceRange: edge.range,
      targetUri: targetNode?.uri,
      targetRange: targetNode?.selectionRange,
    };
  }

  private edgeDetail(edge: SolidityGraphEdge): string {
    const metadata = edge.metadata;
    const value = (...keys: string[]): string | undefined => {
      for (const key of keys) {
        const raw = metadata?.[key];
        if (typeof raw === "string" && raw.length > 0) return raw;
      }
      return undefined;
    };

    switch (edge.kind) {
      case "imports":
        return value("importPath") ?? "";
      case "inherits":
        return value("baseName") ?? "";
      case "implements":
      case "overrides":
        return [value("memberName"), value("baseName")].filter(Boolean).join(" from ");
      case "calls":
      case "externalCall":
        return value("calleeName") ?? "";
      case "delegateCall":
        return value("receiver", "receiverType") ?? "";
      case "creates":
        return value("contractName") ?? "";
      case "usesModifier":
        return value("modifierName") ?? "";
      case "reads":
      case "writes":
        return value("variableName") ?? "";
      case "emits":
        return value("eventName") ?? "";
      case "revertsWith":
        return value("errorName") ?? "";
      case "usesType":
        return [value("typeName"), value("usage")].filter(Boolean).join(" as ");
      default:
        return "";
    }
  }

  private edgeResolutionConfidence(edge: SolidityGraphEdge): ProjectGraphResolutionConfidence {
    return (
      this.validResolutionConfidence(edge.resolutionConfidence) ??
      this.metadataResolutionConfidence(edge.metadata) ??
      "unknown"
    );
  }

  private metadataResolutionConfidence(
    metadata: Record<string, unknown> | undefined,
  ): ProjectGraphResolutionConfidence | undefined {
    return this.validResolutionConfidence(metadata?.resolutionConfidence);
  }

  private validResolutionConfidence(value: unknown): ProjectGraphResolutionConfidence | undefined {
    return typeof value === "string" &&
      VALID_RESOLUTION_CONFIDENCE.has(value as ProjectGraphResolutionConfidence)
      ? (value as ProjectGraphResolutionConfidence)
      : undefined;
  }

  private isUnresolvedEdge(edge: SolidityGraphEdge): boolean {
    return edge.unresolvedTarget === true || edge.metadata?.unresolvedTarget === true;
  }

  private edgeKey(edge: SolidityGraphEdge): string {
    const line = edge.range?.start.line ?? "";
    const character = edge.range?.start.character ?? "";
    return `${edge.source}->${edge.kind}->${edge.target}@${line}:${character}`;
  }

  private dedupeEdges(edges: SolidityGraphEdge[]): SolidityGraphEdge[] {
    const seen = new Set<string>();
    const deduped: SolidityGraphEdge[] = [];
    for (const edge of edges) {
      const key = this.edgeKey(edge);
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(edge);
    }
    return deduped;
  }

  private indexEdge(edge: SolidityGraphEdge): void {
    this.pushIndexedEdge(this.edgesBySource, edge.source, edge);
    this.pushIndexedEdge(this.edgesByTarget, edge.target, edge);
    this.pushIndexedEdge(this.edgesByKind, edge.kind, edge);
    if (edge.kind === "imports" && edge.source.startsWith("file:")) {
      const sources = this.importSourcesByTarget.get(edge.target) ?? [];
      sources.push(edge.source.slice("file:".length));
      this.importSourcesByTarget.set(edge.target, sources);
    }
  }

  private pushIndexedEdge<K>(
    index: Map<K, SolidityGraphEdge[]>,
    key: K,
    edge: SolidityGraphEdge,
  ): void {
    const edges = index.get(key) ?? [];
    edges.push(edge);
    index.set(key, edges);
  }

  private rebuildEdgeIndexes(): void {
    this.edgeKeys = new Set(this.edges.map((edge) => this.edgeKey(edge)));
    this.edgesBySource.clear();
    this.edgesByTarget.clear();
    this.edgesByKind.clear();
    this.importSourcesByTarget.clear();
    for (const edge of this.edges) this.indexEdge(edge);
  }

  private clearEdgeIndexes(): void {
    this.edgeKeys.clear();
    this.edgesBySource.clear();
    this.edgesByTarget.clear();
    this.edgesByKind.clear();
    this.importSourcesByTarget.clear();
  }

  private clearResolutionCaches(): void {
    this.typeNodeIdCache.clear();
    this.memberNodeIdCache.clear();
    this.contractMemberNodeIdCache.clear();
  }

  private resolveImport(uri: string, importPath: string): string | null {
    try {
      return this.workspace.resolveImport(importPath, this.workspace.uriToPath(uri));
    } catch {
      return null;
    }
  }

  private fileTier(uri: string): SolidityGraphNode["tier"] {
    const tier = (this.workspace as Partial<WorkspaceManager>).getFileTier?.(uri);
    return tier ?? "unknown";
  }

  private safeUriToPath(uri: string): string {
    try {
      return this.workspace.uriToPath(uri);
    } catch {
      return "";
    }
  }

  private functionSignature(fn: FunctionDefinition): string {
    const params = fn.parameters
      .map((p) => `${p.typeName}${p.name ? ` ${p.name}` : ""}`)
      .join(", ");
    const returns = fn.returnParameters.map((p) => p.typeName).join(", ");
    return `${fn.name ?? fn.kind}(${params})${returns ? ` returns (${returns})` : ""}`;
  }

  private functionBody(text: string, range: SourceRange): FunctionBody | null {
    const lines = text.split("\n");
    const startLine = Math.max(0, range.start.line);
    const open = this.findOpenBrace(lines, startLine);
    if (!open) return null;

    let depth = 0;
    let body = "";
    for (let lineNo = open.line; lineNo < lines.length; lineNo++) {
      const line = lines[lineNo];
      const start = lineNo === open.line ? open.character + 1 : 0;
      for (let character = start; character < line.length; character++) {
        const ch = line[character];
        if (ch === "{") depth++;
        if (ch === "}") {
          if (depth === 0) {
            const newlineOffsets = this.newlineOffsets(body);
            return {
              text: body,
              startLine: open.line,
              startCharacter: open.character + 1,
              newlineOffsets,
            };
          }
          depth--;
        }
        body += ch;
      }
      if (lineNo < lines.length - 1) body += "\n";
    }
    return null;
  }

  private findOpenBrace(
    lines: string[],
    startLine: number,
  ): { line: number; character: number } | null {
    for (let lineNo = startLine; lineNo < lines.length; lineNo++) {
      const character = lines[lineNo].indexOf("{");
      if (character >= 0) return { line: lineNo, character };
    }
    return null;
  }

  private newlineOffsets(text: string): number[] {
    const out: number[] = [];
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) out.push(i);
    }
    return out;
  }

  private bodyOffsetToRange(body: FunctionBody, offset: number, length: number): SourceRange {
    let lineDelta = 0;
    while (lineDelta < body.newlineOffsets.length && body.newlineOffsets[lineDelta] < offset) {
      lineDelta++;
    }
    const lineStart = lineDelta === 0 ? 0 : body.newlineOffsets[lineDelta - 1] + 1;
    const line = body.startLine + lineDelta;
    const character =
      lineDelta === 0 ? body.startCharacter + offset : Math.max(0, offset - lineStart);
    return {
      start: { line, character },
      end: { line, character: character + length },
    };
  }

  private sourceOffsetAt(uri: string, position: SourceRange["start"]): number | undefined {
    const text = this.parser.getText(uri);
    if (text === undefined) return undefined;
    const lines = text.split("\n");
    if (position.line < 0 || position.line >= lines.length) return undefined;

    let offset = 0;
    for (let i = 0; i < position.line; i++) {
      offset += lines[i].length + 1;
    }
    return offset + Math.min(position.character, lines[position.line].length);
  }

  private textOffsetToRange(text: string, offset: number, length: number): SourceRange {
    const clampedOffset = Math.max(0, Math.min(offset, text.length));
    let line = 0;
    let lineStart = 0;
    for (let i = 0; i < clampedOffset; i++) {
      if (text.charCodeAt(i) === 10) {
        line++;
        lineStart = i + 1;
      }
    }

    const character = clampedOffset - lineStart;
    return {
      start: { line, character },
      end: { line, character: character + length },
    };
  }

  private extractReceiverAtCall(body: FunctionBody, calleeOffset: number): string | null {
    let lineDelta = 0;
    while (
      lineDelta < body.newlineOffsets.length &&
      body.newlineOffsets[lineDelta] < calleeOffset
    ) {
      lineDelta++;
    }
    const lineStart = lineDelta === 0 ? 0 : body.newlineOffsets[lineDelta - 1] + 1;
    const nextLineStart =
      lineDelta < body.newlineOffsets.length ? body.newlineOffsets[lineDelta] : body.text.length;
    const line = body.text.slice(lineStart, nextLineStart);
    const memberStart = calleeOffset - lineStart;
    return extractDottedReceiver(line, memberStart);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface GraphSearchScore {
  score: number;
  matchedText: string;
}

function scoreGraphNodeSearch(node: ProjectGraphNode, query: string): GraphSearchScore | null {
  const candidates: { text: string | undefined; normalized: string; weight: number }[] = [
    { text: node.qualifiedName, normalized: normalizeSearchText(node.qualifiedName), weight: 0 },
    { text: node.name, normalized: normalizeSearchText(node.name), weight: -25 },
    { text: node.containerName, normalized: normalizeSearchText(node.containerName), weight: -80 },
    { text: node.kind, normalized: normalizeSearchText(node.kind), weight: -120 },
    { text: node.filePath, normalized: normalizeSearchText(node.filePath), weight: -180 },
    { text: node.detail, normalized: normalizeSearchText(node.detail), weight: -240 },
  ];

  let best: GraphSearchScore | null = null;
  for (const candidate of candidates) {
    if (!candidate.text || !candidate.normalized) continue;
    const score = scoreSearchCandidate(candidate.normalized, query, candidate.weight);
    if (score === null) continue;
    if (!best || score > best.score) {
      best = { score, matchedText: candidate.text };
    }
  }
  return best;
}

function scoreSearchCandidate(candidate: string, query: string, weight: number): number | null {
  if (candidate === query) return 1000 + weight;
  if (candidate.endsWith(`.${query}`)) return 940 + weight;
  if (candidate.startsWith(query)) return 860 + weight;

  const segmentHit = candidate.split(/[^a-z0-9_]+/u).some((segment) => segment.startsWith(query));
  if (segmentHit) return 780 + weight;

  const index = candidate.indexOf(query);
  if (index >= 0) {
    const earlyMatchBonus = Math.max(0, 80 - index);
    return 650 + earlyMatchBonus + weight;
  }

  const subsequenceScore = scoreOrderedSubsequence(candidate, query);
  return subsequenceScore === null ? null : 250 + subsequenceScore + weight;
}

function scoreOrderedSubsequence(candidate: string, query: string): number | null {
  let queryIndex = 0;
  let first = -1;
  let last = -1;
  for (let i = 0; i < candidate.length && queryIndex < query.length; i++) {
    if (candidate[i] !== query[queryIndex]) continue;
    if (first === -1) first = i;
    last = i;
    queryIndex++;
  }
  if (queryIndex !== query.length) return null;

  const span = Math.max(1, last - first + 1);
  const density = query.length / span;
  return Math.round(density * 160) + Math.max(0, 40 - first);
}

function normalizeSearchText(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function graphTierRank(tier: ProjectGraphNode["tier"]): number {
  switch (tier) {
    case "project":
      return 0;
    case "tests":
      return 1;
    case "deps":
      return 2;
    case "unknown":
    default:
      return 3;
  }
}

function maskCommentsAndStrings(text: string): string {
  let out = "";
  let i = 0;
  let state: "code" | "lineComment" | "blockComment" | "single" | "double" = "code";

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (state === "code") {
      if (ch === "/" && next === "/") {
        out += "  ";
        i += 2;
        state = "lineComment";
        continue;
      }
      if (ch === "/" && next === "*") {
        out += "  ";
        i += 2;
        state = "blockComment";
        continue;
      }
      if (ch === "'") {
        out += " ";
        i++;
        state = "single";
        continue;
      }
      if (ch === '"') {
        out += " ";
        i++;
        state = "double";
        continue;
      }
      out += ch;
      i++;
      continue;
    }

    if (state === "lineComment") {
      out += ch === "\n" ? "\n" : " ";
      i++;
      if (ch === "\n") state = "code";
      continue;
    }

    if (state === "blockComment") {
      if (ch === "*" && next === "/") {
        out += "  ";
        i += 2;
        state = "code";
        continue;
      }
      out += ch === "\n" ? "\n" : " ";
      i++;
      continue;
    }

    if (state === "single" || state === "double") {
      const quote = state === "single" ? "'" : '"';
      if (ch === "\\" && next !== undefined) {
        out += next === "\n" ? " \n" : "  ";
        i += 2;
        continue;
      }
      out += ch === "\n" ? "\n" : " ";
      i++;
      if (ch === quote) state = "code";
    }
  }

  return out;
}

function isRawAstNode(value: RawAstNode | null | undefined): value is RawAstNode {
  return Boolean(value);
}
