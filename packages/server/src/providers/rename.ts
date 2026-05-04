import type {
  CancellationToken,
  Position,
  Range,
  WorkspaceEdit,
  TextDocuments,
} from "vscode-languageserver/node.js";
import { TextEdit, ResponseError, ErrorCodes } from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import * as fs from "node:fs";
import * as path from "node:path";
import { URI } from "vscode-uri";
import type { SymbolIndex } from "../analyzer/symbol-index.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";
import type { SolcBridge } from "../compiler/solc-bridge.js";
import { getWordAtPosition, isInsideString, SOLIDITY_KEYWORDS } from "../utils/text.js";

/**
 * Provides cross-file rename refactoring for Solidity symbols.
 *
 * Supports renaming:
 * - Contract / interface / library names
 * - Function names (including overrides in the inheritance chain)
 * - Event and error names
 * - State variable names
 * - Struct and enum names
 * - Modifier names
 *
 * Safety:
 * - prepareRename validates that the cursor is on a renameable symbol
 * - Scans all workspace files for occurrences
 * - Uses word-boundary matching to avoid false positives
 * - Preserves import aliases (only renames the source, not the alias)
 */
export class RenameProvider {
  private solcBridge: SolcBridge | null = null;

  constructor(
    private symbolIndex: SymbolIndex,
    private workspace: WorkspaceManager,
    private documents: TextDocuments<TextDocument>,
  ) {}

  /**
   * Wire the SolcBridge so we can offer scope-aware rename for local
   * variables and parameters when a successful `forge build` has
   * produced a type-resolved AST. Without the bridge, locals still
   * get rejected (same behaviour as before).
   */
  setSolcBridge(bridge: SolcBridge): void {
    this.solcBridge = bridge;
  }

  /**
   * Validate that the cursor is on a renameable symbol.
   *
   * Accept cases:
   *   1. The identifier is a top-level symbol in the global index
   *      (contract, function, event, error, struct, enum, modifier,
   *      state variable, UDVT) — handled by the workspace-wide rename
   *      below.
   *   2. The identifier is a local variable or parameter AND the
   *      SolcBridge can resolve it to a specific declaration within
   *      a function scope — handled by the single-file solc-driven
   *      rename below.
   *
   * Rejected cases (with a clear client-side error):
   *   - Solidity keywords
   *   - Non-identifier positions (whitespace, punctuation)
   *   - Identifiers not in either code path (likely unresolved or
   *     from a file that hasn't compiled successfully yet)
   *   - Global-index identifiers with multiple mismatched kinds
   */
  prepareRename(
    document: TextDocument,
    position: Position,
  ): { range: Range; placeholder: string } | null {
    const text = document.getText();
    const word = getWordAtPosition(text, position);
    if (!word) return null;

    if (SOLIDITY_KEYWORDS.has(word.text)) return null;

    const symbols = this.symbolIndex.findSymbols(word.text);

    if (symbols.length > 0) {
      const uniqueKinds = Array.from(new Set(symbols.map((s) => s.kind))).sort();
      if (uniqueKinds.length > 1) {
        throw new ResponseError(
          ErrorCodes.InvalidRequest,
          `Cannot rename: '${word.text}' refers to multiple symbol kinds ` +
            `(${uniqueKinds.join(", ")}). Rename would be ambiguous.`,
        );
      }
      return { range: word.range, placeholder: word.text };
    }

    // Fallback: local variable / parameter via SolcBridge.
    if (this.canRenameLocalAt(document, position)) {
      return { range: word.range, placeholder: word.text };
    }

    throw new ResponseError(
      ErrorCodes.InvalidRequest,
      `Cannot rename '${word.text}'. It is not in the workspace symbol index, ` +
        `and no type-resolved AST is available (this typically means the project ` +
        `has not been successfully built yet — save a file to trigger \`forge build\`).`,
    );
  }

  private canRenameLocalAt(document: TextDocument, position: Position): boolean {
    if (!this.solcBridge) return false;
    const fsPath = this.workspace.uriToPath(document.uri);
    const offset = document.offsetAt(position);
    const info = this.solcBridge.findLocalReferences(fsPath, offset);
    return info !== null;
  }

  /**
   * Perform the rename across all workspace files.
   */
  async provideRename(
    document: TextDocument,
    position: Position,
    newName: string,
    token?: CancellationToken,
  ): Promise<WorkspaceEdit | null> {
    // Two rename paths:
    //   1. Scope-aware (SolcBridge): local variable / parameter inside a
    //      function — rewrite only the byte ranges the solc AST attributes
    //      to this declaration, in a single file.
    //   2. Workspace-wide (symbol index): top-level symbol — scan every
    //      workspace file for word-boundary matches, excluding `lib/`.
    //
    // `prepareRename` has already narrowed the set of callers to these
    // two categories; still, we defensively re-check here so a stale
    // client can't bypass the guardrails.

    const text = document.getText();
    const wordResult = getWordAtPosition(text, position);
    if (!wordResult) return null;

    const oldName = wordResult.text;
    if (oldName === newName) return null;

    if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(newName)) return null;

