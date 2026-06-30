import * as fs from "node:fs";
import * as path from "node:path";
import { URI } from "vscode-uri";
import {
  LineIndex,
  type GetMutationCandidatesParams,
  type GetMutationCandidatesResult,
  type MutationCandidateInfo,
  type SourceRange,
} from "@solidity-workbench/common";
import type { SolcAstNode, SolcBridge } from "../compiler/solc-bridge.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";

interface MutationOperator {
  token: string;
  replacement: string;
  label: string;
}

const AST_BINARY_MUTATION_OPERATORS: MutationOperator[] = [
  { token: "==", replacement: "!=", label: "equality" },
  { token: "!=", replacement: "==", label: "inequality" },
  { token: ">=", replacement: ">", label: "boundary" },
  { token: "<=", replacement: "<", label: "boundary" },
  { token: ">", replacement: ">=", label: "boundary" },
  { token: "<", replacement: "<=", label: "boundary" },
  { token: "&&", replacement: "||", label: "logical" },
  { token: "||", replacement: "&&", label: "logical" },
  { token: "+", replacement: "-", label: "arithmetic" },
  { token: "-", replacement: "+", label: "arithmetic" },
];

export class MutationCandidatesProvider {
  constructor(
    private workspace: WorkspaceManager,
    private solcBridge: SolcBridge,
  ) {}

  async provideMutationCandidates(
    params: GetMutationCandidatesParams,
  ): Promise<GetMutationCandidatesResult> {
    const forgeRoot = URI.parse(params.forgeRootUri).fsPath;
    const maxMutants = Math.max(1, Math.floor(params.maxMutants));
    const files = params.targetFileUri
      ? [URI.parse(params.targetFileUri).fsPath]
      : this.filesForRoot(forgeRoot, params.includeTests === true);

    let buildAttempted = false;
    const candidates: MutationCandidateInfo[] = [];
    for (const filePath of files) {
      if (candidates.length >= maxMutants) break;
      if (!params.includeTests && isTestPath(path.relative(forgeRoot, filePath))) continue;

      let ast = this.solcBridge.getAst(filePath);
      if (!ast && !buildAttempted) {
        buildAttempted = true;
        await this.solcBridge.buildAndExtractAst();
        ast = this.solcBridge.getAst(filePath);
      }
      if (!ast) continue;

      const text = readText(filePath);
      if (text === null) continue;
      candidates.push(
        ...this.candidatesForAst({
          ast: ast.ast,
          filePath,
          forgeRoot,
          text,
          maxMutants: maxMutants - candidates.length,
        }),
      );
    }

    if (candidates.length === 0) {
      return {
        candidates: [],
        source: "unavailable",
        reason: buildAttempted
          ? "No compiler-backed mutation candidates were found after rebuilding the solc AST cache."
          : "No compiler-backed mutation candidates were found in the current solc AST cache.",
      };
    }

    return { candidates: candidates.slice(0, maxMutants), source: "solc" };
  }

  private filesForRoot(forgeRoot: string, includeTests: boolean): string[] {
    return this.workspace
      .getAllFileUris()
      .map((uri) => URI.parse(uri).fsPath)
      .filter((filePath) => filePath === forgeRoot || filePath.startsWith(forgeRoot + path.sep))
      .filter((filePath) => includeTests || !isTestPath(path.relative(forgeRoot, filePath)))
      .sort();
  }

  private candidatesForAst(options: {
    ast: SolcAstNode;
    filePath: string;
    forgeRoot: string;
    text: string;
    maxMutants: number;
  }): MutationCandidateInfo[] {
    const lineIndex = LineIndex.fromText(options.text);
    const candidates: MutationCandidateInfo[] = [];
    this.visitSolcAst(
      options.ast,
      { contractName: undefined, functionName: undefined },
      (node, ctx) => {
        if (candidates.length >= options.maxMutants) return;
        if (node.nodeType !== "BinaryOperation") return;
        const operator = typeof node.operator === "string" ? node.operator : undefined;
        if (!operator) return;
        const mutation = AST_BINARY_MUTATION_OPERATORS.find((entry) => entry.token === operator);
        if (!mutation) return;
        const operatorRange = this.operatorRange(options.text, lineIndex, node, operator);
        if (!operatorRange) return;
        const relativePath = path.relative(options.forgeRoot, options.filePath);
        candidates.push({
          id: `${path.basename(options.filePath)}:${operatorRange.start.line + 1}:${operatorRange.start.character + 1}:${mutation.token}->${mutation.replacement}`,
          uri: URI.file(options.filePath).toString(),
          filePath: options.filePath,
          relativePath,
          range: operatorRange,
          operator: mutation.label,
          original: mutation.token,
          replacement: mutation.replacement,
          contractName: ctx.contractName,
          functionName: ctx.functionName,
          lineText: lineTextAt(options.text, operatorRange.start.line),
          source: "solc",
        });
      },
    );
    return candidates;
  }

