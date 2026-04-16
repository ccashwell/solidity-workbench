import type { CodeLens, Range } from "vscode-languageserver/node.js";
import { Command } from "vscode-languageserver/node.js";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type { SymbolIndex } from "../analyzer/symbol-index.js";
import type { ParameterDeclaration } from "@solidity-workbench/common";
import type { SolidityParser } from "../parser/solidity-parser.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";
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

  constructor(
    private symbolIndex: SymbolIndex,
    private parser: SolidityParser,
    private workspace: WorkspaceManager,
  ) {
    // Try to load gas snapshots on construction
    this.loadGasSnapshots();
  }

  provideCodeLenses(document: TextDocument, options: { suppressGas?: boolean } = {}): CodeLens[] {
    const lenses: CodeLens[] = [];
    const result = this.parser.get(document.uri);
    if (!result) return lenses;

    const text = document.getText();
    const isTestFile = document.uri.endsWith(".t.sol");
    const suppressGas = options.suppressGas === true;

    for (const contract of result.sourceUnit.contracts) {
      // Contract-level lens: reference count (omit if 0 usages).
      const contractLens = this.createReferenceLens(contract.name, contract.nameRange);
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
          const funcLens = this.createReferenceLens(func.name, func.nameRange);
          if (funcLens) lenses.push(funcLens);
        }

        // Function selector lens for external/public functions
        if (
          func.name &&
          (func.visibility === "external" || func.visibility === "public") &&
          func.kind === "function"
        ) {
          const selector = this.computeSelector(func.name, func.parameters);
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
    }

    return lenses;
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
   */
  private createReferenceLens(symbolName: string, range: Range): CodeLens | null {
    const totalOccurrences = this.symbolIndex.referenceCount(symbolName);
    const declarationCount = this.symbolIndex.findSymbols(symbolName).length;
    const usageCount = Math.max(0, totalOccurrences - declarationCount);

    if (usageCount === 0) return null;

    return {
      range,
      command: {
        title: usageCount === 1 ? "1 reference" : `${usageCount} references`,
        command: "editor.action.findReferences",
        arguments: [range.start],
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
