# Solforge: Gaps from Here to Production

Comprehensive gap analysis based on a full codebase audit (April 2026).

## Severity Legend

- **P0 — Blocking**: Must fix before any user can test this
- **P1 — Critical**: Must fix before public beta
- **P2 — Important**: Should fix for v1.0 quality
- **P3 — Enhancement**: Nice-to-have for v1.0, required for v2.0

---

## P0 — Blocking

### 1. Replace Regex Parser with Real AST Parser

**Current state**: The entire LSP server relies on a regex-based structural
extractor (`parser/solidity-parser.ts`). This breaks on:
- Multiline contract declarations (`contract Foo\n  is Bar, Baz`)
- Nested mappings (`mapping(address => mapping(bytes32 => uint))`)
- Complex function signatures with tuple returns
- Constructor initializer lists
- Assembly blocks (treated as opaque)

**Fix**: Integrate `@solidity-parser/parser` (already in package.json as a
dependency, never imported). The ANTLR4 parser handles all Solidity syntax
correctly with error recovery.

**Effort**: 2-3 days. Build an adapter that maps `@solidity-parser/parser`'s
AST to our `SoliditySourceUnit` type, preserving the cache and incremental
update interface.

### 2. Fix Diagnostic Source Mapping (Byte Offset → Line/Col)

**Current state**: `diagnostics.ts:parseSolcError()` receives byte offsets
from solc but maps them all to `line: 0, character: 0`. Every solc error
appears at the top of the file.

**Fix**: Convert byte offsets to line/column using a simple offset-to-position
lookup table built from `text.split("\n")` line lengths.

**Effort**: 1-2 hours.

### 3. Register Missing Extension Commands

**Current state**: Several commands referenced in code lens and other
providers are never registered in the extension:
- `solforge.copySelector` (created in code-lens but never registered)
- Various debug/deploy commands may have registration gaps

**Fix**: Audit every `command:` string in the server-side code lens provider
against the extension's registered commands. Register any missing ones.

**Effort**: 1-2 hours.

---

## P1 — Critical

### 4. Eliminate Duplicated Code

**Current state**: `getWordAtPosition()` is duplicated 7 times across
different provider files. The same Solidity keyword set appears in 4+
different files with slightly different contents. `isInsideString()` is
duplicated 3 times.

**Fix**: Already created `packages/server/src/utils/text.ts` with shared
implementations. Remaining work: update all providers to import from it
and delete their local copies.

**Effort**: 2-3 hours.

### 5. Implement Actual Function Selector Computation

**Current state**: `code-lens.ts:computeSelector()` and
`computeEventTopic()` return the human-readable signature string instead
of the actual keccak256 hash. The code comments say "actual keccak256 would
need a crypto library."

**Fix**: Use Node.js built-in `crypto.createHash('sha3-256')` or add the
lightweight `js-sha3` package. Compute `keccak256(signature).slice(0, 4)`
for function selectors and full `keccak256(signature)` for event topics.

**Effort**: 1 hour.

### 6. Fix `isAddressLike()` Stub

**Current state**: `completion.ts:isAddressLike()` always returns `false`,
so address member completions (`.balance`, `.call()`, `.transfer()`, etc.)
never trigger for variables.

**Fix**: Check the symbol index for the variable's type. If it resolves to
`address` or `address payable`, return true. As a heuristic fallback, check
if the variable name contains "addr", "recipient", "sender", etc.

**Effort**: 1 hour.

### 7. Complete `formatRange()` Implementation

**Current state**: `formatting.ts:formatRange()` formats the entire document
because `forge fmt` doesn't support range formatting.

**Fix**: Format the entire document with `forge fmt`, then diff against
the original and return only the TextEdits that fall within the requested
range. This gives correct range-formatting behavior.

**Effort**: 2 hours.

### 8. Add Call Graph Cache Invalidation

**Current state**: `call-hierarchy.ts` builds the call graph on first use
and never invalidates it. File changes after the first query are invisible.

**Fix**: Listen for `documents.onDidChangeContent` and mark affected files
as dirty. Rebuild the call graph lazily on next query.

**Effort**: 2 hours.

---

## P2 — Important

### 9. Proper Error Handling Strategy

**Current state**: Error handling is inconsistent across providers:
- Some swallow errors silently (empty `catch {}`)
- Some return `null` vs empty arrays inconsistently
- No user-facing error messages for provider failures
- No telemetry or error reporting

**Fix**: Define a consistent pattern:
1. Log all caught errors to the LSP connection console
2. Return appropriate empty values (null for single results, [] for lists)
3. Add a `connection.window.showMessage` for actionable user errors
4. Never use empty `catch {}` — always log

**Effort**: 4-6 hours to audit and fix all providers.

### 10. Improve Linter Accuracy

**Current state**: The custom linter has several false-positive sources:
- Reentrancy check doesn't understand `nonReentrant` modifier
- Missing zero-check flags any `require` as a zero check
- Storage-in-loop warns even for single reads per iteration
- No way to suppress individual warnings

**Fix**:
1. Check for `nonReentrant` in function modifiers before flagging reentrancy
2. Actually parse the `require` condition to verify it's a zero check
3. Track variable access count in loops — only warn for multiple reads
4. Support `// solforge-disable-next-line` suppression comments

