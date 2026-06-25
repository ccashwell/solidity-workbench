/**
 * Custom LSP protocol extensions for Solidity Workbench.
 * These extend the standard LSP with Solidity/Foundry-specific notifications and requests.
 */

import type { SourceRange } from "./types.js";

// ── Custom Notifications (server → client) ───────────────────────────

/** Notification sent when forge build completes */
export const ForgeBuildComplete = "solidity-workbench/forgeBuildComplete";

export interface ForgeBuildCompleteParams {
  success: boolean;
  errors: number;
  warnings: number;
  duration: number; // milliseconds
}

/** Notification sent when forge test results are available */
export const ForgeTestResults = "solidity-workbench/forgeTestResults";

export interface ForgeTestResultsParams {
  file: string;
  contract: string;
  tests: {
    name: string;
    status: "pass" | "fail" | "skip";
    gasUsed?: number;
    reason?: string;
  }[];
}

/** Notification for gas snapshot updates */
export const GasSnapshotUpdate = "solidity-workbench/gasSnapshotUpdate";

export interface GasSnapshotUpdateParams {
  snapshots: {
    contract: string;
    function: string;
    gasUsed: number;
    previousGasUsed?: number;
    delta?: number;
  }[];
}

/**
 * Server state heartbeat — pushed on init, after every forge build, and
 * whenever indexing progress crosses a round-number milestone. Drives the
 * status bar in the extension client.
 */
export const ServerStateNotification = "solidity-workbench/serverState";

export type ServerStateIndexing = {
  phase: "indexing";
  filesIndexed: number;
  filesTotal: number;
};

export type ServerStateIdle = {
  phase: "idle";
  rootCount: number;
  fileCount: number;
};

export type ServerStateBuilding = {
  phase: "building";
};

export type ServerStateBuildResult = {
  phase: "build-result";
  success: boolean;
  errorCount: number;
  warningCount: number;
  durationMs: number;
};

export type ServerStateParams =
  | ServerStateIndexing
  | ServerStateIdle
  | ServerStateBuilding
  | ServerStateBuildResult;

// ── Custom Requests (client → server) ────────────────────────────────

/**
 * List test contracts and functions across the workspace, resolved from
 * the already-parsed AST (not by the client re-regexing test files).
 *
 * The client uses this to populate the VSCode Test Explorer. It replaces
 * the previous `parseTestFile` path in `FoundryTestProvider`, which
 * misbehaved on braces inside strings and multi-line function headers.
 */
export const ListTests = "solidity-workbench/listTests";

export interface ListTestsParams {
  /**
   * Optional: limit results to files under the given folder URI. When
   * omitted, every workspace root is scanned.
   */
  folderUri?: string;
}

export interface TestContractInfo {
  /** File URI */
  uri: string;
  /** Contract name (e.g. `CounterTest`) */
  name: string;
  /** Inclusive LSP range of the contract declaration */
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  /** One entry per `test_*`, `testFuzz_*`, `testFork_*`, `testFail_*`, `invariant_*`, or `setUp`. */
  tests: TestFunctionInfo[];
}

export interface TestFunctionInfo {
  /** Function name (e.g. `test_InitialCountIsZero`) */
  name: string;
  /**
   * Classification of the test type so the client can attach tags /
   * different icons. `setUp` and `invariant` are grouped under `"other"`.
   */
  kind: "test" | "testFuzz" | "testFork" | "testFail" | "invariant" | "setUp";
  /** Inclusive LSP range of the function declaration */
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  /** Is this function in a `.t.sol` test file? (Saves the client a regex.) */
  isTestFile: boolean;
}

export interface ListTestsResult {
  contracts: TestContractInfo[];
}

/** Request to get the storage layout for a contract */
export const GetStorageLayout = "solidity-workbench/getStorageLayout";

export interface GetStorageLayoutParams {
  contractPath: string;
  contractName: string;
}

export interface StorageLayoutResult {
  storage: {
    slot: string;
    offset: number;
    type: string;
    label: string;
    numberOfBytes: string;
  }[];
}

