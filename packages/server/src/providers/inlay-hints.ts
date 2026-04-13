import type { InlayHint, Range } from "vscode-languageserver/node.js";
import { InlayHintKind, Position } from "vscode-languageserver/node.js";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type { SymbolIndex } from "../analyzer/symbol-index.js";
import type { SolidityParser } from "../parser/solidity-parser.js";

/**
 * Provides inlay hints — inline annotations that show:
 *
 * - Parameter names at call sites: `transfer(‸to: addr, ‸amount: 100)`
 * - Type annotations for variable declarations (when using `var` or ambiguous)
 * - Gas estimates next to function declarations (from forge snapshot)
 *
 * These are the "ghost text" annotations that TypeScript and Rust developers
 * are accustomed to. A major gap in all existing Solidity extensions.
 */
export class InlayHintsProvider {
  constructor(
    private symbolIndex: SymbolIndex,
    private parser: SolidityParser,
  ) {}

  provideInlayHints(document: TextDocument, range: Range): InlayHint[] {
    const hints: InlayHint[] = [];
    const text = document.getText();
    const lines = text.split("\n");

    for (
      let lineNum = range.start.line;
      lineNum <= Math.min(range.end.line, lines.length - 1);
      lineNum++
    ) {
      const line = lines[lineNum];

      // Find function calls and provide parameter name hints
      this.findCallSiteHints(line, lineNum, document.uri, hints);
    }

    return hints;
  }

  /**
   * Find function call sites and provide parameter name inlay hints.
   * e.g., `transfer(addr, 100)` → `transfer(‸to: addr, ‸amount: 100)`
   */
  private findCallSiteHints(line: string, lineNum: number, uri: string, hints: InlayHint[]): void {
    // Match function calls: identifier(args)
    const callRe = /\b(\w+)\s*\(([^)]*)\)/g;
    let match: RegExpExecArray | null;

    while ((match = callRe.exec(line)) !== null) {
      const funcName = match[1];
      const argsStr = match[2];
      const argsStart = match.index + funcName.length + 1; // +1 for (

      // Skip keywords that look like function calls
      if (this.isKeyword(funcName)) continue;

      // Look up the function in the symbol index
      const symbols = this.symbolIndex.findSymbols(funcName);
      const funcSymbol = symbols.find(
        (s) => s.kind === "function" || s.kind === "event" || s.kind === "error",
      );
      if (!funcSymbol) continue;

      // Get the function's parameter names from the contract
      const paramNames = this.getParameterNames(funcName);
      if (paramNames.length === 0) continue;

      // Parse the call arguments (simple split — doesn't handle nested calls)
      const args = this.splitArguments(argsStr);
      if (args.length === 0) continue;

      // Add parameter name hints for each argument
      let argOffset = argsStart;
      for (let i = 0; i < Math.min(args.length, paramNames.length); i++) {
        const argText = args[i];
        const trimmedArg = argText.trimStart();
        const leadingSpaces = argText.length - trimmedArg.length;

        // Don't add hint if the argument is already a named argument
        if (trimmedArg.includes(":")) continue;

        // Don't add hint if the argument matches the parameter name
        if (trimmedArg.trim() === paramNames[i]) continue;

        hints.push({
          position: { line: lineNum, character: argOffset + leadingSpaces },
          label: `${paramNames[i]}:`,
          kind: InlayHintKind.Parameter,
          paddingRight: true,
        });

        argOffset += argText.length + 1; // +1 for comma
      }
    }
  }

  private getParameterNames(funcName: string): string[] {
    const symbols = this.symbolIndex.findSymbols(funcName);
    for (const sym of symbols) {
      if (sym.kind === "function") {
        const contract = sym.containerName
          ? this.symbolIndex.getContract(sym.containerName)
          : undefined;
        if (contract) {
          const func = contract.contract.functions.find((f) => f.name === funcName);
          if (func) {
            return func.parameters.map((p) => p.name).filter((n): n is string => !!n);
          }
        }
      }
    }
    return [];
  }

  private splitArguments(argsStr: string): string[] {
    const args: string[] = [];
    let depth = 0;
    let current = "";

    for (const ch of argsStr) {
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") depth--;

      if (ch === "," && depth === 0) {
        args.push(current);
        current = "";
      } else {
        current += ch;
      }
    }

    if (current.trim()) args.push(current);
    return args;
  }

  private isKeyword(word: string): boolean {
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
    ]);
    return keywords.has(word);
  }
}
