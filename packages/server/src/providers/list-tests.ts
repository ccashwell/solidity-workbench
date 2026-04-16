import * as fs from "node:fs";
import { URI } from "vscode-uri";
import type {
  ListTestsParams,
  ListTestsResult,
  TestContractInfo,
  TestFunctionInfo,
} from "@solidity-workbench/common";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";
import type { SolidityParser } from "../parser/solidity-parser.js";

/**
 * Enumerate test contracts and functions across the workspace using the
 * real `@solidity-parser/parser` AST rather than client-side regex.
 *
 * A "test contract" is any contract that contains at least one function
 * whose name matches the Foundry test-function patterns:
 *   test_*, testFuzz_*, testFork_*, testFail_*, invariant_*, setUp.
 *
 * Scope:
 *  - When `params.folderUri` is set, only files within that root are
 *    scanned; otherwise every known workspace file is included.
 *  - Only regular `.sol` files are visited. Callers typically filter
 *    further to `.t.sol` in the client, but the server does not enforce
 *    that — a project may host tests outside the `*.t.sol` convention.
 */
export function listTests(
  workspace: WorkspaceManager,
  parser: SolidityParser,
  params: ListTestsParams,
): ListTestsResult {
  const contracts: TestContractInfo[] = [];

  const allUris = workspace.getAllFileUris();
  const uris = params.folderUri
    ? allUris.filter((uri) => uri.startsWith(params.folderUri!))
    : allUris;

  for (const uri of uris) {
    // Parse from the cache if available; otherwise parse from disk so
    // the call works even before the client has opened the file.
    let result = parser.get(uri);
    if (!result) {
      try {
        const text = fs.readFileSync(URI.parse(uri).fsPath, "utf-8");
        result = parser.parse(uri, text);
      } catch {
        continue;
      }
    }

    const isTestFile = uri.endsWith(".t.sol");

    for (const contract of result.sourceUnit.contracts) {
      if (contract.kind !== "contract" && contract.kind !== "abstract") continue;

      const tests: TestFunctionInfo[] = [];
      for (const func of contract.functions) {
        if (!func.name) continue;
        const kind = classifyTest(func.name);
        if (!kind) continue;
        tests.push({
          name: func.name,
          kind,
          range: func.range,
          isTestFile,
        });
      }

      if (tests.length === 0) continue;

      contracts.push({
        uri,
        name: contract.name,
        range: contract.range,
        tests,
      });
    }
  }

  return { contracts };
}

function classifyTest(name: string): TestFunctionInfo["kind"] | null {
  if (name === "setUp") return "setUp";
  if (name.startsWith("test_")) return "test";
  if (name.startsWith("testFuzz_")) return "testFuzz";
  if (name.startsWith("testFork_")) return "testFork";
  if (name.startsWith("testFail_")) return "testFail";
  if (name.startsWith("invariant_")) return "invariant";
  // Loose: a function named literally `test` or `testX...` without the
  // underscore. Foundry accepts these; the Test Explorer should too.
  if (name === "test" || /^test[A-Z]/.test(name)) return "test";
  if (/^testFuzz[A-Z]/.test(name)) return "testFuzz";
  if (/^testFork[A-Z]/.test(name)) return "testFork";
  if (/^testFail[A-Z]/.test(name)) return "testFail";
  if (/^invariant[A-Z]/.test(name)) return "invariant";
  return null;
}
