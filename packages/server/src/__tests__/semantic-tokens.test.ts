import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { TextDocument } from "vscode-languageserver-textdocument";
import { SolSemanticTokenTypes } from "@solidity-workbench/common";
import { SolidityParser } from "../parser/solidity-parser.js";
import { SemanticTokensProvider } from "../providers/semantic-tokens.js";

interface DecodedToken {
  line: number;
  char: number;
  length: number;
  type: string;
  typeIndex: number;
  modifiers: number;
}

/**
 * Decode the LSP semantic-tokens `data` array into absolute-position
 * tokens. The wire format is a flat series of 5-tuples:
 * `[deltaLine, deltaStart, length, tokenType, tokenModifiers]`. When
 * `deltaLine === 0`, `deltaStart` is relative to the previous token's
 * character; otherwise it's absolute within the new line.
 */
function decodeTokens(data: number[]): DecodedToken[] {
  const out: DecodedToken[] = [];
  let line = 0;
  let char = 0;
  for (let i = 0; i < data.length; i += 5) {
    const dLine = data[i];
    const dStart = data[i + 1];
    const length = data[i + 2];
    const typeIndex = data[i + 3];
    const modifiers = data[i + 4];
    if (dLine === 0) {
      char += dStart;
    } else {
      line += dLine;
      char = dStart;
    }
    out.push({
      line,
      char,
      length,
      type: SolSemanticTokenTypes[typeIndex] ?? `unknown(${typeIndex})`,
      typeIndex,
      modifiers,
    });
  }
  return out;
}

function setup(code: string): { provider: SemanticTokensProvider; doc: TextDocument } {
  const parser = new SolidityParser();
  const uri = "file:///test.sol";
  parser.parse(uri, code);
  const doc = TextDocument.create(uri, "solidity", 1, code);
  return { provider: new SemanticTokensProvider(parser), doc };
}

describe("SemanticTokensProvider", () => {
  describe("ordering", () => {
    it("returns declaration tokens in sorted (line, char) order", () => {
      const code = `contract C {
    event E();
    uint256 public x;
    function f() external {}
}`;
      const { provider, doc } = setup(code);
      const tokens = decodeTokens(provider.provideSemanticTokens(doc).data);

      assert.ok(tokens.length >= 4, `expected at least 4 tokens, got ${tokens.length}`);

      for (let i = 1; i < tokens.length; i++) {
        const prev = tokens[i - 1];
        const curr = tokens[i];
        const ordered =
          curr.line > prev.line || (curr.line === prev.line && curr.char >= prev.char);
        assert.ok(
          ordered,
          `tokens out of order at index ${i}: (${prev.line},${prev.char}) then (${curr.line},${curr.char})`,
        );
      }
    });
  });

  describe("reference sites", () => {
    it("tokenizes a state-variable reference inside a function body as a property", () => {
      const code = `contract C {
    uint256 public x;
    function f() external view returns (uint256) { return x; }
}`;
      const { provider, doc } = setup(code);
      const tokens = decodeTokens(provider.provideSemanticTokens(doc).data);

      // The function body is on line 2; the `x` being returned is the last
      // identifier on that line before the closing brace.
      const funcLine = 2;
      const xCol = code.split("\n")[funcLine].lastIndexOf("x");

      const refToken = tokens.find(
        (t) => t.line === funcLine && t.char === xCol && t.length === 1 && t.type === "property",
      );
      assert.ok(
        refToken,
        `expected a property token at line ${funcLine} col ${xCol}; got ${JSON.stringify(tokens)}`,
      );

      // Declaration + reference ⇒ at least two property tokens total.
      const propertyTokens = tokens.filter((t) => t.type === "property");
      assert.ok(
        propertyTokens.length >= 2,
        `expected at least 2 property tokens (decl + ref), got ${propertyTokens.length}`,
      );
    });

    it("does not tokenize identifiers that appear inside string literals", () => {
      const code = `contract C {
    uint256 public x;
    function f() external pure returns (string memory) { return "x"; }
}`;
      const { provider, doc } = setup(code);
      const tokens = decodeTokens(provider.provideSemanticTokens(doc).data);

      // Only the declaration of `x` should be tokenized as property — the
      // `x` inside "x" must be skipped.
      const propertyTokens = tokens.filter((t) => t.type === "property");
      assert.equal(
        propertyTokens.length,
        1,
        `expected exactly 1 property token (declaration only), got ${propertyTokens.length}: ${JSON.stringify(propertyTokens)}`,
      );
    });
  });

  describe("range request", () => {
    it("returns fewer tokens when given a sub-range that excludes declarations", () => {
      const code = `contract C {
    event E();
    uint256 public x;
    function f() external {}
}`;
      const { provider, doc } = setup(code);

      const full = decodeTokens(provider.provideSemanticTokens(doc).data);
      const ranged = decodeTokens(
        provider.provideSemanticTokensRange(doc, {
          start: { line: 2, character: 0 },
          end: { line: 3, character: 0 },
        }).data,
      );

      assert.ok(
        full.length > ranged.length,
        `full (${full.length}) must exceed ranged (${ranged.length})`,
      );
      for (const t of ranged) {
        assert.ok(
          t.line >= 2 && t.line <= 3,
          `token outside requested range: ${JSON.stringify(t)}`,
        );
      }
    });
  });
});
