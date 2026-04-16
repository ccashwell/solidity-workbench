import type { CompletionItem, Position } from "vscode-languageserver/node.js";
import {
  CompletionItemKind,
  InsertTextFormat,
  MarkupContent,
  MarkupKind,
} from "vscode-languageserver/node.js";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type { SymbolKind } from "@solidity-workbench/common";
import type { SymbolIndex } from "../analyzer/symbol-index.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";

/**
 * Provides context-aware completions for Solidity.
 *
 * Completion triggers:
 * - `.` → member access (contract members, struct fields, address methods)
 * - `"` or `'` → import paths
 * - `@` → natspec tags
 * - General typing → keywords, types, visible symbols
 */
export class CompletionProvider {
  constructor(
    private symbolIndex: SymbolIndex,
    private workspace: WorkspaceManager,
  ) {}

  provideCompletions(document: TextDocument, position: Position): CompletionItem[] {
    const text = document.getText();
    const offset = document.offsetAt(position);
    const lineText = text.split("\n")[position.line] ?? "";
    const textBefore = lineText.slice(0, position.character);

    // Detect context
    if (this.isInImportPath(textBefore)) {
      return this.provideImportCompletions(textBefore);
    }

    if (this.isInNatspecComment(text, offset)) {
      return this.provideNatspecCompletions();
    }

    if (textBefore.trimEnd().endsWith(".")) {
      return this.provideMemberCompletions(text, position, textBefore);
    }

    // Default: provide keywords + visible symbols
    return [
      ...this.provideKeywordCompletions(textBefore),
      ...this.provideTypeCompletions(),
      ...this.provideSymbolCompletions(document.uri, textBefore),
      ...this.provideSnippetCompletions(textBefore),
    ];
  }

  resolveCompletion(item: CompletionItem): CompletionItem {
    // Enrich the completion with additional documentation
    if (item.data?.symbolName) {
      const symbols = this.symbolIndex.findSymbols(item.data.symbolName);
      if (symbols.length > 0) {
        const sym = symbols[0];
        if (sym.natspec) {
          const doc: string[] = [];
          if (sym.natspec.notice) doc.push(sym.natspec.notice);
          if (sym.natspec.dev) doc.push(`\n*Dev:* ${sym.natspec.dev}`);
          if (sym.detail) doc.push(`\n\`\`\`solidity\n${sym.detail}\n\`\`\``);
          item.documentation = {
            kind: MarkupKind.Markdown,
            value: doc.join("\n"),
          };
        }
      }
    }
    return item;
  }

