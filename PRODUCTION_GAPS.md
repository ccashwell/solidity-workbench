# Solidity Workbench: Remaining Gaps to v1.0

Updated after the second (April 2026) production-readiness sweep that
closed every open P1 and every open P2. Every item flagged by the
post-MVP review is now addressed; what remains is explicit P3
"v2.0-wants" work.

## Severity Legend

- **P1 — Critical**: should fix before public beta
- **P2 — Important**: should fix for v1.0 quality
- **P3 — Enhancement**: nice-to-have, required for v2.0

---

## Recently fixed (second April 2026 sweep)

### AST-based linter rules (was P2 #1)

- `SolidityLinter` now walks the raw `@solidity-parser/parser` AST for
  reentrancy, missing-event, storage-in-loop, unchecked-call,
  dangerous-delegatecall, and unprotected-selfdestruct detection. The
  regex versions fired on commented-out code and multi-line
  expressions; the AST versions don't.
- Added 6 regression tests that specifically exercise the false-positive
  cases the regex implementation would have hit (block-comment CEI,
  delegatecall in a comment, emit-suppresses-missing-event, captured
  tuple return on `.call`, inline `msg.sender` access check for
  selfdestruct, loop-reads-parameter-shadow).

### Scope-aware rename for locals and parameters (was P2 #2)

- `SolcBridge.findLocalReferences(filePath, offset)` returns the
  declaration range + every reference range for a function-scoped
  variable. `RenameProvider.provideLocalRename` rewrites precisely
  those byte ranges in a single file — no workspace-wide text rewrite
  needed.
- `prepareRename` now accepts locals when a SolcBridge is available
  (post-first-successful-build). Top-level symbols still go through
  the index-based path.
- Updated the legacy rejection error to name the actual precondition
  (no symbol-index match AND no solc AST).

### Canonical selectors via `forge build --json` (was P2 #5)

- `SolcBridge` now extracts `evm.methodIdentifiers` from the forge
  build output alongside the AST and exposes it via
  `getCachedMethodIdentifiers(contractName)`. `CodeLensProvider`
  consults the cache first (Etherscan-accurate for structs / UDTs)
  and only falls back to local keccak256 when the cache is cold
  (pre-first-save or build failure).
- Handles overloads by matching parameter count.

### Deploy picker reads artifacts (was P2 #4)

- `deploy.ts::pickContract` now enumerates `out/**/*.json` Forge
  artifacts for the authoritative deployable-contract list. Skips
  interfaces (empty bytecode), build-info files, and Test/Mock names
  automatically. Falls back to the legacy regex-over-src path when no
  artifacts exist (fresh clone, no build yet).
- When the artifact has an ABI, the constructor-args prompt becomes
  per-parameter with declared Solidity type in the prompt label.
  String values are auto-quoted for `forge create`.

### End-to-end extension tests (was P2 #3)

- `@vscode/test-electron` is wired up:
  - `packages/extension/src/test/runTest.ts` boots a real VSCode
    binary (cached in `.vscode-test/`) with the extension loaded and
    the `test/fixtures/sample-project/` as the workspace.
  - `packages/extension/src/test/suite/` contains the Mocha suite.
  - `pnpm --filter solidity-workbench test:e2e` is now a first-class
    test command, and a new `e2e` CI job runs it under `xvfb-run`
    on GitHub Linux runners.
- The initial smoke suite has 6 tests (all green) covering: extension
  presence, activation, 13 key commands registered, Solidity language
  registered, `.sol` files open with the right `languageId`, and the
  LSP returns document symbols for the sample `Counter.sol` contract.

### Provider + LCOV test coverage (was P2 #6)

- LCOV parser extracted from `extension/src/views/coverage.ts` into
  `@solidity-workbench/common/lcov.ts` so the server's `node --test`
  runner can exercise it. Added 14 tests covering every LCOV record
  type (`DA` / `BRDA` / `LF` / `LH` / `FN` / `FNDA` / ...), CRLF
  tolerance, branch summarization, and derived `LF` / `LH` totals.