/** Request to get the inheritance graph for a contract */
export const GetInheritanceGraph = "solidity-workbench/getInheritanceGraph";

export interface GetInheritanceGraphParams {
  contractPath?: string;
  contractName?: string;
}

export interface InheritanceGraphResult {
  focusId?: string;
  nodes: {
    id: string;
    name: string;
    filePath: string;
    uri: string;
    kind: string;
    tier: "project" | "tests" | "deps" | "unknown";
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
    selectionRange: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
    missing?: boolean;
  }[];
  edges: { from: string; to: string; baseName: string }[];
}

/** Request a workspace-wide semantic graph snapshot. */
export const GetProjectGraph = "solidity-workbench/getProjectGraph";

export type ProjectGraphNodeKind =
  | "file"
  | "contract"
  | "interface"
  | "library"
  | "function"
  | "constructor"
  | "receive"
  | "fallback"
  | "modifier"
  | "event"
  | "error"
  | "stateVariable"
  | "fileConstant"
  | "struct"
  | "enum"
  | "userDefinedValueType";

export type ProjectGraphEdgeKind =
  | "contains"
  | "imports"
  | "inherits"
  | "implements"
  | "overrides"
  | "calls"
  | "externalCall"
  | "delegateCall"
  | "creates"
  | "usesModifier"
  | "reads"
  | "writes"
  | "emits"
  | "revertsWith"
  | "usesType";

export type ProjectGraphResolutionConfidence = "solc" | "parser" | "heuristic" | "unknown";

export interface ProjectGraphEdgeEvidence {
  /** Short user-facing explanation for why this edge exists. */
  summary: string;
  /** Resolution path used to choose the target, when applicable. */
  resolver: ProjectGraphResolutionConfidence;
  /** Source endpoint label captured when the edge was produced. */
  source?: string;
  /** Target endpoint label captured when the edge was produced. */
  target?: string;
  /** URI/range of the source syntax that produced the edge. */
  sourceUri?: string;
  sourceRange?: SourceRange;
  /** URI/range of the target declaration, when known. */
  targetUri?: string;
  targetRange?: SourceRange;
}

export interface GetProjectGraphParams {
  /** Optional edge-kind filter. Omit to return every known edge kind. */
  edgeKinds?: ProjectGraphEdgeKind[];
  /** Optional node cap for interactive views. Omit for full export/report payloads. */
  maxNodes?: number;
}

/** Request a focused project graph neighborhood around a symbol or source position. */
export const GetProjectGraphNeighborhood = "solidity-workbench/getProjectGraphNeighborhood";

export interface GetProjectGraphNeighborhoodParams {
  /** Explicit graph node id to focus. Takes precedence over uri/position. */
  rootId?: string;
  /** Source file URI used with `position` to find the innermost graph node. */
  uri?: string;
  /** Source position used with `uri` to find the innermost graph node. */
  position?: SourceRange["start"];
  /** Number of edge hops to include. Defaults to 2. */
  depth?: number;
  /** Direction to traverse from the root. Defaults to both. */
  direction?: "incoming" | "outgoing" | "both";
  /** Optional edge-kind filter. Omit to traverse every known edge kind. */
  edgeKinds?: ProjectGraphEdgeKind[];
  /** Maximum nodes to return. Defaults to 240. */
  maxNodes?: number;
  /** Include containing declarations for context. Defaults to true. */
  includeContainers?: boolean;
}

/** Request the shortest graph path between two nodes or source positions. */
export const GetProjectGraphPath = "solidity-workbench/getProjectGraphPath";

export interface ProjectGraphEndpoint {
  /** Explicit graph node id. Takes precedence over uri/position. */
  nodeId?: string;
  /** Source file URI used with `position` to find the innermost graph node. */
  uri?: string;
  /** Source position used with `uri` to find the innermost graph node. */
  position?: SourceRange["start"];
}

