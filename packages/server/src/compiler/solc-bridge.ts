import * as path from "node:path";
import * as fs from "node:fs";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";

/**
 * Bridge to the Solidity compiler (solc) for type-resolved AST.
 *
 * The parser module gives us fast, syntax-level AST for keystrokes.
 * This module provides the "rich" AST from solc that includes:
 * - Full type resolution (what type is this variable?)
 * - Overload resolution (which `transfer` function?)
 * - Cross-file reference resolution (where is this imported symbol defined?)
 * - Linearized inheritance chain
 * - Storage layout information
 * - Gas estimates
 *
 * We use two compilation strategies:
 * 1. `forge build --json` for full project compilation (on save)
 * 2. Direct `solc --standard-json` for single-file quick checks (on demand)
 *
 * The solc standard JSON I/O format is documented at:
 * https://docs.soliditylang.org/en/latest/using-the-compiler.html#compiler-input-and-output-json-description
 */
export class SolcBridge {
  private cachedAst: Map<string, SolcSourceUnit> = new Map();

  /**
   * Canonical method identifiers keyed by bare contract name.
   *
   * Populated from `forge build --json` output alongside the AST so
   * callers (currently `CodeLensProvider`) can render Etherscan-
   * accurate selectors without hand-rolling struct / UDT canonicalization.
   * When the cache is empty (pre-first-save or build failure), callers
   * should fall back to their local keccak256 computation.
   */
  private cachedSelectors: Map<string, Record<string, string>> = new Map();

  constructor(private workspace: WorkspaceManager) {}

  /**
   * Run a full forge build and extract ASTs + method identifiers.
   */
  async buildAndExtractAst(): Promise<Map<string, SolcSourceUnit>> {
    const result = await this.workspace.runForge([
      "build",
      "--json",
      "--force", // Force recompile to get fresh AST
    ]);

    if (result.exitCode !== 0) {
      // Build failed — still try to parse partial output
      return this.cachedAst;
    }

    try {
      const output = JSON.parse(result.stdout);
      this.extractAsts(output);
      this.extractSelectors(output);
    } catch {
      // Non-JSON output
    }

    return this.cachedAst;
  }

  /**
   * Compile a single file using solc standard JSON for quick type info.
   */
  async compileSingle(filePath: string): Promise<SolcOutput | null> {
    // Use forge to get the right solc version
    const result = await this.workspace.runForge(["build", "--json", "--match-path", filePath]);

    if (result.exitCode !== 0) return null;

    try {
      return JSON.parse(result.stdout);
    } catch {
      return null;
    }
  }

  /**
   * Get the cached AST for a file.
   */
  getAst(filePath: string): SolcSourceUnit | undefined {
    return this.cachedAst.get(filePath);
  }

  /**
   * Get type information for a node at a given byte offset.
   */
  getTypeAtOffset(filePath: string, offset: number): SolcTypeDescription | null {
    const ast = this.cachedAst.get(filePath);
    if (!ast) return null;

    // Walk the AST to find the node at the given offset
    const node = this.findNodeAtOffset(ast.ast, offset);
    if (!node) return null;

    return node.typeDescriptions ?? null;
  }

  /**
   * Resolve the definition location for a reference at a given offset.
   * Uses solc's referencedDeclaration field.
   */
  resolveReference(
    filePath: string,
    offset: number,
  ): { filePath: string; offset: number; length: number } | null {
    const ast = this.cachedAst.get(filePath);
    if (!ast) return null;

    const node = this.findNodeAtOffset(ast.ast, offset);
    if (!node?.referencedDeclaration) return null;

    // Search all ASTs for the declaration with that ID
    for (const [fp, su] of this.cachedAst) {
      const decl = this.findNodeById(su.ast, node.referencedDeclaration);
      if (decl) {
        const [start, length] = this.parseSourceRange(decl.src);
        return { filePath: fp, offset: start, length };
      }
    }

    return null;
  }

