import type { CodeAction, CodeActionContext, Range } from "vscode-languageserver/node.js";
import { CodeActionKind, TextEdit } from "vscode-languageserver/node.js";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type { ContractDefinition, FunctionDefinition } from "@solidity-workbench/common";
import type { SymbolIndex } from "../analyzer/symbol-index.js";
import type { SolidityParser } from "../parser/solidity-parser.js";

/**
 * Provides code actions (quick fixes and refactorings) for Solidity.
 *
 * Quick fixes:
 * - Add missing SPDX license identifier
 * - Add missing pragma
 * - Add visibility to function
 * - Implement interface methods
 * - Add override/virtual keywords
 * - Convert address to checksum format
 *
 * Refactorings:
 * - Extract modifier from require statements
 * - Add natspec documentation stub
 * - Sort imports
 */
export class CodeActionsProvider {
  constructor(
    private symbolIndex: SymbolIndex,
    private parser: SolidityParser,
  ) {}

  provideCodeActions(
    document: TextDocument,
    range: Range,
    context: CodeActionContext,
  ): CodeAction[] {
    const actions: CodeAction[] = [];
    const text = document.getText();
    const uri = document.uri;

    // Quick fixes based on diagnostics
    for (const diagnostic of context.diagnostics) {
      switch (diagnostic.code) {
        case "missing-spdx":
          actions.push(this.createAddSPDXAction(uri));
          break;
        case "floating-pragma":
          actions.push(...this.createPinPragmaActions(uri, text, diagnostic.range));
          break;
        case "tx-origin":
          actions.push(this.createReplaceTxOriginAction(uri, diagnostic.range));
          break;
        case "state-could-be-constant":
          actions.push(this.createInsertBeforeIdentifierAction(uri, diagnostic.range, "constant"));
          break;
        case "state-could-be-immutable":
          actions.push(this.createInsertBeforeIdentifierAction(uri, diagnostic.range, "immutable"));
          break;
        case "func-visibility-explicit":
          actions.push(...this.createAddVisibilityActions(uri, text, diagnostic.range.start.line));
          break;
      }
    }

    // Context-aware actions based on cursor position
    const line = text.split("\n")[range.start.line] ?? "";
    const trimmed = line.trim();

    // Offer to add natspec to functions/contracts without it
    if (
      trimmed.startsWith("function ") ||
      trimmed.startsWith("contract ") ||
      trimmed.startsWith("interface ") ||
      trimmed.startsWith("library ")
    ) {
      const prevLine =
        range.start.line > 0 ? (text.split("\n")[range.start.line - 1] ?? "").trim() : "";
      if (!prevLine.startsWith("///") && !prevLine.startsWith("/**") && !prevLine.endsWith("*/")) {
        actions.push(this.createAddNatspecAction(uri, range.start.line, trimmed));
      }
    }

    // Offer to implement interface when extending one
    const result = this.parser.get(uri);
    if (result) {
      for (const contract of result.sourceUnit.contracts) {
        if (
          contract.range.start.line <= range.start.line &&
          contract.range.end.line >= range.end.line
        ) {
          // Check if contract implements an interface with missing methods
          for (const base of contract.baseContracts) {
            const baseContract = this.symbolIndex.getContract(base.baseName);
            if (baseContract && baseContract.contract.kind === "interface") {
              const missing = this.findUnimplementedMethods(contract, baseContract.contract);
              if (missing.length > 0) {
                actions.push(
                  this.createImplementInterfaceAction(uri, contract, base.baseName, missing),
                );
              }
            }
          }

          // Offer to extract interface from concrete contracts
          if (contract.kind === "contract" || contract.kind === "abstract") {
            const externalFuncs = contract.functions.filter(
              (f) =>
                f.kind === "function" &&
                f.name &&
                (f.visibility === "external" || f.visibility === "public"),
            );
            if (externalFuncs.length > 0) {
              actions.push(this.createExtractInterfaceAction(uri, text, contract));
            }
          }
        }
      }
    }

    return actions;
  }

  private createAddSPDXAction(uri: string): CodeAction {
    return {
      title: "Add SPDX license identifier (MIT)",
      kind: CodeActionKind.QuickFix,
      edit: {
        changes: {
          [uri]: [TextEdit.insert({ line: 0, character: 0 }, "// SPDX-License-Identifier: MIT\n")],
        },
      },
      isPreferred: true,
    };
  }

