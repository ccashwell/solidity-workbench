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

  describe("struct members", () => {
    it("tokenizes user-defined member types and member names inside a struct", () => {
      // Mirrors the real-world shape that was rendering as plain
      // identifiers before the raw-AST rewrite: user-defined types
      // (`PoolKey`, `MarketId`) and their member names (`poolKey`,
      // `marketId`) both need semantic tokens.
      const code = `contract C {
    struct EscrowedPosition {
        PoolKey poolKey;
        int24 tickLower;
        MarketId marketId;
        address borrower;
    }
}`;
      const { provider, doc } = setup(code);
      const tokens = decodeTokens(provider.provideSemanticTokens(doc).data);

      // struct name is tokenized as `struct`
      assert.ok(
        tokens.some((t) => t.type === "struct" && t.length === "EscrowedPosition".length),
        `expected struct name token; got ${JSON.stringify(tokens)}`,
      );

      // user-defined member type references are tokenized as `type`
      const typeTokens = tokens.filter((t) => t.type === "type");
      assert.ok(
        typeTokens.some((t) => t.length === "PoolKey".length),
        `expected a \`type\` token for PoolKey; got ${JSON.stringify(typeTokens)}`,
      );
      assert.ok(
        typeTokens.some((t) => t.length === "MarketId".length),
        `expected a \`type\` token for MarketId; got ${JSON.stringify(typeTokens)}`,
      );

      // member names are tokenized as `property`
      const memberNames = ["poolKey", "tickLower", "marketId", "borrower"];
      const propertyLengths = new Set(
        tokens.filter((t) => t.type === "property").map((t) => t.length),
      );
      for (const n of memberNames) {
        assert.ok(
          propertyLengths.has(n.length),
          `expected a property token with length ${n.length} (for ${n}); got ${JSON.stringify([...propertyLengths])}`,
        );
      }

      // elementary types (int24, address) must NOT be emitted as semantic
      // `type` tokens — TextMate handles primitives.
      assert.ok(
        !typeTokens.some((t) => t.length === "int24".length && t.char >= 0),
        "elementary type int24 should not produce a `type` token",
      );
    });
  });

  describe("event / error / function parameters", () => {
    it("tokenizes event parameter names and user-defined parameter types", () => {
      const code = `interface I {
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Custom(MyStruct indexed s, MyType v);
}`;
      const { provider, doc } = setup(code);
      const tokens = decodeTokens(provider.provideSemanticTokens(doc).data);

      const paramTokens = tokens.filter((t) => t.type === "parameter");
      const paramLengths = new Set(paramTokens.map((t) => t.length));
      for (const n of ["from", "to", "value", "s", "v"]) {
        assert.ok(
          paramLengths.has(n.length),
          `expected a parameter token with length ${n.length} (for ${n}); got ${JSON.stringify([...paramLengths])}`,
        );
      }

      const typeTokens = tokens.filter((t) => t.type === "type");
      assert.ok(
        typeTokens.some((t) => t.length === "MyStruct".length),
        "expected a `type` token for MyStruct",
      );
      assert.ok(
        typeTokens.some((t) => t.length === "MyType".length),
        "expected a `type` token for MyType",
      );
    });

    it("tokenizes function parameter names and return-type references", () => {
      const code = `contract C {
    function quote(MarketId id, uint256 amount) external view returns (Quote memory q) {}
}`;
      const { provider, doc } = setup(code);
      const tokens = decodeTokens(provider.provideSemanticTokens(doc).data);

      const paramLengths = new Set(
        tokens.filter((t) => t.type === "parameter").map((t) => t.length),
      );
      for (const n of ["id", "amount", "q"]) {
        assert.ok(
          paramLengths.has(n.length),
          `expected a parameter token for ${n}; got ${JSON.stringify([...paramLengths])}`,
        );
      }

      const typeLengths = tokens.filter((t) => t.type === "type").map((t) => t.length);
      assert.ok(typeLengths.includes("MarketId".length), "expected a `type` token for MarketId");
      assert.ok(typeLengths.includes("Quote".length), "expected a `type` token for Quote");
    });
  });

  describe("user-defined types as type references", () => {
    it("tokenizes base contracts in `is A, B` as type references", () => {
      const code = `interface IBase {}
abstract contract Mixin {}
contract Foo is IBase, Mixin { uint256 public x; }`;
      const { provider, doc } = setup(code);
      const tokens = decodeTokens(provider.provideSemanticTokens(doc).data);

      const typeLengths = tokens.filter((t) => t.type === "type").map((t) => t.length);
      assert.ok(typeLengths.includes("IBase".length), "expected a `type` token for IBase");
      assert.ok(typeLengths.includes("Mixin".length), "expected a `type` token for Mixin");
    });

    it("tokenizes a user-defined value type declaration and its references", () => {
      const code = `type MarketId is uint256;
contract C {
    function f(MarketId id) external pure returns (MarketId) { return id; }
}`;
      const { provider, doc } = setup(code);
      const tokens = decodeTokens(provider.provideSemanticTokens(doc).data);

      const typeTokens = tokens.filter((t) => t.type === "type");
      // Declaration + two reference sites (parameter type + return type)
      const marketIdCount = typeTokens.filter((t) => t.length === "MarketId".length).length;
      assert.ok(
        marketIdCount >= 3,
        `expected at least 3 MarketId \`type\` tokens (decl + param + return); got ${marketIdCount}`,
      );
    });

    it("tokenizes a user-defined type referenced inside a function body", () => {
      const code = `contract C {
    struct Point { uint256 x; uint256 y; }
    function f() external pure returns (uint256) {
        Point memory p = Point(1, 2);
        return p.x;
    }
}`;
      const { provider, doc } = setup(code);
      const tokens = decodeTokens(provider.provideSemanticTokens(doc).data);

      // Reference to Point in the body should receive a `struct`
      // semantic token (we register structs in nameKinds).
      const structTokens = tokens.filter(
        (t) => t.type === "struct" && t.length === "Point".length,
      );
      assert.ok(
        structTokens.length >= 2,
        `expected at least 2 struct tokens for Point (decl + body ref); got ${structTokens.length}`,
      );
    });
  });

  describe("mapping and array element types", () => {
    it("tokenizes the user-defined value type of a mapping", () => {
      const code = `contract C {
    mapping(address => UserData) public users;
}`;
      const { provider, doc } = setup(code);
      const tokens = decodeTokens(provider.provideSemanticTokens(doc).data);

      assert.ok(
        tokens.some((t) => t.type === "type" && t.length === "UserData".length),
        "expected a `type` token for UserData inside the mapping value type",
      );
    });

    it("tokenizes the user-defined element type of an array", () => {
      const code = `contract C {
    Order[] public orders;
}`;
      const { provider, doc } = setup(code);
      const tokens = decodeTokens(provider.provideSemanticTokens(doc).data);

      assert.ok(
        tokens.some((t) => t.type === "type" && t.length === "Order".length),
        "expected a `type` token for Order[] element type",
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
