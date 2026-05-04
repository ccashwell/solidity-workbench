import type { DocumentLink, Range } from "vscode-languageserver/node.js";
import type { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import type { SolidityParser } from "../parser/solidity-parser.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";

/**
 * Turns Solidity import paths into clickable document links.
 */
export class DocumentLinksProvider {
  constructor(
    private parser: SolidityParser,
    private workspace: WorkspaceManager,
  ) {}

  provideDocumentLinks(document: TextDocument): DocumentLink[] {
    const result = this.parser.get(document.uri);
    if (!result) return [];

    const lines = document.getText().split("\n");
    const fromPath = this.workspace.uriToPath(document.uri);
    const links: DocumentLink[] = [];

    for (const imp of result.sourceUnit.imports) {
      const target = this.workspace.resolveImport(imp.path, fromPath);
      if (!target) continue;

      const range = this.importPathRange(lines, imp.path, imp.range.start.line);
      if (!range) continue;

      links.push({
        range,
        target: URI.file(target).toString(),
        tooltip: `Open ${imp.path}`,
      });
    }

    return links;
  }

  private importPathRange(lines: string[], importPath: string, startLine: number): Range | null {
    for (let line = startLine; line < Math.min(lines.length, startLine + 4); line++) {
      const col = lines[line].indexOf(importPath);
      if (col === -1) continue;
      return {
        start: { line, character: col },
        end: { line, character: col + importPath.length },
      };
    }
    return null;
  }
}
