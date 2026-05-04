/**
 * Re-export the canonical LineIndex from `@solidity-workbench/common`.
 *
 * The implementation moved to common so both the LSP server (for
 * mapping forge-build diagnostics) and the extension's DAP debug
 * adapter (for mapping source-map byte ranges to file:line) share
 * one source of truth. Existing imports under `../utils/line-index.js`
 * continue to work via this shim.
 */
export { LineIndex } from "@solidity-workbench/common";
