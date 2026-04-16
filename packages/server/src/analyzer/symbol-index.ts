import type { Range, WorkspaceSymbol } from "vscode-languageserver/node.js";
import {
  Location,
  SymbolInformation,
  SymbolKind as LSPSymbolKind,
} from "vscode-languageserver/node.js";
import { URI } from "vscode-uri";
import type {
  SolSymbol,
  SymbolKind,
  ContractDefinition,
  FunctionDefinition,
} from "@solidity-workbench/common";
import type { SolidityParser } from "../parser/solidity-parser.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";
import { ReferenceIndex } from "./reference-index.js";

/**
 * Maintains a cross-file symbol index for the workspace.
 * Supports go-to-definition, find references, workspace symbols, and completions.
 */
export class SymbolIndex {
  private parser: SolidityParser;
  private workspace: WorkspaceManager;

  /** All symbols indexed by name */
  private symbolsByName: Map<string, SolSymbol[]> = new Map();

  /** All symbols indexed by file URI */
  private symbolsByFile: Map<string, SolSymbol[]> = new Map();

  /** Contract definitions indexed by name — for inheritance resolution */
  private contractsByName: Map<string, { uri: string; contract: ContractDefinition }> = new Map();

  /**
   * Inverted identifier-occurrence index used to answer "find all references"
   * and "reference count" queries in O(1) by-name lookups instead of scanning
   * every file on every query.
   */
  private refIndex = new ReferenceIndex();

  constructor(parser: SolidityParser, workspace: WorkspaceManager) {
    this.parser = parser;
    this.workspace = workspace;
  }

  /**
   * Index all Solidity files in the workspace.
   */
  async indexWorkspace(): Promise<void> {
    const uris = this.workspace.getAllFileUris();
    for (const uri of uris) {
      await this.indexFile(uri);
    }
  }

  /**
   * Index or re-index a single file.
   *
   * Reads the file from disk, updates the parser cache, and then delegates
   * to `updateFile(uri)` to (re)build both the symbol table and the
   * inverted reference index from the parser's cached source text.
   */
  async indexFile(uri: string): Promise<void> {
    try {
      const filePath = this.workspace.uriToPath(uri);
      const { readFileSync } = await import("node:fs");
      const text = readFileSync(filePath, "utf-8");
      this.parser.parse(uri, text);
      this.updateFile(uri);
    } catch {
      /* file unreadable, skip */
    }
  }

