import type { CodeLens, Range } from "vscode-languageserver/node.js";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type { SymbolIndex } from "../analyzer/symbol-index.js";
import type { ParameterDeclaration } from "@solidity-workbench/common";
import type { SolidityParser } from "../parser/solidity-parser.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";
import type { SolcBridge } from "../compiler/solc-bridge.js";
import { keccak256 } from "js-sha3";

/**
 * Provides code lenses — actionable annotations above code elements.
 *
 * Lenses provided:
 *
 * 1. **Test functions**: "Run Test" / "Debug Test" above test_*, testFuzz_*, etc.
 * 2. **Reference counts**: "N references" above contracts, functions, events
 * 3. **Gas estimates**: "~N gas" above functions (from forge snapshot data)
 * 4. **Interface compliance**: "implements IFoo" above contracts
 * 5. **Function selector**: "selector: 0xabcd1234" above external/public functions
 *
 * These make the editor feel alive — every function has context about
 * how it's used, how much gas it costs, and how to run its tests.
 */
export class CodeLensProvider {
  private gasSnapshots: Map<string, number> = new Map();
  private solcBridge: SolcBridge | null = null;

  constructor(
    private symbolIndex: SymbolIndex,
    private parser: SolidityParser,
    private workspace: WorkspaceManager,
  ) {
    // Try to load gas snapshots on construction
    this.loadGasSnapshots();
  }

  /**
   * Wire the SolcBridge so selectors can come from `forge build --json`
   * (Etherscan-accurate for structs / UDTs) instead of being
   * hand-rolled from the mapped AST. The cached selectors map is
   * populated on every save via `SolcBridge.buildAndExtractAst`;
   * until the first successful build we fall back to local keccak256.
   */
  setSolcBridge(bridge: SolcBridge): void {
    this.solcBridge = bridge;
  }

  provideCodeLenses(document: TextDocument, options: { suppressGas?: boolean } = {}): CodeLens[] {
    const lenses: CodeLens[] = [];
    const result = this.parser.get(document.uri);
    if (!result) return lenses;

    const isTestFile = document.uri.endsWith(".t.sol");
    const suppressGas = options.suppressGas === true;

    for (const contract of result.sourceUnit.contracts) {
      // Contract-level lens: reference count (omit if 0 usages).
      const contractLens = this.createReferenceLens(
        contract.name,
        contract.nameRange,
        document.uri,
      );
      if (contractLens) lenses.push(contractLens);

      // Contract-level lens: interface compliance
      if (contract.baseContracts.length > 0) {
        const bases = contract.baseContracts.map((b) => b.baseName).join(", ");
        lenses.push({
          range: contract.nameRange,
          command: {
            title: `extends ${bases}`,
            command: "",
          },
        });
      }

      for (const func of contract.functions) {
        if (!func.name) continue; // skip constructor/receive/fallback for some lenses

        // Test run lens for test functions
        if (isTestFile && this.isTestFunction(func.name)) {
          lenses.push({
            range: func.range,
            command: {
              title: "$(play) Run Test",
              command: "solidity-workbench.testFunction",
              arguments: [func.name],
            },
          });
          lenses.push({
            range: func.range,
            command: {
              title: "$(debug) Debug",
              command: "solidity-workbench.debugTest",
              arguments: [func.name],
            },
          });
        }

        // Gas estimate lens
        if (!suppressGas) {
          const gasKey = `${contract.name}::${func.name}`;
          const gasEstimate = this.gasSnapshots.get(gasKey);
          if (gasEstimate !== undefined) {
            lenses.push({
              range: func.range,
              command: {
                title: `$(flame) ${this.formatGas(gasEstimate)} gas`,
                command: "",
              },
            });
          }
        }

        // Reference count lens for non-test functions (omit if 0 usages).
        if (!isTestFile && func.name) {
          const funcLens = this.createReferenceLens(func.name, func.nameRange, document.uri);
          if (funcLens) lenses.push(funcLens);
        }

        // Function selector lens for external/public functions.
        // Prefer the solc-backed selector when available (handles
        // structs / UDTs correctly); otherwise fall back to local
        // keccak256 over the declaration signature.
        if (
          func.name &&
          (func.visibility === "external" || func.visibility === "public") &&
          func.kind === "function"
        ) {
          const selector = this.resolveFunctionSelector(contract.name, func.name, func.parameters);
          if (selector) {
            lenses.push({
              range: func.range,
              command: {
                title: `selector: ${selector}`,
                command: "solidity-workbench.copySelector",
                arguments: [selector],
              },
            });
          }
        }
      }

      // Event selector lenses
      for (const event of contract.events) {
        const topic = this.computeEventTopic(event.name, event.parameters);
        if (topic) {
          lenses.push({
            range: event.range,
            command: {
              title: `topic0: ${topic}`,
              command: "solidity-workbench.copySelector",
              arguments: [topic],
            },
          });
        }
      }

      // Error selector lenses — custom errors have the same 4-byte
      // selector shape as external functions (`bytes4(keccak256(sig))`)
      // and are just as useful to surface for debugging failed calls.
      for (const err of contract.errors) {
        const selector = this.resolveErrorSelector(contract.name, err.name, err.parameters);
        if (selector) {
          lenses.push({
            range: err.range,
            command: {
              title: `selector: ${selector}`,
              command: "solidity-workbench.copySelector",
              arguments: [selector],
            },
          });
        }
      }
    }

    // File-level custom errors (Solidity >= 0.8.4) also get a selector
    // lens. They have no containing contract so the solc cache lookup
    // is skipped — we always compute locally.
    for (const err of result.sourceUnit.errors) {
      const selector = this.computeSelector(err.name, err.parameters);
      lenses.push({
        range: err.range,
        command: {
          title: `selector: ${selector}`,
          command: "solidity-workbench.copySelector",
          arguments: [selector],
        },
      });
    }

    return lenses;
  }

