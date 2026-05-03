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

### 1. Real DAP debugger

Today's "debugger" is three terminal-wrapped `forge debug` / `forge
test --debug` invocations. A real DAP adapter means:

1. Launch forge with trace output (`-vvvvv --json`).
2. Parse the source map from compiled artifacts (`out/C.sol/C.json`
   `sourceMap` + `generatedSources`).
3. Walk EVM opcodes step-by-step, mapping back to source positions.
4. Implement DAP `stackTrace`, `scopes`, `variables`,
   `stepIn` / `stepOut` / `stepOver`.
5. Expose storage and memory as "globals".

**Effort**: 3–4 weeks. Simbolik is the commercial gold standard here.

### 2. Migrate parsing hot path to Solar when it stabilizes

`paradigmxyz/solar` PR #401 is merged but not yet in a released Solar
crate. When Solar ships a stable LSP, evaluate swapping the parser +
resolver hot path via WASM for ~40× speed and true type resolution.

**Effort**: 2–3 weeks once Solar is ready.

### 5. Mythril integration alongside Slither, Aderyn, and Wake

Aderyn landed in the third sweep, Wake (Ackee Blockchain) in the May
2026 sweep. Mythril is the remaining natural next analyzer
integration — same shape as the others (run external tool → parse
JSON → map to diagnostics) but its symbolic-execution runtime is
slower so the on-save toggle wants to be off by default.

**Effort**: 1 week.

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
| P3 | 4 | ~5–8 weeks (DAP dominates) |
<!-- Counts: DAP debugger, Solar migration (blocked on upstream), Mythril integration, ongoing E2E coverage. -->

| **Total to public beta** | **0** | **ship the VSIX** |
| **Total to v1.0** | **0** | **ship the VSIX** |

As of this sweep there are no open P1 or P2 items. Every concern the
post-MVP review raised has landed: AST-based linting eliminates the
comment / multiline false positives; locals / parameters rename via
SolcBridge; selectors come from `forge build` output; the deploy
picker offers type-aware constructor prompts; and there's a real
`@vscode/test-electron` suite running in CI. The remaining work is
strictly P3 — nice-to-haves and v2.0 stretch items.
