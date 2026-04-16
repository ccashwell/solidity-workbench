import * as fs from "node:fs";
import * as path from "node:path";
import type { Connection } from "vscode-languageserver/node.js";
import { URI } from "vscode-uri";
import { parse as parseToml } from "toml";
import type { FoundryProfile, Remapping } from "@solidity-workbench/common";
import { FoundryConfig, parseRemapping, resolveImportPath } from "@solidity-workbench/common";

/**
 * Manages workspace state: foundry.toml, remappings, source directories,
 * and dependency resolution.
 */
export class WorkspaceManager {
  private rootPath: string;
  private connection: Connection;
  private config: FoundryProfile | null = null;
  private remappings: Remapping[] = [];
  private sourceFiles: Map<string, string> = new Map(); // uri → file path
  private forgePath = "forge";

  constructor(rootUri: string, connection: Connection) {
    this.rootPath = URI.parse(rootUri).fsPath;
    this.connection = connection;
  }

  get root(): string {
    return this.rootPath;
  }

  get forge(): string {
    return this.forgePath;
  }

  /**
   * Update the forge binary path from extension config.
   * Empty string or undefined resets to the PATH-based "forge".
   */
  setForgePath(path: string | undefined): void {
    this.forgePath = path && path.trim().length > 0 ? path : "forge";
  }

  get srcDir(): string {
    return path.join(this.rootPath, this.config?.src ?? "src");
  }

  get testDir(): string {
    return path.join(this.rootPath, this.config?.test ?? "test");
  }

  get scriptDir(): string {
    return path.join(this.rootPath, this.config?.script ?? "script");
  }

  get outDir(): string {
    return path.join(this.rootPath, this.config?.out ?? "out");
  }

  get libDirs(): string[] {
    return (this.config?.libs ?? ["lib"]).map((l) => path.join(this.rootPath, l));
  }

  getRemappings(): Remapping[] {
    return this.remappings;
  }

  getFoundryConfig(): FoundryProfile | null {
    return this.config;
  }

  async initialize(): Promise<void> {
    await this.loadFoundryConfig();
    await this.loadRemappings();
    await this.discoverSourceFiles();
    this.connection.console.log(
      `Workspace initialized: ${this.sourceFiles.size} Solidity files found`,
    );
  }

  /**
   * Parse and load foundry.toml from the workspace root.
   */
  private async loadFoundryConfig(): Promise<void> {
    const configPath = path.join(this.rootPath, "foundry.toml");
    try {
      if (!fs.existsSync(configPath)) {
        this.connection.console.log("No foundry.toml found, using defaults");
        return;
      }

      const content = fs.readFileSync(configPath, "utf-8");
      // Simple TOML parsing for the [profile.default] section.
      // In production, use a proper TOML parser — for now we extract
      // the fields we need with regex to avoid the dependency.
      this.config = this.parseFoundryToml(content);
      this.connection.console.log("Loaded foundry.toml configuration");
    } catch (err) {
      this.connection.console.error(`Failed to load foundry.toml: ${err}`);
    }
  }

  /**
   * Load remappings from foundry.toml and/or remappings.txt
   */
  private async loadRemappings(): Promise<void> {
    this.remappings = [];

    // 1. Remappings from foundry.toml
    if (this.config?.remappings) {
      for (const raw of this.config.remappings) {
        this.remappings.push(parseRemapping(raw));
      }
    }

    // 2. Remappings from remappings.txt (these take precedence / augment)
    const remappingsPath = path.join(this.rootPath, "remappings.txt");
    try {
      if (fs.existsSync(remappingsPath)) {
        const content = fs.readFileSync(remappingsPath, "utf-8");
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith("#")) {
            this.remappings.push(parseRemapping(trimmed));
          }
        }
      }
    } catch (err) {
      this.connection.console.warn(`Failed to read remappings.txt: ${err}`);
    }

    // 3. Auto-detect remappings from lib/ directory (forge-style)
    for (const libDir of this.libDirs) {
      try {
        if (!fs.existsSync(libDir)) continue;
        const entries = fs.readdirSync(libDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            // Check if there's a src/ subdirectory
            const srcPath = path.join(libDir, entry.name, "src");
            const hasSubSrc = fs.existsSync(srcPath);
            const target = hasSubSrc ? `${libDir}/${entry.name}/src/` : `${libDir}/${entry.name}/`;

            // Only add if not already covered by explicit remappings
            const prefix = `${entry.name}/`;
            if (!this.remappings.some((r) => r.prefix === prefix)) {
              this.remappings.push({ prefix, path: target });
            }
          }
        }
      } catch (err) {
        this.connection.console.warn(`Failed to scan lib directory ${libDir}: ${err}`);
      }
    }

    this.connection.console.log(`Loaded ${this.remappings.length} remappings`);
  }

  /**
   * Discover all .sol files in the workspace
   */
  private async discoverSourceFiles(): Promise<void> {
    const dirs = [this.srcDir, this.testDir, this.scriptDir, ...this.libDirs];

    for (const dir of dirs) {
      await this.walkDirectory(dir);
    }
  }

  private async walkDirectory(dir: string): Promise<void> {
    try {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // Skip node_modules and out directories
          if (entry.name === "node_modules" || entry.name === "out") continue;
          await this.walkDirectory(fullPath);
        } else if (entry.name.endsWith(".sol")) {
          const uri = URI.file(fullPath).toString();
          this.sourceFiles.set(uri, fullPath);
        }
      }
    } catch (err) {
      this.connection.console.warn(`Failed to walk directory ${dir}: ${err}`);
    }
  }

  /**
   * Resolve a Solidity import path to a filesystem path.
   */
  resolveImport(importPath: string, fromFile: string): string | null {
    // 1. Try remappings first
    const remapped = resolveImportPath(importPath, this.remappings);
    if (remapped) {
      const resolved = path.isAbsolute(remapped) ? remapped : path.join(this.rootPath, remapped);
      if (fs.existsSync(resolved)) return resolved;
    }

    // 2. Try relative import
    if (importPath.startsWith(".")) {
      const fromDir = path.dirname(fromFile);
      const resolved = path.resolve(fromDir, importPath);
      if (fs.existsSync(resolved)) return resolved;
    }

    // 3. Try from project root directories
    for (const baseDir of [this.srcDir, ...this.libDirs]) {
      const resolved = path.join(baseDir, importPath);
      if (fs.existsSync(resolved)) return resolved;
    }

    // 4. Try node_modules
    const nodeModulesPath = path.join(this.rootPath, "node_modules", importPath);
    if (fs.existsSync(nodeModulesPath)) return nodeModulesPath;

    return null;
  }

  /**
   * Get all known Solidity file URIs in the workspace.
   */
  getAllFileUris(): string[] {
    return Array.from(this.sourceFiles.keys());
  }

  /**
   * Get the filesystem path for a URI.
   */
  uriToPath(uri: string): string {
    return URI.parse(uri).fsPath;
  }

  /**
   * Run a forge command and return its output.
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
        cwd: cwd ?? this.rootPath,
        maxBuffer: 10 * 1024 * 1024, // 10MB — forge output can be large
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

  /**
   * Parse foundry.toml using a proper TOML parser.
   */
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
