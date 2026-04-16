# Changelog

All notable changes to Solidity Workbench are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
