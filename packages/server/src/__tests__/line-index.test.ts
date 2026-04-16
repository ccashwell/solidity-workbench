import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { LineIndex } from "../utils/line-index.js";

describe("LineIndex.fromText", () => {
  describe("LF line endings", () => {
    it("maps byte offsets across a simple 3-line LF file", () => {
      const text = "abc\ndef\nghi";
      const idx = LineIndex.fromText(text);

      assert.deepEqual(idx.positionAt(0), { line: 0, character: 0 });
      assert.deepEqual(idx.positionAt(3), { line: 0, character: 3 });
      assert.deepEqual(idx.positionAt(4), { line: 1, character: 0 });
      assert.deepEqual(idx.positionAt(7), { line: 1, character: 3 });
      assert.deepEqual(idx.positionAt(8), { line: 2, character: 0 });
      assert.deepEqual(idx.positionAt(11), { line: 2, character: 3 });
    });

    it("handles a single-line file with no terminator", () => {
      const idx = LineIndex.fromText("hello");
      assert.deepEqual(idx.positionAt(0), { line: 0, character: 0 });
      assert.deepEqual(idx.positionAt(2), { line: 0, character: 2 });
      assert.deepEqual(idx.positionAt(5), { line: 0, character: 5 });
    });

    it("handles a trailing newline producing an empty final line", () => {
      const idx = LineIndex.fromText("hello\n");
      assert.deepEqual(idx.positionAt(5), { line: 0, character: 5 });
      assert.deepEqual(idx.positionAt(6), { line: 1, character: 0 });
    });
  });

  describe("CRLF line endings", () => {
    it("accounts for the extra \\r byte per line", () => {
      const text = "abc\r\ndef\r\nghi";
      const idx = LineIndex.fromText(text);

      assert.deepEqual(idx.positionAt(0), { line: 0, character: 0 });
      assert.deepEqual(idx.positionAt(3), { line: 0, character: 3 });
      assert.deepEqual(idx.positionAt(5), { line: 1, character: 0 });
      assert.deepEqual(idx.positionAt(8), { line: 1, character: 3 });
      assert.deepEqual(idx.positionAt(10), { line: 2, character: 0 });
      assert.deepEqual(idx.positionAt(13), { line: 2, character: 3 });
    });

    it("treats an offset inside CRLF as end-of-line", () => {
      // "abc\r\n" — byte 3 is the '\r', byte 4 is the '\n'
      const idx = LineIndex.fromText("abc\r\ndef");
      assert.deepEqual(idx.positionAt(4), { line: 0, character: 3 });
    });
  });

  describe("UTF-8 multibyte characters", () => {
    it("maps byte offsets past multibyte chars to correct UTF-16 index", () => {
      // "café" in UTF-8: c(1) a(1) f(1) é(2) = 5 bytes; JS length 4
      const idx = LineIndex.fromText("café\nhi");

      assert.deepEqual(idx.positionAt(0), { line: 0, character: 0 });
      assert.deepEqual(idx.positionAt(3), { line: 0, character: 3 });
      assert.deepEqual(idx.positionAt(5), { line: 0, character: 4 });
      assert.deepEqual(idx.positionAt(6), { line: 1, character: 0 });
      assert.deepEqual(idx.positionAt(7), { line: 1, character: 1 });
    });

    it("handles a non-BMP emoji (surrogate pair, 4 UTF-8 bytes)", () => {
      // "hi 👋" in UTF-8: h(1) i(1) space(1) 👋(4) = 7 bytes; JS length 5
      const idx = LineIndex.fromText("hi 👋\nworld");

      assert.deepEqual(idx.positionAt(3), { line: 0, character: 3 });
      assert.deepEqual(idx.positionAt(7), { line: 0, character: 5 });
      assert.deepEqual(idx.positionAt(8), { line: 1, character: 0 });
      assert.deepEqual(idx.positionAt(13), { line: 1, character: 5 });
    });
  });

  describe("empty input", () => {
    it("handles an empty file and a zero offset", () => {
      const idx = LineIndex.fromText("");
      assert.deepEqual(idx.positionAt(0), { line: 0, character: 0 });
    });

    it("clamps any positive offset on an empty file to (0, 0)", () => {
      const idx = LineIndex.fromText("");
      assert.deepEqual(idx.positionAt(42), { line: 0, character: 0 });
    });
  });

  describe("offset past EOF", () => {
    it("clamps to last line, last column", () => {
      const idx = LineIndex.fromText("hello\nworld");
      assert.deepEqual(idx.positionAt(100), { line: 1, character: 5 });
    });

    it("clamps negative offsets to (0, 0)", () => {
      const idx = LineIndex.fromText("hello\nworld");
      assert.deepEqual(idx.positionAt(-1), { line: 0, character: 0 });
    });
  });
});
