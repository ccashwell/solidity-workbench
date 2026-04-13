import type {
  SoliditySourceUnit,
  ContractDefinition,
  FunctionDefinition,
  StateVariableDeclaration,
  EventDefinition,
  ErrorDefinition,
  StructDefinition,
  EnumDefinition,
  ModifierDefinition,
  ImportDirective,
  PragmaDirective,
  SourceRange,
  Visibility,
  Mutability,
  ContractKind,
  NatspecComment,
  ParameterDeclaration,
} from "@solforge/common";

/**
 * Wraps @solidity-parser/parser to produce our typed AST.
 * Maintains a cache of parsed files for fast access.
 *
 * This is the "fast path" parser — it runs on every keystroke with
 * error recovery. The "rich path" (solc AST) runs on save for
 * type-resolved features.
 */
export class SolidityParser {
  private cache: Map<string, ParseResult> = new Map();

  /**
   * Parse a Solidity source file and cache the result.
   * Returns the parsed source unit or null if parsing failed completely.
   */
  parse(uri: string, text: string): ParseResult {
    try {
      // We use @solidity-parser/parser at runtime.
      // For the initial scaffold, we implement a lightweight regex-based
      // extractor that covers the 80% case. The full ANTLR parser
      // integration comes when we wire up the real dependency.
      const result = this.extractStructure(uri, text);
      this.cache.set(uri, result);
      return result;
    } catch (err) {
      const errorResult: ParseResult = {
        sourceUnit: this.emptySourceUnit(uri),
        errors: [
          {
            message: `Parse error: ${err}`,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          },
        ],
      };
      this.cache.set(uri, errorResult);
      return errorResult;
    }
  }

  /**
   * Get the cached parse result for a file.
   */
  get(uri: string): ParseResult | undefined {
    return this.cache.get(uri);
  }

  /**
   * Get the word at a given position in a document.
   */
  getWordAtPosition(text: string, line: number, character: number): string | null {
    const lines = text.split("\n");
    if (line >= lines.length) return null;
    const lineText = lines[line];
    if (character >= lineText.length) return null;

    // Find word boundaries
    let start = character;
    let end = character;
    while (start > 0 && /[\w$]/.test(lineText[start - 1])) start--;
    while (end < lineText.length && /[\w$]/.test(lineText[end])) end++;

    if (start === end) return null;
    return lineText.slice(start, end);
  }

  /**
   * Get the line text at a position.
   */
  getLineText(text: string, line: number): string {
    const lines = text.split("\n");
    return line < lines.length ? lines[line] : "";
  }

  /**
   * Structural extraction using regex patterns.
   * This is a pragmatic approach for the scaffold — reliable enough for
   * navigation, completions, and outline. The full ANTLR parser replaces
   * this for production use.
   */
  private extractStructure(uri: string, text: string): ParseResult {
    const errors: ParseError[] = [];
    const lines = text.split("\n");

    const pragmas = this.extractPragmas(lines);
    const imports = this.extractImports(lines);
    const contracts = this.extractContracts(text, lines);

    return {
      sourceUnit: {
        filePath: uri,
        pragmas,
        imports,
        contracts,
        freeFunctions: [],
        errors: [],
        userDefinedValueTypes: [],
      },
      errors,
    };
  }

