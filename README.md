# Solidity Workbench

> A modern, Foundry-native Solidity IDE for VSCode and Cursor — Java/TypeScript-level
> language support built from the ground up for protocol engineers.

Solidity Workbench is an LSP-powered extension that gives Solidity the IDE
experience developers on other languages take for granted: reliable navigation,
real refactoring, semantic highlighting, inlay hints, call hierarchy, signature
help, auto-imports, integrated testing, gas profiling, coverage, static analysis,
and deep Foundry integration — all in one package.

---

## Table of contents

- [Why another Solidity extension?](#why-another-solidity-extension)
- [Feature overview](#feature-overview)
- [Comparison with existing extensions](#comparison-with-existing-extensions)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Language features](#language-features)
- [Foundry integration](#foundry-integration)
- [Static analysis](#static-analysis)
- [Configuration](#configuration)
- [Keyboard shortcuts & commands](#keyboard-shortcuts--commands)
- [Architecture](#architecture)
- [Development](#development)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## Why another Solidity extension?

The Solidity tooling landscape has three mainstream options, each with
significant gaps:

- **JuanBlanco Solidity** — the install-base leader (1.8M+ installs), but its
language features are implemented directly in the extension host (not an LSP),
it carries years of technical debt, and it's framework-agnostic in a way that
makes Foundry feel second-class.
- **Nomic Foundation Solidity** — LSP-backed and technically the strongest, but
it's Hardhat-first by design; Foundry support is still marked *experimental*,
and it doesn't ship refactorings, call hierarchy, inlay hints, or a test
explorer.
- **Ackee Wake (Tools for Solidity)** — excellent for security auditing, but
requires a Python toolchain (`eth-wake`) alongside Foundry, and its feature
set is oriented toward auditing rather than daily protocol development.

Solidity Workbench is built for developers who already live in Foundry and want
the IDE to match. Every feature assumes `forge`, `cast`, `anvil`, `chisel`, and
`foundry.toml` exist and behave as documented — no Hardhat compatibility layer,
no Truffle fallback, no runtime Python dependency.

See `[ARCHITECTURE.md](ARCHITECTURE.md)` for the full design rationale.

---

## Feature overview

### Language intelligence (via LSP)


| Feature                            | Notes                                                                                     |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| Semantic syntax highlighting       | 20 token types × 10 modifiers, AST-driven                                                 |
| Go-to-definition / type-definition | Cross-file, remapping-aware                                                               |
| Find all references                | Inverted index — O(1) lookup per query                                                    |
| Rename symbol                      | Workspace-wide, with safety guards for ambiguous names                                    |
| Hover information                  | Signatures + NatSpec + built-in globals                                                   |
| Autocompletion                     | Context-aware: members, keywords, types, snippets, imports, NatSpec tags                  |
| Auto-import                        | Code action resolves `forge-std/...`, OZ, relative paths                                  |
| Signature help                     | Parameter hints with NatSpec `@param` docs; overload picking                              |
| Inlay hints                        | Parameter name hints at call sites                                                        |
| Document / workspace symbols       | Outline, Go to Symbol, Quick Open                                                         |
| Document formatting                | Backed by `forge fmt` (full + range formatting)                                           |
| Code actions                       | Add SPDX, replace `tx.origin`, implement interface, NatSpec stub                          |
| Code lens                          | `Run Test` / `Debug`, function selectors, event `topic0`, reference counts, gas estimates |
| Call hierarchy                     | Incoming/outgoing calls with receiver-qualifier disambiguation                            |
| Type hierarchy                     | Supertypes / subtypes across the `is` graph                                               |
| Diagnostics                        | Fast path (parser + custom linter) + full path (`forge build --json`)                     |


### Custom linter

Eight security / best-practice rules run on every keystroke, with
`// solidity-workbench-disable-next-line [code]` suppression:

- `reentrancy` — state writes after external calls (CEI violation)
- `unchecked-call` — low-level `.call(...)` without success check
- `dangerous-delegatecall` — flag any `.delegatecall(...)`
- `unprotected-selfdestruct` — `selfdestruct` with no access control
- `missing-zero-check` — address parameters not checked against `address(0)`
- `missing-event` — state-changing functions that emit no events
- `large-literal` — magic numbers that should be named constants
- `storage-in-loop` — storage reads inside `for`/`while` loops

### Foundry power tools


| Command                                    | What it runs                                                    |
| ------------------------------------------ | --------------------------------------------------------------- |
| **Build**                                  | `forge build`                                                   |
| **Run Tests / Test File / Test at Cursor** | `forge test` with `--match-test` / `--match-path`               |
| **Test Explorer**                          | Tree view with pass/fail, fuzz counterexamples, inline gas      |
| **Format**                                 | `forge fmt` (on-save supported)                                 |
| **Gas Snapshot**                           | `forge snapshot` with inline decorations                        |
| **Coverage**                               | `forge coverage` with per-file coverage banners                 |
| **Flatten**                                | `forge flatten`                                                 |
| **Storage Layout Panel**                   | `forge inspect <C> storage-layout --json` → interactive webview |
| **Script: Simulate / Broadcast / Resume**  | `forge script` with Ledger / Keystore / Interactive signing     |
| **Deploy Contract**                        | Guided `forge create` with Etherscan verification               |
| **Verify Contract**                        | `forge verify-contract` / `forge verify-check`                  |
| **Debug Test / Script / Transaction**      | `forge test --debug` / `forge debug` in a terminal              |


### Cast / Anvil / Chisel integration

- **Anvil**: Start / stop / fork-from-mainnet straight from the command palette
- **Cast**: `sig`, `4byte`, `calldata-decode`, `abi-encode`, `keccak`, `to-wei`,
`from-wei`, `balance`, `storage` — quick palette commands with sensible defaults
- **Chisel**: Start a REPL (fresh or forked) and send the current selection to it

### `foundry.toml` IntelliSense

Autocompletion, hover docs, and value validation for every
`[profile.default]`, `[fmt]`, `[fuzz]`, and `[invariant]` key.

### Static analysis

- **Slither** (optional) — findings surfaced as VSCode diagnostics with severity
mapping (`High`/`Medium` → Error, `Low` → Warning, `Informational`/`Optimization` → Info).
Auto-runs on save when enabled.
- Custom AST-based linter bundled in the LSP (see list above).

### Gas profiling & coverage

- Reads `.gas-snapshot` and renders a tree view grouped by contract.
- Inline decorations show `⛽ {gas} gas` next to every test function.
- Coverage view uses `forge coverage --report summary` and annotates files with
`lines / branches / functions` percentages.

---

## Comparison with existing extensions

As of April 2026, ranked by Marketplace install counts:


| Feature                           | Solidity Workbench   | JuanBlanco Solidity     | Nomic Foundation | Ackee Wake              |
| --------------------------------- | -------------------- | ----------------------- | ---------------- | ----------------------- |
| Architecture                      | LSP (TypeScript)     | In-process (TypeScript) | LSP (TypeScript) | LSP (Python)            |
| Foundry support                   | **Native**           | Generic remappings      | Experimental     | Yes (Foundry + Hardhat) |
| Hardhat support                   | No (by design)       | Yes                     | **Native**       | Yes                     |
| Semantic tokens                   | **Yes**              | No                      | Partial          | Yes                     |
| Inlay hints                       | **Yes**              | No                      | No               | No                      |
| Signature help                    | **Yes**              | No                      | No               | Yes                     |
| Call hierarchy                    | **Yes**              | No                      | No               | Partial                 |
| Type hierarchy                    | **Yes**              | No                      | No               | No                      |
| Rename symbol                     | **Yes**              | No                      | Yes              | Yes                     |
| Auto-import                       | **Yes**              | No                      | No               | Yes                     |
| Code lens (selectors, refs, gas)  | **Yes**              | Partial                 | No               | Partial                 |
| Custom security linter (built in) | **Yes**              | No                      | No               | Yes (Wake)              |
| Slither integration               | **Yes**              | No                      | No               | No                      |
| Test explorer                     | **Yes**              | No                      | No               | Partial                 |
| Forge script runner               | **Yes**              | No                      | No               | No                      |
| `forge create` / verify UI        | **Yes**              | No                      | No               | No                      |
| Anvil / Chisel commands           | **Yes**              | No                      | No               | Yes (Anvil)             |
| Storage layout webview            | **Yes**              | No                      | No               | Yes                     |
| Gas snapshot UI                   | **Yes**              | No                      | No               | No                      |
| Coverage visualization            | **Yes** (file level) | No                      | No               | No                      |
| `foundry.toml` IntelliSense       | **Yes**              | No                      | No               | No                      |
| Runtime dependencies              | Node 18+             | Node 18+                | Node 18+         | **Python 3.8+**         |
| Install count (April 2026)        | 0 (pre-release)      | ~1.8M                   | ~412k            | ~44k                    |
| License                           | MIT                  | MIT                     | MIT              | ISC                     |


Solidity Workbench is the **only** extension that combines deep Foundry
integration, full modern IDE features (semantic tokens, inlay hints, call
hierarchy, signature help, rename, auto-import), and built-in security linting
without pulling in a second toolchain (Python).

---

## Requirements

- **VSCode** `≥ 1.85.0` (or Cursor built on the same engine)
- **Node.js** `≥ 18` (needed only for installation from source; the packaged
VSIX bundles its own server)
- **Foundry** — `forge`, `cast`, `anvil`, `chisel` on your `PATH`.
Install via [foundryup](https://getfoundry.sh):
  ```bash
  curl -L https://foundry.paradigm.xyz | bash
  foundryup
  ```
- **Slither** (optional, Python) — required only if you enable
`solidity-workbench.slither.enabled`.

The extension activates automatically on any workspace that contains a
`foundry.toml` or any `*.sol` file.

---

## Installation

> Note: Solidity Workbench is pre-release and not yet published to the VS Code
> Marketplace. See the [Development](#development) section below to run it
> locally, or install from a CI-built `.vsix`.

### From a built VSIX (recommended for try-outs)

1. Download `solidity-workbench-*.vsix` from the [GitHub
  Actions artifacts](./actions/workflows/ci.yml) of the latest `main` build.
2. In VSCode / Cursor:
  ```
   Cmd/Ctrl+Shift+P → "Extensions: Install from VSIX..."
  ```

### From source (development)

```bash
git clone https://github.com/uniswap/solidity-workbench
cd solidity-workbench
pnpm install
pnpm build
```

Then open the repo in VSCode and press `F5` to launch an Extension Development
Host with the extension loaded.

---

## Quick start

1. Open any Foundry project (something with a `foundry.toml`).
2. Open a `.sol` file — the extension activates, runs `forge build` for
  diagnostics, and indexes your workspace.
3. Play with it:
  - Hover over a symbol for its signature + NatSpec.
  - `F12` on an import path → jump to the remapped file.
  - `Shift+F12` → Find All References.
  - `F2` on a top-level symbol → Rename workspace-wide.
  - Trigger autocomplete inside a function call to get signature help.
  - Place your cursor inside a `test_*` function → click the `$(play) Run Test`
  code lens, or use the Test Explorer in the side bar.
  - Run `Solidity Workbench: Gas Snapshot` → inline gas numbers appear next to
  test functions once `.gas-snapshot` is written.
  - Run `Solidity Workbench: Storage Layout Visualization` → an interactive
  webview of every storage slot for the chosen contract.

---

## Language features

### Diagnostics (three-tier)


| Tier | Trigger                              | Source                                                                          | Latency                            |
| ---- | ------------------------------------ | ------------------------------------------------------------------------------- | ---------------------------------- |
| Fast | On every keystroke (300 ms debounce) | `@solidity-parser/parser` + SPDX / pragma / `tx.origin` / `selfdestruct` checks | ~5–15 ms                           |
| Lint | On parse, same debounce              | Custom AST linter (8 rules, see above)                                          | ~10–30 ms                          |
| Full | On save                              | `forge build --json` mapped via `LineIndex` (CRLF + UTF-8 correct)              | ~hundreds of ms, project-dependent |


### Navigation

- **Go to Definition** (`F12`): walks the symbol index; falls back to
dotted-access member resolution through the inheritance chain.
- **Go to Type Definition**: resolves variable types back to the declaring
contract / struct / enum / UDVT.
- **Peek Definition** (`Alt+F12`).
- **Find References** (`Shift+F12`): O(1) lookup in the inverted reference
index; declarations included/excluded per request context.
- **Workspace Symbols** (`Cmd/Ctrl+T`): substring search over every top-level
symbol, capped at 100 results.

### Refactoring

- **Rename Symbol** (`F2`): scoped to top-level names (contracts, functions,
events, errors, structs, enums, modifiers, state variables, UDVTs). Refuses
ambiguous renames and excludes `lib/` directories from the edit set.
- **Code actions**:
  - Quick fix → Add missing SPDX license
  - Quick fix → Replace `tx.origin` with `msg.sender`
  - Refactor → Add NatSpec stub (auto-generates `@param`/`@return`)
  - Quick fix → Implement unimplemented interface methods (stubs with `TODO`)
  - Quick fix → Auto-import unresolved symbol (remapping-aware)

### Semantic tokens

All 20 token types plus 10 modifiers (`declaration`, `readonly`, `virtual`,
`override`, `documentation`, `defaultLibrary`, …) are emitted for:

- State variables, local variables, parameters, return parameters
- Functions, modifiers, events, errors
- Contracts, interfaces, libraries, structs, enums

Reference-site tokens use a per-function text scan; collisions between
identically-named identifiers in different functions are a known limitation
(documented inline in `semantic-tokens.ts`).

### Inlay hints

Function calls get parameter-name hints: `transfer(›to:‹ alice, ›amount:‹ 100)`.
Toggle via `solidity-workbench.inlayHints.parameterNames`.

### Signature help

Triggers on `(` and `,` inside any call. Shows:

- Full function signature (types + optional names)
- Visibility & mutability
- Return type
- NatSpec `@notice`, `@dev`, and per-parameter `@param` docs
- Overload switching by active parameter index
- Built-in signatures for `require`, `assert`, `revert`, `keccak256`, `sha256`,
`ecrecover`, `addmod`, `mulmod`, `blockhash`

### Code lens

On every function / event / contract:

- `N references` — click to open Find References
- `selector: 0x....` — click to copy to clipboard (keccak256 via `js-sha3`)
- `topic0: 0x....` — for events
- `~{gas} gas` — from `.gas-snapshot` when available
- `$(play) Run Test` / `$(debug) Debug` — in `.t.sol` files
- `extends A, B, C` — on contracts with base contracts

### Call hierarchy

`Ctrl+Shift+H` on any function opens the call graph.
Incoming calls resolve the *receiver qualifier* — so `token.transfer()`
doesn't contaminate findings for every `transfer()` in the codebase. State
variables, parameters, `this`, and `super` all resolve correctly.

### Type hierarchy

`Shift+F4` on a contract/interface shows supertypes and subtypes across the
whole workspace.

---

## Foundry integration

All commands available via `Cmd/Ctrl+Shift+P → "Solidity Workbench: ..."`:

### Build & test

- **Build** (`solidity-workbench.build`)
- **Run Tests** (`solidity-workbench.test`)
- **Run Tests in Current File** (`solidity-workbench.testFile`)
- **Run Test at Cursor** (`solidity-workbench.testFunction`)
- **Gas Snapshot** (`solidity-workbench.gasSnapshot`)
- **Run Coverage** / **Clear Coverage Highlights**
- **Flatten Contract** (`solidity-workbench.flatten`)
- **Inspect Storage Layout** (CLI and webview variants)

### Scripting & deployment

- **Run Script — Simulate** — dry-run against any RPC
- **Run Script — Broadcast** — with Ledger / Keystore / Interactive / env-var
signing; confirms before sending
- **Resume Script Broadcast**
- **Deploy Contract** (`forge create`) — guided picker for contract, network,
signing method, constructor args, and Etherscan verification
- **Verify Contract on Etherscan** / **Check Verification Status**

### Local chain & REPL

- **Start Anvil** / **Stop Anvil** — fresh chain or forked from any RPC
with optional block number pin
- **Start Chisel REPL** / **Start Chisel (Fork)** / **Send Selection to Chisel**

### Cast command palette

Pre-filled quick picks for:

- `cast sig` (function selector)
- `cast 4byte` (selector → signature lookup)
- `cast calldata-decode`
- `cast abi-encode`
- `cast keccak` (operates on the editor selection by default)
- `cast to-wei` / `cast from-wei`
- `cast balance` (uses local Anvil by default)
- `cast storage` (read any slot from any address)

### Debugging

Today debugging is **terminal-based**: `forge test --debug`, `forge debug`, or
`forge debug --rpc-url <url> <txHash>` are spawned in a dedicated debug
terminal, giving access to forge's built-in TUI debugger.

A full Debug Adapter Protocol implementation is planned — see the
[Roadmap](#roadmap) and `PRODUCTION_GAPS.md §16`.

---

## Static analysis

### Built-in linter

Eight rules ship in the LSP server and run on every keystroke. Example
suppression:

```solidity
// solidity-workbench-disable-next-line reentrancy
recipient.call{value: amount}("");
balances[msg.sender] -= amount;
```

### Slither

Set `solidity-workbench.slither.enabled = true` (and optionally `slither.path`).
Findings show as VSCode diagnostics with related-information links between
elements of each finding. Run on demand (`Solidity Workbench: Run Slither Analysis`) or automatically on save.

---

## Configuration

All settings live under the `solidity-workbench.*` namespace:


| Setting                     | Type    | Default           | Description                                  |
| --------------------------- | ------- | ----------------- | -------------------------------------------- |
| `foundryPath`               | string  | `""` (use `PATH`) | Absolute path to `forge` binary              |
| `formatOnSave`              | boolean | `true`            | Run `forge fmt` on save                      |
| `diagnostics.compileOnSave` | boolean | `true`            | Run `forge build` on save                    |
| `diagnostics.debounceMs`    | number  | `500`             | Debounce for real-time diagnostics           |
| `slither.enabled`           | boolean | `false`           | Enable Slither on-save analysis              |
| `slither.path`              | string  | `""`              | Absolute path to `slither` binary            |
| `inlayHints.parameterNames` | boolean | `true`            | Parameter-name hints at call sites           |
| `inlayHints.variableTypes`  | boolean | `false`           | Inferred type hints for variables (planned)  |
| `gasEstimates.enabled`      | boolean | `true`            | Code lens gas estimates from `.gas-snapshot` |
| `test.verbosity`            | number  | `2`               | `forge test` verbosity level (0–5)           |


Changing `foundryPath` is picked up by the LSP server automatically (no restart
needed).

---

## Keyboard shortcuts & commands

The extension does not bind any keybindings by default — it relies on VSCode's
standard LSP shortcuts (`F12`, `Shift+F12`, `F2`, `Ctrl+Shift+H`, `Shift+F4`,
`Ctrl+Space`, etc.).

Editor context menu additions (in `.sol` and `.t.sol` files):

- **Run Test at Cursor** — in `.t.sol` files only
- **Keccak256 Hash** — on the current selection
- **Get Function Selector (cast sig)** — on the current selection

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                VSCode / Cursor Extension Host               │
│                                                             │
│  ┌────────────┐  ┌────────────┐  ┌───────────────────────┐  │
│  │  Foundry   │  │    Test    │  │   Static Analysis     │  │
│  │  Commands  │  │  Explorer  │  │   (slither bridge)    │  │
│  └────────────┘  └────────────┘  └───────────────────────┘  │
│  ┌────────────┐  ┌────────────┐  ┌───────────────────────┐  │
│  │    Gas     │  │  Storage   │  │  Anvil / Cast         │  │
│  │  Profiler  │  │  Layout    │  │  Chisel / Script      │  │
│  └────────────┘  └────────────┘  └───────────────────────┘  │
│  ┌────────────────────────────────────────────────────────┐ │
│  │           LSP Client (vscode-languageclient v9)        │ │
│  └────────────────────────────────────────────────────────┘ │
└────────────────────────────┬────────────────────────────────┘
                             │ LSP over stdio
┌────────────────────────────┴────────────────────────────────┐
│              Solidity Workbench LSP Server                  │
│                                                             │
│  ┌───────────────────┐  ┌──────────────────────────────────┐│
│  │ WorkspaceManager  │  │ SolidityParser                   ││
│  │ foundry.toml,     │  │ @solidity-parser/parser + NatSpec││
│  │ remappings,       │  │ extraction + error recovery      ││
│  │ forge spawning    │  └──────────────────────────────────┘│
│  └───────────────────┘  ┌──────────────────────────────────┐│
│                         │ SymbolIndex + ReferenceIndex     ││
│                         │ (inverted idx for refs)          ││
│                         └──────────────────────────────────┘│
│  ┌──────────────────────────────────────────────────────── ┐│
│  │ 17 providers: completion, definition, hover,            ││
│  │ diagnostics, semantic-tokens, code-actions, formatting, ││
│  │ document-symbols, inlay-hints, signature-help, rename,  ││
│  │ code-lens, references, auto-import, call-hierarchy,     ││
│  │ type-hierarchy, linter                                  ││
│  └─────────────────────────────────────────────────────────┘│
│  ┌───────────────────┐  ┌──────────────────────────────────┐│
│  │   SolcBridge      │  │   LineIndex                      ││
│  │   (type-resolved  │  │   UTF-8 byte ↔ LSP Position      ││
│  │    AST via forge) │  │                                  ││
│  └───────────────────┘  └──────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
         │                │                   │
    ┌────┴─────┐     ┌────┴─────┐      ┌─────┴──────┐
    │   solc   │     │  forge   │      │  slither   │
    │(compiler)│     │build/test│      │  (opt.)    │
    └──────────┘     └──────────┘      └────────────┘
```

See `[ARCHITECTURE.md](ARCHITECTURE.md)` for the full design document,
technology stack rationale, and dual-AST strategy (fast parser AST for
keystroke-level features, rich solc AST for type resolution).

---

## Development

### Project structure

```
solidity-workbench/
├── packages/
│   ├── common/         # Shared types, foundry config, custom LSP protocol
│   ├── server/         # LSP server (17 providers + parser + indexes)
│   └── extension/      # VSCode extension (commands + webviews + test explorer)
├── test/fixtures/      # Sample Foundry project for integration testing
├── ARCHITECTURE.md     # Design rationale and system diagrams
├── PRODUCTION_GAPS.md  # Gap tracking (P1/P2/P3)
└── README.md           # This file
```

### Build & test

```bash
# Install dependencies (pnpm workspace)
pnpm install

# Build all three packages
pnpm build

# Watch mode (rebuilds on change)
pnpm watch

# Run the 111 unit tests
pnpm test

# Lint and format
pnpm lint
pnpm format:check

# Package as a VSIX (also runs the server-bundling esbuild pass)
pnpm package
```

### Running the extension

1. Open this repo in VSCode.
2. Press `F5` → a new Extension Development Host launches with Solidity
  Workbench loaded.
3. Open `test/fixtures/sample-project/` (or any Foundry repo) in that host
  window.
4. Reload the Extension Host (`Ctrl+R`) after code changes, or use
  `pnpm watch` for live rebuilds.

### Tests

All 111 unit tests run via `node --test` (no extra runner). Coverage includes:

- `parser.test.ts` (35 tests) — every Solidity construct
- `symbol-index.test.ts`, `reference-index.test.ts` — indexing correctness
- `rename.test.ts`, `call-hierarchy.test.ts`, `semantic-tokens.test.ts` —
provider output
- `linter.test.ts` — all 8 linter rules
- `line-index.test.ts` — CRLF + UTF-8 byte-offset → Position conversion
- `text-utils.test.ts` — word boundary + string/comment detection

CI (`.github/workflows/ci.yml`) runs on Node 18, 20, and 22, installs Foundry,
runs all tests, and verifies that the produced VSIX contains a bundled LSP
server.

---

## Roadmap

Tracked in detail in `[PRODUCTION_GAPS.md](PRODUCTION_GAPS.md)`. The critical
remaining items for public beta are:

1. **Wire the `SolcBridge` rich AST into providers** — type-resolved member
  completion on variables (`token.` → IERC20 members), scope-aware rename for
   locals, accurate definition resolution through overloads.
2. **Test Explorer should consume the LSP AST** — the current regex-based
  `parseTestFile` breaks on braces inside strings or multi-line function
   headers.
3. **Line-level coverage** via `forge coverage --report lcov` (currently only
  file-level banners).
4. **Gas snapshot deltas** — persist the previous snapshot and show per-function
  regression arrows.

Beyond that, the longer-term roadmap includes multi-root workspace support,
provider-level test coverage, end-to-end extension tests via
`@vscode/test-electron`, `rpc_endpoints` / `fuzz` / `invariant` schema coverage
in `foundry.toml` IntelliSense, a real DAP debugger (`forge debug` trace parser
→ step-through with source maps), a Chisel webview with evaluation history, and
eventual integration with [Solar](https://github.com/paradigmxyz/solar) (or its
Rust LSP when it ships) for ~40× parser speedups and true type resolution.

---

## Contributing

Contributions welcome! The codebase has explicit design patterns that are easy
to follow:

- **Providers** live in `packages/server/src/providers/` and export a single
class with `provide`* methods matching the LSP capability.
- **Extension features** live in `packages/extension/src/{commands,views,analysis,test-explorer,debugger}/`
and register themselves in `extension.ts`.
- **Shared types** go in `packages/common/src/types.ts`; custom LSP
notifications/requests go in `packages/common/src/protocol.ts`.
- **New linter rules** plug into `packages/server/src/providers/linter.ts` —
take a `ContractDefinition` and the source lines, return `Diagnostic[]`.

Run `pnpm lint && pnpm format:check && pnpm test` before opening a PR. The
pre-merge CI matrix runs the same checks on Node 18/20/22.

For larger design changes, open a discussion issue first referencing the
relevant section of `ARCHITECTURE.md` or `PRODUCTION_GAPS.md`.

---

## Telemetry

Solidity Workbench collects **zero** telemetry. No usage data, crash reports,
or identifiers leave your machine. The only outbound network activity
attributable to the extension is whatever you explicitly trigger:

- `forge build` / `forge test` / `forge fmt` / `forge coverage` / `forge
  snapshot` / `forge inspect` / `forge script` / `forge create` /
  `forge verify-contract` — the `forge` binary's normal behaviour,
  including downloading pinned `solc` versions on first use.
- `cast call` / `cast balance` / `cast storage` — HTTP to whichever RPC URL
  you supply.
- `anvil --fork-url …` — HTTP to the fork source you specify.
- `slither` — if you set `solidity-workbench.slither.enabled = true`,
  slither will read `etherscan.io` URLs only if you pass Etherscan
  identifiers to it.

The LSP server communicates with the editor over stdio and never opens a
socket.

## License

[MIT](LICENSE). See [`CHANGELOG.md`](CHANGELOG.md) for release notes.