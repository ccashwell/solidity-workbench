# Changelog

All notable changes to Solidity Workbench are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.2] - 2026-04-28

### Added

- **Chisel REPL is now a structured webview panel.** The 0.1.0
  integration shelled chisel into a `vscode.Terminal`; the terminal
  works but loses every advantage a structured panel gives — output
  is interleaved with whatever else the user types, there's no
  per-evaluation card, no history, no programmatic re-run, and no
  way to script `sendSelection` against a live session. Replaced
  with `ChiselPanel`: a `vscode.WebviewPanel` that owns a long-lived
  `chisel` (or `chisel --fork-url <url>`) subprocess spawned via
  `child_process.spawn`, with per-evaluation cards (expression,
  response body, ok/error status badge, timestamp) and click-to-rerun
  on every history entry. The `solidity-workbench.chisel.start` /
  `.startFork` / `.sendSelection` command IDs are unchanged — only
  the implementation moved — so existing keybindings continue to
  work. `sendSelection` opens / focuses the panel and forwards the
  selection to the live session, waiting up to 5 seconds for chisel
  to become ready when the panel is being spawned fresh. History
  persists across sessions in `context.globalState` under
  `solidity-workbench.chisel.history`, capped at 200 entries; the
  panel exposes a Clear History button. The subprocess is terminated
  on panel disposal AND on extension `deactivate()` (SIGTERM with a
  one-second SIGKILL fallback) so a VSCode reload doesn't leak a
  chisel process. Pure helpers `splitChiselOutputByPrompt`,
  `ChiselOutputBuffer`, `stripAnsi`, `stripChiselBanner`, and
  `classifyBody` live in `@solidity-workbench/common/chisel-output.ts`
  with 28 new server-side unit tests covering ANSI stripping,
  banner consumption, multi-chunk buffering, error classification,
  and subprocess-exit drain. *Implementation note*: chisel disables
  its `➜` prompt under `reedline` when stdout is not a TTY (which
  `child_process.spawn` doesn't provide), so the panel pairs inputs
  to outputs via a 250 ms quiet-window heuristic instead of a prompt
  sentinel; this is documented at length in the module's prelude.

- **Parallel parsing via a `worker_threads` pool.** Bulk
  workspace indexing was single-threaded — every `.sol` file
  parsed one after another on the LSP main thread, with the
  chunked yields from 0.2.0 keeping requests alive but no actual
  concurrency. A new `ParserPool` spawns
  `min(6, max(1, cpus()/2))` workers (each loading
  `@solidity-parser/parser` once at startup) and
  `SymbolIndex.indexFile` routes through `parser.parseAsync`,
  which fans parses out across the pool. `Promise.all` over the
  per-batch slice is what actually drives concurrency — without
  it the awaited chain would still serialize. Empirically a 2.3×
  warm-pool speedup on a forge-std-only fixture; bigger wins on
  larger `lib/` trees where worker boot amortizes better. The
  raw ANTLR AST is intentionally not shipped across the worker
  boundary (too large; only the linter and semantic-tokens
  provider need it, and those run on user-opened files which the
  main thread parses synchronously). `parser.getRawAst` lazily
  re-parses on the main thread for the rare bulk-indexed file
  whose raw AST a downstream consumer reaches for. If the worker
  bundle is missing or `Worker` construction throws, parser
  silently falls back to single-threaded synchronous parsing —
  the pre-pool behaviour.

- **Test Explorer streams rich forge output into the run pane.**
  The provider was piping pass/fail signals through the
  `TestRun` API but never calling `appendOutput`, so VSCode's
  per-run output channel stayed empty and surfaced its default
  "The test run did not record any output." message — even
  though `forge test --json` produces a wealth of detail
  (per-test gas, durations, decoded `console.log` output, fuzz
  run counts and median gas, counterexample calldata, build
  errors). Now formats each test result into the run pane
  scoped to its own child item via `appendOutput(text,
  undefined, childItem)`, so selecting a test in the explorer
  narrows the output to just its slice. The forge command line
  and `cwd` are echoed at the start of each invocation; each
  suite gets a footer summary (`[suite] N passed, M failed`);
  fuzz `kind: { runs, mean_gas, median_gas }`, unit `kind: {
  gas }`, and invariant `kind: { runs, calls, reverts }` are
  pulled out into the per-test header. Build errors / forge
  stderr now also flow into the pane instead of disappearing
  into the error toast.

### Fixed

- **Storage Layout types rendered as raw forge type ids and the
  legend colors never appeared.** The panel was reading
  `entry.type` straight from forge, which is a type *id* like
  `t_mapping(t_userDefinedValueType(PoolId)16015,t_uint256)` —
  unreadable, and `typeColor`'s `startsWith("uint" | "address" |
  "mapping" | …)` checks never matched the `t_` prefix, so every
  slot drew with the default grey. The two pieces of data
  needed to render are in `data.types[entry.type]`: the
  human-readable `label` (e.g. `mapping(PoolId => uint256)`)
  and `numberOfBytes`. Resolved each entry through that map,
  which both restores the legend colors and gives packed slots
  proportional bar widths instead of the previous
  every-bar-is-32-bytes default.
- **Multi-line natspec rendered as one run-on paragraph in
  hover.** The natspec parser was filtering out blank `///`
  separator lines and joining every continuation line with a
  single space — so authored structure like paragraph breaks,
  `## headings`, and numbered lists collapsed into a single
  unreadable block in the hover popover. Continuation lines
  now join with `\n` (Markdown renders a single newline as a
  soft wrap; visually identical for short prose) and blank
  separator lines are preserved as `\n\n` paragraph breaks. The
  edge-trimming pass that previously did `s.replace(/\\s+/g, " ")`
  no longer flattens those newlines back out — it tidies
  intra-line whitespace only and keeps the Markdown structure
  end-to-end through the hover renderer. Applies to `@notice`,
  `@dev`, `@param`, `@return`, and `@custom:*` content; `@title`
  and `@author` stay single-line as before.
