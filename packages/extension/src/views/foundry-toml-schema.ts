import * as vscode from "vscode";

/**
 * Foundry.toml IntelliSense — provides completions, hover docs, and
 * validation for foundry.toml configuration files.
 *
 * Coverage:
 *   - [profile.*]      (default + custom named profiles)
 *   - [fmt]            forge-fmt options
 *   - [fuzz]           forge test fuzz configuration
 *   - [invariant]      forge test invariant-testing configuration
 *   - [rpc_endpoints]  named RPC aliases (any key, URL or env-var value)
 *   - [etherscan]      chain-specific Etherscan config (nested `key` / `url`)
 *
 * All hover docs cite the Foundry Book section they come from so users can
 * jump straight to upstream documentation.
 */
export class FoundryTomlProvider implements vscode.CompletionItemProvider {
  activate(context: vscode.ExtensionContext): void {
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

    if (textBefore.trim() === "[" || textBefore.trim() === "[profile.") {
      return this.provideSectionCompletions();
    }

    if (!textBefore.includes("=")) {
      return this.provideKeyCompletions(document, position);
    }

    const key = textBefore.split("=")[0].trim();
    return this.provideValueCompletions(key);
  }

  private provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Hover | null {
    const line = document.lineAt(position).text;
    const trimmed = line.trim();

    // Section header hover
    const sectionMatch = trimmed.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      const section = sectionMatch[1];
      const doc = SECTION_DOCS[section] ?? SECTION_DOCS[section.split(".")[0]];
      if (doc) {
        return new vscode.Hover(
          new vscode.MarkdownString(
            `**\`[${section}]\`**\n\n${doc.description}\n\n*See: [Foundry Book §${doc.bookRef}](${doc.bookUrl})*`,
          ),
        );
      }
    }

    // Key hover
    const key = trimmed.split("=")[0].trim();
    const section = this.getCurrentSection(document, position.line);
    const info = this.lookupKey(section, key);
    if (!info) return null;

    const md = new vscode.MarkdownString(
      `**\`${key}\`**\n\n${info.description}\n\n*Default:* \`${info.default}\`` +
        (info.bookUrl
          ? `\n\n*See: [Foundry Book${info.bookRef ? " §" + info.bookRef : ""}](${info.bookUrl})*`
          : ""),
    );

