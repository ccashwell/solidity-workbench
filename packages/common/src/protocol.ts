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

// ── Custom Requests (client → server) ────────────────────────────────

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