  private createReplaceTxOriginAction(uri: string, range: Range): CodeAction {
    return {
      title: "Replace tx.origin with msg.sender",
      kind: CodeActionKind.QuickFix,
      edit: {
        changes: {
          [uri]: [TextEdit.replace(range, "msg.sender")],
        },
      },
    };
  }

  private createPinPragmaActions(uri: string, text: string, range: Range): CodeAction[] {
    const line = text.split("\n")[range.start.line] ?? "";
    const match = line.match(/pragma\s+solidity\s+([^;]+);/);
    if (!match) return [];

    const current = match[1].trim();
    const version = current.match(/\d+\.\d+\.\d+/)?.[0] ?? current.replace(/^[\^>=<~\s]+/, "");
    if (!version) return [];

    const start = line.indexOf(current);
    if (start < 0) return [];
    const versionRange: Range = {
      start: { line: range.start.line, character: start },
      end: { line: range.start.line, character: start + current.length },
    };

    return [
      {
        title: `Pin pragma to ${version}`,
        kind: CodeActionKind.QuickFix,
        edit: {
          changes: {
            [uri]: [TextEdit.replace(versionRange, version)],
          },
        },
      },
    ];
  }

  private createInsertBeforeIdentifierAction(
    uri: string,
    range: Range,
    keyword: "constant" | "immutable",
  ): CodeAction {
    return {
      title: `Declare state variable ${keyword}`,
      kind: CodeActionKind.QuickFix,
      edit: {
        changes: {
          [uri]: [TextEdit.insert(range.start, `${keyword} `)],
        },
      },
    };
  }

  private createAddVisibilityActions(uri: string, text: string, lineNum: number): CodeAction[] {
    const line = text.split("\n")[lineNum] ?? "";
    const insertAt = this.visibilityInsertColumn(line);
    if (insertAt === null) return [];

    return ["public", "external", "internal", "private"].map((visibility) => ({
      title: `Add ${visibility} visibility`,
      kind: CodeActionKind.QuickFix,
      edit: {
        changes: {
          [uri]: [
            TextEdit.insert({ line: lineNum, character: insertAt }, ` ${visibility}`),
          ],
        },
      },
    }));
  }

  private visibilityInsertColumn(line: string): number | null {
    const candidates = [line.indexOf("{"), line.indexOf(";")]
      .filter((idx) => idx >= 0)
      .sort((a, b) => a - b);
    if (candidates.length === 0) return null;
    return candidates[0];
  }

  private createAddNatspecAction(uri: string, line: number, declaration: string): CodeAction {
    // Generate a natspec stub based on the declaration
    const stub = this.generateNatspecStub(declaration);
    const indent = declaration.match(/^\s*/)?.[0] ?? "";

    return {
      title: "Add NatSpec documentation",
      kind: CodeActionKind.Refactor,
      edit: {
        changes: {
          [uri]: [
            TextEdit.insert(
              { line, character: 0 },
              stub
                .split("\n")
                .map((l) => indent + l)
                .join("\n") + "\n",
            ),
          ],
        },
      },
    };
  }

  private generateNatspecStub(declaration: string): string {
    const lines: string[] = ["/// @notice "];

    // Extract parameters
    const paramsMatch = declaration.match(/\(([^)]*)\)/);
    if (paramsMatch && paramsMatch[1].trim()) {
      const params = paramsMatch[1].split(",").map((p) => p.trim());
      for (const param of params) {
        const parts = param.split(/\s+/);
        const name = parts[parts.length - 1];
        if (name && !["memory", "storage", "calldata"].includes(name)) {
          lines.push(`/// @param ${name} `);
        }
      }
    }