    return new vscode.Hover(md);
  }

  private provideSectionCompletions(): vscode.CompletionItem[] {
    return Object.entries(SECTION_DOCS).map(([name, doc]) =>
      this.makeSection(name, doc.description),
    );
  }

  private provideKeyCompletions(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionItem[] {
    const section = this.getCurrentSection(document, position.line);

    if (section === "fmt") {
      return Object.entries(FMT_KEYS).map(([key, info]) =>
        this.makeKey(key, info.description, info.default),
      );
    }

    if (section === "fuzz") {
      return Object.entries(FUZZ_KEYS).map(([key, info]) =>
        this.makeKey(key, info.description, info.default),
      );
    }

    if (section === "invariant") {
      return Object.entries(INVARIANT_KEYS).map(([key, info]) =>
        this.makeKey(key, info.description, info.default),
      );
    }

    if (section === "rpc_endpoints") {
      // Arbitrary user-chosen aliases; we still suggest a few defaults.
      return [
        this.makeKey("mainnet", "Ethereum mainnet alias", '"https://eth.llamarpc.com"'),
        this.makeKey("sepolia", "Sepolia testnet alias", '"https://rpc.sepolia.org"'),
        this.makeKey("base", "Base mainnet alias", '"https://mainnet.base.org"'),
        this.makeKey("arbitrum", "Arbitrum One alias", '"https://arb1.arbitrum.io/rpc"'),
        this.makeKey("optimism", "Optimism mainnet alias", '"https://mainnet.optimism.io"'),
        this.makeKey(
          "polygon",
          "Polygon mainnet alias (use env var for paid RPC)",
          '"${POLYGON_RPC}"',
        ),
      ];
    }

    if (section.startsWith("etherscan.") || section === "etherscan") {
      return Object.entries(ETHERSCAN_KEYS).map(([key, info]) =>
        this.makeKey(key, info.description, info.default),
      );
    }

    // Default: profile.* keys (also applies to `[profile.ci]`,
    // `[profile.test]`, etc. — every named profile shares the same schema).
    return Object.entries(PROFILE_KEYS).map(([key, info]) =>
      this.makeKey(key, info.description, info.default),
    );
  }

  private provideValueCompletions(key: string): vscode.CompletionItem[] {
    const info =
      PROFILE_KEYS[key] ??
      FMT_KEYS[key] ??
      FUZZ_KEYS[key] ??
      INVARIANT_KEYS[key] ??
      ETHERSCAN_KEYS[key];
    if (!info?.values) return [];

    return info.values.map((v) => new vscode.CompletionItem(v, vscode.CompletionItemKind.Value));
  }

  private lookupKey(section: string, key: string): KeyInfo | undefined {
    if (section === "fmt") return FMT_KEYS[key];
    if (section === "fuzz") return FUZZ_KEYS[key];
    if (section === "invariant") return INVARIANT_KEYS[key];
    if (section.startsWith("etherscan")) return ETHERSCAN_KEYS[key];
    if (section === "rpc_endpoints") return undefined;
    return PROFILE_KEYS[key];
  }

  private getCurrentSection(document: vscode.TextDocument, line: number): string {
    for (let i = line; i >= 0; i--) {
      const text = document.lineAt(i).text.trim();
      const match = text.match(/^\[(.+)\]$/);
      if (match) {
        // Normalize: `[profile.default]` → `profile.default`, but the key
        // schema for `[profile.ci]`, `[profile.test]`, etc. is identical,
        // so callers should treat any profile.* section as "profile".
        const name = match[1];
        if (name.startsWith("profile.")) return "profile";
        return name;
      }
    }
    return "profile";
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

// ── Schema definitions ───────────────────────────────────────────────

interface KeyInfo {
  description: string;
  default: string;
  values?: string[];
  bookRef?: string;
  bookUrl?: string;
}

interface SectionInfo {
  description: string;
  bookRef: string;
  bookUrl: string;
}

const BOOK = "https://book.getfoundry.sh/reference/config/";

const SECTION_DOCS: Record<string, SectionInfo> = {
  "profile.default": {
    description: "Default build profile — used when no `FOUNDRY_PROFILE` env var is set.",
    bookRef: "Overview",
    bookUrl: `${BOOK}overview`,
  },
  "profile.ci": {
    description:
      "CI build profile. Typically enables verbose output and stricter settings. Activate with `FOUNDRY_PROFILE=ci`.",
    bookRef: "Overview",
    bookUrl: `${BOOK}overview`,
  },
  "profile.test": {
    description: "Test-specific profile. Activate with `FOUNDRY_PROFILE=test`.",
    bookRef: "Overview",
    bookUrl: `${BOOK}overview`,
  },
  profile: {
    description: "Custom named profile. Activate with `FOUNDRY_PROFILE=<name>`.",
    bookRef: "Overview",
    bookUrl: `${BOOK}overview`,
  },
  fmt: {
    description: "Formatter settings — controls how `forge fmt` reshapes your Solidity.",
    bookRef: "Formatter",
    bookUrl: `${BOOK}formatter`,
  },
  fuzz: {
    description: "Fuzz-testing configuration for `forge test` (regular fuzz tests).",
    bookRef: "Testing § Fuzz",
    bookUrl: `${BOOK}testing#fuzz`,
  },
  invariant: {
    description: "Invariant-testing configuration for stateful `forge test` runs.",
    bookRef: "Testing § Invariant",
    bookUrl: `${BOOK}testing#invariant`,
  },
  rpc_endpoints: {
    description:
      "Named RPC endpoints. Values can be literal URLs or env-var references like `${MAINNET_RPC_URL}`. Use the alias from CLI flags (e.g. `forge script --rpc-url mainnet`).",
    bookRef: "Solidity Compiler § rpc_endpoints",
    bookUrl: `${BOOK}solidity-compiler#rpc_endpoints`,
  },
  etherscan: {
    description:
      "Per-chain Etherscan configuration. Each subsection (e.g. `[etherscan.mainnet]`) sets `key` and optionally `url` / `chain` for that chain.",
    bookRef: "Etherscan",
    bookUrl: `${BOOK}etherscan`,
  },
};

const PROFILE_KEYS: Record<string, KeyInfo> = {
  src: { description: "Source directory for contracts", default: '"src"' },
  test: { description: "Directory for test files", default: '"test"' },
  script: { description: "Directory for script files", default: '"script"' },
  out: { description: "Output directory for compiled artifacts", default: '"out"' },
  libs: { description: "Library directories", default: '["lib"]' },
  remappings: {
    description:
      "Import remappings. Auto-detected from `lib/` when not set; values here override auto-detection.",
    default: "[]",
  },
  solc_version: { description: "Solidity compiler version", default: "auto-detect" },
  solc: { description: "Alias for `solc_version`", default: "auto-detect" },
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
  optimizer_runs: {
    description:
      "Optimizer runs parameter (lower = smaller bytecode, higher = cheaper runtime gas)",
    default: "200",
  },
  via_ir: {
    description:
      "Enable the IR-based code generator. Required for some patterns (stack-too-deep fixes).",
    default: "false",
    values: ["true", "false"],
  },
  ffi: {
    description:
      "Allow FFI cheatcodes in tests. Required for some fork/flake tests but widens the attack surface.",
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
  cache: {
    description: "Enable compilation caching",
    default: "true",
    values: ["true", "false"],
  },
  cache_path: { description: "Directory for the compilation cache", default: '"cache"' },
  force: {
    description: "Always recompile (disable the cache)",
    default: "false",
    values: ["true", "false"],
  },
  verbosity: {
    description: "Default verbosity level for `forge test` output (0–5)",
    default: "0",
    values: ["0", "1", "2", "3", "4", "5"],
  },
  deny_warnings: {
    description: "Fail the build on compiler warnings",
    default: "false",
    values: ["true", "false"],
  },
  extra_output: {
    description: 'Extra compiler outputs to request (e.g. `["storageLayout"]`)',
    default: "[]",
  },
  extra_output_files: {
    description: "Extra compiler outputs to write as separate files",
    default: "[]",
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
  override_spacing: {
    description: "Add spaces in `override(a, b)`",
    default: "false",
    values: ["true", "false"],
  },
  wrap_comments: {
    description: "Wrap long single-line comments at `line_length`",
    default: "false",
    values: ["true", "false"],
  },
  ignore: {
    description: "Glob patterns that forge fmt should skip",
    default: "[]",
  },
};

const FUZZ_KEYS: Record<string, KeyInfo> = {
  runs: { description: "Number of fuzz runs per test", default: "256" },
  max_test_rejects: {
    description: "Max inputs rejected by `vm.assume` before the run is marked as failed",
    default: "65536",
  },
  seed: {
    description: "Seed for the fuzzer RNG (hex string, or omit for random)",
    default: "random",
  },
  dictionary_weight: {
    description: "Weight (0–100) given to dictionary-sourced values during generation",
    default: "40",
  },
  include_storage: {
    description: "Include storage slot values as dictionary entries",
    default: "true",
    values: ["true", "false"],
  },
  include_push_bytes: {
    description: "Include PUSH bytes from bytecode as dictionary entries",
    default: "true",
    values: ["true", "false"],
  },
  max_fuzz_dictionary_addresses: {
    description: "Max number of addresses to keep in the fuzz dictionary",
    default: "15728640",
  },
  max_fuzz_dictionary_values: {
    description: "Max number of values to keep in the fuzz dictionary",
    default: "6553600",
  },
  failure_persist_dir: {
    description: "Directory to store reproducer files for failing fuzz runs",
    default: '"cache/fuzz"',
  },
  failure_persist_file: {
    description: "File name pattern for reproducer files",
    default: '"failures"',
  },
};

const INVARIANT_KEYS: Record<string, KeyInfo> = {
  runs: { description: "Number of invariant runs", default: "256" },
  depth: { description: "Number of function calls per run", default: "500" },
  fail_on_revert: {
    description: "Fail the run if any handler call reverts",
    default: "false",
    values: ["true", "false"],
  },
  call_override: {
    description: "Allow overriding function calls by selector during fuzzing",
    default: "false",
    values: ["true", "false"],
  },
  dictionary_weight: {
    description: "Weight (0–100) given to dictionary-sourced values during generation",
    default: "80",
  },
  include_storage: {
    description: "Include storage slot values as dictionary entries",
    default: "true",
    values: ["true", "false"],
  },
  include_push_bytes: {
    description: "Include PUSH bytes from bytecode as dictionary entries",
    default: "true",
    values: ["true", "false"],
  },
  shrink_run_limit: {
    description: "Max number of reductions when minimizing a failing sequence",
    default: "5000",
  },
  max_assume_rejects: {
    description: "Max `vm.assume` rejects before a run is marked as failed",
    default: "65536",
  },
  gas_report_samples: {
    description: "Number of samples to keep for the invariant gas report",
    default: "256",
  },
};

const ETHERSCAN_KEYS: Record<string, KeyInfo> = {
  key: {
    description: "Etherscan API key. Literal or env-var reference (`${ETHERSCAN_API_KEY}`).",
    default: "(required)",
  },
  url: {
    description:
      "Custom Etherscan-compatible API URL. Only needed for non-default explorers (Blockscout, Snowtrace, etc.).",
    default: "chain default",
  },
  chain: {
    description:
      "Chain ID or name this key targets. Pairs with `key` so `forge verify-contract --chain <this>` finds the right credentials.",
    default: "inferred from section name",
  },
};
