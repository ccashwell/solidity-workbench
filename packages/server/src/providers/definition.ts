import type { Definition, Position } from "vscode-languageserver/node.js";
import { Location } from "vscode-languageserver/node.js";
import type { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import type { SymbolIndex } from "../analyzer/symbol-index.js";
import type { SolidityParser } from "../parser/solidity-parser.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";
import type { SolcBridge } from "../compiler/solc-bridge.js";
import type { ResolvedContract, SemanticResolver } from "../analyzer/semantic-resolver.js";
import type { ContractDefinition, SolSymbol, SourceRange } from "@solidity-workbench/common";
import { resolveDottedReceiverTypeName } from "../utils/receiver-type.js";
import {
  getWordAtPosition,
  extractDottedReceiver,
  findLocalVariableType,
  getFunctionBodyTextPrefix,
  stripTypeDecorations,
} from "../utils/text.js";
import { findUsingForFunction } from "../utils/using-for.js";
import { getEnclosingContract, getEnclosingFunctionScope } from "../utils/scope.js";
import {
  findNatspecReferenceMatches,
  isNatspecReferenceTarget,
  resolveNatspecReference,
  symbolDocumentUri,
} from "../utils/natspec-references.js";
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
    private parser: SolidityParser,
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

    const natspecReference = this.resolveNatspecReferenceAtPosition(document.uri, text, position);
    if (natspecReference) return natspecReference;

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

    const importSymbol = this.resolveImportSymbolAtPosition(text, position, document.uri);
    if (importSymbol) return importSymbol;

    const importedSymbol = this.resolveImportedSymbolReference(word, document.uri);
    if (importedSymbol) return importedSymbol;

    // Check for dotted access (Type.member or receiver.member)
    const dottedTarget = this.getDottedAccess(text, position);
    if (dottedTarget) {
      const receiverType =
        resolveDottedReceiverTypeName(
          this.parser,
          this.symbolIndex,
          document.uri,
          position,
          dottedTarget.dottedPath ?? dottedTarget.type,
        ) ?? dottedTarget.type;

      const resolved = this.resolveMemberDefinition(
        receiverType,
        dottedTarget.member,
        document.uri,
        position,
      );
      if (resolved) return resolved;

      if (this.solcBridge) {
        const solcResolved = this.resolveViaSolc(document, position);
        if (solcResolved) {
          return Location.create(solcResolved.uri, {
            start: { line: solcResolved.line, character: solcResolved.character },
            end: { line: solcResolved.line, character: solcResolved.character + word.length },
          });
        }
      }

      return null;
    }

    // Look up in symbol index
    const symbols = this.filterVisibleSymbols(document.uri, this.symbolIndex.findSymbols(word), {
      includeNamespaceImports: false,
    });
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

    const scopedType = this.resolveScopedVariableType(document, position, word);
    if (scopedType) {
      const resolved = this.resolveTypeDefinition(scopedType, document.uri);
      if (resolved) return resolved;
    }

    const symbols = this.filterVisibleSymbols(document.uri, this.symbolIndex.findSymbols(word), {
      includeNamespaceImports: false,
    });
    const selected = this.selectTypeCarrierSymbol(document, position, symbols);
    if (selected?.detail) {
      const resolved = this.resolveTypeDefinition(selected.detail, document.uri);
      if (resolved) return resolved;
    }

    return null;
  }

  private selectTypeCarrierSymbol(
    document: TextDocument,
    position: Position,
    symbols: SolSymbol[],
  ): SolSymbol | undefined {
    const typeCarriers = symbols.filter((sym) => this.isTypeCarrierSymbol(sym));
    const atCursor = typeCarriers
      .filter((sym) => sym.filePath === document.uri && this.rangeContains(sym.nameRange, position))
      .sort((a, b) => this.rangeSize(a.nameRange) - this.rangeSize(b.nameRange));
    if (atCursor[0]) return atCursor[0];

    const sourceUnit = this.parser.get(document.uri)?.sourceUnit;
    const scope = sourceUnit ? getEnclosingFunctionScope(sourceUnit, position) : undefined;
    const contract =
      scope?.contract ?? (sourceUnit ? getEnclosingContract(sourceUnit, position.line) : undefined);
    if (contract) {
      const sameContainer = typeCarriers.find(
        (sym) => sym.filePath === document.uri && sym.containerName === contract.name,
      );
      if (sameContainer) return sameContainer;
    }

    return typeCarriers.find((sym) => sym.filePath === document.uri) ?? typeCarriers[0];
  }

  private isTypeCarrierSymbol(sym: SolSymbol): boolean {
    return (
      sym.kind === "stateVariable" ||
      sym.kind === "fileConstant" ||
      sym.kind === "parameter" ||
      sym.kind === "localVariable"
    );
  }

  private resolveScopedVariableType(
    document: TextDocument,
    position: Position,
    word: string,
  ): string | undefined {
    const sourceUnit = this.parser.get(document.uri)?.sourceUnit;
    if (!sourceUnit) return undefined;
    const scope = getEnclosingFunctionScope(sourceUnit, position);
    if (!scope) return undefined;

    const bodyPrefix = getFunctionBodyTextPrefix(
      document.getText(),
      scope.fn.range.start.line,
      position.line,
      position.character,
    );
    if (bodyPrefix) {
      const localType = findLocalVariableType(bodyPrefix, word);
      if (localType) return localType;
    }

    const params = [...scope.fn.parameters, ...scope.fn.returnParameters];
    const declaredAtCursor = params.find(
      (param) =>
        param.name === word && param.nameRange && this.rangeContains(param.nameRange, position),
    );
    if (declaredAtCursor) return declaredAtCursor.typeName;

    const inFunctionBody =
      position.line > scope.fn.range.start.line ||
      (position.line === scope.fn.range.start.line &&
        position.character >= scope.fn.range.start.character);
    if (!inFunctionBody) return undefined;

    const paramType = params.find((param) => param.name === word)?.typeName;
    if (paramType) return paramType;

    if (scope.contract) {
      const directState = scope.contract.stateVariables.find((variable) => variable.name === word);
      if (directState) return directState.typeName;

      const inherited = this.resolver?.findMemberInInheritanceChain(
        scope.contract.name,
        word,
        document.uri,
      );
      if (inherited?.kind === "stateVariable") {
        return inherited.detail;
      }
    }

    return undefined;
  }

  private resolveTypeDefinition(typeName: string, fromUri: string): Definition | null {
    const normalized = stripTypeDecorations(typeName);
    if (!normalized) return null;

    const names = normalized.includes(".")
      ? [normalized, normalized.split(".").pop() ?? normalized]
      : [normalized];
    const candidates: SolSymbol[] = [];
    const seen = new Set<string>();
    for (const name of names) {
      for (const sym of this.symbolIndex.findSymbols(name)) {
        if (!this.isTypeSymbol(sym)) continue;
        const key = `${sym.filePath}:${sym.kind}:${sym.name}:${sym.nameRange.start.line}:${sym.nameRange.start.character}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(sym);
      }
    }

    const visible = this.resolver
      ? this.resolver.filterVisibleSymbols(fromUri, candidates, {
          includeNamespaceImports: normalized.includes("."),
        })
      : candidates;
    if (visible.length === 0) return null;
    const sameFile = visible.filter((sym) => sym.filePath === fromUri);
    const selected = sameFile.length > 0 ? sameFile : visible;
    return selected.map((sym) => Location.create(sym.filePath, sym.nameRange));
  }

  private resolveImportedSymbolReference(word: string, fromUri: string): Definition | null {
    const imported = this.resolver?.resolveImportedSymbol(word, fromUri);
    if (!imported) return null;

    const symbols = this.symbolIndex
      .findSymbols(imported.name)
      .filter((sym) => sym.filePath === imported.uri);
    if (symbols.length === 0) return null;
    if (symbols.length === 1) return Location.create(symbols[0].filePath, symbols[0].nameRange);
    return symbols.map((sym) => Location.create(sym.filePath, sym.nameRange));
  }

  private filterVisibleSymbols<T extends { filePath: string }>(
    fromUri: string,
    symbols: T[],
    options?: { includeNamespaceImports?: boolean },
  ): T[] {
    return this.resolver ? this.resolver.filterVisibleSymbols(fromUri, symbols, options) : symbols;
  }

  private resolveNatspecReferenceAtPosition(
    documentUri: string,
    text: string,
    position: Position,
  ): Definition | null {
    const comment = this.natspecCommentRangeAtPosition(text, position);
    if (!comment) return null;
    const fromSymbol = this.findDocumentedSymbol(documentUri, comment.endLine);
    const line = text.split("\n")[position.line] ?? "";
    for (const match of findNatspecReferenceMatches(line)) {
      if (position.character < match.start || position.character > match.end) continue;

      const target = resolveNatspecReference(
        match.ref,
        documentUri,
        this.symbolIndex,
        this.resolver,
        fromSymbol,
      );
      return target ? Location.create(symbolDocumentUri(target), target.nameRange) : null;
    }
    return null;
  }

  private isInsideNatspecComment(text: string, position: Position): boolean {
    return this.natspecCommentRangeAtPosition(text, position) !== null;
  }

  private natspecCommentRangeAtPosition(
    text: string,
    position: Position,
  ): { startLine: number; endLine: number } | null {
    const lines = text.split("\n");
    const line = lines[position.line] ?? "";
    const trimmed = line.trimStart();
    if (trimmed.startsWith("///")) {
      let startLine = position.line;
      while (startLine > 0 && (lines[startLine - 1] ?? "").trimStart().startsWith("///")) {
        startLine--;
      }
      let endLine = position.line;
      while (
        endLine + 1 < lines.length &&
        (lines[endLine + 1] ?? "").trimStart().startsWith("///")
      ) {
        endLine++;
      }
      return { startLine, endLine };
    }

    let openLine = -1;
    for (let i = position.line; i >= 0; i--) {
      const candidate = lines[i] ?? "";
      const open = candidate.indexOf("/**");
      const close = candidate.indexOf("*/");
      if (close >= 0 && (i < position.line || close < position.character)) return null;
      if (open >= 0) {
        openLine = i;
        break;
      }
    }
    if (openLine < 0) return null;

    for (let i = openLine; i <= position.line; i++) {
      const close = (lines[i] ?? "").indexOf("*/");
      if (close >= 0 && (i < position.line || close < position.character)) return null;
    }

    let endLine = position.line;
    while (endLine < lines.length && !(lines[endLine] ?? "").includes("*/")) endLine++;
    return { startLine: openLine, endLine: Math.min(endLine, lines.length - 1) };
  }

  private findDocumentedSymbol(uri: string, commentEndLine: number): SolSymbol | undefined {
    return this.symbolIndex
      .getFileSymbols(uri)
      .filter(isNatspecReferenceTarget)
      .filter((symbol) => symbol.range.start.line > commentEndLine)
      .sort(
        (a, b) =>
          a.range.start.line - b.range.start.line ||
          a.range.start.character - b.range.start.character ||
          this.rangeSize(a.range) - this.rangeSize(b.range),
      )[0];
  }

  private isTypeSymbol(sym: SolSymbol): boolean {
    return (
      sym.kind === "contract" ||
      sym.kind === "interface" ||
      sym.kind === "library" ||
      sym.kind === "struct" ||
      sym.kind === "enum" ||
      sym.kind === "userDefinedValueType"
    );
  }

  private rangeContains(range: SourceRange, position: Position): boolean {
    if (position.line < range.start.line || position.line > range.end.line) return false;
    if (position.line === range.start.line && position.character < range.start.character) {
      return false;
    }
    if (position.line === range.end.line && position.character > range.end.character) {
      return false;
    }
    return true;
  }

  private rangeSize(range: SourceRange): number {
    return (
      (range.end.line - range.start.line) * 10_000 + (range.end.character - range.start.character)
    );
  }

  private resolveImportSymbolAtPosition(
    text: string,
    position: Position,
    fromUri: string,
  ): Definition | null {
    const line = text.split("\n")[position.line] ?? "";
    const braceImport = line.match(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/);
    if (!braceImport) return null;

    const symbolSpec = braceImport[1];
    const importPath = braceImport[2];
    const pathStart = line.indexOf(importPath);
    const pathEnd = pathStart + importPath.length;
    if (position.character >= pathStart && position.character <= pathEnd) {
      return null;
    }

    const resolvedPath = this.workspace.resolveImport(
      importPath,
      this.workspace.uriToPath(fromUri),
    );
    if (!resolvedPath) return null;

    const targetUri = URI.file(resolvedPath).toString();
    if (!this.parser.get(targetUri)) {
      try {
        const source = readFileSync(resolvedPath, "utf-8");
        this.parser.parse(targetUri, source);
        this.symbolIndex.updateFile(targetUri);
      } catch {
        return null;
      }
    }

    const specs = symbolSpec.split(",").map((part) => part.trim());
    for (const spec of specs) {
      const asMatch = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(spec);
      const exportedName = asMatch?.[1] ?? spec;
      const localName = asMatch?.[2] ?? spec;
      const labels = asMatch ? [localName, exportedName] : [exportedName];

      for (const label of labels) {
        const start = line.indexOf(label);
        if (start < 0) continue;
        const end = start + label.length;
        if (position.character < start || position.character > end) continue;

        const symbols = this.symbolIndex
          .findSymbols(exportedName)
          .filter((sym) => sym.filePath === targetUri);
        if (symbols.length === 0) return null;
        if (symbols.length === 1) {
          return Location.create(symbols[0].filePath, symbols[0].nameRange);
        }
        const sameFile = symbols.filter((s) => s.filePath === targetUri);
        return sameFile.map((s) => Location.create(s.filePath, s.nameRange));
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
    position?: Position,
  ): Definition | null {
    if (fromUri && position !== undefined) {
      const sourceUnit = this.parser.get(fromUri)?.sourceUnit;
      const contract = sourceUnit ? getEnclosingContract(sourceUnit, position.line) : undefined;
      const hit = findUsingForFunction(
        this.parser,
        this.symbolIndex,
        fromUri,
        contract,
        typeName,
        memberName,
        undefined,
        this.resolver,
      );
      if (hit) {
        return Location.create(hit.filePath, hit.fn.nameRange);
      }
    }

    if (this.resolver && fromUri) {
      const chain = this.resolveVisibleInheritanceChain(typeName, fromUri);
      for (const entry of chain) {
        const resolved = this.resolver.findMemberInContract(entry, memberName);
        if (resolved) return Location.create(resolved.filePath, resolved.nameRange);
      }
    } else {
      const chain = fromUri
        ? this.getParserInheritanceChain(typeName, fromUri)
        : this.symbolIndex.getInheritanceChain(typeName).flatMap((contract) => {
            const entry = this.symbolIndex.getContract(contract.name);
            return entry ? [entry] : [];
          });
      for (const entry of chain) {
        const contract = entry.contract;
        const func = contract.functions.find((f) => f.name === memberName);
        if (func) {
          if (entry) return Location.create(entry.uri, func.nameRange);
        }

        const svar = contract.stateVariables.find((v) => v.name === memberName);
        if (svar) {
          if (entry) return Location.create(entry.uri, svar.nameRange);
        }

        const event = contract.events.find((e) => e.name === memberName);
        if (event) {
          if (entry) return Location.create(entry.uri, event.nameRange);
        }
      }
    }

    const structMember = this.symbolIndex.findContainerMember(
      memberName,
      typeName,
      "structMember",
      fromUri,
    );
    if (structMember) {
      return Location.create(structMember.filePath, structMember.nameRange);
    }

    const enumMember = this.symbolIndex.findContainerMember(
      memberName,
      typeName,
      "enumMember",
      fromUri,
    );
    if (enumMember) {
      return Location.create(enumMember.filePath, enumMember.nameRange);
    }

    return null;
  }

  private getParserInheritanceChain(
    typeName: string,
    fromUri: string,
  ): Array<{ uri: string; contract: ContractDefinition }> {
    const root = this.resolveParserVisibleContract(typeName, fromUri);
    if (!root) return [];

    const chain: Array<{ uri: string; contract: ContractDefinition }> = [];
    const visited = new Set<string>();

    const walk = (entry: { uri: string; contract: ContractDefinition }): void => {
      const key = `${entry.uri}#${entry.contract.name}`;
      if (visited.has(key)) return;
      visited.add(key);
      chain.push(entry);

      for (const base of entry.contract.baseContracts) {
        const baseEntry = this.resolveParserVisibleContract(base.baseName, entry.uri);
        if (baseEntry) walk(baseEntry);
      }
    };

    walk(root);
    return chain;
  }

  private resolveParserVisibleContract(
    typeName: string,
    fromUri: string,
  ): { uri: string; contract: ContractDefinition } | undefined {
    const local = this.symbolIndex.getContract(typeName, fromUri);
    if (local) return local;

    const sourceUnit = this.parser.get(fromUri)?.sourceUnit;
    if (!sourceUnit) return undefined;

    let fromPath: string;
    try {
      fromPath = this.workspace.uriToPath(fromUri);
    } catch {
      return undefined;
    }

    const scoped = typeName.includes(".") ? typeName.split(".") : null;
    for (const imp of sourceUnit.imports) {
      let targetPath: string | null;
      try {
        targetPath = this.workspace.resolveImport(imp.path, fromPath);
      } catch {
        targetPath = null;
      }
      if (!targetPath) continue;
      const targetUri = URI.file(targetPath).toString();

      if (scoped && imp.unitAlias === scoped[0] && scoped[1]) {
        return this.symbolIndex.getContract(scoped[1], targetUri);
      }

      if (scoped) continue;
      for (const alias of imp.symbolAliases ?? []) {
        const visibleName = alias.alias ?? alias.symbol;
        if (visibleName !== typeName) continue;
        return this.symbolIndex.getContract(alias.symbol, targetUri);
      }

      if (!imp.unitAlias && (imp.symbolAliases ?? []).length === 0) {
        const imported = this.symbolIndex.getContract(typeName, targetUri);
        if (imported) return imported;
      }
    }

    return undefined;
  }

  private resolveVisibleInheritanceChain(typeName: string, fromUri: string): ResolvedContract[] {
    if (!this.resolver) return [];

    const imported = this.resolver.resolveImportedSymbol(typeName, fromUri);
    if (imported) return this.resolver.getInheritanceChain(typeName, fromUri);

    const symbols = this.resolver.filterVisibleSymbols(
      fromUri,
      this.symbolIndex
        .findSymbols(typeName)
        .filter(
          (sym) => sym.kind === "contract" || sym.kind === "interface" || sym.kind === "library",
        ),
    );
    const sym = symbols.find((candidate) => candidate.filePath === fromUri) ?? symbols[0];
    const resolved = sym ? this.resolver.resolveContract(sym.name, sym.filePath) : undefined;
    return resolved ? this.resolver.getInheritanceChainFor(resolved) : [];
  }

  private getDottedAccess(
    text: string,
    position: Position,
  ): { type: string; member: string; dottedPath?: string } | null {
    const line = text.split("\n")[position.line] ?? "";
    let memberStart = position.character;
    while (memberStart > 0 && /[\w$]/.test(line[memberStart - 1])) memberStart--;
    if (memberStart === 0 || line[memberStart - 1] !== ".") return null;

    const dottedPath = extractDottedReceiver(line, memberStart);
    const receiver =
      dottedPath ??
      (() => {
        const receiverEnd = memberStart - 1;
        let receiverStart = receiverEnd;
        while (receiverStart > 0 && /[\w$]/.test(line[receiverStart - 1])) receiverStart--;
        return line.slice(receiverStart, receiverEnd);
      })();
    if (!receiver) return null;

    let memberEnd = position.character;
    while (memberEnd < line.length && /[\w$]/.test(line[memberEnd])) memberEnd++;

    const member = line.slice(memberStart, memberEnd);
    return member ? { type: receiver, member, dottedPath: dottedPath ?? undefined } : null;
  }
}
