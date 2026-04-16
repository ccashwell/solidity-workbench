# Solidity Workbench: Remaining Gaps to v1.0

Updated after the April 2026 production-readiness sweep. Every P0 and
every P1 item from the pre-sweep gap list is now resolved. This document
covers what's left.

## Severity Legend

- **P1 — Critical**: should fix before public beta
- **P2 — Important**: should fix for v1.0 quality
- **P3 — Enhancement**: nice-to-have, required for v2.0

---

## Recently fixed (April 2026 sweep)

### Blockers closed

- **SolcBridge rich AST is now consumed by providers.** Hover,
  definition, and member completion all consult
  `SolcBridge.resolveReference` / `getTypeAtOffset` when multiple
  workspace symbols share a name, so overloads and cross-contract
  clashes resolve correctly. `CompletionProvider.provideMemberCompletions`
  resolves `instance.` to `instance`'s concrete contract/struct and
  enumerates its members.
- **Test Explorer now uses the LSP AST** via a new
  `solidity-workbench/listTests` custom request. The client-side regex
  + brace-counting path is gone, fixing the long-standing issue with
  braces inside strings and multi-line function headers. Added 4 tests
  (including the string-braces regression case).
- **Coverage is line-level** via `forge coverage --report lcov`. LCOV's
  `DA` / `BRDA` / `FN` records drive green / red / yellow gutter
  decorations per line; branch-level partial coverage is detected from
  `BRDA` taken counts. Status bar shows the aggregate percentage.
- **Gas profiler computes deltas.** The previous snapshot is persisted
  in `context.globalState` and diffed on each refresh; the tree view
  shows `↑` / `↓` / `—` arrows per entry and inline editor decorations
  include the delta. A new `Clear Gas Regression Baseline` command
  resets the persisted state.

### Architecture cleanups

- **Multi-root workspace support.** `WorkspaceManager` now tracks a map
  of `WorkspaceRoot`s (each with its own `foundry.toml`, remappings,
  source files). `resolveImport` tries the importing file's own root's
  remappings first, then other roots. `workspace/didChangeWorkspaceFolders`
  adds / removes roots and re-indexes.
- **Cancellation token support** across `references`, `rename`,
  `semantic-tokens`, `call-hierarchy`, and `workspace/symbols`.
  Long-running queries early-exit when the client cancels.
- **Dynamic configuration reload**. All `solidity-workbench.*` settings
  (not just `foundryPath`) take effect on the next request;
  `setDebounceMs` and inlay-hint / gas-estimate toggles flow through
  without a restart.
- **Status bar reflects server state.** A new `StatusBar` module
  subscribes to `solidity-workbench/serverState` notifications from the
  server and renders indexing progress, last-build result (✓ / errors /
  warnings), coverage percentage (when loaded), and anvil status.
  Clicking opens the output channel.
- **`foundry.toml` IntelliSense expanded** to `[rpc_endpoints]`,
  `[etherscan.*]`, `[fuzz]`, `[invariant]`, and a much larger surface of
  `[profile.*]` keys. Every key hover cites a specific Foundry Book
  section.
- **Inlay-hint call-site detection** now skips function / modifier /
  event / error declaration lines (previously those looked like calls
  to the regex) and walks parens / brackets / string literals when
  splitting argument lists, so nested calls like
  `transfer(address(0x1), 100)` split correctly.

### Distribution / polish

- **LICENSE file** (MIT) added.
- **CHANGELOG.md** added and kept in sync.
- **Extension icon** (128×128 PNG rasterized from `icon.svg` via a
  committed build script using `@resvg/resvg-js`). `galleryBanner`,
  `repository`, `bugs`, and `homepage` fields populated on
  `package.json`. CI verifies the PNG is up-to-date vs the SVG source
  and that the VSIX ships the icon.
- **Tag-gated publish workflow** (`.github/workflows/publish.yml`).
  Pushing `v*.*.*` runs build → vsce package → `vsce publish` →
  `ovsx publish` → GitHub Release. Uses `VSCE_PAT` / `OVSX_PAT`
  secrets; warns and skips publish cleanly when missing.
- **Telemetry disclaimer** in README: "Solidity Workbench collects
  zero telemetry" with an explicit list of every outbound network
  access attributable to the extension.
- **Provider tests added** for `DefinitionProvider`, `HoverProvider`,
  `SignatureHelpProvider`, `InlayHintsProvider`, `listTests`. Total
  test count: 111 → 135.

### Fixed while adding tests

- **InlayHintsProvider regex bug**: previously the
  `\b(\w+)\s*\(([^)]*)\)` regex couldn't see through nested calls and
  also fired on function declaration lines. Replaced with a
  paren-aware walker plus a declaration-line guard.

### Previously fixed (pre-sweep)

All of the following were closed prior to this sweep; retained here for
historical context:

- Regex parser → replaced with `@solidity-parser/parser` wrapper.
- Diagnostic byte-offset → line/column math via `LineIndex`.
- `forge build --format-json` → `--json`.
- VSIX packaging bundles the server; CI verifies `dist/server.js`.
- Broken `debuggers` contribution removed; terminal-backed debug
  commands remain.
- Chisel commands contributed in `package.json`.
- `keccak256` via `js-sha3`; TOML parsing via `toml`.
- Duplicated `getWordAtPosition` / `isInsideString` / keyword sets
  consolidated into `utils/text.ts`.
