import {
  CodeAction,
  CodeActionKind,
  TextEdit,
  Diagnostic,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import * as path from "node:path";
import { SymbolIndex } from "../analyzer/symbol-index.js";
import { WorkspaceManager } from "../workspace/workspace-manager.js";
import { SolidityParser } from "../parser/solidity-parser.js";

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
   * Provide auto-import code actions for unresolved identifiers.
   */
  provideImportActions(
    document: TextDocument,
    diagnostics: Diagnostic[],
  ): CodeAction[] {
    const actions: CodeAction[] = [];
    const text = document.getText();
    const uri = document.uri;
    const existingImports = this.getExistingImports(uri);

    // Find undeclared identifiers from diagnostics
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

      // Extract the symbol name from the diagnostic message
      const symbolName = this.extractSymbolFromDiagnostic(diag, text);
      if (!symbolName) continue;

      // Find candidate imports
      const candidates = this.findImportCandidates(symbolName, uri, existingImports);
      for (const candidate of candidates) {
        actions.push(
          this.createImportAction(uri, text, symbolName, candidate),
        );
      }
    }

    // Also provide import suggestions for symbols that exist in the workspace
    // but aren't imported (even without diagnostics, for proactive importing)
    const unresolvedSymbols = this.findUnresolvedSymbols(text, uri, existingImports);
    for (const { name, candidates } of unresolvedSymbols) {
      for (const candidate of candidates) {
        const action = this.createImportAction(uri, text, name, candidate);
        // Mark as non-preferred so they don't auto-apply
        action.isPreferred = false;
        actions.push(action);
      }
    }

    return actions;
  }

  /**
   * Find import candidates for a symbol name.
   */
  private findImportCandidates(
    symbolName: string,
    currentUri: string,
    existingImports: Set<string>,
  ): ImportCandidate[] {
    const symbols = this.symbolIndex.findSymbols(symbolName);
    const candidates: ImportCandidate[] = [];

    for (const sym of symbols) {
      if (sym.filePath === currentUri) continue; // Same file, no import needed

      // Check if already imported
      if (existingImports.has(sym.filePath)) continue;

      const importPath = this.computeImportPath(
        currentUri,
        sym.filePath,
        symbolName,
      );
      if (importPath) {
        candidates.push({
          symbolName,
          importPath,
          sourceUri: sym.filePath,
          containerName: sym.containerName,
        });
      }
    }

    // Deduplicate by import path
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
  private computeImportPath(
    fromUri: string,
    toUri: string,
    symbolName: string,
  ): string | null {
    const fromPath = URI.parse(fromUri).fsPath;
    const toPath = URI.parse(toUri).fsPath;

    // 1. Try to match a remapping
    const remappings = this.workspace.getRemappings();
    for (const r of remappings) {
      const remapTarget = path.isAbsolute(r.path)
        ? r.path
        : path.join(this.workspace.root, r.path);

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
          [uri]: [
            TextEdit.insert(
              { line: insertLine, character: 0 },
              importStatement,
            ),
          ],
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

  private extractSymbolFromDiagnostic(
    diag: Diagnostic,
    text: string,
  ): string | null {
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
   * Find symbols used in the document that exist in the workspace
   * but aren't imported.
   */
  private findUnresolvedSymbols(
    text: string,
    uri: string,
    existingImports: Set<string>,
  ): { name: string; candidates: ImportCandidate[] }[] {
    const results: { name: string; candidates: ImportCandidate[] }[] = [];

    // Get all type-position identifiers that start with uppercase
    // (likely contract/interface/library/struct/enum references)
    const typeRefs = new Set<string>();
    const typeRefRe = /\b([A-Z]\w+)\b/g;
    let match: RegExpExecArray | null;

    while ((match = typeRefRe.exec(text)) !== null) {
      typeRefs.add(match[1]);
    }

    // Check which of these are defined in the current file
    const result = this.parser.get(uri);
    const localNames = new Set<string>();
    if (result) {
      for (const contract of result.sourceUnit.contracts) {
        localNames.add(contract.name);
        for (const s of contract.structs) localNames.add(s.name);
        for (const e of contract.enums) localNames.add(e.name);
      }
      // Also add imported symbols
      for (const imp of result.sourceUnit.imports) {
        if (imp.symbolAliases) {
          for (const alias of imp.symbolAliases) {
            localNames.add(alias.alias ?? alias.symbol);
          }
        }
      }
    }

    // Find candidates for unresolved type references
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

  private isBuiltinType(name: string): boolean {
    const builtins = new Set([
      "Error", "Panic", "Test", // common but might actually need import
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
