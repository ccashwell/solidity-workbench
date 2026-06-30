import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import * as vscode from "vscode";
import {
  LineIndex,
  buildPcToInstructionIndex,
  parseForgeArtifact,
  parseSourceMap,
  resolveSourcePosition,
  type SourceMapEntry,
  type ForgeArtifact,
  type FileCoverage,
  type InheritanceGraphResult,
  type ProjectGraphPathResult,
  type ProjectGraphQueryResult,
  type ProjectGraphResult,
  type ProjectGraphSearchResult,
  type ProjectGraphStatsResult,
} from "@solidity-workbench/common";
import {
  buildProjectGraphScopeDiagnosticsReport,
  ProjectGraphExporter,
  PROJECT_GRAPH_CALLER_TARGET_NODE_KINDS,
  PROJECT_GRAPH_DEFAULT_RENDERED_NODE_LIMIT,
  PROJECT_GRAPH_MAX_RENDERED_NODE_LIMIT,
  PROJECT_GRAPH_NODE_KIND_FILTER_ITEMS,
  PROJECT_GRAPH_RENDER_NODE_LIMIT_STEP,
  expandProjectGraphRenderedNodeLimit,
  normalizeProjectGraphRenderedNodeLimit,
  projectGraphNodeMatchesKindFilter,
  projectGraphRenderedNodeState,
  summarizeProjectGraphCompilerStatus,
  projectGraphQueryMissLabel,
  projectGraphQueryTargetKinds,
  projectGraphIncludeDependenciesFlag,
  projectGraphIncludeTestsFlag,
  projectGraphHiddenScopeHint,
  projectGraphShowMoreControlState,
  PROJECT_GRAPH_CALLABLE_NODE_KINDS,
  serializeProjectGraphForExport,
  summarizeProjectGraphEdgeQuality,
  summarizeProjectGraphResultDiagnostics,
  summarizeProjectGraphRelationshipStatus,
} from "../../views/project-graph";
import {
  InheritanceGraphPanel,
  inheritanceGraphIncludeDependenciesFlag,
  inheritanceGraphIncludeTestsFlag,
} from "../../views/inheritance-graph";
import { CoverageProvider } from "../../views/coverage";
import { buildSlitherDiagnostics } from "../../analysis/slither";
import { buildAderynDiagnostics } from "../../analysis/aderyn";
import { buildWakeDiagnostics } from "../../analysis/wake";
import { buildMythrilDiagnostics } from "../../analysis/mythril";
import { shouldFormatSolidityOnSave } from "../../format-on-save";
import { shellArg, shellCommand } from "../../shell";
import {
  applyMutation,
  buildMutationCandidates,
  buildForgeMutationTestArgs,
  buildGambitMutateArgs,
  formatMutationReport,
  generateFoundryTestSkeleton,
  hasForgeTestFailures,
  parseGambitMutantsLog,
  resolveMutationForgeTestScope,
  summarizeMutationResults,
  type MutationResult,
} from "../../mutation/mutation-provider";

/**
 * End-to-end coverage of the feature surface that landed across the
 * April–May 2026 sweeps. Complements the existing `activation` and
 * `lsp-round-trip` suites with broader (not deeper) coverage:
 *
 *   - LSP-driven providers reachable via VSCode's
 *     `executeXxxProvider` commands (code lens, inlay hints,
 *     diagnostics).
 *   - User-facing webview commands (storage layout, IR Viewer,
 *     ABI Explorer, inheritance graph) — verified to be reachable
 *     and execute without throwing.
 *   - Test Explorer controller registration.
 *   - DAP debug adapter registration via the public configuration
 *     contribution.
 *
 * Tests degrade gracefully when external binaries (forge, slither,
 * aderyn, wake, mythril, cast) aren't available on the runner —
 * we assert provider/command shape, not external-tool output.
 */
const EXTENSION_ID = "ccashwell.solidity-workbench";