  /**
   * Look up the 4-byte selector for `contract.error`.
   *
   * Mirrors `resolveFunctionSelector`: prefer the solc-cached error
   * selectors populated from `forge build --json` (accurate for
   * struct / UDVT params) and fall back to a local keccak256 over the
   * parser-level canonical signature when the cache is cold.
   */
  private resolveErrorSelector(
    contractName: string,
    errorName: string,
    params: ParameterDeclaration[],
  ): string | null {
    if (this.solcBridge) {
      const table = this.solcBridge.getCachedErrorSelectors(contractName);
      if (table) {
        const prefix = `${errorName}(`;
        const arity = params.length;
        for (const [signature, selector] of Object.entries(table)) {
          if (!signature.startsWith(prefix)) continue;
          const inner = signature.slice(prefix.length, -1);
          const sigArity = inner.length === 0 ? 0 : this.topLevelCommaCount(inner) + 1;
          if (sigArity === arity) return `0x${selector}`;
        }
      }
    }
    return this.computeSelector(errorName, params);
  }

  /**
   * Look up the 4-byte selector for `contract.function`.
   *
   * Strategy:
   *   1. If SolcBridge has cached method identifiers for this contract,
   *      search for an entry whose key starts with `funcName(`. Match
   *      by parameter-count when multiple overloads exist (we key on
   *      the same comma count the mapped AST reports).
   *   2. Otherwise fall back to keccak256 over `name(canonical,types)`
   *      built from the mapped AST.
   *
   * Returns a `0x…` string in both paths, with no selector emitted when
   * we fail to compute one at all (unlikely — keccak always succeeds).
   */
  private resolveFunctionSelector(
    contractName: string,
    funcName: string,
    params: ParameterDeclaration[],
  ): string | null {
    if (this.solcBridge) {
      const table = this.solcBridge.getCachedMethodIdentifiers(contractName);
      if (table) {
        const prefix = `${funcName}(`;
        const arity = params.length;
        for (const [signature, selector] of Object.entries(table)) {
          if (!signature.startsWith(prefix)) continue;
          // Quick parameter-count match: strip the outer parens and
          // count top-level commas.
          const inner = signature.slice(prefix.length, -1);
          const sigArity = inner.length === 0 ? 0 : this.topLevelCommaCount(inner) + 1;
          if (sigArity === arity) {
            return `0x${selector}`;
          }
        }
      }
    }
    return this.computeSelector(funcName, params);
  }

