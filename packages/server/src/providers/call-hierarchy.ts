import type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  Position,
  Range,
} from "vscode-languageserver/node.js";
import { SymbolKind } from "vscode-languageserver/node.js";
import type { TextDocument } from "vscode-languageserver-textdocument";
import * as fs from "node:fs";
import type { ContractDefinition, FunctionDefinition } from "@solidity-workbench/common";
import type { SymbolIndex } from "../analyzer/symbol-index.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";
import type { SolidityParser } from "../parser/solidity-parser.js";
import { getWordAtPosition, CALL_LIKE_KEYWORDS, isSolidityBuiltinType } from "../utils/text.js";

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
 *
 * Without a full solc AST we can't do exact type inference, so when two
 * contracts define identically-named functions (e.g. ERC20 `transfer` on many
 * tokens) naïvely keying incoming calls by just the callee name produces
 * cross-contract contamination. We disambiguate by remembering the *receiver*
 * of each call (the identifier before the dot) and resolving it through the
 * enclosing function's parameters and the enclosing contract's state variables
 * back to a contract/interface-like type name. Filtering then happens at
 * lookup time against the target contract's name and its inheritance chain.
 */
export class CallHierarchyProvider {
  /**
   * calleeName → [site, ...].
   *
   * Kept keyed by bare callee name so cross-file matches still work; the
   * per-site `qualifier` field is what disambiguates which concrete
   * contract the call is dispatched on.
   */
  private incomingCalls: Map<string, CallSite[]> = new Map();
  /** callerFunction key (`<uri>#<name>`) → [site, ...] */
  private outgoingCalls: Map<string, CallSite[]> = new Map();