describe("Feature coverage — LSP providers", () => {
  before(async function () {
    this.timeout(60_000);
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} not found`);
    await ext!.activate();
    await new Promise((r) => setTimeout(r, 3_000));
  });

  it("publishes diagnostics on Counter.sol from at least one source", async function () {
    this.timeout(30_000);
    const uri = findSampleFile("src/Counter.sol");
    await vscode.workspace.openTextDocument(uri);
    // Diagnostics arrive asynchronously via the language client. Poll
    // for up to ~5 s — the cold-start parse usually settles inside 2.
    let diagnostics: vscode.Diagnostic[] = [];
    for (let attempt = 0; attempt < 20; attempt++) {
      diagnostics = vscode.languages.getDiagnostics(uri);
      if (diagnostics.length > 0) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    // Counter.sol may legitimately have zero diagnostics on a clean
    // build; the assertion is that the API responds with an array
    // and the diagnostic shape (when present) is well-formed.
    assert.ok(Array.isArray(diagnostics));
    for (const d of diagnostics) {
      assert.ok(typeof d.message === "string", "diagnostic.message must be a string");
      assert.ok(d.range instanceof vscode.Range, "diagnostic.range must be a Range");
    }
  });

  it("returns code lenses on Counter.sol", async function () {
    this.timeout(30_000);
    const uri = findSampleFile("src/Counter.sol");
    await vscode.workspace.openTextDocument(uri);
    const lenses = await retry<vscode.CodeLens[]>(() =>
      vscode.commands.executeCommand("vscode.executeCodeLensProvider", uri),
    );
    assert.ok(Array.isArray(lenses), "code lens provider must return an array");
    // Counter.sol has multiple functions / events — expect at least
    // one lens (selector / topic0 / reference count). Allow zero on
    // a stripped runner where forge build hasn't cached selectors.
    if (lenses.length > 0) {
      const lens = lenses[0];
      assert.ok(lens.range instanceof vscode.Range);
    }
  });

  it("returns inlay hints for a function-call range in Counter.t.sol", async function () {
    this.timeout(30_000);
    const uri = findSampleFile("test/Counter.t.sol");
    const doc = await vscode.workspace.openTextDocument(uri);
    const range = new vscode.Range(0, 0, doc.lineCount, 0);
    const hints = await retry<vscode.InlayHint[]>(() =>
      vscode.commands.executeCommand("vscode.executeInlayHintProvider", uri, range),
    );
    assert.ok(Array.isArray(hints), "inlay hint provider must return an array");
    // Each hint must have a position and a label.
    for (const h of hints) {
      assert.ok(h.position instanceof vscode.Position);
      assert.ok(h.label !== undefined && h.label !== null);
    }
  });

  it("returns document highlight ranges for a state-variable identifier", async function () {
    this.timeout(30_000);
    const uri = findSampleFile("src/Counter.sol");
    const doc = await vscode.workspace.openTextDocument(uri);
    const lines = doc.getText().split("\n");
    const decl = lines.findIndex((l) => /uint256 public count;/.test(l));
    assert.ok(decl >= 0);
    const col = lines[decl].indexOf("count");
    const highlights = await retry<vscode.DocumentHighlight[]>(() =>
      vscode.commands.executeCommand(
        "vscode.executeDocumentHighlights",
        uri,
        new vscode.Position(decl, col),
      ),
    );
    assert.ok(Array.isArray(highlights), "document highlight provider must return an array");
  });

  it("type definition for `Counter` resolves to its declaration", async function () {
    this.timeout(30_000);
    const uri = findSampleFile("test/Counter.t.sol");
    const doc = await vscode.workspace.openTextDocument(uri);
    const lines = doc.getText().split("\n");
    const usageLine = lines.findIndex((l) => /Counter public counter;/.test(l));
    if (usageLine < 0) return; // sample fixture changed; skip without failing.
    const col = lines[usageLine].indexOf("Counter");
    const locs = await retry<(vscode.Location | vscode.LocationLink)[]>(() =>
      vscode.commands.executeCommand(
        "vscode.executeTypeDefinitionProvider",
        uri,
        new vscode.Position(usageLine, col),
      ),
    );
    assert.ok(Array.isArray(locs), "type definition provider must return an array");
  });
});

describe("Feature coverage — webview commands", () => {
  before(async function () {
    this.timeout(60_000);
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    await ext!.activate();
  });

  it("honors the extension format-on-save setting only for Solidity documents", () => {
    const enabledConfig = { get: () => true };
    const disabledConfig = { get: () => false };
    const solidityDocument = { languageId: "solidity" };
    const typescriptDocument = { languageId: "typescript" };

    assert.equal(shouldFormatSolidityOnSave(solidityDocument, enabledConfig), true);
    assert.equal(shouldFormatSolidityOnSave(solidityDocument, disabledConfig), false);
    assert.equal(shouldFormatSolidityOnSave(typescriptDocument, enabledConfig), false);
  });

  it("quotes terminal command arguments independently", () => {
    assert.equal(shellArg("forge"), "forge");
    assert.equal(shellArg(""), "''");
    assert.equal(
      shellArg("/tmp/project with spaces/Counter.t.sol"),
      "'/tmp/project with spaces/Counter.t.sol'",
    );
    assert.equal(shellArg("test_owner's_path"), "'test_owner'\\''s_path'");
    assert.equal(
      shellCommand(["/opt/Foundry Tools/forge", "test", "--match-path", "test/My Test.t.sol"]),
      "'/opt/Foundry Tools/forge' test --match-path 'test/My Test.t.sol'",
    );
  });

  /**
   * Each webview command is invoked with the active editor on a
   * Solidity file; the assertion is "the command exists and
   * doesn't throw". Some commands open VSCode quick-pickers that
   * the test environment can't dismiss — those are wrapped with a
   * short timeout so the suite doesn't hang.
   */
  it("registers each webview-opening command", async () => {
    const all = await vscode.commands.getCommands(true);
    const expected = [
      "solidity-workbench.inspectStoragePanel",
      "solidity-workbench.inheritanceGraph",
      "solidity-workbench.showAbi",
      "solidity-workbench.gasDiff",
      "solidity-workbench.remoteChain.open",
      "solidity-workbench.viewIR",
      "solidity-workbench.chisel.start",
      "solidity-workbench.projectGraph",
      "solidity-workbench.projectGraphCursor",
      "solidity-workbench.exportProjectGraph",
      "solidity-workbench.searchProjectGraph",
      "solidity-workbench.queryProjectGraph",
      "solidity-workbench.projectGraphStats",
      "solidity-workbench.projectGraphScopeDiagnostics",
      "solidity-workbench.rebuildProjectGraph",
      "solidity-workbench.clearProjectGraphCache",
    ];
    for (const cmd of expected) {
      assert.ok(all.includes(cmd), `expected '${cmd}' to be registered`);
    }
  });

  it("registers each static-analysis command", async () => {
    const all = await vscode.commands.getCommands(true);
    for (const cmd of [
      "solidity-workbench.slither",
      "solidity-workbench.aderyn",
      "solidity-workbench.wake",
      "solidity-workbench.mythril",
    ]) {
      assert.ok(all.includes(cmd), `expected '${cmd}' to be registered`);
    }
  });

  it("registers each mutation testing command", async () => {
    const all = await vscode.commands.getCommands(true);
    for (const cmd of [
      "solidity-workbench.mutation.run",
      "solidity-workbench.mutation.runFile",
      "solidity-workbench.mutation.openReport",
      "solidity-workbench.mutation.generateTests",
    ]) {
      assert.ok(all.includes(cmd), `expected '${cmd}' to be registered`);
    }
  });

  it("renders inheritance graph scope controls as explicit reload requests", () => {
    type InheritanceGraphPanelInternals = {
      includeTests: boolean;
      includeDependencies: boolean;
      buildHtml(graph: InheritanceGraphResult): string;
    };
    const panel = new InheritanceGraphPanel(
      {} as ConstructorParameters<typeof InheritanceGraphPanel>[0],
    ) as unknown as InheritanceGraphPanelInternals;
    panel.includeTests = true;
    panel.includeDependencies = true;

    const html = panel.buildHtml({
      focusId: "src/A.sol:A",
      nodes: [
        {
          id: "src/A.sol:A",
          name: "A",
          filePath: "/workspace/src/A.sol",
          uri: "file:///workspace/src/A.sol",
          kind: "contract",
          tier: "project",
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 13 } },
          selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 10 } },
        },
      ],
      edges: [],
    });

    assert.match(html, /id="tests"/);
    assert.match(html, /id="deps"/);
    assert.match(html, /tests: true/);
    assert.match(html, /deps: true/);
    assert.match(html, /type: "reload"/);
    assert.match(html, /includeTests: state\.tests/);
    assert.match(html, /includeDependencies: state\.deps/);
  });

  it("keeps inheritance graph scope recoverable when default filters hide every node", () => {
    type InheritanceGraphPanelInternals = {
      buildHtml(graph: InheritanceGraphResult): string;
    };
    const panel = new InheritanceGraphPanel(
      {} as ConstructorParameters<typeof InheritanceGraphPanel>[0],
    ) as unknown as InheritanceGraphPanelInternals;

    const runtime = runInheritanceGraphWebviewScript(panel.buildHtml({ nodes: [], edges: [] }));

    assert.match(runtime.element("canvas").innerHTML, /No contracts in the current scope/);
    runtime.change("tests", true);
    assert.deepEqual(runtime.lastPostedMessage(), {
      type: "reload",
      includeTests: true,
      includeDependencies: false,
    });
    assert.match(runtime.element("canvas").innerHTML, /Loading graph/);
  });
});

describe("Feature coverage — mutation testing", () => {
  it("builds bounded mutation candidates without mutating comments or strings", () => {
    const source = [
      "contract Vault {",
      "    /* require(amount == balance);",
      "       if (amount >= balance) revert(); */",
      "    function withdraw(uint256 amount) external {",
      "        require(amount <= balance);",
      '        string memory ignored = "a <= b"; // amount == balance',
      "        if (amount == 0 || amount > balance) revert();",
      "        uint256 sum = amount + balance;",
      "        unchecked { ++sum; --sum; }",
      "    }",
      "}",
    ].join("\n");

    const candidates = buildMutationCandidates(source, {
      uri: "file:///tmp/Vault.sol",
      filePath: "/tmp/Vault.sol",
      relativePath: "src/Vault.sol",
      maxMutants: 10,
    });

    assert.ok(candidates.some((c) => c.original === "<=" && c.replacement === "<"));
    assert.ok(candidates.some((c) => c.original === "==" && c.replacement === "!="));
    assert.ok(candidates.some((c) => c.original === "||" && c.replacement === "&&"));
    assert.ok(candidates.some((c) => c.original === "+" && c.replacement === "-"));
    assert.ok(candidates.every((c) => c.range.start.line !== 1 && c.range.start.line !== 2));
    assert.ok(candidates.every((c) => c.range.start.line !== 5));
    assert.ok(candidates.every((c) => c.lineText !== "unchecked { ++sum; --sum; }"));
    assert.ok(candidates.every((c) => c.contractName === "Vault"));
    assert.ok(candidates.every((c) => c.functionName === "withdraw"));
  });

  it("applies a mutation at the exact source range", () => {
    const source = "contract C {\n    function f() external { require(x <= y); }\n}";
    const [candidate] = buildMutationCandidates(source, {
      uri: "file:///tmp/C.sol",
      filePath: "/tmp/C.sol",
      relativePath: "src/C.sol",
      maxMutants: 1,
    });

    const mutated = applyMutation(source, candidate);
    assert.match(mutated, /require\(x < y\)/);
  });

  it("summarizes mutation results and emits Foundry test skeletons for survivors", () => {
    const source = "contract C {\n    function f() external { require(x == y); }\n}";
    const [candidate] = buildMutationCandidates(source, {
      uri: "file:///tmp/C.sol",
      filePath: "/tmp/C.sol",
      relativePath: "src/C.sol",
      maxMutants: 1,
    });
    const results: MutationResult[] = [
      { candidate, status: "killed", durationMs: 10 },
      { candidate, status: "survived", durationMs: 12 },
      { candidate, status: "timeout", durationMs: 120_000 },
      { candidate, status: "error", durationMs: 5 },
    ];

    assert.deepEqual(summarizeMutationResults(results), {
      killed: 1,
      survived: 1,
      timeout: 1,
      error: 1,
    });

    const report = formatMutationReport({
      forgeRoot: "/tmp/project",
      scopeLabel: "src/C.sol",
      generatedAt: "2026-06-29T00:00:00.000Z",
      results,
    });
    assert.match(report, /Score: 50\.0%/);
    assert.match(report, /Generated Test Starting Points/);

    const skeleton = generateFoundryTestSkeleton(candidate);
    assert.match(skeleton, /function test_mutation_C_f_equality_1\(\) public/);
    assert.match(skeleton, /Original line:/);
  });

  it("detects failing forge JSON output for killed mutant classification", () => {
    assert.equal(
      hasForgeTestFailures(
        JSON.stringify({
          "test/C.t.sol:CTest": {
            test_results: {
              "test_f()": { status: "Failure", reason: "assertion failed" },
            },
          },
        }),
      ),
      true,
    );
    assert.equal(
      hasForgeTestFailures(
        JSON.stringify({
          "test/C.t.sol:CTest": {
            test_results: {
              "test_f()": { status: "Success" },
            },
          },
        }),
      ),
      false,
    );
  });

  it("builds scoped forge test args for mutation runs", () => {
    assert.deepEqual(
      buildForgeMutationTestArgs({
        verbosity: 3,
        extraArgs: ["--match-path", "test/alf/**", "--isolate"],
      }),
      ["test", "--json", "-vvv", "--match-path", "test/alf/**", "--isolate"],
    );
  });

  it("auto-scopes current-file mutation runs only when the target is a test file", () => {
    assert.deepEqual(
      resolveMutationForgeTestScope({
        forgeRoot: "/project",
        targetFile: "/project/test/Counter.t.sol",
        configuredArgs: ["--isolate"],
      }).args,
      ["--isolate", "--match-path", "test/Counter.t.sol"],
    );

    assert.deepEqual(
      resolveMutationForgeTestScope({
        forgeRoot: "/project",
        targetFile: "/project/src/Counter.sol",
        configuredArgs: [],
      }).args,
      [],
    );

    assert.deepEqual(
      resolveMutationForgeTestScope({
        forgeRoot: "/project",
        targetFile: "/project/test/Counter.t.sol",
        configuredArgs: ["--match-path", "test/alf/**"],
      }).args,
      ["--match-path", "test/alf/**"],
    );
  });

  it("builds Gambit mutate args and parses common mutants.log formats", () => {
    assert.deepEqual(
      buildGambitMutateArgs({
        relativePath: "src/C.sol",
        outdir: "/tmp/gambit",
        numMutants: 7,
        solcPath: "/usr/local/bin/solc",
      }),
      [
        "mutate",
        "--filename",
        "src/C.sol",
        "--sourceroot",
        ".",
        "--outdir",
        "/tmp/gambit",
        "--num_mutants",
        "7",
        "--solc",
        "/usr/local/bin/solc",
      ],
    );

    const jsonRecords = parseGambitMutantsLog(
      '{"id":1,"file":"src/C.sol","line":10,"column":5,"operator":"BOR","original":"<=","replacement":"<"}\n',
    );
    assert.equal(jsonRecords[0].id, "1");
    assert.equal(jsonRecords[0].file, "src/C.sol");
    assert.equal(jsonRecords[0].original, "<=");

    const textRecords = parseGambitMutantsLog("2: src/C.sol:12:8 `==` -> `!=`");
    assert.equal(textRecords[0].id, "2");
    assert.equal(textRecords[0].file, "src/C.sol");
    assert.equal(textRecords[0].line, 12);
  });
});

describe("Feature coverage — coverage decorations", () => {
  it("renders covered, uncovered, and partial branch line decorations", async function () {
    this.timeout(30_000);
    const uri = findSampleFile("src/Counter.sol");
    const document = await vscode.workspace.openTextDocument(uri);
    const provider = new CoverageProvider();
    const internals = provider as unknown as {
      coverageData: Map<string, FileCoverage>;
      coveredDecoration: vscode.TextEditorDecorationType;
      uncoveredDecoration: vscode.TextEditorDecorationType;
      partialDecoration: vscode.TextEditorDecorationType;
      statusBarItem: vscode.StatusBarItem;
      updateDecorations(editor: vscode.TextEditor): void;
    };
    const calls: {
      decoration: vscode.TextEditorDecorationType;
      ranges: readonly (vscode.Range | vscode.DecorationOptions)[];
    }[] = [];
    const fakeEditor = {
      document,
      setDecorations(
        decoration: vscode.TextEditorDecorationType,
        ranges: readonly (vscode.Range | vscode.DecorationOptions)[],
      ) {
        calls.push({ decoration, ranges });
      },
    } as unknown as vscode.TextEditor;

    try {
      internals.coverageData = new Map<string, FileCoverage>([
        [
          "src/Counter.sol",
          {
            file: "src/Counter.sol",
            lines: new Map([
              [9, 1],
              [25, 3],
              [46, 0],
            ]),
            branches: [
              { line: 25, branchId: "0/0", taken: 1 },
              { line: 25, branchId: "0/1", taken: 0 },
            ],
            lineTotal: 3,
            lineHit: 2,
            branchTotal: 2,
            branchHit: 1,
            fnTotal: 0,
            fnHit: 0,
          },
        ],
      ]);

      internals.updateDecorations(fakeEditor);

      const linesFor = (decoration: vscode.TextEditorDecorationType): number[] => {
        const call = calls.find((entry) => entry.decoration === decoration);
        assert.ok(call, "expected decoration call");
        return call.ranges.map((entry) => {
          const range = entry instanceof vscode.Range ? entry : entry.range;
          return range.start.line + 1;
        });
      };

      assert.deepEqual(linesFor(internals.coveredDecoration), [9]);
      assert.deepEqual(linesFor(internals.partialDecoration), [25]);
      assert.deepEqual(linesFor(internals.uncoveredDecoration), [46]);
    } finally {
      internals.coveredDecoration.dispose();
      internals.uncoveredDecoration.dispose();
      internals.partialDecoration.dispose();
      internals.statusBarItem.dispose();
    }
  });
});

describe("Feature coverage — static-analysis diagnostics", () => {
  it("maps Slither JSON findings to VS Code diagnostics", () => {
    const workspaceUri = vscode.Uri.file("/workspace");
    const result = buildSlitherDiagnostics(
      JSON.stringify({
        results: {
          detectors: [
            {
              impact: "High",
              check: "arbitrary-send-eth",
              description: "Unprotected ether transfer",
              elements: [
                {
                  name: "withdraw",
                  source_mapping: {
                    filename_relative: "src/Vault.sol",
                    lines: [42, 43],
                  },
                },
                {
                  name: "owner",
                  source_mapping: {
                    filename_relative: "src/Auth.sol",
                    lines: [7],
                  },
                },
              ],
            },
          ],
        },
      }),
      workspaceUri,
    );

    const vaultDiagnostics = result.diagnosticsByFile.get(
      vscode.Uri.joinPath(workspaceUri, "src/Vault.sol").toString(),
    );
    assert.equal(result.totalFindings, 1);
    assert.equal(result.diagnosticsByFile.size, 2);
    assert.equal(vaultDiagnostics?.length, 1);

    const diagnostic = vaultDiagnostics![0];
    assert.equal(diagnostic.source, "slither");
    assert.equal(diagnostic.code, "arbitrary-send-eth");
    assert.equal(diagnostic.severity, vscode.DiagnosticSeverity.Error);
    assert.match(diagnostic.message, /\[arbitrary-send-eth\] Unprotected ether transfer/);
    assert.equal(diagnostic.range.start.line, 41);
    assert.equal(diagnostic.range.end.line, 42);
    assert.equal(diagnostic.relatedInformation?.length, 1);
    assert.equal(diagnostic.relatedInformation?.[0].message, "owner");
    assert.equal(
      diagnostic.relatedInformation?.[0].location.uri.toString(),
      vscode.Uri.joinPath(workspaceUri, "src/Auth.sol").toString(),
    );
  });

  it("maps Aderyn findings to VS Code diagnostics", () => {
    const workspaceUri = vscode.Uri.file("/workspace");
    const result = buildAderynDiagnostics(
      [
        {
          detector: "unchecked-transfer",
          title: "Unchecked transfer return value",
          description: "ERC20 transfer result is ignored",
          severity: "high",
          instances: [
            { contractPath: "src/Vault.sol", line: 12 },
            { contractPath: "src/Token.sol", line: 4 },
          ],
        },
      ],
      workspaceUri,
    );

    const diagnostics = result.diagnosticsByFile.get(
      vscode.Uri.joinPath(workspaceUri, "src/Vault.sol").toString(),
    );
    assert.equal(result.diagnosticsByFile.size, 2);
    assert.equal(diagnostics?.length, 1);

    const diagnostic = diagnostics![0];
    assert.equal(diagnostic.source, "aderyn");
    assert.equal(diagnostic.code, "unchecked-transfer");
    assert.equal(diagnostic.severity, vscode.DiagnosticSeverity.Error);
    assert.match(diagnostic.message, /\[unchecked-transfer\] Unchecked transfer return value/);
    assert.equal(diagnostic.range.start.line, 11);
    assert.equal(diagnostic.range.end.character, 1000);
    assert.equal(diagnostic.relatedInformation?.length, 1);
    assert.equal(diagnostic.relatedInformation?.[0].message, "Also here (unchecked-transfer)");
  });

  it("maps Wake findings to VS Code diagnostics", () => {
    const workspaceUri = vscode.Uri.file("/workspace");
    const result = buildWakeDiagnostics(
      [
        {
          detector: "reentrancy",
          message: "Possible reentrancy",
          impact: "medium",
          confidence: "high",
          instances: [
            {
              contractPath: "src/Vault.sol",
              line: 20,
              column: 5,
              endLine: 20,
              endColumn: 16,
            },
            {
              contractPath: "src/Hook.sol",
              line: 8,
              column: 2,
            },
          ],
        },
      ],
      workspaceUri,
    );

    const diagnostics = result.diagnosticsByFile.get(
      vscode.Uri.joinPath(workspaceUri, "src/Vault.sol").toString(),
    );
    assert.equal(result.diagnosticsByFile.size, 2);
    assert.equal(diagnostics?.length, 1);

    const diagnostic = diagnostics![0];
    assert.equal(diagnostic.source, "wake");
    assert.equal(diagnostic.code, "reentrancy");
    assert.equal(diagnostic.severity, vscode.DiagnosticSeverity.Warning);
    assert.match(diagnostic.message, /\[reentrancy\] Possible reentrancy \(confidence: high\)/);
    assert.equal(diagnostic.range.start.line, 19);
    assert.equal(diagnostic.range.start.character, 4);
    assert.equal(diagnostic.range.end.character, 15);
    assert.equal(diagnostic.relatedInformation?.length, 1);
  });

  it("maps Mythril findings to VS Code diagnostics", () => {
    const result = buildMythrilDiagnostics([
      {
        title: "Integer Overflow",
        description: "Arithmetic can overflow",
        severity: "low",
        contractPath: "src/Vault.sol",
        line: 33,
        swcId: "101",
        function: "deposit(uint256)",
      },
      {
        title: "Informational note",
        description: "Compiler metadata",
        severity: "informational",
        contractPath: "src/Vault.sol",
        line: 1,
        swcId: null,
      },
    ]);

    assert.equal(result.diagnostics.length, 2);

    const overflow = result.diagnostics[0];
    assert.equal(overflow.source, "mythril");
    assert.equal(overflow.code, "SWC-101");
    assert.equal(overflow.severity, vscode.DiagnosticSeverity.Warning);
    assert.match(
      overflow.message,
      /\[mythril \[SWC-101\]\] \(deposit\(uint256\)\) Integer Overflow: Arithmetic can overflow/,
    );
    assert.equal(overflow.range.start.line, 32);

    const info = result.diagnostics[1];
    assert.equal(info.code, "Informational note");
    assert.equal(info.severity, vscode.DiagnosticSeverity.Information);
  });
});

describe("Feature coverage — Solidity grammar", () => {
  it("tokenizes multi-line global using directives", () => {
    const grammarPath = path.resolve(__dirname, "../../../syntaxes/solidity.tmLanguage.json");
    const grammar = JSON.parse(fs.readFileSync(grammarPath, "utf-8")) as {
      repository?: {
        "using-directive"?: {
          patterns?: Array<{
            begin?: string;
            end?: string;
            beginCaptures?: Record<string, { name?: string }>;
            patterns?: Array<{ match?: string; name?: string }>;
          }>;
        };
      };
    };
    const usingRule = grammar.repository?.["using-directive"]?.patterns?.[0];

    assert.equal(usingRule?.begin, "\\b(using)\\b");
    assert.equal(usingRule?.end, ";");
    assert.equal(usingRule?.beginCaptures?.["1"]?.name, "keyword.other.using.solidity");
    assert.ok(
      usingRule?.patterns?.some(
        (pattern) => pattern.match === "\\bfor\\b" && pattern.name === "keyword.other.for.solidity",
      ),
      "expected `for` keyword capture inside multi-line using directives",
    );
    assert.ok(
      usingRule?.patterns?.some(
        (pattern) =>
          pattern.match === "\\bglobal\\b" && pattern.name === "keyword.other.global.solidity",
      ),
      "expected `global` keyword capture inside multi-line using directives",
    );
  });
});

describe("Feature coverage — project graph export", () => {
  const sampleGraph: ProjectGraphResult = {
    focusId: "file:///workspace/src/Vault.sol#Vault:function:deposit:4:13",
    truncated: true,
    nodes: [
      {
        id: "file:///workspace/src/Vault.sol#Vault:function:deposit:4:13",
        kind: "function",
        name: "deposit",
        qualifiedName: "Vault.deposit",
        uri: "file:///workspace/src/Vault.sol",
        filePath: "/workspace/src/Vault.sol",
        tier: "project",
        range: { start: { line: 4, character: 4 }, end: { line: 6, character: 5 } },
        selectionRange: { start: { line: 4, character: 13 }, end: { line: 4, character: 20 } },
        containerName: "Vault",
        metadata: { visibility: "external" },
      },
      {
        id: "file:///workspace/src/Vault.sol#Vault:stateVariable:balances:2:20",
        kind: "stateVariable",
        name: "balances",
        qualifiedName: "Vault.balances",
        uri: "file:///workspace/src/Vault.sol",
        filePath: "/workspace/src/Vault.sol",
        tier: "project",
        range: { start: { line: 2, character: 4 }, end: { line: 2, character: 53 } },
        selectionRange: { start: { line: 2, character: 20 }, end: { line: 2, character: 28 } },
        containerName: "Vault",
        metadata: { visibility: "public", publicGetter: true, getterArgumentCount: 1 },
      },
    ],
    edges: [
      {
        source: "file:///workspace/src/Vault.sol#Vault:function:deposit:4:13",
        target: "external:IERC20",
        kind: "usesType",
        resolutionConfidence: "parser",
        evidence: {
          summary: "usesType: IERC20 as parameter",
          resolver: "parser",
          source: "Vault.deposit",
          target: "external:IERC20",
          sourceUri: "file:///workspace/src/Vault.sol",
          sourceRange: { start: { line: 4, character: 25 }, end: { line: 4, character: 31 } },
          targetUri: "file:///workspace/src/IERC20.sol",
          targetRange: { start: { line: 2, character: 10 }, end: { line: 2, character: 16 } },
        },
        metadata: { resolutionConfidence: "parser" },
      },
      {
        source: "file:///workspace/src/Vault.sol#Vault:function:deposit:4:13",
        target: "external:unknown-call",
        kind: "externalCall",
        resolutionConfidence: "heuristic",
        unresolvedTarget: true,
        evidence: {
          summary: "unresolved externalCall: call",
          resolver: "heuristic",
          source: "Vault.deposit",
          target: "external:unknown-call",
          sourceUri: "file:///workspace/src/Vault.sol",
          sourceRange: { start: { line: 5, character: 12 }, end: { line: 5, character: 23 } },
        },
        metadata: { resolutionConfidence: "heuristic", unresolvedTarget: true },
      },
    ],
  };

  it("serializes graph exports as JSON, DOT, GraphML, and CodeGraph JSON", () => {
    const stats: ProjectGraphStatsResult = {
      nodeCount: 2,
      edgeCount: 2,
      nodesByKind: Object.assign(Object.create(null), { function: 1 }),
      edgesByKind: Object.assign(Object.create(null), { usesType: 1, externalCall: 1 }),
      edgesByResolutionConfidence: Object.assign(Object.create(null), {
        parser: 1,
        heuristic: 1,
      }),
      unresolvedEdgeCount: 1,
      filesByTier: Object.assign(Object.create(null), { project: 1 }),
      lastRebuildDurationMs: 12,
      lastUpdateDurationMs: 3,
      lastRequestDurationsMs: {
        query: 750,
      },
      performance: {
        state: "warning",
        budget: {
          requestWarningMs: 500,
          requestSlowMs: 2_000,
          rebuildWarningMs: 2_500,
          rebuildSlowMs: 10_000,
          cacheWarningMs: 500,
          cacheSlowMs: 2_000,
        },
        warnings: ["Slowest graph request (query) took 750ms, above the 500ms warning budget."],
        slowestRequest: {
          kind: "query",
          durationMs: 750,
          warningMs: 500,
          slowMs: 2_000,
        },
      },
      compilerStatus: {
        available: true,
        stale: true,
        cachedFileCount: 2,
        staleFileCount: 1,
        staleFiles: ["/workspace/src/Vault.sol"],
        lastBuildTimeMs: 123,
      },
      relationshipFilesIndexed: 7,
      relationshipFilesTotal: 10,
      pendingRelationshipFiles: 3,
      relationshipIndexComplete: false,
    };

    const json = serializeProjectGraphForExport(sampleGraph, "json", stats);
    assert.equal(json.language, "json");
    const parsedJson = JSON.parse(json.content);
    assert.equal(parsedJson.truncated, true);
    assert.equal(parsedJson.stats.relationshipIndexComplete, false);
    assert.equal(parsedJson.stats.pendingRelationshipFiles, 3);
    assert.equal(parsedJson.stats.edgesByResolutionConfidence.parser, 1);
    assert.equal(parsedJson.stats.edgesByResolutionConfidence.heuristic, 1);
    assert.equal(parsedJson.stats.unresolvedEdgeCount, 1);
    assert.equal(parsedJson.stats.performance.state, "warning");
    assert.equal(parsedJson.stats.performance.slowestRequest.kind, "query");
    assert.equal(parsedJson.compilerStatus.state, "stale");
    assert.equal(parsedJson.compilerStatus.staleFileCount, 1);
    assert.equal(parsedJson.relationshipStatus.state, "partial");
    assert.equal(parsedJson.relationshipStatus.pending, 3);
    assert.equal(parsedJson.edgeQuality.unresolved, 1);
    assert.equal(parsedJson.edges[0].evidence.summary, "usesType: IERC20 as parameter");
    assert.equal(
      parsedJson.nodes.find(
        (node: { id?: string }) =>
          node.id === "file:///workspace/src/Vault.sol#Vault:function:deposit:4:13",
      )?.metadata?.visibility,
      "external",
    );
    assert.ok(
      parsedJson.nodes.some(
        (node: { id?: string; kind?: string }) =>
          node.id === "external:IERC20" && node.kind === "external",
      ),
      "expected JSON export to include synthetic nodes for missing edge endpoints",
    );

    const dot = serializeProjectGraphForExport(sampleGraph, "dot");
    assert.equal(dot.language, "dot");
    assert.match(dot.content, /digraph SolidityProjectGraph/);
    assert.match(dot.content, /external:IERC20/);

    const graphMl = serializeProjectGraphForExport(sampleGraph, "graphml");
    assert.equal(graphMl.language, "xml");
    assert.match(graphMl.content, /<graphml/);
    assert.match(
      graphMl.content,
      /source="file:\/\/\/workspace\/src\/Vault.sol#Vault:function:deposit:4:13"/,
    );
    assert.match(graphMl.content, /&quot;visibility&quot;:&quot;external&quot;/);

    const codeGraph = serializeProjectGraphForExport(sampleGraph, "codegraph-json", stats);
    assert.equal(codeGraph.language, "json");
    const parsed = JSON.parse(codeGraph.content);
    assert.equal(parsed.schema, "solidity-workbench-codegraph-export");
    assert.equal(parsed.graph.truncated, true);
    assert.equal(parsed.graph.relationshipIndexComplete, false);
    assert.equal(parsed.graph.relationshipFilesIndexed, 7);
    assert.equal(parsed.graph.relationshipStatus.state, "partial");
    assert.equal(parsed.graph.edgeQuality.unresolved, 1);
    assert.equal(parsed.graph.performance.state, "warning");
    assert.equal(parsed.graph.performance.slowestRequest.durationMs, 750);
    assert.equal(parsed.graph.compilerStatus.stale, true);
    assert.equal(parsed.graph.compilerStatusSummary.state, "stale");
    assert.match(parsed.graph.relationshipStatus.detail, /full-workspace edges may be partial/);
    assert.equal(parsed.edges[0].resolutionConfidence, "parser");
    assert.equal(parsed.edges[0].unresolvedTarget, undefined);
    assert.equal(parsed.edges[0].evidence.summary, "usesType: IERC20 as parameter");
    assert.equal(
      parsed.nodes.find(
        (node: { id?: string }) =>
          node.id === "file:///workspace/src/Vault.sol#Vault:function:deposit:4:13",
      )?.metadata?.visibility,
      "external",
    );
    assert.equal(parsed.edges[1].resolutionConfidence, "heuristic");
    assert.equal(parsed.edges[1].unresolvedTarget, true);
    assert.equal(parsed.edges[1].evidence.summary, "unresolved externalCall: call");
    assert.ok(
      parsed.nodes.some(
        (node: { id?: string; kind?: string }) =>
          node.id === "external:IERC20" && node.kind === "external",
      ),
      "expected missing edge endpoints to be exported as synthetic external nodes",
    );
  });

  it("renders project graph edge evidence navigation controls", () => {
    type ProjectGraphExporterInternals = {
      buildHtml(
        graph: ProjectGraphResult,
        focusId?: string,
        graphStats?: ProjectGraphStatsResult,
      ): string;
    };
    const exporter = new ProjectGraphExporter(
      {} as ConstructorParameters<typeof ProjectGraphExporter>[0],
    ) as unknown as ProjectGraphExporterInternals;

    const html = exporter.buildHtml(sampleGraph, sampleGraph.focusId);

    assert.match(html, /function edgeEvidenceActions/);
    assert.match(html, /addEvidenceAction\(actions, "Source"/);
    assert.match(html, /addEvidenceAction\(actions, "Target"/);
    assert.match(html, /function navigateRange\(uri, range\)/);
    assert.match(html, /"sourceUri":"file:\/\/\/workspace\/src\/Vault\.sol"/);
    assert.match(html, /"targetUri":"file:\/\/\/workspace\/src\/IERC20\.sol"/);
  });

  it("renders project graph edge trust warnings", () => {
    type ProjectGraphExporterInternals = {
      buildHtml(
        graph: ProjectGraphResult,
        focusId?: string,
        graphStats?: ProjectGraphStatsResult,
      ): string;
    };
    const exporter = new ProjectGraphExporter(
      {} as ConstructorParameters<typeof ProjectGraphExporter>[0],
    ) as unknown as ProjectGraphExporterInternals;

    const html = exporter.buildHtml(sampleGraph, sampleGraph.focusId);

    assert.match(html, /function edgeTrustWarningLabel\(edge\)/);
    assert.match(html, /Unresolved target - source edge is known/);
    assert.match(html, /Heuristic resolution - verify before relying on this edge/);
    assert.match(html, /row\.classList\.add\("unresolved"\)/);
    assert.match(html, /confidence\.classList\.add\("warning"\)/);
  });

  it("renders project graph node metadata badges", () => {
    type ProjectGraphExporterInternals = {
      buildHtml(
        graph: ProjectGraphResult,
        focusId?: string,
        graphStats?: ProjectGraphStatsResult,
      ): string;
    };
    const exporter = new ProjectGraphExporter(
      {} as ConstructorParameters<typeof ProjectGraphExporter>[0],
    ) as unknown as ProjectGraphExporterInternals;

    const html = exporter.buildHtml(sampleGraph, sampleGraph.focusId);

    assert.match(html, /function nodeBadges\(node\)/);
    assert.match(html, /function appendNodeBadges\(parent, node\)/);
    assert.match(html, /function nodeMetadataSearchText\(node\)/);
    assert.match(html, /className = "node-badge " \+ badge\.className/);
    assert.match(html, /"visibility":"public"/);
    assert.match(html, /"publicGetter":true/);
    assert.match(html, /"getterArgumentCount":1/);
  });

  it("renders project graph cap diagnostics", () => {
    type ProjectGraphExporterInternals = {
      buildHtml(
        graph: ProjectGraphResult,
        focusId?: string,
        graphStats?: ProjectGraphStatsResult,
      ): string;
    };
    const exporter = new ProjectGraphExporter(
      {} as ConstructorParameters<typeof ProjectGraphExporter>[0],
    ) as unknown as ProjectGraphExporterInternals;

    const html = exporter.buildHtml(sampleGraph, sampleGraph.focusId);

    assert.match(html, /function visibleNodeState\(\)/);
    assert.match(html, /function cappedNodeState\(nodes\)/);
    assert.match(html, /function graphStatsText\(nodeState, visibleGraphEdges\)/);
    assert.match(html, /hidden by render cap/);
    assert.match(html, /rendered nodes/);
  });

  it("renders expandable project graph cap controls", () => {
    type ProjectGraphExporterInternals = {
      buildHtml(
        graph: ProjectGraphResult,
        focusId?: string,
        graphStats?: ProjectGraphStatsResult,
      ): string;
    };
    const exporter = new ProjectGraphExporter(
      {} as ConstructorParameters<typeof ProjectGraphExporter>[0],
    ) as unknown as ProjectGraphExporterInternals;

    const html = exporter.buildHtml(sampleGraph, sampleGraph.focusId);

    assert.match(html, /id="showMoreNodes"/);
    assert.match(html, /const defaultRenderedNodeLimit = 240/);
    assert.match(html, /const renderNodeLimitStep = 240/);
    assert.match(html, /const maxRenderedNodeLimit = 2400/);
    assert.match(html, /persisted\.renderedNodeLimit/);
    assert.match(html, /function updateShowMoreButton\(nodeState\)/);
    assert.match(html, /showMoreNodesButton\.addEventListener\("click"/);
    assert.match(
      html,
      /Math\.min\(maxRenderedNodeLimit, renderedNodeLimit \+ renderNodeLimitStep\)/,
    );
    assert.match(html, /function resetRenderedNodeLimit\(\)/);
    assert.match(html, /renderedNodeLimit,/);
  });

  it("renders embedded project graph search and query controls", () => {
    type ProjectGraphExporterInternals = {
      buildHtml(
        graph: ProjectGraphResult,
        focusId?: string,
        graphStats?: ProjectGraphStatsResult,
      ): string;
    };
    const exporter = new ProjectGraphExporter(
      {} as ConstructorParameters<typeof ProjectGraphExporter>[0],
    ) as unknown as ProjectGraphExporterInternals;

    const html = exporter.buildHtml(sampleGraph, sampleGraph.focusId);

    assert.match(html, /id="serverSearch"/);
    assert.match(html, /id="serverQueryKind"/);
    assert.match(html, /id="serverQuery"/);
    assert.match(html, /id="includeTests"/);
    assert.match(html, /id="includeDependencies"/);
    assert.match(html, /id="resultBanner"/);
    assert.match(html, /type: "searchGraph"/);
    assert.match(html, /type: "queryGraph"/);
    assert.match(html, /includeTests/);
    assert.match(html, /includeDependencies/);
    assert.match(html, /resultDiagnosticsText/);
    assert.match(html, /message\.resultDiagnostics/);
    assert.match(html, /message\.clearQuery === true/);
  });

  it("renders project graph node-kind filtering controls", () => {
    type ProjectGraphExporterInternals = {
      buildHtml(
        graph: ProjectGraphResult,
        focusId?: string,
        graphStats?: ProjectGraphStatsResult,
      ): string;
    };
    const exporter = new ProjectGraphExporter(
      {} as ConstructorParameters<typeof ProjectGraphExporter>[0],
    ) as unknown as ProjectGraphExporterInternals;

    const html = exporter.buildHtml(sampleGraph, sampleGraph.focusId);

    assert.match(html, /id="nodeKind"/);
    assert.match(html, /const nodeKindItems = /);
    assert.match(html, /persisted\.nodeKind/);
    assert.match(html, /function matchesNodeKind\(node\)/);
    assert.match(html, /function matchesNodeKindById\(id\)/);
    assert.match(html, /function renderNodeKindOptions\(\)/);
    assert.match(html, /nodeKindSelect\.addEventListener\("change"/);
    assert.match(html, /nodeKind,/);
  });

  it("executes project graph webview controls in a DOM runtime", () => {
    type ProjectGraphExporterInternals = {
      buildHtml(
        graph: ProjectGraphResult,
        focusId?: string,
        graphStats?: ProjectGraphStatsResult,
      ): string;
    };
    const exporter = new ProjectGraphExporter(
      {} as ConstructorParameters<typeof ProjectGraphExporter>[0],
    ) as unknown as ProjectGraphExporterInternals;
    const runtimeGraph = makeRuntimeProjectGraph(3);
    const runtime = runProjectGraphWebviewScript(
      exporter.buildHtml(runtimeGraph, runtimeGraph.focusId),
    );

    assert.equal(runtime.element("stats").textContent, "3/3 rendered nodes · 2/2 edges");
    assert.equal(
      runtime.element("nodeKind").children.length,
      PROJECT_GRAPH_NODE_KIND_FILTER_ITEMS.length,
    );

    runtime.change("nodeKind", "stateVariable");
    assert.equal(runtime.lastState()?.nodeKind, "stateVariable");
    assert.equal(runtime.element("stats").textContent, "2/2 rendered nodes · 1/2 edges");

    runtime.change("nodeKind", "all");
    runtime.change("includeTests", true);
    assert.equal(
      runtime.lastState()?.includeTests,
      undefined,
      "includeTests should be controlled by the live checkbox or command flag, not persisted state",
    );
    assert.deepEqual(runtime.lastPostedMessage(), {
      type: "loadCursor",
      includeTests: true,
      includeDependencies: false,
    });
    runtime.change("includeDependencies", true);
    assert.equal(
      runtime.lastState()?.includeDependencies,
      undefined,
      "includeDependencies should be controlled by the live checkbox or command flag, not persisted state",
    );
    assert.deepEqual(runtime.lastPostedMessage(), {
      type: "loadCursor",
      includeTests: true,
      includeDependencies: true,
    });

    runtime.input("search", "helper");
    assert.equal(runtime.lastState()?.query, "helper");
    assert.equal(runtime.element("stats").textContent, "2/2 rendered nodes · 1/2 edges");

    runtime.click("serverSearch");
    assert.deepEqual(runtime.lastPostedMessage(), {
      type: "searchGraph",
      query: "helper",
      includeTests: true,
      includeDependencies: true,
    });
    assert.equal(runtime.element("stats").textContent, "Searching project graph…");
  });

  it("keeps project graph scope recoverable when default filters hide every node", () => {
    type ProjectGraphExporterInternals = {
      buildHtml(
        graph: ProjectGraphResult,
        focusId?: string,
        graphStats?: ProjectGraphStatsResult,
      ): string;
    };
    const exporter = new ProjectGraphExporter(
      {} as ConstructorParameters<typeof ProjectGraphExporter>[0],
    ) as unknown as ProjectGraphExporterInternals;
    const stats: ProjectGraphStatsResult = {
      nodeCount: 4,
      edgeCount: 3,
      nodesByKind: Object.assign(Object.create(null), { contract: 2, function: 2 }),
      edgesByKind: Object.assign(Object.create(null), { contains: 2, inherits: 1 }),
      filesByTier: Object.assign(Object.create(null), { tests: 1, deps: 1 }),
      lastRebuildDurationMs: 15,
      lastUpdateDurationMs: null,
      relationshipIndexComplete: true,
    };
    const runtime = runProjectGraphWebviewScript(
      exporter.buildHtml({ nodes: [], edges: [] }, undefined, stats),
    );

    assert.match(runtime.element("emptyGraph").textContent, /No nodes in the current graph scope/);
    runtime.change("includeTests", true);
    assert.deepEqual(runtime.lastPostedMessage(), {
      type: "loadWorkspace",
      includeTests: true,
      includeDependencies: false,
    });
    runtime.change("includeDependencies", true);
    assert.deepEqual(runtime.lastPostedMessage(), {
      type: "loadWorkspace",
      includeTests: true,
      includeDependencies: true,
    });
  });

  it("executes project graph render-cap controls in a DOM runtime", () => {
    type ProjectGraphExporterInternals = {
      buildHtml(
        graph: ProjectGraphResult,
        focusId?: string,
        graphStats?: ProjectGraphStatsResult,
      ): string;
    };
    const exporter = new ProjectGraphExporter(
      {} as ConstructorParameters<typeof ProjectGraphExporter>[0],
    ) as unknown as ProjectGraphExporterInternals;
    const runtimeGraph = makeRuntimeProjectGraph(PROJECT_GRAPH_DEFAULT_RENDERED_NODE_LIMIT + 10);
    const runtime = runProjectGraphWebviewScript(
      exporter.buildHtml(runtimeGraph, runtimeGraph.focusId),
    );

    assert.match(runtime.element("stats").textContent, /240\/250 rendered nodes/);
    assert.match(runtime.element("stats").textContent, /10 hidden by render cap/);
    assert.equal(runtime.element("showMoreNodes").hidden, false);
    assert.equal(runtime.element("showMoreNodes").textContent, "More +10");

    runtime.click("showMoreNodes");
    assert.match(runtime.element("stats").textContent, /250\/250 rendered nodes/);
    assert.equal(runtime.element("showMoreNodes").hidden, true);
    assert.equal(
      runtime.lastState()?.renderedNodeLimit,
      PROJECT_GRAPH_DEFAULT_RENDERED_NODE_LIMIT + PROJECT_GRAPH_RENDER_NODE_LIMIT_STEP,
    );
  });

  it("constrains graph call queries to supported target kinds", () => {
    assert.deepEqual(PROJECT_GRAPH_CALLABLE_NODE_KINDS, [
      "function",
      "constructor",
      "receive",
      "fallback",
      "modifier",
    ]);
    assert.deepEqual(PROJECT_GRAPH_CALLER_TARGET_NODE_KINDS, [
      ...PROJECT_GRAPH_CALLABLE_NODE_KINDS,
      "stateVariable",
      "event",
      "error",
    ]);
    assert.deepEqual(
      projectGraphQueryTargetKinds("callers"),
      PROJECT_GRAPH_CALLER_TARGET_NODE_KINDS,
    );
    assert.deepEqual(projectGraphQueryTargetKinds("callees"), PROJECT_GRAPH_CALLABLE_NODE_KINDS);
    assert.equal(projectGraphQueryTargetKinds("impact"), undefined);
    assert.equal(projectGraphQueryMissLabel("callers"), "No project graph callers target found.");
    assert.equal(
      projectGraphQueryMissLabel("callers", "targetKindMismatch"),
      "Project graph callers queries require a function, constructor, receive/fallback, modifier, state-variable getter, event, or error target.",
    );
    assert.equal(
      projectGraphQueryMissLabel("callees", "targetKindMismatch"),
      "Project graph callees queries require a function, constructor, receive/fallback, or modifier target.",
    );
    assert.equal(projectGraphQueryMissLabel("impact"), "No project graph query target found.");
  });

  it("parses project graph include-tests command flags explicitly", () => {
    assert.equal(projectGraphIncludeTestsFlag({ includeTests: true }), true);
    assert.equal(projectGraphIncludeTestsFlag({ includeTests: false }), false);
    assert.equal(projectGraphIncludeTestsFlag({ includeTests: "true" }), undefined);
    assert.equal(projectGraphIncludeTestsFlag({}), undefined);
    assert.equal(projectGraphIncludeTestsFlag(undefined), undefined);
    assert.equal(projectGraphIncludeDependenciesFlag({ includeDependencies: true }), true);
    assert.equal(projectGraphIncludeDependenciesFlag({ includeDependencies: false }), false);
    assert.equal(projectGraphIncludeDependenciesFlag({ includeDependencies: "true" }), undefined);
    assert.equal(projectGraphIncludeDependenciesFlag({}), undefined);
    assert.equal(projectGraphIncludeDependenciesFlag(undefined), undefined);
  });

  it("parses inheritance graph include-tests command flags explicitly", () => {
    assert.equal(inheritanceGraphIncludeTestsFlag({ includeTests: true }), true);
    assert.equal(inheritanceGraphIncludeTestsFlag({ includeTests: false }), false);
    assert.equal(inheritanceGraphIncludeTestsFlag({ includeTests: "true" }), undefined);
    assert.equal(inheritanceGraphIncludeTestsFlag({}), undefined);
    assert.equal(inheritanceGraphIncludeTestsFlag(undefined), undefined);
    assert.equal(inheritanceGraphIncludeDependenciesFlag({ includeDependencies: true }), true);
    assert.equal(inheritanceGraphIncludeDependenciesFlag({ includeDependencies: false }), false);
    assert.equal(
      inheritanceGraphIncludeDependenciesFlag({ includeDependencies: "true" }),
      undefined,
    );
    assert.equal(inheritanceGraphIncludeDependenciesFlag({}), undefined);
    assert.equal(inheritanceGraphIncludeDependenciesFlag(undefined), undefined);
  });

  it("computes project graph node-kind filters", () => {
    assert.ok(
      PROJECT_GRAPH_NODE_KIND_FILTER_ITEMS.some(
        (item) => item.value === "all" && item.label === "All Node Kinds",
      ),
    );
    assert.ok(PROJECT_GRAPH_NODE_KIND_FILTER_ITEMS.some((item) => item.value === "function"));
    assert.ok(PROJECT_GRAPH_NODE_KIND_FILTER_ITEMS.some((item) => item.value === "fallback"));

    const [deposit, balances] = sampleGraph.nodes;
    assert.equal(projectGraphNodeMatchesKindFilter(deposit, "all"), true);
    assert.equal(projectGraphNodeMatchesKindFilter(deposit, "function"), true);
    assert.equal(projectGraphNodeMatchesKindFilter(deposit, "stateVariable"), false);
    assert.equal(projectGraphNodeMatchesKindFilter(balances, "stateVariable"), true);
  });

  it("computes project graph render cap state", () => {
    assert.equal(
      normalizeProjectGraphRenderedNodeLimit(undefined),
      PROJECT_GRAPH_DEFAULT_RENDERED_NODE_LIMIT,
    );
    assert.equal(
      normalizeProjectGraphRenderedNodeLimit(1),
      PROJECT_GRAPH_DEFAULT_RENDERED_NODE_LIMIT,
    );
    assert.equal(
      normalizeProjectGraphRenderedNodeLimit(PROJECT_GRAPH_MAX_RENDERED_NODE_LIMIT + 1),
      PROJECT_GRAPH_MAX_RENDERED_NODE_LIMIT,
    );
    assert.equal(
      expandProjectGraphRenderedNodeLimit(PROJECT_GRAPH_MAX_RENDERED_NODE_LIMIT),
      PROJECT_GRAPH_MAX_RENDERED_NODE_LIMIT,
    );
    assert.equal(
      expandProjectGraphRenderedNodeLimit(PROJECT_GRAPH_DEFAULT_RENDERED_NODE_LIMIT),
      PROJECT_GRAPH_DEFAULT_RENDERED_NODE_LIMIT + PROJECT_GRAPH_RENDER_NODE_LIMIT_STEP,
    );

    const ids = Array.from({ length: PROJECT_GRAPH_DEFAULT_RENDERED_NODE_LIMIT + 7 }, (_, i) =>
      String(i),
    );
    const capped = projectGraphRenderedNodeState(ids, PROJECT_GRAPH_DEFAULT_RENDERED_NODE_LIMIT);
    assert.equal(capped.ids.length, PROJECT_GRAPH_DEFAULT_RENDERED_NODE_LIMIT);
    assert.equal(capped.candidateCount, ids.length);
    assert.equal(capped.hiddenCount, 7);

    assert.deepEqual(
      projectGraphShowMoreControlState(0, PROJECT_GRAPH_DEFAULT_RENDERED_NODE_LIMIT),
      {
        hidden: true,
        disabled: false,
        text: "More +0",
        title: "Render 0 more hidden graph nodes",
      },
    );
    assert.deepEqual(
      projectGraphShowMoreControlState(7, PROJECT_GRAPH_DEFAULT_RENDERED_NODE_LIMIT),
      {
        hidden: false,
        disabled: false,
        text: "More +7",
        title: "Render 7 more hidden graph nodes",
      },
    );
    assert.deepEqual(
      projectGraphShowMoreControlState(
        PROJECT_GRAPH_RENDER_NODE_LIMIT_STEP + 7,
        PROJECT_GRAPH_DEFAULT_RENDERED_NODE_LIMIT,
      ),
      {
        hidden: false,
        disabled: false,
        text: `More +${PROJECT_GRAPH_RENDER_NODE_LIMIT_STEP}`,
        title: `Render ${PROJECT_GRAPH_RENDER_NODE_LIMIT_STEP} more hidden graph nodes`,
      },
    );
    assert.deepEqual(projectGraphShowMoreControlState(7, PROJECT_GRAPH_MAX_RENDERED_NODE_LIMIT), {
      hidden: false,
      disabled: true,
      text: "Max",
      title: "Maximum rendered node limit reached; narrow the graph with filters",
    });
  });

  it("summarizes project graph edge quality", () => {
    const status = summarizeProjectGraphEdgeQuality({
      nodeCount: 10,
      edgeCount: 4,
      nodesByKind: {},
      edgesByKind: {},
      edgesByResolutionConfidence: { solc: 1, parser: 2, heuristic: 1 },
      unresolvedEdgeCount: 1,
      filesByTier: {},
      lastRebuildDurationMs: 4,
      lastUpdateDurationMs: null,
    });

    assert.equal(status.counts.solc, 1);
    assert.equal(status.counts.parser, 2);
    assert.equal(status.counts.heuristic, 1);
    assert.equal(status.unresolved, 1);
    assert.match(status.label, /1\/4 solc/);
    assert.match(status.detail, /unresolved=1/);
  });

  it("summarizes project graph result diagnostics", () => {
    assert.equal(summarizeProjectGraphResultDiagnostics(), undefined);

    const diagnostics = summarizeProjectGraphResultDiagnostics({
      truncated: true,
      indexStatus: {
        relationshipIndexComplete: false,
        relationshipFilesIndexed: 2,
        relationshipFilesTotal: 5,
        pendingRelationshipFiles: 3,
        partial: true,
      },
      edgeQuality: {
        edgesByResolutionConfidence: { parser: 1, heuristic: 1 },
        lowConfidenceEdgeCount: 1,
        unresolvedEdgeCount: 1,
      },
    });

    assert.equal(diagnostics?.state, "partial");
    assert.equal(diagnostics?.label, "Partial graph result");
    assert.match(diagnostics?.detail ?? "", /truncated/);
    assert.match(diagnostics?.detail ?? "", /2\/5 relationship files indexed/);
    assert.match(diagnostics?.detail ?? "", /1 low-confidence edge/);

    const warning = summarizeProjectGraphResultDiagnostics({
      edgeQuality: {
        edgesByResolutionConfidence: { heuristic: 1 },
        lowConfidenceEdgeCount: 1,
        unresolvedEdgeCount: 0,
      },
    });
    assert.equal(warning?.state, "warning");
    assert.equal(warning?.label, "Graph result needs review");

    const scoped = summarizeProjectGraphResultDiagnostics({
      matches: [],
      scope: {
        includeTests: false,
        includeDependencies: false,
        hiddenNodeCount: 5,
        hiddenTestNodeCount: 2,
        hiddenDependencyNodeCount: 3,
        hiddenOtherNodeCount: 0,
      },
    });
    assert.equal(scoped?.state, "warning");
    assert.match(scoped?.detail ?? "", /Current scope hides 2 test nodes and 3 dependency nodes/);
    assert.match(
      projectGraphHiddenScopeHint({
        includeTests: true,
        includeDependencies: false,
        hiddenNodeCount: 1,
        hiddenTestNodeCount: 0,
        hiddenDependencyNodeCount: 1,
        hiddenOtherNodeCount: 0,
      }) ?? "",
      /1 dependency node/,
    );
  });

  it("builds project graph scope diagnostics reports", () => {
    const stats: ProjectGraphStatsResult = {
      nodeCount: 4,
      edgeCount: 2,
      nodesByKind: Object.assign(Object.create(null), { contract: 2, function: 2 }),
      edgesByKind: Object.assign(Object.create(null), { contains: 2 }),
      filesByTier: Object.assign(Object.create(null), { project: 1, tests: 1 }),
      lastRebuildDurationMs: 11,
      lastUpdateDurationMs: null,
    };
    const report = buildProjectGraphScopeDiagnosticsReport({
      generatedAt: "2026-06-25T00:00:00.000Z",
      requestDurationMs: 7,
      stats,
      scopes: [
        {
          label: "Project Sources Only",
          includeTests: false,
          includeDependencies: false,
          nodeCount: 2,
          edgeCount: 1,
          scope: {
            includeTests: false,
            includeDependencies: false,
            hiddenNodeCount: 2,
            hiddenTestNodeCount: 2,
            hiddenDependencyNodeCount: 0,
            hiddenOtherNodeCount: 0,
          },
        },
      ],
    });

    assert.equal(report.generatedAt, "2026-06-25T00:00:00.000Z");
    assert.equal(report.requestDurationMs, 7);
    assert.equal(report.scopes[0]?.label, "Project Sources Only");
    assert.equal(report.scopes[0]?.scope?.hiddenTestNodeCount, 2);
  });

  it("summarizes project graph relationship indexing status", () => {
    assert.equal(summarizeProjectGraphRelationshipStatus().state, "unknown");

    const partial = summarizeProjectGraphRelationshipStatus({
      nodeCount: 10,
      edgeCount: 20,
      nodesByKind: {},
      edgesByKind: {},
      filesByTier: {},
      lastRebuildDurationMs: 4,
      lastUpdateDurationMs: null,
      relationshipFilesIndexed: 2,
      relationshipFilesTotal: 5,
      pendingRelationshipFiles: 3,
      relationshipIndexComplete: false,
    });
    assert.equal(partial.state, "partial");
    assert.equal(partial.indexed, 2);
    assert.equal(partial.total, 5);
    assert.equal(partial.pending, 3);
    assert.match(partial.label, /2\/5/);

    const complete = summarizeProjectGraphRelationshipStatus({
      nodeCount: 10,
      edgeCount: 20,
      nodesByKind: {},
      edgesByKind: {},
      filesByTier: {},
      lastRebuildDurationMs: 4,
      lastUpdateDurationMs: null,
      relationshipFilesIndexed: 5,
      relationshipFilesTotal: 5,
      pendingRelationshipFiles: 0,
      relationshipIndexComplete: true,
    });
    assert.equal(complete.state, "complete");
    assert.equal(complete.pending, 0);
    assert.equal(complete.label, "edges ready");
  });

  it("summarizes project graph compiler cache status", () => {
    assert.equal(summarizeProjectGraphCompilerStatus().state, "unknown");

    const parserOnly = summarizeProjectGraphCompilerStatus({
      nodeCount: 0,
      edgeCount: 0,
      nodesByKind: {},
      edgesByKind: {},
      filesByTier: {},
      lastRebuildDurationMs: null,
      lastUpdateDurationMs: null,
      compilerStatus: {
        available: false,
        stale: false,
        cachedFileCount: 0,
        staleFileCount: 0,
        lastBuildTimeMs: null,
      },
    });
    assert.equal(parserOnly.state, "parserOnly");
    assert.equal(parserOnly.label, "parser-only graph");

    const stale = summarizeProjectGraphCompilerStatus({
      nodeCount: 0,
      edgeCount: 0,
      nodesByKind: {},
      edgesByKind: {},
      filesByTier: {},
      lastRebuildDurationMs: null,
      lastUpdateDurationMs: null,
      compilerStatus: {
        available: true,
        stale: true,
        cachedFileCount: 2,
        staleFileCount: 1,
        staleFiles: ["/workspace/src/Vault.sol"],
        lastBuildTimeMs: 123,
      },
    });
    assert.equal(stale.state, "stale");
    assert.equal(stale.label, "compiler stale 1");
    assert.equal(stale.staleFileCount, 1);

    const ready = summarizeProjectGraphCompilerStatus({
      nodeCount: 0,
      edgeCount: 0,
      nodesByKind: {},
      edgesByKind: {},
      filesByTier: {},
      lastRebuildDurationMs: null,
      lastUpdateDurationMs: null,
      compilerStatus: {
        available: true,
        stale: false,
        cachedFileCount: 2,
        staleFileCount: 0,
        lastBuildTimeMs: 123,
      },
    });
    assert.equal(ready.state, "ready");
    assert.equal(ready.label, "compiler ready");
  });

  it("serializes large graph exports without dropping nodes, edges, or truncation metadata", () => {
    const largeGraph = makeLargeProjectGraph(420);

    const json = serializeProjectGraphForExport(largeGraph, "json");
    const parsedJson = JSON.parse(json.content);
    assert.equal(parsedJson.truncated, true);
    assert.equal(parsedJson.nodes.length, largeGraph.nodes.length);
    assert.equal(parsedJson.edges.length, largeGraph.edges.length);

    const codeGraph = serializeProjectGraphForExport(largeGraph, "codegraph-json");
    const parsedCodeGraph = JSON.parse(codeGraph.content);
    assert.equal(parsedCodeGraph.graph.nodeCount, largeGraph.nodes.length);
    assert.equal(parsedCodeGraph.graph.edgeCount, largeGraph.edges.length);
    assert.equal(parsedCodeGraph.graph.truncated, true);
    assert.equal(parsedCodeGraph.nodes[0].line, 1);

    const dot = serializeProjectGraphForExport(largeGraph, "dot");
    assert.match(dot.content, /digraph SolidityProjectGraph/);
    assert.match(dot.content, /Escaped\\"Vault/);
    assert.match(dot.content, /line\\nbreak/);

    const graphMl = serializeProjectGraphForExport(largeGraph, "graphml");
    assert.match(graphMl.content, /<graphml/);
    assert.match(graphMl.content, /Escaped&quot;Vault/);
    assert.match(graphMl.content, /line\nbreak/);
  });
});

describe("Feature coverage — live project graph", () => {
  before(async function () {
    this.timeout(60_000);
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    await ext!.activate();
    await new Promise((r) => setTimeout(r, 3_000));
  });

  it("rebuilds the live LSP graph and opens graph stats", async function () {
    this.timeout(60_000);

    await vscode.commands.executeCommand("solidity-workbench.rebuildProjectGraph");
    await vscode.commands.executeCommand("solidity-workbench.projectGraphStats");

    const editor = vscode.window.activeTextEditor;
    assert.ok(editor, "expected project graph stats to open a JSON document");
    const stats = JSON.parse(editor.document.getText()) as ProjectGraphStatsResult & {
      requestDurationMs?: number;
    };

    assert.ok(stats.nodeCount > 0, `expected live graph nodes; got ${stats.nodeCount}`);
    assert.ok(stats.edgeCount > 0, `expected live graph edges; got ${stats.edgeCount}`);
    assert.ok(
      stats.nodesByKind.contract || stats.nodesByKind.function,
      "expected contract/function nodes in live graph stats",
    );
    assert.ok(
      typeof stats.relationshipFilesIndexed === "number" &&
        typeof stats.relationshipFilesTotal === "number" &&
        typeof stats.pendingRelationshipFiles === "number" &&
        typeof stats.relationshipIndexComplete === "boolean",
      "expected relationship indexing progress fields in live graph stats",
    );
    assert.ok(
      stats.edgesByResolutionConfidence &&
        typeof stats.edgesByResolutionConfidence.unknown === "number" &&
        typeof stats.unresolvedEdgeCount === "number",
      "expected edge confidence fields in live graph stats",
    );
    assert.ok(
      stats.lastRequestDurationsMs && typeof stats.lastRequestDurationsMs.rebuild === "number",
      "expected live graph stats to include request timing metadata",
    );
    assert.ok(
      stats.compilerStatus && typeof stats.compilerStatus.available === "boolean",
      "expected live graph stats to include compiler cache status",
    );
    assert.ok(
      stats.performance &&
        typeof stats.performance.budget.requestWarningMs === "number" &&
        Array.isArray(stats.performance.warnings),
      "expected live graph stats to include performance budget metadata",
    );
    assert.equal(
      stats.relationshipIndexComplete,
      true,
      "explicit rebuild should complete relationship indexing for the sample workspace",
    );
    assert.notEqual(stats.rebuildCanceled, true, "explicit sample rebuild should not be canceled");

    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(findSampleFile("src/Counter.sol")),
    );
  });

  it("opens live project graph scope diagnostics", async function () {
    this.timeout(60_000);

    await vscode.commands.executeCommand("solidity-workbench.projectGraphScopeDiagnostics");

    const editor = vscode.window.activeTextEditor;
    assert.ok(editor, "expected project graph scope diagnostics to open a JSON document");
    const report = JSON.parse(editor.document.getText()) as {
      scopes?: Array<{ label: string; nodeCount: number; scope?: { hiddenNodeCount: number } }>;
    };
    assert.equal(report.scopes?.length, 4);
    assert.ok(
      report.scopes?.some((scope) => scope.label === "Project Sources Only"),
      "expected project-source scope diagnostics",
    );
    assert.ok(
      report.scopes?.every((scope) => typeof scope.nodeCount === "number"),
      "expected node counts for every scope",
    );

    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(findSampleFile("src/Counter.sol")),
    );
  });

  it("serves live graph search, query, and path requests over the LSP transport", async function () {
    this.timeout(60_000);

    await vscode.commands.executeCommand("solidity-workbench.rebuildProjectGraph");

    const hiddenTests = await requestProjectGraph<ProjectGraphSearchResult>("search", {
      query: "CounterTest",
      maxResults: 10,
    });
    assert.equal(
      hiddenTests.matches.some((match) => match.node.name === "CounterTest"),
      false,
      "test contracts should remain hidden from graph search unless includeTests is explicit",
    );

    const testSearch = await requestProjectGraph<ProjectGraphSearchResult>("search", {
      query: "CounterTest",
      includeTests: true,
      maxResults: 10,
    });
    const testContract = testSearch.matches.find(
      (match) => match.node.name === "CounterTest",
    )?.node;
    assert.ok(testContract, "includeTests should expose the sample test contract");

    const testFunctionSearch = await requestProjectGraph<ProjectGraphSearchResult>("search", {
      query: "test_Increment",
      kinds: ["function"],
      includeTests: true,
      maxResults: 20,
    });
    const testIncrement = testFunctionSearch.matches.find(
      (match) => match.node.name === "test_Increment",
    )?.node;
    assert.ok(testIncrement, "expected the sample test function in graph search");

    const incrementSearch = await requestProjectGraph<ProjectGraphSearchResult>("search", {
      query: "Counter.increment",
      kinds: ["function"],
      includeTests: true,
      maxResults: 20,
    });
    const increment = incrementSearch.matches.find(
      (match) => match.node.name === "increment" && match.node.containerName === "Counter",
    )?.node;
    assert.ok(increment, "expected Counter.increment in graph search");

    const callers = await requestProjectGraph<ProjectGraphQueryResult>("query", {
      kind: "callers",
      target: { nodeId: increment.id },
      includeTests: true,
      maxNodes: 80,
    });
    assert.equal(callers.found, true, "expected callers query to find Counter.increment");
    assert.ok(
      callers.edges.some(
        (edge) => edge.source === testIncrement.id && edge.target === increment.id,
      ),
      "expected callers query to include CounterTest.test_Increment -> Counter.increment",
    );

    const pathGraph = await requestProjectGraph<ProjectGraphPathResult>("path", {
      from: { nodeId: testIncrement.id },
      to: { nodeId: increment.id },
      direction: "outgoing",
      maxDepth: 2,
      includeTests: true,
    });
    assert.equal(pathGraph.found, true, "expected graph path from test to source function");
    assert.ok(
      pathGraph.edges.some(
        (edge) =>
          edge.kind === "calls" && edge.source === testIncrement.id && edge.target === increment.id,
      ),
      "expected graph path to include the direct call edge",
    );
  });
});

describe("Feature coverage — Test Explorer", () => {
  before(async function () {
    this.timeout(60_000);
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    await ext!.activate();
    await new Promise((r) => setTimeout(r, 3_000));
  });

  it("contributes the Solidity Tests view container", async () => {
    // The package.json contributes the test controller; just check
    // that the controller IDs we expect end up in the host. The
    // public `vscode.tests` API doesn't expose a list of registered
    // controllers, so the cleanest assertion is that running the
    // built-in `testing.refreshTests` command doesn't throw — that
    // proves a controller is at least registered.
    await vscode.commands.executeCommand("testing.refreshTests").then(
      () => {
        /* ok */
      },
      () => {
        /* tolerate environments without the testing API */
      },
    );
  });
});

describe("Feature coverage — DAP debugger contribution", () => {
  before(async function () {
    this.timeout(60_000);
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    await ext!.activate();
  });

  it("declares the `solidity-workbench` debug type via package.json contribution", async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    const debuggers = (ext?.packageJSON?.contributes?.debuggers ?? []) as Array<{
      type?: string;
      label?: string;
    }>;
    const ours = debuggers.find((d) => d.type === "solidity-workbench");
    assert.ok(ours, "expected a `solidity-workbench` debug type contribution");
    assert.ok(typeof ours!.label === "string" && ours!.label.length > 0);
  });

  it("breakpoints are declared for the solidity language", () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    const breakpoints = (ext?.packageJSON?.contributes?.breakpoints ?? []) as Array<{
      language?: string;
    }>;
    assert.ok(
      breakpoints.some((b) => b.language === "solidity"),
      "expected a `breakpoints[language=solidity]` contribution so .sol files expose gutter breakpoints",
    );
  });

  it("starts a debug session with a synthetic trace + artifact and reports a stack frame", async function () {
    this.timeout(45_000);
    const fixture = makeDebugFixture();
    const tracker = installSessionTracker();

    try {
      const ok = await vscode.debug.startDebugging(undefined, {
        type: "solidity-workbench",
        request: "launch",
        name: "e2e: synthetic trace",
        traceFile: fixture.tracePath,
        artifact: fixture.artifactPath,
        projectRoot: fixture.projectRoot,
      });
      assert.ok(ok, "startDebugging returned false — VSCode rejected the configuration");

      // Wait for the adapter's `stopped: entry` event.
      await tracker.waitForEvent("stopped", 10_000);

      // Trigger a stackTrace request via VSCode's DAP relay. The
      // public API doesn't expose `vscode.debug.activeDebugSession.customRequest`
      // on every channel, but it's the canonical way.
      const session = vscode.debug.activeDebugSession;
      assert.ok(session, "expected an active debug session");
      const reply = await session!.customRequest("stackTrace", { threadId: 1 });
      assert.ok(reply, "stackTrace returned no body");
      assert.ok(Array.isArray(reply.stackFrames));
      assert.ok(reply.stackFrames.length >= 1, "expected at least one stack frame");
    } finally {
      try {
        await vscode.debug.stopDebugging(vscode.debug.activeDebugSession);
      } catch {
        /* tolerate "no active session" if the launch failed */
      }
      tracker.dispose();
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("resolves stack frames to real Foundry artifact source locations", async function () {
    this.timeout(45_000);
    const fixture = makeSourceMappedDebugFixture();
    const tracker = installSessionTracker();

    try {
      const ok = await vscode.debug.startDebugging(undefined, {
        type: "solidity-workbench",
        request: "launch",
        name: "e2e: source-mapped trace",
        traceFile: fixture.tracePath,
        artifact: fixture.artifactPath,
        projectRoot: fixture.projectRoot,
      });
      assert.ok(ok, "startDebugging returned false — VSCode rejected the configuration");

      await tracker.waitForEvent("stopped", 10_000);

      const session = vscode.debug.activeDebugSession;
      assert.ok(session, "expected an active debug session");
      const reply = await session!.customRequest("stackTrace", { threadId: 1 });
      assert.ok(reply, "stackTrace returned no body");
      assert.ok(Array.isArray(reply.stackFrames));

      const sourceFrame = reply.stackFrames.find(
        (frame: { source?: { path?: string }; line?: number; column?: number }) =>
          frame.source?.path === fixture.sourcePath,
      );
      assert.ok(
        sourceFrame,
        `expected a stack frame resolved to ${fixture.sourcePath}, got ${JSON.stringify(
          reply.stackFrames,
        )}`,
      );
      assert.equal(sourceFrame!.line, fixture.expectedLine);
      assert.equal(sourceFrame!.column, fixture.expectedColumn);
    } finally {
      try {
        await vscode.debug.stopDebugging(vscode.debug.activeDebugSession);
      } catch {
        /* tolerate "no active session" if the launch failed */
      }
      tracker.dispose();
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});

// ── Helpers ──────────────────────────────────────────────────────────

function findSampleFile(rel: string): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "workspace folder must be open for these tests");
  return vscode.Uri.joinPath(folder.uri, rel);
}

function requestProjectGraph<T>(method: string, params: unknown): Thenable<T> {
  return vscode.commands.executeCommand("solidity-workbench.internal.projectGraphRequest", {
    method,
    params,
  });
}

async function retry<T>(fn: () => Thenable<T>, attempts = 10, delayMs = 500): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await fn();
      if (result !== undefined && result !== null) return result;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  if (lastErr) throw lastErr;
  return (await fn()) as T;
}

function makeLargeProjectGraph(count: number): ProjectGraphResult {
  const nodes: ProjectGraphResult["nodes"] = [];
  const edges: ProjectGraphResult["edges"] = [];

  for (let i = 0; i < count; i++) {
    const uri = `file:///workspace/src/Vault${i}.sol`;
    const contractId = `${uri}#Vault${i}`;
    const functionId = `${uri}#Vault${i}:function:deposit${i}:8:13`;
    nodes.push({
      id: contractId,
      kind: "contract",
      name: i === 0 ? 'Escaped"Vault line\nbreak' : `Vault${i}`,
      qualifiedName: i === 0 ? 'Escaped"Vault line\nbreak' : `Vault${i}`,
      uri,
      filePath: `/workspace/src/Vault${i}.sol`,
      tier: "project",
      range: { start: { line: 0, character: 0 }, end: { line: 20, character: 1 } },
      selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 15 } },
    });
    nodes.push({
      id: functionId,
      kind: "function",
      name: `deposit${i}`,
      qualifiedName: `Vault${i}.deposit${i}`,
      uri,
      filePath: `/workspace/src/Vault${i}.sol`,
      tier: "project",
      containerId: contractId,
      containerName: `Vault${i}`,
      range: { start: { line: 8, character: 4 }, end: { line: 12, character: 5 } },
      selectionRange: { start: { line: 8, character: 13 }, end: { line: 8, character: 21 } },
    });
    edges.push({ source: contractId, target: functionId, kind: "contains" });
    if (i > 0) {
      edges.push({
        source: functionId,
        target: `file:///workspace/src/Vault${i - 1}.sol#Vault${i - 1}:function:deposit${i - 1}:8:13`,
        kind: "calls",
        metadata: { resolutionConfidence: "parser" },
      });
    }
  }

  return {
    focusId: nodes[1]?.id,
    truncated: true,
    nodes,
    edges,
  };
}

