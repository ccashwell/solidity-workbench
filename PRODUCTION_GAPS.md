# Solidity Workbench: Remaining Gaps to v1.0

Updated after the April 2026 productionization pass. Every previously-tracked
P0 and P1 item from the original gap list is either fixed or superseded. This
document covers what's left.

## Severity Legend

- **P1 — Critical**: should fix before public beta
- **P2 — Important**: should fix for v1.0 quality
- **P3 — Enhancement**: nice-to-have, required for v2.0

---

## Recently fixed

The following issues from the pre-productionization gap list are now resolved:

- Regex parser → replaced with `@solidity-parser/parser` wrapper with error recovery (all 35 parser tests passing).
- Diagnostic byte-offset → line/column math: now handled by `LineIndex` with CRLF and UTF-8 correctness.
- `forge build --format-json` → `--json` (the flag the old code used never existed).
- VSIX packaging: server is now bundled into the VSIX via a second esbuild pass; CI verifies `dist/server.js` is present.
- Broken `debuggers` contribution: removed. Terminal-based debug commands remain.
- Chisel commands contributed in `package.json` so they appear in the Command Palette.
- `solidity-workbench.foundryPath` config is now plumbed to the LSP server and refreshed on change.
- `keccak256` selectors: real hash via `js-sha3`.
- `toml` package used for `foundry.toml` parsing (profile inheritance, inline tables).
- Duplicated `getWordAtPosition` / `isInsideString` / keyword sets: consolidated into `utils/text.ts`.
- Workspace watcher: `onDidChangeWatchedFiles` now reindexes on external file changes and reloads when `foundry.toml` / `remappings.txt` changes.
- Reference index wired: `ReferencesProvider` now uses the inverted index instead of an O(files × filesize) scan per query.
- Symbol index now covers free functions, file-level custom errors, and user-defined value types.
- NatSpec extraction: `///` and `/** */` docblocks parsed and attached to every definition; surfaced in hover and signature help.
- Semantic tokens: push order sorted; reference-site tokens added for state variables, parameters, functions, modifiers, events.
- Rename safety: unknown-identifier rename is rejected with a clear error; `lib/` directories are excluded from the edit set.
- Call hierarchy: captures the receiver qualifier on each call so `A.transfer()` and `B.transfer()` don't cross-contaminate.
- Linter `missing-zero-check`: one diagnostic per parameter, pointing at the parameter name.
- Formatting temp file: `crypto.randomUUID()` instead of `Date.now()`.
- Diagnostic file URIs: built via `URI.file(...)` so Windows paths aren't malformed.
- CI now installs Foundry and runs the test suite against it.

---

## P1 — Critical (remaining)

### 1. Wire `SolcBridge` rich AST into providers

**Current state**: `SolcBridge.buildAndExtractAst()` runs on save, caches per-file
AST in memory, but no provider consumes the cache. `DefinitionProvider`,
`HoverProvider`, `CompletionProvider.provideMemberCompletions`, and rename still
rely on the fast (`@solidity-parser/parser`) AST alone.

**Why it matters**: Without type resolution, member completions on variables
(`token.` where `token` is an `IERC20`) return nothing, and rename can't be made
scope-aware.

**Fix plan**:
1. In `DefinitionProvider.provideDefinition`: if the symbol index has multiple
   candidates, consult `solcBridge.resolveReference(filePath, offset)` for the
   authoritative declaration.
2. In `HoverProvider`: consult `solcBridge.getTypeAtOffset(filePath, offset)`
   for the resolved type string when the fast AST can't infer it.
3. In `CompletionProvider.provideMemberCompletions`: when the token before `.`
   is a variable, look up its type via `SolcBridge`, then enumerate members of
   that type.
4. In `RenameProvider`: when the cursor is on a local variable or parameter,
   use `referencedDeclaration` IDs from the solc AST to compute the exact set
   of references to rename.

**Effort**: 3-5 days.

### 2. Test-Explorer should use the LSP's AST, not regex

**Current state**: `FoundryTestProvider.parseTestFile` re-parses every test file
with regex + brace counting. Breaks on braces inside strings or multiline
function headers.

**Fix plan**: Add a custom LSP request (e.g. `solidity-workbench/listTests`) that the
extension calls to enumerate test contracts and functions from the already-parsed
AST. Or: reuse `@solidity-parser/parser` on the client side directly.

**Effort**: 1 day.

### 3. Coverage should be line-level, not file-level

**Current state**: `CoverageProvider` parses `forge coverage --report summary`
and renders a single banner line per file. Users can't see which lines are
covered.

**Fix plan**: Switch to `forge coverage --report lcov --report-file lcov.info`
and parse LCOV (DA records for lines, BRDA for branches, FN/FNDA for functions).
Render line-level decorations with the existing covered/uncovered/partial styles.

**Effort**: 1 day.

### 4. Gas profiler doesn't compute deltas

**Current state**: `GasEntry.delta` is declared but never populated. The
"regression tracker" promised in docs doesn't exist.

**Fix plan**: Persist the last successfully-loaded snapshot in the extension's
global state (`context.globalState`). Diff on refresh. Color arrows by sign.

**Effort**: 2 hours.

---

## P2 — Important

### 5. Multi-root workspace support

Server initializes with `workspaceFolders[0]?.uri ?? params.rootUri`. Multi-root
setups see only the first folder. Need `workspace/didChangeWorkspaceFolders` and
per-root state (foundry.toml, remappings, symbol index).

**Effort**: 1-2 days.

### 6. Provider test coverage

We have parser, linter, text-utils, line-index, symbol-index, reference-index,
rename, semantic-tokens, and call-hierarchy tests. Still missing:

