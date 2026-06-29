import type { SignatureHelp, SignatureInformation, Position } from "vscode-languageserver/node.js";
import { ParameterInformation, MarkupKind } from "vscode-languageserver/node.js";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type {
  FunctionDefinition,
  ContractDefinition,
  NatspecComment,
  EventDefinition,
  ErrorDefinition,
  ModifierDefinition,
  SoliditySourceUnit,
} from "@solidity-workbench/common";
import type { SymbolIndex } from "../analyzer/symbol-index.js";
import type { ResolvedContract, SemanticResolver } from "../analyzer/semantic-resolver.js";
import { resolveEffectiveNatspec } from "../utils/natspec.js";
import type { SolidityParser } from "../parser/solidity-parser.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";
import { URI } from "vscode-uri";
import { resolveDottedReceiverTypeName } from "../utils/receiver-type.js";
import { findUsingForFunction } from "../utils/using-for.js";

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
    private resolver?: SemanticResolver,
    private workspace?: WorkspaceManager,
  ) {}

  provideSignatureHelp(document: TextDocument, position: Position): SignatureHelp | null {
    const text = document.getText();
    const offset = document.offsetAt(position);

    // Walk backward from cursor to find the opening paren and function name
    const callContext = this.findCallContext(text, offset);
    if (!callContext) return null;

    const { functionName, activeParameter, containerName } = callContext;

    // Look up function definitions
    const signatures = this.findSignatures(functionName, containerName, document.uri, position);
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
      const containerEnd = nameStart - 2;
      let containerStart = containerEnd;
      while (containerStart > 0 && /[\w$.]/.test(text[containerStart - 1])) containerStart--;
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
    documentUri: string,
    position: Position,
  ): SignatureInformation[] {
    const signatures: SignatureInformation[] = [];

    // If we have a container, resolve through that contract
    if (containerName) {
      const receiverTypeName =
        resolveDottedReceiverTypeName(
          this.parser,
          this.symbolIndex,
          documentUri,
          position,
          containerName,
        ) ?? containerName;
      const usingForHit = findUsingForFunction(
        this.parser,
        this.symbolIndex,
        documentUri,
        this.findEnclosingContract(documentUri, position),
        receiverTypeName,
        funcName,
        undefined,
        this.resolver,
      );
      if (usingForHit) {
        signatures.push(
          this.buildSignature(usingForHit.fn, usingForHit.containerName ?? "", {
            skipFirstParameter: true,
            containerUri: usingForHit.filePath,
          }),
        );
        return signatures;
      }

      const resolvedChain = this.resolveVisibleInheritanceChain(receiverTypeName, documentUri);
      if (resolvedChain) {
        for (const entry of resolvedChain) {
          this.addContractSignatures(signatures, entry, funcName);
        }
        return signatures;
      }

      const chain = this.getParserInheritanceChain(receiverTypeName, documentUri);
      for (const entry of chain) {
        for (const func of entry.contract.functions) {
          if (func.name === funcName) {
            signatures.push(
              this.buildSignature(func, entry.contract.name, { containerUri: entry.uri }),
            );
          }
        }
      }
      return signatures;
    }

    const scopedSignatures = this.findUnqualifiedSignatures(funcName, documentUri, position);
    if (scopedSignatures.length > 0) return scopedSignatures;

    // Otherwise search globally. This is intentionally only a legacy
    // parser-only fallback for minimal single-file setups without import
    // awareness; resolver-backed or workspace-backed flows should prefer no
    // result over an unrelated same-named declaration from a reachable file.
    if (this.resolver || this.workspace) return signatures;

    const symbols = this.symbolIndex.findSymbols(funcName);
    for (const sym of symbols) {
      if (
        sym.kind === "function" ||
        sym.kind === "modifier" ||
        sym.kind === "event" ||
        sym.kind === "error"
      ) {
        if (sym.containerName) {
          const entry = this.symbolIndex.getContract(sym.containerName, sym.filePath);
          if (entry) {
            const func = entry.contract.functions.find((f) => f.name === funcName);
            if (func) {
              signatures.push(
                this.buildSignature(func, sym.containerName, {
                  containerUri: entry.uri,
                }),
              );
              continue;
            }
            const mod = entry.contract.modifiers.find((m) => m.name === funcName);
            if (mod) {
              signatures.push(
                this.buildModifierSignature(mod, sym.containerName, {
                  containerUri: entry.uri,
                }),
              );
              continue;
            }
            const event = entry.contract.events.find((e) => e.name === funcName);
            if (event) {
              signatures.push(this.buildEventSignature(event));
              continue;
            }
            const error = entry.contract.errors.find((e) => e.name === funcName);
            if (error) {
              signatures.push(this.buildErrorSignature(error));
            }
          }
        } else if (sym.kind === "function") {
          const parsed = this.parser.get(sym.filePath);
          const fn = parsed?.sourceUnit.freeFunctions.find((f) => f.name === funcName);
          if (fn) {
            signatures.push(this.buildSignature(fn, "", { containerUri: sym.filePath }));
          }
        } else if (sym.kind === "error") {
          const parsed = this.parser.get(sym.filePath);
          const err = parsed?.sourceUnit.errors.find((e) => e.name === funcName);
          if (err) {
            signatures.push(this.buildErrorSignature(err));
          }
        } else if (sym.kind === "event") {
          const parsed = this.parser.get(sym.filePath);
          const event = parsed?.sourceUnit.events.find((e) => e.name === funcName);
          if (event) {
            signatures.push(this.buildEventSignature(event));
          }
        }
      }
    }

    return signatures;
  }

  private findUnqualifiedSignatures(
    funcName: string,
    documentUri: string,
    position: Position,
  ): SignatureInformation[] {
    const sourceUnit = this.parser.get(documentUri)?.sourceUnit;
    if (!sourceUnit) return [];

    const signatures: SignatureInformation[] = [];
    const contract = this.findEnclosingContract(documentUri, position);
    if (contract) {
      const resolver = this.resolver;
      const resolved = resolver?.resolveContract(contract.name, documentUri);
      if (resolver && resolved) {
        for (const entry of resolver.getInheritanceChainFor(resolved)) {
          this.addContractCallableSignatures(signatures, entry.contract, funcName, entry.uri);
        }
      } else {
        for (const entry of this.getParserInheritanceChain(contract.name, documentUri)) {
          this.addContractCallableSignatures(signatures, entry.contract, funcName, entry.uri);
        }
      }
    }

    this.addSourceUnitCallableSignatures(signatures, sourceUnit, funcName, documentUri);
    this.addImportedCallableSignatures(signatures, funcName, documentUri);
    return this.dedupeSignatures(signatures);
  }

  private addContractCallableSignatures(
    signatures: SignatureInformation[],
    contract: ContractDefinition,
    funcName: string,
    uri?: string,
  ): void {
    for (const func of contract.functions) {
      if (func.name === funcName) {
        signatures.push(this.buildSignature(func, contract.name, uri ? { containerUri: uri } : {}));
      }
    }
    for (const mod of contract.modifiers) {
      if (mod.name === funcName) {
        signatures.push(
          this.buildModifierSignature(mod, contract.name, uri ? { containerUri: uri } : {}),
        );
      }
    }
    for (const event of contract.events) {
      if (event.name === funcName) signatures.push(this.buildEventSignature(event));
    }
    for (const error of contract.errors) {
      if (error.name === funcName) signatures.push(this.buildErrorSignature(error));
    }
  }

  private addSourceUnitCallableSignatures(
    signatures: SignatureInformation[],
    sourceUnit: SoliditySourceUnit,
    funcName: string,
    uri: string,
  ): void {
    for (const fn of sourceUnit.freeFunctions) {
      if (fn.name === funcName) signatures.push(this.buildSignature(fn, "", { containerUri: uri }));
    }
    for (const event of sourceUnit.events) {
      if (event.name === funcName) signatures.push(this.buildEventSignature(event));
    }
    for (const error of sourceUnit.errors) {
      if (error.name === funcName) signatures.push(this.buildErrorSignature(error));
    }
  }

  private addImportedCallableSignatures(
    signatures: SignatureInformation[],
    funcName: string,
    documentUri: string,
  ): void {
    const imported = this.resolver
      ? this.resolver.resolveImportedSymbol(funcName, documentUri)
      : this.resolveParserImportedSymbol(funcName, documentUri);
    if (imported) {
      const importedUnit = this.parser.get(imported.uri)?.sourceUnit;
      if (importedUnit) {
        this.addSourceUnitCallableSignatures(signatures, importedUnit, imported.name, imported.uri);
      }
      return;
    }
  }

  private resolveParserImportedSymbol(
    name: string,
    documentUri: string,
  ): { name: string; uri: string } | undefined {
    if (!this.workspace) return undefined;

    const sourceUnit = this.parser.get(documentUri)?.sourceUnit;
    if (!sourceUnit) return undefined;

    let fromPath: string;
    try {
      fromPath = this.workspace.uriToPath(documentUri);
    } catch {
      return undefined;
    }

    const scoped = name.includes(".") ? name.split(".") : null;
    for (const imp of sourceUnit.imports) {
      let targetPath: string | null;
      try {
        targetPath = this.workspace.resolveImport(imp.path, fromPath);
      } catch {
        targetPath = null;
      }
      if (!targetPath) continue;
      const targetUri = URI.file(targetPath).toString();

      if (scoped && imp.unitAlias === scoped[0] && scoped[1]) {
        return { name: scoped[1], uri: targetUri };
      }

      if (scoped) continue;
      for (const alias of imp.symbolAliases ?? []) {
        const visibleName = alias.alias ?? alias.symbol;
        if (visibleName === name) return { name: alias.symbol, uri: targetUri };
      }

      const isPlainImport = !imp.unitAlias && (imp.symbolAliases ?? []).length === 0;
      if (isPlainImport) {
        const targetUnit = this.parser.get(targetUri)?.sourceUnit;
        if (
          targetUnit?.freeFunctions.some((fn) => fn.name === name) ||
          targetUnit?.events.some((event) => event.name === name) ||
          targetUnit?.errors.some((error) => error.name === name)
        ) {
          return { name, uri: targetUri };
        }
      }
    }

    return undefined;
  }

  private dedupeSignatures(signatures: SignatureInformation[]): SignatureInformation[] {
    const seen = new Set<string>();
    const deduped: SignatureInformation[] = [];
    for (const sig of signatures) {
      const key = sig.label;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(sig);
    }
    return deduped;
  }

  private resolveVisibleInheritanceChain(
    typeName: string,
    documentUri: string,
  ): ResolvedContract[] | null {
    if (!this.resolver) return null;

    const imported = this.resolver.resolveImportedSymbol(typeName, documentUri);
    if (imported) return this.resolver.getInheritanceChain(typeName, documentUri);

    const symbols = this.resolver.filterVisibleSymbols(
      documentUri,
      this.symbolIndex
        .findSymbols(typeName)
        .filter(
          (sym) => sym.kind === "contract" || sym.kind === "interface" || sym.kind === "library",
        ),
    );
    const sym = symbols.find((candidate) => candidate.filePath === documentUri) ?? symbols[0];
    return sym ? this.resolver.getInheritanceChain(sym.name, sym.filePath) : [];
  }

  private getParserInheritanceChain(
    typeName: string,
    documentUri: string,
  ): Array<{ uri: string; contract: ContractDefinition }> {
    const root = this.resolveParserVisibleContract(typeName, documentUri);
    if (!root) return [];

    const chain: Array<{ uri: string; contract: ContractDefinition }> = [];
    const visited = new Set<string>();

    const walk = (entry: { uri: string; contract: ContractDefinition }): void => {
      const key = `${entry.uri}#${entry.contract.name}`;
      if (visited.has(key)) return;
      visited.add(key);
      chain.push(entry);

      for (const base of entry.contract.baseContracts) {
        const baseEntry = this.resolveParserVisibleContract(base.baseName, entry.uri);
        if (baseEntry) walk(baseEntry);
      }
    };

    walk(root);
    return chain;
  }

  private resolveParserVisibleContract(
    typeName: string,
    documentUri: string,
  ): { uri: string; contract: ContractDefinition } | undefined {
    const local = this.symbolIndex.getContract(typeName, documentUri);
    if (local) return local;

    return this.resolveParserImportedContract(typeName, documentUri);
  }

  private resolveParserImportedContract(
    typeName: string,
    documentUri: string,
  ): { uri: string; contract: ContractDefinition } | undefined {
    if (!this.workspace) return undefined;

    const sourceUnit = this.parser.get(documentUri)?.sourceUnit;
    if (!sourceUnit) return undefined;

    let fromPath: string;
    try {
      fromPath = this.workspace.uriToPath(documentUri);
    } catch {
      return undefined;
    }

    const scoped = typeName.includes(".") ? typeName.split(".") : null;
    for (const imp of sourceUnit.imports) {
      let targetPath: string | null;
      try {
        targetPath = this.workspace.resolveImport(imp.path, fromPath);
      } catch {
        targetPath = null;
      }
      if (!targetPath) continue;
      const targetUri = URI.file(targetPath).toString();

      if (scoped && imp.unitAlias === scoped[0] && scoped[1]) {
        return this.symbolIndex.getContract(scoped[1], targetUri);
      }

      if (scoped) continue;
      for (const alias of imp.symbolAliases ?? []) {
        const visibleName = alias.alias ?? alias.symbol;
        if (visibleName !== typeName) continue;
        return this.symbolIndex.getContract(alias.symbol, targetUri);
      }

      if (!imp.unitAlias && (imp.symbolAliases ?? []).length === 0) {
        const imported = this.symbolIndex.getContract(typeName, targetUri);
        if (imported) return imported;
      }
    }

    return undefined;
  }

  private addContractSignatures(
    signatures: SignatureInformation[],
    entry: ResolvedContract,
    funcName: string,
  ): void {
    for (const func of entry.contract.functions) {
      if (func.name === funcName) {
        signatures.push(
          this.buildSignature(func, entry.contract.name, { containerUri: entry.uri }),
        );
      }
    }
    for (const mod of entry.contract.modifiers) {
      if (mod.name === funcName) {
        signatures.push(
          this.buildModifierSignature(mod, entry.contract.name, { containerUri: entry.uri }),
        );
      }
    }
  }

  private findEnclosingContract(
    documentUri: string,
    position: Position,
  ): ContractDefinition | undefined {
    const sourceUnit = this.parser.get(documentUri)?.sourceUnit;
    return sourceUnit?.contracts.find((contract) => this.positionInRange(position, contract.range));
  }

  private positionInRange(position: Position, range: { start: Position; end: Position }): boolean {
    const afterStart =
      position.line > range.start.line ||
      (position.line === range.start.line && position.character >= range.start.character);
    const beforeEnd =
      position.line < range.end.line ||
      (position.line === range.end.line && position.character <= range.end.character);
    return afterStart && beforeEnd;
  }

  private buildSignature(
    func: FunctionDefinition,
    containerName: string,
    options: { skipFirstParameter?: boolean; containerUri?: string } = {},
  ): SignatureInformation {
    const sym =
      func.name && containerName
        ? this.symbolIndex
            .findSymbols(func.name)
            .find(
              (s) =>
                s.kind === "function" &&
                s.containerName === containerName &&
                (!options.containerUri || s.filePath === options.containerUri),
            )
        : undefined;
    const effective = sym
      ? resolveEffectiveNatspec(sym, this.symbolIndex, this.resolver)
      : func.natspec;

    const params: ParameterInformation[] = func.parameters
      .slice(options.skipFirstParameter ? 1 : 0)
      .map((p) => {
        const label = `${p.typeName}${p.storageLocation ? " " + p.storageLocation : ""}${p.name ? " " + p.name : ""}`;
        const doc = effective?.params?.[p.name ?? ""];
        return {
          label,
          documentation: doc ? { kind: MarkupKind.Markdown, value: doc } : undefined,
        };
      });

    const paramStr = params.map((p) => p.label).join(", ");
    const returnsStr =
      func.returnParameters.length > 0
        ? ` returns (${func.returnParameters.map((p) => `${p.typeName}${p.name ? " " + p.name : ""}`).join(", ")})`
        : "";
    const vis = func.visibility !== "public" ? ` ${func.visibility}` : "";
    const mut = func.mutability !== "nonpayable" ? ` ${func.mutability}` : "";

    const label = `${func.name ?? func.kind}(${paramStr})${vis}${mut}${returnsStr}`;

    const documentation = this.buildDocumentation(effective, containerName);

    return {
      label,
      documentation: documentation
        ? { kind: MarkupKind.Markdown, value: documentation }
        : undefined,
      parameters: params,
    };
  }

  private buildEventSignature(event: EventDefinition): SignatureInformation {
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

  private buildModifierSignature(
    mod: ModifierDefinition,
    containerName: string,
    options: { containerUri?: string } = {},
  ): SignatureInformation {
    const sym = this.symbolIndex
      .findSymbols(mod.name)
      .find(
        (s) =>
          s.kind === "modifier" &&
          s.containerName === containerName &&
          (!options.containerUri || s.filePath === options.containerUri),
      );
    const effective = sym
      ? resolveEffectiveNatspec(sym, this.symbolIndex, this.resolver)
      : mod.natspec;

    const params = mod.parameters.map((p) => {
      const label = `${p.typeName}${p.storageLocation ? " " + p.storageLocation : ""}${p.name ? " " + p.name : ""}`;
      const doc = effective?.params?.[p.name ?? ""];
      return {
        label,
        documentation: doc ? { kind: MarkupKind.Markdown, value: doc } : undefined,
      };
    });
    const paramStr = params.map((p) => p.label).join(", ");
    const documentation = this.buildDocumentation(effective, containerName);

    return {
      label: `${mod.name}(${paramStr})`,
      documentation: documentation
        ? { kind: MarkupKind.Markdown, value: documentation }
        : undefined,
      parameters: params,
    };
  }

  private buildErrorSignature(error: ErrorDefinition): SignatureInformation {
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
    if (!natspec) {
      return containerName ? `*Defined in* \`${containerName}\`` : undefined;
    }

    const parts: string[] = [];
    if (natspec.notice) parts.push(natspec.notice);
    if (natspec.dev) parts.push(`\n**Dev:** ${natspec.dev}`);
    if (natspec.custom) {
      for (const [tag, desc] of Object.entries(natspec.custom)) {
        if (tag === "inheritdoc") continue;
        parts.push(`\n**${this.formatCustomNatspecLabel(tag)}:** ${desc}`);
      }
    }
    if (containerName) {
      parts.push(`\n*Defined in* \`${containerName}\``);
    }
    return parts.length > 0 ? parts.join("\n") : undefined;
  }

  private formatCustomNatspecLabel(tag: string): string {
    if (tag === "security-contact") return "Security Contact";
    if (tag === "inheritdoc") return "Inherits Documentation From";
    return tag
      .split(/[-_]/)
      .filter(Boolean)
      .map((part) => part[0].toUpperCase() + part.slice(1))
      .join(" ");
  }

  /**
   * Find the best overload — prefer the one where activeParameter is within bounds.
   */
  private findBestOverload(signatures: SignatureInformation[], activeParameter: number): number {
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
        parameters: [ParameterInformation.create("bool condition", "Invariant to assert")],
      },
      revert: {
        label: "revert(string memory reason)",
        documentation: {
          kind: MarkupKind.Markdown,
          value: "Aborts execution and reverts state changes.",
        },
        parameters: [ParameterInformation.create("string memory reason", "Revert reason")],
      },
      keccak256: {
        label: "keccak256(bytes memory data) returns (bytes32)",
        documentation: {
          kind: MarkupKind.Markdown,
          value: "Computes the Keccak-256 hash of the input.",
        },
        parameters: [ParameterInformation.create("bytes memory data", "Data to hash")],
      },
      sha256: {
        label: "sha256(bytes memory data) returns (bytes32)",
        parameters: [ParameterInformation.create("bytes memory data", "Data to hash")],
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
        parameters: [ParameterInformation.create("uint256 blockNumber")],
      },
    };

    return builtins[name] ?? null;
  }
}