- Workspace watcher re-indexes on external file changes.
- Reference index O(1) backs `ReferencesProvider`.
- Symbol index covers free functions, file-level custom errors, UDVTs.
- NatSpec extraction parses `///` + `/** */` and surfaces everywhere.
- Semantic tokens: push order sorted; reference-site tokens included.
- Rename safety: unknown-identifier rename rejected clearly;
  `lib/` excluded.
- Call hierarchy captures the receiver qualifier.
- Linter `missing-zero-check` emits per-parameter diagnostics.
- Formatting temp file uses `crypto.randomUUID()`.
- Diagnostic file URIs use `URI.file(...)`.
- CI installs Foundry and runs the test suite against it.

---

## P1 — Critical (remaining)

None open. 135 tests pass; build is clean; VSIX bundles the server,
icon, and all providers; all previously-P1 blockers are closed.

---

## P2 — Important

### 1. Reentrancy / missing-event linters still use line-regex matching

Current rules in `SolidityLinter` (`checkReentrancy`,
`checkMissingEvents`, `checkStorageInLoop`) operate on `function.body`
as a string joined by `\n`. They fire on code inside `/* ... */` block
comments and miss state writes done through library calls
(`mapping.set(...)`). Acceptable today because all rules emit
`Warning` / `Information`, but should graduate to statement-level AST
matching before any rule emits `Error`.

**Effort**: 2–3 days.

### 2. Scope-aware rename for locals / parameters

`RenameProvider` refuses to rename identifiers that aren't in the
global symbol index (locals, parameters, free identifiers). With
`SolcBridge` wired into the hover / definition providers we now have
the building block to do scope-aware rename: the solc AST's
`referencedDeclaration` IDs give us the exact set of reference sites
for any local or parameter. Extend `provideRename` to use that path
when `prepareRename` would otherwise reject.

**Effort**: 2–3 days.

### 3. VSCode end-to-end tests

`@vscode/test-electron` is not wired up. We have no automated proof
that the extension activates, that `F12` returns a location, that
`forge fmt` edits apply, or that the status bar renders. The
sample-project fixture is ready to serve as the E2E workspace.

**Effort**: 2 days.

### 4. Deploy contract picker should use compiled artifacts

`deploy.ts::pickContract` regex-scans `src/**/*.sol` for
`contract Foo`. Should instead read `out/*.json` for the authoritative
list of deployable contracts and their constructor ABIs so the
constructor-args prompt can be type-checked.

**Effort**: 1 day.

### 5. Selector computation should canonicalize structs / UDTs

`canonicalType` in `code-lens.ts` doesn't flatten struct parameters to
their tuple form. Prefer `forge inspect <Contract> method-identifiers
--json` and cache the result per contract per build ID.

**Effort**: Half day.

### 6. Complete provider test coverage

We now have tests for `DefinitionProvider`, `HoverProvider`,
`SignatureHelpProvider`, `InlayHintsProvider`, and `listTests`. Still
missing:

- `CompletionProvider` (context detection, solc-backed member resolution)
- `AutoImportProvider` (candidate dedup, remapping preference)
- `DiagnosticsProvider` (solc JSON → diagnostics through `LineIndex`)
- `FormattingProvider` (stable behaviour under concurrent calls)
- `CodeActionsProvider` (implement-interface, add-natspec stubs)
- `LCOV parser` (from `packages/extension/src/views/coverage.ts`)

**Effort**: 2–3 days.

---

## P3 — Enhancement

### 7. Real DAP debugger

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

### 8. Migrate parsing hot path to Solar when it stabilizes

`paradigmxyz/solar` PR #401 is merged but not yet in a released Solar
crate. When Solar ships a stable LSP, evaluate swapping the parser +
resolver hot path via WASM for ~40× speed and true type resolution.

**Effort**: 2–3 weeks once Solar is ready.

### 9. Chisel webview with evaluation history

Current chisel integration is a terminal wrapper. A webview that
persists the session, shows structured output, and supports re-running
prior expressions would be much more useful.

**Effort**: 1 week.

### 10. Workspace symbol trigram / fuzzy index

`findWorkspaceSymbols` does a linear substring scan (now
cancellation-aware and capped at 100). A trigram index gives O(1)
lookup per character and supports fuzzy queries. Low priority until we
see slowness on large monorepos.

**Effort**: 2–3 days.

### 11. Aderyn / Wake / Mythril integrations alongside Slither

Current static analysis is Slither only. Wake and Aderyn are
increasingly popular; Mythril is the classic. Each has a different
output format and severity scheme to normalize.

**Effort**: 1 week per integration.

### 12. Subgraph scaffold generator

Read contract ABI, emit a starter `subgraph.yaml` + `schema.graphql` +
AssemblyScript mappings. Adjacent feature for protocol developers.

**Effort**: 3–5 days.

### 13. Remote chain interaction UI

Webview that wraps `cast call` / `cast send` against a chain picker,
with ABI awareness so args are typed. Unique differentiator nobody
else has.

**Effort**: 1 week.

---

## Summary

| Priority | Count | Cumulative effort |
|----------|-------|-------------------|
| P1 | 0 | — |
| P2 | 6 | ~2 weeks |
| P3 | 7 | ~2 months |
| **Total to public beta** | **0** | **ship the VSIX** |
| **Total to v1.0** | **6** | **~2 weeks** |

The extension is ready for a public beta. Everything the
pre-sweep review flagged as a P1 blocker is resolved: SolcBridge is
wired in, coverage is line-level, tests are LSP-backed, gas deltas
work, the icon ships, publishing is automated, cancellation is
honoured, and multi-root projects are supported. Remaining P2 items
are depth improvements — scope-aware rename, E2E tests, stricter
linter rules — none of which block shipping.
