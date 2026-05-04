import type { Hover, Position } from "vscode-languageserver/node.js";
import { MarkupKind } from "vscode-languageserver/node.js";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type {
  FunctionDefinition,
  ModifierDefinition,
  NatspecComment,
  ParameterDeclaration,
  SolSymbol,
  SourceRange,
} from "@solidity-workbench/common";
import type { SymbolIndex } from "../analyzer/symbol-index.js";
import type { SolidityParser } from "../parser/solidity-parser.js";
import type { SolcBridge } from "../compiler/solc-bridge.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";
import type { SemanticResolver } from "../analyzer/semantic-resolver.js";
import { URI } from "vscode-uri";
import { readFileSync } from "node:fs";

/**
 * Provides hover information for Solidity symbols.
 *
 * Shows:
 * - Type/signature information in a Solidity code block
 * - NatSpec documentation (notice, dev, params, returns)
 * - Contract kind (contract/interface/library)
 * - Visibility and mutability for functions
 */
export class HoverProvider {
  private solcBridge: SolcBridge | null = null;

  constructor(
    private symbolIndex: SymbolIndex,
    private parser: SolidityParser,
    private workspace?: WorkspaceManager,
    private resolver?: SemanticResolver,
  ) {}

  /**
   * Wire the SolcBridge (type-resolved AST cache) into hover so that
   * when multiple workspace symbols share a name we can pick the one
   * actually referenced at the cursor position via
   * `referencedDeclaration`. Falls back gracefully when no solc AST
   * exists yet (first-load, or forge build failed).
   */
  setSolcBridge(bridge: SolcBridge): void {
    this.solcBridge = bridge;
  }

  provideHover(document: TextDocument, position: Position): Hover | null {
    const text = document.getText();
    const word = this.parser.getWordAtPosition(text, position.line, position.character);
    if (!word) return null;

    // Dotted access `Receiver.member` is handled BEFORE we consult the
    // global symbol index. Without this short-circuit, hovering the
    // `unwrap` in `Currency.unwrap(x)` could surface an unrelated
    // `IWstETH.unwrap(uint256)` simply because they share a name. When
    // the receiver is identified but the member can't be found on it,
    // we return `null` — no hover is better than a misleading one.
    const dotted = this.getDottedAccessAtPosition(text, position);
    if (dotted && dotted.member === word) {
      return this.resolveDottedHover(dotted.receiver, dotted.member, document.uri);
    }

    const builtinHover = this.getBuiltinHover(word);
    if (builtinHover) return builtinHover;

    const typeHover = this.getTypeHover(word);
    if (typeHover) return typeHover;

    const localHover = this.getLocalParameterHover(document, position, word);
    if (localHover) return localHover;

    const symbols = this.symbolIndex.findSymbols(word);
    if (symbols.length === 0) return null;

    // Pick the canonical symbol:
    // 1. Consult the solc AST for the
    //    cursor position. If it resolves to a specific declaration, find
    //    the matching symbol-index entry and use that.
    // 2. Otherwise discard symbols that are not visible from the current
    //    file through the current file + transitive import graph.
    // 3. Otherwise prefer the symbol from the current file.
    // 4. Otherwise take the first visible match.
    let sym: SolSymbol | undefined;
    if (this.solcBridge) {
      const resolved = this.resolveViaSolc(document, position);
      if (resolved) {
        sym = symbols.find(
          (s) =>
            s.filePath === resolved.uri &&
            s.nameRange.start.line === resolved.line &&
            Math.abs(s.nameRange.start.character - resolved.character) <= word.length,
        );
      }
    }
    if (!sym) {
      const visibleSymbols = this.filterVisibleSymbols(document.uri, symbols);
      if (visibleSymbols.length === 0) return null;
      sym = visibleSymbols.find((s) => s.filePath === document.uri) ?? visibleSymbols[0];
    }

    return this.buildHover(sym);
  }