  private isInImportPath(textBefore: string): boolean {
    return /import\s+.*["'][^"']*$/.test(textBefore) || /from\s+["'][^"']*$/.test(textBefore);
  }

  private isInNatspecComment(text: string, offset: number): boolean {
    // Walk backward to find if we're in a /// or /** comment
    const before = text.slice(0, offset);
    const lastNewline = before.lastIndexOf("\n");
    const currentLine = before.slice(lastNewline + 1);
    return /^\s*\/\/\//.test(currentLine) || /\/\*\*/.test(currentLine);
  }

  private provideImportCompletions(textBefore: string): CompletionItem[] {
    const items: CompletionItem[] = [];

    // Suggest known contract/library names from the workspace
    for (const [name, entry] of this.symbolIndex.getAllContracts()) {
      items.push({
        label: name,
        kind: CompletionItemKind.Module,
        detail: `from ${entry.uri}`,
      });
    }

    // Suggest common import prefixes from remappings
    for (const r of this.workspace.getRemappings()) {
      items.push({
        label: r.prefix,
        kind: CompletionItemKind.Folder,
        detail: `→ ${r.path}`,
      });
    }

    return items;
  }

  private provideNatspecCompletions(): CompletionItem[] {
    return [
      { label: "@title", kind: CompletionItemKind.Keyword, detail: "Contract title" },
      { label: "@author", kind: CompletionItemKind.Keyword, detail: "Author name" },
      { label: "@notice", kind: CompletionItemKind.Keyword, detail: "Explain to end user" },
      { label: "@dev", kind: CompletionItemKind.Keyword, detail: "Explain to developer" },
      { label: "@param", kind: CompletionItemKind.Keyword, detail: "Document a parameter" },
      { label: "@return", kind: CompletionItemKind.Keyword, detail: "Document return value" },
      { label: "@inheritdoc", kind: CompletionItemKind.Keyword, detail: "Inherit documentation" },
      { label: "@custom:", kind: CompletionItemKind.Keyword, detail: "Custom natspec tag" },
    ];
  }

  private provideMemberCompletions(
    text: string,
    position: Position,
    textBefore: string,
  ): CompletionItem[] {
    const items: CompletionItem[] = [];

    // Extract the expression before the dot
    const dotMatch = textBefore.match(/(\w+)\.\s*$/);
    if (!dotMatch) return items;

    const target = dotMatch[1];

    // Check if it's a known contract/type name → provide its members
    const contract = this.symbolIndex.getContract(target);
    if (contract) {
      const chain = this.symbolIndex.getInheritanceChain(target);
      for (const c of chain) {
        for (const func of c.functions) {
          if (func.name && func.visibility !== "private") {
            items.push({
              label: func.name,
              kind: CompletionItemKind.Method,
              detail: `${func.visibility} ${func.mutability}`,
              data: { symbolName: func.name },
            });
          }
        }
        for (const svar of c.stateVariables) {
          if (svar.visibility === "public") {
            items.push({
              label: svar.name,
              kind: CompletionItemKind.Field,
              detail: svar.typeName,
            });
          }
        }
        for (const event of c.events) {
          items.push({
            label: event.name,
            kind: CompletionItemKind.Event,
          });
        }
        for (const err of c.errors) {
          items.push({
            label: err.name,
            kind: CompletionItemKind.Struct,
            detail: "error",
          });
        }
      }
      return items;
    }

    // Address member completions
    if (this.isAddressLike(target, text)) {
      return this.provideAddressMembers();
    }

    // msg, block, tx globals
    if (target === "msg") return this.provideMsgMembers();
    if (target === "block") return this.provideBlockMembers();
    if (target === "tx") return this.provideTxMembers();
    if (target === "abi") return this.provideAbiMembers();
    if (target === "type") return this.provideTypeMembers();

    return items;
  }

  private provideKeywordCompletions(textBefore: string): CompletionItem[] {
    const keywords = [
      "pragma",
      "import",
      "contract",
      "interface",
      "library",
      "abstract",
      "function",
      "modifier",
      "event",
      "error",
      "struct",
      "enum",
      "mapping",
      "constructor",
      "receive",
      "fallback",
      "public",
      "private",
      "internal",
      "external",
      "pure",
      "view",
      "payable",
      "virtual",
      "override",
      "immutable",
      "constant",
      "memory",
      "storage",
      "calldata",
      "if",
      "else",
      "for",
      "while",
      "do",
      "break",
      "continue",
      "return",
      "try",
      "catch",
      "revert",
      "require",
      "assert",
      "emit",
      "new",
      "delete",
      "type",
      "assembly",
      "unchecked",
      "using",
      "is",
      "as",
    ];

    return keywords.map((kw) => ({
      label: kw,
      kind: CompletionItemKind.Keyword,
    }));
  }

  private provideTypeCompletions(): CompletionItem[] {
    const types = [
      // Value types
      "bool",
      "address",
      "string",
      "bytes",
      "uint8",
      "uint16",
      "uint32",
      "uint64",
      "uint128",
      "uint256",
      "int8",
      "int16",
      "int32",
      "int64",
      "int128",
      "int256",
      "bytes1",
      "bytes2",
      "bytes4",
      "bytes8",
      "bytes16",
      "bytes32",
      // Aliases
      "uint",
      "int",
    ];

    const items: CompletionItem[] = types.map((t) => ({
      label: t,
      kind: CompletionItemKind.TypeParameter,
      detail: "Solidity type",
    }));

    // Add known contracts/interfaces/structs as types
    for (const [name] of this.symbolIndex.getAllContracts()) {
      items.push({
        label: name,
        kind: CompletionItemKind.Class,
        detail: "contract/interface",
      });
    }

    return items;
  }

  private provideSymbolCompletions(uri: string, textBefore: string): CompletionItem[] {
    const fileSymbols = this.symbolIndex.getFileSymbols(uri);
    return fileSymbols.map((sym) => ({
      label: sym.name,
      kind: this.symbolToCompletionKind(sym.kind),
      detail: sym.detail ?? sym.containerName,
      data: { symbolName: sym.name },
    }));
  }

  private provideSnippetCompletions(textBefore: string): CompletionItem[] {
    return [
      {
        label: "function",
        kind: CompletionItemKind.Snippet,
        insertText:
          "function ${1:name}(${2:params}) ${3:public} ${4:returns (${5:type})} {\n\t$0\n}",
        insertTextFormat: InsertTextFormat.Snippet,
        detail: "Function declaration",
      },
      {
        label: "modifier",
        kind: CompletionItemKind.Snippet,
        insertText:
          'modifier ${1:name}(${2:params}) {\n\t${3:require(${4:condition}, "${5:message}");}\n\t_;\n}',
        insertTextFormat: InsertTextFormat.Snippet,
        detail: "Modifier declaration",
      },
      {
        label: "event",
        kind: CompletionItemKind.Snippet,
        insertText: "event ${1:Name}(${2:params});",
        insertTextFormat: InsertTextFormat.Snippet,
        detail: "Event declaration",
      },
      {
        label: "error",
        kind: CompletionItemKind.Snippet,
        insertText: "error ${1:Name}(${2:params});",
        insertTextFormat: InsertTextFormat.Snippet,
        detail: "Custom error declaration",
      },
      {
        label: "struct",
        kind: CompletionItemKind.Snippet,
        insertText: "struct ${1:Name} {\n\t${2:type} ${3:field};\n}",
        insertTextFormat: InsertTextFormat.Snippet,
        detail: "Struct declaration",
      },
      {
        label: "mapping",
        kind: CompletionItemKind.Snippet,
        insertText: "mapping(${1:address} => ${2:uint256}) ${3:public} ${4:name};",
        insertTextFormat: InsertTextFormat.Snippet,
        detail: "Mapping declaration",
      },
      {
        label: "require",
        kind: CompletionItemKind.Snippet,
        insertText: 'require(${1:condition}, "${2:message}");',
        insertTextFormat: InsertTextFormat.Snippet,
        detail: "Require statement",
      },
      {
        label: "ifelse",
        kind: CompletionItemKind.Snippet,
        insertText: "if (${1:condition}) {\n\t$2\n} else {\n\t$3\n}",
        insertTextFormat: InsertTextFormat.Snippet,
        detail: "If-else block",
      },
      {
        label: "forloop",
        kind: CompletionItemKind.Snippet,
        insertText:
          "for (uint256 ${1:i}; ${1:i} < ${2:length}; ${3:unchecked { ++${1:i}; \\}}) {\n\t$0\n}",
        insertTextFormat: InsertTextFormat.Snippet,
        detail: "For loop with unchecked increment",
      },
      {
        label: "test",
        kind: CompletionItemKind.Snippet,
        insertText: "function test_${1:name}() public {\n\t$0\n}",
        insertTextFormat: InsertTextFormat.Snippet,
        detail: "Foundry test function",
      },
      {
        label: "testFuzz",
        kind: CompletionItemKind.Snippet,
        insertText: "function testFuzz_${1:name}(${2:uint256 x}) public {\n\t$0\n}",
        insertTextFormat: InsertTextFormat.Snippet,
        detail: "Foundry fuzz test function",
      },
      {
        label: "setUp",
        kind: CompletionItemKind.Snippet,
        insertText: "function setUp() public {\n\t$0\n}",
        insertTextFormat: InsertTextFormat.Snippet,
        detail: "Foundry setUp function",
      },
    ];
  }

  // ── Global member helpers ─────────────────────────────────────────

  private provideMsgMembers(): CompletionItem[] {
    return [
      { label: "sender", kind: CompletionItemKind.Property, detail: "address" },
      { label: "value", kind: CompletionItemKind.Property, detail: "uint256" },
      { label: "data", kind: CompletionItemKind.Property, detail: "bytes calldata" },
      { label: "sig", kind: CompletionItemKind.Property, detail: "bytes4" },
    ];
  }

  private provideBlockMembers(): CompletionItem[] {
    return [
      { label: "timestamp", kind: CompletionItemKind.Property, detail: "uint256" },
      { label: "number", kind: CompletionItemKind.Property, detail: "uint256" },
      { label: "chainid", kind: CompletionItemKind.Property, detail: "uint256" },
      { label: "coinbase", kind: CompletionItemKind.Property, detail: "address payable" },
      { label: "difficulty", kind: CompletionItemKind.Property, detail: "uint256" },
      { label: "prevrandao", kind: CompletionItemKind.Property, detail: "uint256" },
      { label: "gaslimit", kind: CompletionItemKind.Property, detail: "uint256" },
      { label: "basefee", kind: CompletionItemKind.Property, detail: "uint256" },
      { label: "blobbasefee", kind: CompletionItemKind.Property, detail: "uint256" },
    ];
  }

  private provideTxMembers(): CompletionItem[] {
    return [
      { label: "origin", kind: CompletionItemKind.Property, detail: "address" },
      { label: "gasprice", kind: CompletionItemKind.Property, detail: "uint256" },
    ];
  }

  private provideAbiMembers(): CompletionItem[] {
    return [
      { label: "encode", kind: CompletionItemKind.Method, detail: "(…) → bytes memory" },
      { label: "encodePacked", kind: CompletionItemKind.Method, detail: "(…) → bytes memory" },
      {
        label: "encodeWithSelector",
        kind: CompletionItemKind.Method,
        detail: "(bytes4, …) → bytes memory",
      },
      {
        label: "encodeWithSignature",
        kind: CompletionItemKind.Method,
        detail: "(string, …) → bytes memory",
      },
      {
        label: "encodeCall",
        kind: CompletionItemKind.Method,
        detail: "(function, …) → bytes memory",
      },
      { label: "decode", kind: CompletionItemKind.Method, detail: "(bytes, (types)) → (…)" },
    ];
  }

  private provideTypeMembers(): CompletionItem[] {
    return [
      { label: "name", kind: CompletionItemKind.Property, detail: "string" },
      { label: "creationCode", kind: CompletionItemKind.Property, detail: "bytes memory" },
      { label: "runtimeCode", kind: CompletionItemKind.Property, detail: "bytes memory" },
      { label: "interfaceId", kind: CompletionItemKind.Property, detail: "bytes4" },
      { label: "min", kind: CompletionItemKind.Property, detail: "T" },
      { label: "max", kind: CompletionItemKind.Property, detail: "T" },
    ];
  }

  private provideAddressMembers(): CompletionItem[] {
    return [
      { label: "balance", kind: CompletionItemKind.Property, detail: "uint256" },
      { label: "code", kind: CompletionItemKind.Property, detail: "bytes memory" },
      { label: "codehash", kind: CompletionItemKind.Property, detail: "bytes32" },
      { label: "call", kind: CompletionItemKind.Method, detail: "(bytes) → (bool, bytes memory)" },
      {
        label: "delegatecall",
        kind: CompletionItemKind.Method,
        detail: "(bytes) → (bool, bytes memory)",
      },
      {
        label: "staticcall",
        kind: CompletionItemKind.Method,
        detail: "(bytes) → (bool, bytes memory)",
      },
      { label: "transfer", kind: CompletionItemKind.Method, detail: "(uint256)" },
      { label: "send", kind: CompletionItemKind.Method, detail: "(uint256) → bool" },
    ];
  }

  private isAddressLike(target: string, text: string): boolean {
    // Check symbol index for the variable's type
    const symbols = this.symbolIndex.findSymbols(target);
    for (const sym of symbols) {
      if (sym.detail === "address" || sym.detail === "address payable") return true;
    }
    // Heuristic: common address variable names
    const lowerTarget = target.toLowerCase();
    return (
      lowerTarget.includes("addr") ||
      lowerTarget === "sender" ||
      lowerTarget === "recipient" ||
      lowerTarget === "owner" ||
      lowerTarget === "to" ||
      lowerTarget === "from"
    );
  }

  private symbolToCompletionKind(kind: SymbolKind): CompletionItemKind {
    switch (kind) {
      case "contract":
        return CompletionItemKind.Class;
      case "interface":
        return CompletionItemKind.Interface;
      case "library":
        return CompletionItemKind.Module;
      case "function":
        return CompletionItemKind.Function;
      case "modifier":
        return CompletionItemKind.Method;
      case "event":
        return CompletionItemKind.Event;
      case "error":
        return CompletionItemKind.Struct;
      case "struct":
        return CompletionItemKind.Struct;
      case "enum":
        return CompletionItemKind.Enum;
      case "stateVariable":
        return CompletionItemKind.Field;
      case "localVariable":
        return CompletionItemKind.Variable;
      case "parameter":
        return CompletionItemKind.Variable;
      case "userDefinedValueType":
        return CompletionItemKind.TypeParameter;
    }
  }
}