- Added provider-level tests for:
  - `CompletionProvider` — keywords, types, user-defined symbols,
    NatSpec tags, import paths, `msg. / abi.`, static `Contract.`
    member lookup with visibility filtering (7 tests)
  - `AutoImportProvider` — remapped-vs-relative path selection,
    undeclared-identifier quick fixes, irrelevant-diagnostic
    suppression (4 tests)
  - `CodeActionsProvider` — add-SPDX, replace-tx.origin,
    add-NatSpec idempotence, implement-interface stubbing with
    override keyword placement (5 tests)
  - `DiagnosticsProvider.extractSyntaxDiagnostics` — SPDX, floating
    pragma, `tx.origin`, deprecated `selfdestruct`, comment
    suppression (9 tests)
- Server test count: 135 → **181**.

---

## Previously fixed (first April 2026 sweep)

See git history for full detail. Highlights retained here for
cross-reference:

- SolcBridge rich AST consumed by hover / definition / completion
  providers for overload disambiguation and member resolution.
- Test Explorer backed by a custom `solidity-workbench/listTests` LSP
  request sourced from the parsed AST.
- Line-level coverage via `forge coverage --report lcov`.
- Gas profiler regression deltas persisted to `context.globalState`.
- Multi-root workspace support with per-root `foundry.toml` /
  remappings / source trees.
- Cancellation tokens across every heavy LSP request.
- Full dynamic config reload for every `solidity-workbench.*` setting.
- Status bar wired to a `solidity-workbench/serverState` notification.
- `foundry.toml` IntelliSense expanded to `rpc_endpoints`,
  `etherscan.*`, `fuzz`, `invariant` plus every `[profile.*]` key.
- Inlay-hint paren-aware argument walker and declaration-line guard.
- LICENSE / CHANGELOG / icon / telemetry disclaimer / tag-gated publish
  workflow in place.

---

## P1 — Critical (remaining)

None.

---

## P2 — Important (remaining)

None.

---

## Recently fixed (third April 2026 sweep — P3 landings)

### Trigram-indexed fuzzy workspace symbols (was P3 #4)

- New `TrigramIndex` under `packages/server/src/analyzer/` maintains a
  map from 3-grams to symbol names. `SymbolIndex.findWorkspaceSymbols`
  now prunes candidates via posting-list intersection for queries of
  3+ chars, ranks matches via `scoreName` (exact > prefix > substring
  > ordered-subsequence fuzzy), and caps at 100 results. Includes full
  add / remove lifecycle so symbols removed from the workspace no
  longer leak into search. 15 new unit tests across
  `trigram-index.test.ts` + `symbol-index.test.ts`.

### Aderyn static-analysis integration (was P3 #5a)

- Pure JSON-report parser added to `@solidity-workbench/common/aderyn-report`
  with 11 unit tests covering malformed input, the three severity
  buckets, tuple params, and schema drift tolerance.
- `AderynIntegration` VSCode wrapper mirrors the Slither shape — new
  `solidity-workbench.aderyn` command, `aderyn.enabled` /
  `aderyn.path` settings, and opt-in on-save hook. Writes the report
  to a tempdir, parses it, maps to `vscode.Diagnostic` with
  related-information links between instances.

### Subgraph scaffold generator (was P3 #6)

- `generateSubgraphScaffold` in `@solidity-workbench/common` emits
  `subgraph.yaml`, `schema.graphql`, and `src/<contract>.ts` for a
  contract ABI. Events-only scaffold with correct indexed-param
  canonical signatures, scalar / array type mapping, and explicit
  `// TODO` markers for tuple params whose encoding is domain-specific.
  16 unit tests cover the ABI → files transformation.
- `solidity-workbench.subgraph.scaffold` command picks a compiled
  contract from `out/*.sol/*.json`, prompts for network / address /
  start block, writes the scaffold files plus a copy of the ABI into
  `subgraph/<ContractName>/`, and opens the manifest.

### Wake static-analysis integration (was P3 #5b — May 2026 sweep)

- Pure JSON-report parser added to `@solidity-workbench/common/wake-report`
  with 12 unit tests covering the canonical and legacy top-level
  shapes, field-name fallbacks across Wake versions
  (`detector_name`/`detector`/`name`,
  `impact`/`severity`,
  `source_unit_name`/`file`/`path`,
  `line_from`/`line`/`start_line`), `location.start: [line, col]`
  tuples, dedup of subdetections, and informational-impact aliases.
