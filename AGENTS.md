# AGENTS.md — Solidity Workbench steering document

Read this before touching the codebase. It captures the architecture, the
moving parts, the invariants that aren't immediately obvious from the file
tree, and the exact commands needed to build, test, package, and debug the
extension end-to-end.

---

## What this project is

A Foundry-native Solidity IDE distributed as a single VS Code / Cursor
extension. It combines a TypeScript **LSP server** (17 providers) with a
thin extension **client** (commands, webviews, test explorer, status bar).

Positioning — we are deliberately **not** a Hardhat/Truffle competitor.
Every feature assumes `forge`, `cast`, `anvil`, and `chisel` exist on
`PATH`. When in doubt, design for the Foundry path and leave Hardhat to
Nomic Foundation's extension.

- License: MIT, author: Chris Cashwell
- GitHub: `ccashwell/solidity-workbench`
- Marketplace publisher: `ccashwell`
- Engines: VS Code `^1.85.0`, Node `>=18`

---

## Repository layout

```
solidity-workbench/
├── packages/
│   ├── common/          Shared types, custom LSP messages, LCOV parser
│   ├── server/          LSP server — run via Node over stdio
│   └── extension/       VS Code client — bundles server.js into the VSIX
├── scripts/
│   ├── build-icon.mjs           SVG → PNG for the marketplace icon
│   └── prepare-vsix-files.mjs   Copy README/LICENSE/CHANGELOG into packages/extension/ before vsce
├── test/fixtures/       Sample Foundry project for E2E tests
├── ARCHITECTURE.md      Design rationale (long-form)
├── PRODUCTION_GAPS.md   Severity-tagged backlog (P1/P2 cleared; P3 remaining)
├── CHANGELOG.md         Keep-a-Changelog format; all recent work under [Unreleased]
└── README.md            User-facing docs; shipped in the VSIX
```

Workspace manager: **pnpm** (`pnpm@8.15.0`). TypeScript project references
wire the packages together — do not use raw `tsc` without `-b`.

---

## Architecture in one picture

```
VS Code extension host  ──┐
  ├─ commands/            │  forge, cast, anvil, chisel, script, deploy
  ├─ views/               │  status bar, gas profiler, coverage overlays,
  │                       │  storage layout webview, chisel, foundry.toml IntelliSense
  ├─ test-explorer/       │  VS Code Test API integration (listTests LSP request)
  ├─ analysis/            │  Slither bridge
  └─ LanguageClient ──── stdio ──── dist/server.js (bundled from packages/server)

LSP server (packages/server)
  ├─ server.ts            initialize handler, capability advertisement, dispatch
  ├─ providers/*          17 providers — one class per LSP capability
  ├─ analyzer/            SymbolIndex (cross-file symbols) + ReferenceIndex (inverted)
  ├─ parser/              @solidity-parser/parser wrapper + mapped SoliditySourceUnit
  ├─ compiler/            SolcBridge — type-resolved AST from `forge build --json`
  ├─ workspace/           WorkspaceManager — multi-root, foundry.toml, remappings, forge spawner
  └─ utils/               LineIndex (UTF-8-safe byte↔Position), text helpers

Shared (packages/common)
  ├─ types.ts             SoliditySourceUnit, ContractDefinition, NatspecComment, SolSymbol, …
  ├─ protocol.ts          Custom LSP messages + semantic token legend
  ├─ foundry-config.ts    foundry.toml schema
  └─ lcov.ts              LCOV parser (used by the coverage view client-side)
```

### Dual-AST strategy (important)

Two complementary ASTs drive every provider:

| AST | Source | When | Used by |
| --- | --- | --- | --- |
| **Parser AST** (`SolidityParser`) | `@solidity-parser/parser`, tolerant | Every keystroke | Everything — completion, diagnostics (fast tier), semantic tokens, symbols, linter, hover fallback |
| **Solc AST** (`SolcBridge`) | `forge build --json` on save | After first successful build | Overload disambiguation, receiver-typed member resolution, scope-aware rename for locals, canonical selectors |

A provider that needs type info checks `SolcBridge` first, then falls back
to parser-only logic — never require solc; the extension must be useful
before the first build completes.

---

## Commands — build, test, package

All commands run from the repo root.

```bash
pnpm install                       # Sets up the pnpm workspace
pnpm build                         # common → server → extension (esbuild bundle)
pnpm watch                         # Parallel rebuild on change
pnpm test                          # Runs the server's node --test suite
pnpm lint                          # ESLint over packages/*/src/**/*.ts
pnpm format:check                  # Prettier check (use `pnpm format` to fix)
pnpm package                       # Produces packages/extension/solidity-workbench-*.vsix
pnpm --filter solidity-workbench test:e2e   # VS Code E2E via @vscode/test-electron
```

