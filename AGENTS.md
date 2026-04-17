## Learned User Preferences

- When reviewing code, immediately resolve identified findings rather than just reporting them
- Use the continual-learning workflow to persist durable facts across sessions

## Learned Workspace Facts

- pnpm monorepo with three packages: `packages/common` (shared types, LCOV parser, custom LSP protocol), `packages/server` (LSP server, 17 providers), `packages/extension` (VSCode client, commands, webviews)
- Build order: common → server → extension; run with `pnpm build` (esbuild bundled)
- Test: `pnpm test` runs 181 unit tests via `node --test`; E2E via `pnpm --filter solidity-workbench test:e2e` using `@vscode/test-electron`
- Lint/format: `pnpm lint` (ESLint), `pnpm format:check` (Prettier)
- Package VSIX: `pnpm package`
- CI: GitHub Actions on Node 18/20/22 matrix with Foundry installed; tag-gated publish to Marketplace and Open VSX
- Architecture: LSP server over stdio; dual-AST strategy — fast `@solidity-parser/parser` for keystroke features, rich solc AST via `forge build --json` on save for type-resolved features
- Foundry-native by design — no Hardhat/Truffle support; assumes `forge`, `cast`, `anvil`, `chisel` on PATH
- Zero telemetry; LSP server never opens a network socket
- License: MIT, author: Chris Cashwell
- GitHub org: `ccashwell/solidity-workbench`
