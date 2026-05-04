import type { Definition, Position } from "vscode-languageserver/node.js";
import { Location } from "vscode-languageserver/node.js";
import type { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import type { SymbolIndex } from "../analyzer/symbol-index.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";
import type { SolcBridge } from "../compiler/solc-bridge.js";
import type { SemanticResolver } from "../analyzer/semantic-resolver.js";
import { getWordAtPosition } from "../utils/text.js";
import { readFileSync } from "node:fs";

/**
 * Provides go-to-definition and go-to-type-definition.
 *
 * Strategy:
 * 1. Get the word at the cursor position
 * 2. Look it up in the symbol index
 * 3. For imports, resolve the file path and jump to it
 * 4. For member access (e.g., contract.func), resolve through inheritance chain
 */
export class DefinitionProvider {
  private solcBridge: SolcBridge | null = null;

  constructor(
    private symbolIndex: SymbolIndex,
    private workspace: WorkspaceManager,
    private resolver?: SemanticResolver,
  ) {}

  /**
   * Wire the SolcBridge for overload and cross-file disambiguation.
   * When multiple symbols share a name we consult the solc AST's
   * `referencedDeclaration` so we jump to the actual target (not just
   * the first index match).
   */
  setSolcBridge(bridge: SolcBridge): void {
    this.solcBridge = bridge;
  }

  provideDefinition(document: TextDocument, position: Position): Definition | null {
    const text = document.getText();
    const word = getWordAtPosition(text, position)?.text ?? null;
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
      const resolved = this.resolveMemberDefinition(
        dottedTarget.type,
        dottedTarget.member,
        document.uri,
      );
      if (resolved || this.resolver) return resolved;
    }

    // Look up in symbol index
    const symbols = this.symbolIndex.findSymbols(word);
    if (symbols.length === 0) return null;

    // If there's only one definition, go directly
    if (symbols.length === 1) {
      return Location.create(symbols[0].filePath, symbols[0].nameRange);
    }

    // Multiple definitions — consult the solc AST when available. If it
    // resolves to a specific (file, offset) we convert that back to a
    // (line, character) range and prefer the matching symbol-index entry.
    if (this.solcBridge) {
      const solcResolved = this.resolveViaSolc(document, position);
      if (solcResolved) {
        const match = symbols.find(
          (s) =>
            s.filePath === solcResolved.uri &&
            s.nameRange.start.line === solcResolved.line &&
            Math.abs(s.nameRange.start.character - solcResolved.character) <= word.length,
        );
        if (match) {
          return Location.create(match.filePath, match.nameRange);
        }
      }
    }

    // Fallback: prefer same-file matches, then every match.
    const sameFile = symbols.filter((s) => s.filePath === document.uri);
    if (sameFile.length > 0) {
      return sameFile.map((s) => Location.create(s.filePath, s.nameRange));
    }

    return symbols.map((s) => Location.create(s.filePath, s.nameRange));
  }

  private resolveViaSolc(
    document: TextDocument,
    position: Position,
  ): { uri: string; line: number; character: number } | null {
    if (!this.solcBridge) return null;
    const fsPath = this.workspace.uriToPath(document.uri);
    const offset = document.offsetAt(position);
    const ref = this.solcBridge.resolveReference(fsPath, offset);
    if (!ref) return null;

    try {
      const text = readFileSync(ref.filePath, "utf-8");
      const prefix = text.slice(0, ref.offset);
      const line = prefix.split(/\r?\n/).length - 1;
      const character =
        prefix.length - Math.max(prefix.lastIndexOf("\n"), prefix.lastIndexOf("\r")) - 1;
      return {
        uri: URI.file(ref.filePath).toString(),
        line,
        character,
      };
    } catch {
      return null;
    }
  }

  provideTypeDefinition(document: TextDocument, position: Position): Definition | null {
    const text = document.getText();
    const word = getWordAtPosition(text, position)?.text ?? null;
    if (!word) return null;

    // Look up the symbol to find its type
    const symbols = this.symbolIndex.findSymbols(word);
    for (const sym of symbols) {
      if (
        sym.kind === "stateVariable" ||
        sym.kind === "parameter" ||
        sym.kind === "localVariable"
      ) {
        // The detail field contains the type name for variables
        if (sym.detail) {
          const typeName = sym.detail
            .replace(/\[\]$/, "")
            .replace(/\s+memory$/, "")
            .replace(/\s+storage$/, "");
          const typeSymbols = this.symbolIndex.findSymbols(typeName);
          if (typeSymbols.length > 0) {
            return typeSymbols.map((s) => Location.create(s.filePath, s.nameRange));
          }
        }
      }
    }

    return null;
  }

  private resolveImportAtPosition(text: string, position: Position): string | null {
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

  private resolveMemberDefinition(
    typeName: string,
    memberName: string,
    fromUri?: string,
  ): Definition | null {
    const resolved = this.resolver?.findMemberInInheritanceChain(typeName, memberName, fromUri);
    if (resolved) return Location.create(resolved.filePath, resolved.nameRange);

    const chain = this.symbolIndex.getInheritanceChain(typeName);
    for (const contract of chain) {
      const func = contract.functions.find((f) => f.name === memberName);
      if (func) {
        const entry = this.symbolIndex.getContract(contract.name);
        if (entry) return Location.create(entry.uri, func.nameRange);
      }

      const svar = contract.stateVariables.find((v) => v.name === memberName);
      if (svar) {
        const entry = this.symbolIndex.getContract(contract.name);
        if (entry) return Location.create(entry.uri, svar.nameRange);
      }

      const event = contract.events.find((e) => e.name === memberName);
      if (event) {
        const entry = this.symbolIndex.getContract(contract.name);
        if (entry) return Location.create(entry.uri, event.nameRange);
      }
    }
    return null;
  }

  private getDottedAccess(
    text: string,
    position: Position,
  ): { type: string; member: string } | null {
    const line = text.split("\n")[position.line] ?? "";
    let memberStart = position.character;
    while (memberStart > 0 && /[\w$]/.test(line[memberStart - 1])) memberStart--;
    if (memberStart === 0 || line[memberStart - 1] !== ".") return null;

    const receiverEnd = memberStart - 1;
    let receiverStart = receiverEnd;
    while (receiverStart > 0 && /[\w$]/.test(line[receiverStart - 1])) receiverStart--;
    if (receiverStart === receiverEnd) return null;

    let memberEnd = position.character;
    while (memberEnd < line.length && /[\w$]/.test(line[memberEnd])) memberEnd++;

    const receiver = line.slice(receiverStart, receiverEnd);
    const member = line.slice(memberStart, memberEnd);
    return receiver && member ? { type: receiver, member } : null;
  }
}
