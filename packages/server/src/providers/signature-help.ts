import {
  SignatureHelp,
  SignatureInformation,
  ParameterInformation,
  MarkupKind,
  Position,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { FunctionDefinition, NatspecComment } from "@solforge/common";
import { SymbolIndex } from "../analyzer/symbol-index.js";
import { SolidityParser } from "../parser/solidity-parser.js";

/**
 * Provides signature help — the parameter hints shown while typing
 * inside function call parentheses.
 *
 * Triggers on `(` and `,`. Shows:
 * - Full function signature with parameter types and names
 * - Active parameter highlighting as you type each argument
 * - NatSpec @param documentation for each parameter
 * - Overloaded function signatures when multiple exist
 *
 * This is one of the most-requested missing features across all
 * existing Solidity extensions (none provide it as of April 2026).
 */
export class SignatureHelpProvider {
  constructor(
    private symbolIndex: SymbolIndex,
    private parser: SolidityParser,
  ) {}

  provideSignatureHelp(
    document: TextDocument,
    position: Position,
  ): SignatureHelp | null {
    const text = document.getText();
    const offset = document.offsetAt(position);

    // Walk backward from cursor to find the opening paren and function name
    const callContext = this.findCallContext(text, offset);
    if (!callContext) return null;

    const { functionName, activeParameter, containerName } = callContext;

    // Look up function definitions
    const signatures = this.findSignatures(functionName, containerName, document.uri);
    if (signatures.length === 0) {
      // Try built-in functions
      const builtinSig = this.getBuiltinSignature(functionName);
      if (builtinSig) {
        return {
          signatures: [builtinSig],
          activeSignature: 0,
          activeParameter,
        };
      }
      return null;
    }

    return {
      signatures,
      activeSignature: this.findBestOverload(signatures, activeParameter),
      activeParameter,
    };
  }

  /**
   * Walk backward from the cursor to find what function we're inside,
   * and which parameter position we're at.
   */
  private findCallContext(
    text: string,
    offset: number,
  ): { functionName: string; activeParameter: number; containerName?: string } | null {
    let depth = 0;
    let commaCount = 0;
    let i = offset - 1;

    // Find the matching open paren
    while (i >= 0) {
      const ch = text[i];
      if (ch === ")" || ch === "]" || ch === "}") depth++;
      else if (ch === "(" || ch === "[" || ch === "{") {
        if (depth === 0 && ch === "(") break;
        depth--;
      } else if (ch === "," && depth === 0) {
        commaCount++;
      }
      i--;
    }

    if (i < 0 || text[i] !== "(") return null;

    // Walk backward past whitespace to find the function name
    let nameEnd = i;
    i--;
    while (i >= 0 && /\s/.test(text[i])) i--;
    if (i < 0) return null;

    // Extract the identifier
    let nameStart = i;
    while (nameStart > 0 && /[\w$]/.test(text[nameStart - 1])) nameStart--;
    const functionName = text.slice(nameStart, i + 1);
    if (!functionName || /^\d/.test(functionName)) return null;

    // Check for container (e.g., `Contract.func(`)
    let containerName: string | undefined;
    if (nameStart > 1 && text[nameStart - 1] === ".") {
      let containerEnd = nameStart - 2;
      let containerStart = containerEnd;
      while (containerStart > 0 && /[\w$]/.test(text[containerStart - 1])) containerStart--;
      containerName = text.slice(containerStart, containerEnd + 1);
    }

    return { functionName, activeParameter: commaCount, containerName };
  }

  /**
   * Find all function signatures matching the name.
   */
  private findSignatures(
    funcName: string,
    containerName: string | undefined,
    uri: string,
  ): SignatureInformation[] {
    const signatures: SignatureInformation[] = [];

    // If we have a container, resolve through that contract
    if (containerName) {
      const chain = this.symbolIndex.getInheritanceChain(containerName);
      for (const contract of chain) {
        for (const func of contract.functions) {
          if (func.name === funcName) {
            signatures.push(this.buildSignature(func, contract.name));
          }
        }
      }
      return signatures;
    }

    // Otherwise search globally
    const symbols = this.symbolIndex.findSymbols(funcName);
    for (const sym of symbols) {
      if (sym.kind === "function" || sym.kind === "event" || sym.kind === "error") {
        // Get the full function definition from the contract
        if (sym.containerName) {
          const entry = this.symbolIndex.getContract(sym.containerName);
          if (entry) {
            const func = entry.contract.functions.find((f) => f.name === funcName);
            if (func) {
              signatures.push(this.buildSignature(func, sym.containerName));
              continue;
            }
            // Check events
            const event = entry.contract.events.find((e) => e.name === funcName);
            if (event) {
              signatures.push(this.buildEventSignature(event, sym.containerName));
              continue;
            }
            // Check errors
            const error = entry.contract.errors.find((e) => e.name === funcName);
            if (error) {
              signatures.push(this.buildErrorSignature(error, sym.containerName));
            }
          }
        }
      }
    }

    return signatures;
  }

  private buildSignature(
    func: FunctionDefinition,
    containerName: string,
  ): SignatureInformation {
    const params = func.parameters.map((p) => {
      const label = `${p.typeName}${p.storageLocation ? " " + p.storageLocation : ""}${p.name ? " " + p.name : ""}`;
      const doc = func.natspec?.params?.[p.name ?? ""];
      return ParameterInformation.create(
        label,
        doc ? { kind: MarkupKind.Markdown, value: doc } : undefined,
      );
    });

    const paramStr = params.map((p) => p.label).join(", ");
    const returnsStr = func.returnParameters.length > 0
      ? ` returns (${func.returnParameters.map((p) => `${p.typeName}${p.name ? " " + p.name : ""}`).join(", ")})`
      : "";
    const vis = func.visibility !== "public" ? ` ${func.visibility}` : "";
    const mut = func.mutability !== "nonpayable" ? ` ${func.mutability}` : "";

    const label = `${func.name ?? func.kind}(${paramStr})${vis}${mut}${returnsStr}`;

    const documentation = this.buildDocumentation(func.natspec, containerName);

    return {
      label,
      documentation: documentation
        ? { kind: MarkupKind.Markdown, value: documentation }
        : undefined,
      parameters: params,
    };
  }

  private buildEventSignature(
    event: import("@solforge/common").EventDefinition,
    containerName: string,
  ): SignatureInformation {
    const params = event.parameters.map((p) => {
      const label = `${p.typeName}${p.indexed ? " indexed" : ""}${p.name ? " " + p.name : ""}`;
      return ParameterInformation.create(label);
    });
    const paramStr = params.map((p) => p.label).join(", ");
    return {
      label: `event ${event.name}(${paramStr})`,
      documentation: event.natspec?.notice
        ? { kind: MarkupKind.Markdown, value: event.natspec.notice }
        : undefined,
      parameters: params,
    };
  }

  private buildErrorSignature(
    error: import("@solforge/common").ErrorDefinition,
    containerName: string,
  ): SignatureInformation {
    const params = error.parameters.map((p) => {
      const label = `${p.typeName}${p.name ? " " + p.name : ""}`;
      return ParameterInformation.create(label);
    });
    const paramStr = params.map((p) => p.label).join(", ");
    return {
      label: `error ${error.name}(${paramStr})`,
      documentation: error.natspec?.notice
        ? { kind: MarkupKind.Markdown, value: error.natspec.notice }
        : undefined,
      parameters: params,
    };
  }

  private buildDocumentation(
    natspec: NatspecComment | undefined,
    containerName: string,
  ): string | undefined {
    if (!natspec) return `*Defined in* \`${containerName}\``;

    const parts: string[] = [];
    if (natspec.notice) parts.push(natspec.notice);
    if (natspec.dev) parts.push(`\n> *Dev:* ${natspec.dev}`);
    parts.push(`\n*Defined in* \`${containerName}\``);
    return parts.join("\n");
  }

  /**
   * Find the best overload — prefer the one where activeParameter is within bounds.
   */
  private findBestOverload(
    signatures: SignatureInformation[],
    activeParameter: number,
  ): number {
    for (let i = 0; i < signatures.length; i++) {
      if ((signatures[i].parameters?.length ?? 0) > activeParameter) {
        return i;
      }
    }
    return 0;
  }

  // ── Built-in function signatures ──────────────────────────────────

  private getBuiltinSignature(name: string): SignatureInformation | null {
    const builtins: Record<string, SignatureInformation> = {
      require: {
        label: "require(bool condition, string memory message)",
        documentation: {
          kind: MarkupKind.Markdown,
          value: "Reverts execution if `condition` is false.",
        },
        parameters: [
          ParameterInformation.create("bool condition", "The condition to check"),
          ParameterInformation.create("string memory message", "Revert reason string"),
        ],
      },
      assert: {
        label: "assert(bool condition)",
        documentation: {
          kind: MarkupKind.Markdown,
          value: "Triggers Panic(1) if `condition` is false. Use for invariants.",
        },
        parameters: [
          ParameterInformation.create("bool condition", "Invariant to assert"),
        ],
      },
      revert: {
        label: "revert(string memory reason)",
        documentation: {
          kind: MarkupKind.Markdown,
          value: "Aborts execution and reverts state changes.",
        },
        parameters: [
          ParameterInformation.create("string memory reason", "Revert reason"),
        ],
      },
      keccak256: {
        label: "keccak256(bytes memory data) returns (bytes32)",
        documentation: {
          kind: MarkupKind.Markdown,
          value: "Computes the Keccak-256 hash of the input.",
        },
        parameters: [
          ParameterInformation.create("bytes memory data", "Data to hash"),
        ],
      },
      sha256: {
        label: "sha256(bytes memory data) returns (bytes32)",
        parameters: [
          ParameterInformation.create("bytes memory data", "Data to hash"),
        ],
      },
      ecrecover: {
        label: "ecrecover(bytes32 hash, uint8 v, bytes32 r, bytes32 s) returns (address)",
        documentation: {
          kind: MarkupKind.Markdown,
          value: "Recovers the signer address from an ECDSA signature.",
        },
        parameters: [
          ParameterInformation.create("bytes32 hash", "Message hash"),
          ParameterInformation.create("uint8 v", "Recovery id"),
          ParameterInformation.create("bytes32 r", "ECDSA r value"),
          ParameterInformation.create("bytes32 s", "ECDSA s value"),
        ],
      },
      addmod: {
        label: "addmod(uint256 x, uint256 y, uint256 k) returns (uint256)",
        documentation: {
          kind: MarkupKind.Markdown,
          value: "Computes `(x + y) % k` with arbitrary precision arithmetic.",
        },
        parameters: [
          ParameterInformation.create("uint256 x"),
          ParameterInformation.create("uint256 y"),
          ParameterInformation.create("uint256 k", "Modulus (must be non-zero)"),
        ],
      },
      mulmod: {
        label: "mulmod(uint256 x, uint256 y, uint256 k) returns (uint256)",
        documentation: {
          kind: MarkupKind.Markdown,
          value: "Computes `(x * y) % k` with arbitrary precision arithmetic.",
        },
        parameters: [
          ParameterInformation.create("uint256 x"),
          ParameterInformation.create("uint256 y"),
          ParameterInformation.create("uint256 k", "Modulus (must be non-zero)"),
        ],
      },
      blockhash: {
        label: "blockhash(uint256 blockNumber) returns (bytes32)",
        documentation: {
          kind: MarkupKind.Markdown,
          value: "Returns the hash of the given block. Only works for the 256 most recent blocks.",
        },
        parameters: [
          ParameterInformation.create("uint256 blockNumber"),
        ],
      },
    };

    return builtins[name] ?? null;
  }
}
