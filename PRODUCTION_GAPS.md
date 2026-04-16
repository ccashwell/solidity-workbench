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

## P3 — Enhancement

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

### 3. Chisel webview with evaluation history

Current chisel integration is a terminal wrapper. A webview that
persists the session, shows structured output, and supports re-running
prior expressions would be much more useful.

**Effort**: 1 week.

### 4. Workspace symbol trigram / fuzzy index

`findWorkspaceSymbols` does a linear substring scan (now
cancellation-aware and capped at 100). A trigram index gives O(1)
lookup per character and supports fuzzy queries. Low priority until we
see slowness on large monorepos.

**Effort**: 2–3 days.

### 5. Aderyn / Wake / Mythril integrations alongside Slither

Current static analysis is Slither only. Wake and Aderyn are
increasingly popular; Mythril is the classic. Each has a different
output format and severity scheme to normalize.

**Effort**: 1 week per integration.

### 6. Subgraph scaffold generator

Read contract ABI, emit a starter `subgraph.yaml` + `schema.graphql` +
AssemblyScript mappings. Adjacent feature for protocol developers.

**Effort**: 3–5 days.

### 7. Remote chain interaction UI

Webview that wraps `cast call` / `cast send` against a chain picker,
with ABI awareness so args are typed. Unique differentiator nobody
else has.

**Effort**: 1 week.

### 8. More E2E coverage

The E2E scaffold runs 6 smoke tests in ~3s locally. Natural next
additions: rename round-trip, code-action application, test-explorer
discovery after a `forge build`, coverage decoration rendering,
storage-layout webview HTML shape. Tracked here so future work
extends the suite rather than reinventing the scaffold.

**Effort**: 1–2 days ongoing.

---

## Summary

| Priority | Count | Cumulative effort |
|----------|-------|-------------------|
| P1 | 0 | — |
| P2 | 0 | — |
| P3 | 8 | ~2 months |
| **Total to public beta** | **0** | **ship the VSIX** |
| **Total to v1.0** | **0** | **ship the VSIX** |

As of this sweep there are no open P1 or P2 items. Every concern the
post-MVP review raised has landed: AST-based linting eliminates the
comment / multiline false positives; locals / parameters rename via
SolcBridge; selectors come from `forge build` output; the deploy
picker offers type-aware constructor prompts; and there's a real
`@vscode/test-electron` suite running in CI. The remaining work is
strictly P3 — nice-to-haves and v2.0 stretch items.