  /**
   * When the cursor is on `member` in a `Receiver.member` expression,
   * resolve the hover through the receiver's type rather than through
   * the global name lookup. This prevents the classic "two unrelated
   * contracts happen to share a method name" misresolution.
   *
   * Resolution order:
   *   1. Receiver is a user-defined value type (UDVT): the only valid
   *      members are the built-in `wrap` / `unwrap`; return a synthetic
   *      hover for those or `null` for anything else.
   *   2. Receiver is a contract / interface / library: walk the `is`
   *      inheritance chain and look for a function, state variable,
   *      event, error, struct, or enum with the requested name.
   *   3. Receiver is a struct: search its members.
   *
   * Returns `null` (not a global fallback) when the receiver is
   * identified but the member can't be located — surfacing the wrong
   * symbol is worse than surfacing no symbol.
   */
  private resolveDottedHover(receiver: string, member: string, fromUri: string): Hover | null {
    const receiverSymbols = this.symbolIndex.findSymbols(receiver);
    if (receiverSymbols.length === 0) return null;

    // UDVT builtins: `wrap(underlying) -> UDVT`, `unwrap(UDVT) -> underlying`.
    const udvt = receiverSymbols.find((s) => s.kind === "userDefinedValueType");
    if (udvt) {
      return this.getUdvtBuiltinHover(udvt, member);
    }

    for (const receiverSym of receiverSymbols) {
      if (receiverSym.kind === "contract" || receiverSym.kind === "interface") {
        const hit = this.findMemberInInheritanceChain(receiver, member, fromUri);
        if (hit) return this.buildHover(hit);
      } else if (receiverSym.kind === "library") {
        const hit = this.findMemberInContract(receiver, member, fromUri);
        if (hit) return this.buildHover(hit);
      } else if (receiverSym.kind === "struct") {
        const hit = this.findStructMember(receiverSym, member);
        if (hit) return hit;
      }
    }

    return null;
  }

  /**
   * Parameters and named return values are lexical declarations, not
   * workspace-global symbols. Resolve them before the global symbol
   * index so a local `poolId` never hovers as an unrelated state
   * variable from a different indexed test or dependency file.
   */
  private getLocalParameterHover(
    document: TextDocument,
    position: Position,
    word: string,
  ): Hover | null {
    const result = this.parser.get(document.uri);
    if (!result) return null;

    const candidates: Array<FunctionDefinition | ModifierDefinition> = [];
    for (const contract of result.sourceUnit.contracts) {
      candidates.push(...contract.functions, ...contract.modifiers);
    }
    candidates.push(...result.sourceUnit.freeFunctions);

    const scope = candidates
      .filter((candidate) => rangeContains(candidate.range, position))
      .sort((a, b) => rangeSize(a.range) - rangeSize(b.range))[0];
    if (!scope) return null;

    const input = scope.parameters.find((param) => param.name === word);
    if (input) return this.buildParameterHover(input, scope, "Parameter");

    if ("returnParameters" in scope) {
      const output = scope.returnParameters.find((param) => param.name === word);
      if (output) return this.buildParameterHover(output, scope, "Return parameter");
    }

    return null;
  }

