import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  getWordAtPosition,
  getWordTextAtPosition,
  SOLIDITY_KEYWORDS,
  CALL_LIKE_KEYWORDS,
  isSolidityBuiltinType,
  isInsideString,
  findLineCommentStart,
} from "../utils/text.js";

describe("getWordAtPosition", () => {
  it("extracts a word at a position", () => {
    const result = getWordAtPosition("  uint256 public count;", { line: 0, character: 18 });
    assert.ok(result);
    assert.equal(result.text, "count");
    assert.equal(result.range.start.character, 17);
    assert.equal(result.range.end.character, 22);
  });

  it("returns null for whitespace", () => {
    const result = getWordAtPosition("  uint256 public count;", { line: 0, character: 1 });
    assert.equal(result, null);
  });

  it("returns null for out-of-bounds line", () => {
    const result = getWordAtPosition("single line", { line: 5, character: 0 });
    assert.equal(result, null);
  });

  it("handles multi-line text", () => {
    const text = "line one\nline two\nline three";
    const result = getWordAtPosition(text, { line: 1, character: 5 });
    assert.ok(result);
    assert.equal(result.text, "two");
  });

  it("includes $ in identifiers", () => {
    const result = getWordAtPosition("$myVar = 1;", { line: 0, character: 2 });
    assert.ok(result);
    assert.equal(result.text, "$myVar");
  });
});

describe("getWordTextAtPosition", () => {
  it("returns just the word string", () => {
    const result = getWordTextAtPosition("function foo()", 0, 10);
    assert.equal(result, "foo");
  });

  it("returns null for non-word positions", () => {
    const result = getWordTextAtPosition("a + b", 0, 2);
    assert.equal(result, null);
  });
});

describe("SOLIDITY_KEYWORDS", () => {
  it("contains common keywords", () => {
    assert.ok(SOLIDITY_KEYWORDS.has("contract"));
    assert.ok(SOLIDITY_KEYWORDS.has("function"));
    assert.ok(SOLIDITY_KEYWORDS.has("mapping"));
    assert.ok(SOLIDITY_KEYWORDS.has("uint256"));
    assert.ok(SOLIDITY_KEYWORDS.has("msg"));
  });

  it("does not contain non-keywords", () => {
    assert.ok(!SOLIDITY_KEYWORDS.has("myVariable"));
    assert.ok(!SOLIDITY_KEYWORDS.has("Counter"));
  });
});

describe("CALL_LIKE_KEYWORDS", () => {
  it("contains flow-control keywords that look like calls", () => {
    assert.ok(CALL_LIKE_KEYWORDS.has("require"));
    assert.ok(CALL_LIKE_KEYWORDS.has("revert"));
    assert.ok(CALL_LIKE_KEYWORDS.has("emit"));
    assert.ok(CALL_LIKE_KEYWORDS.has("new"));
  });
});

describe("isSolidityBuiltinType", () => {
  it("recognizes built-in types", () => {
    assert.ok(isSolidityBuiltinType("uint256"));
    assert.ok(isSolidityBuiltinType("address"));
    assert.ok(isSolidityBuiltinType("bool"));
    assert.ok(isSolidityBuiltinType("bytes32"));
    assert.ok(isSolidityBuiltinType("int128"));
    assert.ok(isSolidityBuiltinType("string"));
  });

  it("rejects non-builtin types", () => {
    assert.ok(!isSolidityBuiltinType("Counter"));
    assert.ok(!isSolidityBuiltinType("IPool"));
    assert.ok(!isSolidityBuiltinType("mapping"));
  });
});

describe("isInsideString", () => {
  it("detects position inside double-quoted string", () => {
    assert.ok(isInsideString('require(x, "error message")', 15));
  });

  it("returns false outside strings", () => {
    assert.ok(!isInsideString('require(x, "error")', 5));
  });

  it("handles escaped quotes", () => {
    assert.ok(isInsideString('string s = "hello \\"world\\""', 20));
  });

  it("handles single-quoted strings", () => {
    assert.ok(isInsideString("string s = 'hello'", 14));
  });
});

describe("findLineCommentStart", () => {
  it("finds line comment start", () => {
    assert.equal(findLineCommentStart("uint256 x; // a counter"), 11);
  });

  it("returns -1 when no comment", () => {
    assert.equal(findLineCommentStart("uint256 x;"), -1);
  });

  it("ignores // inside strings", () => {
    assert.equal(findLineCommentStart('string s = "http://example.com"'), -1);
  });

  it("finds comment after string", () => {
    const pos = findLineCommentStart('string s = "val"; // comment');
    assert.ok(pos > 16);
  });
});