export interface GetProjectGraphPathParams {
  from: ProjectGraphEndpoint;
  to: ProjectGraphEndpoint;
  /** Direction to traverse from the source. Defaults to outgoing. */
  direction?: "incoming" | "outgoing" | "both";
  /** Optional edge-kind filter. Omit to traverse every known edge kind. */
  edgeKinds?: ProjectGraphEdgeKind[];
  /** Maximum hops to search. Defaults to 16. */
  maxDepth?: number;
}

export interface ProjectGraphNode {
  id: string;
  kind: ProjectGraphNodeKind;
  name: string;
  qualifiedName: string;
  uri: string;
  filePath: string;
  tier: "project" | "tests" | "deps" | "unknown";
  range: SourceRange;
  selectionRange: SourceRange;
  containerId?: string;
  containerName?: string;
  detail?: string;
}

export interface ProjectGraphEdge {
  source: string;
  target: string;
  kind: ProjectGraphEdgeKind;
  range?: SourceRange;
  /**
   * How the target was resolved. `solc` means a warm compiler AST confirmed the
   * target, `parser` means the parser/symbol index resolved it, `heuristic`
   * means the edge is best-effort, and `unknown` means the edge kind is
   * structural or predates confidence tagging.
   */
  resolutionConfidence?: ProjectGraphResolutionConfidence;
  /** True when the source operation is known but the concrete target is not. */
  unresolvedTarget?: boolean;
  /** Human-readable evidence explaining why the edge exists. */
  evidence?: ProjectGraphEdgeEvidence;
  metadata?: Record<string, unknown>;
}

export interface ProjectGraphResult {
  nodes: ProjectGraphNode[];
  edges: ProjectGraphEdge[];
  focusId?: string;
  truncated?: boolean;
}

export interface ProjectGraphPathResult extends ProjectGraphResult {
  fromId?: string;
  toId?: string;
  found: boolean;
}

/** Request ranked symbol search over the indexed project graph. */
export const SearchProjectGraph = "solidity-workbench/searchProjectGraph";

export interface SearchProjectGraphParams {
  query: string;
  /** Optional node-kind filter. Omit to search every node kind. */
  kinds?: ProjectGraphNodeKind[];
  /** Include adjacent edges for each matched node. Defaults to false. */
  includeEdges?: boolean;
  /** Direction for adjacent edges when includeEdges is true. Defaults to both. */
  edgeDirection?: "incoming" | "outgoing" | "both";
  /** Optional adjacent edge-kind filter. Omit to include every known edge kind. */
  edgeKinds?: ProjectGraphEdgeKind[];
  /** Maximum ranked node matches. Defaults to 50. */
  maxResults?: number;
  /** Maximum adjacent edges per matched node. Defaults to 32. */
  maxEdgesPerNode?: number;
}

export interface ProjectGraphSearchMatch {
  node: ProjectGraphNode;
  /** Relative rank; larger scores are better matches. */
  score: number;
  /** The indexed field that produced the winning match. */
  matchedText: string;
  /** Adjacent edges when requested. */
  edges?: ProjectGraphEdge[];
  /** Endpoint nodes for adjacent edges when requested. */
  relatedNodes?: ProjectGraphNode[];
  edgesTruncated?: boolean;
}

export interface ProjectGraphSearchResult {
  query: string;
  matches: ProjectGraphSearchMatch[];
  truncated?: boolean;
  indexStatus?: ProjectGraphIndexStatus;
  edgeQuality?: ProjectGraphEdgeQuality;
}

export interface ProjectGraphIndexStatus {
  relationshipIndexComplete?: boolean;
  relationshipFilesIndexed?: number;
  relationshipFilesTotal?: number;
  pendingRelationshipFiles?: number;
  partial: boolean;
}

export interface ProjectGraphEdgeQuality {
  edgesByResolutionConfidence: Partial<Record<ProjectGraphResolutionConfidence, number>>;
  unresolvedEdgeCount: number;
  lowConfidenceEdgeCount: number;
}

/** Request a focused graph query over callers, callees, or impact radius. */
export const QueryProjectGraph = "solidity-workbench/queryProjectGraph";

export type ProjectGraphQueryKind = "callers" | "callees" | "impact";
export type ProjectGraphQueryMissReason = "targetNotFound" | "targetKindMismatch";