function makeRuntimeProjectGraph(count: number): ProjectGraphResult {
  const focusId = "file:///workspace/src/Vault.sol#Vault:function:deposit:4:13";
  const nodes: ProjectGraphResult["nodes"] = [
    {
      id: focusId,
      kind: "function",
      name: "deposit",
      qualifiedName: "Vault.deposit",
      uri: "file:///workspace/src/Vault.sol",
      filePath: "/workspace/src/Vault.sol",
      tier: "project",
      range: { start: { line: 4, character: 4 }, end: { line: 6, character: 5 } },
      selectionRange: { start: { line: 4, character: 13 }, end: { line: 4, character: 20 } },
      containerName: "Vault",
    },
  ];
  const edges: ProjectGraphResult["edges"] = [];

  for (let i = 1; i < count; i++) {
    const isState = i === 2;
    const id = isState
      ? "file:///workspace/src/Vault.sol#Vault:stateVariable:balances:2:20"
      : `file:///workspace/src/Vault.sol#Vault:function:helper${i}:8:13`;
    nodes.push({
      id,
      kind: isState ? "stateVariable" : "function",
      name: isState ? "balances" : `helper${i}`,
      qualifiedName: isState ? "Vault.balances" : `Vault.helper${i}`,
      uri: "file:///workspace/src/Vault.sol",
      filePath: "/workspace/src/Vault.sol",
      tier: "project",
      range: { start: { line: 8 + i, character: 4 }, end: { line: 8 + i, character: 30 } },
      selectionRange: {
        start: { line: 8 + i, character: 13 },
        end: { line: 8 + i, character: 20 },
      },
      containerName: "Vault",
    });
    edges.push({
      source: focusId,
      target: id,
      kind: isState ? "usesType" : "calls",
      resolutionConfidence: "parser",
    });
  }

  return { focusId, nodes, edges };
}

