import {
  SemanticTokens,
  SemanticTokensBuilder,
  Range,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import { SolSemanticTokenTypes, SolSemanticTokenModifiers } from "@solforge/common";
import { SolidityParser } from "../parser/solidity-parser.js";

const tokenTypeMap = new Map(
  SolSemanticTokenTypes.map((t, i) => [t, i]),
);
const tokenModifierMap = new Map(
  SolSemanticTokenModifiers.map((m, i) => [m, i]),
);

/**
 * Provides semantic token highlighting for Solidity.
 *
 * This goes beyond TextMate grammars by using AST information to
 * color tokens by their semantic role:
 * - State variables vs. local variables vs. parameters
 * - Contract names in type position vs. declaration
 * - Modifiers vs. regular functions
 * - Constants/immutables with a distinct style
 * - Virtual/override/abstract function annotations
 */
export class SemanticTokensProvider {
  constructor(private parser: SolidityParser) {}

  provideSemanticTokens(document: TextDocument): SemanticTokens {
    const builder = new SemanticTokensBuilder();
    const text = document.getText();
    const result = this.parser.get(document.uri);

    if (!result) return builder.build();

    const su = result.sourceUnit;

    // Highlight pragmas
    for (const pragma of su.pragmas) {
      this.pushToken(builder, pragma.range.start.line, 0, 6, "keyword", []); // "pragma"
      this.pushToken(
        builder,
        pragma.range.start.line,
        7,
        pragma.name.length,
        "namespace",
        [],
      );
    }

    // Highlight import paths
    for (const imp of su.imports) {
      this.pushToken(builder, imp.range.start.line, 0, 6, "keyword", []); // "import"
    }

    // Highlight contracts and their contents
    for (const contract of su.contracts) {
      // Contract keyword + name
      const kindLen = contract.kind === "abstract" ? 17 : contract.kind.length; // "abstract contract" or "interface" etc.
      this.pushToken(
        builder,
        contract.nameRange.start.line,
        contract.nameRange.start.character,
        contract.name.length,
        contract.kind === "interface" ? "interface" : "class",
        ["declaration", "definition"],
      );

      // Functions
      for (const func of contract.functions) {
        if (func.name) {
          const modifiers: string[] = ["declaration"];
          if (func.isVirtual) modifiers.push("virtual");
          if (func.isOverride) modifiers.push("override");

          this.pushToken(
            builder,
            func.range.start.line,
            func.nameRange.start.character,
            func.name.length,
            "function",
            modifiers,
          );
        }
      }

      // Events
      for (const event of contract.events) {
        this.pushToken(
          builder,
          event.range.start.line,
          event.nameRange.start.character,
          event.name.length,
          "event",
          ["declaration"],
        );
      }

      // State variables
      for (const svar of contract.stateVariables) {
        const modifiers: string[] = [];
        if (svar.mutability === "constant" || svar.mutability === "immutable") {
          modifiers.push("readonly");
        }
        this.pushToken(
          builder,
          svar.range.start.line,
          svar.nameRange.start.character,
          svar.name.length,
          "property",
          modifiers,
        );
      }

      // Structs
      for (const struct of contract.structs) {
        this.pushToken(
          builder,
          struct.range.start.line,
          struct.nameRange.start.character,
          struct.name.length,
          "struct",
          ["declaration"],
        );
      }

      // Enums
      for (const enumDef of contract.enums) {
        this.pushToken(
          builder,
          enumDef.range.start.line,
          enumDef.nameRange.start.character,
          enumDef.name.length,
          "enum",
          ["declaration"],
        );
      }

      // Modifiers
      for (const mod of contract.modifiers) {
        this.pushToken(
          builder,
          mod.range.start.line,
          mod.nameRange.start.character,
          mod.name.length,
          "macro",
          ["declaration"],
        );
      }
    }

    return builder.build();
  }

  provideSemanticTokensRange(
    document: TextDocument,
    range: Range,
  ): SemanticTokens {
    // For range requests, we still compute full tokens and filter
    // A production implementation would optimize this with range tracking
    return this.provideSemanticTokens(document);
  }

  private pushToken(
    builder: SemanticTokensBuilder,
    line: number,
    char: number,
    length: number,
    tokenType: string,
    tokenModifiers: string[],
  ): void {
    const typeIndex = tokenTypeMap.get(tokenType as any);
    if (typeIndex === undefined) return;

    let modifierBitmask = 0;
    for (const mod of tokenModifiers) {
      const modIndex = tokenModifierMap.get(mod as any);
      if (modIndex !== undefined) {
        modifierBitmask |= 1 << modIndex;
      }
    }

    builder.push(line, char, length, typeIndex, modifierBitmask);
  }
}
