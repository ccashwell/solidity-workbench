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

  describe("locally-declared identifiers", () => {
    // Regression for the "Import 'CountChanged' from ./interfaces/ICounter.sol"
    // quick fix that showed up in a file where `CountChanged` was
    // already declared locally as an event.
    function setupCounterFixture() {
      const parser = new SolidityParser();
      const workspace = makeFakeWorkspace({});
      const idx = new SymbolIndex(parser, workspace);

      // The interface in a sibling file also declares CountChanged, so
      // the symbol index contains multiple hits by name.
      indexFile(
        parser,
        idx,
        URI.file("/project/src/interfaces/ICounter.sol").toString(),
        `pragma solidity ^0.8.0;
interface ICounter {
    event CountChanged(uint256 oldValue, uint256 newValue);
    error NotOwner(address caller, address expectedOwner);
    error Overflow();
}`,
      );

      // The consumer declares the same names locally — it does NOT
      // need an import even though the index has entries in ICounter.sol.
      const consumerUri = URI.file("/project/src/Counter.sol").toString();
      const consumerText = `pragma solidity ^0.8.0;
contract Counter {
    event CountChanged(uint256 indexed oldValue, uint256 indexed newValue);
    error NotOwner(address caller, address expectedOwner);
    error Overflow();

    function reset() external {
        emit CountChanged(0, 0);
    }
}`;
      indexFile(parser, idx, consumerUri, consumerText);

      return {
        provider: new AutoImportProvider(idx, workspace, parser),
        doc: TextDocument.create(consumerUri, "solidity", 1, consumerText),
      };
    }

    it("never suggests importing an event that is declared in the current file", () => {
      const { provider, doc } = setupCounterFixture();
      // Proactive scan only: no diagnostics, but give a range that
      // covers the whole file so every identifier is considered.
      const actions = provider.provideImportActions(doc, [], {
        start: { line: 0, character: 0 },
        end: { line: 20, character: 0 },
      });
      for (const a of actions) {
        assert.ok(
          !a.title.includes("CountChanged"),
          `locally-declared event must not surface an import: ${a.title}`,
        );
        assert.ok(
          !a.title.includes("NotOwner"),
          `locally-declared error must not surface an import: ${a.title}`,
        );
        assert.ok(
          !a.title.includes("Overflow"),
          `locally-declared error must not surface an import: ${a.title}`,
        );
      }
    });

    it("short-circuits even on an Undeclared diagnostic when the name is declared locally", () => {
      // A stale / spurious diagnostic claiming CountChanged is
      // undeclared must not trick the provider into importing a
      // different declaration from another file.
      const { provider, doc } = setupCounterFixture();
      const diag = makeUndeclaredDiag(
        { line: 2, character: 10 },
        "CountChanged".length,
        `Undeclared identifier "CountChanged"`,
      );
      const actions = provider.provideImportActions(doc, [diag]);
      for (const a of actions) {
        assert.ok(
          !a.title.includes("CountChanged"),
          `local declaration should short-circuit diagnostic-triggered import: ${a.title}`,
        );
      }
    });

    it("includes UDVTs, free functions, and file-level errors in the local-name set", () => {
      const parser = new SolidityParser();
      const workspace = makeFakeWorkspace({});
      const idx = new SymbolIndex(parser, workspace);

      // Sibling file also declares the same names.
      indexFile(
        parser,
        idx,
        URI.file("/project/src/Shared.sol").toString(),
        `pragma solidity ^0.8.0;
type MarketId is uint256;
error GlobalErr(uint256 code);
function globalHelper(uint256 x) pure returns (uint256) { return x; }`,
      );

      // Consumer declares them locally.
      const consumerUri = URI.file("/project/src/App.sol").toString();
      const consumerText = `pragma solidity ^0.8.0;
type MarketId is uint256;
error GlobalErr(uint256 code);
function globalHelper(uint256 x) pure returns (uint256) { return x; }

contract App {
    function usesAll(MarketId id) external pure returns (uint256) {
        if (id == MarketId.wrap(0)) revert GlobalErr(1);
        return globalHelper(id.unwrap());
    }
}`;
      indexFile(parser, idx, consumerUri, consumerText);

      const provider = new AutoImportProvider(idx, workspace, parser);
      const doc = TextDocument.create(consumerUri, "solidity", 1, consumerText);
      const actions = provider.provideImportActions(doc, [], {
        start: { line: 0, character: 0 },
        end: { line: 20, character: 0 },
      });
      for (const a of actions) {
        assert.ok(
          !a.title.includes("MarketId"),
          `local UDVT must not surface an import: ${a.title}`,
        );
        assert.ok(
          !a.title.includes("GlobalErr"),
          `local file-level error must not surface an import: ${a.title}`,
        );
      }
    });
  });

  describe("proactive suggestions are range-scoped", () => {
    // Regression for the Quick Fix menu showing imports for every
    // undeclared identifier in the file when the cursor was sitting
    // on an unrelated diagnostic (e.g. the pragma's floating-pragma
    // warning).
    it("does not surface imports for identifiers outside the requested range", () => {
      const parser = new SolidityParser();
      const workspace = makeFakeWorkspace({});
      const idx = new SymbolIndex(parser, workspace);

      // The sibling file declares `MysteryLib` — a candidate for
      // proactive import.
      indexFile(
        parser,
        idx,
        URI.file("/project/lib/mystery/MysteryLib.sol").toString(),
        "pragma solidity ^0.8.0; library MysteryLib { function noop() external {} }",
      );

      // Consumer uses `MysteryLib` down on line 5; line 0 has an
      // unrelated floating-pragma diagnostic on the pragma statement.
      const consumerUri = URI.file("/project/src/App.sol").toString();
      const consumerText = `pragma solidity ^0.8.0;

contract App {
    function f() external pure returns (uint256) {
        MysteryLib.noop();
        return 0;
    }
}`;
      indexFile(parser, idx, consumerUri, consumerText);

      const provider = new AutoImportProvider(idx, workspace, parser);
      const doc = TextDocument.create(consumerUri, "solidity", 1, consumerText);

      // Ask for code actions anchored to the pragma line. The
      // proactive scan must NOT surface the MysteryLib import.
      const actionsAtPragma = provider.provideImportActions(doc, [], {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 24 },
      });
      for (const a of actionsAtPragma) {
        assert.ok(
          !a.title.includes("MysteryLib"),
          `import suggestion leaked into unrelated pragma range: ${a.title}`,
        );
      }

      // For comparison: anchored to the line that uses MysteryLib,
      // the suggestion should be offered.
      const actionsAtUsage = provider.provideImportActions(doc, [], {
        start: { line: 4, character: 0 },
        end: { line: 4, character: 30 },
      });
      assert.ok(
        actionsAtUsage.some((a) => a.title.includes("MysteryLib")),
        `proactive import should fire for identifier in range; got ${JSON.stringify(actionsAtUsage.map((a) => a.title))}`,
      );
    });

    it("falls back to whole-file scan when no range is supplied (back-compat)", () => {
      const parser = new SolidityParser();
      const workspace = makeFakeWorkspace({});
      const idx = new SymbolIndex(parser, workspace);

      indexFile(
        parser,
        idx,
        URI.file("/project/lib/oz/IERC20.sol").toString(),
        "interface IERC20 {}",
      );

      const consumerUri = URI.file("/project/src/App.sol").toString();
      const consumerText = `pragma solidity ^0.8.0;
contract App { IERC20 public token; }`;
      indexFile(parser, idx, consumerUri, consumerText);

      const provider = new AutoImportProvider(idx, workspace, parser);
      const doc = TextDocument.create(consumerUri, "solidity", 1, consumerText);

      const actions = provider.provideImportActions(doc, []);
      assert.ok(
        actions.some((a) => a.title.includes("IERC20")),
        "no-range call should still run the whole-file proactive scan",
      );
    });
  });
});
