#!/usr/bin/env node
/**
 * Verify the packaged VSIX contains exactly the runtime files we expect.
 *
 * This is intentionally shared by local checks, CI, and publish workflows so
 * the release artifact contract cannot drift between shell snippets.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const EXT_ROOT = resolve(REPO_ROOT, "packages/extension");
const pkg = JSON.parse(readFileSync(resolve(EXT_ROOT, "package.json"), "utf8"));
const vsixPath = resolve(EXT_ROOT, `solidity-workbench-${pkg.version}.vsix`);

if (!existsSync(vsixPath)) {
  fail(`Expected VSIX was not produced: ${relative(vsixPath)}`);
}

const listing = execFileSync("unzip", ["-Z1", vsixPath], { encoding: "utf8" })
  .split(/\r?\n/u)
  .filter(Boolean);
const files = new Set(listing);

const required = [
  "extension/dist/extension.js",
  "extension/dist/server.js",
  "extension/dist/parser-worker.js",
  "extension/resources/icon.png",
  "extension/README.md",
  "extension/LICENSE.txt",
  "extension/CHANGELOG.md",
];

for (const file of required) {
  if (!files.has(file)) fail(`VSIX is missing ${file}`);
}

const forbiddenPrefixes = ["extension/dist/test/"];
for (const file of listing) {
  if (forbiddenPrefixes.some((prefix) => file.startsWith(prefix))) {
    fail(`VSIX contains forbidden artifact: ${file}`);
  }
}

const allowedDistJs = new Set([
  "extension/dist/extension.js",
  "extension/dist/server.js",
  "extension/dist/parser-worker.js",
]);
const extraDistJs = listing.filter(
  (file) =>
    file.startsWith("extension/dist/") && file.endsWith(".js") && !allowedDistJs.has(file),
);
if (extraDistJs.length > 0) {
  fail(`VSIX contains unexpected dist JavaScript artifacts:\n${extraDistJs.join("\n")}`);
}

console.log(`Verified ${relative(vsixPath)} (${listing.length} files)`);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function relative(path) {
  return path.startsWith(REPO_ROOT) ? path.slice(REPO_ROOT.length + 1) : path;
}