  /**
   * Update the index for a file that's already been parsed.
   */
  updateFile(uri: string): void {
    const result = this.parser.get(uri);
    if (!result) return;

    // Refresh the inverted reference index using the cached source text.
    // If for some reason the parser didn't retain text (older call sites),
    // we skip the refresh rather than re-reading from disk here — indexFile()
    // is the canonical entry point that guarantees both caches are populated.
    const cachedText = this.parser.getText(uri);
    if (cachedText !== undefined) {
      this.refIndex.indexFile(uri, cachedText);
    }

    // Remove old symbols for this file
    const oldSymbols = this.symbolsByFile.get(uri) ?? [];
    for (const sym of oldSymbols) {
      const byName = this.symbolsByName.get(sym.name);
      if (byName) {
        const filtered = byName.filter((s) => s.filePath !== uri);
        if (filtered.length > 0) {
          this.symbolsByName.set(sym.name, filtered);
        } else {
          this.symbolsByName.delete(sym.name);
        }
      }
    }

    // Build new symbols
    const newSymbols: SolSymbol[] = [];
    const su = result.sourceUnit;

    for (const contract of su.contracts) {
      // Contract itself
      newSymbols.push({
        name: contract.name,
        kind:
          contract.kind === "interface"
            ? "interface"
            : contract.kind === "library"
              ? "library"
              : "contract",
        filePath: uri,
        range: contract.range,
        nameRange: contract.nameRange,
        natspec: contract.natspec,
      });

      this.contractsByName.set(contract.name, { uri, contract });

      // Functions
      for (const func of contract.functions) {
        if (func.name) {
          newSymbols.push({
            name: func.name,
            kind: "function",
            filePath: uri,
            range: func.range,
            nameRange: func.nameRange,
            containerName: contract.name,
            detail: this.buildFunctionSignature(func),
            natspec: func.natspec,
          });
        }
      }

      // Events
      for (const event of contract.events) {
        newSymbols.push({
          name: event.name,
          kind: "event",
          filePath: uri,
          range: event.range,
          nameRange: event.nameRange,
          containerName: contract.name,
          natspec: event.natspec,
        });
      }

      // Errors
      for (const error of contract.errors) {
        newSymbols.push({
          name: error.name,
          kind: "error",
          filePath: uri,
          range: error.range,
          nameRange: error.nameRange,
          containerName: contract.name,
          natspec: error.natspec,
        });
      }

      // State variables
      for (const svar of contract.stateVariables) {
        newSymbols.push({
          name: svar.name,
          kind: "stateVariable",
          filePath: uri,
          range: svar.range,
          nameRange: svar.nameRange,
          containerName: contract.name,
          detail: svar.typeName,
          natspec: svar.natspec,
        });
      }

      // Structs
      for (const struct of contract.structs) {
        newSymbols.push({
          name: struct.name,
          kind: "struct",
          filePath: uri,
          range: struct.range,
          nameRange: struct.nameRange,
          containerName: contract.name,
          natspec: struct.natspec,
        });
      }

      // Enums
      for (const enumDef of contract.enums) {
        newSymbols.push({
          name: enumDef.name,
          kind: "enum",
          filePath: uri,
          range: enumDef.range,
          nameRange: enumDef.nameRange,
          containerName: contract.name,
          natspec: enumDef.natspec,
        });
      }

      // Modifiers
      for (const mod of contract.modifiers) {
        newSymbols.push({
          name: mod.name,
          kind: "modifier",
          filePath: uri,
          range: mod.range,
          nameRange: mod.nameRange,
          containerName: contract.name,
          natspec: mod.natspec,
        });
      }
    }

    // File-level free functions (Solidity >=0.7.1)
    for (const fn of su.freeFunctions) {
      if (!fn.name) continue;
      newSymbols.push({
        name: fn.name,
        kind: "function",
        filePath: uri,
        range: fn.range,
        nameRange: fn.nameRange,
        detail: this.buildFunctionSignature(fn),
        natspec: fn.natspec,
      });
    }

    // File-level custom errors
    for (const err of su.errors) {
      newSymbols.push({
        name: err.name,
        kind: "error",
        filePath: uri,
        range: err.range,
        nameRange: err.nameRange,
        natspec: err.natspec,
      });
    }

    // File-level user-defined value types (e.g. `type Fixed is uint256;`)
    for (const udvt of su.userDefinedValueTypes) {
      newSymbols.push({
        name: udvt.name,
        kind: "userDefinedValueType",
        filePath: uri,
        range: udvt.range,
        nameRange: udvt.nameRange,
        detail: udvt.underlyingType,
      });
    }

    // Store symbols
    this.symbolsByFile.set(uri, newSymbols);
    for (const sym of newSymbols) {
      const existing = this.symbolsByName.get(sym.name) ?? [];
      existing.push(sym);
      this.symbolsByName.set(sym.name, existing);
    }
  }

  /**
   * Find symbols by name (exact match or prefix).
   */
  findSymbols(name: string): SolSymbol[] {
    return this.symbolsByName.get(name) ?? [];
  }

  /**
   * Find every textual occurrence of `name` in indexed files.
   *
   * Backed by the inverted `ReferenceIndex`, which pre-computes word-boundary
   * matches and already strips block comments, line comments, and string
   * literals.  Includes both declaration sites and usage sites; callers that
   * want to distinguish them can intersect with {@link findSymbols}.
   */
  findReferences(name: string): { uri: string; range: Range }[] {
    return this.refIndex.findReferences(name);
  }

  /**
   * Total count of indexed occurrences of `name` (declarations + usages).
   */
  referenceCount(name: string): number {
    return this.refIndex.referenceCount(name);
  }