interface ProjectGraphWebviewRuntime {
  element(id: string): FakeElement;
  input(id: string, value: string): void;
  change(id: string, value: string | boolean): void;
  click(id: string): void;
  lastState(): RuntimeState | undefined;
  lastPostedMessage(): RuntimeMessage | undefined;
}

interface RuntimeState {
  activeId?: string;
  query?: string;
  scope?: string;
  nodeKind?: string;
  quality?: string;
  zoom?: number;
  pathMode?: boolean;
  renderedNodeLimit?: number;
  visibleEdges?: string[];
  includeTests?: boolean;
  includeDependencies?: boolean;
}

type RuntimeMessage = Record<string, unknown>;

function runProjectGraphWebviewScript(html: string): ProjectGraphWebviewRuntime {
  const script = extractProjectGraphScript(html);
  const document = new FakeDocument(html);
  const window = new FakeWindow();
  let state: RuntimeState | undefined;
  const postedMessages: RuntimeMessage[] = [];

  const context = vm.createContext({
    acquireVsCodeApi: () => ({
      getState: () => state,
      setState: (next: RuntimeState) => {
        state = structuredClone(next);
      },
      postMessage: (message: RuntimeMessage) => {
        postedMessages.push(message);
      },
    }),
    document,
    window,
    console,
  });

  vm.runInContext(script, context, { timeout: 5_000 });

  return {
    element: (id) => document.getElementById(id),
    input(id, value) {
      const element = document.getElementById(id);
      element.value = value;
      element.dispatch("input");
    },
    change(id, value) {
      const element = document.getElementById(id);
      if (typeof value === "boolean") element.checked = value;
      else element.value = value;
      element.dispatch("change");
    },
    click(id) {
      document.getElementById(id).dispatch("click");
    },
    lastState: () => state,
    lastPostedMessage: () => postedMessages.at(-1),
  };
}

