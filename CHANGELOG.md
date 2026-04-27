# Changelog

All notable changes to Solidity Workbench are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-04-27

### Performance

- **LSP startup no longer blocks until every dependency file is
  indexed.** The previous `for..of await indexFile()` walk only
  crossed microtask boundaries between files, which doesn't let
  the event loop dispatch hover / completion / diagnostics
  requests; users with a populated `lib/` tree saw the editor
  stall on activation. `WorkspaceManager` now partitions
  discovered `.sol` files into `project` (`src/`), `tests`
  (`test/` + `script/`), and `deps` (`lib/`) tiers, and
  `SymbolIndex.indexWorkspace` walks them in priority order with
  a `setImmediate` yield every 24 files. Project symbols become
  queryable while deps continue indexing in the background.
- **Streamed indexing progress.** `serverState` notifications
  now fire at every batch boundary, so the status bar shows
  `Indexing 24/N`, `48/N`, … instead of jumping from 0 to done.
- **Symbol-lookup misses drain the pending queue.**
  `findSymbols`, `getContract`, `findReferences`,
  `referenceCount`, and `hasReferences` fall back to a
  synchronous drain of remaining tier files when the in-memory
  cache returns empty during the indexing window. The first miss
  on a `forge-std` symbol pays the catch-up cost; every later
  query takes the fast path. Editor-driven `updateFile` calls
  also clear the file from the pending set so the bulk loop
  doesn't re-index something the user just opened.

### Fixed

- **Marketplace upload rejected with "suspicious content".** Two
  GitHub URLs in the README still pointed at the old organization
  the repository moved from. The Marketplace's content scanner
  flags publisher/repository mismatches as potential
  typosquatting. Repointed both URLs (the CI artifacts link and
  the `git clone` command) at the current `ccashwell` repo.
- **VSIX shipped 4.7 MB of unnecessary source maps.** Both
  `extension.js.map` and `server.js.map` were being packaged even
  though end users never consume them — they added bytes the
  content scanner has to walk (maps embed the full `sourcesContent`
  of our TS source) and tripled the VSIX size for no end-user
  benefit. Drop them from the packaged artifact via `.vscodeignore`;
  local `dist/` still has them for debugging. VSIX size now 416 KB
  (was 1.17 MB).
