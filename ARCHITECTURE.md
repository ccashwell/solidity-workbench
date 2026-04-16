# Solidity Workbench: A Modern Solidity IDE Plugin for VSCode/Cursor

## Vision

Deliver **Java/TypeScript-level** IDE support for Solidity, purpose-built for
modern Foundry-based workflows. No legacy Hardhat/Truffle baggage. A daily-driver
for protocol engineers who live in Solidity.

## Why Build This

### The Current Landscape is Mediocre

| Feature | Juan Blanco | Nomic Foundation | tintinweb Visual Auditor |
|---|---|---|---|
| Syntax Highlighting | TextMate (regex) | TextMate (regex) | TextMate + overlays |
| Go-to-Definition | Partial, fragile | Good (LSP-backed) | No |
| Find References | No | Partial | No |
| Rename Symbol | No | No | No |
| Semantic Tokens | No | Partial | No |
| Completions | Basic keywords | Context-aware | No |
| Code Actions | No | Some | No |
| Foundry Integration | Minimal | No (Hardhat-first) | No |
| Test Runner | No | No | No |
| Debugger | No | No | No |
| Inline Diagnostics | solc errors | solc errors + custom | No |
| Formatting | Via solhint | Via prettier-solidity | No |
| Inlay Hints | No | No | No |
| Call Hierarchy | No | No | No |
| Type Hierarchy | No | No | No |

### What "Major Language Support" Means

TypeScript and Java developers take these for granted:

- **IntelliSense**: Context-aware completions showing types, docs, signatures
- **Navigation**: Reliable go-to-definition, find references, peek definition — across files, libraries, interfaces
- **Refactoring**: Rename symbol, extract function/modifier, implement interface
- **Diagnostics**: Real-time error reporting with quick-fix code actions
- **Semantic Highlighting**: Token-level coloring by role (storage var vs. local, modifier vs. function, etc.)
- **Inlay Hints**: Inline type annotations, parameter names, gas estimates
- **Code Lens**: Inline test results, natspec previews, inheritance info
- **Test Explorer**: Visual test tree with run/debug per test, inline pass/fail
- **Debugger**: Step through transactions with variable inspection
- **Formatting**: Opinionated auto-formatting integrated into save
- **Workspace Intelligence**: Understanding of the build system, imports, remappings

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    VSCode / Cursor Extension                 │
│                   (TypeScript - Extension Host)               │
│                                                              │
│  ┌────────────┐  ┌────────────┐  ┌────────────────────────┐ │
│  │  Foundry   │  │   Test     │  │   Static Analysis      │ │
│  │  Commands  │  │  Explorer  │  │   Panel                │ │
│  │  & Tasks   │  │  & Runner  │  │   (slither/mythril)    │ │
│  └────────────┘  └────────────┘  └────────────────────────┘ │
│                                                              │
│  ┌────────────┐  ┌────────────┐  ┌────────────────────────┐ │
│  │  Gas       │  │  Contract  │  │   Anvil / Cast         │ │
│  │  Profiler  │  │  Flattener │  │   Integration          │ │
│  └────────────┘  └────────────┘  └────────────────────────┘ │
│                                                              │
│  ┌──────────────────────────────────────────────────────────┐│
│  │              LSP Client (vscode-languageclient)          ││
│  └──────────────────────────────────────────────────────────┘│
└──────────────────────────┬───────────────────────────────────┘
                           │ LSP Protocol (JSON-RPC over stdio)
                           │
