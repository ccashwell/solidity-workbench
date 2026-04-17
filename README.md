# Solidity Workbench

**Foundry-native Solidity IDE for VS Code and Cursor.**

An LSP-powered extension that gives Solidity the IDE experience that languages like TypeScript
and Rust take for granted: reliable navigation, real refactoring, semantic highlighting,
call hierarchy, auto-imports, integrated testing, gas profiling, coverage overlays, static
analysis, and deep Foundry toolchain integration — in a single extension.

## Table of contents

- [Why Solidity Workbench?](#why-solidity-workbench)
- [Feature overview](#feature-overview)
- [Comparison with existing extensions](#comparison-with-existing-extensions)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Language features in depth](#language-features-in-depth)
- [Foundry integration](#foundry-integration)
- [Static analysis](#static-analysis)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Development](#development)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## Why Solidity Workbench?

The three mainstream Solidity extensions each leave meaningful gaps:

| Extension | Strength | Gap |
| --- | --- | --- |
| **JuanBlanco Solidity** (1.8M installs) | Broad framework support, mature ecosystem | No LSP, no rename, no call hierarchy, no test explorer, Foundry is not a first-class citizen |
| **Nomic Foundation** (~412k installs) | LSP-backed, strong Hardhat integration | Foundry marked *experimental*; no call/type hierarchy, inlay hints, signature help, code lens, test explorer, or gas tools |
| **Ackee Wake** (~44k installs) | Security-focused, call graphs, detectors | Requires Python runtime (`eth-wake`); limited forge script/deploy/gas/coverage tooling |

Solidity Workbench is built for teams that already live in Foundry. Every feature assumes
`forge`, `cast`, `anvil`, and `chisel` exist on PATH — no Hardhat compatibility layer, no
Python runtime dependency.

---

## Feature overview

### Language intelligence (17 LSP providers)

| Feature | Implementation |
| --- | --- |
| Semantic syntax highlighting | 20 token types, 10 modifiers, AST-driven |
| Go-to definition / type definition | Cross-file, remapping-aware, solc-enriched overload disambiguation |
| Find all references | Inverted index with O(1) lookup |
| Rename symbol | Workspace-wide for top-level names; scope-aware via solc AST for locals/parameters |
| Hover | Signatures, NatSpec, built-in globals, solc-backed disambiguation |
| Autocompletion | Context-aware: members, keywords, types, snippets, imports, NatSpec tags |
| Auto-import | Code actions for `forge-std/...`, OpenZeppelin, relative paths |
| Signature help | Parameter hints with NatSpec docs, overload switching, built-ins |
| Inlay hints | Parameter name hints at call sites |
| Document / workspace symbols | Outline, Go to Symbol, Quick Open |
| Formatting | Backed by `forge fmt` — full document and range |
| Code actions | Add SPDX, replace `tx.origin`, implement interface, NatSpec stub, auto-import |
| Code lens | Run Test / Debug, function selectors, event `topic0`, reference counts, gas estimates |
| Call hierarchy | Incoming/outgoing with receiver-qualifier disambiguation |
| Type hierarchy | Supertypes and subtypes across the `is` graph |
| Diagnostics | Fast parser + linter on keystroke; full `forge build --json` on save |

### Built-in linter (8 rules)

AST-based rules run on every keystroke with zero false positives on commented-out code.
Suppressible with `// solidity-workbench-disable-next-line [rule]`:

- `reentrancy` — state writes after external calls (CEI violation)
- `unchecked-call` — `.call(...)` without success check
- `dangerous-delegatecall` — any `.delegatecall(...)`
- `unprotected-selfdestruct` — `selfdestruct` with no access control
- `missing-zero-check` — address params not checked against `address(0)`
- `missing-event` — state-changing functions that emit no events
- `large-literal` — magic numbers that should be named constants
- `storage-in-loop` — storage reads inside `for`/`while`

### Foundry toolchain

| Command | Runs |
| --- | --- |
| Build | `forge build` |
| Run Tests / Test File / Test at Cursor | `forge test` with match flags |
| Test Explorer | Tree view, pass/fail, fuzz counterexamples, inline gas |
| Format | `forge fmt` (on-save supported) |
| Gas Snapshot | `forge snapshot` with inline decorations and regression deltas |
| Coverage | `forge coverage --report lcov` with line-level gutter decorations |
| Flatten | `forge flatten` |
| Storage Layout | Interactive webview via `forge inspect` |
| Script: Simulate / Broadcast / Resume | `forge script` with Ledger / Keystore / Interactive signing |
| Deploy Contract | Guided `forge create` with typed constructor args and verification |
| Verify / Check Verification | `forge verify-contract` / `forge verify-check` |
| Debug Test / Script / Transaction | `forge test --debug` / `forge debug` in terminal |

### Cast, Anvil, and Chisel

- **Anvil**: Start / stop / fork from any RPC with optional block pin; status in the status bar
- **Cast**: `sig`, `4byte`, `calldata-decode`, `abi-encode`, `keccak`, `to-wei`, `from-wei`, `balance`, `storage`
- **Chisel**: Start a REPL (fresh or forked), send editor selection directly to it

### `foundry.toml` IntelliSense

Completions, hover docs, and value validation for `[profile.default]`, `[fmt]`, `[fuzz]`,
`[invariant]`, `[rpc_endpoints]`, and `[etherscan]` keys.

### Static analysis

- **Built-in linter** — 8 AST-based rules in the LSP (see above)
- **Slither** (optional) — findings surfaced as VS Code diagnostics with severity mapping; auto-runs on save when enabled

### Gas profiling and coverage

- `.gas-snapshot` tree view grouped by contract, with regression deltas (up/down/unchanged) against previous baseline
- Inline gas decorations next to every test function
- Line-level coverage via LCOV — covered / uncovered / partial gutter decorations; per-file totals in the status bar

---

## Comparison with existing extensions

Accurate as of April 2026. Entries verified against each extension's published documentation and marketplace listing.

| Capability | Solidity Workbench | JuanBlanco | Nomic Foundation | Ackee Wake |
| --- | --- | --- | --- | --- |
| Architecture | LSP (TypeScript) | In-process (TS) | LSP (TypeScript) | LSP (Python) |
| Foundry support | **Native** | Generic remappings | Experimental | Yes |
| Hardhat support | No (by design) | Yes | **Native** | Yes |
| Go-to definition | Yes | Yes | Yes | Yes |
| Find references | Yes | Yes | Yes | Yes |
| Rename symbol | Yes | No | Yes | Yes |
| Semantic tokens | **Yes** (20 types) | No | Partial | Yes |
| Inlay hints | **Yes** | No | No | No |
| Signature help | **Yes** | No | No | Yes |
| Call hierarchy | **Yes** | No | No | Partial |
| Type hierarchy | **Yes** | No | No | Yes |
| Auto-import | **Yes** | No | No | Yes |
| Code lens (selectors, refs, gas) | **Yes** | Partial | No | Partial |
| Built-in security linter | **Yes** (8 rules) | No | No | Yes (Wake) |
| Slither integration | **Yes** | No | No | No |
| Test Explorer | **Yes** | No | No | Partial |
| Forge script runner | **Yes** | No | No | No |
| `forge create` / verify UI | **Yes** | No | No | No |
| Anvil / Chisel commands | **Yes** | No | No | Yes (Anvil) |
| Storage layout webview | **Yes** | No | No | Yes |
| Gas snapshot UI | **Yes** | No | No | No |
| Coverage visualization | **Yes** (line-level) | No | No | No |
| `foundry.toml` IntelliSense | **Yes** | No | No | No |
| Runtime dependencies | Node 18+ | Node 18+ | Node 18+ | Python 3.8+ |
| Marketplace installs | Pre-release | ~1.8M | ~412k | ~44k |

---

## Requirements

- **VS Code** >= 1.85.0 (or Cursor on the same engine)
- **Foundry** on PATH — install via [foundryup](https://getfoundry.sh):
  ```bash
  curl -L https://foundry.paradigm.xyz | bash
  foundryup
  ```
- **Slither** (optional) — only if `solidity-workbench.slither.enabled` is set to `true`

Node.js >= 18 is required only when building from source. The packaged VSIX bundles its own server.

The extension activates automatically in any workspace containing `foundry.toml` or `*.sol` files.

---

## Installation

> Solidity Workbench is pre-release. Install from a CI-built VSIX or from source.

### From VSIX

1. Download `solidity-workbench-*.vsix` from the latest
   [CI build artifacts](https://github.com/uniswap/solidity-workbench/actions/workflows/ci.yml).
2. Install:
   ```
   Cmd/Ctrl+Shift+P → Extensions: Install from VSIX...
   ```

### From source

```bash
git clone https://github.com/uniswap/solidity-workbench
cd solidity-workbench
pnpm install
pnpm build
```

Press `F5` in VS Code to launch an Extension Development Host with the extension loaded.

---

## Quick start

1. Open a Foundry project (must contain `foundry.toml`).
2. Open any `.sol` file — the extension activates, indexes the workspace, and runs `forge build`.
3. Try:
   - **Hover** a symbol for its signature and NatSpec
   - **`F12`** on an import path to jump to the resolved file
   - **`Shift+F12`** for Find All References
   - **`F2`** to rename (workspace-wide or scope-aware for locals)
   - **`Ctrl+Space`** inside a function call for signature help
   - Click **Run Test** in the code lens above any `test_*` function
   - **`Cmd/Ctrl+Shift+P`** → *Solidity Workbench: Gas Snapshot* for inline gas
   - **`Cmd/Ctrl+Shift+P`** → *Solidity Workbench: Run Coverage* for line-level decorations
   - **`Cmd/Ctrl+Shift+P`** → *Solidity Workbench: Storage Layout Visualization* for the slot webview

---

## Language features in depth

### Diagnostics (three tiers)

| Tier | Trigger | Source | Latency |
| --- | --- | --- | --- |
| Fast | Every keystroke (debounced) | `@solidity-parser/parser` + SPDX / pragma / `tx.origin` checks | ~5–15 ms |
| Lint | Same debounce | AST linter (8 rules) | ~10–30 ms |
| Full | On save | `forge build --json` mapped via `LineIndex` (CRLF + UTF-8 safe) | Hundreds of ms |

### Navigation

- **Go to Definition** (`F12`): symbol index with inheritance chain traversal; solc AST for overload disambiguation
- **Go to Type Definition**: resolves to the declaring contract / struct / enum / UDVT
- **Find References** (`Shift+F12`): O(1) lookup via inverted index; includes/excludes declarations per context
- **Workspace Symbols** (`Cmd/Ctrl+T`): substring search over all top-level symbols

### Refactoring

- **Rename** (`F2`): workspace-wide for top-level names (contracts, functions, events, errors, structs, enums, modifiers, state variables, UDVTs). Locals and parameters rename scope-aware via the solc AST. Ambiguous renames are refused with an explanation. `lib/` directories are excluded.
- **Code actions**: add SPDX, replace `tx.origin`, generate NatSpec stub, implement interface methods, auto-import unresolved symbols

### Semantic tokens

20 token types with 10 modifiers (`declaration`, `readonly`, `virtual`, `override`, `documentation`, `defaultLibrary`, etc.) for state variables, locals, parameters, functions, modifiers, events, errors, contracts, interfaces, libraries, structs, and enums.

Reference-site tokens use a per-function text scan; collisions between identically-named
identifiers in different functions are a known limitation.

### Inlay hints

Parameter name hints at call sites: `transfer(›to:‹ alice, ›amount:‹ 100)`.
Toggle: `solidity-workbench.inlayHints.parameterNames`.

### Signature help

Triggers on `(` and `,`. Shows the full signature with visibility, mutability, return types,
NatSpec `@notice` / `@dev` / `@param` docs, overload switching, and built-in signatures for
`require`, `assert`, `revert`, `keccak256`, `sha256`, `ecrecover`, `addmod`, `mulmod`, `blockhash`.

### Code lens

Per function / event / contract:

- `N references` — click opens Find References
- `selector: 0x....` — from `forge build` output (struct/UDT-accurate), keccak256 fallback; click to copy
- `topic0: 0x....` — for events
- `~{gas} gas` — from `.gas-snapshot`
- `Run Test` / `Debug` — in `.t.sol` files
- `extends A, B, C` — on contracts with base contracts

### Call hierarchy

Incoming and outgoing calls with receiver-qualifier disambiguation — `token.transfer()`
resolves to the correct contract, not every `transfer()` in the workspace. State variables,
parameters, `this`, and `super` all resolve correctly.

### Type hierarchy

Supertypes and subtypes across the entire `is` inheritance graph.

---

## Foundry integration

All commands available via `Cmd/Ctrl+Shift+P → "Solidity Workbench: ..."`.

### Build and test

- **Build** — `forge build`
- **Run Tests** / **Test File** / **Test at Cursor** — `forge test` with `--match-test` / `--match-path`
- **Test Explorer** — tree view with pass/fail, fuzz counterexamples, inline gas
- **Gas Snapshot** — `forge snapshot` with inline decorations and regression tracking
- **Coverage** / **Clear Coverage** — `forge coverage --report lcov` with line-level coloring
- **Flatten** — `forge flatten`
- **Storage Layout** — CLI output or interactive webview

### Scripting and deployment

- **Simulate** / **Broadcast** / **Resume** — `forge script` with Ledger, Keystore, Interactive, or env-var signing
- **Deploy Contract** — guided `forge create` with artifact picker, typed constructor args, Etherscan verification
- **Verify Contract** / **Check Status** — `forge verify-contract` / `forge verify-check`

### Local chain and REPL

- **Anvil**: start / stop / fork from any RPC with optional block pin
- **Chisel**: start REPL (fresh or forked), send editor selection to it

### Cast palette

Quick picks for `sig`, `4byte`, `calldata-decode`, `abi-encode`, `keccak`, `to-wei`, `from-wei`, `balance`, and `storage`.

### Debugging

Terminal-based: `forge test --debug`, `forge debug`, or `forge debug --rpc-url <url> <txHash>`.
A Debug Adapter Protocol (DAP) implementation is planned.

---

## Static analysis

### Built-in linter

Eight AST-based rules in the LSP server, running on every keystroke. Suppress per-line:

```solidity
// solidity-workbench-disable-next-line reentrancy
recipient.call{value: amount}("");
balances[msg.sender] -= amount;
```

### Slither

Enable with `solidity-workbench.slither.enabled = true`. Findings appear as VS Code
diagnostics with related-information links. Run on demand or automatically on save.

---

## Configuration

All settings under `solidity-workbench.*`:

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `foundryPath` | string | `""` (PATH) | Absolute path to `forge` binary |
| `formatOnSave` | boolean | `true` | Run `forge fmt` on save |
| `diagnostics.compileOnSave` | boolean | `true` | Run `forge build` on save for full diagnostics |
| `diagnostics.debounceMs` | number | `500` | Debounce for real-time diagnostics (ms) |
| `slither.enabled` | boolean | `false` | Enable Slither on-save analysis |
| `slither.path` | string | `""` | Absolute path to `slither` binary |
| `inlayHints.parameterNames` | boolean | `true` | Parameter name hints at call sites |
| `gasEstimates.enabled` | boolean | `true` | Gas estimate code lens from `.gas-snapshot` |
| `test.verbosity` | number | `2` | `forge test` verbosity (0–5) |

Settings take effect dynamically without a restart.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                  VS Code / Cursor Extension                  │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐ │
│  │   Foundry    │  │     Test     │  │  Static Analysis   │ │
│  │   Commands   │  │   Explorer   │  │  (Slither bridge)  │ │
│  └──────────────┘  └──────────────┘  └────────────────────┘ │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐ │
│  │     Gas      │  │   Storage    │  │  Anvil / Cast /    │ │
│  │   Profiler   │  │   Layout     │  │  Chisel / Deploy   │ │
│  └──────────────┘  └──────────────┘  └────────────────────┘ │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │            LSP Client (vscode-languageclient v9)        │ │
│  └─────────────────────────────────────────────────────────┘ │
└────────────────────────────┬─────────────────────────────────┘
                             │ stdio
┌────────────────────────────┴─────────────────────────────────┐
│                  Solidity Workbench LSP Server                │
│                                                              │
│  ┌───────────────────┐  ┌──────────────────────────────────┐ │
│  │ WorkspaceManager  │  │ SolidityParser                   │ │
│  │ foundry.toml,     │  │ @solidity-parser/parser + NatSpec│ │
│  │ remappings,       │  │ extraction + error recovery      │ │
│  │ multi-root, forge │  └──────────────────────────────────┘ │
│  └───────────────────┘  ┌──────────────────────────────────┐ │
│                         │ SymbolIndex + ReferenceIndex      │ │
│                         │ (inverted index for O(1) refs)   │ │
│                         └──────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ 17 LSP providers: completion, definition, hover,        │ │
│  │ diagnostics, semantic-tokens, code-actions, formatting, │ │
│  │ document-symbols, inlay-hints, signature-help, rename,  │ │
│  │ code-lens, references, auto-import, call-hierarchy,     │ │
│  │ type-hierarchy, linter                                  │ │
│  └─────────────────────────────────────────────────────────┘ │
│  ┌───────────────────┐  ┌──────────────────────────────────┐ │
│  │   SolcBridge      │  │   LineIndex                      │ │
│  │   type-resolved   │  │   UTF-8 byte offset <-> LSP pos  │ │
│  │   AST via forge   │  │                                  │ │
│  └───────────────────┘  └──────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
         │                │                   │
    ┌────┴─────┐     ┌────┴─────┐      ┌─────┴──────┐
    │   solc   │     │  forge   │      │  slither   │
    │(compiler)│     │build/test│      │  (opt.)    │
    └──────────┘     └──────────┘      └────────────┘
```

**Dual-AST strategy**: a fast parser AST (`@solidity-parser/parser`) powers keystroke-level
features while a type-resolved solc AST (from `forge build --json` on save) powers overload
disambiguation, member completion, and scope-aware rename.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design document.

---

## Development

### Monorepo structure

```
solidity-workbench/
├── packages/
│   ├── common/         Shared types, custom LSP protocol, LCOV parser
│   ├── server/         LSP server — 17 providers, parser, indexes, SolcBridge
│   └── extension/      VS Code client — commands, webviews, test explorer
├── test/fixtures/      Sample Foundry project for integration testing
├── scripts/            Build helpers (icon rasterization)
├── .github/workflows/  CI (Node 18/20/22 matrix) + tag-gated publish
├── ARCHITECTURE.md     Design rationale and system diagrams
├── PRODUCTION_GAPS.md  Gap tracker (all P1/P2 resolved; P3 backlog)
└── CHANGELOG.md        Release notes (Keep a Changelog format)
```

### Build and test

```bash
pnpm install              # install workspace dependencies
pnpm build                # build common → server → extension (esbuild)
pnpm watch                # rebuild on change
pnpm test                 # 181 unit tests (node --test)
pnpm lint                 # ESLint
pnpm format:check         # Prettier
pnpm package              # produce .vsix

# E2E tests (boots a real VS Code instance)
pnpm --filter solidity-workbench test:e2e
```

### Running in dev

1. Open this repo in VS Code.
2. Press `F5` — an Extension Development Host launches with the extension loaded.
3. Open `test/fixtures/sample-project/` (or any Foundry repo).
4. Use `pnpm watch` for live rebuilds; `Ctrl+R` in the host to reload.

### Test suite

181 unit tests via Node's built-in test runner, plus 6 E2E smoke tests via `@vscode/test-electron`. CI runs on Node 18, 20, and 22 with Foundry installed.

Coverage spans: parser (35 tests), symbol/reference indexing, all major providers (completion,
definition, hover, rename, references, code actions, auto-import, diagnostics, semantic tokens,
call hierarchy, signature help, inlay hints), the 8 linter rules, LCOV parsing, line-index
byte-offset conversion, and text utilities.

---

## Roadmap

All P1 and P2 items are resolved. Remaining P3 enhancements — see [PRODUCTION_GAPS.md](PRODUCTION_GAPS.md):

| Item | Effort | Description |
| --- | --- | --- |
| DAP debugger | 3–4 weeks | Source-level step-through via forge trace + source maps |
| Solar integration | 2–3 weeks | Swap parser hot path to Solar WASM for ~40x speed |
| Chisel webview | 1 week | Persistent REPL with evaluation history |
| Fuzzy workspace symbols | 2–3 days | Trigram index for O(1) fuzzy lookup |
| Additional analyzers | 1 wk each | Aderyn, Wake, Mythril integrations |
| Subgraph scaffold | 3–5 days | Generate Graph subgraph from contract ABI |
| Remote chain UI | 1 week | ABI-aware webview for `cast call` / `cast send` |
| More E2E coverage | Ongoing | Rename round-trip, code-action application, coverage rendering |

---

## Contributing

Contributions welcome. The codebase follows consistent patterns:

- **Providers** live in `packages/server/src/providers/` — single class with `provide*` methods
- **Extension features** live in `packages/extension/src/{commands,views,analysis,test-explorer,debugger}/`
- **Shared types** go in `packages/common/src/types.ts`; custom LSP messages in `packages/common/src/protocol.ts`
- **Linter rules** plug into `packages/server/src/providers/linter.ts`

Run `pnpm lint && pnpm format:check && pnpm test` before opening a PR. For larger design
changes, open an issue referencing the relevant section of [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Telemetry

Zero telemetry. No usage data, crash reports, or identifiers leave your machine. The only
network activity is what you explicitly trigger (`forge build`, `cast`, `anvil --fork-url`, etc.).
The LSP server communicates over stdio and never opens a network socket.

---

## License

[MIT](LICENSE) — Copyright (c) 2026 Chris Cashwell

See [CHANGELOG.md](CHANGELOG.md) for release notes.