  private visitSolcAst(
    node: SolcAstNode | undefined,
    context: { contractName?: string; functionName?: string },
    visitor: (node: SolcAstNode, context: { contractName?: string; functionName?: string }) => void,
  ): void {
    if (!node) return;
    const next = { ...context };
    if (node.nodeType === "ContractDefinition" && typeof node.name === "string") {
      next.contractName = node.name;
    }
    if (node.nodeType === "FunctionDefinition" && typeof node.name === "string") {
      next.functionName = node.name || undefined;
    }
    visitor(node, next);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) {
          if (isSolcAstNode(child)) this.visitSolcAst(child, next, visitor);
        }
      } else if (isSolcAstNode(value)) {
        this.visitSolcAst(value, next, visitor);
      }
    }
  }

  private operatorRange(
    text: string,
    lineIndex: LineIndex,
    node: SolcAstNode,
    operator: string,
  ): SourceRange | null {
    const nodeRange = parseSolcSrc(node.src);
    const leftRange = parseSolcSrc((node.leftExpression as SolcAstNode | undefined)?.src);
    const rightRange = parseSolcSrc((node.rightExpression as SolcAstNode | undefined)?.src);
    if (!nodeRange) return null;
    const start = leftRange ? leftRange.start + leftRange.length : nodeRange.start;
    const end = rightRange ? rightRange.start : nodeRange.start + nodeRange.length;
    if (end < start) return null;
    const segmentStart = solcByteOffsetToDocumentOffset(text, lineIndex, start);
    const segmentEnd = solcByteOffsetToDocumentOffset(text, lineIndex, end);
    const segment = text.slice(segmentStart, segmentEnd);
    const relative = segment.indexOf(operator);
    if (relative < 0) return null;
    const offset = segmentStart + relative;
    return textOffsetToRange(text, offset, operator.length);
  }
}

function parseSolcSrc(src: unknown): { start: number; length: number } | null {
  if (typeof src !== "string") return null;
  const [start, length] = src.split(":").map((part) => Number(part));
  if (!Number.isFinite(start) || !Number.isFinite(length)) return null;
  return { start, length };
}

function solcByteOffsetToDocumentOffset(
  text: string,
  lineIndex: LineIndex,
  byteOffset: number,
): number {
  return offsetAtPosition(text, lineIndex.positionAt(byteOffset));
}

function offsetAtPosition(text: string, position: { line: number; character: number }): number {
  if (position.line <= 0) return Math.max(0, Math.min(position.character, text.length));
  let line = 0;
  let i = 0;
  while (i < text.length && line < position.line) {
    const ch = text[i];
    if (ch === "\r") {
      line++;
      i += i + 1 < text.length && text[i + 1] === "\n" ? 2 : 1;
    } else if (ch === "\n") {
      line++;
      i++;
    } else {
      i++;
    }
  }
  return Math.max(0, Math.min(i + position.character, text.length));
}

function textOffsetToRange(text: string, offset: number, length: number): SourceRange {
  return {
    start: positionAtTextOffset(text, offset),
    end: positionAtTextOffset(text, offset + length),
  };
}

function positionAtTextOffset(text: string, offset: number): { line: number; character: number } {
  let line = 0;
  let lineStart = 0;
  const clamped = Math.max(0, Math.min(offset, text.length));
  for (let i = 0; i < clamped; i++) {
    const ch = text[i];
    if (ch === "\r") {
      line++;
      if (i + 1 < clamped && text[i + 1] === "\n") i++;
      lineStart = i + 1;
    } else if (ch === "\n") {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, character: clamped - lineStart };
}

function lineTextAt(text: string, lineNo: number): string {
  return text.split(/\r?\n/)[lineNo]?.trim() ?? "";
}

function isTestPath(relativePath: string): boolean {
  return relativePath.split(path.sep).includes("test") || relativePath.endsWith(".t.sol");
}

function readText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function isSolcAstNode(value: unknown): value is SolcAstNode {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as SolcAstNode).nodeType === "string"
  );
}
