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

  constructor(private workspace: WorkspaceManager) {}

  /**
   * Run a full forge build and extract ASTs from the output.
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
      return JSON.parse(result.stdout);
    } catch {
      return null;
    }
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

  private findNodeAtOffset(node: any, offset: number): any | null {
    if (!node || typeof node !== "object") return null;

    if (node.src) {
      const [start, length] = this.parseSourceRange(node.src);
      if (offset >= start && offset < start + length) {
        // Check children for a more specific match
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
    }

    return null;
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
