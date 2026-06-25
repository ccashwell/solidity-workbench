import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { TextDocuments } from "vscode-languageserver/node.js";
import { URI } from "vscode-uri";
import { SolidityParser } from "../parser/solidity-parser.js";
import { SymbolIndex } from "../analyzer/symbol-index.js";
import { SemanticResolver } from "../analyzer/semantic-resolver.js";
import { ReferencesProvider } from "../providers/references.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";

function makeFakeWorkspace(
  uris: string[] = [],
  resolveImport: (importPath: string, from: string) => string | null = () => null,
) {
  return {
    getAllFileUris: () => uris,
    uriToPath: (uri: string) => URI.parse(uri).fsPath,
    resolveImport,
    root: "/w",
  } as unknown as WorkspaceManager;
}

function makeFakeDocuments(docs: TextDocument[]): TextDocuments<TextDocument> {
  return {
    all: () => docs,
    get: (uri: string) => docs.find((doc) => doc.uri === uri),
  } as unknown as TextDocuments<TextDocument>;
}

type ReferencesSolcBridge = Parameters<ReferencesProvider["setSolcBridge"]>[0];

describe("ReferencesProvider", () => {
  it("uses the solc declaration for includeDeclaration without merging same-name symbols", () => {
    const uri = "file:///w/Overloads.sol";
    const text =
      "contract A {\n" +
      "    function ping() external {}\n" +
      "    function call() external { ping(); }\n" +
      "}\n" +
      "contract B {\n" +
      "    function ping(uint256 x) external {}\n" +
      "}\n";
    const parser = new SolidityParser();
    const workspace = makeFakeWorkspace();
    const index = new SymbolIndex(parser, workspace);
    parser.parse(uri, text);
    index.updateFile(uri);

    const doc = TextDocument.create(uri, "solidity", 1, text);
    const provider = new ReferencesProvider(index, workspace, parser, makeFakeDocuments([doc]));
    const declarationOffset = text.indexOf("function ping()") + "function ".length;
    const declarationNameOffset = text.indexOf("ping()");
    const callOffset = text.indexOf("ping();");
    provider.setSolcBridge({
      findReferencesAt: () => ({
        declaration: {
          filePath: URI.parse(uri).fsPath,
          offset: declarationNameOffset,
          length: "ping".length,
        },
        references: [
          {
            filePath: URI.parse(uri).fsPath,
            offset: callOffset,
            length: "ping".length,
          },
        ],
      }),
    } as unknown as ReferencesSolcBridge);

    const refs = provider.provideReferences(doc, doc.positionAt(declarationOffset), {
      includeDeclaration: true,
    });

    assert.equal(refs.length, 2);
    assert.ok(
      refs.some((ref) => ref.range.start.line === 1),
      "expected A.ping declaration",
    );
    assert.ok(
      refs.some((ref) => ref.range.start.line === 2),
      "expected A.ping call site",
    );
    assert.equal(
      refs.some((ref) => ref.range.start.line === 5),
      false,
      "must not include unrelated B.ping(uint256) declaration",
    );
  });

  it("filters indexed references to files that can reach the selected declaration", () => {
    const helperUri = "file:///w/src/Helpers.sol";
    const useUri = "file:///w/src/Use.sol";
    const testHelperUri = "file:///w/test/Helpers.sol";
    const files = {
      [helperUri]: `function helper() pure returns (uint256) {
    return 1;
}`,
      [useUri]: `import "./Helpers.sol";
contract Use {
    function run() external pure returns (uint256) {
        return helper();
    }
}`,
      [testHelperUri]: `function helper() pure returns (uint256) {
    return 2;
}`,
    };
    const parser = new SolidityParser();
    const workspace = makeFakeWorkspace(Object.keys(files), (importPath, from) =>
      importPath === "./Helpers.sol" && from.endsWith("/src/Use.sol")
        ? URI.parse(helperUri).fsPath
        : null,
    );
    const index = new SymbolIndex(parser, workspace);
    const docs: TextDocument[] = [];
    for (const [uri, text] of Object.entries(files)) {
      parser.parse(uri, text);
      index.updateFile(uri);
      docs.push(TextDocument.create(uri, "solidity", 1, text));
    }
    const resolver = new SemanticResolver(parser, workspace, index);
    const doc = docs.find((candidate) => candidate.uri === helperUri);
    assert.ok(doc);
    const provider = new ReferencesProvider(
      index,
      workspace,
      parser,
      makeFakeDocuments(docs),
      resolver,
    );

    const refs = provider.provideReferences(
      doc,
      { line: 0, character: "function ".length + 1 },
      { includeDeclaration: true },
    );

    assert.ok(
      refs.some((ref) => ref.uri === helperUri && ref.range.start.line === 0),
      "expected source helper declaration",
    );
    assert.ok(
      refs.some((ref) => ref.uri === useUri && ref.range.start.line === 3),
      "expected source helper call site",
    );
    assert.equal(
      refs.some((ref) => ref.uri === testHelperUri),
      false,
      "unrelated same-name test helper must not be returned",
    );
  });
});