- `DefinitionProvider` (cross-file, remappings, dotted access)
- `HoverProvider` (natspec surfacing, builtin members)
- `CompletionProvider` (context detection, member resolution)
- `SignatureHelpProvider` (arg parsing through nested calls, overloads)
- `InlayHintsProvider` (argument name hints with nested calls)
- `CodeActionsProvider` (implement-interface, add-natspec stubs)
- `AutoImportProvider` (candidate dedup, remapping preference)
- `DiagnosticsProvider` (solc JSON → diagnostics mapping through `LineIndex`)
- `FormattingProvider` (stable behavior under concurrent calls)

**Effort**: 3-4 days.

### 7. VSCode end-to-end tests

`@vscode/test-electron` is not configured. We have no automated smoke tests that
the extension actually activates or that LSP requests succeed inside a real
editor.

**Effort**: 2 days.

### 8. Completion of members through variable type resolution

`provideMemberCompletions` handles `ContractName.|` but not `instance.|` where
`instance` is a variable of a contract type. Depends on P1 #1 (SolcBridge wiring).

### 9. Deploy contract picker via compiled artifacts

Current picker regex-scans `src/` for `contract Foo`. Should read `out/*.json`
from the forge build to get the authoritative list of deployable contracts and
their constructor ABI.

**Effort**: 1 day.

### 10. `rpc_endpoints` / `etherscan` / `fuzz.*` / `invariant.*` in foundry.toml IntelliSense

`FoundryTomlProvider` schema currently covers only top-level keys plus `[fmt]`.

**Effort**: 1 day.

### 11. Selector computation canonicalizes structs and UDTs

`canonicalType` in `code-lens.ts` doesn't flatten struct parameters to their
tuple form. For displayed selectors, prefer `forge inspect <Contract>
method-identifiers --json` and cache the result.

**Effort**: Half day.

### 12. Cancellation token support across providers

Long-running references / rename / semantic-tokens queries don't observe
`params.token`. They should early-exit when the client cancels.

**Effort**: 1 day.

### 13. Status bar reflects server state

Currently static. Should show: LSP ready/error, latest forge build result,
active anvil, coverage %, snapshot delta summary.

**Effort**: 1 day.

### 14. Extension icon, README, CHANGELOG, marketplace screenshots

None exist. Required for a credible marketplace listing.

**Effort**: 1-2 days including design.

### 15. Reentrancy / missing-event linters use stricter AST matching

Current linters are line-regex heavy; use the parser's statement AST to reduce
false positives. P2 because current behavior is best-effort hints, not errors.

**Effort**: 2-3 days.

---

## P3 — Enhancement

### 16. Real DAP debugger

Today's "debugger" is three terminal-wrapped `forge debug` / `forge test --debug`
invocations. The `debuggers` contribution that used to be in `package.json` was
removed because the DAP factory returned `undefined`.

Building a real DAP adapter means:

1. Launch forge with trace output (`-vvvvv --json`).
2. Parse the source map from compiled artifacts (`out/Contract.sol/Contract.json`
   `sourceMap` + `generatedSources`).
3. Walk EVM opcodes step-by-step, mapping back to Solidity source positions.
4. Implement DAP `stackTrace`, `scopes`, `variables`, `stepIn`/`stepOut`/`stepOver`.
5. Expose storage and memory reads as "globals".

**Effort**: 3-4 weeks. Simbolik is the commercial gold standard here.

### 17. Migrate to Solar LSP when it releases

`paradigmxyz/solar` PR #401 is merged but not yet in a released Solar crate
(status as of April 2026). When Solar ships a stable LSP, evaluate swapping the
parser/resolver hot path via WASM or native addon for ~40× speed and real type
resolution.

**Effort**: 2-3 weeks once Solar is ready.

### 18. Chisel webview with evaluation history

Current chisel integration is a terminal wrapper. A webview that persists the
session, shows structured output, and supports re-running prior expressions
would be much more useful.

**Effort**: 1 week.

### 19. Workspace symbol trigram / fuzzy index

`findWorkspaceSymbols` does a linear substring scan capped at 100 results. A
trigram index gives O(1) lookup per character and supports fuzzy queries. Low
priority until we see slowness on large monorepos.

**Effort**: 2-3 days.

### 20. Publish workflow

Package workflow exists (and verifies server bundling). Still need:

- `vsce publish` step gated on a tag push.
- Open VSX publish for Cursor / VSCodium users.
- Publisher `uniswap` must be registered and have credentials in CI secrets.

**Effort**: Half day of workflow + whatever it takes to reserve the publisher.

### 21. Aderyn / Wake / Mythril integrations alongside Slither

Current static analysis is Slither only. Wake and Aderyn are increasingly
popular; Mythril is the classic. Each has a different output format and
severity scheme to normalize.

**Effort**: 1 week per integration.

### 22. Subgraph scaffold generator

Read contract ABI, emit a starter `subgraph.yaml` + `schema.graphql` +
AssemblyScript mappings. Useful adjacent feature for protocol developers.

**Effort**: 3-5 days.

### 23. Remote chain interaction UI

Webview that wraps `cast call` / `cast send` against a chain picker, with ABI
awareness so args are typed. Unique differentiator nobody else has.

**Effort**: 1 week.

---

## Summary

| Priority | Count | Cumulative effort |
|----------|-------|-------------------|
| P1 | 4 | ~1 week |
| P2 | 11 | ~3 weeks |
| P3 | 8 | ~2 months |
| **Total to public beta** | **4** | **~1 week** |
| **Total to v1.0** | **15** | **~1 month** |

The previously-listed P0 blockers are all resolved; the extension now activates,
bundles correctly, sends real diagnostics, and 111 unit tests pass. Remaining
work is about depth (type-resolved navigation via Solc AST, line-level coverage,
DAP debugger) rather than correctness of the core scaffolding.
