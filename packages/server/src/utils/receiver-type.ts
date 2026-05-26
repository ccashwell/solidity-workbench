import type { SoliditySourceUnit } from "@solidity-workbench/common";
import type { Position } from "vscode-languageserver/node.js";
import type { SymbolIndex } from "../analyzer/symbol-index.js";
import type { SolidityParser } from "../parser/solidity-parser.js";
import { findLocalVariableType, getFunctionBodyTextPrefix } from "./text.js";
import { getEnclosingContract, getEnclosingFunctionScope } from "./scope.js";

export interface ReceiverExpression {
  simpleName?: string;
  explicitTypeName?: string;
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
  if (receiver.explicitTypeName) return receiver.explicitTypeName;
  if (!receiver.simpleName) return undefined;

  const sourceUnit = parser.get(fromUri)?.sourceUnit;
  if (!sourceUnit) return undefined;

  const scope = getEnclosingFunctionScope(sourceUnit, position);
  const parameter = scope?.fn.parameters.find((p) => p.name === receiver.simpleName);
  if (parameter) return parameter.typeName;

  const text = parser.getText(fromUri);
  if (text && scope) {
    const bodyPrefix = getFunctionBodyTextPrefix(
      text,
      scope.fn.range.start.line,
      position.line,
      position.character,
    );
    if (bodyPrefix) {
      const localType = findLocalVariableType(bodyPrefix, receiver.simpleName);
      if (localType) return localType;
    }
  }

  const contract = scope?.contract ?? getEnclosingContract(sourceUnit, position.line);
  const stateVariable = contract?.stateVariables.find((v) => v.name === receiver.simpleName);
  return stateVariable?.typeName;
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
  if (isGlobalTypeName(symbolIndex, receiverName)) return receiverName;
  return resolveReceiverTypeName(parser, symbolIndex, fromUri, position, {
    simpleName: receiverName,
  });
}