### The package pipeline is load-bearing — don't shortcut it

`pnpm package` runs three steps in order:

1. `pnpm build:icon` — rasterizes `packages/extension/resources/icon.svg` → `icon.png`.
   CI checks the PNG for drift; if you edit the SVG, commit the regenerated PNG.
2. `node scripts/prepare-vsix-files.mjs` — copies `README.md`, `LICENSE`, `CHANGELOG.md`
   from the repo root into `packages/extension/`. Those copies are **gitignored**
   (see `.gitignore`) — the authoritative files live at the repo root.
   The VSIX needs them present or the Marketplace listing tabs render blank.
3. `vsce package --no-dependencies` — produces the VSIX from the extension package.

CI verifies the VSIX's contents (required: `dist/extension.js`, `dist/server.js`,
`icon.png`, `README.md`, `LICENSE`, `CHANGELOG.md`; forbidden: anything under
`dist/test/**`). Edit `.github/workflows/ci.yml` and `publish.yml` together when
changing the VSIX shape.

### Running in a dev host

1. Open the repo in VS Code
2. Press `F5` — launches an Extension Development Host with the extension loaded
3. Open `test/fixtures/sample-project/` (or any Foundry repo) in the host
4. `pnpm watch` for live rebuilds; `Ctrl+R` / `Cmd+R` in the host to reload

---

## Key invariants and conventions

### Providers are single-class modules under `packages/server/src/providers/`

Each provider exports one class named `<Feature>Provider` with `provide*`
methods that match the LSP capability names. Providers are instantiated in
`server.ts` and wired to their dependencies via the constructor or a
`setSolcBridge()` setter (for the five providers that need type info).

When adding a new provider:
1. Create `packages/server/src/providers/<feature>.ts`
2. Instantiate + wire it in `server.ts`
3. Add the capability to the `InitializeResult.capabilities` object
4. Register the LSP handler near the bottom of `server.ts`
5. Write tests in `packages/server/src/__tests__/<feature>.test.ts`

### LSP capability advertisement must match the wired handlers

Every `InitializeResult.capabilities` entry must have a matching
`connection.on<X>` handler, and vice versa. A mismatch causes "unexpected
type" or silent failure on the client — a whole class of bugs we've hit
more than once (`implementationProvider` was advertised without a handler;
`compileOnSave` was declared in `ServerSettings` but never read).

### Receiver-aware lookups for dotted access

When a provider needs to resolve `Receiver.member` (hover, inlay hints,
definition, code actions), **always** consult the receiver through
`SymbolIndex` before doing a global name lookup. The naïve pattern:

```ts
const symbols = this.symbolIndex.findSymbols(memberName); // WRONG for dotted
```

will silently pick a same-named method from an unrelated type. Correct
pattern:

```ts
const chain = this.symbolIndex.getInheritanceChain(receiverName);
for (const c of chain) {
  const hit = c.functions.find((f) => f.name === memberName);
  if (hit) return hit;
}
return null; // prefer no result over a wrong result
```

UDVT builtins (`Currency.wrap` / `Currency.unwrap`) need special handling:
check for `kind === "userDefinedValueType"` on the receiver and either
synthesise a hover or return empty (inlay hints).

### Settings live under `solidity-workbench.*`

Every user setting must appear in three places:
1. `packages/extension/package.json` → `contributes.configuration.properties`
2. `packages/server/src/server.ts` → `ServerSettings` interface (if the server reads it)
3. `packages/extension/src/config.ts` → typed accessor (if the extension reads it)

Settings that are declared but never read are worse than missing ones —
they promise behavior that doesn't exist. CI doesn't catch this; be careful.

### Commands must be registered AND contributed

Commands the user can invoke from the palette must be in
`contributes.commands` in `package.json`. Internal shim commands (e.g.
`solidity-workbench.findReferencesAt`) that are only invoked
programmatically from code lenses can be registered via
`vscode.commands.registerCommand` without a manifest entry — they won't
appear in the palette.

### URIs cross the stdio boundary as strings

LSP transports URIs as strings. VS Code commands like
`editor.action.findReferences` expect real `vscode.Uri` instances. When a
code lens needs to invoke such a command, emit a thin client-side shim
that parses the string into `vscode.Uri` before calling through. The
`findReferencesAt` shim in `packages/extension/src/extension.ts` is the
canonical example.

### Tests use Node's built-in runner

No Mocha/Jest/Vitest for unit tests — just `node --test` against compiled
`.js` files in `dist/__tests__/`. Tests must run through a full `tsc -b`
cycle before they execute; `pnpm test` handles that automatically.