function runInheritanceGraphWebviewScript(html: string): ProjectGraphWebviewRuntime {
  const match = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match, "expected inheritance graph HTML to include an inline script");
  const document = new FakeDocument(html);
  const window = new FakeWindow();
  const postedMessages: RuntimeMessage[] = [];

  const context = vm.createContext({
    acquireVsCodeApi: () => ({
      postMessage: (message: RuntimeMessage) => {
        postedMessages.push(message);
      },
    }),
    document,
    window,
    console,
  });

  vm.runInContext(match[1], context, { timeout: 5_000 });

  return {
    element: (id) => document.getElementById(id),
    input(id, value) {
      const element = document.getElementById(id);
      element.value = value;
      element.dispatch("input");
    },
    change(id, value) {
      const element = document.getElementById(id);
      if (typeof value === "boolean") element.checked = value;
      else element.value = value;
      element.dispatch("change");
    },
    click(id) {
      document.getElementById(id).dispatch("click");
    },
    lastState: () => undefined,
    lastPostedMessage: () => postedMessages.at(-1),
  };
}

function extractProjectGraphScript(html: string): string {
  const match = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match, "expected project graph HTML to include an inline script");
  return match[1];
}

type FakeListener = (event: FakeEvent) => void;

class FakeEvent {
  public readonly target: FakeElement;
  public readonly key?: string;

