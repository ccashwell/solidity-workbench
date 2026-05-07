import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { URI } from "vscode-uri";
import type { Connection } from "vscode-languageserver/node.js";
import { WorkspaceManager } from "../workspace/workspace-manager.js";

/** Connection stub — WorkspaceManager only calls `console.{log,warn,error}`. */
function makeFakeConnection(): Connection {
  return {
    console: {
      log: () => {},
      warn: () => {},
      error: () => {},
    },
  } as unknown as Connection;
}

/**
 * Build a tiny foundry-shaped fixture with `src/`, `test/`, `script/`, and
 * `lib/...` populated with `.sol` files. Returns the root path so the
 * caller can construct a `WorkspaceManager` against it.
 */
function makeFixtureRoot(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ws-mgr-"));
  fs.writeFileSync(path.join(tmp, "foundry.toml"), "[profile.default]\n");

  const dirs = {
    src: path.join(tmp, "src"),
    test: path.join(tmp, "test"),
    script: path.join(tmp, "script"),
    lib: path.join(tmp, "lib", "forge-std", "src"),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });

  fs.writeFileSync(path.join(dirs.src, "Counter.sol"), "contract Counter {}");
  fs.writeFileSync(path.join(dirs.src, "Token.sol"), "contract Token {}");
  fs.writeFileSync(path.join(dirs.test, "Counter.t.sol"), "contract CounterTest {}");
  fs.writeFileSync(path.join(dirs.script, "Deploy.s.sol"), "contract Deploy {}");
  fs.writeFileSync(path.join(dirs.lib, "Test.sol"), "contract Test {}");

  return tmp;
}

describe("WorkspaceManager", () => {
  describe("getFileUrisByTier", () => {
    it("groups src/ as project, test/ + script/ as tests, lib/ as deps", async () => {
      const rootPath = makeFixtureRoot();
      const rootUri = URI.file(rootPath).toString();

      const ws = new WorkspaceManager(rootUri, makeFakeConnection());
      await ws.initialize();

      const tiers = ws.getFileUrisByTier();
      const basenames = (uris: string[]) =>
        uris.map((u) => path.basename(URI.parse(u).fsPath)).sort();

      assert.deepEqual(basenames(tiers.project), ["Counter.sol", "Token.sol"]);
      assert.deepEqual(basenames(tiers.tests), ["Counter.t.sol", "Deploy.s.sol"]);
      assert.deepEqual(basenames(tiers.deps), ["Test.sol"]);

      // Tiers must partition the flat URI list — no file can land in
      // two tiers, and the union must equal the full discovered set.
      const allFromTiers = new Set([...tiers.project, ...tiers.tests, ...tiers.deps]);
      const flat = new Set(ws.getAllFileUris());
      assert.equal(allFromTiers.size, flat.size);
      for (const uri of flat) assert.ok(allFromTiers.has(uri), `${uri} missing from tiers`);

      fs.rmSync(rootPath, { recursive: true, force: true });
    });

    it("getFileTier returns the right tier for each known file and null for unknowns", async () => {
      const rootPath = makeFixtureRoot();
      const ws = new WorkspaceManager(URI.file(rootPath).toString(), makeFakeConnection());
      await ws.initialize();

      const tiers = ws.getFileUrisByTier();
      const findByBase = (uris: string[], base: string): string =>
        uris.find((u) => path.basename(URI.parse(u).fsPath) === base) ?? "";

      assert.equal(ws.getFileTier(findByBase(tiers.project, "Counter.sol")), "project");
      assert.equal(ws.getFileTier(findByBase(tiers.tests, "Counter.t.sol")), "tests");
      assert.equal(ws.getFileTier(findByBase(tiers.tests, "Deploy.s.sol")), "tests");
      assert.equal(ws.getFileTier(findByBase(tiers.deps, "Test.sol")), "deps");
      assert.equal(ws.getFileTier("file:///nope/Unknown.sol"), null);

      fs.rmSync(rootPath, { recursive: true, force: true });
    });

    it("returns empty tiers for a workspace with no Solidity files", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ws-mgr-empty-"));
      fs.writeFileSync(path.join(tmp, "foundry.toml"), "[profile.default]\n");
      const ws = new WorkspaceManager(URI.file(tmp).toString(), makeFakeConnection());
      await ws.initialize();

      const tiers = ws.getFileUrisByTier();
      assert.deepEqual(tiers.project, []);
      assert.deepEqual(tiers.tests, []);
      assert.deepEqual(tiers.deps, []);

      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it("skips heavy Foundry/VCS directories during discovery", async () => {
      // The previous implementation only excluded `node_modules` and
      // `out`, so the recursive walk descended into `.git/` (commonly
      // tens of thousands of objects), Foundry's `cache/` and
      // `broadcast/` (build artifacts), and editor-config dirs. Any
      // `.sol` file under these paths would otherwise be discovered
      // and parsed during the initial sweep — pure I/O waste that
      // delays the user's first usable LSP response. We don't fail
      // closed (a `.sol` inside `lib/forge-std/cache` is a real lib
      // file), but the top-level project walk skips these names.
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ws-mgr-skip-"));
      fs.writeFileSync(path.join(tmp, "foundry.toml"), "[profile.default]\n");

      const srcDir = path.join(tmp, "src");
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, "Real.sol"), "contract Real {}");

      // These are the dirs we now skip. They're seeded with a fake
      // `.sol` file so we can detect a regression: if the file is
      // discovered, the walk is no longer respecting the skip list.
      const skipDirs = [".git", "cache", "broadcast", ".foundry", ".vscode", "coverage"];
      for (const d of skipDirs) {
        const full = path.join(srcDir, d);
        fs.mkdirSync(full, { recursive: true });
        fs.writeFileSync(path.join(full, "Bogus.sol"), "contract Bogus {}");
      }

      const ws = new WorkspaceManager(URI.file(tmp).toString(), makeFakeConnection());
      await ws.initialize();

      const basenames = ws
        .getAllFileUris()
        .map((u) => path.basename(URI.parse(u).fsPath))
        .sort();
      assert.deepEqual(basenames, ["Real.sol"], `discovered files: ${basenames.join(", ")}`);

      fs.rmSync(tmp, { recursive: true, force: true });
    });
  });
});