Mock workspace helper pattern:

```ts
function makeFakeWorkspace() {
  return {
    getAllFileUris: () => [],
    uriToPath: (uri: string) => URI.parse(uri).fsPath,
  } as unknown as WorkspaceManager;
}
```

Every provider test file uses this exact shape — copy it, don't
reinvent.

### Raw AST vs mapped AST for semantic tokens

`SemanticTokensProvider` is the one provider that drives off the **raw**
`@solidity-parser/parser` AST instead of the mapped `SoliditySourceUnit`.
This is because the raw AST carries precise `loc` info on every sub-node
(including `.identifier.loc` on variable declarations and `.typeName.loc`
on type references), and the mapped AST's `nameRange` heuristic is too
coarse for per-identifier tokenization. If you add tokenization for a new
construct, follow the same raw-AST pattern.

### Diagnostics are tiered; don't merge the tiers

- **Fast** (`onDidChangeContent`): parser + lint + a few regex-ish sanity checks. Must stay under ~30ms.
- **Full** (`onDidSave`): `forge build --json`, mapped through `LineIndex`. Respects `diagnostics.compileOnSave`.

Never call `forge build` from the fast tier. Never run the linter on save
unconditionally — it's already in the fast tier.

---

## Publishing flow

Publishing is tag-gated in `.github/workflows/publish.yml`. The tag must
be `v<X.Y.Z>` and must match the `version` field in
`packages/extension/package.json` exactly. The workflow:

1. Verifies tag ↔ version parity
2. Builds, packages, and verifies VSIX contents
3. Publishes to VS Code Marketplace via `VSCE_PAT` secret
4. Publishes to Open VSX via `OVSX_PAT` secret
5. Attaches the VSIX to a GitHub Release

Both tokens are optional — missing tokens produce a CI warning but don't
fail the job. The GitHub Release always happens.

Publisher is `ccashwell`. Do **not** change the publisher without
coordinating the Azure DevOps PAT.

---

## Common pitfalls (learned the hard way)

| Pitfall | Symptom | Fix |
| --- | --- | --- |
| Advertising an LSP capability with no handler | "unexpected type" or silent no-op on the client | Remove the advertisement or add the handler |
| Declaring a setting that no code reads | User toggles it, nothing happens | Either implement it or remove it from `package.json` |
| Passing an LSP-wire URI string to a VS Code command | "unexpected type" | Use a client-side shim that `vscode.Uri.parse`s it |
| Using `findSymbols(name)` for dotted access | Wrong same-named method picked | Walk the receiver's inheritance chain first, return null on miss |
| Only tokenizing declaration **names** in semantic tokens | Struct members, params, type refs render unstyled | Walk the raw AST; use `.identifier.loc` and `.typeName.loc` |
| Static elementary-type list for hover | `uint8`/`uint128`/`bytes16` silently unsupported | Recognise the family programmatically (`/^uint(\d+)$/`, etc.) |
| `.vscodeignore` `!` negations + broader exclusions | Dead files leak into the VSIX | Prefer positive allow-lists like `!dist/extension.js` over `!dist/**/*.js` + `dist/test/**` |
| Forgetting to bump the icon PNG | CI fails the icon-drift check | `pnpm build:icon` and commit the result |

---

## Agent preferences learned in prior sessions

- When reviewing code for findings, **resolve them immediately** — do not stop at "here's a list of issues."
- Commit scope should match logical change boundaries, not sweep everything into one `WIP` commit.
- Use the `continual-learning` workflow to persist durable facts across sessions — this document is the primary output.
- Prefer conventional-commit-style messages (`fix(scope): …`, `feat(scope): …`) with a short body explaining _why_.

---

## Where to look for things

| Need to… | Look at |
| --- | --- |
| Add a new LSP provider | `packages/server/src/providers/*.ts` + `server.ts` wiring |
| Add a Foundry command | `packages/extension/src/commands/` (one file per subsurface) |
| Add a webview/tree view | `packages/extension/src/views/` |
| Change the hover blurb for a built-in type | `packages/server/src/providers/hover.ts` → `describeElementaryType` / `getBuiltinHover` |
| Add a security linter rule | `packages/server/src/providers/linter.ts` |
| Add a custom LSP message | `packages/common/src/protocol.ts` |
| Change the VSIX shape | `packages/extension/.vscodeignore`, `packages/extension/package.json`, both CI workflows |
| Change the semantic-tokens legend | `packages/common/src/protocol.ts` → `SolSemanticTokenTypes` / `…Modifiers` |
| Understand the rationale for a design choice | `ARCHITECTURE.md` (long-form) and `PRODUCTION_GAPS.md` (what's intentionally deferred) |