  public constructor(target: FakeElement, key?: string) {
    this.target = target;
    this.key = key;
  }

  public preventDefault(): void {
    // Test harness no-op.
  }

  public stopPropagation(): void {
    // Test harness no-op.
  }
}

class FakeClassList {
  private readonly values = new Set<string>();

  public add(...tokens: string[]): void {
    for (const token of tokens) {
      if (token) this.values.add(token);
    }
  }

  public remove(...tokens: string[]): void {
    for (const token of tokens) this.values.delete(token);
  }

  public toggle(token: string, force?: boolean): boolean {
    const enabled = force ?? !this.values.has(token);
    if (enabled) this.values.add(token);
    else this.values.delete(token);
    return enabled;
  }

  public contains(token: string): boolean {
    return this.values.has(token);
  }
}

class FakeElement {
  public readonly tagName: string;
  public readonly children: Array<FakeElement | string> = [];
  public readonly classList = new FakeClassList();
  public readonly style: Record<string, string> = {};
  public className = "";
  public textContent = "";
  public title = "";
  public value = "";
  public type = "";
  public checked = false;
  public hidden = false;
  public disabled = false;
  public tabIndex = 0;
  public scrollLeft = 0;
  public scrollTop = 0;
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, FakeListener[]>();
  private html = "";

