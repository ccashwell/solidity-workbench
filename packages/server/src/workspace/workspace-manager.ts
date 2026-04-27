import * as fs from "node:fs";
import * as path from "node:path";
import type { Connection } from "vscode-languageserver/node.js";
import { URI } from "vscode-uri";
import { parse as parseToml } from "toml";
import type { FoundryProfile, Remapping } from "@solidity-workbench/common";
import { parseRemapping, resolveImportPath } from "@solidity-workbench/common";

/** Indexing-priority tiers used by `SymbolIndex` to decide what to scan first. */
export type FileTier = "project" | "tests" | "deps";

/**
 * Per-root state. Each workspace root (i.e. each folder the user has
 * opened in the editor) gets its own `foundry.toml` profile, remappings,
 * and discovered source files. Aggregation across roots happens inside
 * `WorkspaceManager`.
 *
 * `filesByTier` mirrors `sourceFiles` partitioned by indexing priority
 * — `src/` lands in `project`, `test/` and `script/` in `tests`, and
 * everything under the configured library directories in `deps`.
 */
interface WorkspaceRoot {
  rootUri: string;
  rootPath: string;
  config: FoundryProfile | null;
  remappings: Remapping[];
  sourceFiles: Set<string>;
  filesByTier: Record<FileTier, Set<string>>;
}

/**
 * Manages workspace state: foundry.toml, remappings, source directories,
 * and dependency resolution across one or more workspace roots.
 *
 * Multi-root support: the `roots` map is keyed by URI. The *primary* root
 * is the first one added — that's what `runForge` uses as its default cwd
 * when no explicit `cwd` is supplied. Aggregating methods
 * (`getAllFileUris`, `getRemappings`, `libDirs`, `resolveImport`) span
 * every root.
 */
export class WorkspaceManager {
  private connection: Connection;
  private roots: Map<string, WorkspaceRoot> = new Map();
  private primaryUri: string | null = null;
  private forgePath = "forge";

  constructor(initialRootUri: string, connection: Connection) {
    this.connection = connection;
    if (initialRootUri) {
      this.addRootSync(initialRootUri);
    }
  }

  /** Primary root's filesystem path. Kept for backwards compatibility. */
  get root(): string {
    const primary = this.primaryUri ? this.roots.get(this.primaryUri) : undefined;
    return primary?.rootPath ?? process.cwd();
  }

  get forge(): string {
    return this.forgePath;
  }

  /** All workspace root filesystem paths, primary first. */
  get rootPaths(): string[] {
    const paths: string[] = [];
    if (this.primaryUri) {
      const p = this.roots.get(this.primaryUri);
      if (p) paths.push(p.rootPath);
    }
    for (const [uri, root] of this.roots) {
      if (uri !== this.primaryUri) paths.push(root.rootPath);
    }
    return paths;
  }

  get rootCount(): number {
    return this.roots.size;
  }

  setForgePath(pathValue: string | undefined): void {
    this.forgePath = pathValue && pathValue.trim().length > 0 ? pathValue : "forge";
  }

  /** Primary root's src directory. Multi-root callers should use per-root walking. */
  get srcDir(): string {
    const root = this.primaryRoot();
    return path.join(root.rootPath, root.config?.src ?? "src");
  }

  get testDir(): string {
    const root = this.primaryRoot();
    return path.join(root.rootPath, root.config?.test ?? "test");
  }

  get scriptDir(): string {
    const root = this.primaryRoot();
    return path.join(root.rootPath, root.config?.script ?? "script");
  }

  get outDir(): string {
    const root = this.primaryRoot();
    return path.join(root.rootPath, root.config?.out ?? "out");
  }

  /** All library directories across all roots, for rename guards and index scans. */
  get libDirs(): string[] {
    const out: string[] = [];
    for (const root of this.roots.values()) {
      const libs = root.config?.libs ?? ["lib"];
      for (const lib of libs) {
        out.push(path.join(root.rootPath, lib));
      }
    }
    return out;
  }