    // Check for return values
    if (declaration.includes("returns")) {
      const returnsMatch = declaration.match(/returns\s*\(([^)]*)\)/);
      if (returnsMatch && returnsMatch[1].trim()) {
        const returns = returnsMatch[1].split(",").map((r) => r.trim());
        for (const ret of returns) {
          const parts = ret.split(/\s+/);
          const name = parts.length > 1 ? parts[parts.length - 1] : "";
          lines.push(`/// @return ${name} `);
        }
      }
    }

    return lines.join("\n");
  }

  private createExtractInterfaceAction(
    uri: string,
    text: string,
    contract: ContractDefinition,
  ): CodeAction {
    const interfaceName = `I${contract.name}`;
    const lines: string[] = [];

    // Find the pragma from the file
    const pragmaMatch = text.match(/pragma solidity[^;]+;/);
    if (pragmaMatch) {
      lines.push("// SPDX-License-Identifier: MIT");
      lines.push(pragmaMatch[0]);
      lines.push("");
    }

    lines.push(`interface ${interfaceName} {`);

    // Extract events
    for (const event of contract.events) {
      const params = event.parameters
        .map(
          (p) =>
            `${p.typeName}${p.indexed ? " indexed" : ""}${p.name ? " " + p.name : ""}`,
        )
        .join(", ");
      lines.push(`    event ${event.name}(${params});`);
    }

    // Extract custom errors
    for (const error of contract.errors) {
      const params = error.parameters
        .map((p) => `${p.typeName}${p.name ? " " + p.name : ""}`)
        .join(", ");
      lines.push(`    error ${error.name}(${params});`);
    }

    if ((contract.events.length > 0 || contract.errors.length > 0) && contract.functions.length > 0) {
      lines.push("");
    }

    // Extract external/public function signatures
    const externalFuncs = contract.functions.filter(
      (f) =>
        f.kind === "function" &&
        f.name &&
        (f.visibility === "external" || f.visibility === "public"),
    );

    for (const func of externalFuncs) {
      const params = func.parameters
        .map(
          (p) =>
            `${p.typeName}${p.storageLocation ? " " + p.storageLocation : ""}${p.name ? " " + p.name : ""}`,
        )
        .join(", ");
      const returns =
        func.returnParameters.length > 0
          ? ` returns (${func.returnParameters.map((p) => `${p.typeName}${p.storageLocation ? " " + p.storageLocation : ""}${p.name ? " " + p.name : ""}`).join(", ")})`
          : "";
      const mut = func.mutability !== "nonpayable" ? ` ${func.mutability}` : "";
      lines.push(`    function ${func.name}(${params}) external${mut}${returns};`);
    }

    lines.push("}");
    lines.push("");

    const interfaceText = lines.join("\n");

    // Insert before the contract definition
    return {
      title: `Extract Interface '${interfaceName}'`,
      kind: CodeActionKind.Refactor,
      edit: {
        changes: {
          [uri]: [
            TextEdit.insert(
              { line: contract.range.start.line, character: 0 },
              interfaceText + "\n",
            ),
          ],
        },
      },
    };
  }

  private findUnimplementedMethods(
    contract: ContractDefinition,
    iface: ContractDefinition,
  ): FunctionDefinition[] {
    const implemented = new Set(contract.functions.map((f) => f.name).filter(Boolean));
    return iface.functions.filter((f) => f.name && !implemented.has(f.name));
  }

  private createImplementInterfaceAction(
    uri: string,
    contract: ContractDefinition,
    interfaceName: string,
    missing: FunctionDefinition[],
  ): CodeAction {
    const stubs = missing.map((func) => {
      const params = func.parameters
        .map(
          (p) =>
            `${p.typeName}${p.storageLocation ? " " + p.storageLocation : ""}${p.name ? " " + p.name : ""}`,
        )
        .join(", ");
      const returns =
        func.returnParameters.length > 0
          ? ` returns (${func.returnParameters.map((p) => `${p.typeName}${p.storageLocation ? " " + p.storageLocation : ""}${p.name ? " " + p.name : ""}`).join(", ")})`
          : "";
      const mut = func.mutability !== "nonpayable" ? ` ${func.mutability}` : "";
      return `    function ${func.name}(${params}) external${mut} override${returns} {\n        // TODO: implement\n    }`;
    });

    const insertLine = contract.range.end.line;

    return {
      title: `Implement ${interfaceName} (${missing.length} methods)`,
      kind: CodeActionKind.QuickFix,
      edit: {
        changes: {
          [uri]: [
            TextEdit.insert({ line: insertLine, character: 0 }, "\n" + stubs.join("\n\n") + "\n"),
          ],
        },
      },
    };
  }
}
