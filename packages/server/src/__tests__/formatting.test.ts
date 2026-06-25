import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { TextDocument } from "vscode-languageserver-textdocument";
import { FormattingProvider } from "../providers/formatting.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";

describe("FormattingProvider", () => {
  it("bounds forge fmt so formatting requests cannot hang the editor", async () => {
    const calls: { args: string[]; timeoutMs?: number }[] = [];
    const workspace = {
      runForge: async (args: string[], _cwd?: string, options?: { timeoutMs?: number }) => {
        calls.push({ args, timeoutMs: options?.timeoutMs });
        return { stdout: "", stderr: "timed out", exitCode: 1 };
      },
    } as unknown as WorkspaceManager;
    const provider = new FormattingProvider(workspace);
    const document = TextDocument.create(
      "file:///Counter.sol",
      "solidity",
      1,
      "contract Counter { uint256 public count; }\n",
    );

    const edits = await provider.format(document, { insertSpaces: true, tabSize: 4 });

    assert.deepEqual(edits, []);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(0, 1), ["fmt"]);
    assert.equal(calls[0].timeoutMs, 5_000);
  });
});
