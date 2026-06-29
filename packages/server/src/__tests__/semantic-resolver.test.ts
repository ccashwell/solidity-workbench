import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { URI } from "vscode-uri";
import { SolidityParser } from "../parser/solidity-parser.js";
import { SymbolIndex } from "../analyzer/symbol-index.js";
import { SemanticResolver } from "../analyzer/semantic-resolver.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";

describe("SemanticResolver", () => {
  it("resolves duplicate base names through the active import graph", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-resolver-test-"));
    try {
      const files = {
        "src/Base.sol": `pragma solidity ^0.8.24;
contract Base {
    function ping() internal {}
}
`,
        "src/Child.sol": `pragma solidity ^0.8.24;
import "./Base.sol";
contract Child is Base {}
`,
        "test/Base.sol": `pragma solidity ^0.8.24;
contract Base {
    function ping() internal {}
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

      const workspace: Pick<
        WorkspaceManager,
        "getAllFileUris" | "getFileTier" | "resolveImport" | "uriToPath"
      > = {
        getAllFileUris: () => uris.slice(),
        getFileTier: (uri: string) =>
          URI.parse(uri).fsPath.includes("/test/") ? "tests" : "project",
        resolveImport: (importPath: string, fromFile: string) => {
          const target = path.resolve(path.dirname(fromFile), importPath);
          return fs.existsSync(target) ? target : null;
        },
        uriToPath: (uri: string) => URI.parse(uri).fsPath,
      };
      const index = new SymbolIndex(parser, workspace as WorkspaceManager);
      for (const uri of uris) index.updateFile(uri);

      const resolver = new SemanticResolver(parser, workspace as WorkspaceManager, index);
      const childUri = URI.file(path.join(tmpDir, "src/Child.sol")).toString();
      const srcBasePath = path.join(tmpDir, "src/Base.sol");
      const testBasePath = path.join(tmpDir, "test/Base.sol");

      const base = resolver.resolveBaseContract(childUri, "Base");
      assert.ok(base, "expected imported Base to resolve");
      assert.equal(base.filePath, srcBasePath);
      assert.notEqual(base.filePath, testBasePath);

      const chain = resolver.getInheritanceChain("Child", childUri);
      assert.deepEqual(
        chain.map((entry) => entry.filePath),
        [path.join(tmpDir, "src/Child.sol"), srcBasePath],
      );

      const ping = resolver.findMemberInInheritanceChain("Child", "ping", childUri);
      assert.ok(ping, "expected inherited ping member");
      assert.equal(ping.filePath, URI.file(srcBasePath).toString());

      const subtypes = resolver.getSubtypes(base);
      assert.deepEqual(
        subtypes.map((entry) => entry.contract.name),
        ["Child"],
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not resolve contracts that are not visible from the current file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-resolver-visibility-test-"));
    try {
      const files = {
        "src/Current.sol": `pragma solidity ^0.8.24;
contract Current {
    Ghost ghost;
    ProjectOnly projectOnly;
}
`,
        "src/ProjectOnly.sol": `pragma solidity ^0.8.24;
contract ProjectOnly {}
`,
        "test/Ghost.sol": `pragma solidity ^0.8.24;
contract Ghost {}
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

      const workspace: Pick<
        WorkspaceManager,
        "getAllFileUris" | "getFileTier" | "resolveImport" | "uriToPath"
      > = {
        getAllFileUris: () => uris.slice(),
        getFileTier: (uri: string) =>
          URI.parse(uri).fsPath.includes("/test/") ? "tests" : "project",
        resolveImport: (importPath: string, fromFile: string) => {
          const target = path.resolve(path.dirname(fromFile), importPath);
          return fs.existsSync(target) ? target : null;
        },
        uriToPath: (uri: string) => URI.parse(uri).fsPath,
      };
      const index = new SymbolIndex(parser, workspace as WorkspaceManager);
      for (const uri of uris) index.updateFile(uri);

      const resolver = new SemanticResolver(parser, workspace as WorkspaceManager, index);
      const currentUri = URI.file(path.join(tmpDir, "src/Current.sol")).toString();

      assert.equal(resolver.resolveContract("Ghost", currentUri), undefined);
      assert.equal(resolver.resolveContract("ProjectOnly", currentUri), undefined);
      assert.equal(resolver.resolveBaseContract(currentUri, "Ghost"), undefined);
      assert.equal(resolver.resolveBaseContract(currentUri, "ProjectOnly"), undefined);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("filters top-level symbols by Solidity import exposure", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-resolver-import-filter-test-"));
    try {
      const files = {
        "src/Current.sol": `pragma solidity ^0.8.24;
import {Allowed} from "./Defs.sol";
import "./Plain.sol";
import * as Namespace from "./Namespaced.sol";
contract Current {
    Allowed allowed;
    PlainVisible plain;
    Namespace.NamespacedVisible namespaced;
}
`,
        "src/Defs.sol": `pragma solidity ^0.8.24;
contract Allowed {
    function allowedFn() internal {}
}
contract Hidden {}
`,
        "src/Plain.sol": `pragma solidity ^0.8.24;
import "./Transitive.sol";
contract PlainVisible {}
`,
        "src/Namespaced.sol": `pragma solidity ^0.8.24;
contract NamespacedVisible {}
`,
        "src/Transitive.sol": `pragma solidity ^0.8.24;
contract TransitiveHidden {}
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

      const workspace: Pick<
        WorkspaceManager,
        "getAllFileUris" | "getFileTier" | "resolveImport" | "uriToPath"
      > = {
        getAllFileUris: () => uris.slice(),
        getFileTier: () => "project",
        resolveImport: (importPath: string, fromFile: string) => {
          const target = path.resolve(path.dirname(fromFile), importPath);
          return fs.existsSync(target) ? target : null;
        },
        uriToPath: (uri: string) => URI.parse(uri).fsPath,
      };
      const index = new SymbolIndex(parser, workspace as WorkspaceManager);
      for (const uri of uris) index.updateFile(uri);

      const resolver = new SemanticResolver(parser, workspace as WorkspaceManager, index);
      const currentUri = URI.file(path.join(tmpDir, "src/Current.sol")).toString();
      const visible = (name: string) =>
        resolver
          .filterVisibleSymbols(currentUri, index.findSymbols(name), {
            includeNamespaceImports: false,
          })
          .map((sym) => sym.name);

      assert.deepEqual(visible("Allowed"), ["Allowed"]);
      assert.deepEqual(visible("PlainVisible"), ["PlainVisible"]);
      assert.deepEqual(visible("Hidden"), []);
      assert.deepEqual(visible("NamespacedVisible"), []);
      assert.deepEqual(visible("TransitiveHidden"), []);
      assert.deepEqual(visible("allowedFn"), ["allowedFn"]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
