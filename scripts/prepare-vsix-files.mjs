#!/usr/bin/env node
/**
 * Copy the repo-root README, LICENSE, and CHANGELOG into the extension
 * package so `vsce package` picks them up and the VS Code Marketplace
 * listing has a populated overview, license, and changelog tab.
 *
 * Run via `pnpm --filter solidity-workbench prepackage` or implicitly
 * through the `prepackage` npm lifecycle hook before `pnpm package`.
 * The copied files live in the gitignored set at
 * `packages/extension/{README.md,LICENSE,CHANGELOG.md}` so the
 * authoritative copies remain at the repo root.
 */
import { copyFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const EXT_ROOT = resolve(REPO_ROOT, "packages/extension");

const FILES = ["README.md", "LICENSE", "CHANGELOG.md"];

for (const name of FILES) {
  const src = resolve(REPO_ROOT, name);
  const dst = resolve(EXT_ROOT, name);
  if (!existsSync(src)) {
    console.error(`[prepare-vsix-files] missing source: ${src}`);
    process.exit(1);
  }
  copyFileSync(src, dst);
  console.log(`[prepare-vsix-files] ${name} -> packages/extension/${name}`);
}
