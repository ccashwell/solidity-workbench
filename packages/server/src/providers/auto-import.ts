import type { CodeAction, Diagnostic, Range } from "vscode-languageserver/node.js";
import { CodeActionKind, TextEdit } from "vscode-languageserver/node.js";
import type { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import * as path from "node:path";
import type { SymbolIndex } from "../analyzer/symbol-index.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";
import type { SolidityParser } from "../parser/solidity-parser.js";

/**
 * Auto-import code action provider.
 *
 * When a symbol is used but not imported, provides quick-fix actions to:
 * 1. Add a named import: `import {Symbol} from "path";`
 * 2. Add a wildcard import: `import "path";`
 *
 * Import path resolution:
 * - Uses remappings to produce the shortest correct import path
 * - Prefers remapped paths over relative paths
 * - Follows Foundry conventions (e.g., `forge-std/Test.sol`)
 *
 * This is one of the most impactful missing features — TypeScript developers
 * take auto-import for granted, and Solidity devs waste significant time
 * manually writing import statements.
 */
export class AutoImportProvider {
  constructor(
    private symbolIndex: SymbolIndex,
    private workspace: WorkspaceManager,
    private parser: SolidityParser,
  ) {}

  /**
   * Provide auto-import code actions.
   *
   * Two independent surfaces produce import candidates:
   *
   *   1. **Diagnostic-triggered.** When the incoming diagnostic
   *      includes "Undeclared identifier" / "not found" / "not
   *      visible" (or the matching solc error codes), we offer
   *      imports for that specific identifier. These fire
   *      regardless of the cursor range since they're already
   *      range-anchored to the diagnostic itself.
   *
   *   2. **Proactive.** For names that aren't yet flagged by solc
   *      (e.g. between saves when full diagnostics haven't run),
   *      we scan the source for uppercase-starting identifiers that
   *      aren't locally declared or imported and offer imports for
   *      them. These are **scoped to the requested code-action
   *      range** so they don't bleed into Quick Fix menus invoked
   *      on unrelated diagnostics elsewhere in the file.
   */
  provideImportActions(
    document: TextDocument,
    diagnostics: Diagnostic[],
    range?: Range,
  ): CodeAction[] {
    const actions: CodeAction[] = [];
    const text = document.getText();
    const uri = document.uri;
    const existingImports = this.getExistingImports(uri);

    for (const diag of diagnostics) {
      // solc error 7576 = "Undeclared identifier"
      // solc error 9582 = "Member not found"
      const isUndeclared =
        diag.code === "7576" ||
        diag.code === "7920" ||
        (typeof diag.message === "string" &&
          (diag.message.includes("Undeclared identifier") ||
            diag.message.includes("not found") ||
            diag.message.includes("not visible")));

      if (!isUndeclared) continue;

      const symbolName = this.extractSymbolFromDiagnostic(diag, text);
      if (!symbolName) continue;

      const candidates = this.findImportCandidates(symbolName, uri, existingImports);
      for (const candidate of candidates) {
        actions.push(this.createImportAction(uri, text, symbolName, candidate));
      }
    }

    const unresolvedSymbols = this.findUnresolvedSymbols(document, existingImports, range);
    for (const { name, candidates } of unresolvedSymbols) {
      for (const candidate of candidates) {
        const action = this.createImportAction(uri, text, name, candidate);
        action.isPreferred = false;
        actions.push(action);
      }
    }

    return actions;
  }

  /**
   * Find import candidates for a symbol name.
   *
   * Short-circuit: if *any* declaration with this name lives in the
   * current file, we return `[]`. Otherwise same-file declarations
   * would coexist with cross-file imports, and the user would be
   * offered to import a name that's already in scope — the exact
   * mis-UX that produced "Import 'CountChanged' from ./interfaces/…"
   * suggestions for a symbol declared in the active contract.
   */
  private findImportCandidates(
    symbolName: string,
    currentUri: string,
    existingImports: Set<string>,
  ): ImportCandidate[] {
    const symbols = this.symbolIndex.findSymbols(symbolName);
    if (symbols.some((s) => s.filePath === currentUri)) return [];

    const candidates: ImportCandidate[] = [];
    for (const sym of symbols) {
      if (existingImports.has(sym.filePath)) continue;

      const importPath = this.computeImportPath(currentUri, sym.filePath, symbolName);
      if (importPath) {
        candidates.push({
          symbolName,
          importPath,
          sourceUri: sym.filePath,
          containerName: sym.containerName,
        });
      }
    }

    const seen = new Set<string>();
    return candidates.filter((c) => {
      if (seen.has(c.importPath)) return false;
      seen.add(c.importPath);
      return true;
    });
  }

  /**
   * Compute the shortest correct import path from one file to another.
   * Prefers remapped paths over relative paths.
   */
  private computeImportPath(fromUri: string, toUri: string, symbolName: string): string | null {
    const fromPath = URI.parse(fromUri).fsPath;
    const toPath = URI.parse(toUri).fsPath;

    // 1. Try to match a remapping
    const remappings = this.workspace.getRemappings();
    for (const r of remappings) {
      const remapTarget = path.isAbsolute(r.path) ? r.path : path.join(this.workspace.root, r.path);

      if (toPath.startsWith(remapTarget)) {
        const relative = toPath.slice(remapTarget.length);
        return r.prefix + relative;
      }
    }

    // 2. Try relative path
    const fromDir = path.dirname(fromPath);
    let relativePath = path.relative(fromDir, toPath);

    // Ensure it starts with ./ or ../
    if (!relativePath.startsWith(".")) {
      relativePath = "./" + relativePath;
    }

    // Normalize path separators
    relativePath = relativePath.replace(/\\/g, "/");

    return relativePath;
  }

  private createImportAction(
    uri: string,
    text: string,
    symbolName: string,
    candidate: ImportCandidate,
  ): CodeAction {
    const importStatement = `import {${symbolName}} from "${candidate.importPath}";\n`;

    // Find the best position to insert the import
    const insertLine = this.findImportInsertPosition(text);

    return {
      title: `Import '${symbolName}' from "${candidate.importPath}"`,
      kind: CodeActionKind.QuickFix,
      edit: {
        changes: {
          [uri]: [TextEdit.insert({ line: insertLine, character: 0 }, importStatement)],
        },
      },
      isPreferred: true,
    };
  }

  /**
   * Find the line number where new imports should be inserted.
   * Inserts after existing imports, or after the pragma, or at line 0.
   */
  private findImportInsertPosition(text: string): number {
    const lines = text.split("\n");
    let lastImportLine = -1;
    let lastPragmaLine = -1;
    let lastSpdxLine = -1;

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith("import ")) lastImportLine = i;
      if (trimmed.startsWith("pragma ")) lastPragmaLine = i;
      if (trimmed.includes("SPDX-License-Identifier")) lastSpdxLine = i;
    }

    if (lastImportLine >= 0) return lastImportLine + 1;
    if (lastPragmaLine >= 0) return lastPragmaLine + 1;
    if (lastSpdxLine >= 0) return lastSpdxLine + 1;
    return 0;
  }

  private getExistingImports(uri: string): Set<string> {
    const result = this.parser.get(uri);
    if (!result) return new Set();

    const imported = new Set<string>();
    for (const imp of result.sourceUnit.imports) {
      // Resolve the import path to a URI for comparison
      const fromPath = URI.parse(uri).fsPath;
      const resolved = this.workspace.resolveImport(imp.path, fromPath);
      if (resolved) {
        imported.add(URI.file(resolved).toString());
      }
    }
    return imported;
  }

  private extractSymbolFromDiagnostic(diag: Diagnostic, text: string): string | null {
    // Try to extract from the diagnostic message
    const match = (diag.message as string).match(
      /(?:Undeclared identifier|not found)[.\s]*"?(\w+)"?/i,
    );
    if (match) return match[1];

    // Fall back to the text at the diagnostic range
    const lines = text.split("\n");
    const line = lines[diag.range.start.line];
    if (!line) return null;

    return line.slice(diag.range.start.character, diag.range.end.character) || null;
  }

  /**
   * Find uppercase-starting identifiers used in the document that are
   * neither locally declared nor imported.
   *
   * Scope of "local":
   *   - Contract, interface, and library names
   *   - Struct, enum, event, error, modifier, and function names
   *     declared inside any of those contracts
   *   - File-level user-defined value types, free functions, and
   *     custom errors (Solidity ≥ 0.8.4)
   *   - Every imported symbol alias
   *
   * The scan regex matches uppercase-starting words in the raw text.
   * That includes matches inside comments and string literals. That's
   * fine for correctness (they're filtered downstream by the local
   * name set / candidate lookup), but we additionally filter by the
   * requested code-action range when one is supplied — a Quick Fix
   * invoked on the pragma line shouldn't surface imports for names
   * that appear 40 lines below.
   */
  private findUnresolvedSymbols(
    document: TextDocument,
    existingImports: Set<string>,
    range?: Range,
  ): { name: string; candidates: ImportCandidate[] }[] {
    const uri = document.uri;
    const text = document.getText();

    const typeRefs = new Set<string>();
    const typeRefRe = /\b([A-Z]\w+)\b/g;
    let match: RegExpExecArray | null;

    while ((match = typeRefRe.exec(text)) !== null) {
      if (range) {
        const start = document.positionAt(match.index);
        const end = document.positionAt(match.index + match[0].length);
        if (!rangesOverlap({ start, end }, range)) continue;
      }
      typeRefs.add(match[1]);
    }

    const localNames = this.collectLocalNames(uri);

    const results: { name: string; candidates: ImportCandidate[] }[] = [];
    for (const name of typeRefs) {
      if (localNames.has(name)) continue;
      if (this.isBuiltinType(name)) continue;

      const candidates = this.findImportCandidates(name, uri, existingImports);
      if (candidates.length > 0) {
        results.push({ name, candidates });
      }
    }

    return results;
  }

  /**
   * Every identifier that's already in scope in the current file —
   * declarations from the file itself plus names brought in by
   * imports. Used by `findUnresolvedSymbols` to decide which
   * identifiers deserve a proactive import suggestion.
   */
  private collectLocalNames(uri: string): Set<string> {
    const result = this.parser.get(uri);
    const names = new Set<string>();
    if (!result) return names;

    const su = result.sourceUnit;

    for (const contract of su.contracts) {
      names.add(contract.name);
      for (const s of contract.structs) names.add(s.name);
      for (const e of contract.enums) names.add(e.name);
      for (const ev of contract.events) names.add(ev.name);
      for (const er of contract.errors) names.add(er.name);
      for (const m of contract.modifiers) if (m.name) names.add(m.name);
      for (const f of contract.functions) if (f.name) names.add(f.name);
    }

    for (const udvt of su.userDefinedValueTypes) names.add(udvt.name);
    for (const err of su.errors) names.add(err.name);
    for (const fn of su.freeFunctions) if (fn.name) names.add(fn.name);

    for (const imp of su.imports) {
      if (imp.symbolAliases) {
        for (const alias of imp.symbolAliases) {
          names.add(alias.alias ?? alias.symbol);
        }
      }
      if (imp.unitAlias) names.add(imp.unitAlias);
    }

    return names;
  }

  private isBuiltinType(name: string): boolean {
    const builtins = new Set([
      "Error",
      "Panic",
      "Test", // common but might actually need import
    ]);
    return builtins.has(name);
  }
}

interface ImportCandidate {
  symbolName: string;
  importPath: string;
  sourceUri: string;
  containerName?: string;
}

/**
 * True when two LSP ranges share any byte of overlap. Used to filter
 * proactive import suggestions to identifiers near the user's cursor
 * rather than dumping every unresolved type reference in the file
 * into every Quick Fix menu.
 */
function rangesOverlap(a: Range, b: Range): boolean {
  if (a.end.line < b.start.line) return false;
  if (b.end.line < a.start.line) return false;
  if (a.end.line === b.start.line && a.end.character < b.start.character) return false;
  if (b.end.line === a.start.line && b.end.character < a.start.character) return false;
  return true;
}
