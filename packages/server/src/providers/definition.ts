import {
  Definition,
  Location,
  Position,
  Range,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import { SymbolIndex } from "../analyzer/symbol-index.js";
import { WorkspaceManager } from "../workspace/workspace-manager.js";

/**
 * Provides go-to-definition, go-to-type-definition, and find-references.
 *
 * Strategy:
 * 1. Get the word at the cursor position
 * 2. Look it up in the symbol index
 * 3. For imports, resolve the file path and jump to it
 * 4. For member access (e.g., contract.func), resolve through inheritance chain
 */
export class DefinitionProvider {
  constructor(
    private symbolIndex: SymbolIndex,
    private workspace: WorkspaceManager,
  ) {}

  provideDefinition(
    document: TextDocument,
    position: Position,
  ): Definition | null {
    const text = document.getText();
    const word = this.getWordAtPosition(text, position);
    if (!word) return null;

    // Check if this is an import path — navigate to the file
    const importTarget = this.resolveImportAtPosition(text, position);
    if (importTarget) {
      const resolved = this.workspace.resolveImport(
        importTarget,
        this.workspace.uriToPath(document.uri),
      );
      if (resolved) {
        return Location.create(URI.file(resolved).toString(), {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        });
      }
    }

    // Check for dotted access (Type.member)
    const dottedTarget = this.getDottedAccess(text, position);
    if (dottedTarget) {
      return this.resolveMemberDefinition(dottedTarget.type, dottedTarget.member);
    }

    // Look up in symbol index
    const symbols = this.symbolIndex.findSymbols(word);
    if (symbols.length === 0) return null;

    // If there's only one definition, go directly
    if (symbols.length === 1) {
      return Location.create(symbols[0].filePath, symbols[0].nameRange);
    }

    // Multiple definitions — prefer the one in the same file, then declarations
    const sameFile = symbols.filter((s) => s.filePath === document.uri);
    if (sameFile.length > 0) {
      return sameFile.map((s) =>
        Location.create(s.filePath, s.nameRange),
      );
    }

    return symbols.map((s) => Location.create(s.filePath, s.nameRange));
  }

  provideTypeDefinition(
    document: TextDocument,
    position: Position,
  ): Definition | null {
    const text = document.getText();
    const word = this.getWordAtPosition(text, position);
    if (!word) return null;

    // Look up the symbol to find its type
    const symbols = this.symbolIndex.findSymbols(word);
    for (const sym of symbols) {
      if (sym.kind === "stateVariable" || sym.kind === "parameter" || sym.kind === "localVariable") {
        // The detail field contains the type name for variables
        if (sym.detail) {
          const typeName = sym.detail.replace(/\[\]$/, "").replace(/\s+memory$/, "").replace(/\s+storage$/, "");
          const typeSymbols = this.symbolIndex.findSymbols(typeName);
          if (typeSymbols.length > 0) {
            return typeSymbols.map((s) =>
              Location.create(s.filePath, s.nameRange),
            );
          }
        }
      }
    }

    return null;
  }

  provideReferences(
    document: TextDocument,
    position: Position,
  ): Location[] {
    const text = document.getText();
    const word = this.getWordAtPosition(text, position);
    if (!word) return [];

    // Search all indexed files for occurrences of this word
    // This is a simple textual search — the rich AST from solc would
    // give us semantically accurate references
    const references: Location[] = [];

    for (const uri of this.workspace.getAllFileUris()) {
      const symbols = this.symbolIndex.getFileSymbols(uri);
      for (const sym of symbols) {
        if (sym.name === word) {
          references.push(Location.create(sym.filePath, sym.nameRange));
        }
      }
    }

    return references;
  }

  private resolveImportAtPosition(
    text: string,
    position: Position,
  ): string | null {
    const line = text.split("\n")[position.line] ?? "";

    // Check if cursor is on an import path
    const importMatch = line.match(/import\s+.*?["']([^"']+)["']/);
    if (importMatch) {
      const pathStart = line.indexOf(importMatch[1]);
      const pathEnd = pathStart + importMatch[1].length;
      if (position.character >= pathStart && position.character <= pathEnd) {
        return importMatch[1];
      }
    }

    const fromMatch = line.match(/from\s+["']([^"']+)["']/);
    if (fromMatch) {
      const pathStart = line.indexOf(fromMatch[1]);
      const pathEnd = pathStart + fromMatch[1].length;
      if (position.character >= pathStart && position.character <= pathEnd) {
        return fromMatch[1];
      }
    }

    return null;
  }

  private getDottedAccess(
    text: string,
    position: Position,
  ): { type: string; member: string } | null {
    const line = text.split("\n")[position.line] ?? "";
    const before = line.slice(0, position.character);

    // Match patterns like `ContractName.functionName` or `variable.member`
    const match = before.match(/(\w+)\.(\w*)$/);
    if (match) {
      return { type: match[1], member: match[2] || this.getWordAfterDot(line, position.character) };
    }
    return null;
  }

  private resolveMemberDefinition(
    typeName: string,
    memberName: string,
  ): Definition | null {
    const chain = this.symbolIndex.getInheritanceChain(typeName);
    for (const contract of chain) {
      // Search functions
      const func = contract.functions.find((f) => f.name === memberName);
      if (func) {
        const entry = this.symbolIndex.getContract(contract.name);
        if (entry) {
          return Location.create(entry.uri, func.nameRange);
        }
      }

      // Search state variables
      const svar = contract.stateVariables.find((v) => v.name === memberName);
      if (svar) {
        const entry = this.symbolIndex.getContract(contract.name);
        if (entry) {
          return Location.create(entry.uri, svar.nameRange);
        }
      }

      // Search events
      const event = contract.events.find((e) => e.name === memberName);
      if (event) {
        const entry = this.symbolIndex.getContract(contract.name);
        if (entry) {
          return Location.create(entry.uri, event.nameRange);
        }
      }
    }
    return null;
  }

  private getWordAtPosition(text: string, position: Position): string | null {
    const lines = text.split("\n");
    if (position.line >= lines.length) return null;
    const line = lines[position.line];

    let start = position.character;
    let end = position.character;
    while (start > 0 && /[\w$]/.test(line[start - 1])) start--;
    while (end < line.length && /[\w$]/.test(line[end])) end++;

    if (start === end) return null;
    return line.slice(start, end);
  }

  private getWordAfterDot(line: string, dotPosition: number): string {
    let end = dotPosition;
    while (end < line.length && /[\w$]/.test(line[end])) end++;
    return line.slice(dotPosition, end);
  }
}
