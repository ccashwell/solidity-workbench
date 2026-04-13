import type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  Position,
  Range} from "vscode-languageserver/node.js";
import {
  SymbolKind,
} from "vscode-languageserver/node.js";
import type { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import * as fs from "node:fs";
import type { SymbolIndex } from "../analyzer/symbol-index.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";
import type { SolidityParser } from "../parser/solidity-parser.js";

/**
 * Call Hierarchy provider — traces call chains through the codebase.
 *
 * "Show Incoming Calls" → who calls this function?
 * "Show Outgoing Calls" → what does this function call?
 *
 * This is critical for understanding control flow in complex protocol code
 * where a single function may be called through multiple entry points
 * (routers, multicall, proxy delegates, etc.).
 *
 * Strategy:
 * 1. Build a call graph by scanning function bodies for identifier references
 * 2. Cross-reference with the symbol index to resolve call targets
 * 3. Walk the inheritance chain for virtual/override dispatch
 */
export class CallHierarchyProvider {
  /** calleeFunction → [callerFunction, ...] */
  private incomingCalls: Map<string, CallSite[]> = new Map();
  /** callerFunction → [calleeFunction, ...] */
  private outgoingCalls: Map<string, CallSite[]> = new Map();

  private indexed = false;

  constructor(
    private symbolIndex: SymbolIndex,
    private workspace: WorkspaceManager,
    private parser: SolidityParser,
  ) {}

  /**
   * Prepare: identify the function at the cursor position.
   */
  prepareCallHierarchy(document: TextDocument, position: Position): CallHierarchyItem[] {
    const text = document.getText();
    const word = this.getWordAtPosition(text, position);
    if (!word) return [];

    const symbols = this.symbolIndex.findSymbols(word);
    const funcSymbols = symbols.filter((s) => s.kind === "function" || s.kind === "modifier");

    if (funcSymbols.length === 0) return [];

    return funcSymbols.map((sym) => ({
      name: sym.name,
      kind: sym.kind === "modifier" ? SymbolKind.Method : SymbolKind.Function,
      uri: sym.filePath,
      range: sym.range,
      selectionRange: sym.nameRange,
      detail: sym.containerName,
    }));
  }

  /**
   * Get incoming calls — who calls this function?
   */
  async getIncomingCalls(item: CallHierarchyItem): Promise<CallHierarchyIncomingCall[]> {
    await this.ensureIndexed();

    const key = this.makeKey(item.uri, item.name);
    const sites = this.incomingCalls.get(key) ?? [];

    // Also check by just the function name (for cross-contract calls)
    const nameOnlySites = this.incomingCalls.get(item.name) ?? [];
    const allSites = [...sites, ...nameOnlySites];

    // Group by caller function
    const callerMap = new Map<string, { item: CallHierarchyItem; ranges: Range[] }>();

    for (const site of allSites) {
      const callerKey = `${site.callerUri}:${site.callerName}`;
      let entry = callerMap.get(callerKey);

      if (!entry) {
        const callerSymbols = this.symbolIndex.findSymbols(site.callerName);
        const callerSym =
          callerSymbols.find((s) => s.filePath === site.callerUri) ?? callerSymbols[0];
        if (!callerSym) continue;

        entry = {
          item: {
            name: site.callerName,
            kind: SymbolKind.Function,
            uri: site.callerUri,
            range: callerSym.range,
            selectionRange: callerSym.nameRange,
            detail: callerSym.containerName,
          },
          ranges: [],
        };
        callerMap.set(callerKey, entry);
      }

      entry.ranges.push(site.callRange);
    }

    return Array.from(callerMap.values()).map((entry) => ({
      from: entry.item,
      fromRanges: entry.ranges,
    }));
  }

  /**
   * Get outgoing calls — what does this function call?
   */
  async getOutgoingCalls(item: CallHierarchyItem): Promise<CallHierarchyOutgoingCall[]> {
    await this.ensureIndexed();

    const key = this.makeKey(item.uri, item.name);
    const sites = this.outgoingCalls.get(key) ?? [];

    // Group by callee function
    const calleeMap = new Map<string, { item: CallHierarchyItem; ranges: Range[] }>();

    for (const site of sites) {
      const calleeKey = site.calleeName;
      let entry = calleeMap.get(calleeKey);

      if (!entry) {
        const calleeSymbols = this.symbolIndex.findSymbols(site.calleeName);
        const calleeSym = calleeSymbols[0];
        if (!calleeSym) continue;

        entry = {
          item: {
            name: site.calleeName,
            kind: SymbolKind.Function,
            uri: calleeSym.filePath,
            range: calleeSym.range,
            selectionRange: calleeSym.nameRange,
            detail: calleeSym.containerName,
          },
          ranges: [],
        };
        calleeMap.set(calleeKey, entry);
      }

      entry.ranges.push(site.callRange);
    }

    return Array.from(calleeMap.values()).map((entry) => ({
      to: entry.item,
      fromRanges: entry.ranges,
    }));
  }

  /**
   * Build the call graph by scanning all workspace files.
   */
  private async ensureIndexed(): Promise<void> {
    if (this.indexed) return;

    const allUris = this.workspace.getAllFileUris();
    for (const uri of allUris) {
      try {
        const filePath = this.workspace.uriToPath(uri);
        const text = fs.readFileSync(filePath, "utf-8");
        this.indexCallsInFile(uri, text);
      } catch {
        // skip unreadable files
      }
    }

    this.indexed = true;
  }

  /**
   * Index all function calls within a file by scanning function bodies.
   */
  private indexCallsInFile(uri: string, text: string): void {
    const result = this.parser.get(uri) ?? this.parser.parse(uri, text);
    const lines = text.split("\n");

    for (const contract of result.sourceUnit.contracts) {
      for (const func of contract.functions) {
        const callerName = func.name ?? func.kind;
        const callerKey = this.makeKey(uri, callerName);

        // Get the function body text (between { and })
        const bodyRange = this.getFunctionBodyRange(text, func.range.start.line);
        if (!bodyRange) continue;

        const bodyText = lines.slice(bodyRange.start, bodyRange.end + 1).join("\n");

        // Find all function-call-like patterns in the body
        const callRe = /\b([a-zA-Z_$][\w$]*)\s*\(/g;
        let match: RegExpExecArray | null;

        while ((match = callRe.exec(bodyText)) !== null) {
          const calleeName = match[1];

          // Skip keywords and common non-function patterns
          if (this.isCallKeyword(calleeName)) continue;

          // Skip type casts like uint256(...), address(...)
          if (this.isSolidityType(calleeName)) continue;

          const callLine = bodyRange.start + bodyText.slice(0, match.index).split("\n").length - 1;
          const callCol = match.index - bodyText.slice(0, match.index).lastIndexOf("\n") - 1;

          const callRange: Range = {
            start: { line: callLine, character: Math.max(0, callCol) },
            end: { line: callLine, character: Math.max(0, callCol) + calleeName.length },
          };

          // Record outgoing call
          const outgoing = this.outgoingCalls.get(callerKey) ?? [];
          outgoing.push({ calleeName, callRange, callerUri: uri, callerName });
          this.outgoingCalls.set(callerKey, outgoing);

          // Record incoming call (indexed by callee name for cross-file matching)
          const incoming = this.incomingCalls.get(calleeName) ?? [];
          incoming.push({ calleeName, callRange, callerUri: uri, callerName });
          this.incomingCalls.set(calleeName, incoming);
        }
      }
    }
  }

  private getFunctionBodyRange(
    text: string,
    funcStartLine: number,
  ): { start: number; end: number } | null {
    const lines = text.split("\n");
    let braceDepth = 0;
    let foundOpen = false;
    let startLine = funcStartLine;

    for (let i = funcStartLine; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === "{") {
          if (!foundOpen) {
            foundOpen = true;
            startLine = i;
          }
          braceDepth++;
        } else if (ch === "}") {
          braceDepth--;
          if (foundOpen && braceDepth === 0) {
            return { start: startLine, end: i };
          }
        }
      }
      // If we hit a semicolon before opening brace, it's an interface function
      if (!foundOpen && lines[i].includes(";")) return null;
    }

    return null;
  }

  private makeKey(uri: string, name: string): string {
    return `${uri}#${name}`;
  }

  private isCallKeyword(name: string): boolean {
    const keywords = new Set([
      "if",
      "else",
      "for",
      "while",
      "do",
      "return",
      "require",
      "assert",
      "revert",
      "emit",
      "new",
      "delete",
      "type",
      "try",
      "catch",
      "mapping",
      "assembly",
      "unchecked",
      "super",
      "this",
    ]);
    return keywords.has(name);
  }

  private isSolidityType(name: string): boolean {
    return /^(uint|int|bytes|bool|address|string)\d*$/.test(name) || name === "byte";
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
}

interface CallSite {
  calleeName: string;
  callRange: Range;
  callerUri: string;
  callerName: string;
}
