import type { Position } from "vscode-languageserver/node.js";
import type { SymbolIndex } from "../analyzer/symbol-index.js";
import type { SolidityParser } from "../parser/solidity-parser.js";
import { findLocalVariableType, getFunctionBodyTextPrefix } from "./text.js";
import { getEnclosingContract, getEnclosingFunctionScope } from "./scope.js";

export interface ReceiverExpression {
  simpleName?: string;
  explicitTypeName?: string;
  /** Full dotted receiver (`store.owner`) when present */
  dottedPath?: string;
}

export type ReceiverTypeResolutionSource =
  | "explicitType"
  | "this"
  | "super"
  | "globalType"
  | "parameter"
  | "localVariable"
  | "stateVariable"
  | "structMember";

export interface ReceiverTypeResolution {
  typeName: string;
  source: ReceiverTypeResolutionSource;
  receiver: string;
}

/**
 * Map a receiver identifier (or cast type) to its declared Solidity type name.
 */
export function resolveReceiverTypeName(
  parser: SolidityParser,
  symbolIndex: SymbolIndex,
  fromUri: string,
  position: Position,
  receiver: ReceiverExpression,
): string | undefined {
  return resolveReceiverTypeInfo(parser, symbolIndex, fromUri, position, receiver)?.typeName;
}

/**
 * Map a receiver identifier (or cast type) to its declared Solidity type and
 * explain where that type came from.
 */
export function resolveReceiverTypeInfo(
  parser: SolidityParser,
  symbolIndex: SymbolIndex,
  fromUri: string,
  position: Position,
  receiver: ReceiverExpression,
): ReceiverTypeResolution | undefined {
  if (receiver.explicitTypeName) {
    return {
      typeName: receiver.explicitTypeName,
      source: "explicitType",
      receiver: receiver.explicitTypeName,
    };
  }

  const path = receiver.dottedPath ?? receiver.simpleName;
  if (!path) return undefined;

  if (path.includes(".")) {
    return resolveDottedPathTypeInfo(parser, symbolIndex, fromUri, position, path);
  }

  const sourceUnit = parser.get(fromUri)?.sourceUnit;
  if (!sourceUnit) return undefined;

  const scope = getEnclosingFunctionScope(sourceUnit, position);
  const parameter = scope?.fn.parameters.find((p) => p.name === path);
  if (parameter) return { typeName: parameter.typeName, source: "parameter", receiver: path };

  const text = parser.getText(fromUri);
  if (text && scope) {
    const bodyPrefix = getFunctionBodyTextPrefix(
      text,
      scope.fn.range.start.line,
      position.line,
      position.character,
    );
    if (bodyPrefix) {
      const localType = findLocalVariableType(bodyPrefix, path);
      if (localType) return { typeName: localType, source: "localVariable", receiver: path };
    }
  }

  const contract = scope?.contract ?? getEnclosingContract(sourceUnit, position.line);
  const stateVariable = contract?.stateVariables.find((v) => v.name === path);
  return stateVariable
    ? { typeName: stateVariable.typeName, source: "stateVariable", receiver: path }
    : undefined;
}

function resolveDottedPathTypeInfo(
  parser: SolidityParser,
  symbolIndex: SymbolIndex,
  fromUri: string,
  position: Position,
  path: string,
): ReceiverTypeResolution | undefined {
  const segments = path
    .split(".")
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length === 0) return undefined;

  let current = resolveReceiverTypeInfo(parser, symbolIndex, fromUri, position, {
    simpleName: segments[0],
  });
  if (!current) return undefined;

  for (let i = 1; i < segments.length; i++) {
    const member = segments[i];
    const structName = normalizeTypeName(current.typeName);
    const struct = symbolIndex.getStruct(fromUri, structName);
    const field = struct?.members.find((m) => m.name === member);
    if (!field) return undefined;
    current = { typeName: field.typeName, source: "structMember", receiver: path };
  }

  return current;
}

export function normalizeTypeName(typeName: string): string {
  return typeName.replace(/\s+(memory|storage|calldata)\b/g, "").trim();
}

export function isSameTypeName(left: string, right: string): boolean {
  return normalizeTypeName(left) === normalizeTypeName(right);
}

export function isGlobalTypeName(symbolIndex: SymbolIndex, name: string): boolean {
  const symbols = symbolIndex.findSymbols(name);
  return symbols.some(
    (s) =>
      s.kind === "contract" ||
      s.kind === "interface" ||
      s.kind === "library" ||
      s.kind === "struct" ||
      s.kind === "enum" ||
      s.kind === "userDefinedValueType",
  );
}

/**
 * When dotted access uses a variable receiver (`p.foo`), map it to the
 * receiver's declared type. Leaves global type names (`Contract.foo`) as-is.
 */
export function resolveDottedReceiverTypeName(
  parser: SolidityParser,
  symbolIndex: SymbolIndex,
  fromUri: string,
  position: Position,
  receiverName: string,
): string | undefined {
  return resolveDottedReceiverTypeInfo(parser, symbolIndex, fromUri, position, receiverName)
    ?.typeName;
}

export function resolveDottedReceiverTypeInfo(
  parser: SolidityParser,
  symbolIndex: SymbolIndex,
  fromUri: string,
  position: Position,
  receiverName: string,
): ReceiverTypeResolution | undefined {
  if (receiverName.includes(".")) {
    return resolveDottedPathTypeInfo(parser, symbolIndex, fromUri, position, receiverName);
  }
  if (isGlobalTypeName(symbolIndex, receiverName)) {
    return { typeName: receiverName, source: "globalType", receiver: receiverName };
  }
  return resolveReceiverTypeInfo(parser, symbolIndex, fromUri, position, {
    simpleName: receiverName,
  });
}