  /**
   * Scope-aware reference lookup for a local variable, parameter, or
   * other function-scoped declaration.
   *
   * Given a file + offset, resolve the declaration (whether the
   * cursor is on the declaration itself or on a reference site) and
   * return:
   *   - the declaration's own byte range
   *   - every reference site in the same file whose
   *     `referencedDeclaration` matches
   *
   * Returns `null` when:
   *   - The position doesn't resolve to any declaration (no solc AST
   *     for this file, or the position is whitespace / punctuation)
   *   - The declaration is NOT function-scoped (i.e. it's a state
   *     variable, contract, event, error, struct, enum, or file-level
   *     declaration — those belong to the symbol-index-based rename
   *     path in `RenameProvider`, not this one)
   *
   * This is the building block for scope-aware local-variable rename.
   * Locals / parameters are always single-file, so cross-file scans
   * are intentionally skipped — a huge simplification over the
   * workspace-wide code-lens / symbol-index rename.
   */
  findLocalReferences(
    filePath: string,
    offset: number,
  ): {
    declarationOffset: number;
    declarationLength: number;
    nameLength: number;
    references: { offset: number; length: number }[];
  } | null {
    const ast = this.cachedAst.get(filePath);
    if (!ast) return null;

    const node = this.findNodeAtOffset(ast.ast, offset);
    if (!node) return null;

    // Resolve to a declaration: either the node itself *is* a
    // VariableDeclaration (cursor on declaration site) or it's an
    // Identifier whose `referencedDeclaration` points to one.
    let declId: number | null = null;
    if (node.nodeType === "VariableDeclaration" && typeof node.id === "number") {
      declId = node.id;
    } else if (typeof node.referencedDeclaration === "number") {
      declId = node.referencedDeclaration;
    }
    if (declId === null) return null;

    // The declaration must be somewhere in this file — locals don't
    // cross files, so we only search this file's AST.
    const decl = this.findNodeById(ast.ast, declId);
    if (!decl) return null;
    if (decl.nodeType !== "VariableDeclaration") return null;

    // Function-scoped only. Contract-scoped declarations (state vars)
    // have a parent contract as their scope; function-scoped
    // declarations have a function / block as their scope. We detect
    // the latter by searching the AST for the scope ID and checking
    // its node type.
    if (typeof decl.scope !== "number" || !this.isFunctionScope(ast.ast, decl.scope)) {
      return null;
    }

    const [declStart, declLength] = this.parseSourceRange(decl.src);
    const name = typeof decl.name === "string" ? decl.name : "";
    if (!name) return null;

    // Walk the file's AST collecting every Identifier whose
    // referencedDeclaration matches.
    const references: { offset: number; length: number }[] = [];
    this.collectReferencesTo(ast.ast, declId, references);

    return {
      declarationOffset: declStart,
      declarationLength: declLength,
      nameLength: name.length,
      references,
    };
  }

  private isFunctionScope(root: any, scopeId: number): boolean {
    const scopeNode = this.findNodeById(root, scopeId);
    if (!scopeNode) return false;
    return (
      scopeNode.nodeType === "FunctionDefinition" ||
      scopeNode.nodeType === "ModifierDefinition" ||
      scopeNode.nodeType === "Block"
    );
  }