  private indexedFiles: Set<string> = new Set();

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
    const word = getWordAtPosition(text, position)?.text ?? null;
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
   *
   * Sites stored under the bare callee name are filtered by their recorded
   * qualifier against the target contract (item.detail) plus every contract
   * or interface in its inheritance chain. Unqualified sites are always
   * included because without type info we cannot prove they *don't* dispatch
   * to this target, and unqualified internal calls are the common case.
   */
  async getIncomingCalls(item: CallHierarchyItem): Promise<CallHierarchyIncomingCall[]> {
    await this.ensureIndexed();

    const sites = this.incomingCalls.get(item.name) ?? [];
    const allowedQualifiers = this.computeAllowedQualifiers(item.detail);

    const callerMap = new Map<string, { item: CallHierarchyItem; ranges: Range[] }>();

    for (const site of sites) {
      if (site.qualifier && item.detail && !allowedQualifiers.has(site.qualifier)) {
        continue;
      }

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
  invalidateFile(uri: string): void {
    // Remove all call sites from/to this file
    for (const [key, sites] of this.incomingCalls) {
      const filtered = sites.filter((s) => s.callerUri !== uri);
      if (filtered.length > 0) this.incomingCalls.set(key, filtered);
      else this.incomingCalls.delete(key);
    }
    for (const [key] of this.outgoingCalls) {
      if (key.startsWith(uri + "#")) this.outgoingCalls.delete(key);
    }
    this.indexedFiles.delete(uri);
  }

  private async ensureIndexed(): Promise<void> {
    const allUris = this.workspace.getAllFileUris();
    for (const uri of allUris) {
      if (this.indexedFiles.has(uri)) continue;
      try {
        const filePath = this.workspace.uriToPath(uri);
        const text = fs.readFileSync(filePath, "utf-8");
        this.indexCallsInFile(uri, text);
        this.indexedFiles.add(uri);
      } catch {
        // skip unreadable files
      }
    }
  }

  /**
   * Compute the set of qualifier names that should be considered as matching
   * a target contract. This is the contract itself plus every base contract
   * and interface in its inheritance chain, so that e.g. a call recorded with
   * qualifier `IERC20` is still attributed to `MyToken.transfer` when
   * `MyToken is IERC20`.
   */
  private computeAllowedQualifiers(containerName: string | undefined): Set<string> {
    const allowed = new Set<string>();
    if (!containerName) return allowed;
    allowed.add(containerName);
    const chain = this.symbolIndex.getInheritanceChain(containerName);
    for (const base of chain) {
      if (base.name) allowed.add(base.name);
    }
    return allowed;
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

        const bodyRange = this.getFunctionBodyRange(text, func.range.start.line);
        if (!bodyRange) continue;

        // Start *after* the opening brace so the function's own signature
        // (which naturally contains `name(`) isn't mistaken for a recursive
        // self-call when the body lives on the same physical line as the
        // declaration.
        const firstLine = lines[bodyRange.bodyStartLine].slice(bodyRange.bodyStartChar);
        const restLines = lines.slice(bodyRange.bodyStartLine + 1, bodyRange.bodyEndLine + 1);
        const bodyText = restLines.length > 0 ? [firstLine, ...restLines].join("\n") : firstLine;

        // Capture group 1 = optional receiver identifier, group 2 = callee
        // name. Chained expressions (`a.b.c()`) are only partially handled —
        // the captured qualifier is the identifier immediately before the
        // dot, which is fine for the 95% case but would need solc's AST for
        // full accuracy.
        const callRe = /(?:\b([a-zA-Z_$][\w$]*)\s*\.\s*)?\b([a-zA-Z_$][\w$]*)\s*\(/g;
        let match: RegExpExecArray | null;

        while ((match = callRe.exec(bodyText)) !== null) {
          const rawQualifier = match[1];
          const calleeName = match[2];

          if (CALL_LIKE_KEYWORDS.has(calleeName)) continue;
          if (isSolidityBuiltinType(calleeName)) continue;

          const qualifier = this.resolveQualifier(rawQualifier, func, contract);

          const absoluteMatchStart = match.index + match[0].lastIndexOf(calleeName);
          const precedingInBody = bodyText.slice(0, absoluteMatchStart);
          const newlinesBefore = (precedingInBody.match(/\n/g) ?? []).length;
          const callLine = bodyRange.bodyStartLine + newlinesBefore;
          const callCol =
            newlinesBefore === 0
              ? bodyRange.bodyStartChar + absoluteMatchStart
              : absoluteMatchStart - precedingInBody.lastIndexOf("\n") - 1;

          const callRange: Range = {
            start: { line: callLine, character: Math.max(0, callCol) },
            end: { line: callLine, character: Math.max(0, callCol) + calleeName.length },
          };

          const outgoing = this.outgoingCalls.get(callerKey) ?? [];
          outgoing.push({ calleeName, qualifier, callRange, callerUri: uri, callerName });
          this.outgoingCalls.set(callerKey, outgoing);

          const incoming = this.incomingCalls.get(calleeName) ?? [];
          incoming.push({ calleeName, qualifier, callRange, callerUri: uri, callerName });
          this.incomingCalls.set(calleeName, incoming);
        }
      }
    }
  }

  /**
   * Best-effort mapping of a raw qualifier identifier (e.g. `a` in
   * `a.transfer()`) to a contract/interface-like type name.
   *
   * - `this` collapses to the enclosing contract (so `this.foo()` is still
   *   attributed to this contract and not to any same-named `foo` elsewhere).
   * - `super` collapses to the first declared base contract, which is where
   *   the dispatch starts for `super.foo()`.
   * - Parameter and state-variable references are resolved to their declared
   *   type names.
   * - Anything else (e.g. `MyLib` in `MyLib.foo()`) is returned verbatim and
   *   will match as long as it's a real contract/library name.
   */
  private resolveQualifier(
    rawQualifier: string | undefined,
    func: FunctionDefinition,
    contract: ContractDefinition,
  ): string | undefined {
    if (!rawQualifier) return undefined;

    if (rawQualifier === "this") {
      return contract.name.length > 0 ? contract.name : undefined;
    }
    if (rawQualifier === "super") {
      const firstBase = contract.baseContracts[0]?.baseName;
      return firstBase && firstBase.length > 0 ? firstBase : undefined;
    }

    for (const p of func.parameters) {
      if (p.name && p.name === rawQualifier) {
        return this.stripTypeDecorations(p.typeName) ?? rawQualifier;
      }
    }
    for (const v of contract.stateVariables) {
      if (v.name === rawQualifier) {
        return this.stripTypeDecorations(v.typeName) ?? rawQualifier;
      }
    }

    return rawQualifier;
  }

  /**
   * Reduce a declared type name to its underlying contract-like identifier by
   * stripping array suffixes and trailing location / mutability keywords.
   * E.g. `A[] memory` → `A`, `IPool[3] calldata` → `IPool`.
   */
  private stripTypeDecorations(typeName: string | undefined): string | undefined {
    if (!typeName) return undefined;
    let t = typeName.trim();
    while (/\[[^\]]*\]\s*$/.test(t)) {
      t = t.replace(/\s*\[[^\]]*\]\s*$/, "").trim();
    }
    t = t.replace(/\s+(memory|storage|calldata|payable)$/, "").trim();
    return t.length > 0 ? t : undefined;
  }

  private getFunctionBodyRange(
    text: string,
    funcStartLine: number,
  ): { bodyStartLine: number; bodyStartChar: number; bodyEndLine: number } | null {
    const lines = text.split("\n");
    let braceDepth = 0;
    let foundOpen = false;
    let bodyStartLine = funcStartLine;
    let bodyStartChar = 0;

    for (let i = funcStartLine; i < lines.length; i++) {
      const line = lines[i];
      for (let j = 0; j < line.length; j++) {
        const ch = line[j];
        if (ch === "{") {
          if (!foundOpen) {
            foundOpen = true;
            bodyStartLine = i;
            bodyStartChar = j + 1;
          }
          braceDepth++;
        } else if (ch === "}") {
          braceDepth--;
          if (foundOpen && braceDepth === 0) {
            return { bodyStartLine, bodyStartChar, bodyEndLine: i };
          }
        }
      }
      // If we hit a semicolon before opening brace, it's an interface function
      if (!foundOpen && line.includes(";")) return null;
    }

    return null;
  }

  private makeKey(uri: string, name: string): string {
    return `${uri}#${name}`;
  }
}

interface CallSite {
  calleeName: string;
  /**
   * Resolved contract/interface-like type of the call receiver, or undefined
   * for unqualified calls. Variable-name qualifiers are mapped through the
   * enclosing function's parameters and the enclosing contract's state
   * variables; `this` maps to the enclosing contract, `super` to the first
   * declared base contract.
   */
  qualifier?: string;
  callRange: Range;
  callerUri: string;
  callerName: string;
}