    // Prefer the solc path for identifiers that aren't in the global
    // symbol index — those are locals / parameters / block-scoped
    // bindings.
    if (this.symbolIndex.findSymbols(oldName).length === 0) {
      return this.provideLocalRename(document, position, newName);
    }

    const semantic = this.provideSemanticRename(document, position, oldName, newName);
    if (semantic) return semantic;

    const libDirs = this.workspace.libDirs;
    const isInLibDir = (uri: string): boolean => {
      const filePath = this.workspace.uriToPath(uri);
      return libDirs.some(
        (libDir) => filePath === libDir || filePath.startsWith(libDir + path.sep),
      );
    };

    const changes: Record<string, TextEdit[]> = {};

    // 1. Find all occurrences in currently open documents (skip lib/).
    for (const doc of this.documents.all()) {
      if (token?.isCancellationRequested) return null;
      if (isInLibDir(doc.uri)) continue;
      const edits = this.findOccurrencesInText(doc.getText(), oldName, doc.uri);
      if (edits.length > 0) {
        changes[doc.uri] = edits.map((range) => TextEdit.replace(range, newName));
      }
    }

    // 2. Scan all workspace files (not currently open), skipping lib/.
    const allUris = this.workspace.getAllFileUris();
    for (const uri of allUris) {
      if (token?.isCancellationRequested) return null;
      if (changes[uri]) continue; // Already processed from open docs
      if (isInLibDir(uri)) continue;

      try {
        const filePath = this.workspace.uriToPath(uri);
        const fileText = fs.readFileSync(filePath, "utf-8");
        const edits = this.findOccurrencesInText(fileText, oldName, uri);
        if (edits.length > 0) {
          changes[uri] = edits.map((range) => TextEdit.replace(range, newName));
        }
      } catch {
        // File might not exist or be unreadable
      }
    }

    if (Object.keys(changes).length === 0) return null;

