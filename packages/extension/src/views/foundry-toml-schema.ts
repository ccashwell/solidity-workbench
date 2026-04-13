import * as vscode from "vscode";

/**
 * Foundry.toml IntelliSense — provides completions, hover docs, and
 * validation for foundry.toml configuration files.
 *
 * Since foundry.toml uses TOML format, we register a completion provider
 * for TOML files named "foundry.toml" and provide context-aware suggestions.
 */
export class FoundryTomlProvider implements vscode.CompletionItemProvider {
  activate(context: vscode.ExtensionContext): void {
    // Register for TOML files, but filter to foundry.toml in the provider
    context.subscriptions.push(
      vscode.languages.registerCompletionItemProvider(
        { pattern: "**/foundry.toml" },
        this,
        "=",
        "[",
        ".",
      ),
    );

    context.subscriptions.push(
      vscode.languages.registerHoverProvider(
        { pattern: "**/foundry.toml" },
        {
          provideHover: (doc, pos) => this.provideHover(doc, pos),
        },
      ),
    );
  }

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionItem[] {
    const line = document.lineAt(position).text;
    const textBefore = line.slice(0, position.character);

    // Section headers
    if (textBefore.trim() === "[" || textBefore.trim() === "[profile.") {
      return this.provideSectionCompletions();
    }

    // Key completions
    if (!textBefore.includes("=")) {
      return this.provideKeyCompletions(document, position);
    }

    // Value completions (after =)
    const key = textBefore.split("=")[0].trim();
    return this.provideValueCompletions(key);
  }

  private provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Hover | null {
    const line = document.lineAt(position).text;
    const key = line.split("=")[0].trim();
    const doc = FOUNDRY_KEYS[key];
    if (!doc) return null;

    return new vscode.Hover(
      new vscode.MarkdownString(
        `**${key}**\n\n${doc.description}\n\n*Default:* \`${doc.default}\``,
      ),
    );
  }

  private provideSectionCompletions(): vscode.CompletionItem[] {
    return [
      this.makeSection("profile.default", "Default build profile"),
      this.makeSection("profile.ci", "CI build profile (typically stricter)"),
      this.makeSection("profile.test", "Test-specific profile"),
      this.makeSection("fmt", "Formatter settings"),
      this.makeSection("rpc_endpoints", "Named RPC endpoint aliases"),
      this.makeSection("etherscan", "Etherscan API key configuration"),
      this.makeSection("fuzz", "Fuzz testing configuration"),
      this.makeSection("invariant", "Invariant testing configuration"),
    ];
  }

