# Changelog

All notable changes to Solidity Workbench are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added (third production-readiness sweep — P3 landings)

- **Trigram-indexed fuzzy workspace symbols.** New
  `packages/server/src/analyzer/trigram-index.ts` maintains a 3-gram
  posting list for every indexed name. `findWorkspaceSymbols` now
  prunes candidates via posting-list intersection for 3+-char queries
  and ranks matches (exact → prefix → substring → ordered-subsequence
  fuzzy). Typing `ctr` in the VSCode symbol picker now surfaces
  `Counter`; long queries run sub-linearly on large workspaces. 15
  new unit tests.
- **Aderyn (Cyfrin) static-analysis integration.** Pure JSON-report
  parser in `@solidity-workbench/common/aderyn-report` plus a VSCode
  wrapper under `packages/extension/src/analysis/aderyn.ts` that
  mirrors the Slither shape. New command
  `solidity-workbench.aderyn`, settings `aderyn.enabled` /
  `aderyn.path`, and opt-in on-save analysis. 11 unit tests cover the
  parser, severity mapping, and summary helpers.
- **Subgraph scaffold generator.** `generateSubgraphScaffold` in
  `@solidity-workbench/common/subgraph-scaffold.ts` emits
  `subgraph.yaml`, `schema.graphql`, and `src/<contract>.ts` from a
  contract ABI — events-only scaffold with canonical
  `indexed`-aware event signatures, scalar / array-type mapping to
  GraphQL, and TODO markers for tuple params. New command
  `solidity-workbench.subgraph.scaffold` picks a contract from
  `out/*.sol/*.json`, prompts for network / address / start block,
  and writes the scaffold plus an ABI copy to
  `subgraph/<ContractName>/`. 16 unit tests cover the generator.
- **Expanded E2E coverage.** Fixed the stale
  `uniswap.solidity-workbench` extension ID (publisher is
  `ccashwell`) in the activation smoke tests. Added LSP round-trip
  tests for hover, workspace symbols (exact + fuzzy subsequence),
  references, rename response, code actions response, and formatting
  response — all with retry loops tolerating the async initial
  indexing pass.

Server unit-test count: 204 → **252**.

### Fixed