  /** Aggregated remappings from every root, in root-addition order. */
  getRemappings(): Remapping[] {
    const out: Remapping[] = [];
    for (const root of this.roots.values()) {
      out.push(...root.remappings);
    }
    return out;
  }

  /** Primary root's foundry profile. */
  getFoundryConfig(): FoundryProfile | null {
    return this.primaryRoot().config;
  }

  /**
   * Find the root that owns a given file URI (nearest-ancestor match).
   * Returns the primary root as a fallback so callers never have to
   * branch on `undefined`.
   */
  findRootFor(uri: string): WorkspaceRoot {
    const fsPath = URI.parse(uri).fsPath;
    let best: WorkspaceRoot | undefined;
    let bestLen = -1;
    for (const root of this.roots.values()) {
      if (fsPath === root.rootPath || fsPath.startsWith(root.rootPath + path.sep)) {
        if (root.rootPath.length > bestLen) {
          best = root;
          bestLen = root.rootPath.length;
        }
      }
    }
    return best ?? this.primaryRoot();
  }

  /** Remappings scoped to the root that owns `fromUri`. */
  getRemappingsFor(fromUri: string): Remapping[] {
    return this.findRootFor(fromUri).remappings;
  }

  async initialize(): Promise<void> {
    for (const root of this.roots.values()) {
      await this.loadRoot(root);
    }
    const files = [...this.roots.values()].reduce((n, r) => n + r.sourceFiles.size, 0);
    this.connection.console.log(
      `Workspace initialized: ${this.roots.size} root(s), ${files} Solidity file(s)`,
    );
  }

  // ── Root management (multi-root) ───────────────────────────────────

  async addRoot(uri: string): Promise<void> {
    if (this.roots.has(uri)) return;
    this.addRootSync(uri);
    const root = this.roots.get(uri);
    if (root) await this.loadRoot(root);
  }

  removeRoot(uri: string): void {
    this.roots.delete(uri);
    if (this.primaryUri === uri) {
      const next = this.roots.keys().next();
      this.primaryUri = next.done ? null : next.value;
    }
  }

  private addRootSync(uri: string): void {
    const rootPath = URI.parse(uri).fsPath;
    this.roots.set(uri, {
      rootUri: uri,
      rootPath,
      config: null,
      remappings: [],
      sourceFiles: new Set(),
      filesByTier: {
        project: new Set(),
        tests: new Set(),
        deps: new Set(),
      },
    });
    if (!this.primaryUri) this.primaryUri = uri;
  }

  /** Reload state for a single root (after foundry.toml / remappings.txt changed). */
  async reloadRoot(uri: string): Promise<void> {
    const root = this.roots.get(uri);
    if (!root) return;
    await this.loadRoot(root);
  }

  private async loadRoot(root: WorkspaceRoot): Promise<void> {
    root.config = this.loadFoundryConfig(root.rootPath);
    root.remappings = this.loadRemappings(root);
    root.sourceFiles.clear();
    root.filesByTier.project.clear();
    root.filesByTier.tests.clear();
    root.filesByTier.deps.clear();
    this.discoverSourceFiles(root);
  }

  private primaryRoot(): WorkspaceRoot {
    if (!this.primaryUri) throw new Error("WorkspaceManager has no primary root");
    const root = this.roots.get(this.primaryUri);
    if (!root) throw new Error(`Primary root ${this.primaryUri} missing`);
    return root;
  }

  // ── Config + remappings ────────────────────────────────────────────

  private loadFoundryConfig(rootPath: string): FoundryProfile | null {
    const configPath = path.join(rootPath, "foundry.toml");
    try {
      if (!fs.existsSync(configPath)) {
        this.connection.console.log(`No foundry.toml at ${rootPath} — using defaults`);
        return null;
      }
      const content = fs.readFileSync(configPath, "utf-8");
      return this.parseFoundryToml(content);
    } catch (err) {
      this.connection.console.error(`Failed to load foundry.toml at ${rootPath}: ${err}`);
      return null;
    }
  }