**Effort**: 1-2 days.

### 11. Add Proper TOML Parser

**Current state**: `workspace-manager.ts:parseFoundryToml()` uses regex
to extract foundry.toml values. This breaks on:
- Multiline strings
- Inline tables
- Array values spanning multiple lines
- Profile inheritance (`[profile.ci]` inheriting from `[profile.default]`)

**Fix**: Use the `toml` package (already in package.json, never imported).

**Effort**: 2 hours.

### 12. Test Suite

**Current state**: Zero tests. No unit tests, no integration tests,
no E2E tests.

**Fix**:
1. Unit tests for the parser (known inputs → expected AST)
2. Unit tests for each LSP provider (mock documents → expected responses)
3. Integration tests using `vscode-languageserver-textdocument` in-memory
4. E2E tests using `@vscode/test-electron` for the extension client

Priority test coverage:
- Parser: 20+ test cases covering all contract/function/event patterns
- Diagnostics: verify correct source positions
- Completions: verify context detection and member resolution
- Definition: verify cross-file navigation with remappings

**Effort**: 3-5 days for meaningful coverage.

### 13. Clean Up Dead Code

**Current state**:
- `definition.ts:provideReferences()` exists but is superseded by
  `references.ts:ReferencesProvider`
- `solc-bridge.ts:buildStandardInput()` is never called
- `solc-bridge.ts:compileSingle()` references `inputJson` but doesn't use it
- Unused `import type` statements after lint fix

**Fix**: Remove all dead code paths and unused functions.

**Effort**: 1 hour.

### 14. Performance Optimization

**Current state**:
- References provider does O(n×m) scan on every query (n files, m = file size)
- Symbol index does linear scans for workspace symbol search
- No incremental parsing — full re-parse on every keystroke
- No caching of forge build output between saves

**Fix**:
1. Build an inverted index for references (pre-computed per file on parse)
2. Use a trie or fuzzy matcher for workspace symbol search
3. Implement incremental parsing with the ANTLR4 parser's error recovery
4. Cache forge build output and only rebuild changed files

**Effort**: 1-2 weeks for significant impact.

---

## P3 — Enhancement

### 15. Migrate to Solar/Rust for Parser Hot Path

**Current state**: TypeScript-based parser with regex extraction.

**Fix**: When Paradigm's Solar compiler exposes stable Rust crates with WASM
bindings, replace the parser and type resolver with Solar's implementation.
This would give us:
- 40x faster parsing
- Full type resolution (no more regex guessing)
- Scope-aware reference resolution
- Accurate cross-contract call resolution

**Status**: Solar's LSP has 0/6 tracked subtasks as of April 2026. Monitor
`paradigmxyz/solar#394` for progress.

**Effort**: 2-3 weeks when Solar is ready.

### 16. Full DAP Debugger Implementation

**Current state**: Debugger uses terminal-based `forge debug` / `forge test
--debug`. No stepping, no variable inspection, no breakpoints in the editor.

**Fix**: Implement a proper Debug Adapter Protocol server that:
1. Launches forge with trace output
2. Parses source maps to map EVM opcodes to Solidity lines
3. Implements step/continue/breakpoint via the DAP protocol
4. Surfaces local variables, storage, and memory state

**Effort**: 2-4 weeks. Requires deep EVM source map understanding.

### 17. Chisel REPL Integration

**Current state**: Not implemented.

**Fix**: Add a webview panel or terminal integration for Foundry's Chisel
REPL. Allow users to evaluate Solidity expressions in-context with the
current project's contracts available.

**Effort**: 1 week.

### 18. Multi-root Workspace Support

**Current state**: Server assumes a single workspace root.

**Fix**: Handle `workspace/didChangeWorkspaceFolders` and maintain per-root
state (foundry.toml, remappings, symbol index).

**Effort**: 1-2 days.

### 19. Foundry.toml Intellisense

**Current state**: No language support for foundry.toml itself.

**Fix**: Register a TOML language contribution with a JSON schema for
`foundry.toml` so users get completions, validation, and hover docs for
Foundry configuration keys.

**Effort**: 1-2 days.

### 20. VS Code Marketplace Publishing Pipeline

**Current state**: No CI/CD, no packaging, no marketplace listing.

**Fix**:
1. GitHub Actions workflow: lint → test → build → package `.vsix`
2. Automated publishing to VS Code Marketplace
3. Also publish to Open VSX (for Cursor and other editors)
4. Extension icon, README, screenshots, changelog

**Effort**: 1-2 days.

---

## Summary

| Priority | Count | Effort Estimate |
|----------|-------|-----------------|
| P0 — Blocking | 3 | 3-4 days |
| P1 — Critical | 5 | 1-2 days |
| P2 — Important | 6 | 2-3 weeks |
| P3 — Enhancement | 6 | 1-2 months |
| **Total to public beta** | **8** | **~1 week** |
| **Total to v1.0** | **14** | **~1 month** |

The single most impactful change is **replacing the regex parser with
`@solidity-parser/parser`** (P0 #1). This unlocks correctness for every
downstream feature — completions, definition, references, semantic tokens,
code actions, and the linter all depend on parse quality.