export interface QueryProjectGraphParams {
  kind: ProjectGraphQueryKind;
  /** Explicit graph endpoint to query. Takes precedence over query. */
  target?: ProjectGraphEndpoint;
  /** Symbol query used when target is omitted. The best ranked match is queried. */
  query?: string;
  /** Restrict query targets by node kind. Applies to explicit targets and text queries. */
  targetKinds?: ProjectGraphNodeKind[];
  /** Optional edge-kind filter. Defaults depend on query kind. */
  edgeKinds?: ProjectGraphEdgeKind[];
  /** Maximum traversal depth. Defaults to 1 for callers/callees and 2 for impact. */
  maxDepth?: number;
  /** Maximum nodes to return. Defaults to 240. */
  maxNodes?: number;
  /** Include containing declarations for context. Defaults to true. */
  includeContainers?: boolean;
}

export interface ProjectGraphQueryResult extends ProjectGraphResult {
  kind: ProjectGraphQueryKind;
  query?: string;
  targetId?: string;
  found: boolean;
  missReason?: ProjectGraphQueryMissReason;
  indexStatus?: ProjectGraphIndexStatus;
  edgeQuality?: ProjectGraphEdgeQuality;
}

/** Request lightweight project graph size and timing stats. */
export const GetProjectGraphStats = "solidity-workbench/getProjectGraphStats";

/** Request a fresh project graph declaration rebuild, with relationship edges queued or indexed. */
export const RebuildProjectGraph = "solidity-workbench/rebuildProjectGraph";

export interface RebuildProjectGraphParams {
  /** Relationship indexing mode. Defaults to background. */
  relationships?: "background" | "blocking" | "declarationsOnly";
}

export interface ProjectGraphStatsResult {
  nodeCount: number;
  edgeCount: number;
  nodesByKind: Partial<Record<ProjectGraphNodeKind, number>>;
  edgesByKind: Partial<Record<ProjectGraphEdgeKind, number>>;
  edgesByResolutionConfidence?: Partial<Record<ProjectGraphResolutionConfidence, number>>;
  unresolvedEdgeCount?: number;
  filesByTier: Partial<Record<"project" | "tests" | "deps" | "unknown", number>>;
  lastRebuildDurationMs: number | null;
  lastUpdateDurationMs: number | null;
  cacheHit?: boolean;
  lastCacheRestoreDurationMs?: number | null;
  lastCacheWriteDurationMs?: number | null;
  relationshipFilesIndexed?: number;
  relationshipFilesTotal?: number;
  pendingRelationshipFiles?: number;
  relationshipIndexComplete?: boolean;
  rebuildCanceled?: boolean;
}

// ── Semantic Token Types ─────────────────────────────────────────────

/**
 * Custom semantic token types for Solidity beyond the LSP standard set.
 * These give us fine-grained, role-based highlighting.
 */
export const SolSemanticTokenTypes = [
  // Standard LSP types we use
  "namespace", // pragma, import paths
  "type", // contract/interface/library names in type position
  "class", // contract/interface/library definitions
  "interface", // interface definitions
  "struct", // struct definitions
  "enum", // enum definitions
  "typeParameter", // (reserved)
  "parameter", // function/event/error parameters
  "variable", // local variables
  "property", // struct members, state variables
  "function", // function definitions and calls
  "method", // contract function calls (external)
  "macro", // modifiers
  "keyword", // Solidity keywords
  "modifier", // visibility/mutability keywords
  "comment", // natspec comments
  "string", // string literals
  "number", // number literals
  "operator", // operators
  "decorator", // annotations / natspec tags
  "event", // event definitions and emissions
] as const;

export const SolSemanticTokenModifiers = [
  "declaration",
  "definition",
  "readonly", // constants, immutables
  "static", // library functions
  "deprecated", // (for future lint integration)
  "abstract", // abstract contracts/functions
  "virtual", // virtual functions
  "override", // override functions
  "documentation", // natspec
  "defaultLibrary", // built-in globals (msg, block, tx, abi, etc.)
] as const;
