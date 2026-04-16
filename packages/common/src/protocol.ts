/**
 * Custom LSP protocol extensions for Solidity Workbench.
 * These extend the standard LSP with Solidity/Foundry-specific notifications and requests.
 */

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
  contractPath: string;
  contractName: string;
}

export interface InheritanceGraphResult {
  nodes: { name: string; filePath: string; kind: string }[];
  edges: { from: string; to: string }[];
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