- `WakeIntegration` VSCode wrapper mirrors the Aderyn shape — new
  `solidity-workbench.wake` command, `wake.enabled` / `wake.path`
  settings, and an opt-in on-save hook. Captures stdout (Wake has
  no `--output` flag), parses, and surfaces each finding with
  column-precise ranges where Wake provides them and the confidence
  rating in the diagnostic message.

### Mythril symbolic-execution integration (was P3 #5c — May 2026 sweep)

- Pure JSON-report parser added to `@solidity-workbench/common/mythril-report`
  with 11 unit tests covering all three top-level shapes Mythril
  emits (single-target `{ issues: [...] }`, multi-target keyed-by-
  filename, bare-array form), severity normalisation including
  `Informational`/`Info`/`Information` aliases, SWC field aliases
  (`swc-id`/`swcID`/`swc_id`), and dropping of malformed entries.
- `MythrilIntegration` VSCode wrapper differs from the others
  because Mythril's symbolic-execution runtime is too slow for
  whole-workspace scans:
  - **Per-file**: command + on-save hook target a single Solidity
    file (the active editor's file by default).
  - **Long-running progress**: `withProgress` shows a status-bar
    spinner while the analysis runs (10-minute timeout cap).
  - **In-flight guard**: a save burst won't stack analyses.
  - **SWC tagging**: each diagnostic's `code` is the SWC registry
    id (`SWC-107`, `SWC-101`, ...) when present.
  - `solidity-workbench.mythril.enabled` defaults to `false` —
    opt-in to avoid a save-time stall.

### Expanded E2E coverage (was P3 #8)

- Corrected the stale `uniswap.solidity-workbench` extension ID in the
  activation smoke tests (publisher is `ccashwell`).
- Extended command-registration assertions to cover the three new
  commands (`aderyn`, `subgraph.scaffold`, `findReferencesAt`).
- Added `lsp-round-trip.test.ts` with tests for hover, workspace
  symbols (exact + fuzzy subsequence), references, rename response,
  code actions response, and formatting response. Retry loop
  tolerates the asynchronous initial indexing pass.

---

## Recently fixed (fourth April 2026 sweep — P3 landings)

### Remote chain interaction UI (was P3 #7)

- New `solidity-workbench.remoteChain.open` command opens a webview
  that wraps `cast call` against a chain picker, with ABI
  awareness so args are typed. Seven seeded public RPCs (Mainnet,
  Sepolia, Base, Base Sepolia, Optimism, Arbitrum One, Polygon PoS)
  plus a "Custom RPC URL…" escape hatch. ABI loaded by pasting
  JSON or picking a forge artifact under `out/**/*.json`.
  Function picker groups read-only and write methods; writes are
  rendered disabled with a deferral tooltip. Result cards show
  raw hex AND decoded text with copy buttons. Pure helpers
  `formatFunctionSignature`, `formatFunctionDisplaySignature`,
  `formatFunctionSignatureWithReturns`, and `isReadOnly` ship in
  `@solidity-workbench/common/abi-signature` with 27 unit tests.
  `cast decode-output` does not exist on Foundry 1.5; the panel
  uses cast's built-in inline decoding via `name(in)(out)`
  signatures instead.

### Chisel webview with evaluation history (was P3 #3)

- The legacy `ChiselIntegration` shelled chisel into a
  `vscode.Terminal`. Replaced with `ChiselPanel` — a webview that
  owns a long-lived `chisel` subprocess spawned via
  `child_process.spawn`, renders each evaluation as a card, and
  persists history (capped at 200 entries) in
  `context.globalState`. The three command IDs
  (`solidity-workbench.chisel.start`, `.startFork`, `.sendSelection`)
  keep working unchanged. Subprocess teardown fires on both panel
  disposal and extension deactivate (SIGTERM with a 1 s SIGKILL
  fallback). Pure helpers in `@solidity-workbench/common/chisel-output`
  with 28 new unit tests cover ANSI stripping, banner consumption,
  multi-chunk buffering, error classification, and exit-time drain.
  Pairing strategy is a quiet-window heuristic, not a prompt
  sentinel — chisel's reedline frontend disables its `➜` prompt
  under non-TTY stdio, so prompt-based parsing was infeasible.

---

## P3 — Enhancement (remaining)

### 1. Real DAP debugger (DONE — stretch goals at bottom)

A real DAP adapter that launches forge / cast with trace output,
parses solc source maps, walks opcodes, and implements the DAP
request set. All five originally-scoped stages landed in the May
2026 sweep.

**Stage 1 — scaffold (DONE).** May 2026 sweep:

- Pure `parseSourceMap` / `buildPcToInstructionIndex` /
  `resolveSourcePosition` helpers in
  `@solidity-workbench/common/source-map` with 17 unit tests
  covering compression rules, the `fileIndex = -1` sentinel, PUSH1–
  PUSH32 + PUSH0 operand walks, hex-prefix tolerance, and
  recoverable map-shorter-than-bytecode mismatches.
- `SolidityDapAdapter` (inline `DebugAdapterInlineImplementation`)
  speaks the DAP wire format directly. Stubs initialize / launch /
  threads / stackTrace / scopes / variables / step* / terminate.
  Unimplemented requests return `success: false` with a "Not yet
  implemented" message rather than blocking the host.
- `package.json` declares `breakpoints: [{ language: "solidity" }]`,
  the `solidity-workbench` debug type with a launch.json schema
  (`program`, `test`, `stopOnEntry`), an initial config, and an
  auto-completer snippet. `SolidityDapConfigurationProvider` fills
  in defaults for F5-without-launch.json.

**Stage 2 — trace ingestion (DONE).** May 2026 sweep:

- `parseTraceJson` accepts the de-facto `debug_traceTransaction`
  JSON shape (geth, anvil, `cast run --json`) plus two defensive
  variants (`{ steps: [...] }` and a bare array). Tolerant of the
  field-name drift Foundry emitters exhibit (`pc`/`programCounter`,
  `op`/`opName`/`opcode`, `gas`/`gasLeft`, `gasCost`/`cost`) and
  gas values serialised as either decimal numbers or `0x` hex.
- `TraceCursor` is the navigator the DAP adapter holds for the
  session: `current` / `index` / `length` / `next` / `previous` /
  `seek` / `findNext` / `findPrevious`. Cheap index moves;
  source-position-aware semantics compose `findNext` with a
  predicate built from the source-map module so the cursor itself
  stays source-map-agnostic.
- 16 unit tests cover the three top-level shapes, field aliases,
  gas-as-hex-or-decimal, optional-field defaults, error capture,
  and every cursor method's edge cases.
- The DAP adapter's launch config gained a `traceFile` escape
  hatch. When set, the adapter parses the JSON, builds a
  `TraceCursor`, and `stackTrace` / `next` / `stepIn` / `continue`
  /`terminated` all flow through real cursor state. Until the
  live execution path lands in stage 3, users can hand-feed
  `cast run --json` output and step opcode-by-opcode.

**Stage 3 — source-position resolution + step semantics +
setBreakpoints (DONE).** May 2026 sweep:

- New `parseForgeArtifact` in `@solidity-workbench/common` decodes
  forge artifacts (`out/<File>.sol/<Contract>.json`) tolerating
  the canonical / flat-string / `evm.<key>` shapes that Foundry
  has emitted across versions. Source list extracted from
  `metadata.sources` (canonical solc metadata key order =
  fileIndex), with fallbacks to top-level `sources` /
  `sourceList`. 11 unit tests.
- `LineIndex` moved into common so the adapter shares one canonical
  UTF-8-byte ↔ LSP-position implementation with the LSP server.
- The adapter loads the artifact during `launch`, builds a
  `ContractContext` (parsed sourceMap, pre-computed PC →
  instruction-index table, absolute source paths each indexed
  for byte-offset → line conversion), and:
    * `stackTrace` reports actual file + line + column.
    * `next` / `stepIn` advance until the source line changes.
    * `stepOut` runs until call depth drops below the current
      frame.
    * `continue` advances to the next breakpoint or end.
    * `setBreakpoints` records source-line breakpoints keyed on
      normalised absolute path.
    * `loadedSources` enumerates the artifact's source list.
- Single-contract caveat: when a trace enters an external CALL /
  CREATE the inner contract's bytecode + sourceMap aren't ours,
  so stepping shows label-only frames at depth > 1 until the call
  returns.

**Stage 4 — internal call stack + Stack / Memory / Storage scopes
(DONE).** May 2026 sweep:

- `stackTrace` walks `jump: "i"` / `jump: "o"` markers from index
  0 through the cursor's current step to construct the Solidity
  internal call stack. Each internal function call is its own
  DAP frame with its own source position. The DAP convention is
  topmost-first; the topmost frame's name carries the
  PC/opcode/depth context. Defensive against unbalanced jumps
  from exception unwinds.
- `scopes` exposes Stack (uint256 entries, top-of-stack first),
  Memory (32-byte words by start offset), and Storage (slot →
  value entries from structLogs) at the current step. Each
  scope name carries a count badge.
- `variables` resolves the references through a per-step
  allocation table cleared at every fresh `scopes` request, so
  stale references can't survive a step transition.

**Stage 5 — disassembly + storage pretty-print + evaluate (DONE).**
May 2026 sweep:

- `parseStorageLayout` in common reads the artifact's
  `storageLayout` block and groups packed entries by slot.
  Storage scope entries surface as
  `<label> (slot 0xN [+offset]) = <value>` with the Solidity
  type attached. 8 unit tests.
- `disassemble` helper in common decodes EVM bytecode through
  Cancun / post-Cancun (BLOBHASH, BLOBBASEFEE, MCOPY, TLOAD,
  TSTORE, PUSH0). Unknown opcodes render as `INVALID(0xNN)`
  rather than throwing. The deployed bytecode is disassembled
  once at load and `disassemble` requests slice instruction
  windows out of the cache. 7 unit tests.
- `evaluate` request supports a small expression DSL:
  `stack[N]`, `memory[0xN]`, `storage[<slot>]`, and bare
  state-variable identifiers resolved through the storage
  layout. `supportsEvaluateForHovers` flipped on so VSCode's
  hover surfaces values inline.

**Stretch goals (not blocking).** A live `forge test --debug
--json` execution path (so users don't have to hand-feed a
saved trace), AST-driven local-variable decoding (mapping
Solidity identifiers to stack slots), and multi-contract source
maps (loading the inner contract's artifact when a CALL crosses
a boundary). All three are valuable but the adapter is functional
without them — users can step through any trace they save with
`cast run --json` against a single contract.

### 2. Migrate parsing hot path to Solar when it stabilizes

`paradigmxyz/solar` PR #401 is merged but not yet in a released Solar
crate. When Solar ships a stable LSP, evaluate swapping the parser +
resolver hot path via WASM for ~40× speed and true type resolution.

**Effort**: 2–3 weeks once Solar is ready.


### 8. More E2E coverage (ongoing)

Third-sweep work added LSP round-trip tests for hover, workspace
symbols (exact + fuzzy), references, rename, code actions, and
formatting. Natural next additions: test-explorer discovery after a
`forge build`, coverage decoration rendering, storage-layout webview
HTML shape, Slither / Aderyn diagnostic round-trip with a fixture
report.

**Effort**: 1–2 days ongoing.

---

## Summary

| Priority | Count | Cumulative effort |
|----------|-------|-------------------|
| P1 | 0 | — |
| P2 | 0 | — |
| P3 | 2 | ~2–3 weeks |
<!-- Counts: Solar migration (blocked on upstream), ongoing E2E coverage. The DAP debugger's five originally-scoped stages all shipped in the May 2026 sweep; stretch goals (live forge launch, AST local-variable decoding, multi-contract source maps) are tracked at the bottom of the DAP entry. -->

| **Total to public beta** | **0** | **ship the VSIX** |
| **Total to v1.0** | **0** | **ship the VSIX** |

As of this sweep there are no open P1 or P2 items. Every concern the
post-MVP review raised has landed: AST-based linting eliminates the
comment / multiline false positives; locals / parameters rename via
SolcBridge; selectors come from `forge build` output; the deploy
picker offers type-aware constructor prompts; and there's a real
`@vscode/test-electron` suite running in CI. The remaining work is
strictly P3 — nice-to-haves and v2.0 stretch items.
