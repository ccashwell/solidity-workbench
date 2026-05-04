/**
 * Solc compactAST walker for the DAP debug adapter (stretch 2).
 *
 * Forge artifacts include a compactAST JSON tree under the `ast`
 * field. We extract the bits the debug adapter cares about:
 *
 *   - Every `FunctionDefinition` node, with its source byte range,
 *     parameters, and locally-declared `VariableDeclaration`s.
 *
 * Stack-slot mapping (which EVM stack position each parameter or
 * local occupies at any given source position) is intentionally
 * out of scope — that requires walking the compiled bytecode
 * alongside the source map and is a significantly larger effort.
 * For now the adapter exposes names + types; runtime values land
 * in a follow-up.
 *
 * The walker tolerates both the modern compactAST shape
 * (`nodes: [...]`) and pre-0.8 legacyAST (`children: [...]`),
 * matching what `parseForgeArtifact` consumers see across
 * Foundry / solc versions.
 */

export interface AstParameter {
  name: string;
  type: string;
}

export interface AstLocal {
  name: string;
  type: string;
  /**
   * Byte offset at which the declaration begins. Used to gate
   * "is this local in scope at the cursor's current source
   * position?" — locals only become visible after their
   * declaration statement.
   */
  declaredAtByte: number;
  /**
   * Byte offset of the enclosing `VariableDeclarationStatement`
   * (the start of the whole `<type> <name> [= <expr>];` statement).
   * Populated alongside `statementEndByte` so the debug adapter
   * can detect when execution has finished evaluating the
   * initializer expression and recorded the local on the EVM
   * stack.
   */
  statementStartByte: number;
  /**
   * Byte offset of the position just after the statement (start +
   * length) — i.e. the position of the closing semicolon plus
   * one. The debug adapter uses this to detect when the source
   * position has fully exited the declaration, which marks the
   * point at which the initializer's result is on the stack and
   * the local can be tracked.
   */
  statementEndByte: number;
}

export interface AstFunction {
  /** Function or constructor name. `null` for anonymous fallback / receive. */
  name: string;
  /** Solc source index (matches `fileIndex` in source maps). */
  fileIndex: number;
  /** Inclusive byte offset of the function declaration. */
  startByte: number;
  /** Exclusive byte offset of the function body's closing brace. */
  endByte: number;
  parameters: AstParameter[];
  locals: AstLocal[];
}

/**
 * Walk a compactAST `SourceUnit` and return every
 * FunctionDefinition we find, including nested contracts and
 * libraries. Returns `[]` for unparseable / missing input — the
 * adapter degrades to a names-less Variables panel, never throws.
 */
export function extractFunctions(ast: unknown): AstFunction[] {
  if (!ast || typeof ast !== "object") return [];
  const out: AstFunction[] = [];
  visit(ast as AstNode, (node) => {
    if (node?.nodeType !== "FunctionDefinition" && node?.nodeType !== "ConstructorDefinition") {
      return;
    }
    const src = parseSrc(node.src);
    if (!src) return;
    const params = extractParameters(node.parameters as AstNode | undefined);
    const locals = node.body ? extractLocals(node.body as AstNode) : [];
    out.push({
      name: typeof node.name === "string" ? node.name : "",
      fileIndex: src.fileIndex,
      startByte: src.start,
      endByte: src.start + src.length,
      parameters: params,
      locals,
    });
  });
  return out;
}

function extractParameters(parameterList: AstNode | undefined): AstParameter[] {
  if (!parameterList) return [];
  const params = parameterList.parameters;
  if (!Array.isArray(params)) return [];
  return params
    .map((p) => {
      if (!p || typeof p !== "object") return null;
      const v = p as AstNode;
      if (v.nodeType !== "VariableDeclaration") return null;
      const name = typeof v.name === "string" ? v.name : "";
      const type = readTypeString(v);
      if (!name) return null;
      return { name, type };
    })
    .filter((p): p is AstParameter => p !== null);
}

function extractLocals(body: AstNode): AstLocal[] {
  const out: AstLocal[] = [];
  visit(body, (node) => {
    if (node?.nodeType !== "VariableDeclarationStatement") return;
    const stmtSrc = parseSrc(node.src);
    if (!stmtSrc) return;
    const decls = node.declarations;
    if (!Array.isArray(decls)) return;
    for (const d of decls) {
      if (!d || typeof d !== "object") continue;
      const v = d as AstNode;
      if (v.nodeType !== "VariableDeclaration") continue;
      const src = parseSrc(v.src);
      const name = typeof v.name === "string" ? v.name : "";
      if (!name || !src) continue;
      out.push({
        name,
        type: readTypeString(v),
        declaredAtByte: src.start,
        statementStartByte: stmtSrc.start,
        statementEndByte: stmtSrc.start + stmtSrc.length,
      });
    }
  });
  return out;
}

function readTypeString(v: AstNode): string {
  const td = v.typeDescriptions;
  if (td && typeof td === "object") {
    const t = (td as Record<string, unknown>).typeString;
    if (typeof t === "string" && t.length > 0) return t;
  }
  // Fallback: typeName.name (legacy AST).
  const typeName = v.typeName;
  if (typeName && typeof typeName === "object") {
    const n = (typeName as Record<string, unknown>).name;
    if (typeof n === "string" && n.length > 0) return n;
  }
  return "";
}

function parseSrc(src: unknown): { start: number; length: number; fileIndex: number } | null {
  if (typeof src !== "string") return null;
  const parts = src.split(":");
  if (parts.length < 3) return null;
  const start = Number.parseInt(parts[0], 10);
  const length = Number.parseInt(parts[1], 10);
  const fileIndex = Number.parseInt(parts[2], 10);
  if (!Number.isFinite(start) || !Number.isFinite(length) || !Number.isFinite(fileIndex)) {
    return null;
  }
  return { start, length, fileIndex };
}

interface AstNode {
  nodeType?: string;
  name?: string;
  src?: unknown;
  parameters?: unknown;
  body?: unknown;
  declarations?: unknown;
  typeDescriptions?: unknown;
  typeName?: unknown;
  // The two child-array names compactAST and legacyAST use.
  nodes?: unknown;
  children?: unknown;
  statements?: unknown;
  baseContracts?: unknown;
}

/** Pre-order walk that handles both compactAST and legacyAST child arrays. */
function visit(node: AstNode | undefined | null, fn: (n: AstNode) => void): void {
  if (!node || typeof node !== "object") return;
  fn(node);
  for (const key of ["nodes", "children", "statements", "declarations", "baseContracts"]) {
    const value = (node as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === "object") visit(child as AstNode, fn);
      }
    }
  }
  // ParameterList / Block / etc. nest under typed keys.
  for (const key of ["body", "parameters", "returnParameters", "trueBody", "falseBody"]) {
    const value = (node as Record<string, unknown>)[key];
    if (value && typeof value === "object") visit(value as AstNode, fn);
  }
}

/**
 * Find the function whose byte range contains `byteOffset` in
 * source `fileIndex`. Returns the innermost match (handles
 * function-inside-function declarations, which Solidity doesn't
 * have today but might via inline-functions in future versions).
 */
export function findEnclosingFunction(
  functions: AstFunction[],
  fileIndex: number,
  byteOffset: number,
): AstFunction | null {
  let best: AstFunction | null = null;
  for (const fn of functions) {
    if (fn.fileIndex !== fileIndex) continue;
    if (byteOffset < fn.startByte || byteOffset >= fn.endByte) continue;
    if (!best || fn.endByte - fn.startByte < best.endByte - best.startByte) {
      best = fn;
    }
  }
  return best;
}