  private topLevelCommaCount(text: string): number {
    let depth = 0;
    let count = 0;
    for (const ch of text) {
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") depth--;
      else if (ch === "," && depth === 0) count++;
    }
    return count;
  }

  resolveCodeLens(codeLens: CodeLens): CodeLens {
    // Code lenses that need lazy resolution can be handled here
    // For now, all lenses are fully resolved on creation
    return codeLens;
  }

  /**
   * Load gas snapshot data from .gas-snapshot file.
   */
  private async loadGasSnapshots(): Promise<void> {
    try {
      const { readFileSync, existsSync } = await import("node:fs");
      const { join } = await import("node:path");

      const snapshotPath = join(this.workspace.root, ".gas-snapshot");
      if (!existsSync(snapshotPath)) return;

      const content = readFileSync(snapshotPath, "utf-8");
      for (const line of content.split("\n")) {
        // Format: ContractName:testFunctionName() (gas: 12345)
        const match = line.match(/^(\w+):(\w+)\(\)\s+\(gas:\s+(\d+)\)/);
        if (match) {
          this.gasSnapshots.set(`${match[1]}::${match[2]}`, parseInt(match[3], 10));
        }
      }
    } catch {
      // .gas-snapshot might not exist
    }
  }

  /**
   * Build a "N references" code lens showing the number of *usage* sites for
   * a symbol — i.e. total textual occurrences minus declaration sites.
   *
   * Returns `null` when the symbol has no usages, so callers can omit the
   * lens entirely rather than showing a misleading "0 references".
   *
   * The lens is wired to our client-side shim command
   * `solidity-workbench.findReferencesAt`, which converts the URI string
   * (the wire format LSP uses) into a `vscode.Uri` before calling VSCode's
   * `editor.action.findReferences`. Passing the LSP wire arguments
   * directly to that VSCode command would fail with "unexpected type"
   * because the latter expects a real `Uri` instance.
   */
  private createReferenceLens(
    symbolName: string,
    range: Range,
    documentUri: string,
  ): CodeLens | null {
    const totalOccurrences = this.symbolIndex.referenceCount(symbolName);
    const declarationCount = this.symbolIndex.findSymbols(symbolName).length;
    const usageCount = Math.max(0, totalOccurrences - declarationCount);

    if (usageCount === 0) return null;

    return {
      range,
      command: {
        title: usageCount === 1 ? "1 reference" : `${usageCount} references`,
        command: "solidity-workbench.findReferencesAt",
        arguments: [documentUri, range.start],
      },
    };
  }

  private isTestFunction(name: string): boolean {
    return (
      /^(test|testFuzz|testFork|testFail)_/.test(name) || name === "setUp" || name === "invariant"
    );
  }

  /**
   * Compute the 4-byte function selector.
   * selector = keccak256(signature)[0:4]
   */
  private computeSelector(name: string, params: ParameterDeclaration[]): string {
    const types = params.map((p) => this.canonicalType(p.typeName));
    const sig = `${name}(${types.join(",")})`;
    return "0x" + keccak256(sig).slice(0, 8);
  }

  private computeEventTopic(name: string, params: ParameterDeclaration[]): string {
    const types = params.map((p) => this.canonicalType(p.typeName));
    const sig = `${name}(${types.join(",")})`;
    return "0x" + keccak256(sig);
  }

  /**
   * Normalize a type name to its canonical form for signature computation.
   */
  private canonicalType(typeName: string): string {
    // uint → uint256, int → int256
    if (typeName === "uint") return "uint256";
    if (typeName === "int") return "int256";
    if (typeName === "byte") return "bytes1";
    return typeName;
  }

  private formatGas(gas: number): string {
    if (gas >= 1_000_000) return `${(gas / 1_000_000).toFixed(1)}M`;
    if (gas >= 1_000) return `${(gas / 1_000).toFixed(1)}k`;
    return gas.toString();
  }
}