  private buildParameterHover(
    param: ParameterDeclaration,
    scope: FunctionDefinition | ModifierDefinition,
    label: "Parameter" | "Return parameter",
  ): Hover {
    const name = param.name ?? "";
    const storage = param.storageLocation ? ` ${param.storageLocation}` : "";
    const declaration = `${param.typeName}${storage} ${name}`.trim();
    const parts = [`\`\`\`solidity\n${declaration}\n\`\`\``];

    const docs = name ? scope.natspec?.params?.[name] : undefined;
    if (docs) parts.push(docs);

    const scopeName =
      scope.type === "ModifierDefinition"
        ? `modifier ${scope.name}`
        : scope.name
          ? `function ${scope.name}`
          : scope.kind;
    parts.push(`*${label} of* \`${scopeName}\``);

    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: parts.join("\n\n---\n\n"),
      },
    };
  }

  private filterVisibleSymbols(currentUri: string, symbols: SolSymbol[]): SolSymbol[] {
    if (this.resolver) return this.resolver.filterVisibleSymbols(currentUri, symbols);
    const reachable = this.collectReachableUris(currentUri);
    return symbols.filter((sym) => reachable.has(sym.filePath));
  }

  private collectReachableUris(uri: string, visited: Set<string> = new Set()): Set<string> {
    if (visited.has(uri)) return visited;
    visited.add(uri);

    if (!this.workspace) return visited;
    const result = this.parser.get(uri);
    if (!result) return visited;

    let fsPath: string;
    try {
      fsPath = this.workspace.uriToPath(uri);
    } catch {
      return visited;
    }

    for (const imp of result.sourceUnit.imports) {
      const targetPath = this.workspace.resolveImport(imp.path, fsPath);
      if (!targetPath) continue;
      this.collectReachableUris(URI.file(targetPath).toString(), visited);
    }

    return visited;
  }

  private findMemberInInheritanceChain(
    receiver: string,
    member: string,
    fromUri?: string,
  ): SolSymbol | null {
    const resolved = this.resolver?.findMemberInInheritanceChain(receiver, member, fromUri);
    if (resolved) return resolved;

    const chain = this.symbolIndex.getInheritanceChain(receiver);
    for (const contract of chain) {
      const sym = this.lookupMember(contract.name, contract, member);
      if (sym) return sym;
    }
    return null;
  }

  private findMemberInContract(
    receiver: string,
    member: string,
    fromUri?: string,
  ): SolSymbol | null {
    const resolvedContract = this.resolver?.resolveContract(receiver, fromUri);
    if (resolvedContract) {
      const resolved = this.resolver?.findMemberInContract(resolvedContract, member);
      if (resolved) return resolved;
    }

    const entry = this.symbolIndex.getContract(receiver);
    if (!entry) return null;
    return this.lookupMember(entry.contract.name, entry.contract, member);
  }

  /**
   * Search one contract/library's own declared members (NOT inherited)
   * and return a matching symbol-index entry for the member name. We
   * round-trip through the symbol index so the returned `SolSymbol`
   * has a populated `natspec`, `detail`, and `containerName`.
   */
  private lookupMember(
    containerName: string,
    contract: {
      functions: { name: string | null }[];
      stateVariables: { name: string }[];
      events: { name: string }[];
      errors: { name: string }[];
      structs: { name: string }[];
      enums: { name: string }[];
    },
    member: string,
  ): SolSymbol | null {
    const hasMember =
      contract.functions.some((f) => f.name === member) ||
      contract.stateVariables.some((v) => v.name === member) ||
      contract.events.some((e) => e.name === member) ||
      contract.errors.some((e) => e.name === member) ||
      contract.structs.some((s) => s.name === member) ||
      contract.enums.some((e) => e.name === member);
    if (!hasMember) return null;

    const candidates = this.symbolIndex.findSymbols(member);
    return candidates.find((s) => s.containerName === containerName) ?? null;
  }

  private findStructMember(structSym: SolSymbol, member: string): Hover | null {
    // Struct members aren't individually registered in the symbol index
    // today, so emit a best-effort synthetic hover that at least says
    // "this is a member of struct X".
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: `\`\`\`solidity\n${structSym.name}.${member}\n\`\`\`\n\n*Struct member of* \`${structSym.name}\``,
      },
    };
  }

  private getUdvtBuiltinHover(udvt: SolSymbol, member: string): Hover | null {
    const name = udvt.name;
    const underlying = udvt.detail ?? "underlying";
    if (member === "wrap") {
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value:
            `\`\`\`solidity\nfunction ${name}.wrap(${underlying}) pure returns (${name})\n\`\`\`\n\n` +
            `Implicit converter from the underlying type \`${underlying}\` to the user-defined value type \`${name}\`. No runtime cost; identity at the EVM level.`,
        },
      };
    }
    if (member === "unwrap") {
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value:
            `\`\`\`solidity\nfunction ${name}.unwrap(${name}) pure returns (${underlying})\n\`\`\`\n\n` +
            `Implicit converter from the user-defined value type \`${name}\` to its underlying type \`${underlying}\`. No runtime cost; identity at the EVM level.`,
        },
      };
    }
    // UDVTs only expose wrap/unwrap; anything else is a type error.
    return null;
  }

  /**
   * Detect a dotted access of the form `Receiver.member` where the
   * cursor is on the `member` side. Returns the receiver identifier
   * and the member identifier, or `null` if the cursor isn't on the
   * right-hand side of a dotted access.
   */
  private getDottedAccessAtPosition(
    text: string,
    position: Position,
  ): { receiver: string; member: string } | null {
    const line = text.split("\n")[position.line] ?? "";
    // Walk backward from the cursor through identifier chars to find
    // the start of the member, then require the preceding char to be
    // a dot.
    let memberStart = position.character;
    while (memberStart > 0 && /[\w$]/.test(line[memberStart - 1])) memberStart--;
    if (memberStart === 0 || line[memberStart - 1] !== ".") return null;

    const receiverEnd = memberStart - 1;
    let receiverStart = receiverEnd;
    while (receiverStart > 0 && /[\w$]/.test(line[receiverStart - 1])) receiverStart--;
    if (receiverStart === receiverEnd) return null;

    // Walk forward to capture the full member identifier (cursor may
    // be in the middle of it).
    let memberEnd = position.character;
    while (memberEnd < line.length && /[\w$]/.test(line[memberEnd])) memberEnd++;

    const receiver = line.slice(receiverStart, receiverEnd);
    const member = line.slice(memberStart, memberEnd);
    if (!receiver || !member) return null;
    return { receiver, member };
  }

  /**
   * Map the cursor position to a solc-AST `referencedDeclaration`, then
   * back to a URI + zero-based position.
   */
  private resolveViaSolc(
    document: TextDocument,
    position: Position,
  ): { uri: string; line: number; character: number } | null {
    if (!this.solcBridge) return null;
    const fsPath = URI.parse(document.uri).fsPath;
    const offset = document.offsetAt(position);
    const ref = this.solcBridge.resolveReference(fsPath, offset);
    if (!ref) return null;

    // solc emits byte offsets. For our purposes we only need a coarse
    // filename + ~line pinpoint, so read the referenced file to compute
    // (line, character) from the offset.
    try {
      const text = readFileSync(ref.filePath, "utf-8");
      const prefix = text.slice(0, ref.offset);
      const line = prefix.split(/\r?\n/).length - 1;
      const character =
        prefix.length - Math.max(prefix.lastIndexOf("\n"), prefix.lastIndexOf("\r")) - 1;
      return {
        uri: URI.file(ref.filePath).toString(),
        line,
        character,
      };
    } catch {
      return null;
    }
  }

  private buildHover(sym: SolSymbol): Hover {
    const parts: string[] = [];

    // Code block with the declaration
    const declaration = this.buildDeclaration(sym);
    parts.push(`\`\`\`solidity\n${declaration}\n\`\`\``);

    // NatSpec documentation
    if (sym.natspec) {
      parts.push(this.formatNatspec(sym.natspec));
    }

    // Container info
    if (sym.containerName) {
      parts.push(`*Defined in* \`${sym.containerName}\``);
    }

    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: parts.join("\n\n---\n\n"),
      },
    };
  }

  private buildDeclaration(sym: SolSymbol): string {
    switch (sym.kind) {
      case "contract":
        return `contract ${sym.name}`;
      case "interface":
        return `interface ${sym.name}`;
      case "library":
        return `library ${sym.name}`;
      case "function":
        return `function ${sym.name}${sym.detail ?? "()"}`;
      case "modifier":
        return `modifier ${sym.name}${sym.detail ?? "()"}`;
      case "event":
        return `event ${sym.name}${sym.detail ?? "()"}`;
      case "error":
        return `error ${sym.name}${sym.detail ?? "()"}`;
      case "struct":
        return `struct ${sym.name}`;
      case "enum":
        return `enum ${sym.name}`;
      case "stateVariable":
        return `${sym.detail ?? "unknown"} ${sym.name}`;
      case "localVariable":
      case "parameter":
        return `${sym.detail ?? "unknown"} ${sym.name}`;
      case "userDefinedValueType":
        return `type ${sym.name}`;
    }
  }

  private formatNatspec(natspec: NatspecComment): string {
    const parts: string[] = [];

    if (natspec.notice) parts.push(natspec.notice);
    if (natspec.dev) parts.push(`\n**Dev:** ${natspec.dev}`);

    if (natspec.params && Object.keys(natspec.params).length > 0) {
      parts.push("\n**Parameters:**");
      for (const [name, desc] of Object.entries(natspec.params)) {
        parts.push(`- \`${name}\` — ${desc}`);
      }
    }

    if (natspec.returns && Object.keys(natspec.returns).length > 0) {
      parts.push("\n**Returns:**");
      for (const [name, desc] of Object.entries(natspec.returns)) {
        parts.push(`- \`${name}\` — ${desc}`);
      }
    }

    return parts.join("\n");
  }

  private getBuiltinHover(word: string): Hover | null {
    const builtins: Record<string, string> = {
      msg: "```solidity\nstruct {\n  address sender;\n  uint256 value;\n  bytes data;\n  bytes4 sig;\n}\n```\nTransaction message context.",
      block:
        "```solidity\nstruct {\n  uint256 timestamp;\n  uint256 number;\n  uint256 chainid;\n  address payable coinbase;\n  uint256 prevrandao;\n  uint256 gaslimit;\n  uint256 basefee;\n}\n```\nCurrent block properties.",
      tx: "```solidity\nstruct {\n  address origin;\n  uint256 gasprice;\n}\n```\nTransaction properties.",
      require:
        "```solidity\nrequire(bool condition, string memory message)\n```\nReverts if condition is false with the given message.",
      assert:
        "```solidity\nassert(bool condition)\n```\nReverts with Panic(1) if condition is false. Use for invariants.",
      revert:
        "```solidity\nrevert(string memory reason)\nrevert CustomError(args...)\n```\nAborts execution and reverts state changes.",
      keccak256:
        "```solidity\nkeccak256(bytes memory) returns (bytes32)\n```\nComputes the Keccak-256 hash.",
      sha256:
        "```solidity\nsha256(bytes memory) returns (bytes32)\n```\nComputes the SHA-256 hash.",
      ecrecover:
        "```solidity\necrecover(bytes32 hash, uint8 v, bytes32 r, bytes32 s) returns (address)\n```\nRecovers the signer address from a signature.",
      addmod:
        "```solidity\naddmod(uint256 x, uint256 y, uint256 k) returns (uint256)\n```\nComputes (x + y) % k with arbitrary precision.",
      mulmod:
        "```solidity\nmulmod(uint256 x, uint256 y, uint256 k) returns (uint256)\n```\nComputes (x * y) % k with arbitrary precision.",
      selfdestruct:
        "```solidity\nselfdestruct(address payable recipient)\n```\n**Deprecated.** Sends remaining Ether to recipient.",
      this: "```solidity\naddress(this)\n```\nThe current contract instance. Converts to `address`.",
      super: "The parent contract in the inheritance hierarchy.",
      gasleft: "```solidity\ngasleft() returns (uint256)\n```\nRemaining gas.",
      blockhash:
        "```solidity\nblockhash(uint256 blockNumber) returns (bytes32)\n```\nHash of the given block (only works for the last 256 blocks).",
    };

    const doc = builtins[word];
    if (!doc) return null;

    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: doc,
      },
    };
  }

  /**
   * Hover for Solidity elementary types. Rather than hand-maintaining
   * 65+ entries (uint8..uint256, int8..int256, bytes1..bytes32), we
   * recognise the family programmatically so every legal variant gets
   * the same quality of documentation.
   *
   * See https://docs.soliditylang.org/en/latest/types.html#value-types
   * for the complete list. `fixed` / `ufixed` are reserved but not yet
   * implemented by the compiler; we still emit a hover so users who
   * write them get a pointer to why the code won't compile.
   */
  private getTypeHover(word: string): Hover | null {
    const doc = describeElementaryType(word);
    if (!doc) return null;
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: doc,
      },
    };
  }
}