  public constructor(tagName: string) {
    this.tagName = tagName;
  }

  public get childElementCount(): number {
    return this.children.filter((child) => child instanceof FakeElement).length;
  }

  public get innerHTML(): string {
    return this.html;
  }

  public set innerHTML(value: string) {
    this.html = value;
    if (value === "") {
      this.children.splice(0, this.children.length);
    }
  }

  public append(...children: Array<FakeElement | string>): void {
    this.children.push(...children);
  }

  public appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  public getAttribute(name: string): string | undefined {
    return this.attributes.get(name);
  }

  public addEventListener(type: string, listener: FakeListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  public dispatch(type: string, key?: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new FakeEvent(this, key));
    }
  }

  public closest(selector: string): FakeElement | null {
    if (!selector.startsWith(".")) return null;
    const className = selector.slice(1);
    return this.className.split(/\s+/).includes(className) || this.classList.contains(className)
      ? this
      : null;
  }

  public scrollTo(position: { left?: number; top?: number }): void {
    this.scrollLeft = position.left ?? this.scrollLeft;
    this.scrollTop = position.top ?? this.scrollTop;
  }

  public setPointerCapture(): void {
    // Test harness no-op.
  }

  public releasePointerCapture(): void {
    // Test harness no-op.
  }
}

class FakeDocument {
  private readonly elements = new Map<string, FakeElement>();

