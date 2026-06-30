import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { URI } from "vscode-uri";
import { GraphIndex } from "../analyzer/graph-index.js";
import { SemanticResolver } from "../analyzer/semantic-resolver.js";
import { SymbolIndex } from "../analyzer/symbol-index.js";
import type { SolcBridge } from "../compiler/solc-bridge.js";
import { SolidityParser } from "../parser/solidity-parser.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";

describe("GraphIndex", () => {
  it("indexes file, containment, import, inheritance, and call edges", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-index-test-"));
    try {
      const files = {
        "src/Base.sol": `pragma solidity ^0.8.24;
contract Base {
    function inherited() internal {}
}
`,
        "src/helper.sol": `pragma solidity ^0.8.24;
contract helper {}
`,
        "src/Child.sol": `pragma solidity ^0.8.24;
import "./Base.sol";
contract Child is Base {
    struct Snapshot {
        Base target;
    }

    event Updated(uint256 value);
    error Unauthorized();
    uint256 public count;
    Base public baseRef;
    Snapshot internal snapshot;

    function entry() external {
        count += 1;
        helper();
        emit Updated(count);
        if (count > 10) revert Unauthorized();
        inherited();
    }

    function helper() internal {}

    function typed(Base target) external pure returns (Base) {
        return target;
    }
}
`,
      };

      const uris: string[] = [];
      const parser = new SolidityParser();
      for (const [name, contents] of Object.entries(files)) {
        const filePath = path.join(tmpDir, name);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, contents, "utf-8");
        const uri = URI.file(filePath).toString();
        uris.push(uri);
        parser.parse(uri, contents);
      }

      const workspace = makeWorkspace(tmpDir, uris);
      const symbolIndex = new SymbolIndex(parser, workspace);
      for (const uri of uris) symbolIndex.updateFile(uri);
      const resolver = new SemanticResolver(parser, workspace, symbolIndex);
      const graph = new GraphIndex(parser, workspace, resolver, symbolIndex);
      const childPath = path.join(tmpDir, "src/Child.sol");
      const inheritedCallOffset = fs.readFileSync(childPath, "utf-8").lastIndexOf("inherited");
      graph.setSolcBridge({
        getDeclarationInfoAt: (_filePath: string, offset: number) =>
          offset === inheritedCallOffset
            ? {
                declarationId: 1234,
                declarationFilePath: path.join(tmpDir, "src/Base.sol"),
                declarationOffset: files["src/Base.sol"].indexOf("function inherited"),
                declarationLength: "function inherited() internal {}".length,
                nodeType: "FunctionDefinition",
                name: "inherited",
              }
            : null,
        getCacheStatus: () => ({
          available: true,
          stale: false,
          cachedFileCount: 3,
          staleFileCount: 0,
          lastBuildTimeMs: 123,
        }),
      } as unknown as SolcBridge);
      graph.rebuildWorkspace();

      const childUri = URI.file(path.join(tmpDir, "src/Child.sol")).toString();
      const basePath = path.join(tmpDir, "src/Base.sol");
      const baseUri = URI.file(basePath).toString();
      const childId = resolver.contractId(childUri, "Child");
      const baseId = resolver.contractId(baseUri, "Base");

      assert.ok(graph.getNode(childId), "expected Child contract node");
      assert.ok(graph.getNode(baseId), "expected Base contract node");

      const imports = graph.getOutgoingEdges(`file:${childUri}`, "imports");
      assert.equal(imports.length, 1);
      assert.equal(imports[0].target, `file:${baseUri}`);

      const inherits = graph.getOutgoingEdges(childId, "inherits");
      assert.equal(inherits.length, 1);
      assert.equal(inherits[0].target, baseId);
      assert.equal(inherits[0].metadata?.baseName, "Base");

      const entry = graph
        .getNodes()
        .find((node) => node.name === "entry" && node.containerName === "Child");
      const helper = graph
        .getNodes()
        .find((node) => node.name === "helper" && node.containerName === "Child");
      const helperContract = graph
        .getNodes()
        .find((node) => node.name === "helper" && node.kind === "contract");
      const inherited = graph
        .getNodes()
        .find((node) => node.name === "inherited" && node.containerName === "Base");
      const count = graph
        .getNodes()
        .find((node) => node.name === "count" && node.containerName === "Child");
      const updated = graph
        .getNodes()
        .find((node) => node.name === "Updated" && node.containerName === "Child");
      const unauthorized = graph
        .getNodes()
        .find((node) => node.name === "Unauthorized" && node.containerName === "Child");
      const typed = graph
        .getNodes()
        .find((node) => node.name === "typed" && node.containerName === "Child");
      const baseRef = graph
        .getNodes()
        .find((node) => node.name === "baseRef" && node.containerName === "Child");
      const snapshot = graph
        .getNodes()
        .find((node) => node.name === "Snapshot" && node.containerName === "Child");
      assert.ok(entry, "expected entry function node");
      assert.ok(helper, "expected helper function node");
      assert.ok(helperContract, "expected same-name helper contract node");
      assert.ok(inherited, "expected inherited function node");
      assert.ok(count, "expected count state variable node");
      assert.ok(updated, "expected Updated event node");
      assert.ok(unauthorized, "expected Unauthorized error node");
      assert.ok(typed, "expected typed function node");
      assert.ok(baseRef, "expected baseRef state variable node");
      assert.ok(snapshot, "expected Snapshot struct node");

      const calls = graph.getOutgoingEdges(entry.id, "calls");
      assert.deepEqual(calls.map((edge) => edge.target).sort(), [helper.id, inherited.id].sort());
      const inheritedCall = calls.find((edge) => edge.target === inherited.id);
      assert.equal(
        inheritedCall?.metadata?.solcDeclarationId,
        1234,
        "expected warm SolcBridge declaration id to enrich call edges",
      );
      assert.equal(inheritedCall?.metadata?.resolutionConfidence, "solc");
      assert.equal(inheritedCall?.resolutionConfidence, "solc");
      assert.equal(inheritedCall?.evidence?.resolver, "solc");
      assert.match(inheritedCall?.evidence?.summary ?? "", /calls: inherited/);
      assert.equal(inheritedCall?.evidence?.source, "Child.entry");
      assert.equal(inheritedCall?.evidence?.target, "Base.inherited");
      const helperCall = calls.find((edge) => edge.target === helper.id);
      assert.equal(helperCall?.metadata?.resolutionConfidence, "parser");
      assert.equal(helperCall?.resolutionConfidence, "parser");
      assert.equal(helperCall?.evidence?.resolver, "parser");

      const writes = graph.getOutgoingEdges(entry.id, "writes");
      assert.ok(
        writes.some((edge) => edge.target === count.id),
        "expected entry to write count",
      );

      const reads = graph.getOutgoingEdges(entry.id, "reads");
      assert.ok(
        reads.some((edge) => edge.target === count.id),
        "expected entry to read count",
      );

      const emits = graph.getOutgoingEdges(entry.id, "emits");
      assert.deepEqual(
        emits.map((edge) => edge.target),
        [updated.id],
      );

      const reverts = graph.getOutgoingEdges(entry.id, "revertsWith");
      assert.deepEqual(
        reverts.map((edge) => edge.target),
        [unauthorized.id],
      );

      assert.ok(
        graph.getOutgoingEdges(typed.id, "usesType").some((edge) => edge.target === baseId),
        "expected function parameter and return types to create usesType edges",
      );
      assert.ok(
        graph.getOutgoingEdges(baseRef.id, "usesType").some((edge) => edge.target === baseId),
        "expected state variable types to create usesType edges",
      );
      assert.ok(
        graph.getOutgoingEdges(snapshot.id, "usesType").some((edge) => edge.target === baseId),
        "expected struct member types to create usesType edges",
      );

      const graphSnapshot = graph.toProjectGraph(["inherits", "emits"]);
      assert.ok(
        graphSnapshot.nodes.some((node) => node.id === childId && node.kind === "contract"),
        "expected project graph snapshot to include contract nodes",
      );
      assert.deepEqual(
        new Set(graphSnapshot.edges.map((edge) => edge.kind)),
        new Set(["inherits", "emits"]),
      );
      assert.ok(
        graphSnapshot.edges.some((edge) => edge.source === childId && edge.target === baseId),
        "expected filtered snapshot to include inheritance edges",
      );
      assert.ok(
        graphSnapshot.edges.some((edge) => edge.source === entry.id && edge.target === updated.id),
        "expected filtered snapshot to include emit edges",
      );
      const cappedGraph = graph.toProjectGraph(undefined, 3);
      const cappedIds = new Set(cappedGraph.nodes.map((node) => node.id));
      assert.equal(cappedGraph.nodes.length, 3);
      assert.equal(cappedGraph.truncated, true);
      assert.ok(
        cappedGraph.edges.every((edge) => cappedIds.has(edge.source) && cappedIds.has(edge.target)),
        "expected capped project graph edges to stay within returned nodes",
      );

      const entryNeighborhood = graph.toNeighborhood({
        rootId: entry.id,
        depth: 1,
        direction: "outgoing",
        edgeKinds: ["calls"],
      });
      assert.equal(entryNeighborhood.focusId, entry.id);
      assert.deepEqual(
        entryNeighborhood.nodes.map((node) => node.id).sort(),
        [entry.id, helper.id, inherited.id, childId, baseId].sort(),
        "expected outgoing call neighborhood to include callees plus containing contract",
      );
      assert.deepEqual(
        entryNeighborhood.edges.map((edge) => edge.target).sort(),
        [helper.id, inherited.id].sort(),
      );

      const positionNeighborhood = graph.toNeighborhood({
        uri: childUri,
        position: entry.selectionRange.start,
        depth: 0,
      });
      assert.equal(
        positionNeighborhood.focusId,
        entry.id,
        "expected position lookup to focus the innermost graph node",
      );

      const callPath = graph.toShortestPath({
        from: { nodeId: entry.id },
        to: { nodeId: inherited.id },
        direction: "outgoing",
        edgeKinds: ["calls"],
      });
      assert.equal(callPath.found, true);
      assert.equal(callPath.fromId, entry.id);
      assert.equal(callPath.toId, inherited.id);
      assert.deepEqual(
        callPath.edges.map((edge) => [edge.source, edge.target, edge.kind]),
        [[entry.id, inherited.id, "calls"]],
        "expected shortest path to preserve the call edge",
      );

      const positionPath = graph.toShortestPath({
        from: { uri: childUri, position: entry.selectionRange.start },
        to: { nodeId: updated.id },
        direction: "outgoing",
        edgeKinds: ["emits"],
      });
      assert.equal(positionPath.found, true);
      assert.deepEqual(
        positionPath.edges.map((edge) => edge.kind),
        ["emits"],
        "expected source-position endpoint to resolve before path search",
      );

      const filteredPath = graph.toShortestPath({
        from: { nodeId: entry.id },
        to: { nodeId: helper.id },
        direction: "outgoing",
        edgeKinds: ["inherits"],
      });
      assert.equal(filteredPath.found, false);
      assert.deepEqual(
        filteredPath.edges,
        [],
        "edge filters should be respected when no path exists",
      );

      const entrySearch = graph.search({
        query: "Child.entry",
        includeEdges: true,
        edgeDirection: "outgoing",
        edgeKinds: ["calls"],
      });
      assert.equal(entrySearch.matches[0]?.node.id, entry.id);
      assert.deepEqual(
        entrySearch.matches[0]?.edges?.map((edge) => edge.target).sort(),
        [helper.id, inherited.id].sort(),
        "expected search to include filtered adjacent call edges",
      );
      assert.deepEqual(
        entrySearch.matches[0]?.relatedNodes?.map((node) => node.id).sort(),
        [helper.id, inherited.id].sort(),
        "expected search to include endpoint nodes for adjacent edges",
      );
      assert.equal(entrySearch.indexStatus?.partial, false);
      assert.ok(
        (entrySearch.edgeQuality?.edgesByResolutionConfidence.parser ?? 0) >= 1,
        "expected search result edge-quality metadata to count parser-resolved edges",
      );
      assert.ok(
        (entrySearch.edgeQuality?.edgesByResolutionConfidence.solc ?? 0) >= 1,
        "expected search result edge-quality metadata to count solc-resolved edges",
      );

      const functionSearch = graph.search({
        query: "hel",
        kinds: ["function"],
        maxResults: 1,
      });
      assert.equal(functionSearch.matches.length, 1);
      assert.equal(functionSearch.matches[0]?.node.id, helper.id);
      assert.equal(
        functionSearch.matches.every((match) => match.node.kind === "function"),
        true,
        "expected graph search kind filter to restrict matches",
      );

      const cappedSearch = graph.search({ query: "c", maxResults: 1 });
      assert.equal(cappedSearch.matches.length, 1);
      assert.equal(cappedSearch.truncated, true);

      const unconstrainedHelperQuery = graph.query({
        kind: "callers",
        query: "helper",
      });
      assert.equal(
        unconstrainedHelperQuery.targetId,
        helperContract.id,
        "expected unconstrained text query to show why callers must request callable targets",
      );

      const helperCallers = graph.query({
        kind: "callers",
        query: "helper",
        targetKinds: ["function"],
      });
      assert.equal(helperCallers.found, true);
      assert.equal(helperCallers.targetId, helper.id);
      assert.ok(
        helperCallers.nodes.some((node) => node.id === entry.id),
        "expected callers query to include the function that calls helper",
      );
      assert.ok(
        helperCallers.edges.some((edge) => edge.source === entry.id && edge.target === helper.id),
        "expected callers query to include the incoming call edge",
      );
      assert.equal(helperCallers.indexStatus?.partial, false);
      assert.equal(
        helperCallers.edgeQuality?.lowConfidenceEdgeCount,
        0,
        "expected parser-resolved caller edges to avoid low-confidence warnings",
      );

      const entryCallees = graph.query({
        kind: "callees",
        target: { nodeId: entry.id },
      });
      assert.equal(entryCallees.found, true);
      assert.deepEqual(
        entryCallees.edges.map((edge) => edge.target).sort(),
        [helper.id, inherited.id, updated.id, unauthorized.id].sort(),
        "expected callees query to include outgoing calls, emitted events, and custom-error reverts",
      );

      const updatedCallers = graph.query({
        kind: "callers",
        target: { nodeId: updated.id },
        targetKinds: ["event"],
      });
      assert.equal(updatedCallers.found, true);
      assert.equal(updatedCallers.targetId, updated.id);
      assert.ok(
        updatedCallers.edges.some((edge) => edge.source === entry.id && edge.target === updated.id),
        "expected callers query to include the function that emits the event",
      );

      const updatedSignatureCallers = graph.query({
        kind: "callers",
        query: "Child.Updated(uint256 value)",
        targetKinds: ["event"],
      });
      assert.equal(updatedSignatureCallers.found, true);
      assert.equal(updatedSignatureCallers.targetId, updated.id);

      const unauthorizedCallers = graph.query({
        kind: "callers",
        target: { nodeId: unauthorized.id },
        targetKinds: ["error"],
      });
      assert.equal(unauthorizedCallers.found, true);
      assert.equal(unauthorizedCallers.targetId, unauthorized.id);
      assert.ok(
        unauthorizedCallers.edges.some(
          (edge) => edge.source === entry.id && edge.target === unauthorized.id,
        ),
        "expected callers query to include the function that reverts with the custom error",
      );

      const unauthorizedSignatureCallers = graph.query({
        kind: "callers",
        query: "Child.Unauthorized()",
        targetKinds: ["error"],
      });
      assert.equal(unauthorizedSignatureCallers.found, true);
      assert.equal(unauthorizedSignatureCallers.targetId, unauthorized.id);

      const nonCallableCallers = graph.query({
        kind: "callers",
        target: { nodeId: count.id },
        targetKinds: ["function"],
      });
      assert.equal(
        nonCallableCallers.found,
        false,
        "explicit callers targets must also respect callable target constraints",
      );
      assert.equal(nonCallableCallers.missReason, "targetKindMismatch");
      assert.deepEqual(nonCallableCallers.nodes, []);
      assert.deepEqual(nonCallableCallers.edges, []);

      const nonCallableTextCallers = graph.query({
        kind: "callers",
        query: "count",
        targetKinds: ["function"],
      });
      assert.equal(
        nonCallableTextCallers.found,
        false,
        "text callers targets must report when only non-callable symbols match",
      );
      assert.equal(nonCallableTextCallers.missReason, "targetKindMismatch");
      assert.deepEqual(nonCallableTextCallers.nodes, []);
      assert.deepEqual(nonCallableTextCallers.edges, []);

      const countImpact = graph.query({
        kind: "impact",
        target: { nodeId: count.id },
        maxDepth: 1,
      });
      assert.equal(countImpact.found, true);
      assert.ok(
        countImpact.nodes.some((node) => node.id === entry.id),
        "expected impact query to include functions that read or write the target state variable",
      );
      assert.ok(
        countImpact.edges.some(
          (edge) =>
            edge.source === entry.id &&
            edge.target === count.id &&
            (edge.kind === "reads" || edge.kind === "writes"),
        ),
        "expected impact query to include incoming state access edges",
      );

      graph.recordRequestDuration("query", 750);
      graph.recordRequestDuration("search", 25);
      graph.setSolcBridge({
        getDeclarationInfoAt: () => null,
        getCacheStatus: () => ({
          available: true,
          stale: true,
          cachedFileCount: 3,
          staleFileCount: 1,
          staleFiles: [path.join(tmpDir, "src/Child.sol")],
          lastBuildTimeMs: 123,
        }),
      } as unknown as SolcBridge);
      const stats = graph.getStats();
      assert.equal(stats.nodesByKind.contract, 3);
      assert.equal(stats.edgesByKind.inherits, 1);
      assert.ok((stats.edgesByKind.usesType ?? 0) >= 3);
      assert.ok(
        (stats.edgesByResolutionConfidence?.solc ?? 0) >= 1,
        "expected stats to count solc-confirmed edges",
      );
      assert.ok(
        (stats.edgesByResolutionConfidence?.parser ?? 0) >= 1,
        "expected stats to count parser-resolved edges",
      );
      assert.ok(
        (stats.edgesByResolutionConfidence?.unknown ?? 0) >= 1,
        "expected stats to count structural edges with unknown confidence",
      );
      assert.equal(stats.unresolvedEdgeCount, 0);
      assert.ok(stats.edgeCount >= graphSnapshot.edges.length);
      assert.equal(stats.filesByTier.project, 3);
      assert.ok(
        typeof stats.lastRebuildDurationMs === "number",
        "expected rebuild timing to be recorded",
      );
      assert.equal(stats.lastRequestDurationsMs?.query, 750);
      assert.equal(stats.lastRequestDurationsMs?.search, 25);
      assert.equal(stats.performance?.state, "warning");
      assert.equal(stats.performance?.slowestRequest?.kind, "query");
      assert.match(
        stats.performance?.warnings.join("\n") ?? "",
        /Slowest graph request \(query\) took 750ms/,
      );
      assert.equal(stats.compilerStatus?.available, true);
      assert.equal(stats.compilerStatus?.stale, true);
      assert.equal(stats.compilerStatus?.staleFileCount, 1);

      const cacheDir = path.join(tmpDir, ".cache", "graph-index");
      graph.writeCache(cacheDir);
      const restoredGraph = new GraphIndex(parser, workspace, resolver, symbolIndex);
      assert.equal(restoredGraph.restoreFromCache(cacheDir), true);
      assert.equal(restoredGraph.getStats().cacheHit, true);
      assert.equal(restoredGraph.getNodes().length, graph.getNodes().length);
      assert.equal(restoredGraph.getEdges().length, graph.getEdges().length);
      assert.deepEqual(
        restoredGraph
          .getOutgoingEdges(entry.id, "calls")
          .map((edge) => edge.target)
          .sort(),
        [helper.id, inherited.id].sort(),
        "expected cached graph to restore call edges",
      );
      assert.equal(
        restoredGraph
          .getOutgoingEdges(entry.id, "calls")
          .find((edge) => edge.target === inherited.id)?.resolutionConfidence,
        "solc",
        "expected cached graph to restore promoted edge confidence",
      );
      assert.match(
        restoredGraph
          .getOutgoingEdges(entry.id, "calls")
          .find((edge) => edge.target === inherited.id)?.evidence?.summary ?? "",
        /calls: inherited/,
        "expected cached graph to restore edge evidence",
      );
      const updatedBaseForRestore = files["src/Base.sol"].replace(
        "function inherited() internal {}",
        "function cachedInherited() internal {}",
      );
      parser.parse(baseUri, updatedBaseForRestore);
      symbolIndex.updateFile(baseUri);
      assert.deepEqual(
        restoredGraph.updateFileAndDependents(baseUri, false).sort(),
        [baseUri, childUri].sort(),
        "expected restored graph to use rebuilt import reverse index for dependent refresh",
      );
      assert.equal(
        restoredGraph.getOutgoingEdges(childId, "inherits")[0]?.target,
        baseId,
        "expected restored graph refresh to preserve inherited base edge",
      );
      parser.parse(baseUri, files["src/Base.sol"]);
      symbolIndex.updateFile(baseUri);
      restoredGraph.updateFileAndDependents(baseUri, false);

      const cacheFiles = fs.readdirSync(cacheDir).filter((name) => name.endsWith(".json"));
      assert.equal(cacheFiles.length, 1);
      const cachePath = path.join(cacheDir, cacheFiles[0]);
      const originalCache = fs.readFileSync(cachePath, "utf-8");
      const corruptedCache = JSON.parse(originalCache) as {
        files?: { uri?: string; edges?: { source?: string; target?: string; kind?: string }[] }[];
      };
      const childEntry = corruptedCache.files?.find((file) => file.uri === childUri);
      childEntry?.edges?.push({
        source: entry.id,
        target: "missing:node",
        kind: "calls",
      });
      childEntry?.edges?.push({
        source: entry.id,
        target: helper.id,
        kind: "notARealEdgeKind",
      });
      fs.writeFileSync(cachePath, JSON.stringify(corruptedCache), "utf-8");
      const sanitizedCacheGraph = new GraphIndex(parser, workspace, resolver, symbolIndex);
      assert.equal(sanitizedCacheGraph.restoreFromCache(cacheDir), true);
      assert.equal(
        sanitizedCacheGraph.getEdges().some((edge) => edge.target === "missing:node"),
        false,
        "cache restore should drop edges whose target node is absent",
      );
      assert.equal(
        sanitizedCacheGraph.getEdges().some((edge) => String(edge.kind) === "notARealEdgeKind"),
        false,
        "cache restore should drop edges with unknown kinds",
      );
      fs.writeFileSync(cachePath, originalCache, "utf-8");

      fs.writeFileSync(path.join(tmpDir, "foundry.toml"), "[profile.default]\nsrc = 'src'\n");
      const configStaleGraph = new GraphIndex(parser, workspace, resolver, symbolIndex);
      assert.equal(
        configStaleGraph.restoreFromCache(cacheDir),
        false,
        "changed foundry.toml fingerprint should reject stale graph cache",
      );
      fs.rmSync(path.join(tmpDir, "foundry.toml"));
      assert.equal(
        new GraphIndex(parser, workspace, resolver, symbolIndex).restoreFromCache(cacheDir),
        true,
      );

      fs.writeFileSync(path.join(tmpDir, "remappings.txt"), "@lib/=lib/\n");
      const remappingStaleGraph = new GraphIndex(parser, workspace, resolver, symbolIndex);
      assert.equal(
        remappingStaleGraph.restoreFromCache(cacheDir),
        false,
        "changed remappings.txt fingerprint should reject stale graph cache",
      );
      fs.rmSync(path.join(tmpDir, "remappings.txt"));
      assert.equal(
        new GraphIndex(parser, workspace, resolver, symbolIndex).restoreFromCache(cacheDir),
        true,
      );

      fs.appendFileSync(path.join(tmpDir, "src/Child.sol"), "\n// cache invalidation\n");
      const staleGraph = new GraphIndex(parser, workspace, resolver, symbolIndex);
      assert.equal(
        staleGraph.restoreFromCache(cacheDir),
        true,
        "changed source file fingerprint should preserve cache entries for unchanged files",
      );
      assert.ok(staleGraph.getNode(baseId), "expected unchanged Base file to restore from cache");
      assert.equal(
        staleGraph.getNode(childId),
        undefined,
        "expected changed Child file cache entry to be dropped",
      );
      staleGraph.ensureWorkspaceDeclarations();
      assert.ok(staleGraph.getNode(childId), "expected missing Child declarations to be rebuilt");
      assert.equal(staleGraph.getStats().relationshipIndexComplete, false);

      const helperPath = path.join(tmpDir, "src/helper.sol");
      const helperOriginalStat = fs.statSync(helperPath);
      const helperChangedSameSize = files["src/helper.sol"].replace("helper", "unused");
      assert.equal(
        helperChangedSameSize.length,
        files["src/helper.sol"].length,
        "test fixture must keep the edited helper file the same size",
      );
      fs.writeFileSync(helperPath, helperChangedSameSize, "utf-8");
      fs.utimesSync(helperPath, helperOriginalStat.atime, helperOriginalStat.mtime);
      const sameStatChangedGraph = new GraphIndex(parser, workspace, resolver, symbolIndex);
      assert.equal(
        sameStatChangedGraph.restoreFromCache(cacheDir),
        true,
        "same-size same-mtime edits should still preserve unchanged cache entries",
      );
      assert.equal(
        sameStatChangedGraph.getNode(helperContract.id),
        undefined,
        "same-size same-mtime source edits must drop stale cached graph entries",
      );

      fs.writeFileSync(
        basePath,
        `pragma solidity ^0.8.24;
contract Base {
    function renamedInherited() internal {}
}
`,
        "utf-8",
      );
      parser.parse(baseUri, fs.readFileSync(basePath, "utf-8"));
      symbolIndex.updateFile(baseUri);
      graph.updateFileAndDependents(baseUri);
      assert.equal(
        graph.getOutgoingEdges(childId, "inherits")[0]?.target,
        baseId,
        "dependent refresh should rebuild inheritance edges from importing files",
      );
      assert.equal(
        graph.getNode(inherited.id),
        undefined,
        "removed base functions should disappear from the graph",
      );
      assert.ok(
        !graph.getOutgoingEdges(entry.id, "calls").some((edge) => edge.target === inherited.id),
        "dependent refresh should remove stale call edges to removed inherited functions",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("indexes file-level event declarations", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-index-file-event-test-"));
    try {
      const filePath = path.join(tmpDir, "src/Events.sol");
      const contents = `pragma solidity ^0.8.24;

event FileClaimed(address indexed account, uint256 amount);
`;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, contents, "utf-8");
      const uri = URI.file(filePath).toString();
      const parser = new SolidityParser();
      parser.parse(uri, contents);
      const workspace = makeWorkspace(tmpDir, [uri]);
      const symbolIndex = new SymbolIndex(parser, workspace);
      symbolIndex.updateFile(uri);
      const resolver = new SemanticResolver(parser, workspace, symbolIndex);
      const graph = new GraphIndex(parser, workspace, resolver, symbolIndex);

      graph.rebuildWorkspace();

      const event = graph
        .getNodes()
        .find((node) => node.kind === "event" && node.name === "FileClaimed");
      assert.ok(event, "expected file-level event node");
      assert.equal(event.containerName, undefined);
      assert.equal(event.detail, "FileClaimed(address indexed account, uint256 amount)");
      assert.ok(
        graph.getOutgoingEdges(`file:${uri}`, "contains").some((edge) => edge.target === event.id),
        "expected file node to contain the file-level event",
      );

      const canonicalSignature = graph.query({
        kind: "callers",
        query: "FileClaimed(address,uint256)",
        targetKinds: ["event"],
      });
      assert.equal(canonicalSignature.found, true);
      assert.equal(canonicalSignature.targetId, event.id);

      const displaySignature = graph.query({
        kind: "callers",
        query: "FileClaimed(address indexed account, uint256 amount)",
        targetKinds: ["event"],
      });
      assert.equal(displaySignature.found, true);
      assert.equal(displaySignature.targetId, event.id);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("indexes relationship edges for file-level declarations", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-index-file-relationships-"));
    try {
      const filePath = path.join(tmpDir, "src/Claims.sol");
      const contents = `pragma solidity ^0.8.24;

event Claimed(address indexed account, uint256 amount);
error ClaimDenied();

struct Receipt {
    address account;
}

function helper(address account) pure returns (address) {
    return account;
}

function helper(uint256 amount) pure returns (uint256) {
    return amount + 1;
}

function redeemClaims(Receipt memory receipt, uint256 amount, address account) {
    helper(amount);
    helper(account);
    emit Claimed(receipt.account, amount);
    if (amount == 0) revert ClaimDenied();
}

contract Consumer {
    function run(Receipt memory receipt) external {
        redeemClaims(receipt, 1, address(this));
        emit Claimed(receipt.account, 1);
        revert ClaimDenied();
    }
}
`;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, contents, "utf-8");
      const uri = URI.file(filePath).toString();
      const parser = new SolidityParser();
      parser.parse(uri, contents);
      const workspace = makeWorkspace(tmpDir, [uri]);
      const symbolIndex = new SymbolIndex(parser, workspace);
      symbolIndex.updateFile(uri);
      const resolver = new SemanticResolver(parser, workspace, symbolIndex);
      const graph = new GraphIndex(parser, workspace, resolver, symbolIndex);

      graph.rebuildWorkspace();

      const helperUint = graph
        .getNodes()
        .find(
          (node) =>
            node.kind === "function" && node.detail === "helper(uint256 amount) returns (uint256)",
        );
      const helperAddress = graph
        .getNodes()
        .find(
          (node) =>
            node.kind === "function" && node.detail === "helper(address account) returns (address)",
        );
      const redeemClaims = graph
        .getNodes()
        .find((node) => node.kind === "function" && node.name === "redeemClaims");
      const claimed = graph
        .getNodes()
        .find((node) => node.kind === "event" && node.name === "Claimed");
      const denied = graph
        .getNodes()
        .find((node) => node.kind === "error" && node.name === "ClaimDenied");
      const receipt = graph
        .getNodes()
        .find((node) => node.kind === "struct" && node.name === "Receipt");
      const run = graph
        .getNodes()
        .find(
          (node) =>
            node.kind === "function" && node.name === "run" && node.containerName === "Consumer",
        );
      assert.ok(helperUint, "expected file-level uint256 helper function node");
      assert.ok(helperAddress, "expected file-level address helper function node");
      assert.ok(redeemClaims, "expected file-level redeemClaims function node");
      assert.ok(claimed, "expected file-level Claimed event node");
      assert.ok(denied, "expected file-level ClaimDenied error node");
      assert.ok(receipt, "expected file-level Receipt struct node");
      assert.ok(run, "expected Consumer.run graph node");

      assert.ok(
        graph
          .getOutgoingEdges(redeemClaims.id, "calls")
          .some((edge) => edge.target === helperUint.id),
        "expected file-level function body to call uint256 helper overload",
      );
      assert.ok(
        graph
          .getOutgoingEdges(redeemClaims.id, "calls")
          .some((edge) => edge.target === helperAddress.id),
        "expected file-level function body to call address helper overload",
      );
      assert.equal(
        graph
          .getOutgoingEdges(redeemClaims.id, "calls")
          .filter((edge) => edge.target === helperAddress.id).length,
        1,
        "expected exactly one address helper call edge",
      );
      assert.ok(
        graph.getOutgoingEdges(redeemClaims.id, "emits").some((edge) => edge.target === claimed.id),
        "expected file-level function body to emit a file-level event",
      );
      assert.ok(
        graph
          .getOutgoingEdges(redeemClaims.id, "revertsWith")
          .some((edge) => edge.target === denied.id),
        "expected file-level function body to revert with a file-level error",
      );
      assert.ok(
        graph
          .getOutgoingEdges(redeemClaims.id, "usesType")
          .some((edge) => edge.target === receipt.id),
        "expected file-level function parameters to reference file-level types",
      );
      assert.ok(
        graph.getOutgoingEdges(run.id, "calls").some((edge) => edge.target === redeemClaims.id),
        "expected contract body to call a visible file-level function",
      );
      assert.ok(
        graph.getOutgoingEdges(run.id, "emits").some((edge) => edge.target === claimed.id),
        "expected contract body to emit a visible file-level event",
      );
      assert.ok(
        graph.getOutgoingEdges(run.id, "revertsWith").some((edge) => edge.target === denied.id),
        "expected contract body to revert with a visible file-level error",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolves namespace-imported file-level relationship targets", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-index-file-namespace-"));
    try {
      const files = {
        "src/Claims.sol": `pragma solidity ^0.8.24;

event Claimed(address indexed account, uint256 amount);
error ClaimDenied();

function redeemClaims(uint256 amount) {
    amount;
}
`,
        "src/UseClaims.sol": `pragma solidity ^0.8.24;
import * as Claims from "./Claims.sol";

function runFree(uint256 amount) {
    Claims.redeemClaims(amount);
    emit Claims.Claimed(address(0), amount);
    if (amount == 0) revert Claims.ClaimDenied();
}

contract Consumer {
    function run(uint256 amount) external {
        Claims.redeemClaims(amount);
        emit Claims.Claimed(msg.sender, amount);
        if (amount == 0) revert Claims.ClaimDenied();
    }
}
`,
      };

      const uris: string[] = [];
      const parser = new SolidityParser();
      for (const [name, contents] of Object.entries(files)) {
        const filePath = path.join(tmpDir, name);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, contents, "utf-8");
        const uri = URI.file(filePath).toString();
        uris.push(uri);
        parser.parse(uri, contents);
      }
      const workspace = makeWorkspace(tmpDir, uris);
      const symbolIndex = new SymbolIndex(parser, workspace);
      for (const uri of uris) symbolIndex.updateFile(uri);
      const resolver = new SemanticResolver(parser, workspace, symbolIndex);
      const graph = new GraphIndex(parser, workspace, resolver, symbolIndex);

      graph.rebuildWorkspace();

      const redeemClaims = graph
        .getNodes()
        .find((node) => node.kind === "function" && node.name === "redeemClaims");
      const claimed = graph
        .getNodes()
        .find((node) => node.kind === "event" && node.name === "Claimed");
      const denied = graph
        .getNodes()
        .find((node) => node.kind === "error" && node.name === "ClaimDenied");
      const runFree = graph
        .getNodes()
        .find((node) => node.kind === "function" && node.name === "runFree");
      const run = graph
        .getNodes()
        .find(
          (node) =>
            node.kind === "function" && node.name === "run" && node.containerName === "Consumer",
        );
      assert.ok(redeemClaims, "expected namespace target free function node");
      assert.ok(claimed, "expected namespace target file-level event node");
      assert.ok(denied, "expected namespace target file-level error node");
      assert.ok(runFree, "expected namespaced free-function caller node");
      assert.ok(run, "expected namespaced contract caller node");

      for (const source of [runFree, run]) {
        assert.ok(
          graph
            .getOutgoingEdges(source.id, "calls")
            .some((edge) => edge.target === redeemClaims.id),
          `expected ${source.qualifiedName} to call Claims.redeemClaims`,
        );
        assert.ok(
          graph.getOutgoingEdges(source.id, "emits").some((edge) => edge.target === claimed.id),
          `expected ${source.qualifiedName} to emit Claims.Claimed`,
        );
        assert.ok(
          graph
            .getOutgoingEdges(source.id, "revertsWith")
            .some((edge) => edge.target === denied.id),
          `expected ${source.qualifiedName} to revert with Claims.ClaimDenied`,
        );
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("excludes test files and Foundry Test descendants unless requested", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-index-include-tests-"));
    try {
      const files = {
        "src/Prod.sol": `pragma solidity ^0.8.24;
contract Prod { function run() external {} }
`,
        "src/SourceHarness.sol": `pragma solidity ^0.8.24;
import "../lib/forge-std/Test.sol";
contract SourceHarness is Test { function test_run() external {} }
`,
        "src/ProjectTestName.sol": `pragma solidity ^0.8.24;
contract Test {}
contract LegitSource is Test { function run() external {} }
`,
        "src/UsesDep.sol": `pragma solidity ^0.8.24;
import "../lib/Dep.sol";
contract UsesDep is Dep { function run() external {} }
`,
        "src/UsesNonFoundryTest.sol": `pragma solidity ^0.8.24;
import "../lib/other/Test.sol";
contract UsesNonFoundryTest is Test { function run() external {} }
`,
        "lib/Dep.sol": `pragma solidity ^0.8.24;
contract Dep {}
`,
        "lib/other/Test.sol": `pragma solidity ^0.8.24;
contract Test {}
`,
        "lib/forge-std/Test.sol": `pragma solidity ^0.8.24;
contract Test {}
`,
        "test/Prod.t.sol": `pragma solidity ^0.8.24;
contract ProdTest { function test_Run() external {} }
`,
      };
      const uris: string[] = [];
      const parser = new SolidityParser();
      for (const [name, contents] of Object.entries(files)) {
        const filePath = path.join(tmpDir, name);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, contents, "utf-8");
        const uri = URI.file(filePath).toString();
        uris.push(uri);
        parser.parse(uri, contents);
      }
      const workspace = makeWorkspace(tmpDir, uris);
      const symbolIndex = new SymbolIndex(parser, workspace);
      for (const uri of uris) symbolIndex.updateFile(uri);
      const resolver = new SemanticResolver(parser, workspace, symbolIndex);
      const graph = new GraphIndex(parser, workspace, resolver, symbolIndex);

      graph.rebuildWorkspace();

      const defaultGraph = graph.toProjectGraph();
      assert.ok(defaultGraph.nodes.some((node) => node.name === "Prod"));
      assert.ok(!defaultGraph.nodes.some((node) => node.name === "ProdTest"));
      assert.ok(!defaultGraph.nodes.some((node) => node.name === "SourceHarness"));
      assert.ok(!defaultGraph.nodes.some((node) => node.name === "test_run"));
      assert.ok(
        defaultGraph.nodes.some((node) => node.name === "LegitSource"),
        "project contracts extending a project contract named Test should stay visible",
      );
      assert.ok(
        defaultGraph.nodes.some((node) => node.name === "UsesDep"),
        "project contracts extending hidden non-test dependencies should stay visible",
      );
      assert.ok(
        defaultGraph.nodes.some((node) => node.name === "UsesNonFoundryTest"),
        "project contracts extending a non-Foundry dependency named Test should stay visible",
      );
      const defaultGraphNodeIds = new Set(defaultGraph.nodes.map((node) => node.id));
      assert.ok(
        defaultGraph.edges.every(
          (edge) => defaultGraphNodeIds.has(edge.source) && defaultGraphNodeIds.has(edge.target),
        ),
        "default graph snapshots should not include edges to hidden or unindexed dependency nodes",
      );
      const depSearch = graph.search({ query: "UsesDep", includeEdges: true });
      assert.ok(depSearch.matches.length > 0, "expected UsesDep search match");
      assert.ok(
        depSearch.matches.every((match) =>
          (match.edges ?? []).every(
            (edge) => defaultGraphNodeIds.has(edge.source) && defaultGraphNodeIds.has(edge.target),
          ),
        ),
        "search edge previews should not include edges to hidden or unindexed dependency nodes",
      );

      const withTests = graph.toProjectGraph(undefined, undefined, true);
      assert.ok(withTests.nodes.some((node) => node.name === "ProdTest"));
      assert.ok(withTests.nodes.some((node) => node.name === "SourceHarness"));
      assert.ok(withTests.nodes.some((node) => node.name === "test_run"));

      assert.ok(
        graph
          .search({ query: "ProdTest" })
          .matches.every((match) => match.node.name !== "ProdTest"),
        "default graph search should exclude test-file nodes",
      );
      assert.equal(
        graph.search({ query: "SourceHarness" }).matches.length,
        0,
        "default graph search should exclude Foundry Test descendants outside test/",
      );
      assert.equal(
        graph.search({ query: "ProdTest", includeTests: true }).matches[0]?.node.name,
        "ProdTest",
        "includeTests should make test-file nodes searchable",
      );
      assert.equal(
        graph.search({ query: "SourceHarness", includeTests: true }).matches[0]?.node.name,
        "SourceHarness",
        "includeTests should make Foundry Test descendants searchable",
      );
      assert.equal(
        graph.query({ kind: "callees", query: "test_run", includeTests: true }).found,
        true,
        "includeTests should propagate through graph query target resolution",
      );
      const hiddenSignatureQuery = graph.query({
        kind: "callers",
        query: "SourceHarness.test_run()",
        targetKinds: ["function"],
      });
      assert.equal(
        hiddenSignatureQuery.found,
        false,
        "exact signature queries should respect the default test scope",
      );
      assert.equal(
        hiddenSignatureQuery.missReason,
        "targetNotFound",
        "hidden exact signature matches should not be reported as kind mismatches",
      );
      const visibleSignatureQuery = graph.query({
        kind: "callers",
        query: "SourceHarness.test_run()",
        targetKinds: ["function"],
        includeTests: true,
      });
      assert.equal(
        visibleSignatureQuery.found,
        true,
        "includeTests should expose exact signature query targets",
      );

      const sourceHarness = graph
        .getNodes()
        .find((node) => node.name === "SourceHarness" && node.kind === "contract");
      const prod = graph
        .getNodes()
        .find((node) => node.name === "Prod" && node.kind === "contract");
      assert.ok(sourceHarness, "expected indexed SourceHarness node before scope filtering");
      assert.ok(prod, "expected indexed Prod node before scope filtering");

      const hiddenNeighborhood = graph.toNeighborhood({ rootId: sourceHarness.id });
      assert.equal(
        hiddenNeighborhood.nodes.length,
        0,
        "focused neighborhoods should hide Foundry Test descendants by default",
      );
      const visibleNeighborhood = graph.toNeighborhood({
        rootId: sourceHarness.id,
        includeTests: true,
      });
      assert.ok(
        visibleNeighborhood.nodes.some((node) => node.id === sourceHarness.id),
        "includeTests should expose Foundry Test descendant neighborhoods",
      );

      const hiddenPath = graph.toShortestPath({
        from: { nodeId: sourceHarness.id },
        to: { nodeId: prod.id },
      });
      assert.equal(
        hiddenPath.found,
        false,
        "path queries should hide Foundry Test descendants by default",
      );
      const visibleSelfPath = graph.toShortestPath({
        from: { nodeId: sourceHarness.id },
        to: { nodeId: sourceHarness.id },
        includeTests: true,
      });
      assert.equal(
        visibleSelfPath.found,
        true,
        "includeTests should expose Foundry Test descendant path endpoints",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolves typed receiver calls without unrelated same-name contamination", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-index-receiver-test-"));
    try {
      const files = {
        "src/PoolVault.sol": `pragma solidity ^0.8.24;
import "./IERC4626.sol";
abstract contract MultiAssetVault {}
abstract contract PoolVault is MultiAssetVault {
    mapping(uint256 => mapping(address => IERC4626)) public vaults;

    function effectiveBalance(uint256 poolId) external view returns (uint256 bal) {
        IERC4626 vault = vaults[poolId][address(0)];
        uint256 shares = 1;
        return vault.previewRedeem(shares);
    }

    function assetBalanceV4(uint256 poolId) external view returns (uint256 bal) {
        IERC4626 vault = vaults[poolId][address(0)];
        uint256 shares = 1;
        return vault.convertToAssets(shares);
    }
}
`,
        "test/MockERC4626.sol": `pragma solidity ^0.8.24;
contract MockERC4626 {
    function convertToAssets(uint256 shares) external pure returns (uint256) {
        return shares;
    }

    function previewRedeem(uint256 shares) external pure returns (uint256) {
        return shares;
    }
}
`,
        "src/IERC4626.sol": `pragma solidity ^0.8.24;
interface IERC4626 {
    function convertToAssets(uint256 shares) external view returns (uint256);
    function previewRedeem(uint256 shares) external view returns (uint256);
}
`,
        "src/Comments.sol": `pragma solidity ^0.8.24;
contract Comments {
    function caller() external pure {
        string memory text = "helper()";
        // helper();
        /* helper(); */
    }

    function helper() internal pure {}
}
`,
      };

      const parser = new SolidityParser();
      const uris: string[] = [];
      for (const [name, contents] of Object.entries(files)) {
        const filePath = path.join(tmpDir, name);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, contents, "utf-8");
        const uri = URI.file(filePath).toString();
        uris.push(uri);
        parser.parse(uri, contents);
      }

      const workspace = makeWorkspace(tmpDir, uris);
      const symbolIndex = new SymbolIndex(parser, workspace);
      for (const uri of uris) symbolIndex.updateFile(uri);
      const resolver = new SemanticResolver(parser, workspace, symbolIndex);
      const graph = new GraphIndex(parser, workspace, resolver, symbolIndex);
      graph.rebuildWorkspace();

      const poolVaultEntry = graph
        .getNodes()
        .find((node) => node.name === "effectiveBalance" && node.containerName === "PoolVault");
      const poolVaultAssetBalance = graph
        .getNodes()
        .find((node) => node.name === "assetBalanceV4" && node.containerName === "PoolVault");
      const interfaceConvert = graph
        .getNodes()
        .find((node) => node.name === "convertToAssets" && node.containerName === "IERC4626");
      const interfacePreview = graph
        .getNodes()
        .find((node) => node.name === "previewRedeem" && node.containerName === "IERC4626");
      const mockConvert = graph
        .getNodes()
        .find((node) => node.name === "convertToAssets" && node.containerName === "MockERC4626");
      const mockPreview = graph
        .getNodes()
        .find((node) => node.name === "previewRedeem" && node.containerName === "MockERC4626");
      assert.ok(poolVaultEntry, "expected PoolVault.effectiveBalance node");
      assert.ok(poolVaultAssetBalance, "expected PoolVault.assetBalanceV4 node");
      assert.ok(interfaceConvert, "expected IERC4626.convertToAssets node");
      assert.ok(interfacePreview, "expected IERC4626.previewRedeem node");
      assert.ok(mockConvert, "expected unrelated MockERC4626.convertToAssets node");
      assert.ok(mockPreview, "expected unrelated MockERC4626.previewRedeem node");

      const calls = graph.getOutgoingEdges(poolVaultEntry.id, "calls");
      const previewRedeemEdge = calls.find((edge) => edge.target === interfacePreview.id);
      assert.ok(
        previewRedeemEdge,
        "expected previewRedeem receiver call to resolve to imported IERC4626",
      );
      assert.equal(previewRedeemEdge.metadata?.receiver, "vault");
      assert.equal(previewRedeemEdge.metadata?.receiverType, "IERC4626");
      assert.equal(previewRedeemEdge.metadata?.receiverResolution, "localVariable");
      assert.match(previewRedeemEdge.evidence?.summary ?? "", /calls: IERC4626\.previewRedeem/);
      assert.ok(
        calls.every((edge) => edge.target !== mockPreview.id),
        "did not expect previewRedeem receiver call to resolve to unrelated mock",
      );

      const assetCalls = graph.getOutgoingEdges(poolVaultAssetBalance.id, "calls");
      const convertToAssetsEdge = assetCalls.find((edge) => edge.target === interfaceConvert.id);
      assert.ok(
        convertToAssetsEdge,
        "expected convertToAssets receiver call to resolve to imported IERC4626",
      );
      assert.equal(convertToAssetsEdge.metadata?.receiver, "vault");
      assert.equal(convertToAssetsEdge.metadata?.receiverType, "IERC4626");
      assert.equal(convertToAssetsEdge.metadata?.receiverResolution, "localVariable");
      assert.match(convertToAssetsEdge.evidence?.summary ?? "", /calls: IERC4626\.convertToAssets/);
      assert.ok(
        assetCalls.every((edge) => edge.target !== mockConvert.id),
        "did not expect convertToAssets receiver call to resolve to unrelated mock",
      );

      const commentsCaller = graph
        .getNodes()
        .find((node) => node.name === "caller" && node.containerName === "Comments");
      assert.ok(commentsCaller, "expected Comments.caller node");
      assert.equal(
        graph.getOutgoingEdges(commentsCaller.id, "calls").length,
        0,
        "comments and strings should not create call edges",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("classifies mapping and delete state access through raw AST expressions", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-index-state-access-test-"));
    try {
      const source = `pragma solidity ^0.8.24;
contract Ledger {
    mapping(address => uint256) public balances;
    uint256 public total;

    function edit(address user) external {
        balances[user] = 1;
        balances[user] += 2;
        delete balances[user];
        total = balances[user];
    }
}
`;
      const filePath = path.join(tmpDir, "src/Ledger.sol");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, source, "utf-8");
      const uri = URI.file(filePath).toString();

      const parser = new SolidityParser();
      parser.parse(uri, source);
      const workspace = makeWorkspace(tmpDir, [uri]);
      const symbolIndex = new SymbolIndex(parser, workspace);
      symbolIndex.updateFile(uri);
      const resolver = new SemanticResolver(parser, workspace, symbolIndex);
      const graph = new GraphIndex(parser, workspace, resolver, symbolIndex);
      graph.rebuildWorkspace();

      const edit = graph
        .getNodes()
        .find((node) => node.name === "edit" && node.containerName === "Ledger");
      const balances = graph
        .getNodes()
        .find((node) => node.name === "balances" && node.containerName === "Ledger");
      const total = graph
        .getNodes()
        .find((node) => node.name === "total" && node.containerName === "Ledger");
      assert.ok(edit, "expected Ledger.edit node");
      assert.ok(balances, "expected Ledger.balances node");
      assert.ok(total, "expected Ledger.total node");

      const balanceWrites = graph
        .getOutgoingEdges(edit.id, "writes")
        .filter((edge) => edge.target === balances.id);
      const balanceReads = graph
        .getOutgoingEdges(edit.id, "reads")
        .filter((edge) => edge.target === balances.id);
      assert.equal(balanceWrites.length, 3, "expected assignment, compound assignment, and delete");
      assert.equal(balanceReads.length, 2, "expected compound assignment and final read");
      assert.ok(
        graph.getOutgoingEdges(edit.id, "writes").some((edge) => edge.target === total.id),
        "expected assignment to scalar state variable to be classified as a write",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("clears stale graph nodes when a file update has no parser result", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-index-stale-parse-test-"));
    try {
      const source = `pragma solidity ^0.8.24;
contract Gone {
    function oldName() external {}
}
`;
      const filePath = path.join(tmpDir, "src/Gone.sol");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, source, "utf-8");
      const uri = URI.file(filePath).toString();

      const parser = new SolidityParser();
      parser.parse(uri, source);
      const workspace = makeWorkspace(tmpDir, [uri]);
      const symbolIndex = new SymbolIndex(parser, workspace);
      symbolIndex.updateFile(uri);
      const resolver = new SemanticResolver(parser, workspace, symbolIndex);
      const graph = new GraphIndex(parser, workspace, resolver, symbolIndex);
      graph.rebuildWorkspace();

      const oldNode = graph.getNodes().find((node) => node.name === "oldName");
      assert.ok(oldNode, "expected old graph node before parser cache is cleared");

      parser.removeFile(uri);
      graph.updateFile(uri);

      assert.equal(
        graph.getNode(oldNode.id),
        undefined,
        "expected stale nodes to be removed when no parser result is available",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("can refresh changed files and import dependents without synchronous relationship indexing", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-index-queued-update-test-"));
    try {
      const files = {
        "src/Base.sol": `pragma solidity ^0.8.24;
contract Base {
    function ping() internal pure returns (uint256) {
        return 1;
    }
}
`,
        "src/Child.sol": `pragma solidity ^0.8.24;
import "./Base.sol";

contract Child is Base {
    function run() external pure returns (uint256) {
        return ping();
    }
}
`,
      };

      const uris: string[] = [];
      const parser = new SolidityParser();
      for (const [name, contents] of Object.entries(files)) {
        const filePath = path.join(tmpDir, name);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, contents, "utf-8");
        const uri = URI.file(filePath).toString();
        uris.push(uri);
        parser.parse(uri, contents);
      }

      const workspace = makeWorkspace(tmpDir, uris);
      const symbolIndex = new SymbolIndex(parser, workspace);
      for (const uri of uris) symbolIndex.updateFile(uri);
      const resolver = new SemanticResolver(parser, workspace, symbolIndex);
      const graph = new GraphIndex(parser, workspace, resolver, symbolIndex);
      graph.rebuildWorkspace();

      const baseUri = URI.file(path.join(tmpDir, "src/Base.sol")).toString();
      const childRun = graph
        .getNodes()
        .find((node) => node.name === "run" && node.containerName === "Child");
      const basePing = graph
        .getNodes()
        .find((node) => node.name === "ping" && node.containerName === "Base");
      assert.ok(childRun, "expected Child.run graph node");
      assert.ok(basePing, "expected Base.ping graph node");
      assert.ok(
        graph.getOutgoingEdges(childRun.id, "calls").some((edge) => edge.target === basePing.id),
        "expected initial full rebuild to include call edge",
      );

      const updatedBase = files["src/Base.sol"].replace("return 1;", "return 2;");
      fs.writeFileSync(path.join(tmpDir, "src/Base.sol"), updatedBase, "utf-8");
      parser.parse(baseUri, updatedBase);
      symbolIndex.updateFile(baseUri);
      const refreshed = graph.updateFileAndDependents(baseUri, false);

      assert.ok(
        refreshed.some((uri) => uri.endsWith("/src/Child.sol")),
        "expected importing dependent to refresh",
      );
      assert.equal(
        graph.getOutgoingEdges(childRun.id, "calls").length,
        0,
        "declaration-only dependent refresh should remove stale relationship edges",
      );
      assert.equal(graph.getStats().relationshipIndexComplete, false);
      assert.ok(
        (graph.getStats().pendingRelationshipFiles ?? 0) > 0,
        "expected changed files to be queued for relationship reindexing",
      );

      graph.ensureFileRelationships(URI.file(path.join(tmpDir, "src/Child.sol")).toString());
      assert.ok(
        graph.getOutgoingEdges(childRun.id, "calls").some((edge) => edge.target === basePing.id),
        "focused relationship indexing should restore the dependent call edge",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("updates import, inheritance, and call edges when a file changes imported bases", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-index-import-change-test-"));
    try {
      const files = {
        "src/BaseA.sol": `pragma solidity ^0.8.24;
contract BaseA {
    function pingA() internal pure returns (uint256) {
        return 1;
    }
}
`,
        "src/BaseB.sol": `pragma solidity ^0.8.24;
contract BaseB {
    function pingB() internal pure returns (uint256) {
        return 2;
    }
}
`,
        "src/Child.sol": `pragma solidity ^0.8.24;
import "./BaseA.sol";

contract Child is BaseA {
    function run() external pure returns (uint256) {
        return pingA();
    }
}
`,
      };

      const uris: string[] = [];
      const parser = new SolidityParser();
      for (const [name, contents] of Object.entries(files)) {
        const filePath = path.join(tmpDir, name);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, contents, "utf-8");
        const uri = URI.file(filePath).toString();
        uris.push(uri);
        parser.parse(uri, contents);
      }

      const workspace = makeWorkspace(tmpDir, uris);
      const symbolIndex = new SymbolIndex(parser, workspace);
      for (const uri of uris) symbolIndex.updateFile(uri);
      const resolver = new SemanticResolver(parser, workspace, symbolIndex);
      const graph = new GraphIndex(parser, workspace, resolver, symbolIndex);
      graph.rebuildWorkspace();

      const childUri = URI.file(path.join(tmpDir, "src/Child.sol")).toString();
      const baseAUri = URI.file(path.join(tmpDir, "src/BaseA.sol")).toString();
      const baseBUri = URI.file(path.join(tmpDir, "src/BaseB.sol")).toString();
      const childId = resolver.contractId(childUri, "Child");
      const baseAId = resolver.contractId(baseAUri, "BaseA");
      const baseBId = resolver.contractId(baseBUri, "BaseB");
      const childRun = graph
        .getNodes()
        .find((node) => node.name === "run" && node.containerName === "Child");
      const pingA = graph
        .getNodes()
        .find((node) => node.name === "pingA" && node.containerName === "BaseA");
      assert.ok(childRun, "expected Child.run graph node");
      assert.ok(pingA, "expected BaseA.pingA graph node");
      assert.equal(graph.getOutgoingEdges(childId, "inherits")[0]?.target, baseAId);
      assert.ok(
        graph.getOutgoingEdges(childRun.id, "calls").some((edge) => edge.target === pingA.id),
        "expected initial call edge to BaseA.pingA",
      );

      const updatedChild = files["src/Child.sol"]
        .replace("./BaseA.sol", "./BaseB.sol")
        .replace("BaseA", "BaseB")
        .replace("pingA", "pingB");
      fs.writeFileSync(path.join(tmpDir, "src/Child.sol"), updatedChild, "utf-8");
      parser.parse(childUri, updatedChild);
      symbolIndex.updateFile(childUri);
      const refreshed = graph.updateFileAndDependents(childUri, false);

      assert.deepEqual(refreshed, [childUri]);
      assert.equal(
        graph.getOutgoingEdges(`file:${childUri}`, "imports")[0]?.target,
        `file:${baseBUri}`,
        "expected import edge to retarget BaseB",
      );
      assert.ok(
        graph
          .getOutgoingEdges(`file:${childUri}`, "imports")
          .every((edge) => edge.target !== `file:${baseAUri}`),
        "expected stale import edge to BaseA to be removed",
      );
      assert.equal(
        graph.getOutgoingEdges(childId, "inherits")[0]?.target,
        baseBId,
        "expected inheritance edge to retarget BaseB",
      );
      assert.ok(
        graph.getOutgoingEdges(childId, "inherits").every((edge) => edge.target !== baseAId),
        "expected stale inheritance edge to BaseA to be removed",
      );
      assert.equal(
        graph.getOutgoingEdges(childRun.id, "calls").length,
        0,
        "declaration-only import change refresh should remove stale relationship edges",
      );

      graph.ensureFileRelationships(childUri);
      const refreshedChildRun = graph
        .getNodes()
        .find((node) => node.name === "run" && node.containerName === "Child");
      const pingB = graph
        .getNodes()
        .find((node) => node.name === "pingB" && node.containerName === "BaseB");
      assert.ok(refreshedChildRun, "expected refreshed Child.run graph node");
      assert.ok(pingB, "expected BaseB.pingB graph node");
      assert.ok(
        graph
          .getOutgoingEdges(refreshedChildRun.id, "calls")
          .some((edge) => edge.target === pingB.id),
        "expected focused relationship indexing to add call edge to BaseB.pingB",
      );
      assert.ok(
        graph
          .getOutgoingEdges(refreshedChildRun.id, "calls")
          .every((edge) => edge.target !== pingA.id),
        "expected stale call edge to BaseA.pingA to stay removed",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("removes deleted files, refreshes import dependents, and evicts stale parser state", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-index-delete-test-"));
    try {
      const files = {
        "src/Base.sol": `pragma solidity ^0.8.24;
contract Base {
    function ping() internal pure returns (uint256) {
        return 1;
    }
}
`,
        "src/Child.sol": `pragma solidity ^0.8.24;
import "./Base.sol";

contract Child is Base {
    function run() external pure returns (uint256) {
        return ping();
    }
}
`,
      };

      const uris: string[] = [];
      const parser = new SolidityParser();
      for (const [name, contents] of Object.entries(files)) {
        const filePath = path.join(tmpDir, name);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, contents, "utf-8");
        const uri = URI.file(filePath).toString();
        uris.push(uri);
        parser.parse(uri, contents);
      }

      const workspace = makeWorkspace(tmpDir, uris);
      const symbolIndex = new SymbolIndex(parser, workspace);
      for (const uri of uris) symbolIndex.updateFile(uri);
      const resolver = new SemanticResolver(parser, workspace, symbolIndex);
      const graph = new GraphIndex(parser, workspace, resolver, symbolIndex);
      graph.rebuildWorkspace();

      const baseUri = URI.file(path.join(tmpDir, "src/Base.sol")).toString();
      const childUri = URI.file(path.join(tmpDir, "src/Child.sol")).toString();
      const baseId = resolver.contractId(baseUri, "Base");
      const childId = resolver.contractId(childUri, "Child");
      const childRun = graph
        .getNodes()
        .find((node) => node.name === "run" && node.containerName === "Child");
      const basePing = graph
        .getNodes()
        .find((node) => node.name === "ping" && node.containerName === "Base");
      assert.ok(childRun, "expected Child.run graph node");
      assert.ok(basePing, "expected Base.ping graph node");
      assert.ok(graph.getNode(baseId), "expected Base before deletion");
      assert.ok(
        graph.getOutgoingEdges(childRun.id, "calls").some((edge) => edge.target === basePing.id),
        "expected initial inherited call edge",
      );

      fs.rmSync(path.join(tmpDir, "src/Base.sol"));
      parser.removeFile(baseUri);
      symbolIndex.removeFile(baseUri);
      const refreshed = graph.removeFileAndDependents(baseUri, false);

      assert.deepEqual(
        refreshed.sort(),
        [baseUri, childUri].sort(),
        "expected deleted file and importing dependent to refresh",
      );
      assert.equal(
        parser.get(baseUri),
        undefined,
        "expected parser cache eviction for deleted file",
      );
      assert.equal(graph.getNode(baseId), undefined, "expected deleted Base node to be removed");
      assert.equal(
        graph.getNode(basePing.id),
        undefined,
        "expected deleted Base.ping node to be removed",
      );
      assert.equal(
        graph.getOutgoingEdges(`file:${childUri}`, "imports").length,
        0,
        "expected unresolved import edge to be removed after dependent refresh",
      );
      const inheritanceEdges = graph.getOutgoingEdges(childId, "inherits");
      assert.equal(inheritanceEdges.length, 1, "expected unresolved inheritance edge to remain");
      assert.equal(
        inheritanceEdges[0].target,
        graph.externalNodeId("Base"),
        "expected deleted Base inheritance to retarget an unresolved external node",
      );
      assert.equal(inheritanceEdges[0].unresolvedTarget, true);
      assert.ok(
        inheritanceEdges.every((edge) => edge.target !== baseId),
        "expected stale inheritance edge to deleted Base file node to be removed",
      );
      assert.equal(
        graph.getOutgoingEdges(childRun.id, "calls").length,
        0,
        "expected stale inherited call edge to be removed until relationships reindex",
      );
      assert.equal(graph.getStats().relationshipIndexComplete, false);
      assert.ok(
        (graph.getStats().pendingRelationshipFiles ?? 0) >= 1,
        "expected dependent to be queued for relationship reindexing",
      );

      graph.ensureWorkspaceDeclarations();
      assert.equal(
        graph.getNode(baseId),
        undefined,
        "deleted file should not be re-added from stale parser state",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("indexes modifier body calls, state access, emits, and reverts", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-index-modifier-body-test-"));
    try {
      const source = `pragma solidity ^0.8.24;
contract Guarded {
    event Checked(uint256 count);
    error Closed();
    uint256 public count;

    modifier onlyOpen() {
        count += 1;
        emit Checked(count);
        if (count > 10) revert Closed();
        helper();
        _;
    }

    function run() external onlyOpen {}
    function helper() internal {}
}
`;
      const filePath = path.join(tmpDir, "src/Guarded.sol");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, source, "utf-8");
      const uri = URI.file(filePath).toString();

      const parser = new SolidityParser();
      parser.parse(uri, source);
      const workspace = makeWorkspace(tmpDir, [uri]);
      const symbolIndex = new SymbolIndex(parser, workspace);
      symbolIndex.updateFile(uri);
      const resolver = new SemanticResolver(parser, workspace, symbolIndex);
      const graph = new GraphIndex(parser, workspace, resolver, symbolIndex);
      graph.rebuildWorkspace();

      const onlyOpen = graph
        .getNodes()
        .find((node) => node.name === "onlyOpen" && node.containerName === "Guarded");
      const run = graph
        .getNodes()
        .find((node) => node.name === "run" && node.containerName === "Guarded");
      const helper = graph
        .getNodes()
        .find((node) => node.name === "helper" && node.containerName === "Guarded");
      const count = graph
        .getNodes()
        .find((node) => node.name === "count" && node.containerName === "Guarded");
      const checked = graph
        .getNodes()
        .find((node) => node.name === "Checked" && node.containerName === "Guarded");
      const closed = graph
        .getNodes()
        .find((node) => node.name === "Closed" && node.containerName === "Guarded");
      assert.ok(onlyOpen, "expected onlyOpen modifier node");
      assert.ok(run, "expected run function node");
      assert.ok(helper, "expected helper function node");
      assert.ok(count, "expected count state variable node");
      assert.ok(checked, "expected Checked event node");
      assert.ok(closed, "expected Closed error node");

      const usesOnlyOpen = graph
        .getOutgoingEdges(run.id, "usesModifier")
        .find((edge) => edge.target === onlyOpen.id);
      assert.ok(usesOnlyOpen, "expected function to use onlyOpen modifier");
      assert.deepEqual(usesOnlyOpen.range, {
        start: { line: 14, character: 28 },
        end: { line: 14, character: 36 },
      });
      assert.ok(
        graph.getOutgoingEdges(onlyOpen.id, "calls").some((edge) => edge.target === helper.id),
        "expected modifier body helper() call edge",
      );
      assert.ok(
        graph.getOutgoingEdges(onlyOpen.id, "writes").some((edge) => edge.target === count.id),
        "expected modifier body count write edge",
      );
      assert.ok(
        graph.getOutgoingEdges(onlyOpen.id, "reads").some((edge) => edge.target === count.id),
        "expected modifier body count read edge",
      );
      assert.ok(
        graph.getOutgoingEdges(onlyOpen.id, "emits").some((edge) => edge.target === checked.id),
        "expected modifier body event emit edge",
      );
      assert.ok(
        graph
          .getOutgoingEdges(onlyOpen.id, "revertsWith")
          .some((edge) => edge.target === closed.id),
        "expected modifier body custom error edge",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolves using-for extension methods without external-call contamination", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-index-using-for-test-"));
    try {
      const source = `pragma solidity ^0.8.24;
struct Data {
    uint256 value;
}

function clear(Data storage self) {
    self.value = 0;
}

library DataLib {
    function bump(Data storage self) internal returns (uint256) {
        self.value += 1;
        return self.value;
    }
}

contract UsesUsingFor {
    using DataLib for Data;
    using {clear} for Data;
    Data internal data;

    function run() external {
        data.bump();
        data.clear();
    }
}
`;
      const filePath = path.join(tmpDir, "src/UsesUsingFor.sol");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, source, "utf-8");
      const uri = URI.file(filePath).toString();

      const parser = new SolidityParser();
      parser.parse(uri, source);
      const workspace = makeWorkspace(tmpDir, [uri]);
      const symbolIndex = new SymbolIndex(parser, workspace);
      symbolIndex.updateFile(uri);
      const resolver = new SemanticResolver(parser, workspace, symbolIndex);
      const graph = new GraphIndex(parser, workspace, resolver, symbolIndex);
      graph.rebuildWorkspace();

      const run = graph
        .getNodes()
        .find((node) => node.name === "run" && node.containerName === "UsesUsingFor");
      const bump = graph
        .getNodes()
        .find((node) => node.name === "bump" && node.containerName === "DataLib");
      const clear = graph
        .getNodes()
        .find((node) => node.name === "clear" && node.containerName === undefined);
      assert.ok(run, "expected UsesUsingFor.run node");
      assert.ok(bump, "expected DataLib.bump node");
      assert.ok(clear, "expected free clear node");

      const calls = graph.getOutgoingEdges(run.id, "calls");
      assert.ok(
        calls.some((edge) => edge.target === bump.id),
        "expected data.bump() to resolve to DataLib.bump",
      );
      assert.ok(
        calls.some((edge) => edge.target === clear.id),
        "expected data.clear() to resolve to free clear function",
      );
      const externalCalls = graph.getOutgoingEdges(run.id, "externalCall");
      assert.ok(
        externalCalls.every((edge) => edge.target !== bump.id && edge.target !== clear.id),
        "using-for extension methods should not be classified as external calls",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolves using-for extension methods through imported library aliases", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-index-using-alias-test-"));
    try {
      const files = {
        "src/DataLib.sol": `pragma solidity ^0.8.24;
struct Data {
    uint256 value;
}

library DataLib {
    function bump(Data storage self, uint256 value) internal returns (uint256) {
        self.value += value;
        return self.value;
    }
}
`,
        "src/UsesUsingAlias.sol": `pragma solidity ^0.8.24;
import {Data, DataLib as RenamedDataLib} from "./DataLib.sol";

contract UsesUsingAlias {
    using RenamedDataLib for Data;
    Data internal data;

    function run() external {
        data.bump(1);
    }
}
`,
      };

      const parser = new SolidityParser();
      const uris: string[] = [];
      for (const [name, contents] of Object.entries(files)) {
        const filePath = path.join(tmpDir, name);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, contents, "utf-8");
        const uri = URI.file(filePath).toString();
        uris.push(uri);
        parser.parse(uri, contents);
      }

      const workspace = makeWorkspace(tmpDir, uris);
      const symbolIndex = new SymbolIndex(parser, workspace);
      for (const uri of uris) symbolIndex.updateFile(uri);
      const resolver = new SemanticResolver(parser, workspace, symbolIndex);
      const graph = new GraphIndex(parser, workspace, resolver, symbolIndex);
      graph.rebuildWorkspace();

      const run = graph
        .getNodes()
        .find((node) => node.name === "run" && node.containerName === "UsesUsingAlias");
      const bump = graph
        .getNodes()
        .find((node) => node.name === "bump" && node.containerName === "DataLib");
      assert.ok(run, "expected UsesUsingAlias.run node");
      assert.ok(bump, "expected DataLib.bump node");
      assert.ok(
        graph.getOutgoingEdges(run.id, "calls").some((edge) => edge.target === bump.id),
        "expected data.bump() to resolve through the imported RenamedDataLib alias",
      );
      assert.equal(
        graph.getOutgoingEdges(run.id, "externalCall").length,
        0,
        "using-for extension methods should not be classified as external calls",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolves same-file forward contract references before body indexing", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-index-forward-ref-test-"));
    try {
      const source = `pragma solidity ^0.8.24;
contract UsesLater {
    Later public later;

    function callLater() external {
        later.ping();
    }
}

contract Later {
    function ping() external {}
}
`;
      const filePath = path.join(tmpDir, "src/Forward.sol");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, source, "utf-8");
      const uri = URI.file(filePath).toString();

      const parser = new SolidityParser();
      parser.parse(uri, source);
      const workspace = makeWorkspace(tmpDir, [uri]);
      const symbolIndex = new SymbolIndex(parser, workspace);
      symbolIndex.updateFile(uri);
      const resolver = new SemanticResolver(parser, workspace, symbolIndex);
      const graph = new GraphIndex(parser, workspace, resolver, symbolIndex);
      graph.rebuildWorkspace();

      const usesLater = graph
        .getNodes()
        .find((node) => node.name === "UsesLater" && node.kind === "contract");
      const laterContract = graph
        .getNodes()
        .find((node) => node.name === "Later" && node.kind === "contract");
      const laterState = graph
        .getNodes()
        .find((node) => node.name === "later" && node.containerName === "UsesLater");
      const callLater = graph
        .getNodes()
        .find((node) => node.name === "callLater" && node.containerName === "UsesLater");
      const ping = graph
        .getNodes()
        .find((node) => node.name === "ping" && node.containerName === "Later");
      assert.ok(usesLater, "expected UsesLater contract node");
      assert.ok(laterContract, "expected Later contract node");
      assert.ok(laterState, "expected later state variable node");
      assert.ok(callLater, "expected callLater function node");
      assert.ok(ping, "expected Later.ping function node");

      assert.ok(
        graph
          .getOutgoingEdges(laterState.id, "usesType")
          .some((edge) => edge.target === laterContract.id),
        "expected state variable to use forward-declared Later type",
      );
      assert.ok(
        graph.getOutgoingEdges(callLater.id, "calls").some((edge) => edge.target === ping.id),
        "expected later.ping() to resolve to same-file forward contract member",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses argument count to disambiguate parser fallback overloads", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-index-overload-test-"));
    try {
      const source = `pragma solidity ^0.8.24;
contract OverloadedTarget {
    function ping() external {}
    function ping(address account) external {}
    function ping(uint256 value) external {}
}

contract Caller {
    OverloadedTarget public target;
    uint256[] internal amounts;
    mapping(address => uint256) internal balances;
    bool internal flag;

    function local(address account, uint256 value) external {
        one();
        one(1);
        one(account);
        one(uint256(value));
        one(value + 1);
        one(flag ? value : 1);
        one(amounts[0]);
        one(balances[account]);
        one(makeAmount(value));
        one(makeAccount(account));
    }

    function receiver(address account, uint256 value) external {
        target.ping();
        target.ping(1);
        target.ping(account);
        target.ping(uint256(value));
        target.ping(value + 1);
        target.ping(flag ? value : 1);
        target.ping(amounts[0]);
        target.ping(balances[account]);
        target.ping(makeAmount(value));
        target.ping(makeAccount(account));
    }

    function makeAmount(uint256 value) internal pure returns (uint256) {
        return value;
    }

    function makeAccount(address account) internal pure returns (address) {
        return account;
    }

    function one() internal {}
    function one(address account) internal {}
    function one(uint256 value) internal {}
}
`;
      const filePath = path.join(tmpDir, "src/Overload.sol");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, source, "utf-8");
      const uri = URI.file(filePath).toString();

      const parser = new SolidityParser();
      parser.parse(uri, source);
      const workspace = makeWorkspace(tmpDir, [uri]);
      const symbolIndex = new SymbolIndex(parser, workspace);
      symbolIndex.updateFile(uri);
      const resolver = new SemanticResolver(parser, workspace, symbolIndex);
      const graph = new GraphIndex(parser, workspace, resolver, symbolIndex);
      graph.rebuildWorkspace();

      const local = graph
        .getNodes()
        .find((node) => node.name === "local" && node.containerName === "Caller");
      const receiver = graph
        .getNodes()
        .find((node) => node.name === "receiver" && node.containerName === "Caller");
      const oneNoArgs = graph
        .getNodes()
        .find((node) => node.detail === "one()" && node.containerName === "Caller");
      const oneUint = graph
        .getNodes()
        .find((node) => node.detail === "one(uint256 value)" && node.containerName === "Caller");
      const oneAddress = graph
        .getNodes()
        .find((node) => node.detail === "one(address account)" && node.containerName === "Caller");
      const pingNoArgs = graph
        .getNodes()
        .find((node) => node.detail === "ping()" && node.containerName === "OverloadedTarget");
      const pingUint = graph
        .getNodes()
        .find(
          (node) =>
            node.detail === "ping(uint256 value)" && node.containerName === "OverloadedTarget",
        );
      const pingAddress = graph
        .getNodes()
        .find(
          (node) =>
            node.detail === "ping(address account)" && node.containerName === "OverloadedTarget",
        );
      assert.ok(local, "expected Caller.local node");
      assert.ok(receiver, "expected Caller.receiver node");
      assert.ok(oneNoArgs, "expected zero-arg one overload");
      assert.ok(oneUint, "expected uint256 one overload");
      assert.ok(oneAddress, "expected address one overload");
      assert.ok(pingNoArgs, "expected zero-arg ping overload");
      assert.ok(pingUint, "expected uint256 ping overload");
      assert.ok(pingAddress, "expected address ping overload");

      assert.ok(
        graph.getOutgoingEdges(local.id, "calls").some((edge) => edge.target === oneNoArgs.id),
        "expected one() to target the zero-arg overload",
      );
      assert.ok(
        graph.getOutgoingEdges(local.id, "calls").some((edge) => edge.target === oneUint.id),
        "expected one(1) to target the uint256 overload",
      );
      assert.equal(
        graph.getOutgoingEdges(local.id, "calls").filter((edge) => edge.target === oneUint.id)
          .length,
        7,
        "expected every local uint-compatible expression to target the uint256 overload",
      );
      assert.ok(
        graph.getOutgoingEdges(local.id, "calls").some((edge) => edge.target === oneAddress.id),
        "expected one(account) to target the address overload",
      );
      assert.equal(
        graph.getOutgoingEdges(local.id, "calls").filter((edge) => edge.target === oneAddress.id)
          .length,
        2,
        "expected direct and nested local address expressions to target the address overload",
      );
      assert.ok(
        graph.getOutgoingEdges(receiver.id, "calls").some((edge) => edge.target === pingNoArgs.id),
        "expected target.ping() to target the zero-arg overload",
      );
      assert.ok(
        graph.getOutgoingEdges(receiver.id, "calls").some((edge) => edge.target === pingUint.id),
        "expected target.ping(1) to target the uint256 overload",
      );
      assert.equal(
        graph.getOutgoingEdges(receiver.id, "calls").filter((edge) => edge.target === pingUint.id)
          .length,
        7,
        "expected every receiver uint-compatible expression to target the uint256 overload",
      );
      assert.ok(
        graph.getOutgoingEdges(receiver.id, "calls").some((edge) => edge.target === pingAddress.id),
        "expected target.ping(account) to target the address overload",
      );
      assert.equal(
        graph
          .getOutgoingEdges(receiver.id, "calls")
          .filter((edge) => edge.target === pingAddress.id).length,
        2,
        "expected direct and nested receiver address expressions to target the address overload",
      );

      const pingUintCallers = graph.query({
        kind: "callers",
        query: "OverloadedTarget.ping(uint256)",
        targetKinds: ["function"],
      });
      assert.equal(pingUintCallers.found, true);
      assert.equal(pingUintCallers.targetId, pingUint.id);
      assert.ok(
        pingUintCallers.edges.some(
          (edge) => edge.source === receiver.id && edge.target === pingUint.id,
        ),
        "expected signature query to target ping(uint256)",
      );

      const pingNoArgCallers = graph.query({
        kind: "callers",
        query: "OverloadedTarget.ping()",
        targetKinds: ["function"],
      });
      assert.equal(pingNoArgCallers.found, true);
      assert.equal(pingNoArgCallers.targetId, pingNoArgs.id);

      const oneUintCallers = graph.query({
        kind: "callers",
        query: "Caller.one(uint256 value)",
        targetKinds: ["function"],
      });
      assert.equal(oneUintCallers.found, true);
      assert.equal(oneUintCallers.targetId, oneUint.id);

      const pingAddressCallers = graph.query({
        kind: "callers",
        query: "OverloadedTarget.ping(address)",
        targetKinds: ["function"],
      });
      assert.equal(pingAddressCallers.found, true);
      assert.equal(pingAddressCallers.targetId, pingAddress.id);

      const missingOverload = graph.query({
        kind: "callers",
        query: "OverloadedTarget.ping(bool)",
        targetKinds: ["function"],
      });
      assert.equal(missingOverload.found, false);
      assert.equal(missingOverload.missReason, "targetNotFound");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolves receiver calls to public state-variable getters", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-index-getter-call-test-"));
    try {
      const source = `pragma solidity ^0.8.24;
interface IERC4626 {}

contract Vault {
    uint256 public totalAssets;
    mapping(address => uint256) public balanceOf;
    uint256[] public sharePrices;
    mapping(uint256 => mapping(address => IERC4626)) public vaults;
    mapping(address => uint256[]) public assetsByOwner;
    uint256 internal internalAssets;
}

contract Caller {
    Vault public vault;

    function read(address account) external view returns (uint256 total, uint256 balance) {
        total = vault.totalAssets();
        balance = vault.balanceOf(account);
    }

    function ignored() external view returns (uint256) {
        return vault.internalAssets();
    }

    function choose(address account) external view {
        pick(vault.totalAssets());
        pick(vault.balanceOf(account));
        pick(vault.sharePrices(0));
        pick(vault.assetsByOwner(account, 0));
        pick(vault.vaults(1, account));
    }

    function pick(uint256 value) internal pure {}
    function pick(IERC4626 vault_) internal pure {}
}
`;
      const filePath = path.join(tmpDir, "src/GetterCall.sol");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, source, "utf-8");
      const uri = URI.file(filePath).toString();

      const parser = new SolidityParser();
      parser.parse(uri, source);
      const workspace = makeWorkspace(tmpDir, [uri]);
      const symbolIndex = new SymbolIndex(parser, workspace);
      symbolIndex.updateFile(uri);
      const resolver = new SemanticResolver(parser, workspace, symbolIndex);
      const graph = new GraphIndex(parser, workspace, resolver, symbolIndex);
      graph.rebuildWorkspace();

      const read = graph
        .getNodes()
        .find((node) => node.name === "read" && node.containerName === "Caller");
      const ignored = graph
        .getNodes()
        .find((node) => node.name === "ignored" && node.containerName === "Caller");
      const choose = graph
        .getNodes()
        .find((node) => node.name === "choose" && node.containerName === "Caller");
      const pickUint = graph
        .getNodes()
        .find((node) => node.detail === "pick(uint256 value)" && node.containerName === "Caller");
      const pickVault = graph
        .getNodes()
        .find((node) => node.detail === "pick(IERC4626 vault_)" && node.containerName === "Caller");
      const totalAssets = graph
        .getNodes()
        .find((node) => node.name === "totalAssets" && node.containerName === "Vault");
      const balanceOf = graph
        .getNodes()
        .find((node) => node.name === "balanceOf" && node.containerName === "Vault");
      const sharePrices = graph
        .getNodes()
        .find((node) => node.name === "sharePrices" && node.containerName === "Vault");
      const vaults = graph
        .getNodes()
        .find((node) => node.name === "vaults" && node.containerName === "Vault");
      const assetsByOwner = graph
        .getNodes()
        .find((node) => node.name === "assetsByOwner" && node.containerName === "Vault");
      const internalAssets = graph
        .getNodes()
        .find((node) => node.name === "internalAssets" && node.containerName === "Vault");
      assert.ok(read, "expected Caller.read node");
      assert.ok(ignored, "expected Caller.ignored node");
      assert.ok(choose, "expected Caller.choose node");
      assert.ok(pickUint, "expected Caller.pick(uint256) node");
      assert.ok(pickVault, "expected Caller.pick(IERC4626) node");
      assert.ok(totalAssets, "expected Vault.totalAssets node");
      assert.ok(balanceOf, "expected Vault.balanceOf node");
      assert.ok(sharePrices, "expected Vault.sharePrices node");
      assert.ok(vaults, "expected Vault.vaults node");
      assert.ok(assetsByOwner, "expected Vault.assetsByOwner node");
      assert.ok(internalAssets, "expected Vault.internalAssets node");
      assert.equal(totalAssets.metadata?.visibility, "public");
      assert.equal(totalAssets.metadata?.publicGetter, true);
      assert.equal(totalAssets.metadata?.getterArgumentCount, 0);
      assert.equal(balanceOf.metadata?.visibility, "public");
      assert.equal(balanceOf.metadata?.publicGetter, true);
      assert.equal(balanceOf.metadata?.getterArgumentCount, 1);
      assert.equal(sharePrices.metadata?.getterArgumentCount, 1);
      assert.equal(vaults.metadata?.getterArgumentCount, 2);
      assert.equal(assetsByOwner.metadata?.getterArgumentCount, 2);
      assert.equal(internalAssets.metadata?.visibility, "internal");
      assert.equal(internalAssets.metadata?.publicGetter, false);

      const calls = graph.getOutgoingEdges(read.id, "calls");
      assert.ok(
        calls.some((edge) => edge.target === totalAssets.id),
        "expected vault.totalAssets() to resolve to the public state-variable getter",
      );
      assert.ok(
        calls.some((edge) => edge.target === balanceOf.id),
        "expected vault.balanceOf(account) to resolve to the public mapping getter",
      );

      const chooseCalls = graph.getOutgoingEdges(choose.id, "calls");
      assert.ok(
        chooseCalls.some((edge) => edge.target === totalAssets.id),
        "expected nested scalar getter call to resolve to the public getter",
      );
      assert.ok(
        chooseCalls.some((edge) => edge.target === balanceOf.id),
        "expected nested mapping getter call to resolve to the public getter",
      );
      assert.ok(
        chooseCalls.some((edge) => edge.target === sharePrices.id),
        "expected nested array getter call to resolve to the public getter",
      );
      assert.ok(
        chooseCalls.some((edge) => edge.target === assetsByOwner.id),
        "expected nested mapping-to-array getter call to resolve to the public getter",
      );
      assert.ok(
        chooseCalls.some((edge) => edge.target === vaults.id),
        "expected nested mapping-to-mapping getter call to resolve to the public getter",
      );
      assert.equal(
        chooseCalls.filter((edge) => edge.target === pickUint.id).length,
        4,
        "expected scalar, mapping, array, and mapping-to-array getters to return uint256 for overload selection",
      );
      assert.equal(
        chooseCalls.filter((edge) => edge.target === pickVault.id).length,
        1,
        "expected nested mapping getter to return IERC4626 for overload selection",
      );

      const externalCalls = graph.getOutgoingEdges(read.id, "externalCall");
      assert.ok(
        externalCalls.some((edge) => edge.target === totalAssets.id),
        "expected public getter call to create an externalCall edge",
      );
      assert.ok(
        externalCalls.some((edge) => edge.target === balanceOf.id),
        "expected public mapping getter call to create an externalCall edge",
      );

      const totalAssetsCallers = graph.query({
        kind: "callers",
        target: { nodeId: totalAssets.id },
        targetKinds: ["function", "stateVariable"],
      });
      assert.equal(totalAssetsCallers.found, true);
      assert.equal(totalAssetsCallers.targetId, totalAssets.id);
      assert.ok(
        totalAssetsCallers.edges.some(
          (edge) => edge.source === read.id && edge.target === totalAssets.id,
        ),
        "expected callers query to include public getter call edge",
      );

      const balanceOfCallers = graph.query({
        kind: "callers",
        query: "balanceOf",
        targetKinds: ["function", "stateVariable"],
      });
      assert.equal(balanceOfCallers.found, true);
      assert.equal(balanceOfCallers.targetId, balanceOf.id);
      assert.ok(
        balanceOfCallers.nodes.some((node) => node.id === read.id),
        "expected text callers query to include caller of public mapping getter",
      );

      const internalAssetsCallers = graph.query({
        kind: "callers",
        target: { nodeId: internalAssets.id },
        targetKinds: ["function", "stateVariable"],
      });
      assert.equal(internalAssetsCallers.found, false);
      assert.equal(internalAssetsCallers.missReason, "targetKindMismatch");

      const internalAssetsTextCallers = graph.query({
        kind: "callers",
        query: "internalAssets",
        targetKinds: ["function", "stateVariable"],
      });
      assert.equal(internalAssetsTextCallers.found, false);
      assert.equal(internalAssetsTextCallers.missReason, "targetKindMismatch");

      assert.ok(
        graph
          .getOutgoingEdges(ignored.id, "calls")
          .every((edge) => edge.target !== internalAssets.id),
        "did not expect internal state variable to resolve as a public getter call",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolves import aliases and namespace-qualified types in receiver chains", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-index-import-alias-test-"));
    try {
      const files = {
        "src/Types.sol": `pragma solidity ^0.8.24;
interface IBase {
    function ping(uint256 value) external view returns (uint256);
}

interface IChild is IBase {}

struct Box {
    IChild vault;
}
`,
        "src/Target.sol": `pragma solidity ^0.8.24;
contract Target {
    function ping() external pure returns (uint256) {
        return 0;
    }

    function ping(uint256 value) external pure returns (uint256) {
        return value;
    }
}
`,
        "src/UsesAliases.sol": `pragma solidity ^0.8.24;
import {Target as RenamedTarget} from "./Target.sol";
import {Box as RenamedBox, IChild as ChildVault} from "./Types.sol";
import * as TypeNS from "./Types.sol";

contract UsesAliases {
    RenamedTarget public direct;
    ChildVault public child;
    RenamedBox internal box;
    TypeNS.Box internal namespacedBox;

    function callDirect() external view returns (uint256) {
        return direct.ping(1);
    }

    function callInheritedInterface() external view returns (uint256) {
        return child.ping(1);
    }

    function callStructMembers() external view returns (uint256 a, uint256 b) {
        a = box.vault.ping(1);
        b = namespacedBox.vault.ping(1);
    }
}
`,
      };

      const parser = new SolidityParser();
      const uris: string[] = [];
      for (const [name, contents] of Object.entries(files)) {
        const filePath = path.join(tmpDir, name);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, contents, "utf-8");
        const uri = URI.file(filePath).toString();
        uris.push(uri);
        parser.parse(uri, contents);
      }

      const workspace = makeWorkspace(tmpDir, uris);
      const symbolIndex = new SymbolIndex(parser, workspace);
      for (const uri of uris) symbolIndex.updateFile(uri);
      const resolver = new SemanticResolver(parser, workspace, symbolIndex);
      const graph = new GraphIndex(parser, workspace, resolver, symbolIndex);
      graph.rebuildWorkspace();

      const nodes = graph.getNodes();
      const callDirect = nodes.find(
        (node) => node.name === "callDirect" && node.containerName === "UsesAliases",
      );
      const callInheritedInterface = nodes.find(
        (node) => node.name === "callInheritedInterface" && node.containerName === "UsesAliases",
      );
      const callStructMembers = nodes.find(
        (node) => node.name === "callStructMembers" && node.containerName === "UsesAliases",
      );
      const direct = nodes.find(
        (node) => node.name === "direct" && node.containerName === "UsesAliases",
      );
      const child = nodes.find(
        (node) => node.name === "child" && node.containerName === "UsesAliases",
      );
      const boxState = nodes.find(
        (node) => node.name === "box" && node.containerName === "UsesAliases",
      );
      const namespacedBox = nodes.find(
        (node) => node.name === "namespacedBox" && node.containerName === "UsesAliases",
      );
      const target = nodes.find((node) => node.name === "Target" && node.kind === "contract");
      const childInterface = nodes.find(
        (node) => node.name === "IChild" && node.kind === "interface",
      );
      const basePing = nodes.find(
        (node) =>
          node.detail === "ping(uint256 value) returns (uint256)" && node.containerName === "IBase",
      );
      const targetPing = nodes.find(
        (node) =>
          node.detail === "ping(uint256 value) returns (uint256)" &&
          node.containerName === "Target",
      );
      const box = nodes.find((node) => node.name === "Box" && node.kind === "struct");
      assert.ok(callDirect, "expected callDirect node");
      assert.ok(callInheritedInterface, "expected callInheritedInterface node");
      assert.ok(callStructMembers, "expected callStructMembers node");
      assert.ok(direct, "expected direct state variable node");
      assert.ok(child, "expected child state variable node");
      assert.ok(boxState, "expected box state variable node");
      assert.ok(namespacedBox, "expected namespacedBox state variable node");
      assert.ok(target, "expected Target contract node");
      assert.ok(childInterface, "expected IChild interface node");
      assert.ok(basePing, "expected inherited IBase.ping node");
      assert.ok(targetPing, "expected overloaded Target.ping(uint256) node");
      assert.ok(box, "expected Box struct node");

      assert.ok(
        graph.getOutgoingEdges(direct.id, "usesType").some((edge) => edge.target === target.id),
        "expected renamed contract import to create a usesType edge to Target",
      );
      assert.ok(
        graph
          .getOutgoingEdges(child.id, "usesType")
          .some((edge) => edge.target === childInterface.id),
        "expected renamed interface import to create a usesType edge to IChild",
      );
      assert.ok(
        graph.getOutgoingEdges(boxState.id, "usesType").some((edge) => edge.target === box.id),
        "expected renamed struct import to create a usesType edge to Box",
      );
      assert.ok(
        graph.getOutgoingEdges(namespacedBox.id, "usesType").some((edge) => edge.target === box.id),
        "expected namespace-qualified struct type to create a usesType edge to Box",
      );
      assert.ok(
        graph
          .getOutgoingEdges(callDirect.id, "calls")
          .some((edge) => edge.target === targetPing.id),
        "expected direct.ping(1) to resolve through the renamed Target import",
      );
      assert.ok(
        graph
          .getOutgoingEdges(callInheritedInterface.id, "calls")
          .some((edge) => edge.target === basePing.id),
        "expected renamed interface receiver to resolve inherited IBase.ping",
      );
      assert.equal(
        graph
          .getOutgoingEdges(callStructMembers.id, "calls")
          .filter((edge) => edge.target === basePing.id).length,
        2,
        "expected both aliased and namespace-qualified struct member receivers to resolve IBase.ping",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses explicit argument count to disambiguate using-for overloads", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-index-using-overload-test-"));
    try {
      const source = `pragma solidity ^0.8.24;
struct Data {
    uint256 value;
}

library DataLib {
    function apply(Data storage self) internal {}
    function apply(Data storage self, uint256 value) internal {}
    function apply(Data storage self, address account) internal {}
}

contract UsesUsingOverloads {
    using DataLib for Data;
    Data internal data;

    function run(address account, bool flag) external {
        data.apply();
        data.apply(1);
        data.apply(account);
        data.apply(flag);
    }
}
`;
      const filePath = path.join(tmpDir, "src/UsingOverload.sol");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, source, "utf-8");
      const uri = URI.file(filePath).toString();

      const parser = new SolidityParser();
      parser.parse(uri, source);
      const workspace = makeWorkspace(tmpDir, [uri]);
      const symbolIndex = new SymbolIndex(parser, workspace);
      symbolIndex.updateFile(uri);
      const resolver = new SemanticResolver(parser, workspace, symbolIndex);
      const graph = new GraphIndex(parser, workspace, resolver, symbolIndex);
      graph.rebuildWorkspace();

      const run = graph
        .getNodes()
        .find((node) => node.name === "run" && node.containerName === "UsesUsingOverloads");
      const applyNoArgs = graph
        .getNodes()
        .find((node) => node.detail === "apply(Data self)" && node.containerName === "DataLib");
      const applyUint = graph
        .getNodes()
        .find(
          (node) =>
            node.detail === "apply(Data self, uint256 value)" && node.containerName === "DataLib",
        );
      const applyAddress = graph
        .getNodes()
        .find(
          (node) =>
            node.detail === "apply(Data self, address account)" && node.containerName === "DataLib",
        );
      assert.ok(run, "expected run node");
      assert.ok(applyNoArgs, "expected receiver-only apply overload");
      assert.ok(applyUint, "expected receiver plus uint256 apply overload");
      assert.ok(applyAddress, "expected receiver plus address apply overload");

      const calls = graph.getOutgoingEdges(run.id, "calls");
      assert.ok(
        calls.some((edge) => edge.target === applyNoArgs.id),
        "expected data.apply() to target the receiver-only overload",
      );
      assert.ok(
        calls.some((edge) => edge.target === applyUint.id),
        "expected data.apply(1) to target the uint256 overload",
      );
      assert.ok(
        calls.some((edge) => edge.target === applyAddress.id),
        "expected data.apply(account) to target the address overload",
      );
      assert.equal(
        calls.filter((edge) => edge.target === applyAddress.id).length,
        1,
        "expected exactly one address using-for overload edge",
      );
      assert.equal(
        calls.filter((edge) => edge.target === applyUint.id).length,
        1,
        "expected unmatched bool extension call not to fall back to the uint256 overload",
      );
      assert.equal(
        calls.filter((edge) => edge.target === applyNoArgs.id).length,
        1,
        "expected unmatched bool extension call not to fall back to the receiver-only overload",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses warm solc declaration info to retarget parser-resolved call edges", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-index-solc-target-test-"));
    try {
      const files = {
        "src/TargetA.sol": `pragma solidity ^0.8.24;
contract TargetA {
    function ping() external {}
}
`,
        "src/TargetB.sol": `pragma solidity ^0.8.24;
contract TargetB {
    function ping() external {}
}
`,
        "src/Caller.sol": `pragma solidity ^0.8.24;
import "./TargetA.sol";
import "./TargetB.sol";

contract Caller {
    TargetA internal target;

    function entry() external {
        target.ping();
    }
}
`,
      };

      const parser = new SolidityParser();
      const uris: string[] = [];
      for (const [name, contents] of Object.entries(files)) {
        const filePath = path.join(tmpDir, name);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, contents, "utf-8");
        const uri = URI.file(filePath).toString();
        uris.push(uri);
        parser.parse(uri, contents);
      }

      const workspace = makeWorkspace(tmpDir, uris);
      const symbolIndex = new SymbolIndex(parser, workspace);
      for (const uri of uris) symbolIndex.updateFile(uri);
      const resolver = new SemanticResolver(parser, workspace, symbolIndex);
      const graph = new GraphIndex(parser, workspace, resolver, symbolIndex);
      const callerPath = path.join(tmpDir, "src/Caller.sol");
      const targetBPath = path.join(tmpDir, "src/TargetB.sol");
      const pingCallOffset = fs.readFileSync(callerPath, "utf-8").indexOf("ping");
      graph.setSolcBridge({
        getDeclarationInfoAt: (filePath: string, offset: number) =>
          filePath === callerPath && offset === pingCallOffset
            ? {
                declarationId: 4242,
                declarationFilePath: targetBPath,
                declarationOffset: files["src/TargetB.sol"].indexOf("function ping"),
                declarationLength: "function ping() external {}".length,
                nodeType: "FunctionDefinition",
                name: "ping",
              }
            : null,
      } as unknown as SolcBridge);
      graph.rebuildWorkspace();

      const entry = graph
        .getNodes()
        .find((node) => node.name === "entry" && node.containerName === "Caller");
      const targetAPing = graph
        .getNodes()
        .find((node) => node.name === "ping" && node.containerName === "TargetA");
      const targetBPing = graph
        .getNodes()
        .find((node) => node.name === "ping" && node.containerName === "TargetB");
      assert.ok(entry, "expected Caller.entry node");
      assert.ok(targetAPing, "expected TargetA.ping node");
      assert.ok(targetBPing, "expected TargetB.ping node");

      const calls = graph.getOutgoingEdges(entry.id, "calls");
      assert.ok(
        calls.some(
          (edge) =>
            edge.target === targetBPing.id &&
            edge.metadata?.resolutionConfidence === "solc" &&
            edge.metadata?.solcDeclarationId === 4242,
        ),
        "expected call edge to use the compiler-resolved declaration target",
      );
      assert.ok(
        calls.every((edge) => edge.target !== targetAPing.id),
        "did not expect parser fallback target when solc declaration maps to another function",
      );

      const externalCalls = graph.getOutgoingEdges(entry.id, "externalCall");
      assert.ok(
        externalCalls.some((edge) => edge.target === targetBPing.id),
        "expected paired externalCall edge to use the compiler-resolved declaration target",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("marks warm solc call targets unresolved when the compiler target is not indexed", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-index-solc-unmapped-target-"));
    try {
      const files = {
        "src/TargetA.sol": `pragma solidity ^0.8.24;
contract TargetA {
    function ping() external {}
}
`,
        "src/Caller.sol": `pragma solidity ^0.8.24;
import "./TargetA.sol";

contract Caller {
    TargetA internal target;

    function entry() external {
        target.ping();
    }
}
`,
        "lib/TargetB.sol": `pragma solidity ^0.8.24;
contract TargetB {
    function ping() external {}
}
`,
      };

      const parser = new SolidityParser();
      const uris: string[] = [];
      for (const [name, contents] of Object.entries(files)) {
        const filePath = path.join(tmpDir, name);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, contents, "utf-8");
        const uri = URI.file(filePath).toString();
        uris.push(uri);
        parser.parse(uri, contents);
      }

      const workspace = makeWorkspace(tmpDir, uris);
      const symbolIndex = new SymbolIndex(parser, workspace);
      for (const uri of uris) symbolIndex.updateFile(uri);
      const resolver = new SemanticResolver(parser, workspace, symbolIndex);
      const graph = new GraphIndex(parser, workspace, resolver, symbolIndex);
      const callerPath = path.join(tmpDir, "src/Caller.sol");
      const targetBPath = path.join(tmpDir, "lib/TargetB.sol");
      const pingCallOffset = fs.readFileSync(callerPath, "utf-8").indexOf("ping");
      graph.setSolcBridge({
        getDeclarationInfoAt: (filePath: string, offset: number) =>
          filePath === callerPath && offset === pingCallOffset
            ? {
                declarationId: 4343,
                declarationFilePath: targetBPath,
                declarationOffset: files["lib/TargetB.sol"].indexOf("function ping"),
                declarationLength: "function ping() external {}".length,
                nodeType: "FunctionDefinition",
                name: "ping",
              }
            : null,
      } as unknown as SolcBridge);
      graph.rebuildWorkspace();

      const entry = graph
        .getNodes()
        .find((node) => node.name === "entry" && node.containerName === "Caller");
      const targetAPing = graph
        .getNodes()
        .find((node) => node.name === "ping" && node.containerName === "TargetA");
      const targetBPing = graph
        .getNodes()
        .find((node) => node.name === "ping" && node.containerName === "TargetB");
      assert.ok(entry, "expected Caller.entry node");
      assert.ok(targetAPing, "expected indexed TargetA.ping node");
      assert.equal(targetBPing, undefined, "dependency TargetB should not be indexed by default");

      const calls = graph.getOutgoingEdges(entry.id, "calls");
      assert.ok(
        calls.some(
          (edge) =>
            edge.target === entry.id &&
            edge.unresolvedTarget === true &&
            edge.metadata?.resolutionConfidence === "solc" &&
            edge.metadata?.solcDeclarationId === 4343 &&
            edge.metadata?.solcTargetUnmapped === true,
        ),
        "expected compiler-resolved but unindexed calls to stay unresolved",
      );
      assert.ok(
        calls.every((edge) => edge.target !== targetAPing.id),
        "did not expect parser fallback target when solc maps to an unindexed declaration",
      );
      assert.ok(
        graph
          .getOutgoingEdges(entry.id, "externalCall")
          .every((edge) => edge.target !== targetAPing.id),
        "did not expect externalCall edge to keep the parser fallback target",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses warm solc declaration info to retarget non-call relationship edges", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-index-solc-rich-retarget-"));
    try {
      const files = {
        "src/Other.sol": `pragma solidity ^0.8.24;
contract Other {
    uint256 public total;
    event Updated(uint256 value);
    error Unauthorized();
}
`,
        "src/Caller.sol": `pragma solidity ^0.8.24;
import "./Other.sol";

contract Caller {
    uint256 public total;
    event Updated(uint256 value);
    error Unauthorized();

    function entry() external {
        total = 1;
        emit Updated(total);
        revert Unauthorized();
    }
}
`,
      };

      const parser = new SolidityParser();
      const uris: string[] = [];
      for (const [name, contents] of Object.entries(files)) {
        const filePath = path.join(tmpDir, name);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, contents, "utf-8");
        const uri = URI.file(filePath).toString();
        uris.push(uri);
        parser.parse(uri, contents);
      }

      const workspace = makeWorkspace(tmpDir, uris);
      const symbolIndex = new SymbolIndex(parser, workspace);
      for (const uri of uris) symbolIndex.updateFile(uri);
      const resolver = new SemanticResolver(parser, workspace, symbolIndex);
      const graph = new GraphIndex(parser, workspace, resolver, symbolIndex);
      const callerPath = path.join(tmpDir, "src/Caller.sol");
      const otherPath = path.join(tmpDir, "src/Other.sol");
      const callerText = files["src/Caller.sol"];
      const otherText = files["src/Other.sol"];
      const totalWriteOffset = callerText.indexOf("total = 1");
      const emitOffset = callerText.indexOf("Updated(total)");
      const revertOffset = callerText.lastIndexOf("Unauthorized();");
      graph.setSolcBridge({
        getDeclarationInfoAt: (filePath: string, offset: number) => {
          if (filePath !== callerPath) return null;
          if (offset === totalWriteOffset) {
            return {
              declarationId: 5101,
              declarationFilePath: otherPath,
              declarationOffset: otherText.indexOf("total"),
              declarationLength: "total".length,
              nodeType: "VariableDeclaration",
              name: "total",
            };
          }
          if (offset === emitOffset) {
            return {
              declarationId: 5102,
              declarationFilePath: otherPath,
              declarationOffset: otherText.indexOf("Updated"),
              declarationLength: "Updated".length,
              nodeType: "EventDefinition",
              name: "Updated",
            };
          }
          if (offset === revertOffset) {
            return {
              declarationId: 5103,
              declarationFilePath: otherPath,
              declarationOffset: otherText.indexOf("Unauthorized"),
              declarationLength: "Unauthorized".length,
              nodeType: "ErrorDefinition",
              name: "Unauthorized",
            };
          }
          return null;
        },
      } as unknown as SolcBridge);
      graph.rebuildWorkspace();

      const entry = graph
        .getNodes()
        .find((node) => node.name === "entry" && node.containerName === "Caller");
      const callerTotal = graph
        .getNodes()
        .find((node) => node.name === "total" && node.containerName === "Caller");
      const otherTotal = graph
        .getNodes()
        .find((node) => node.name === "total" && node.containerName === "Other");
      const callerUpdated = graph
        .getNodes()
        .find((node) => node.name === "Updated" && node.containerName === "Caller");
      const otherUpdated = graph
        .getNodes()
        .find((node) => node.name === "Updated" && node.containerName === "Other");
      const callerUnauthorized = graph
        .getNodes()
        .find((node) => node.name === "Unauthorized" && node.containerName === "Caller");
      const otherUnauthorized = graph
        .getNodes()
        .find((node) => node.name === "Unauthorized" && node.containerName === "Other");
      assert.ok(entry, "expected Caller.entry node");
      assert.ok(callerTotal, "expected Caller.total node");
      assert.ok(otherTotal, "expected Other.total node");
      assert.ok(callerUpdated, "expected Caller.Updated node");
      assert.ok(otherUpdated, "expected Other.Updated node");
      assert.ok(callerUnauthorized, "expected Caller.Unauthorized node");
      assert.ok(otherUnauthorized, "expected Other.Unauthorized node");

      const writes = graph.getOutgoingEdges(entry.id, "writes");
      assert.ok(
        writes.some(
          (edge) =>
            edge.target === otherTotal.id &&
            edge.metadata?.resolutionConfidence === "solc" &&
            edge.metadata?.solcDeclarationId === 5101,
        ),
        "expected state write edge to use compiler-resolved declaration target",
      );
      assert.ok(
        writes.every((edge) => edge.target !== callerTotal.id),
        "did not expect parser fallback state variable target when solc maps elsewhere",
      );

      const emits = graph.getOutgoingEdges(entry.id, "emits");
      assert.ok(
        emits.some(
          (edge) =>
            edge.target === otherUpdated.id &&
            edge.metadata?.resolutionConfidence === "solc" &&
            edge.metadata?.solcDeclarationId === 5102,
        ),
        "expected emit edge to use compiler-resolved event target",
      );
      assert.ok(
        emits.every((edge) => edge.target !== callerUpdated.id),
        "did not expect parser fallback event target when solc maps elsewhere",
      );

      const reverts = graph.getOutgoingEdges(entry.id, "revertsWith");
      assert.ok(
        reverts.some(
          (edge) =>
            edge.target === otherUnauthorized.id &&
            edge.metadata?.resolutionConfidence === "solc" &&
            edge.metadata?.solcDeclarationId === 5103,
        ),
        "expected revert edge to use compiler-resolved error target",
      );
      assert.ok(
        reverts.every((edge) => edge.target !== callerUnauthorized.id),
        "did not expect parser fallback error target when solc maps elsewhere",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("marks warm solc non-call targets unresolved when the compiler target is not indexed", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-index-solc-unmapped-rich-"));
    try {
      const files = {
        "src/Caller.sol": `pragma solidity ^0.8.24;
contract Caller {
    uint256 public total;
    event Updated();
    error Unauthorized();

    function entry() external returns (uint256 copy) {
        total = 1;
        copy = total;
        emit Updated();
        revert Unauthorized();
    }
}
`,
        "lib/Other.sol": `pragma solidity ^0.8.24;
contract Other {
    uint256 public total;
    event Updated();
    error Unauthorized();
}
`,
      };

      const parser = new SolidityParser();
      const uris: string[] = [];
      for (const [name, contents] of Object.entries(files)) {
        const filePath = path.join(tmpDir, name);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, contents, "utf-8");
        const uri = URI.file(filePath).toString();
        uris.push(uri);
        parser.parse(uri, contents);
      }

      const workspace = makeWorkspace(tmpDir, uris);
      const symbolIndex = new SymbolIndex(parser, workspace);
      for (const uri of uris) symbolIndex.updateFile(uri);
      const resolver = new SemanticResolver(parser, workspace, symbolIndex);
      const graph = new GraphIndex(parser, workspace, resolver, symbolIndex);
      const callerPath = path.join(tmpDir, "src/Caller.sol");
      const otherPath = path.join(tmpDir, "lib/Other.sol");
      const callerText = files["src/Caller.sol"];
      const otherText = files["lib/Other.sol"];
      const totalWriteOffset = callerText.indexOf("total = 1");
      const totalReadOffset = callerText.indexOf("copy = total") + "copy = ".length;
      const emitOffset = callerText.indexOf("emit Updated();") + "emit ".length;
      const revertOffset = callerText.lastIndexOf("Unauthorized();");
      graph.setSolcBridge({
        getDeclarationInfoAt: (filePath: string, offset: number) => {
          if (filePath !== callerPath) return null;
          if (offset === totalWriteOffset) {
            return {
              declarationId: 5201,
              declarationFilePath: otherPath,
              declarationOffset: otherText.indexOf("total"),
              declarationLength: "total".length,
              nodeType: "VariableDeclaration",
              name: "total",
            };
          }
          if (offset === totalReadOffset) {
            return {
              declarationId: 5202,
              declarationFilePath: otherPath,
              declarationOffset: otherText.indexOf("total"),
              declarationLength: "total".length,
              nodeType: "VariableDeclaration",
              name: "total",
            };
          }
          if (offset === emitOffset) {
            return {
              declarationId: 5203,
              declarationFilePath: otherPath,
              declarationOffset: otherText.indexOf("Updated"),
              declarationLength: "Updated".length,
              nodeType: "EventDefinition",
              name: "Updated",
            };
          }
          if (offset === revertOffset) {
            return {
              declarationId: 5204,
              declarationFilePath: otherPath,
              declarationOffset: otherText.indexOf("Unauthorized"),
              declarationLength: "Unauthorized".length,
              nodeType: "ErrorDefinition",
              name: "Unauthorized",
            };
          }
          return null;
        },
      } as unknown as SolcBridge);
      graph.rebuildWorkspace();

      const entry = graph
        .getNodes()
        .find((node) => node.name === "entry" && node.containerName === "Caller");
      const callerTotal = graph
        .getNodes()
        .find((node) => node.name === "total" && node.containerName === "Caller");
      const callerUpdated = graph
        .getNodes()
        .find((node) => node.name === "Updated" && node.containerName === "Caller");
      const callerUnauthorized = graph
        .getNodes()
        .find((node) => node.name === "Unauthorized" && node.containerName === "Caller");
      const otherTotal = graph
        .getNodes()
        .find((node) => node.name === "total" && node.containerName === "Other");
      assert.ok(entry, "expected Caller.entry node");
      assert.ok(callerTotal, "expected Caller.total node");
      assert.ok(callerUpdated, "expected Caller.Updated node");
      assert.ok(callerUnauthorized, "expected Caller.Unauthorized node");
      assert.equal(otherTotal, undefined, "dependency Other should not be indexed by default");

      const hasUnmappedSolcEdge = (
        kind: "reads" | "writes" | "emits" | "revertsWith",
        id: number,
      ) =>
        graph
          .getOutgoingEdges(entry.id, kind)
          .some(
            (edge) =>
              edge.target === entry.id &&
              edge.unresolvedTarget === true &&
              edge.metadata?.resolutionConfidence === "solc" &&
              edge.metadata?.solcDeclarationId === id &&
              edge.metadata?.solcTargetUnmapped === true,
          );

      assert.ok(hasUnmappedSolcEdge("writes", 5201), "expected unmapped write to stay unresolved");
      assert.ok(hasUnmappedSolcEdge("reads", 5202), "expected unmapped read to stay unresolved");
      assert.ok(hasUnmappedSolcEdge("emits", 5203), "expected unmapped emit to stay unresolved");
      assert.ok(
        hasUnmappedSolcEdge("revertsWith", 5204),
        "expected unmapped revert to stay unresolved",
      );
      assert.ok(
        graph.getOutgoingEdges(entry.id, "writes").every((edge) => edge.target !== callerTotal.id),
        "did not expect write edge to keep the parser fallback target",
      );
      assert.ok(
        graph.getOutgoingEdges(entry.id, "reads").every((edge) => edge.target !== callerTotal.id),
        "did not expect read edge to keep the parser fallback target",
      );
      assert.ok(
        graph.getOutgoingEdges(entry.id, "emits").every((edge) => edge.target !== callerUpdated.id),
        "did not expect emit edge to keep the parser fallback target",
      );
      assert.ok(
        graph
          .getOutgoingEdges(entry.id, "revertsWith")
          .every((edge) => edge.target !== callerUnauthorized.id),
        "did not expect revert edge to keep the parser fallback target",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("indexes implementation, override, creation, external-call, and delegatecall edges", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-index-rich-edges-"));
    try {
      const files = {
        "src/IFoo.sol": `pragma solidity ^0.8.24;
interface IFoo {
    function run(uint256 amount) external;
    function run() external;
}
`,
        "src/Base.sol": `pragma solidity ^0.8.24;
contract Base {
    function hook(uint256 amount) public virtual {}
    function hook() public virtual {}
}
`,
        "src/Created.sol": `pragma solidity ^0.8.24;
contract Created {}
`,
        "src/Callable.sol": `pragma solidity ^0.8.24;
contract Callable {
    function call() external {}
}
`,
        "src/Impl.sol": `pragma solidity ^0.8.24;
import "./IFoo.sol";
import "./Base.sol";
import "./Created.sol";
import "./Callable.sol";

contract Impl is IFoo, Base {
    IFoo public target;
    Callable public callable;

    function run() external override {
        Created created = new Created();
        created;
    }

    function hook() public override {}

    function callTarget() external {
        target.run();
    }

    function tryTarget() external {
        try target.run() {} catch {}
    }

    function jump(address impl, bytes memory data) external {
        impl.delegatecall(data);
    }

    function lowLevel(address targetAddress, bytes memory data) external {
        targetAddress.call(data);
        targetAddress.staticcall(data);
    }

    function typedCall() external {
        callable.call();
    }
}
`,
      };

      const parser = new SolidityParser();
      const uris: string[] = [];
      for (const [name, contents] of Object.entries(files)) {
        const filePath = path.join(tmpDir, name);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, contents, "utf-8");
        const uri = URI.file(filePath).toString();
        uris.push(uri);
        parser.parse(uri, contents);
      }

      const workspace = makeWorkspace(tmpDir, uris);
      const symbolIndex = new SymbolIndex(parser, workspace);
      for (const uri of uris) symbolIndex.updateFile(uri);
      const resolver = new SemanticResolver(parser, workspace, symbolIndex);
      const graph = new GraphIndex(parser, workspace, resolver, symbolIndex);
      graph.rebuildWorkspace();

      const nodes = graph.getNodes();
      const implRun = nodes.find((node) => node.name === "run" && node.containerName === "Impl");
      const interfaceRun = nodes.find(
        (node) => node.name === "run" && node.containerName === "IFoo" && node.detail === "run()",
      );
      const interfaceRunWithAmount = nodes.find(
        (node) =>
          node.name === "run" &&
          node.containerName === "IFoo" &&
          node.detail === "run(uint256 amount)",
      );
      const implHook = nodes.find((node) => node.name === "hook" && node.containerName === "Impl");
      const baseHook = nodes.find(
        (node) => node.name === "hook" && node.containerName === "Base" && node.detail === "hook()",
      );
      const baseHookWithAmount = nodes.find(
        (node) =>
          node.name === "hook" &&
          node.containerName === "Base" &&
          node.detail === "hook(uint256 amount)",
      );
      const callTarget = nodes.find(
        (node) => node.name === "callTarget" && node.containerName === "Impl",
      );
      const tryTarget = nodes.find(
        (node) => node.name === "tryTarget" && node.containerName === "Impl",
      );
      const jump = nodes.find((node) => node.name === "jump" && node.containerName === "Impl");
      const lowLevel = nodes.find(
        (node) => node.name === "lowLevel" && node.containerName === "Impl",
      );
      const typedCall = nodes.find(
        (node) => node.name === "typedCall" && node.containerName === "Impl",
      );
      const created = nodes.find((node) => node.name === "Created" && node.kind === "contract");
      const callableCall = nodes.find(
        (node) => node.name === "call" && node.containerName === "Callable",
      );
      assert.ok(implRun, "expected Impl.run node");
      assert.ok(interfaceRun, "expected IFoo.run node");
      assert.ok(interfaceRunWithAmount, "expected overloaded IFoo.run(uint256) node");
      assert.ok(implHook, "expected Impl.hook node");
      assert.ok(baseHook, "expected Base.hook node");
      assert.ok(baseHookWithAmount, "expected overloaded Base.hook(uint256) node");
      assert.ok(callTarget, "expected Impl.callTarget node");
      assert.ok(tryTarget, "expected Impl.tryTarget node");
      assert.ok(jump, "expected Impl.jump node");
      assert.ok(lowLevel, "expected Impl.lowLevel node");
      assert.ok(typedCall, "expected Impl.typedCall node");
      assert.ok(created, "expected Created contract node");
      assert.ok(callableCall, "expected Callable.call node");

      assert.ok(
        graph
          .getOutgoingEdges(implRun.id, "implements")
          .some((edge) => edge.target === interfaceRun.id),
        "expected override of interface function to create implements edge",
      );
      assert.ok(
        graph
          .getOutgoingEdges(implRun.id, "implements")
          .every((edge) => edge.target !== interfaceRunWithAmount.id),
        "did not expect no-arg implementation to target overloaded interface function",
      );
      assert.ok(
        graph
          .getOutgoingEdges(implHook.id, "overrides")
          .some((edge) => edge.target === baseHook.id),
        "expected override of base function to create overrides edge",
      );
      assert.ok(
        graph
          .getOutgoingEdges(implHook.id, "overrides")
          .every((edge) => edge.target !== baseHookWithAmount.id),
        "did not expect no-arg override to target overloaded base function",
      );
      assert.ok(
        graph.getOutgoingEdges(implRun.id, "creates").some((edge) => edge.target === created.id),
        "expected new Created() to create creates edge",
      );
      assert.ok(
        graph
          .getOutgoingEdges(callTarget.id, "externalCall")
          .some((edge) => edge.target === interfaceRun.id),
        "expected receiver-typed target.run() to create externalCall edge",
      );
      assert.ok(
        graph
          .getOutgoingEdges(tryTarget.id, "externalCall")
          .some((edge) => edge.target === interfaceRun.id),
        "expected try target.run() to create externalCall edge",
      );

      const delegateCalls = graph.getOutgoingEdges(jump.id, "delegateCall");
      assert.equal(delegateCalls.length, 1);
      assert.equal(delegateCalls[0].target, jump.id);
      assert.equal(delegateCalls[0].metadata?.unresolvedTarget, true);
      assert.equal(delegateCalls[0].unresolvedTarget, true);
      assert.equal(delegateCalls[0].resolutionConfidence, "heuristic");
      assert.equal(delegateCalls[0].evidence?.resolver, "heuristic");
      assert.match(delegateCalls[0].evidence?.summary ?? "", /unresolved delegateCall/);

      const lowLevelExternalCalls = graph.getOutgoingEdges(lowLevel.id, "externalCall");
      assert.equal(lowLevelExternalCalls.length, 2);
      assert.ok(
        lowLevelExternalCalls.every(
          (edge) =>
            edge.target === lowLevel.id &&
            edge.metadata?.lowLevelCall === true &&
            edge.metadata?.unresolvedTarget === true,
        ),
        "expected address.call/staticcall to create unresolved externalCall edges",
      );
      assert.deepEqual(lowLevelExternalCalls.map((edge) => edge.metadata?.calleeName).sort(), [
        "call",
        "staticcall",
      ]);
      assert.ok(
        lowLevelExternalCalls.every(
          (edge) => edge.unresolvedTarget === true && edge.resolutionConfidence === "heuristic",
        ),
        "expected unresolved low-level external call fields to be promoted onto graph edges",
      );
      assert.ok(
        lowLevelExternalCalls.every((edge) =>
          /unresolved externalCall/.test(edge.evidence?.summary ?? ""),
        ),
        "expected unresolved low-level external call evidence",
      );
      assert.ok(
        (graph.getStats().unresolvedEdgeCount ?? 0) >= 3,
        "expected graph stats to count unresolved delegatecall and low-level call edges",
      );
      assert.ok(
        (graph.getStats().edgesByResolutionConfidence?.heuristic ?? 0) >= 3,
        "expected graph stats to count heuristic edges",
      );

      assert.ok(
        graph
          .getOutgoingEdges(typedCall.id, "externalCall")
          .some((edge) => edge.target === callableCall.id),
        "expected contract method named call() to resolve as a typed external call",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("stays within interactive performance budgets for medium workspaces", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-index-perf-test-"));
    try {
      const files: Record<string, string> = {};
      for (let i = 0; i < 80; i++) {
        files[`src/C${i}.sol`] = `pragma solidity ^0.8.24;
contract C${i} {
    uint256 public value;
    event Updated(uint256 value);

    function bump() external {
        value += 1;
        emit Updated(value);
    }
}
`;
      }

      const parser = new SolidityParser();
      const uris: string[] = [];
      for (const [name, contents] of Object.entries(files)) {
        const filePath = path.join(tmpDir, name);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, contents, "utf-8");
        const uri = URI.file(filePath).toString();
        uris.push(uri);
        parser.parse(uri, contents);
      }

      const workspace = makeWorkspace(tmpDir, uris);
      const symbolIndex = new SymbolIndex(parser, workspace);
      for (const uri of uris) symbolIndex.updateFile(uri);
      const resolver = new SemanticResolver(parser, workspace, symbolIndex);
      const graph = new GraphIndex(parser, workspace, resolver, symbolIndex);

      const rebuildStarted = Date.now();
      graph.rebuildWorkspace();
      const rebuildMs = Date.now() - rebuildStarted;
      assert.ok(
        rebuildMs < 1_500,
        `expected medium graph rebuild under 1500ms, got ${rebuildMs}ms`,
      );

      const projectStarted = Date.now();
      const capped = graph.toProjectGraph(undefined, 120);
      const projectMs = Date.now() - projectStarted;
      assert.ok(projectMs < 150, `expected capped graph query under 150ms, got ${projectMs}ms`);
      assert.equal(capped.nodes.length, 120);
      assert.equal(capped.truncated, true);

      const root = graph
        .getNodes()
        .find((node) => node.name === "bump" && node.containerName === "C40");
      assert.ok(root, "expected C40.bump node");
      const neighborhoodStarted = Date.now();
      const neighborhood = graph.toNeighborhood({
        rootId: root.id,
        depth: 2,
        direction: "both",
        maxNodes: 120,
      });
      const neighborhoodMs = Date.now() - neighborhoodStarted;
      assert.ok(
        neighborhoodMs < 150,
        `expected graph neighborhood query under 150ms, got ${neighborhoodMs}ms`,
      );
      assert.equal(neighborhood.focusId, root.id);

      const updateUri = URI.file(path.join(tmpDir, "src/C40.sol")).toString();
      const updatedText = files["src/C40.sol"].replace("value += 1;", "value += 2;");
      fs.writeFileSync(path.join(tmpDir, "src/C40.sol"), updatedText, "utf-8");
      parser.parse(updateUri, updatedText);
      symbolIndex.updateFile(updateUri);
      const updateStarted = Date.now();
      graph.updateFileAndDependents(updateUri);
      const updateMs = Date.now() - updateStarted;
      assert.ok(updateMs < 250, `expected graph incremental update under 250ms, got ${updateMs}ms`);

      const cacheDir = path.join(tmpDir, ".cache", "graph-index");
      const writeStarted = Date.now();
      graph.writeCache(cacheDir);
      const writeMs = Date.now() - writeStarted;
      assert.ok(writeMs < 500, `expected graph cache write under 500ms, got ${writeMs}ms`);

      const restoreGraph = new GraphIndex(parser, workspace, resolver, symbolIndex);
      const restoreStarted = Date.now();
      assert.equal(restoreGraph.restoreFromCache(cacheDir), true);
      const restoreMs = Date.now() - restoreStarted;
      assert.ok(restoreMs < 500, `expected graph cache restore under 500ms, got ${restoreMs}ms`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps large-workspace declaration indexing and relationship batches bounded", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-index-large-perf-test-"));
    try {
      const parser = new SolidityParser();
      const uris: string[] = [];
      for (let i = 0; i < 1_000; i++) {
        const contents = `pragma solidity ^0.8.24;
contract Large${i} {
    uint256 public value;

    function read() external view returns (uint256) {
        return value;
    }
}
`;
        const filePath = path.join(tmpDir, "src", `Large${i}.sol`);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, contents, "utf-8");
        const uri = URI.file(filePath).toString();
        uris.push(uri);
        parser.parse(uri, contents);
      }

      const workspace = makeWorkspace(tmpDir, uris);
      const symbolIndex = new SymbolIndex(parser, workspace);
      for (const uri of uris) symbolIndex.updateFile(uri);
      const resolver = new SemanticResolver(parser, workspace, symbolIndex);
      const graph = new GraphIndex(parser, workspace, resolver, symbolIndex);

      const declarationStarted = Date.now();
      graph.rebuildWorkspaceDeclarations();
      const declarationMs = Date.now() - declarationStarted;
      assert.ok(
        declarationMs < 1_000,
        `expected large declaration graph under 1000ms, got ${declarationMs}ms`,
      );

      let stats = graph.getStats();
      assert.equal(stats.relationshipIndexComplete, false);
      assert.equal(stats.relationshipFilesTotal, 1_000);
      assert.equal(stats.relationshipFilesIndexed, 0);
      assert.equal(graph.getNodes().length, 4_000);

      const firstBatch = graph.indexRelationshipBatch(20, 10);
      assert.equal(firstBatch.filesIndexed, 10);
      assert.equal(firstBatch.complete, false);
      assert.ok(
        firstBatch.durationMs < 100,
        `expected first relationship batch under 100ms, got ${firstBatch.durationMs}ms`,
      );

      const root = graph
        .getNodes()
        .find((node) => node.name === "read" && node.containerName === "Large999");
      assert.ok(root, "expected Large999.read node");
      const ensureStarted = Date.now();
      graph.ensureFileRelationships(root.uri);
      const ensureMs = Date.now() - ensureStarted;
      assert.ok(
        ensureMs < 100,
        `expected focused relationship indexing under 100ms, got ${ensureMs}ms`,
      );
      assert.ok(graph.getOutgoingEdges(root.id, "reads").length >= 1);

      stats = graph.getStats();
      assert.equal(stats.relationshipIndexComplete, false);
      assert.ok((stats.relationshipFilesIndexed ?? 0) >= 11);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps Foundry-shaped project graph indexing bounded", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-index-foundry-perf-test-"));
    try {
      const parser = new SolidityParser();
      const uris: string[] = [];
      const files: Record<string, string> = {};

      for (let i = 0; i < 40; i++) {
        files[`interfaces/IAsset${i}.sol`] = `pragma solidity ^0.8.24;
interface IAsset${i} {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}
`;
      }

      for (let i = 0; i < 24; i++) {
        files[`lib/Math${i}.sol`] = `pragma solidity ^0.8.24;
library Math${i} {
    function add(uint256 a, uint256 b) internal pure returns (uint256) {
        return a + b;
    }
}
`;
      }

      for (let i = 0; i < 24; i++) {
        files[`src/base/Base${i}.sol`] = `pragma solidity ^0.8.24;
abstract contract Base${i} {
    uint256 internal baseValue;

    function baseRead() public view returns (uint256) {
        return baseValue;
    }
}
`;
      }

      for (let i = 0; i < 160; i++) {
        const asset = i % 40;
        const math = i % 24;
        const base = i % 24;
        const previousImport = i > 0 ? `import "./Vault${i - 1}.sol";\n` : "";
        const previousType = i > 0 ? `Vault${i - 1} previous` : "Base0 previous";
        files[`src/Vault${i}.sol`] = `pragma solidity ^0.8.24;
import "../interfaces/IAsset${asset}.sol";
import "../lib/Math${math}.sol";
import "./base/Base${base}.sol";
${previousImport}
contract Vault${i} is Base${base} {
    using Math${math} for uint256;

    IAsset${asset} internal asset;
    uint256 public totalAssets;
    event Deposited(address indexed account, uint256 amount);
    error TransferFailed();

    function deposit(uint256 amount) external {
        totalAssets = totalAssets.add(amount);
        baseValue = baseValue.add(amount);
        if (!asset.transfer(address(this), amount)) revert TransferFailed();
        emit Deposited(msg.sender, amount);
    }

    function preview(${previousType}) external view returns (uint256) {
        return asset.balanceOf(address(this)) + totalAssets + previous.baseRead();
    }
}
`;
      }

      for (let i = 0; i < 40; i++) {
        const vault = i * 4;
        files[`test/Vault${vault}.t.sol`] = `pragma solidity ^0.8.24;
import "../src/Vault${vault}.sol";

contract Vault${vault}Test {
    Vault${vault} internal vault;

    function test_deposit_smoke() external {
        vault.deposit(1);
    }
}
`;
      }

      for (const [name, contents] of Object.entries(files)) {
        const filePath = path.join(tmpDir, name);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, contents, "utf-8");
        const uri = URI.file(filePath).toString();
        uris.push(uri);
        parser.parse(uri, contents);
      }

      const workspace = makeWorkspace(tmpDir, uris);
      const symbolIndex = new SymbolIndex(parser, workspace);
      for (const uri of uris) symbolIndex.updateFile(uri);
      const resolver = new SemanticResolver(parser, workspace, symbolIndex);
      const graph = new GraphIndex(parser, workspace, resolver, symbolIndex);

      const declarationStarted = Date.now();
      graph.rebuildWorkspaceDeclarations();
      const declarationMs = Date.now() - declarationStarted;
      assert.ok(
        declarationMs < 3_000,
        `expected Foundry-shaped declarations under 3000ms, got ${declarationMs}ms`,
      );

      let stats = graph.getStats();
      assert.equal(stats.relationshipFilesTotal, 264);
      assert.equal(stats.relationshipIndexComplete, false);
      assert.equal(stats.filesByTier.project, 224);
      assert.equal(stats.filesByTier.deps ?? 0, 0);
      assert.equal(stats.filesByTier.tests, 40);

      const firstBatch = graph.indexRelationshipBatch(35, 20);
      assert.equal(firstBatch.filesIndexed, 20);
      assert.equal(firstBatch.complete, false);
      assert.ok(
        firstBatch.durationMs < 500,
        `expected Foundry-shaped relationship batch under 500ms, got ${firstBatch.durationMs}ms`,
      );

      const vaultUri = URI.file(path.join(tmpDir, "src/Vault159.sol")).toString();
      const focusedStarted = Date.now();
      graph.ensureFileRelationships(vaultUri);
      const focusedMs = Date.now() - focusedStarted;
      assert.ok(
        focusedMs < 500,
        `expected focused Foundry-shaped indexing under 500ms, got ${focusedMs}ms`,
      );

      const deposit = graph
        .getNodes()
        .find((node) => node.name === "deposit" && node.containerName === "Vault159");
      assert.ok(deposit, "expected Vault159.deposit node");
      assert.ok(
        graph.getOutgoingEdges(deposit.id, "externalCall").some((edge) => {
          const target = graph.getNode(edge.target);
          return target?.name === "transfer" && target.containerName === "IAsset39";
        }),
        "expected receiver-typed IAsset.transfer externalCall edge",
      );
      assert.ok(
        graph.getOutgoingEdges(deposit.id, "writes").some((edge) => {
          const target = graph.getNode(edge.target);
          return target?.name === "totalAssets" && target.containerName === "Vault159";
        }),
        "expected state write edge for totalAssets",
      );
      assert.ok(
        graph.getOutgoingEdges(deposit.id, "emits").some((edge) => {
          const target = graph.getNode(edge.target);
          return target?.name === "Deposited" && target.containerName === "Vault159";
        }),
        "expected event emission edge",
      );

      const cacheDir = path.join(tmpDir, ".cache", "graph-index");
      const writeStarted = Date.now();
      graph.writeCache(cacheDir);
      const writeMs = Date.now() - writeStarted;
      assert.ok(
        writeMs < 1_500,
        `expected Foundry-shaped cache write under 1500ms, got ${writeMs}ms`,
      );

      const restored = new GraphIndex(parser, workspace, resolver, symbolIndex);
      const restoreStarted = Date.now();
      assert.equal(restored.restoreFromCache(cacheDir), true);
      const restoreMs = Date.now() - restoreStarted;
      assert.ok(
        restoreMs < 1_500,
        `expected Foundry-shaped cache restore under 1500ms, got ${restoreMs}ms`,
      );

      const baseUri = URI.file(path.join(tmpDir, "src/base/Base15.sol")).toString();
      const updatedBase = files["src/base/Base15.sol"].replace(
        "return baseValue;",
        "return baseValue + 1;",
      );
      parser.parse(baseUri, updatedBase);
      symbolIndex.updateFile(baseUri);
      const updateStarted = Date.now();
      const updatedUris = graph.updateFileAndDependents(baseUri);
      const updateMs = Date.now() - updateStarted;
      assert.ok(
        updateMs < 2_000,
        `expected shared-base incremental update under 2000ms, got ${updateMs}ms`,
      );
      assert.ok(updatedUris.length > 1, "expected shared base update to refresh dependents");

      stats = graph.getStats();
      assert.equal(stats.relationshipIndexComplete, false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps dependency relationship indexing opt-in while preserving dependency declarations", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-index-deps-test-"));
    try {
      const files = {
        "src/App.sol": `pragma solidity ^0.8.24;
import "../lib/Dep.sol";

contract App {
    Dep internal dep;

    function run() external view returns (uint256) {
        return dep.read();
    }
}
`,
        "lib/Dep.sol": `pragma solidity ^0.8.24;

contract Dep {
    uint256 internal total;

    function read() external view returns (uint256) {
        return total;
    }
}
`,
      };
      const parser = new SolidityParser();
      const uris: string[] = [];
      for (const [name, contents] of Object.entries(files)) {
        const filePath = path.join(tmpDir, name);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, contents, "utf-8");
        const uri = URI.file(filePath).toString();
        uris.push(uri);
        parser.parse(uri, contents);
      }

      const workspace = makeWorkspace(tmpDir, uris);
      const symbolIndex = new SymbolIndex(parser, workspace);
      for (const uri of uris) symbolIndex.updateFile(uri);
      const resolver = new SemanticResolver(parser, workspace, symbolIndex);

      const defaultDepsDisabled = new GraphIndex(parser, workspace, resolver, symbolIndex);
      defaultDepsDisabled.rebuildWorkspaceDeclarations();
      let stats = defaultDepsDisabled.getStats();
      assert.equal(stats.filesByTier.project, 1);
      assert.equal(stats.filesByTier.deps ?? 0, 0);
      assert.equal(stats.relationshipFilesTotal, 1);
      assert.equal(
        defaultDepsDisabled.getNodes().some((node) => node.containerName === "Dep"),
        false,
        "expected dependency declarations to be omitted by default",
      );

      const declarationsOnlyDeps = new GraphIndex(parser, workspace, resolver, symbolIndex);
      assert.equal(declarationsOnlyDeps.setDependencyIndexing("declarations"), true);
      declarationsOnlyDeps.rebuildWorkspaceDeclarations();
      stats = declarationsOnlyDeps.getStats();
      assert.equal(stats.filesByTier.project, 1);
      assert.equal(stats.filesByTier.deps, 1);
      assert.equal(stats.relationshipFilesTotal, 1);
      assert.equal(stats.pendingRelationshipFiles, 1);

      const depRead = declarationsOnlyDeps
        .getNodes()
        .find((node) => node.name === "read" && node.containerName === "Dep");
      const depTotal = declarationsOnlyDeps
        .getNodes()
        .find((node) => node.name === "total" && node.containerName === "Dep");
      assert.ok(depRead, "expected dependency function declaration node");
      assert.ok(depTotal, "expected dependency state declaration node");
      assert.equal(
        declarationsOnlyDeps.toProjectGraph().nodes.some((node) => node.containerName === "Dep"),
        false,
        "expected dependency declarations to stay hidden from project graph results by default",
      );
      assert.ok(
        (declarationsOnlyDeps.toProjectGraph().scope?.hiddenDependencyNodeCount ?? 0) > 0,
        "expected default graph result to explain hidden dependency nodes",
      );
      assert.equal(
        declarationsOnlyDeps
          .toProjectGraph(undefined, undefined, false, true)
          .nodes.some((node) => node.containerName === "Dep"),
        true,
        "expected includeDependencies to expose indexed dependency declarations",
      );
      assert.equal(
        declarationsOnlyDeps.toProjectGraph(undefined, undefined, false, true).scope
          ?.hiddenDependencyNodeCount,
        0,
        "expected includeDependencies to clear dependency hidden-node diagnostics",
      );
      const hiddenDependencySearch = declarationsOnlyDeps.search({ query: "Dep" });
      assert.equal(
        hiddenDependencySearch.matches.some(
          (match) => match.node.containerName === "Dep" || match.node.name === "Dep",
        ),
        false,
        "expected dependency declarations to stay hidden from graph search by default",
      );
      assert.ok(
        (hiddenDependencySearch.scope?.hiddenDependencyNodeCount ?? 0) > 0,
        "expected search result to explain hidden dependency nodes",
      );
      assert.ok(
        declarationsOnlyDeps
          .search({ query: "Dep", includeDependencies: true })
          .matches.some((match) => match.node.containerName === "Dep" || match.node.name === "Dep"),
        "expected includeDependencies to expose dependency declarations in graph search",
      );

      while (!declarationsOnlyDeps.indexRelationshipBatch(10, 10).complete) {
        // Drain project/test relationship work.
      }
      stats = declarationsOnlyDeps.getStats();
      assert.equal(stats.relationshipIndexComplete, true);
      assert.equal(stats.relationshipFilesIndexed, 1);
      assert.equal(declarationsOnlyDeps.getOutgoingEdges(depRead.id, "reads").length, 0);

      const fullDeps = new GraphIndex(parser, workspace, resolver, symbolIndex);
      assert.equal(fullDeps.setDependencyIndexing("relationships"), true);
      fullDeps.rebuildWorkspace();
      stats = fullDeps.getStats();
      assert.equal(stats.relationshipFilesTotal, 2);
      assert.equal(stats.relationshipIndexComplete, true);
      const fullDepRead = fullDeps
        .getNodes()
        .find((node) => node.name === "read" && node.containerName === "Dep");
      const fullDepTotal = fullDeps
        .getNodes()
        .find((node) => node.name === "total" && node.containerName === "Dep");
      assert.ok(fullDepRead, "expected dependency read node");
      assert.ok(fullDepTotal, "expected dependency total node");
      assert.ok(
        fullDeps
          .getOutgoingEdges(fullDepRead.id, "reads")
          .some((edge) => edge.target === fullDepTotal.id),
        "expected dependency relationship edge only when dependency relationships are enabled",
      );

      assert.equal(declarationsOnlyDeps.setDependencyIndexing("disabled"), true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("tolerates skipped tuple slots while indexing local variables", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-index-test-"));
    try {
      const contents = `pragma solidity ^0.8.24;
contract TupleLocals {
    uint256 internal total;

    function pair() internal pure returns (uint256, uint256) {
        return (1, 2);
    }

    function readSecond() external returns (uint256) {
        (, uint256 value) = pair();
        total = value;
        return total;
    }
}
`;
      const filePath = path.join(tmpDir, "src/TupleLocals.sol");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, contents, "utf-8");
      const uri = URI.file(filePath).toString();
      const parser = new SolidityParser();
      parser.parse(uri, contents);
      const workspace = makeWorkspace(tmpDir, [uri]);
      const symbolIndex = new SymbolIndex(parser, workspace);
      symbolIndex.updateFile(uri);
      const resolver = new SemanticResolver(parser, workspace, symbolIndex);
      const graph = new GraphIndex(parser, workspace, resolver, symbolIndex);

      assert.doesNotThrow(() => graph.rebuildWorkspace());
      const readSecond = graph
        .getNodes()
        .find((node) => node.name === "readSecond" && node.containerName === "TupleLocals");
      const total = graph
        .getNodes()
        .find((node) => node.name === "total" && node.containerName === "TupleLocals");
      assert.ok(readSecond, "expected readSecond function node");
      assert.ok(total, "expected total state variable node");
      assert.ok(
        graph
          .getOutgoingEdges(readSecond.id, "writes")
          .some((edge) => edge.target === total.id && edge.metadata?.variableName === "total"),
        "expected write edge for total",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("forces endpoint relationship indexing for selected-node shortest paths", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-index-path-test-"));
    try {
      const files = {
        "src/A.sol": `pragma solidity ^0.8.24;
import "./B.sol";

contract A {
    B internal b;

    function run() external {
        b.ping();
    }
}
`,
        "src/B.sol": `pragma solidity ^0.8.24;

contract B {
    function ping() external {}
}
`,
      };
      const uris: string[] = [];
      const parser = new SolidityParser();
      for (const [name, contents] of Object.entries(files)) {
        const filePath = path.join(tmpDir, name);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, contents, "utf-8");
        const uri = URI.file(filePath).toString();
        uris.push(uri);
        parser.parse(uri, contents);
      }

      const workspace = makeWorkspace(tmpDir, uris);
      const symbolIndex = new SymbolIndex(parser, workspace);
      for (const uri of uris) symbolIndex.updateFile(uri);
      const resolver = new SemanticResolver(parser, workspace, symbolIndex);
      const graph = new GraphIndex(parser, workspace, resolver, symbolIndex);

      graph.rebuildWorkspaceDeclarations();

      const run = graph
        .getNodes()
        .find((node) => node.name === "run" && node.containerName === "A");
      const ping = graph
        .getNodes()
        .find((node) => node.name === "ping" && node.containerName === "B");
      assert.ok(run, "expected A.run declaration node");
      assert.ok(ping, "expected B.ping declaration node");
      assert.equal(graph.getStats().relationshipFilesIndexed, 0);

      const pathResult = graph.toShortestPath({
        from: { nodeId: run.id },
        to: { nodeId: ping.id },
        direction: "outgoing",
        edgeKinds: ["calls"],
        maxDepth: 2,
      });

      assert.equal(pathResult.found, true);
      assert.deepEqual(
        pathResult.edges.map((edge) => [edge.source, edge.target, edge.kind]),
        [[run.id, ping.id, "calls"]],
      );
      assert.equal(graph.getStats().relationshipFilesIndexed, 2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("indexes intermediate files while searching outgoing shortest paths", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-index-path-hop-test-"));
    try {
      const files = {
        "src/A.sol": `pragma solidity ^0.8.24;
import "./B.sol";

contract A {
    B internal b;

    function run() external {
        b.ping();
    }
}
`,
        "src/B.sol": `pragma solidity ^0.8.24;
import "./C.sol";

contract B {
    C internal c;

    function ping() external {
        c.done();
    }
}
`,
        "src/C.sol": `pragma solidity ^0.8.24;

contract C {
    function done() external {}
}
`,
      };
      const uris: string[] = [];
      const parser = new SolidityParser();
      for (const [name, contents] of Object.entries(files)) {
        const filePath = path.join(tmpDir, name);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, contents, "utf-8");
        const uri = URI.file(filePath).toString();
        uris.push(uri);
        parser.parse(uri, contents);
      }

      const workspace = makeWorkspace(tmpDir, uris);
      const symbolIndex = new SymbolIndex(parser, workspace);
      for (const uri of uris) symbolIndex.updateFile(uri);
      const resolver = new SemanticResolver(parser, workspace, symbolIndex);
      const graph = new GraphIndex(parser, workspace, resolver, symbolIndex);

      graph.rebuildWorkspaceDeclarations();

      const run = graph
        .getNodes()
        .find((node) => node.name === "run" && node.containerName === "A");
      const ping = graph
        .getNodes()
        .find((node) => node.name === "ping" && node.containerName === "B");
      const done = graph
        .getNodes()
        .find((node) => node.name === "done" && node.containerName === "C");
      assert.ok(run, "expected A.run declaration node");
      assert.ok(ping, "expected B.ping declaration node");
      assert.ok(done, "expected C.done declaration node");
      assert.equal(graph.getStats().relationshipFilesIndexed, 0);

      const pathResult = graph.toShortestPath({
        from: { nodeId: run.id },
        to: { nodeId: done.id },
        direction: "outgoing",
        edgeKinds: ["calls"],
        maxDepth: 3,
      });

      assert.equal(pathResult.found, true);
      assert.deepEqual(
        pathResult.edges.map((edge) => [edge.source, edge.target, edge.kind]),
        [
          [run.id, ping.id, "calls"],
          [ping.id, done.id, "calls"],
        ],
      );
      assert.equal(graph.getStats().relationshipFilesIndexed, 3);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("indexes intermediate files while building outgoing neighborhoods", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-index-neighborhood-hop-test-"));
    try {
      const files = {
        "src/A.sol": `pragma solidity ^0.8.24;
import "./B.sol";

contract A {
    B internal b;

    function run() external {
        b.ping();
    }
}
`,
        "src/B.sol": `pragma solidity ^0.8.24;
import "./C.sol";

contract B {
    C internal c;

    function ping() external {
        c.done();
    }
}
`,
        "src/C.sol": `pragma solidity ^0.8.24;

contract C {
    function done() external {}
}
`,
      };
      const uris: string[] = [];
      const parser = new SolidityParser();
      for (const [name, contents] of Object.entries(files)) {
        const filePath = path.join(tmpDir, name);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, contents, "utf-8");
        const uri = URI.file(filePath).toString();
        uris.push(uri);
        parser.parse(uri, contents);
      }

      const workspace = makeWorkspace(tmpDir, uris);
      const symbolIndex = new SymbolIndex(parser, workspace);
      for (const uri of uris) symbolIndex.updateFile(uri);
      const resolver = new SemanticResolver(parser, workspace, symbolIndex);
      const graph = new GraphIndex(parser, workspace, resolver, symbolIndex);

      graph.rebuildWorkspaceDeclarations();

      const run = graph
        .getNodes()
        .find((node) => node.name === "run" && node.containerName === "A");
      const ping = graph
        .getNodes()
        .find((node) => node.name === "ping" && node.containerName === "B");
      const done = graph
        .getNodes()
        .find((node) => node.name === "done" && node.containerName === "C");
      assert.ok(run, "expected A.run declaration node");
      assert.ok(ping, "expected B.ping declaration node");
      assert.ok(done, "expected C.done declaration node");
      assert.equal(graph.getStats().relationshipFilesIndexed, 0);

      const neighborhood = graph.toNeighborhood({
        rootId: run.id,
        direction: "outgoing",
        edgeKinds: ["calls"],
        depth: 2,
        maxNodes: 20,
        includeContainers: false,
      });

      assert.deepEqual(
        neighborhood.edges.map((edge) => [edge.source, edge.target, edge.kind]),
        [
          [run.id, ping.id, "calls"],
          [ping.id, done.id, "calls"],
        ],
      );
      assert.deepEqual(
        neighborhood.nodes.map((node) => node.id).sort(),
        [run.id, ping.id, done.id].sort(),
      );
      assert.equal(graph.getStats().relationshipFilesIndexed, 2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("drains relationship indexing for callers queries", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-index-callers-test-"));
    try {
      const files = {
        "src/A.sol": `pragma solidity ^0.8.24;
import "./B.sol";

contract A {
    B internal b;

    function run() external {
        b.ping();
    }
}
`,
        "src/B.sol": `pragma solidity ^0.8.24;

contract B {
    function ping() external {}
}
`,
      };
      const uris: string[] = [];
      const parser = new SolidityParser();
      for (const [name, contents] of Object.entries(files)) {
        const filePath = path.join(tmpDir, name);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, contents, "utf-8");
        const uri = URI.file(filePath).toString();
        uris.push(uri);
        parser.parse(uri, contents);
      }
      const unparsedUri = URI.file(path.join(tmpDir, "src/GeneratedButUnparsed.sol")).toString();
      uris.push(unparsedUri);

      const workspace = makeWorkspace(tmpDir, uris);
      const symbolIndex = new SymbolIndex(parser, workspace);
      for (const uri of uris) symbolIndex.updateFile(uri);
      const resolver = new SemanticResolver(parser, workspace, symbolIndex);
      const graph = new GraphIndex(parser, workspace, resolver, symbolIndex);

      graph.rebuildWorkspaceDeclarations();

      const run = graph
        .getNodes()
        .find((node) => node.name === "run" && node.containerName === "A");
      const ping = graph
        .getNodes()
        .find((node) => node.name === "ping" && node.containerName === "B");
      assert.ok(run, "expected A.run declaration node");
      assert.ok(ping, "expected B.ping declaration node");
      assert.equal(graph.getStats().relationshipFilesIndexed, 0);
      assert.equal(graph.getStats().relationshipFilesTotal, 3);

      const callers = graph.query({
        kind: "callers",
        target: { nodeId: ping.id },
        maxNodes: 20,
      });

      assert.equal(callers.found, true);
      assert.ok(
        callers.edges.some((edge) => edge.source === run.id && edge.target === ping.id),
        "expected callers query to force-index all potential caller files",
      );
      assert.equal(callers.indexStatus?.partial, false);
      assert.equal(graph.getStats().relationshipIndexComplete, true);
      assert.equal(graph.getStats().relationshipFilesIndexed, 3);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("supports declaration-only rebuilds with chunked relationship indexing", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-index-test-"));
    try {
      const files = {
        "src/A.sol": `pragma solidity ^0.8.24;
import "./B.sol";

contract A {
    B internal b;

    function run() external {
        b.ping();
    }
}
`,
        "src/B.sol": `pragma solidity ^0.8.24;

contract B {
    function ping() external {}
}
`,
      };
      const uris: string[] = [];
      const parser = new SolidityParser();
      for (const [name, contents] of Object.entries(files)) {
        const filePath = path.join(tmpDir, name);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, contents, "utf-8");
        const uri = URI.file(filePath).toString();
        uris.push(uri);
        parser.parse(uri, contents);
      }

      const workspace = makeWorkspace(tmpDir, uris);
      const symbolIndex = new SymbolIndex(parser, workspace);
      for (const uri of uris) symbolIndex.updateFile(uri);
      const resolver = new SemanticResolver(parser, workspace, symbolIndex);
      const graph = new GraphIndex(parser, workspace, resolver, symbolIndex);

      graph.rebuildWorkspaceDeclarations();

      const run = graph
        .getNodes()
        .find((node) => node.name === "run" && node.containerName === "A");
      const ping = graph
        .getNodes()
        .find((node) => node.name === "ping" && node.containerName === "B");
      assert.ok(run, "expected A.run declaration node");
      assert.ok(ping, "expected B.ping declaration node");
      assert.equal(graph.getOutgoingEdges(run.id, "calls").length, 0);

      let stats = graph.getStats();
      assert.equal(stats.relationshipIndexComplete, false);
      assert.equal(stats.relationshipFilesIndexed, 0);
      assert.equal(stats.pendingRelationshipFiles, 2);
      assert.equal(
        graph.search({ query: "run" }).indexStatus?.partial,
        true,
        "expected search metadata to flag partial relationship indexing",
      );
      const selectedNodeCallees = graph.query({
        kind: "callees",
        target: { nodeId: run.id },
        maxNodes: 20,
      });
      assert.equal(selectedNodeCallees.found, true);
      assert.ok(
        selectedNodeCallees.edges.some((edge) => edge.source === run.id && edge.target === ping.id),
        "expected selected-node callees query to force-index the source file relationships",
      );
      assert.equal(graph.getStats().relationshipFilesIndexed, 1);

      const partialCacheDir = path.join(tmpDir, ".cache", "partial");
      graph.writeCache(partialCacheDir);
      const partialRestore = new GraphIndex(parser, workspace, resolver, symbolIndex);
      assert.equal(partialRestore.restoreFromCache(partialCacheDir), true);
      assert.equal(partialRestore.getStats().relationshipIndexComplete, false);
      partialRestore.ensureWorkspaceDeclarations();
      assert.equal(partialRestore.getStats().pendingRelationshipFiles, 1);

      const firstBatch = graph.indexRelationshipBatch(1, 1);
      assert.equal(firstBatch.filesIndexed, 2);
      assert.equal(firstBatch.complete, true);

      graph.ensureFileRelationships(URI.file(path.join(tmpDir, "src/A.sol")).toString());
      assert.ok(
        graph.getOutgoingEdges(run.id, "calls").some((edge) => edge.target === ping.id),
        "expected forced relationship indexing to add A.run -> B.ping",
      );

      while (!graph.indexRelationshipBatch(5, 5).complete) {
        // Drain remaining work.
      }

      stats = graph.getStats();
      assert.equal(stats.relationshipIndexComplete, true);
      assert.equal(stats.pendingRelationshipFiles, 0);

      const fullCacheDir = path.join(tmpDir, ".cache", "full");
      graph.writeCache(fullCacheDir);
      const restored = new GraphIndex(parser, workspace, resolver, symbolIndex);
      assert.equal(restored.restoreFromCache(fullCacheDir), true);
      assert.equal(restored.getStats().relationshipIndexComplete, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

function makeWorkspace(tmpDir: string, uris: string[]): WorkspaceManager {
  return {
    getAllFileUris: () => uris.slice(),
    getFileTier: (uri: string) => {
      const fsPath = URI.parse(uri).fsPath;
      if (fsPath.includes("/lib/")) return "deps";
      if (fsPath.includes("/test/")) return "tests";
      return "project";
    },
    resolveImport: (importPath: string, fromFile: string) => {
      const target = path.resolve(path.dirname(fromFile), importPath);
      return fs.existsSync(target) ? target : null;
    },
    uriToPath: (uri: string) => URI.parse(uri).fsPath,
    root: tmpDir,
  } as unknown as WorkspaceManager;
}