function describeElementaryType(word: string): string | null {
  if (word === "address") {
    return "```solidity\naddress\n```\n20-byte Ethereum address. Holds a `balance` and can receive Ether when typed as `address payable`.";
  }
  if (word === "bool") {
    return "```solidity\nbool\n```\nBoolean value — either `true` or `false`.";
  }
  if (word === "string") {
    return "```solidity\nstring\n```\nDynamically-sized UTF-8-encoded string. Equal to a `bytes` array without fixed-length access.";
  }
  if (word === "bytes") {
    return "```solidity\nbytes\n```\nDynamically-sized byte array. Cheaper than `byte[]` because elements are tightly packed.";
  }
  if (word === "fixed" || word === "ufixed") {
    return `\`\`\`solidity\n${word}\n\`\`\`\nFixed-point decimal number. Reserved by the language but **not yet implemented** by the compiler — you can declare variables of this type but cannot assign to them.`;
  }

  // uint8, uint16, ..., uint256 (step 8). `uint` is an alias for uint256.
  if (word === "uint" || /^uint(\d+)$/.test(word)) {
    const bits = word === "uint" ? 256 : Number(word.slice(4));
    if (bits >= 8 && bits <= 256 && bits % 8 === 0) {
      const alias = word === "uint" ? ` (alias for \`uint256\`)` : "";
      return (
        "```solidity\n" +
        word +
        "\n```\n" +
        `Unsigned ${bits}-bit integer${alias}. Range: \`0\` to \`2**${bits} - 1\`. Overflow reverts under Solidity 0.8+ unless inside an \`unchecked { ... }\` block.`
      );
    }
  }

  // int8, int16, ..., int256 (step 8). `int` is an alias for int256.
  if (word === "int" || /^int(\d+)$/.test(word)) {
    const bits = word === "int" ? 256 : Number(word.slice(3));
    if (bits >= 8 && bits <= 256 && bits % 8 === 0) {
      const alias = word === "int" ? ` (alias for \`int256\`)` : "";
      return (
        "```solidity\n" +
        word +
        "\n```\n" +
        `Signed ${bits}-bit integer${alias}. Range: \`-2**${bits - 1}\` to \`2**${bits - 1} - 1\`. Overflow reverts under Solidity 0.8+ unless inside an \`unchecked { ... }\` block.`
      );
    }
  }

  // bytes1, bytes2, ..., bytes32. `byte` is the deprecated alias for bytes1.
  if (word === "byte" || /^bytes(\d+)$/.test(word)) {
    const size = word === "byte" ? 1 : Number(word.slice(5));
    if (size >= 1 && size <= 32) {
      const alias = word === "byte" ? ` — **deprecated** alias for \`bytes1\`` : "";
      return (
        "```solidity\n" +
        word +
        "\n```\n" +
        `Fixed-size byte array of length ${size}${alias}. Indexable per-byte; cheaper than \`bytes\` when the size is known and ≤ 32.`
      );
    }
  }

  // ufixedMxN / fixedMxN — reserved but not implemented.
  if (/^u?fixed\d+x\d+$/.test(word)) {
    return (
      "```solidity\n" +
      word +
      "\n```\nFixed-point decimal number. Reserved by the language but **not yet implemented** by the compiler — you can declare variables of this type but cannot assign to them."
    );
  }

  return null;
}

function rangeContains(range: SourceRange, position: Position): boolean {
  return comparePosition(position, range.start) >= 0 && comparePosition(position, range.end) <= 0;
}

function rangeSize(range: SourceRange): number {
  return (
    (range.end.line - range.start.line) * 10_000 + (range.end.character - range.start.character)
  );
}

function comparePosition(a: Position, b: Position): number {
  if (a.line !== b.line) return a.line - b.line;
  return a.character - b.character;
}