  private loadRemappings(root: WorkspaceRoot): Remapping[] {
    const out: Remapping[] = [];

    if (root.config?.remappings) {
      for (const raw of root.config.remappings) {
        out.push(parseRemapping(raw));
      }
    }

    const remappingsPath = path.join(root.rootPath, "remappings.txt");
    try {
      if (fs.existsSync(remappingsPath)) {
        const content = fs.readFileSync(remappingsPath, "utf-8");
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith("#")) {
            out.push(parseRemapping(trimmed));
          }
        }
      }
    } catch (err) {
      this.connection.console.warn(`Failed to read remappings.txt at ${root.rootPath}: ${err}`);
    }

    // Auto-detect from lib/
    const libs = (root.config?.libs ?? ["lib"]).map((l) => path.join(root.rootPath, l));
    for (const libDir of libs) {
      try {
        if (!fs.existsSync(libDir)) continue;
        const entries = fs.readdirSync(libDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const srcPath = path.join(libDir, entry.name, "src");
            const hasSubSrc = fs.existsSync(srcPath);
            const target = hasSubSrc ? `${libDir}/${entry.name}/src/` : `${libDir}/${entry.name}/`;
            const prefix = `${entry.name}/`;
            if (!out.some((r) => r.prefix === prefix)) {
              out.push({ prefix, path: target });
            }
          }
        }
      } catch (err) {
        this.connection.console.warn(`Failed to scan lib directory ${libDir}: ${err}`);
      }
    }

    return out;
  }

  private discoverSourceFiles(root: WorkspaceRoot): void {
    const cfg = root.config;
    const projectDir = path.join(root.rootPath, cfg?.src ?? "src");
    const testDir = path.join(root.rootPath, cfg?.test ?? "test");
    const scriptDir = path.join(root.rootPath, cfg?.script ?? "script");
    const libDirs = (cfg?.libs ?? ["lib"]).map((l) => path.join(root.rootPath, l));

    this.walkDirectory(projectDir, root, "project");
    this.walkDirectory(testDir, root, "tests");
    this.walkDirectory(scriptDir, root, "tests");
    for (const libDir of libDirs) {
      this.walkDirectory(libDir, root, "deps");
    }
  }

  private walkDirectory(dir: string, root: WorkspaceRoot, tier: FileTier): void {
    try {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === "out") continue;
          this.walkDirectory(fullPath, root, tier);
        } else if (entry.name.endsWith(".sol")) {
          const uri = URI.file(fullPath).toString();
          root.sourceFiles.add(uri);
          root.filesByTier[tier].add(uri);
        }
      }
    } catch (err) {
      this.connection.console.warn(`Failed to walk directory ${dir}: ${err}`);
    }
  }

  // ── Import resolution ──────────────────────────────────────────────

  /**
   * Resolve a Solidity import path to a filesystem path. Multi-root:
   * first try remappings from the importing file's own root, then any
   * other root (so shared lib dirs across roots still resolve), then
   * relative, then per-root src/lib directories, then node_modules.
   */
  resolveImport(importPath: string, fromFile: string): string | null {
    const fromUri = URI.file(fromFile).toString();
    const ownRoot = this.findRootFor(fromUri);

    // 1. Own root's remappings
    const localMatch = this.tryRemap(importPath, ownRoot.remappings, ownRoot.rootPath);
    if (localMatch) return localMatch;

    // 2. Remappings from other roots (shared libs case)
    for (const root of this.roots.values()) {
      if (root === ownRoot) continue;
      const match = this.tryRemap(importPath, root.remappings, root.rootPath);
      if (match) return match;
    }

    // 3. Relative
    if (importPath.startsWith(".")) {
      const resolved = path.resolve(path.dirname(fromFile), importPath);
      if (fs.existsSync(resolved)) return resolved;
    }

    // 4. Per-root src + lib directories
    for (const root of this.roots.values()) {
      const srcDir = path.join(root.rootPath, root.config?.src ?? "src");
      const libs = (root.config?.libs ?? ["lib"]).map((l) => path.join(root.rootPath, l));
      for (const baseDir of [srcDir, ...libs]) {
        const resolved = path.join(baseDir, importPath);
        if (fs.existsSync(resolved)) return resolved;
      }
    }

    // 5. node_modules from primary root
    const nodeModulesPath = path.join(this.root, "node_modules", importPath);
    if (fs.existsSync(nodeModulesPath)) return nodeModulesPath;

    return null;
  }

  private tryRemap(importPath: string, remappings: Remapping[], rootPath: string): string | null {
    const remapped = resolveImportPath(importPath, remappings);
    if (!remapped) return null;
    const resolved = path.isAbsolute(remapped) ? remapped : path.join(rootPath, remapped);
    if (fs.existsSync(resolved)) return resolved;
    return null;
  }

  /** Every known Solidity file URI, across every root. */
  getAllFileUris(): string[] {
    const uris: string[] = [];
    for (const root of this.roots.values()) {
      for (const uri of root.sourceFiles) uris.push(uri);
    }
    return uris;
  }

  /**
   * File URIs grouped by indexing priority. `project` covers `src/`,
   * `tests` covers `test/` and `script/`, `deps` covers everything under
   * the configured `libs` directories. `SymbolIndex` walks these tiers
   * in order so the editor becomes responsive on project files before
   * dependencies finish indexing.
   */
  getFileUrisByTier(): Record<FileTier, string[]> {
    const project: string[] = [];
    const tests: string[] = [];
    const deps: string[] = [];
    for (const root of this.roots.values()) {
      for (const uri of root.filesByTier.project) project.push(uri);
      for (const uri of root.filesByTier.tests) tests.push(uri);
      for (const uri of root.filesByTier.deps) deps.push(uri);
    }
    return { project, tests, deps };
  }

  uriToPath(uri: string): string {
    return URI.parse(uri).fsPath;
  }

  /**
   * Run a forge command. If `cwd` is omitted we dispatch to the primary
   * root — callers that need per-root behaviour should pass a `cwd`
   * (typically via `findRootFor(uri).rootPath`).
   */
  async runForge(
    args: string[],
    cwd?: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    try {
      const result = await execFileAsync(this.forgePath, args, {
        cwd: cwd ?? this.root,
        maxBuffer: 10 * 1024 * 1024,
        timeout: 120_000,
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    } catch (err: any) {
      return {
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? err.message,
        exitCode: err.code ?? 1,
      };
    }
  }

  private parseFoundryToml(content: string): FoundryProfile {
    try {
      const parsed = parseToml(content);
      const defaultProfile = parsed?.profile?.default ?? parsed?.default ?? parsed;

      const profile: FoundryProfile = {};
      if (defaultProfile.src) profile.src = defaultProfile.src;
      if (defaultProfile.test) profile.test = defaultProfile.test;
      if (defaultProfile.script) profile.script = defaultProfile.script;
      if (defaultProfile.out) profile.out = defaultProfile.out;
      if (defaultProfile.libs) profile.libs = defaultProfile.libs;
      if (defaultProfile.remappings) profile.remappings = defaultProfile.remappings;
      if (defaultProfile.solc_version || defaultProfile.solc) {
        profile.solc_version = defaultProfile.solc_version ?? defaultProfile.solc;
      }
      if (defaultProfile.evm_version) profile.evm_version = defaultProfile.evm_version;
      if (defaultProfile.optimizer !== undefined) profile.optimizer = defaultProfile.optimizer;
      if (defaultProfile.optimizer_runs !== undefined) {
        profile.optimizer_runs = defaultProfile.optimizer_runs;
      }
      if (defaultProfile.via_ir !== undefined) profile.via_ir = defaultProfile.via_ir;
      if (defaultProfile.fmt) profile.fmt = defaultProfile.fmt;

      return profile;
    } catch (err) {
      this.connection.console.error(`Failed to parse foundry.toml: ${err}`);
      return {};
    }
  }
}