    return { changes };
  }

  /**
   * Workspace rename through solc declaration IDs. When available, this
   * avoids rewriting unrelated same-named symbols, overloads, shadowed
   * locals, strings, and comments. Falls back to the text-scan path when
   * the rich AST cache is cold or cannot map the declaration back to a
   * symbol-index name range.
   */
  private provideSemanticRename(
    document: TextDocument,
    position: Position,
    oldName: string,
    newName: string,
  ): WorkspaceEdit | null {
    if (!this.solcBridge) return null;

    const fsPath = this.workspace.uriToPath(document.uri);
    const refs = this.solcBridge.findReferencesAt(fsPath, document.offsetAt(position));
    if (!refs) return null;

    const declarationEdit = refs.declaration
      ? this.semanticDeclarationEdit(refs.declaration, oldName, newName)
      : null;

    const changes: Record<string, TextEdit[]> = {};
    const push = (uri: string, edit: TextEdit): void => {
      changes[uri] = [...(changes[uri] ?? []), edit];
    };

    if (declarationEdit) push(declarationEdit.uri, declarationEdit.edit);

    for (const ref of refs.references) {
      const uri = this.uriForPath(ref.filePath);
      const doc = this.documents.get(uri);
      const text = doc?.getText() ?? this.readFile(ref.filePath);
      if (text === null) continue;
      const lspDoc = doc ?? TextDocument.create(uri, "solidity", 1, text);
      const start = lspDoc.positionAt(ref.offset);
      const end = lspDoc.positionAt(ref.offset + ref.length);
      push(uri, TextEdit.replace({ start, end }, newName));
    }

    for (const [uri, edits] of Object.entries(changes)) {
      const seen = new Set<string>();
      changes[uri] = edits.filter((edit) => {
        const key = `${edit.range.start.line}:${edit.range.start.character}:${edit.range.end.line}:${edit.range.end.character}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    return Object.keys(changes).length > 0 ? { changes } : null;
  }

  private semanticDeclarationEdit(
    declaration: { filePath: string; offset: number; length: number },
    oldName: string,
    newName: string,
  ): { uri: string; edit: TextEdit } | null {
    const uri = this.uriForPath(declaration.filePath);
    const symbols = this.symbolIndex.findSymbols(oldName).filter((sym) => sym.filePath === uri);
    const symbol = symbols.find((sym) => {
      const doc = this.documents.get(uri);
      const text = doc?.getText() ?? this.readFile(declaration.filePath);
      if (text === null) return false;
      const lspDoc = doc ?? TextDocument.create(uri, "solidity", 1, text);
      const start = lspDoc.offsetAt(sym.nameRange.start);
      const end = lspDoc.offsetAt(sym.nameRange.end);
      return start >= declaration.offset && end <= declaration.offset + declaration.length;
    });
    if (!symbol) return null;
    return { uri, edit: TextEdit.replace(symbol.nameRange, newName) };
  }

  private uriForPath(filePath: string): string {
    return URI.file(path.isAbsolute(filePath) ? filePath : path.join(this.workspace.root, filePath)).toString();
  }

  private readFile(filePath: string): string | null {
    try {
      return fs.readFileSync(
        path.isAbsolute(filePath) ? filePath : path.join(this.workspace.root, filePath),
        "utf-8",
      );
    } catch {
      return null;
    }
  }

  /**
   * Single-file scope-aware rename for a local variable or parameter
   * via the solc-resolved AST.
   *
   * The solc AST gives us precise byte ranges for:
   *   - the declaration site
   *   - every reference to that declaration (only within this file,
   *     since locals don't cross files)
   *
   * We convert each byte range to an LSP (line, character) pair using
   * the document's own `positionAt` — this handles CRLF and UTF-8
   * multibyte characters correctly without needing LineIndex.
   */
  private provideLocalRename(
    document: TextDocument,
    position: Position,
    newName: string,
  ): WorkspaceEdit | null {
    if (!this.solcBridge) return null;

    const fsPath = this.workspace.uriToPath(document.uri);
    const offset = document.offsetAt(position);
    const info = this.solcBridge.findLocalReferences(fsPath, offset);
    if (!info) return null;

    // Gather every rewrite site: the declaration itself + every reference.
    // We replace just the IDENTIFIER portion, not the full declaration
    // range (which includes the type + optional storage location). The
    // name is always the last `info.nameLength` bytes of the identifier
    // — but for VariableDeclarations, solc's `src` actually covers the
    // whole `uint256 memory foo` chunk. The cleanest portable approach
    // is to find the `name` string starting from the end of the decl
    // range.

    const edits: TextEdit[] = [];

    // Declaration rewrite: locate `name` at or near the end of the
    // declaration range.
    const declEdit = this.declarationNameEdit(
      document,
      info.declarationOffset,
      info.declarationLength,
      info.nameLength,
      newName,
    );
    if (declEdit) edits.push(declEdit);

    // Reference rewrites: every Identifier we collected is exactly the
    // name, so the range is the full src range.
    for (const ref of info.references) {
      const start = document.positionAt(ref.offset);
      const end = document.positionAt(ref.offset + ref.length);
      edits.push(TextEdit.replace({ start, end }, newName));
    }

    if (edits.length === 0) return null;

    return {
      changes: {
        [document.uri]: edits,
      },
    };
  }

  /**
   * Compute the TextEdit for the identifier within a VariableDeclaration's
   * source range. solc's `src` for a declaration covers the whole
   * `<type> <storage-location> <name>` sequence, so we locate the name
   * substring at the tail of that range.
   */
  private declarationNameEdit(
    document: TextDocument,
    declOffset: number,
    declLength: number,
    nameLength: number,
    newName: string,
  ): TextEdit | null {
    const text = document.getText();
    const declText = text.slice(declOffset, declOffset + declLength);
    // Find the last word of length `nameLength`. We take the last
    // identifier character run that has the right length — this is
    // robust against multi-line declarations and doesn't depend on
    // the exact serialization of type names.
    const identRe = /[A-Za-z_$][A-Za-z0-9_$]*/g;
    let lastMatch: RegExpExecArray | null = null;
    for (
      let m: RegExpExecArray | null = identRe.exec(declText);
      m !== null;
      m = identRe.exec(declText)
    ) {
      lastMatch = m;
    }
    if (!lastMatch || lastMatch[0].length !== nameLength) return null;

    const nameOffset = declOffset + lastMatch.index;
    const start = document.positionAt(nameOffset);
    const end = document.positionAt(nameOffset + nameLength);
    return TextEdit.replace({ start, end }, newName);
  }

  /**
   * Find all occurrences of a symbol name in text, using word-boundary matching.
   * Returns ranges for each occurrence.
   */
  private findOccurrencesInText(text: string, symbolName: string, uri: string): Range[] {
    const ranges: Range[] = [];
    const lines = text.split("\n");

    // Build a word-boundary regex
    const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`\\b${escaped}\\b`, "g");

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      const line = lines[lineNum];

      // Skip comments
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

      // Skip string literals (simple heuristic)
      let match: RegExpExecArray | null;
      regex.lastIndex = 0;

      while ((match = regex.exec(line)) !== null) {
        const col = match.index;

        // Check we're not inside a string literal
        if (isInsideString(line, col)) continue;

        // Check we're not inside a comment on this line
        if (this.isInsideLineComment(line, col)) continue;

        ranges.push({
          start: { line: lineNum, character: col },
          end: { line: lineNum, character: col + symbolName.length },
        });
      }
    }

    return ranges;
  }

  private isInsideLineComment(line: string, position: number): boolean {
    const commentStart = line.indexOf("//");
    return commentStart !== -1 && commentStart < position;
  }
}