- **Test Explorer ran `forge test` but never displayed any results.**
  Four compounding bugs, all fixed together:
    - stdout was split by `\n` and each line parsed as JSON. Real
      forge `--json` output is a single JSON blob on one line, so
      only stray valid-JSON lines ever parsed — typically nothing.
    - `data.test_results` was read one level too shallow. The actual
      shape is `{ "<file>:<Contract>": { test_results: {...} } }`,
      so the lookup was always `undefined`.
    - `findChildByName` compared the forge signature key
      (`test_Increment()`) against the TestItem label
      (`test_Increment`), so child matching always fell through to
      the parent container.
    - forge ran with `cwd = workspaceFolders[0]` regardless of where
      the test actually lived. In a monorepo where the workspace
      root sits above the Foundry project (the common case for this
      repo's `test/fixtures/sample-project/`), forge picked up the
      wrong `foundry.toml` (or none at all) and emitted an empty
      result set, producing VSCode's "test run did not record any
      output" message.
  Now the parser consumes the whole blob as one JSON object, walks
  both levels of the forge shape, matches children by stripping the
  signature suffix (via `stripForgeTestSignature`), parses forge's
  human-readable duration strings via `parseForgeDurationMs`, and
  resolves the correct `cwd` by walking up from each test file to
  the nearest `foundry.toml` via a new `findForgeRoot` helper.
  Unknown / empty forge responses now resolve the parent item as
  `skipped` instead of leaving it in the started state forever.
  Added `stripForgeTestSignature`, `parseForgeDurationMs`, and
  `findForgeRoot` helpers to `@solidity-workbench/common/foundry-cli.ts`,
  with 13 unit tests across the real forge output shapes and
  nested-project scenarios (including an outer stub
  `foundry.toml` that must NOT shadow the real project config).
- **`forge test` verbosity flag was malformed.** Every command that
  invoked `forge test` was building the verbosity flag as
  `"-".repeat(n) + "v"` — producing `--v` for the default
  `test.verbosity=2`, which forge rejects with
  `error: unexpected argument '--v' found`. Coverage, the test
  explorer, and the palette `test` / `testFile` / `testFunction`
  commands all hit it. Centralized the flag building in a new
  `forgeVerbosityFlag` helper in `@solidity-workbench/common` (short
  flag shape: `-v`, `-vv`, `-vvv`, `-vvvv`, `-vvvvv`; empty for
  level 0; clamped at 5) so it can't be re-introduced. 6 unit
  tests cover every boundary including a `/^-v+$/` assertion that
  would have caught the original bug.
- **Auto-import quick fixes no longer offer to import symbols that
  are declared in the current file, and no longer leak into Quick
  Fix menus invoked on unrelated diagnostics.** Three fixes in
  `AutoImportProvider`:
    - `collectLocalNames` now includes every kind of local
      declaration — contracts, interfaces, libraries, structs,
      enums, events, errors, modifiers, contract functions,
      file-level errors, file-level free functions, UDVTs, import
      aliases, and import unit aliases. Previously only
      contracts / structs / enums were treated as local, so
      locally-declared events / errors / UDVTs / free functions
      got flagged as "unresolved" and the provider offered to
      import same-named declarations from other files.
    - `findImportCandidates` short-circuits to `[]` whenever any
      symbol with the requested name is declared in the current
      file. Defense-in-depth against stale / spurious "Undeclared
      identifier" diagnostics that would otherwise still trigger
      a wrong import suggestion.
    - Proactive import suggestions are now scoped to the
      code-action request's `range`. Quick Fix invoked on an
      unrelated diagnostic — e.g. the pragma line's
      floating-pragma warning — no longer shows a menu of imports
      for every uppercase identifier in the file. 5 new
      regression tests lock the behaviour in.
- **`forge build --match-path` was invalid** — subgraph auto-compile
  emitted `forge build --match-path <file>`, but `--match-path` is a
  `forge test` flag; `forge build` expects positional path arguments.
  Switched to `forge build <relative-path>`, which forge resolves
  against the configured `src/` / `contracts/` trees.
- **Word-at-cursor highlighting no longer leaks into comments and
  strings.** Without a `DocumentHighlightProvider`, VSCode falls back
  to a regex-based highlighter that lights up every textual match of
  the cursor's word — including inside `///` natspec comments, `//`
  line comments, block comments, and string literals. The visible
  symptom was an identifier-styled "overlay" applied to ordinary
  prose inside comment blocks. New `DocumentHighlightProvider` routes
  highlights through the existing comment- and string-aware
  `ReferenceIndex`, scoped to the current file. 7 new regression
  tests cover the comment, line-comment, and string-literal cases
  plus whitespace and multi-file isolation.

### Added

- **Indexer scaffolds beyond Graph Protocol.** The subgraph scaffold
  generator now has two peers in `@solidity-workbench/common`:
  - `generatePonderScaffold` — emits `ponder.config.ts`,
    `ponder.schema.ts` (Drizzle `onchainTable` entries), an
    `src/index.ts` with `ponder.on` handlers, an
    `abis/<Contract>Abi.ts` TypeScript `as const` module, plus
    `package.json`, `.env.example`, and a brief README. Column
    types map Solidity → Drizzle (`address` → `t.hex()`, `uintN`
    → `t.bigint()`, arrays → `.array()`, tuples → `t.json()` with
    TODO). Chain ids auto-resolve from the network slug.
  - `generateEnvioScaffold` — emits `config.yaml`, `schema.graphql`,
    `src/EventHandlers.ts` with `<Contract>.<Event>.handler`
    registrations, plus `package.json`, `.env.example`, and README.
    Event signatures drop the `indexed` keyword (Envio infers it
    from the ABI), id derivation uses `chainId_blockNumber_logIndex`
    for cross-chain uniqueness.
  Shared ABI / event-signature / type-mapping helpers now live in
  `indexer-shared.ts` so all three generators stay in lockstep.
  New command `solidity-workbench.indexer.scaffold` prompts for a
  backend (Graph / Ponder / Envio), shares the contract picker,
  auto-compile, and prompt flow with the legacy subgraph command
  (which stays as a direct shortcut to the subgraph backend).
  Ponder and Envio generators each get 10+ unit tests
  (manifest shape, type mapping, tuple warnings, unnamed params,
  empty-ABI stub, package.json sanity) — server test count
  263 → 282.

- **Code lens: error selectors.** Custom errors now get a
  `selector: 0x…` code lens identical in shape to the function
  selector lens — clicking copies the 4-byte selector to the
  clipboard. Contract-level and file-level (global) errors are both
  covered. `SolcBridge` now extracts error selectors from the ABI on
  each `forge build` and caches them for accurate struct / UDVT
  parameter types; cold-cache and pre-build states fall back to
  local keccak over the parser-level canonical signature. 4 new
  regression tests lock in zero-arg, primitive, file-level, and
  multi-error cases.

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
  The command now auto-compiles on demand: if no artifacts exist
  (fresh clone, clean working copy) or the active `.sol` file has
  no matching artifact, it runs `forge build` (narrowed via
  `--match-path` when a specific file is targeted) inside a progress
  notification before falling through to the quick-pick, instead of
  erroring out. Build failures surface the stderr in a dedicated
  output channel with an "Open Output" button. The active file's
  contract is also hoisted to the top of the pick list.
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