┌──────────────────────────┴───────────────────────────────────┐
│                     Solidity Workbench LSP Server                       │
│                      (TypeScript / Node)                      │
│                                                              │
│  ┌──────────────────────────────────────────────────────────┐│
│  │                  Workspace Manager                        ││
│  │  - foundry.toml parsing & watching                        ││
│  │  - Remappings resolution (foundry.toml + remappings.txt)  ││
│  │  - Dependency graph (node_modules, lib/)                  ││
│  │  - File watcher for incremental updates                   ││
│  └──────────────────────────────────────────────────────────┘│
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐ │
│  │   Parser     │  │   Semantic   │  │    Compiler        │ │
│  │   & AST      │  │   Analyzer   │  │    Bridge          │ │
│  │              │  │              │  │                    │ │
│  │ - @solidity- │  │ - Type       │  │ - solc invocation  │ │
│  │   parser/    │  │   resolution │  │ - forge build      │ │
│  │   antlr4     │  │ - Scope      │  │ - AST from solc    │ │
│  │ - Incremental│  │   analysis   │  │   --ast-compact-   │ │
│  │   parsing    │  │ - Symbol     │  │   json             │ │
│  │ - Error      │  │   table      │  │ - Diagnostic       │ │
│  │   recovery   │  │ - Natspec    │  │   mapping          │ │
│  │              │  │   extraction │  │                    │ │
│  └──────────────┘  └──────────────┘  └────────────────────┘ │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐ │
│  │  Completion  │  │   Code       │  │   Formatting       │ │
│  │  Provider    │  │   Actions    │  │   (forge fmt)      │ │
│  │              │  │              │  │                    │ │
│  │ - Contract   │  │ - Implement  │  │ - On save          │ │
│  │   members    │  │   interface  │  │ - On paste         │ │
│  │ - Import     │  │ - Add        │  │ - Range format     │ │
│  │   suggest    │  │   override   │  │                    │ │
│  │ - Pragma     │  │ - Add        │  │                    │ │
│  │   versions   │  │   visibility │  │                    │ │
│  │ - Snippets   │  │ - Fix import │  │                    │ │
│  └──────────────┘  └──────────────┘  └────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
           │                    │                  │
    ┌──────┴──────┐    ┌───────┴───────┐   ┌──────┴──────┐
    │    solc     │    │    forge      │   │   slither   │
    │  (compiler) │    │  (build/test) │   │  (analysis) │
    └─────────────┘    └───────────────┘   └─────────────┘
