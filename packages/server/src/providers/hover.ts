import type { Hover, Position } from "vscode-languageserver/node.js";
import { MarkupContent, MarkupKind } from "vscode-languageserver/node.js";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type { NatspecComment, SolSymbol } from "@solidity-workbench/common";
import type { SymbolIndex } from "../analyzer/symbol-index.js";
import type { SolidityParser } from "../parser/solidity-parser.js";

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
  constructor(
    private symbolIndex: SymbolIndex,
    private parser: SolidityParser,
  ) {}

  provideHover(document: TextDocument, position: Position): Hover | null {
    const text = document.getText();
    const word = this.parser.getWordAtPosition(text, position.line, position.character);
    if (!word) return null;

    // Check for built-in globals
    const builtinHover = this.getBuiltinHover(word);
    if (builtinHover) return builtinHover;

    // Check for Solidity type keywords
    const typeHover = this.getTypeHover(word);
    if (typeHover) return typeHover;

    // Look up in symbol index
    const symbols = this.symbolIndex.findSymbols(word);
    if (symbols.length === 0) return null;

    // Prefer the symbol from the current file
    const sym = symbols.find((s) => s.filePath === document.uri) ?? symbols[0];

    return this.buildHover(sym);
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
    if (natspec.dev) parts.push(`\n> **Dev:** ${natspec.dev}`);

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

  private getTypeHover(word: string): Hover | null {
    const types: Record<string, string> = {
      address: "`address` — 20-byte Ethereum address. Use `address payable` for transfer/send.",
      bool: "`bool` — Boolean value (`true` or `false`)",
      string: "`string` — Dynamically-sized UTF-8 string",
      bytes: "`bytes` — Dynamically-sized byte array",
      uint256: "`uint256` — Unsigned 256-bit integer (0 to 2^256 - 1)",
      int256: "`int256` — Signed 256-bit integer (-2^255 to 2^255 - 1)",
      bytes32: "`bytes32` — Fixed-size 32-byte array",
    };

    const doc = types[word];
    if (!doc) return null;

    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: doc,
      },
    };
  }
}