  /**
   * True if any file in the workspace has been indexed with an occurrence of
   * `name`.  Used by callers that want to decide between the fast inverted
   * index path and a slow text-scan fallback for identifiers we haven't seen
   * yet (e.g. newly opened files not yet indexed).
   */
  hasReferences(name: string): boolean {
    return this.refIndex.has(name);
  }

  /**
   * Drop all inverted-index entries for a file — intended for cleanup when a
   * file is closed or removed from the workspace.  Symbol / contract maps
   * are untouched; those remain valid until the next `updateFile` rebuild.
   */
  onFileClosed(uri: string): void {
    this.refIndex.removeFile(uri);
  }

  /**
   * Find symbols matching a query (for workspace symbol search).
   */
  findWorkspaceSymbols(query: string): WorkspaceSymbol[] {
    const results: WorkspaceSymbol[] = [];
    const lowerQuery = query.toLowerCase();

    for (const [name, symbols] of this.symbolsByName) {
      if (name.toLowerCase().includes(lowerQuery)) {
        for (const sym of symbols) {
          results.push({
            name: sym.containerName ? `${sym.containerName}.${sym.name}` : sym.name,
            kind: this.toLSPSymbolKind(sym.kind),
            location: {
              uri: sym.filePath,
              range: sym.range,
            },
            containerName: sym.containerName,
          });
        }
      }
      if (results.length >= 100) break; // Limit results
    }

    return results;
  }

  /**
   * Get all symbols in a file.
   */
  getFileSymbols(uri: string): SolSymbol[] {
    return this.symbolsByFile.get(uri) ?? [];
  }

  /**
   * Get a contract definition by name.
   */
  getContract(name: string): { uri: string; contract: ContractDefinition } | undefined {
    return this.contractsByName.get(name);
  }

  /**
   * Get all contracts (for completions and navigation).
   */
  getAllContracts(): Map<string, { uri: string; contract: ContractDefinition }> {
    return this.contractsByName;
  }

  /**
   * Resolve the full inheritance chain for a contract.
   */
  getInheritanceChain(contractName: string): ContractDefinition[] {
    const chain: ContractDefinition[] = [];
    const visited = new Set<string>();

    const resolve = (name: string) => {
      if (visited.has(name)) return;
      visited.add(name);

      const entry = this.contractsByName.get(name);
      if (!entry) return;

      chain.push(entry.contract);
      for (const base of entry.contract.baseContracts) {
        resolve(base.baseName);
      }
    };

    resolve(contractName);
    return chain;
  }

  private buildFunctionSignature(func: FunctionDefinition): string {
    const params = func.parameters
      .map((p) => `${p.typeName}${p.name ? " " + p.name : ""}`)
      .join(", ");
    const returns = func.returnParameters.map((p) => p.typeName).join(", ");
    const vis = func.visibility !== "public" ? ` ${func.visibility}` : "";
    const mut = func.mutability !== "nonpayable" ? ` ${func.mutability}` : "";
    const ret = returns ? ` returns (${returns})` : "";
    return `(${params})${vis}${mut}${ret}`;
  }

  private toLSPSymbolKind(kind: SymbolKind): LSPSymbolKind {
    switch (kind) {
      case "contract":
        return LSPSymbolKind.Class;
      case "interface":
        return LSPSymbolKind.Interface;
      case "library":
        return LSPSymbolKind.Module;
      case "function":
        return LSPSymbolKind.Function;
      case "modifier":
        return LSPSymbolKind.Method;
      case "event":
        return LSPSymbolKind.Event;
      case "error":
        return LSPSymbolKind.Struct;
      case "struct":
        return LSPSymbolKind.Struct;
      case "enum":
        return LSPSymbolKind.Enum;
      case "stateVariable":
        return LSPSymbolKind.Field;
      case "localVariable":
        return LSPSymbolKind.Variable;
      case "parameter":
        return LSPSymbolKind.Variable;
      case "userDefinedValueType":
        return LSPSymbolKind.TypeParameter;
    }
  }
}