  private provideKeyCompletions(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionItem[] {
    // Determine which section we're in
    const section = this.getCurrentSection(document, position.line);

    if (section.startsWith("fmt")) {
      return Object.entries(FMT_KEYS).map(([key, info]) =>
        this.makeKey(key, info.description, info.default),
      );
    }

    if (section.startsWith("fuzz")) {
      return [
        this.makeKey("runs", "Number of fuzz runs", "256"),
        this.makeKey("max_test_rejects", "Max inputs rejected before failure", "65536"),
        this.makeKey("seed", "Seed for the fuzzer RNG", "random"),
        this.makeKey("dictionary_weight", "Weight for dictionary values", "40"),
      ];
    }

    if (section.startsWith("invariant")) {
      return [
        this.makeKey("runs", "Number of invariant runs", "256"),
        this.makeKey("depth", "Number of calls per run", "15"),
        this.makeKey("fail_on_revert", "Fail if any call reverts", "false"),
        this.makeKey("call_override", "Allow function call overrides", "false"),
      ];
    }

    // Default profile keys
    return Object.entries(FOUNDRY_KEYS).map(([key, info]) =>
      this.makeKey(key, info.description, info.default),
    );
  }

  private provideValueCompletions(key: string): vscode.CompletionItem[] {
    const info = FOUNDRY_KEYS[key] ?? FMT_KEYS[key];
    if (!info?.values) return [];

    return info.values.map((v) => {
      const item = new vscode.CompletionItem(v, vscode.CompletionItemKind.Value);
      return item;
    });
  }

  private getCurrentSection(document: vscode.TextDocument, line: number): string {
    for (let i = line; i >= 0; i--) {
      const text = document.lineAt(i).text.trim();
      const match = text.match(/^\[(.+)\]$/);
      if (match) return match[1];
    }
    return "profile.default";
  }

  private makeSection(name: string, description: string): vscode.CompletionItem {
    const item = new vscode.CompletionItem(`[${name}]`, vscode.CompletionItemKind.Module);
    item.detail = description;
    item.insertText = `${name}]\n`;
    return item;
  }

  private makeKey(key: string, description: string, defaultVal: string): vscode.CompletionItem {
    const item = new vscode.CompletionItem(key, vscode.CompletionItemKind.Property);
    item.detail = `Default: ${defaultVal}`;
    item.documentation = new vscode.MarkdownString(description);
    item.insertText = `${key} = `;
    return item;
  }
}

interface KeyInfo {
  description: string;
  default: string;
  values?: string[];
}

const FOUNDRY_KEYS: Record<string, KeyInfo> = {
  src: { description: "Source directory for contracts", default: '"src"' },
  test: { description: "Directory for test files", default: '"test"' },
  script: { description: "Directory for script files", default: '"script"' },
  out: { description: "Output directory for compiled artifacts", default: '"out"' },
  libs: { description: "Library directories", default: '["lib"]' },
  remappings: { description: "Import remappings", default: "[]" },
  solc_version: { description: "Solidity compiler version", default: "auto-detect" },
  evm_version: {
    description: "Target EVM version",
    default: '"cancun"',
    values: ['"cancun"', '"shanghai"', '"paris"', '"london"', '"berlin"', '"istanbul"'],
  },
  optimizer: {
    description: "Enable the Solidity optimizer",
    default: "false",
    values: ["true", "false"],
  },
  optimizer_runs: { description: "Optimizer runs parameter", default: "200" },
  via_ir: {
    description: "Enable the IR-based code generator",
    default: "false",
    values: ["true", "false"],
  },
  ffi: {
    description: "Allow FFI cheatcodes in tests",
    default: "false",
    values: ["true", "false"],
  },
  gas_reports: { description: "Contracts to generate gas reports for", default: '["*"]' },
  gas_limit: { description: "Gas limit for tests", default: "9223372036854775807" },
  block_timestamp: { description: "Block timestamp for tests", default: "1" },
  block_number: { description: "Block number for tests", default: "1" },
  chain_id: { description: "Chain ID for tests", default: "31337" },
  sender: {
    description: "Default msg.sender for tests",
    default: '"0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38"',
  },
  tx_origin: {
    description: "Default tx.origin for tests",
    default: '"0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38"',
  },
  fs_permissions: { description: "Filesystem access permissions for tests", default: "[]" },
  auto_detect_solc: {
    description: "Auto-detect solc version from pragmas",
    default: "true",
    values: ["true", "false"],
  },
  auto_detect_remappings: {
    description: "Auto-detect import remappings",
    default: "true",
    values: ["true", "false"],
  },
};

const FMT_KEYS: Record<string, KeyInfo> = {
  line_length: { description: "Maximum line length", default: "120" },
  tab_width: { description: "Indentation width in spaces", default: "4" },
  bracket_spacing: {
    description: "Add spaces inside brackets",
    default: "false",
    values: ["true", "false"],
  },
  int_types: {
    description: "How to format integer types",
    default: '"long"',
    values: ['"long"', '"short"', '"preserve"'],
  },
  multiline_func_header: {
    description: "How to format multiline function headers",
    default: '"attributes_first"',
    values: ['"attributes_first"', '"params_first"', '"all"'],
  },
  quote_style: {
    description: "String quote style",
    default: '"double"',
    values: ['"double"', '"single"'],
  },
  number_underscore: {
    description: "Number underscore formatting",
    default: '"preserve"',
    values: ['"preserve"', '"thousands"', '"remove"'],
  },
  single_line_statement_blocks: {
    description: "Single-line statement block formatting",
    default: '"preserve"',
    values: ['"preserve"', '"single"', '"multi"'],
  },
  sort_imports: {
    description: "Sort import statements",
    default: "false",
    values: ["true", "false"],
  },
};