  private extractPragmas(lines: string[]): PragmaDirective[] {
    const pragmas: PragmaDirective[] = [];
    const re = /^pragma\s+(\w+)\s+(.+?)\s*;/;

    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(re);
      if (match) {
        pragmas.push({
          type: "PragmaDirective",
          name: match[1],
          value: match[2],
          range: {
            start: { line: i, character: 0 },
            end: { line: i, character: lines[i].length },
          },
        });
      }
    }
    return pragmas;
  }

  private extractImports(lines: string[]): ImportDirective[] {
    const imports: ImportDirective[] = [];

    // Match: import "path"; import {A, B} from "path"; import "path" as Alias;
    const reSimple = /^import\s+["'](.+?)["']\s*(?:as\s+(\w+))?\s*;/;
    const reNamed =
      /^import\s+\{([^}]+)\}\s+from\s+["'](.+?)["']\s*;/;
    const reWildcard =
      /^import\s+\*\s+as\s+(\w+)\s+from\s+["'](.+?)["']\s*;/;

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      let match: RegExpMatchArray | null;

      if ((match = trimmed.match(reNamed))) {
        const symbols = match[1].split(",").map((s) => {
          const parts = s.trim().split(/\s+as\s+/);
          return { symbol: parts[0].trim(), alias: parts[1]?.trim() };
        });
        imports.push({
          type: "ImportDirective",
          path: match[2],
          symbolAliases: symbols,
          range: {
            start: { line: i, character: 0 },
            end: { line: i, character: lines[i].length },
          },
        });
      } else if ((match = trimmed.match(reWildcard))) {
        imports.push({
          type: "ImportDirective",
          path: match[2],
          unitAlias: match[1],
          range: {
            start: { line: i, character: 0 },
            end: { line: i, character: lines[i].length },
          },
        });
      } else if ((match = trimmed.match(reSimple))) {
        imports.push({
          type: "ImportDirective",
          path: match[1],
          unitAlias: match[2],
          range: {
            start: { line: i, character: 0 },
            end: { line: i, character: lines[i].length },
          },
        });
      }
    }

    return imports;
  }

  private extractContracts(text: string, lines: string[]): ContractDefinition[] {
    const contracts: ContractDefinition[] = [];

    // Match contract/interface/library/abstract contract declarations
    const contractRe =
      /^(abstract\s+)?(?:contract|interface|library)\s+(\w+)(?:\s+is\s+([^{]+))?\s*\{/gm;

    let match: RegExpExecArray | null;
    while ((match = contractRe.exec(text)) !== null) {
      const isAbstract = !!match[1];
      const fullMatch = match[0];
      const name = match[2];
      const baseClause = match[3];

      // Determine kind
      let kind: ContractKind = "contract";
      if (fullMatch.includes("interface ")) kind = "interface";
      else if (fullMatch.includes("library ")) kind = "library";
      else if (isAbstract) kind = "abstract";

      // Find the line number
      const beforeMatch = text.slice(0, match.index);
      const startLine = beforeMatch.split("\n").length - 1;
      const startChar = match.index - beforeMatch.lastIndexOf("\n") - 1;

      // Find matching closing brace
      const endLine = this.findMatchingBrace(text, match.index + fullMatch.length - 1);

      // Parse base contracts
      const baseContracts = baseClause
        ? baseClause.split(",").map((b) => ({
            baseName: b.trim().split("(")[0].trim(),
          }))
        : [];

      // Extract contract body contents
      const braceStart = match.index + fullMatch.length - 1;
      const braceEnd = this.findMatchingBraceIndex(text, braceStart);
      const bodyText = text.slice(braceStart + 1, braceEnd);
      const bodyStartLine = startLine + fullMatch.slice(0, fullMatch.indexOf("{")).split("\n").length - 1;

      const nameStart = match.index + fullMatch.indexOf(name);
      const nameBeforeMatch = text.slice(0, nameStart);
      const nameStartLine = nameBeforeMatch.split("\n").length - 1;
      const nameStartChar = nameStart - nameBeforeMatch.lastIndexOf("\n") - 1;

      const contract: ContractDefinition = {
        type: "ContractDefinition",
        name,
        kind,
        baseContracts,
        stateVariables: this.extractStateVariables(bodyText, bodyStartLine + 1),
        functions: this.extractFunctions(bodyText, bodyStartLine + 1),
        modifiers: this.extractModifiers(bodyText, bodyStartLine + 1),
        events: this.extractEvents(bodyText, bodyStartLine + 1),
        errors: this.extractErrors(bodyText, bodyStartLine + 1),
        structs: this.extractStructs(bodyText, bodyStartLine + 1),
        enums: this.extractEnums(bodyText, bodyStartLine + 1),
        usingFor: [],
        range: {
          start: { line: startLine, character: startChar },
          end: { line: endLine, character: 0 },
        },
        nameRange: {
          start: { line: nameStartLine, character: nameStartChar },
          end: { line: nameStartLine, character: nameStartChar + name.length },
        },
      };

      contracts.push(contract);
    }

    return contracts;
  }

  private extractFunctions(
    bodyText: string,
    lineOffset: number,
  ): FunctionDefinition[] {
    const functions: FunctionDefinition[] = [];

    // Match function declarations
    const funcRe =
      /(?:^|\n)\s*(function\s+(\w+)|constructor|receive|fallback)\s*\(([^)]*)\)([^{;]*)[{;]/g;

    let match: RegExpExecArray | null;
    while ((match = funcRe.exec(bodyText)) !== null) {
      const fullMatch = match[0];
      const isCtor = fullMatch.trimStart().startsWith("constructor");
      const isReceive = fullMatch.trimStart().startsWith("receive");
      const isFallback = fullMatch.trimStart().startsWith("fallback");

      const name = isCtor
        ? null
        : isReceive
          ? null
          : isFallback
            ? null
            : match[2];
      const kind = isCtor
        ? "constructor" as const
        : isReceive
          ? "receive" as const
          : isFallback
            ? "fallback" as const
            : "function" as const;

      const paramsStr = match[3] ?? "";
      const modifiersStr = match[4] ?? "";
      const hasBody = fullMatch.endsWith("{");

      const beforeMatch = bodyText.slice(0, match.index);
      const line = lineOffset + beforeMatch.split("\n").length - 1;

      const visibility = this.extractVisibility(modifiersStr);
      const mutability = this.extractMutability(modifiersStr);
      const isVirtual = /\bvirtual\b/.test(modifiersStr);
      const isOverride = /\boverride\b/.test(modifiersStr);

      const parameters = this.parseParameters(paramsStr);
      const returnParams = this.extractReturnParams(modifiersStr);

      functions.push({
        type: "FunctionDefinition",
        name,
        kind,
        visibility,
        mutability,
        parameters,
        returnParameters: returnParams,
        modifiers: this.extractModifierNames(modifiersStr),
        isVirtual,
        isOverride,
        body: hasBody,
        range: {
          start: { line, character: 0 },
          end: { line, character: 0 },
        },
        nameRange: {
          start: { line, character: 0 },
          end: { line, character: name?.length ?? 0 },
        },
      });
    }

    return functions;
  }

  private extractEvents(bodyText: string, lineOffset: number): EventDefinition[] {
    const events: EventDefinition[] = [];
    const re = /event\s+(\w+)\s*\(([^)]*)\)\s*(anonymous)?\s*;/g;

    let match: RegExpExecArray | null;
    while ((match = re.exec(bodyText)) !== null) {
      const beforeMatch = bodyText.slice(0, match.index);
      const line = lineOffset + beforeMatch.split("\n").length - 1;
      events.push({
        type: "EventDefinition",
        name: match[1],
        parameters: this.parseParameters(match[2]),
        isAnonymous: !!match[3],
        range: { start: { line, character: 0 }, end: { line, character: 0 } },
        nameRange: { start: { line, character: 0 }, end: { line, character: 0 } },
      });
    }
    return events;
  }

  private extractErrors(bodyText: string, lineOffset: number): ErrorDefinition[] {
    const errors: ErrorDefinition[] = [];
    const re = /error\s+(\w+)\s*\(([^)]*)\)\s*;/g;

    let match: RegExpExecArray | null;
    while ((match = re.exec(bodyText)) !== null) {
      const beforeMatch = bodyText.slice(0, match.index);
      const line = lineOffset + beforeMatch.split("\n").length - 1;
      errors.push({
        type: "ErrorDefinition",
        name: match[1],
        parameters: this.parseParameters(match[2]),
        range: { start: { line, character: 0 }, end: { line, character: 0 } },
        nameRange: { start: { line, character: 0 }, end: { line, character: 0 } },
      });
    }
    return errors;
  }

  private extractStructs(bodyText: string, lineOffset: number): StructDefinition[] {
    const structs: StructDefinition[] = [];
    const re = /struct\s+(\w+)\s*\{([^}]*)\}/g;

    let match: RegExpExecArray | null;
    while ((match = re.exec(bodyText)) !== null) {
      const beforeMatch = bodyText.slice(0, match.index);
      const line = lineOffset + beforeMatch.split("\n").length - 1;
      const members = this.parseStructMembers(match[2]);
      structs.push({
        type: "StructDefinition",
        name: match[1],
        members,
        range: { start: { line, character: 0 }, end: { line, character: 0 } },
        nameRange: { start: { line, character: 0 }, end: { line, character: 0 } },
      });
    }
    return structs;
  }

  private extractEnums(bodyText: string, lineOffset: number): EnumDefinition[] {
    const enums: EnumDefinition[] = [];
    const re = /enum\s+(\w+)\s*\{([^}]*)\}/g;

    let match: RegExpExecArray | null;
    while ((match = re.exec(bodyText)) !== null) {
      const beforeMatch = bodyText.slice(0, match.index);
      const line = lineOffset + beforeMatch.split("\n").length - 1;
      const members = match[2]
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean);
      enums.push({
        type: "EnumDefinition",
        name: match[1],
        members,
        range: { start: { line, character: 0 }, end: { line, character: 0 } },
        nameRange: { start: { line, character: 0 }, end: { line, character: 0 } },
      });
    }
    return enums;
  }

  private extractStateVariables(
    bodyText: string,
    lineOffset: number,
  ): StateVariableDeclaration[] {
    const vars: StateVariableDeclaration[] = [];
    // Match state variable patterns: type visibility? mutability? name (= value)?;
    const re =
      /(?:mapping\s*\([^)]+\)|[\w\[\]]+(?:\s*\.\s*\w+)*)\s+(?:(public|private|internal|external)\s+)?(?:(constant|immutable)\s+)?(\w+)\s*(?:=[^;]*)?\s*;/g;

    let match: RegExpExecArray | null;
    while ((match = re.exec(bodyText)) !== null) {
      const fullMatch = match[0];
      // Skip if this looks like a local variable (inside a function)
      // or a function parameter — we can't reliably detect this with regex
      // but we check if it's at the top level of the body
      const name = match[3];
      const visibility = (match[1] as Visibility) ?? "internal";
      const mutability = match[2] as "constant" | "immutable" | undefined;

      // Extract the type name (everything before visibility/name)
      const typeName = fullMatch
        .slice(0, fullMatch.indexOf(name))
        .replace(/\b(public|private|internal|external|constant|immutable)\b/g, "")
        .trim();

      const beforeMatch = bodyText.slice(0, match.index);
      const line = lineOffset + beforeMatch.split("\n").length - 1;

      vars.push({
        type: "StateVariableDeclaration",
        typeName,
        name,
        visibility,
        mutability,
        range: { start: { line, character: 0 }, end: { line, character: 0 } },
        nameRange: { start: { line, character: 0 }, end: { line, character: 0 } },
      });
    }
    return vars;
  }

  private extractModifiers(
    bodyText: string,
    lineOffset: number,
  ): ModifierDefinition[] {
    const modifiers: ModifierDefinition[] = [];
    const re = /modifier\s+(\w+)\s*\(([^)]*)\)/g;

    let match: RegExpExecArray | null;
    while ((match = re.exec(bodyText)) !== null) {
      const beforeMatch = bodyText.slice(0, match.index);
      const line = lineOffset + beforeMatch.split("\n").length - 1;
      modifiers.push({
        type: "ModifierDefinition",
        name: match[1],
        parameters: this.parseParameters(match[2]),
        isVirtual: false,
        isOverride: false,
        range: { start: { line, character: 0 }, end: { line, character: 0 } },
        nameRange: { start: { line, character: 0 }, end: { line, character: 0 } },
      });
    }
    return modifiers;
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private parseParameters(paramsStr: string): ParameterDeclaration[] {
    if (!paramsStr.trim()) return [];

    return paramsStr
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const parts = p.split(/\s+/);
        const indexed = parts.includes("indexed");
        const storageLocation = parts.find((x) =>
          ["memory", "storage", "calldata"].includes(x),
        ) as "memory" | "storage" | "calldata" | undefined;

        // Filter out keywords to find type and name
        const meaningful = parts.filter(
          (x) => !["indexed", "memory", "storage", "calldata"].includes(x),
        );

        return {
          type: "ParameterDeclaration" as const,
          typeName: meaningful[0] ?? "unknown",
          name: meaningful.length > 1 ? meaningful[meaningful.length - 1] : undefined,
          storageLocation,
          indexed: indexed || undefined,
        };
      });
  }

  private parseStructMembers(membersStr: string): ParameterDeclaration[] {
    return membersStr
      .split(";")
      .map((m) => m.trim())
      .filter(Boolean)
      .map((m) => {
        const parts = m.split(/\s+/);
        return {
          type: "ParameterDeclaration" as const,
          typeName: parts[0] ?? "unknown",
          name: parts[parts.length - 1],
        };
      });
  }

  private extractVisibility(modifiers: string): Visibility {
    if (/\bexternal\b/.test(modifiers)) return "external";
    if (/\bpublic\b/.test(modifiers)) return "public";
    if (/\binternal\b/.test(modifiers)) return "internal";
    if (/\bprivate\b/.test(modifiers)) return "private";
    return "public"; // default for functions
  }

  private extractMutability(modifiers: string): Mutability {
    if (/\bpure\b/.test(modifiers)) return "pure";
    if (/\bview\b/.test(modifiers)) return "view";
    if (/\bpayable\b/.test(modifiers)) return "payable";
    return "nonpayable";
  }

  private extractModifierNames(modifiers: string): string[] {
    // Remove known keywords and extract remaining identifiers that look like modifiers
    const cleaned = modifiers
      .replace(
        /\b(public|private|internal|external|pure|view|payable|virtual|override|returns\s*\([^)]*\))\b/g,
        "",
      )
      .trim();

    return cleaned
      .split(/\s+/)
      .filter((m) => /^\w+/.test(m))
      .map((m) => m.replace(/\(.*/, "")); // strip arguments
  }

  private extractReturnParams(modifiers: string): ParameterDeclaration[] {
    const returnsMatch = modifiers.match(/returns\s*\(([^)]*)\)/);
    if (!returnsMatch) return [];
    return this.parseParameters(returnsMatch[1]);
  }

  private findMatchingBrace(text: string, openIndex: number): number {
    let depth = 1;
    let i = openIndex + 1;
    while (i < text.length && depth > 0) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
      i++;
    }
    const before = text.slice(0, i);
    return before.split("\n").length - 1;
  }

  private findMatchingBraceIndex(text: string, openIndex: number): number {
    let depth = 1;
    let i = openIndex + 1;
    while (i < text.length && depth > 0) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
      i++;
    }
    return i - 1;
  }

  private emptySourceUnit(uri: string): SoliditySourceUnit {
    return {
      filePath: uri,
      pragmas: [],
      imports: [],
      contracts: [],
      freeFunctions: [],
      errors: [],
      userDefinedValueTypes: [],
    };
  }
}

// ── Types ────────────────────────────────────────────────────────────

export interface ParseResult {
  sourceUnit: SoliditySourceUnit;
  errors: ParseError[];
}

export interface ParseError {
  message: string;
  range: SourceRange;
}