```

## Key Design Decisions

### 1. TypeScript LSP Server (not Rust — yet)

**Rationale**: Ship fast, iterate fast. The `vscode-languageserver` library is
mature, `@solidity-parser/parser` gives us an ANTLR4-based Solidity AST, and
solc's `--ast-compact-json` provides the type-resolved AST for deeper analysis.

**Future**: Hot paths (parsing, symbol resolution on large monorepos) can be
moved to Rust/WASM modules. tower-lsp + tree-sitter-solidity is the natural
Rust stack if we need it.

### 2. Forge as Primary Compilation Backend

Instead of shelling out to raw `solc`, we use `forge build --json` as
the compilation driver. This means:

- Automatic solc version management (forge handles it)
- Correct remappings resolution
- Library linking handled
- Same compilation as the developer's actual build

We fall back to direct `solc` for rapid single-file diagnostics during editing
(faster feedback loop than a full forge build).

### 3. Dual-AST Strategy

- **Fast AST** (`@solidity-parser/parser`): For real-time features like
  completions, syntax highlighting, basic navigation. Tolerant of errors,
  fast enough for keystroke-level updates.
  
- **Rich AST** (`solc --ast-compact-json` via forge): For type-resolved
  features like accurate go-to-definition across contracts, find all
  references, rename. Updated on save or on debounced idle.

### 4. Foundry-Native, Not Foundry-Optional

Every feature assumes Foundry. The test explorer speaks `forge test`.
Formatting uses `forge fmt`. Gas snapshots use `forge snapshot`.
Script execution uses `forge script`. This isn't a generic Solidity
extension that also supports Foundry — it's a Foundry extension that
deeply understands Solidity.

## Feature Roadmap

### Phase 1: Foundation (MVP)
- [x] VSCode extension scaffold
- [x] LSP server with basic lifecycle
- [ ] Syntax highlighting (TextMate grammar + semantic tokens)
- [ ] Diagnostics from forge build
- [ ] Go-to-definition (within file, then cross-file)
- [ ] Hover information (types, natspec)
- [ ] Basic completions (keywords, contract members)
- [ ] `forge fmt` integration
- [ ] `foundry.toml` awareness

### Phase 2: Intelligence
- [ ] Cross-file go-to-definition with remappings
- [ ] Find all references
- [ ] Rename symbol
- [ ] Workspace symbols
- [ ] Signature help
- [ ] Import auto-completion and auto-import
- [ ] Inlay hints (types, parameter names)
- [ ] Document symbols / outline

### Phase 3: Foundry Power Tools
- [ ] Test Explorer (tree view of test contracts/functions)
- [ ] Inline test run/debug via code lens
- [ ] Test output panel with stack traces
- [ ] Gas snapshot tracking & comparison
- [ ] `forge coverage` visualization
- [ ] `forge script` runner
- [ ] Anvil management (start/stop/fork)
- [ ] Cast command palette integration

### Phase 4: Deep Analysis
- [ ] Slither integration (inline findings)
- [ ] Custom linting rules (beyond solhint)
- [ ] Reentrancy detection highlighting
- [ ] Storage layout visualization
- [ ] Call graph / inheritance graph
- [ ] Bytecode size tracking per contract

### Phase 5: Debug & Deploy
- [ ] Transaction debugger (step through EVM execution)
- [ ] Variable inspection during debug
- [ ] Breakpoints in Solidity source
- [ ] Deploy workflow (forge create / forge script)
- [ ] Etherscan verification integration

## Project Structure

```
solidity-workbench/
├── packages/
│   ├── extension/          # VSCode extension (client-side)
│   │   ├── src/
│   │   │   ├── extension.ts         # Activation, LSP client setup
│   │   │   ├── commands/            # Foundry commands, cast, anvil
│   │   │   ├── test-explorer/       # Test tree provider, runner
│   │   │   ├── views/               # Custom webview panels
│   │   │   └── config.ts            # Extension settings
│   │   ├── syntaxes/                # TextMate grammars
│   │   ├── package.json             # Extension manifest
│   │   └── tsconfig.json
│   │
│   ├── server/             # LSP server
│   │   ├── src/
│   │   │   ├── server.ts            # Server entry, capability registration
│   │   │   ├── workspace/           # Workspace manager, foundry.toml, remappings
│   │   │   ├── parser/              # Solidity parser, AST utilities
│   │   │   ├── analyzer/            # Semantic analysis, symbol table, scopes
│   │   │   ├── providers/           # LSP feature providers
│   │   │   │   ├── completion.ts
│   │   │   │   ├── definition.ts
│   │   │   │   ├── hover.ts
│   │   │   │   ├── references.ts
│   │   │   │   ├── diagnostics.ts
│   │   │   │   ├── semantic-tokens.ts
│   │   │   │   ├── code-actions.ts
│   │   │   │   ├── formatting.ts
│   │   │   │   └── inlay-hints.ts
│   │   │   └── compiler/            # solc/forge compilation bridge
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── common/             # Shared types and utilities
│       ├── src/
│       │   ├── types.ts             # Shared Solidity AST types
│       │   ├── foundry-config.ts    # foundry.toml schema
│       │   └── protocol.ts          # Custom LSP extensions
│       ├── package.json
│       └── tsconfig.json
│
├── syntaxes/
│   └── solidity.tmLanguage.json     # TextMate grammar
│
├── test/
│   ├── fixtures/                    # Sample Solidity projects for testing
│   └── suite/                       # Extension integration tests
│
├── package.json                     # Root workspace config
├── tsconfig.json                    # Root TypeScript config
└── ARCHITECTURE.md                  # This document
```

## Technology Stack

| Component | Technology | Rationale |
|---|---|---|
| Extension Host | TypeScript | VSCode standard |
| LSP Server | TypeScript (Node.js) | Fast iteration, mature LSP libraries |
| Parser (fast) | @solidity-parser/parser | ANTLR4-based, error-tolerant, MIT |
| Parser (rich) | solc --ast-compact-json | Full type resolution from compiler |
| Build System | forge | Foundry-native compilation |
| Formatter | forge fmt | Foundry-native formatting |
| Test Runner | forge test --json | Structured test output |
| Static Analysis | slither (optional) | Industry-standard Solidity analyzer |
| Package Manager | pnpm | Monorepo workspace support |
| Bundler | esbuild | Fast extension bundling |

## Comparison to Building on Existing Work

### Why not fork Nomic Foundation's solidity-ls?

Their LSP is good but deeply entangled with Hardhat assumptions. The workspace
model assumes hardhat.config, the compilation pipeline assumes Hardhat's solc
management, and the project structure assumes Hardhat conventions. Ripping that
out and replacing it with Foundry would be more work than building the Foundry
parts from scratch with a clean architecture.

### Why not extend Juan Blanco's extension?

It's not LSP-based — the language features are implemented directly in the
extension host. This makes it impossible to use outside VSCode and limits the
architecture. The codebase has significant technical debt from years of
incremental additions.

### What we can reuse

- **TextMate grammar**: The Solidity TextMate grammar is well-established. We
  can start with an existing one and enhance it for semantic tokens.
- **@solidity-parser/parser**: The ANTLR4-based parser is solid, maintained,
  and provides the fast-path AST we need.
- **solc compiler interface**: We use solc's JSON I/O for rich AST and diagnostics.
- **Tree-sitter grammar**: tree-sitter-solidity can be used for incremental
  parsing if we need it later.

## Extended Competitive Landscape (April 2026)

Beyond the three main extensions compared above, recent research reveals:

### Notable Projects

| Project | Approach | Strengths | Status |
|---|---|---|---|
| **Solar (Paradigm)** | Rust-based Solidity compiler | 40x faster than solc, full parsing + type resolution, rust-analyzer-inspired architecture | LSP tracking issue has 0/6 subtasks done |
| **Ackee Wake / Tools for Solidity** | Python-based framework | LSP features, Remix-like local deployment, Anvil integration | Active, auditor-focused |
| **Simbolik (Runtime Verification)** | Commercial debugger | Source-level + time-travel debugging, Foundry test explorer, fuzzing | Most capable debugger, commercial |
| **Aderyn (Cyfrin)** | Rust-based static analyzer | Real-time vulnerability detection, uses `foundry-compilers` crate | Active, growing |
| **solc --lsp** | Built into solc compiler | Official, has semantic highlighting | Proof-of-concept quality, development slowed |

### The Solar Opportunity

Paradigm's Solar compiler (`paradigmxyz/solar`) is the most architecturally
promising foundation for a Solidity LSP. It's:
- Written in Rust with a modular crate design
- 40x faster than solc for parsing and ABI generation
- Has full Solidity 0.8.x parsing + Yul support + working type resolution
- Architecturally inspired by rust-analyzer (Salsa-like incremental computation)

However, their LSP effort is very early (draft PR, 0/6 tracked subtasks as of
April 2026). This creates a strategic opportunity:

1. **Short-term**: Build on TypeScript + `@solidity-parser/parser` for fast iteration
2. **Medium-term**: Integrate Solar's Rust crates via WASM or native addon for
   parsing and type resolution (replacing our regex-based extractor)
3. **Long-term**: Contribute to or build on Solar's LSP when it matures

### The 10 Biggest Gaps We're Filling

1. **No refactoring support** in any existing extension (extract function, inline, rename)
2. **No semantic highlighting** in mainstream extensions (Nomic, JuanBlanco)
3. **No inlay hints** — zero extensions show parameter names or inferred types
4. **No call hierarchy** — cannot trace incoming/outgoing call chains
5. **No signature help** — no parameter hints during function calls
6. **No integrated debugger** in main extensions (Simbolik is separate + commercial)
7. **Fragmented test runner** — multiple beta-quality community extensions
8. **No workspace symbol search** across the project
9. **Foundry support is "experimental"** in the best LSP (Nomic Foundation)
10. **No `forge script` / `cast` / `anvil` integration** in any extension