- **Duplicate `solidity-workbench.inspectStoragePanel` manifest
  entry.** The 0.3.0 `solforge.*` cleanup renamed
  `solforge.inspectStoragePanel` to
  `solidity-workbench.inspectStoragePanel` without noticing
  that the canonical entry already lived earlier in the
  contributes block. Net effect was the command palette listing
  "Solidity Workbench: Storage Layout Visualization" twice;
  both invoked the same registered command, so it was a UI
  papercut rather than a functional bug. Down to 46 unique
  command IDs.

## [0.3.0] - 2026-04-27

### Fixed

- **Storage Layout Visualization failed across every contract.**
  The panel ran `forge inspect` with `cwd: workspaceFolders[0]`,
  so any workspace whose root sat above the actual Foundry
  project (a monorepo subdirectory, this repo's own
  `test/fixtures/sample-project` layout, or a workspace opened
  one level too high) would have forge pick up no `foundry.toml`
  and fail uniformly with "No contract found" — surfaced to the
  user as the unhelpful "Make sure the project compiles." Now
  resolves the nearest `foundry.toml` ancestor of the active
  file via `findForgeRoot` (matching the test-explorer fix from
  0.2.0). The error path also surfaces forge's stderr verbatim
  so the actual cause is visible — compile error, ambiguous
  name, forge not on PATH, etc. Same fix applied to the ABI
  Explorer panel.
- **ABI Explorer was reading the wrong configuration namespace.**
  `getConfiguration("solforge")` (a leftover from a previous
  brand name) silently returned the default for every key, so
  the user's `solidity-workbench.foundryPath` setting was
  ignored — only the `forge` on PATH was ever invoked. Switched
  to `getConfiguration("solidity-workbench")`.

### Changed (breaking — pre-1.0 rename)

- **Normalized command IDs.** Four commands shipped under a
  legacy `solforge.*` namespace from an earlier branding pass
  and never got renamed when the extension became Solidity
  Workbench. Renamed:
  - `solforge.gasDiff` → `solidity-workbench.gasDiff`
  - `solforge.gasDiffRefresh` →
    `solidity-workbench.gasDiffRefresh`
  - `solforge.inheritanceGraph` →
    `solidity-workbench.inheritanceGraph`
  - `solforge.showAbi` → `solidity-workbench.showAbi`

  Any existing keybindings or `tasks.json` references will need
  updating. The matching tree-view ID (`solforge-gas-diff`) and
  webview type IDs (`solforge-inheritance-graph`,
  `solforge-abi-panel`) are also normalized; menu group names
  follow.
- **Removed dead manifest entries** that contributed `solforge.*`
  commands with no matching `registerCommand` implementation.
  Clicking these palette entries did nothing. The functionality
  was always reachable through the existing
  `solidity-workbench.*` commands they shadowed:
  - `solforge.inspectStoragePanel` (impl is
    `solidity-workbench.inspectStoragePanel`)
  - `solforge.chisel.start` / `.startFork` / `.sendSelection`
    (already declared as `solidity-workbench.chisel.*` earlier
    in the manifest)
  - `solforge.copySelector` (an internal command — the manifest
    entry exposed it in the palette by mistake; the real
    implementation is `solidity-workbench.copySelector`,
    invoked programmatically by code-lens click handlers)

## [0.2.1] - 2026-04-27

### Fixed

- **Hover, inlay hints, and definition were unresponsive until the
  full workspace index finished.** 0.2.0's "flush pending on miss"
  fallback was correctness-correct but blocked the LSP: a single
  lookup miss on a `forge-std` symbol drained every remaining
  `lib/` file synchronously before the request returned. While the
  drain ran, the event loop couldn't dispatch any other LSP
  requests or progress notifications, which read to users as "the
  editor is frozen until indexing finishes" — the same symptom
  chunked indexing was meant to fix. Replaced with
  `SymbolIndex.ensureImportsIndexed`, which walks the transitive
  import graph of an opened/changed document and indexes only the
  files that document actually pulls in (typically a few dozen,
  vs. the whole `lib/` tree). Wired into
  `documents.onDidChangeContent` as fire-and-forget; a `visited`
  set prevents re-work on subsequent edits and infinite recursion
  on import cycles. By-name lookups (`findSymbols`, `getContract`,
  `findReferences`, etc.) are back to fast cache reads.
- **Hover and signature-help natspec rendering.** Two `>`
  blockquote markers in front of the `Dev:` label rendered as
  quoted blocks in the hover popover instead of inline emphasis.
  Switched to plain `**Dev:**` formatting.

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