- **Parameter-name inlay hints now respect the receiver of a dotted
  call.** `Currency.unwrap(currency)` was annotated with
  `_wstETHAmount:` — a parameter name belonging to an unrelated
  interface's `unwrap(uint256)`. `InlayHintsProvider` now extracts
  the receiver from `Receiver.funcName(...)` and either walks the
  receiver's inheritance chain for the matching function or emits
  no hints (when the receiver is a UDVT builtin like `wrap`/`unwrap`,
  or a variable whose type can't be inferred). Plain unqualified
  calls keep the existing lookup. 4 new regression tests.
- **Hover on dotted access no longer picks an unrelated same-named
  function.** Hovering `Currency.unwrap(x)` could surface
  `IWstETH.unwrap(uint256)` simply because both declared an `unwrap`
  method — the hover fell through to a raw name lookup with no
  receiver check. `HoverProvider` now detects the `Receiver.member`
  pattern at the cursor, resolves the receiver through the symbol
  index (contract / interface / library / struct / UDVT), and returns
  only a member that actually belongs to that receiver. UDVTs
  synthesise a hover for their implicit `wrap` / `unwrap` functions,
  including the underlying type. When the receiver is identified but
  the member can't be found on it we return `null` rather than
  surfacing the wrong symbol.
- **Hover now covers every elementary Solidity type.** Previously only
  `address`, `bool`, `string`, `bytes`, `uint256`, `int256`, and
  `bytes32` had a hover — hovering `uint8`, `uint128`, `int24`,
  `bytes16`, etc. returned nothing. Replaced the static map with a
  generator that recognises every legal width (`uint8` / `int8` …
  `uint256` / `int256` in steps of 8, `bytes1` … `bytes32`, plus the
  `uint` / `int` / `byte` aliases and the reserved `fixed` /
  `ufixed(MxN)` syntax). 8 new regression tests lock the coverage in.
- **"N references" code lens no longer throws "unexpected type" when
  clicked.** The lens was wired directly to VSCode's
  `editor.action.findReferences`, which requires a `vscode.Uri`
  instance, but LSP emits URIs as strings over the wire so the command
  argument coercion failed. Route the lens through a new client-side
  shim `solidity-workbench.findReferencesAt(uri, position)` that
  parses the URI into a `vscode.Uri` before invoking the editor
  command. 3 new regression tests cover the argument shape, the title
  format, and omission when a symbol has no usages.
- **Semantic tokens now cover struct members, event / error / function
  parameters, state variable types, base contracts, user-defined value
  types, and cross-body references to user-defined types.** The
  previous implementation only tokenized declaration names; struct
  bodies like `struct EscrowedPosition { PoolKey poolKey; MarketId
  marketId; }` rendered with no type/field colouring at all. The
  `SemanticTokensProvider.collectDeclarationTokens` implementation now
  walks the raw `@solidity-parser/parser` AST so every sub-node's
  precise `loc` is used, including `.identifier.loc` on variable
  declarations and `.typeName.loc` on user-defined type references.
  `buildNameKinds` also registers contracts, interfaces, structs,
  enums, UDVTs, and errors so function-body references receive the
  correct `type` / `struct` / `enum` / `interface` colour. 8 new
  regression tests cover the cases the old provider missed.

### Added (second production-readiness sweep)

- **AST-based linter rules**. `reentrancy`, `missing-event`,
  `storage-in-loop`, `unchecked-call`, `dangerous-delegatecall`, and
  `unprotected-selfdestruct` now walk the raw `@solidity-parser/parser`
  AST instead of regex-scanning function body text. Eliminates false
  positives on commented-out code and multi-line expressions. 6 new
  regression tests cover the cases the regex version would have missed
  or mis-flagged.
- **Scope-aware rename for locals and parameters**. `RenameProvider`
  consults `SolcBridge.findLocalReferences` to rewrite precisely the
  byte ranges solc attributes to a single function-scoped declaration.
  Top-level symbols still use the workspace-wide path. `prepareRename`
  gives a clear error when neither path applies (e.g. before first
  successful `forge build`).
- **Canonical selectors from `forge build --json`**. `SolcBridge`
  caches `evm.methodIdentifiers` and `CodeLensProvider` consults the
  cache first, falling back to local keccak256 only when cold.
  Selectors for functions that take structs / UDTs are now
  Etherscan-accurate.
- **Deploy picker reads compiled artifacts**. `deploy.ts::pickContract`
  enumerates `out/**/*.json` for the authoritative contract list.
  When the ABI is present the constructor-args prompt becomes
  per-parameter with declared Solidity type in the prompt label;
  strings are auto-quoted for `forge create`.
- **E2E test scaffold via `@vscode/test-electron`**. A real VSCode
  binary boots with the extension loaded and the sample project open.
  6-test smoke suite covering activation, command registration,
  language registration, and a round-trip through
  `vscode.executeDocumentSymbolProvider`. New `e2e` CI job under
  `xvfb-run`.
- **LCOV parser extracted** into `@solidity-workbench/common` so it's
  unit-testable from the server test runner.
- **Provider test coverage expanded**: `CompletionProvider`,
  `AutoImportProvider`, `CodeActionsProvider`,
  `DiagnosticsProvider.extractSyntaxDiagnostics`, LCOV parser. Total
  server tests: 135 → 181.

### Added (first production-readiness sweep)

- **Line-level coverage** via `forge coverage --report lcov`. Each executable
  line gets a covered / uncovered / partial gutter decoration; branch coverage
  (`BRDA` records) surfaces as "partial" on branches with uncovered sides.
  Replaces the previous file-level banner. Per-file totals still show in the
  status bar.
- **Gas profiler regression deltas**. The last loaded `.gas-snapshot` is
  persisted in extension global state; on every refresh the tree view shows
  arrows (`↑` regression / `↓` improvement / `—` no change) and inline gas
  decorations include the delta.
- **Test Explorer backed by the LSP AST**. A new custom LSP request
  (`solidity-workbench/listTests`) enumerates test contracts and functions
  from the already-parsed AST instead of re-regexing each file. Handles
  braces inside strings, multi-line function headers, and nested contracts
  correctly.
- **Multi-root workspace support**. The LSP server now tracks per-root
  state (`foundry.toml`, remappings, symbol index) and responds to
  `workspace/didChangeWorkspaceFolders` with add/remove-root plumbing.
- **Cancellation token support** across heavy providers (`references`,
  `rename`, `semantic-tokens`, `call-hierarchy`, `workspace-symbols`).
  Long-running queries now early-exit when the client cancels.
- **Dynamic configuration reload** for every `solidity-workbench.*` setting
  (not just `foundryPath`). Debounce / verbosity / inlay-hint toggles take
  effect without a restart.
- **Status bar wired to server state** — a live indicator shows LSP
  readiness, most recent `forge build` result (ok / errors / warnings),
  coverage percentage when loaded, and whether Anvil is running.
- **`foundry.toml` IntelliSense expanded** to cover `[rpc_endpoints]`,
  `[etherscan]`, `[fuzz]`, `[invariant]`, and the full `[profile.*]` key
  surface area. Hovers cite the Foundry Book documentation section.
- **SolcBridge wired into providers**. Hover, definition, and member
  completion now consult the type-resolved solc AST (when a `forge build`
  has succeeded) to pick the right overload and enumerate members of the
  concrete variable type.
- **Publish workflow**. A tag-gated GitHub Actions job publishes the VSIX to
  the VS Code Marketplace (`vsce publish`) and Open VSX (`ovsx publish`) on
  `v*.*.*` tags. Credentials required: `VSCE_PAT`, `OVSX_PAT`.
- **Provider-level tests** for `DefinitionProvider`, `HoverProvider`,
  `SignatureHelpProvider`, and `InlayHintsProvider`. 111 → 150+ tests.
- Extension icon + Marketplace gallery banner.
- `LICENSE` file (MIT). `CHANGELOG.md` (this file).

### Changed

- **Diagnostics** include `Diagnostic.data` with the raw solc `errorCode`
  so code actions can key off it without parsing message text.
- **Reference index** skips `lib/` directories when a workspace has a
  `foundry.toml` — matches rename behaviour and keeps large monorepo
  indexes responsive.

### Fixed

- Gas profiler now correctly populates `GasEntry.delta` (previously
  declared but never assigned).
- Status bar `Solidity Workbench` item is clickable to Run Build (was
  static label).

## [0.1.0] - 2026-04-16

Initial pre-release. Feature set covers:

- LSP server with 17 providers: completion, definition, type-definition,
  references, hover, diagnostics, semantic tokens, code actions,
  formatting, document symbols, inlay hints, signature help, rename, code
  lens, auto-import, call hierarchy, type hierarchy.
- Custom linter with 8 security / best-practice rules.
- Foundry integration: build, test, format, gas snapshot, coverage, flatten,
  storage layout, Anvil, Chisel, cast palette (9 commands), `forge script`
  simulate/broadcast/resume, `forge create` deploy flow, contract
  verification.
- Slither static analysis bridge.
- Test Explorer with inline pass/fail, fuzz counterexample display.
- Gas profiler tree view + inline decorations.
- Storage layout webview.
- `foundry.toml` IntelliSense (basic schema).
- TextMate grammar for Solidity.
- 111 unit tests; CI matrix on Node 18/20/22 with Foundry installed.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the design rationale and
[`PRODUCTION_GAPS.md`](PRODUCTION_GAPS.md) for the tracked roadmap.