  private collectReferencesTo(
    node: any,
    declId: number,
    out: { offset: number; length: number }[],
  ): void {
    if (!node || typeof node !== "object") return;

    if (
      node.nodeType === "Identifier" &&
      node.referencedDeclaration === declId &&
      typeof node.src === "string"
    ) {
      const [start, length] = this.parseSourceRange(node.src);
      out.push({ offset: start, length });
    }

    for (const key of Object.keys(node)) {
      if (key === "src" || key === "typeDescriptions") continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) this.collectReferencesTo(item, declId, out);
      } else if (typeof child === "object" && child !== null) {
        this.collectReferencesTo(child, declId, out);
      }
    }
  }

  /**
   * Get the storage layout for a contract.
   */
  async getStorageLayout(contractName: string): Promise<StorageLayoutEntry[] | null> {
    const result = await this.workspace.runForge([
      "inspect",
      contractName,
      "storage-layout",
      "--json",
    ]);

    if (result.exitCode !== 0) return null;

    try {
      const output = JSON.parse(result.stdout);
      return output.storage ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Get method identifiers (function selectors) for a contract.
   */
  async getMethodIdentifiers(contractName: string): Promise<Record<string, string> | null> {
    const result = await this.workspace.runForge([
      "inspect",
      contractName,
      "method-identifiers",
      "--json",
    ]);

    if (result.exitCode !== 0) return null;

    try {
      const parsed = JSON.parse(result.stdout) as Record<string, string>;
      this.cachedSelectors.set(contractName, parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * Read the method-identifier cache synchronously. Returns the map
   * `{ "transfer(address,uint256)": "a9059cbb", ... }` from the last
   * successful `forge build --json` (via `buildAndExtractAst`) or an
   * explicit `getMethodIdentifiers` call. `undefined` means "not in
   * the cache yet" — callers should fall back to their own keccak256
   * computation over the parser's declaration-level signature.
   */
  getCachedMethodIdentifiers(contractName: string): Record<string, string> | undefined {
    return this.cachedSelectors.get(contractName);
  }

  /**
   * Get the ABI for a contract.
   */
  async getAbi(contractName: string): Promise<any[] | null> {
    const result = await this.workspace.runForge(["inspect", contractName, "abi"]);

    if (result.exitCode !== 0) return null;

    try {
      return JSON.parse(result.stdout);
    } catch {
      return null;
    }
  }

  // ── Private helpers ────────────────────────────────────────────────

  private buildStandardInput(filePath: string): SolcStandardInput {
    const content = fs.readFileSync(filePath, "utf-8");
    const relativePath = path.relative(this.workspace.root, filePath);

    return {
      language: "Solidity",
      sources: {
        [relativePath]: { content },
      },
      settings: {
        outputSelection: {
          "*": {
            "*": ["abi", "evm.methodIdentifiers", "storageLayout"],
            "": ["ast"],
          },
        },
        remappings: this.workspace
          .getRemappings()
          .map((r) => `${r.context ? r.context + ":" : ""}${r.prefix}=${r.path}`),
      },
    };
  }

  private extractAsts(output: any): void {
    if (!output.sources) return;

    for (const [filePath, source] of Object.entries(output.sources) as [string, any][]) {
      if (source.ast) {
        this.cachedAst.set(filePath, {
          id: source.id,
          filePath,
          ast: source.ast,
        });
      }
    }
  }

  /**
   * Populate `cachedSelectors` from a `forge build --json` payload.
   *
   * The output shape is:
   *   {
   *     contracts: {
   *       "src/Counter.sol": {
   *         "Counter": {
   *           evm: { methodIdentifiers: { "increment()": "d09de08a", ... } }
   *         }
   *       }
   *     }
   *   }
   *
   * We key the cache by bare contract name. When two contracts in
   * different files share a name, the last one written wins; this
   * matches what `forge inspect <name>` itself does.
   */
  private extractSelectors(output: any): void {
    const contracts = output?.contracts;
    if (!contracts || typeof contracts !== "object") return;

    for (const fileEntry of Object.values(contracts) as any[]) {
      if (!fileEntry || typeof fileEntry !== "object") continue;
      for (const [contractName, contractEntry] of Object.entries(fileEntry) as [string, any][]) {
        const ids = contractEntry?.evm?.methodIdentifiers;
        if (ids && typeof ids === "object") {
          this.cachedSelectors.set(contractName, ids as Record<string, string>);
        }
      }
    }
  }

  private findNodeAtOffset(node: any, offset: number): any | null {
    if (!node || typeof node !== "object") return null;

    // The top-level SourceUnit doesn't carry a src range, so recurse
    // into `nodes` when present and fall back to generic key walking
    // when we don't have a src to check.
    if (!node.src) {
      if (Array.isArray(node.nodes)) {
        for (const child of node.nodes) {
          const found = this.findNodeAtOffset(child, offset);
          if (found) return found;
        }
      }
      return null;
    }

    const [start, length] = this.parseSourceRange(node.src);
    if (offset < start || offset >= start + length) return null;

    // Check children for a more specific match.
    for (const key of Object.keys(node)) {
      if (key === "src" || key === "typeDescriptions") continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) {
          const found = this.findNodeAtOffset(item, offset);
          if (found) return found;
        }
      } else if (typeof child === "object" && child !== null) {
        const found = this.findNodeAtOffset(child, offset);
        if (found) return found;
      }
    }
    return node; // This node is the best match
  }

  private findNodeById(node: any, id: number): any | null {
    if (!node || typeof node !== "object") return null;

    if (node.id === id) return node;

    for (const key of Object.keys(node)) {
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) {
          const found = this.findNodeById(item, id);
          if (found) return found;
        }
      } else if (typeof child === "object" && child !== null) {
        const found = this.findNodeById(child, id);
        if (found) return found;
      }
    }

    return null;
  }

  private parseSourceRange(src: string): [number, number] {
    const parts = src.split(":");
    return [parseInt(parts[0], 10), parseInt(parts[1], 10)];
  }
}

// ── Types ────────────────────────────────────────────────────────────

export interface SolcSourceUnit {
  id: number;
  filePath: string;
  ast: any; // solc AST node
}

export interface SolcOutput {
  errors?: SolcError[];
  sources?: Record<string, { id: number; ast: any }>;
  contracts?: Record<string, Record<string, SolcContractOutput>>;
}

export interface SolcContractOutput {
  abi?: any[];
  evm?: {
    bytecode?: { object: string };
    methodIdentifiers?: Record<string, string>;
    gasEstimates?: {
      creation?: { totalCost: string };
      external?: Record<string, string>;
      internal?: Record<string, string>;
    };
  };
  storageLayout?: {
    storage: StorageLayoutEntry[];
    types: Record<string, any>;
  };
}

export interface SolcError {
  severity: "error" | "warning" | "info";
  errorCode?: string;
  message: string;
  formattedMessage?: string;
  sourceLocation?: {
    file: string;
    start: number;
    end: number;
  };
  type?: string;
}

export interface SolcTypeDescription {
  typeIdentifier?: string;
  typeString?: string;
}

export interface StorageLayoutEntry {
  astId: number;
  contract: string;
  label: string;
  offset: number;
  slot: string;
  type: string;
}

export interface SolcStandardInput {
  language: "Solidity";
  sources: Record<string, { content: string }>;
  settings: {
    outputSelection: Record<string, Record<string, string[]>>;
    remappings?: string[];
    optimizer?: { enabled: boolean; runs: number };
    evmVersion?: string;
  };
}
