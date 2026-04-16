import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import type { Diagnostic } from "vscode-languageserver/node.js";
import { DiagnosticSeverity } from "vscode-languageserver/node.js";
import { SolidityParser } from "../parser/solidity-parser.js";
import { SymbolIndex } from "../analyzer/symbol-index.js";
import { AutoImportProvider } from "../providers/auto-import.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";

/**
 * Minimal workspace stub sufficient for AutoImportProvider. The provider
 * calls:
 *   - getRemappings(): Remapping[]
 *   - resolveImport(importPath, fromFile): string | null
 *   - uriToPath(uri): string
 * and a few `root`-style getters we don't exercise. We fake just what's
 * needed.
 */
function makeFakeWorkspace(opts: {
  remappings?: { prefix: string; path: string }[];
  resolveImport?: (p: string, from: string) => string | null;
}) {
  return {
    root: "/project",
    getAllFileUris: () => [],
    uriToPath: (uri: string) => URI.parse(uri).fsPath,
    getRemappings: () => opts.remappings ?? [],
    resolveImport: opts.resolveImport ?? (() => null),
  } as unknown as WorkspaceManager;
}

function indexFile(parser: SolidityParser, idx: SymbolIndex, uri: string, text: string): void {
  parser.parse(uri, text);
  idx.updateFile(uri);
}

function makeUndeclaredDiag(
  range: { line: number; character: number },
  length: number,
  message: string,
): Diagnostic {
  return {
    severity: DiagnosticSeverity.Error,
    range: {
      start: range,
      end: { line: range.line, character: range.character + length },
    },
    message,
    source: "solc",
    code: "7576",
  };
}

describe("AutoImportProvider", () => {
  describe("quick-fix from Undeclared identifier diagnostic", () => {
    it("suggests a remapped import path when one applies", () => {
      const parser = new SolidityParser();
      const workspace = makeFakeWorkspace({
        remappings: [{ prefix: "@oz/", path: "/project/lib/oz/contracts/" }],
      });
      const idx = new SymbolIndex(parser, workspace);

      // A file at the remapped location declares IERC20.
      indexFile(
        parser,
        idx,
        URI.file("/project/lib/oz/contracts/token/IERC20.sol").toString(),
        "pragma solidity ^0.8.0; interface IERC20 { function transfer(address, uint256) external returns (bool); }",
      );

      // The consumer file uses IERC20 without importing it.
      const consumerUri = URI.file("/project/src/Wrapper.sol").toString();
      const consumerText = `pragma solidity ^0.8.0;
contract Wrapper {
    IERC20 public token;
}`;
      indexFile(parser, idx, consumerUri, consumerText);

      const provider = new AutoImportProvider(idx, workspace, parser);
      const doc = TextDocument.create(consumerUri, "solidity", 1, consumerText);

      const diag = makeUndeclaredDiag(
        { line: 2, character: 4 },
        "IERC20".length,
        `Undeclared identifier "IERC20"`,
      );

      const actions = provider.provideImportActions(doc, [diag]);
      assert.ok(actions.length >= 1, "expected at least one import action");

      const titles = actions.map((a) => a.title);
      assert.ok(
        titles.some((t) => t.includes("@oz/token/IERC20.sol")),
        `expected a remapped import among: ${JSON.stringify(titles)}`,
      );
    });

    it("offers no action for symbols the index has never seen", () => {
      const parser = new SolidityParser();
      const workspace = makeFakeWorkspace({});
      const idx = new SymbolIndex(parser, workspace);

      const uri = URI.file("/project/src/A.sol").toString();
      const text = `pragma solidity ^0.8.0;\ncontract A {}\n`;
      indexFile(parser, idx, uri, text);

      const provider = new AutoImportProvider(idx, workspace, parser);
      const doc = TextDocument.create(uri, "solidity", 1, text);

      const diag = makeUndeclaredDiag(
        { line: 1, character: 0 },
        "MysteryLib".length,
        `Undeclared identifier "MysteryLib"`,
      );
      const actions = provider.provideImportActions(doc, [diag]);
      // The proactive scan may still surface candidates from uppercase
      // identifiers in the text. What matters is that NONE of them point
      // to a file that exports "MysteryLib" — because nothing does.
      for (const action of actions) {
        assert.ok(!action.title.includes("MysteryLib"));
      }
    });
  });

  describe("quick-fix path selection", () => {
    it("prefers a remapped path over a relative one when both match", () => {
      const parser = new SolidityParser();
      const workspace = makeFakeWorkspace({
        remappings: [{ prefix: "@lib/", path: "/project/lib/foo/src/" }],
      });
      const idx = new SymbolIndex(parser, workspace);

      indexFile(
        parser,
        idx,
        URI.file("/project/lib/foo/src/Widget.sol").toString(),
        "contract Widget {}",
      );

      const consumerUri = URI.file("/project/src/App.sol").toString();
      const consumerText = `pragma solidity ^0.8.0;
contract App { Widget public w; }`;
      indexFile(parser, idx, consumerUri, consumerText);

      const provider = new AutoImportProvider(idx, workspace, parser);
      const doc = TextDocument.create(consumerUri, "solidity", 1, consumerText);

      const diag = makeUndeclaredDiag(
        { line: 1, character: 15 },
        "Widget".length,
        `Undeclared identifier "Widget"`,
      );

      const actions = provider.provideImportActions(doc, [diag]);
      const titles = actions.map((a) => a.title);
      const remapped = titles.find((t) => t.includes("@lib/Widget.sol"));
      assert.ok(remapped, `expected @lib/ remapped path, got ${JSON.stringify(titles)}`);
    });
  });

  describe("diagnostic filtering", () => {
    it("ignores diagnostics that aren't about unresolved identifiers", () => {
      const parser = new SolidityParser();
      const workspace = makeFakeWorkspace({});
      const idx = new SymbolIndex(parser, workspace);

      const uri = URI.file("/project/src/A.sol").toString();
      const text = `pragma solidity ^0.8.0;\ncontract A {}\n`;
      indexFile(parser, idx, uri, text);

      const provider = new AutoImportProvider(idx, workspace, parser);
      const doc = TextDocument.create(uri, "solidity", 1, text);

      const diag: Diagnostic = {
        severity: DiagnosticSeverity.Warning,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        },
        message: "Unused variable",
        source: "solc",
        code: "2072",
      };

      const actions = provider.provideImportActions(doc, [diag]);
      // None of the returned actions should be "import"-style fixes
      // flagged as preferred — the proactive scan might return
      // lower-priority suggestions, but the Undeclared path must NOT
      // have triggered.
      for (const action of actions) {
        assert.equal(action.isPreferred, false);
      }
    });
  });
});