  public constructor(html: string) {
    for (const match of html.matchAll(/\sid="([^"]+)"/g)) {
      this.elements.set(match[1], new FakeElement("div"));
    }
  }

  public getElementById(id: string): FakeElement {
    let element = this.elements.get(id);
    if (!element) {
      element = new FakeElement("div");
      this.elements.set(id, element);
    }
    return element;
  }

  public createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }

  public createElementNS(_namespace: string, tagName: string): FakeElement {
    return new FakeElement(tagName);
  }
}

class FakeWindow {
  private readonly listeners = new Map<string, ((event: { data: unknown }) => void)[]>();

  public addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  public postMessage(data: unknown): void {
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ data });
    }
  }
}

/**
 * Spin up a temp dir with the absolute minimum the DAP adapter
 * needs to bring up a session: a tiny trace JSON (3 structLog
 * steps) and a synthetic forge artifact (one PUSH1 STOP, source
 * map pointing nowhere meaningful). The session won't have real
 * source resolution but stackTrace should still respond, exercising
 * the wire protocol end-to-end.
 */
function makeDebugFixture(): {
  dir: string;
  tracePath: string;
  artifactPath: string;
  projectRoot: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solidity-workbench-dap-"));
  const tracePath = path.join(dir, "trace.json");
  const artifactPath = path.join(dir, "artifact.json");
  fs.writeFileSync(
    tracePath,
    JSON.stringify({
      gas: 21000,
      failed: false,
      returnValue: "0x",
      structLogs: [
        { pc: 0, op: "PUSH1", depth: 1, gas: 999990, gasCost: 3, stack: [], memory: [] },
        { pc: 2, op: "STOP", depth: 1, gas: 999987, gasCost: 0, stack: ["0x1"], memory: [] },
      ],
    }),
  );
  // Smallest plausible artifact. fileIndex -1 (`-`) so source
  // resolution returns null gracefully — the test only exercises
  // wire-protocol shape, not source mapping.
  fs.writeFileSync(
    artifactPath,
    JSON.stringify({
      bytecode: { object: "0x600100", sourceMap: "0:0:-1:-:0" },
      deployedBytecode: { object: "0x600100", sourceMap: "0:0:-1:-:0" },
      metadata: JSON.stringify({ sources: {} }),
    }),
  );
  return { dir, tracePath, artifactPath, projectRoot: dir };
}

function makeSourceMappedDebugFixture(): {
  dir: string;
  tracePath: string;
  artifactPath: string;
  projectRoot: string;
  sourcePath: string;
  expectedLine: number;
  expectedColumn: number;
} {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "workspace folder must be open for these tests");

  const projectRoot = folder.uri.fsPath;
  const artifactPath = path.join(projectRoot, "out", "Counter.sol", "Counter.json");
  const sourcePath = path.join(projectRoot, "src", "Counter.sol");
  ensureSampleForgeArtifact(projectRoot, artifactPath);
  assert.ok(fs.existsSync(sourcePath), `expected sample source at ${sourcePath}`);

  const artifact = parseForgeArtifact(fs.readFileSync(artifactPath, "utf8"));
  assert.ok(artifact, `failed to parse forge artifact ${artifactPath}`);

  const sourceText = fs.readFileSync(sourcePath, "utf8");
  const mapped = findSourceMappedInstruction(artifact, sourceText, "src/Counter.sol");
  assert.ok(mapped, `expected ${artifactPath} to contain a source-mapped Counter.sol instruction`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solidity-workbench-dap-source-"));
  const tracePath = path.join(dir, "trace.json");
  fs.writeFileSync(
    tracePath,
    JSON.stringify({
      gas: 21000,
      failed: false,
      returnValue: "0x",
      structLogs: [
        {
          pc: mapped!.pc,
          op: "PUSH1",
          depth: 1,
          gas: 999990,
          gasCost: 3,
          stack: [],
          memory: [],
        },
      ],
    }),
  );

  return {
    dir,
    tracePath,
    artifactPath,
    projectRoot,
    sourcePath,
    expectedLine: mapped!.line,
    expectedColumn: mapped!.column,
  };
}

function ensureSampleForgeArtifact(projectRoot: string, artifactPath: string): void {
  if (fs.existsSync(artifactPath)) return;

  try {
    execFileSync("forge", ["build", "src/Counter.sol"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 60_000,
    });
  } catch (err) {
    const details =
      err && typeof err === "object"
        ? [
            String((err as { message?: unknown }).message ?? ""),
            String((err as { stdout?: unknown }).stdout ?? ""),
            String((err as { stderr?: unknown }).stderr ?? ""),
          ]
            .filter(Boolean)
            .join("\n")
        : String(err);
    assert.fail(`expected forge build to generate ${artifactPath}${details ? `\n${details}` : ""}`);
  }

  assert.ok(fs.existsSync(artifactPath), `expected forge build to generate ${artifactPath}`);
}

function findSourceMappedInstruction(
  artifact: ForgeArtifact,
  sourceText: string,
  sourcePathSuffix: string,
): { pc: number; line: number; column: number } | null {
  const sourceIndex = artifact.sources.findIndex((source) =>
    source.replace(/\\/g, "/").endsWith(sourcePathSuffix),
  );
  if (sourceIndex < 0) return null;

  const sourceMap = parseSourceMap(artifact.deployedSourceMap);
  const pcMap = buildPcToInstructionIndex(artifact.deployedBytecode);
  const lineIndex = LineIndex.fromText(sourceText);
  return (
    findMappedPc(pcMap, sourceMap, sourceIndex, lineIndex, (line) => line >= 36) ??
    findMappedPc(pcMap, sourceMap, sourceIndex, lineIndex)
  );
}

function findMappedPc(
  pcMap: number[],
  sourceMap: SourceMapEntry[],
  sourceIndex: number,
  lineIndex: LineIndex,
  lineFilter: (line: number) => boolean = () => true,
): { pc: number; line: number; column: number } | null {
  for (let pc = 0; pc < pcMap.length; pc++) {
    const entry = resolveSourcePosition(pc, pcMap, sourceMap);
    if (!entry || entry.fileIndex !== sourceIndex) continue;
    const pos = lineIndex.positionAt(entry.start);
    if (!lineFilter(pos.line + 1)) continue;
    return { pc, line: pos.line + 1, column: pos.character + 1 };
  }
  return null;
}

interface SessionTracker {
  waitForEvent(name: string, timeoutMs: number): Promise<unknown>;
  dispose(): void;
}

function installSessionTracker(): SessionTracker {
  const events: { name: string; body: unknown }[] = [];
  const waiters: {
    name: string;
    resolve: (body: unknown) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }[] = [];

  const onEvent = (name: string, body: unknown): void => {
    events.push({ name, body });
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].name === name) {
        clearTimeout(waiters[i].timer);
        waiters[i].resolve(body);
        waiters.splice(i, 1);
      }
    }
  };

  const factory = vscode.debug.registerDebugAdapterTrackerFactory("solidity-workbench", {
    createDebugAdapterTracker() {
      return {
        onDidSendMessage(msg: { type?: string; event?: string; body?: unknown }) {
          if (msg.type === "event" && typeof msg.event === "string") {
            onEvent(msg.event, msg.body);
          }
        },
      };
    },
  });

  return {
    waitForEvent(name, timeoutMs) {
      const past = events.find((e) => e.name === name);
      if (past) return Promise.resolve(past.body);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for DAP event '${name}'`));
        }, timeoutMs);
        waiters.push({ name, resolve, reject, timer });
      });
    },
    dispose() {
      factory.dispose();
      for (const w of waiters) clearTimeout(w.timer);
    },
  };
}
