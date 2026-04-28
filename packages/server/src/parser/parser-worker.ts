import { parentPort } from "node:worker_threads";
import type { SoliditySourceUnit } from "@solidity-workbench/common";
import { SolidityParser } from "./solidity-parser.js";

/**
 * Worker entry for the parser pool. Lives in `dist/parser-worker.js`
 * after esbuild bundling and is spawned by `ParserPool` on the main
 * thread.
 *
 * Protocol:
 *   - Inbound `{ uri, text }`: parse a Solidity file.
 *   - Outbound `{ uri, sourceUnit, errors, text }`: success.
 *   - Outbound `{ uri, workerError }`: parse threw. Pool surfaces the
 *     message and the caller decides whether to fall back to a
 *     main-thread parse.
 *
 * The raw `@solidity-parser/parser` AST is *intentionally not* shipped
 * across the worker boundary. Two reasons:
 *
 *   1. It's a deeply-nested object — a 1000-line file produces ~100 KB
 *      of JSON, and structured-cloning that across the thread boundary
 *      for every bulk-indexed file would eat most of the parallelism
 *      win we're spawning workers for.
 *   2. Only `LinterProvider` and `SemanticTokensProvider` actually
 *      consume the raw AST, and both run only on files the user has
 *      opened in the editor — those go through the main thread's
 *      `documents.onDidChangeContent` path which calls the synchronous
 *      `SolidityParser.parse` directly and populates `rawAst` there.
 *      Bulk-indexed files (the lib/ tree) have `rawAst: null`; if a
 *      consumer reaches for it later, `SolidityParser.getRawAst`
 *      re-parses lazily on the main thread.
 */

if (!parentPort) {
  throw new Error("parser-worker.ts must be run inside a worker_threads Worker");
}

const port = parentPort;

interface ParseRequest {
  uri: string;
  text: string;
}

interface ParseResponse {
  uri: string;
  sourceUnit?: SoliditySourceUnit;
  errors?: { message: string; range: unknown }[];
  text?: string;
  workerError?: string;
}

port.on("message", (req: ParseRequest) => {
  // Fresh parser instance per call. Keeps the worker stateless from the
  // caller's perspective and bounds memory — `SolidityParser` accumulates
  // a per-uri cache that we'd otherwise have to manually evict. Class
  // construction is microseconds; the heavy lifting (loading the ANTLR
  // parser module) happened once at worker startup.
  const parser = new SolidityParser();
  try {
    const result = parser.parse(req.uri, req.text);
    const response: ParseResponse = {
      uri: req.uri,
      sourceUnit: result.sourceUnit,
      errors: result.errors,
      text: result.text,
    };
    port.postMessage(response);
  } catch (err) {
    const response: ParseResponse = {
      uri: req.uri,
      workerError: err instanceof Error ? err.message : String(err),
    };
    port.postMessage(response);
  }
});
