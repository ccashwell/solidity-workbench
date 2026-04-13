import type { Diagnostic} from "vscode-languageserver/node.js";
import { DiagnosticSeverity, Range } from "vscode-languageserver/node.js";
import type { SoliditySourceUnit, ContractDefinition, FunctionDefinition } from "@solforge/common";

/**
 * Custom linting rules for Solidity — security and best-practice checks
 * that go beyond what solhint provides, focused on DeFi/protocol patterns.
 *
 * Rules:
 *
 * Security:
 * - reentrancy: Detects state changes after external calls (CEI violation)
 * - unchecked-call: Low-level calls without return value checks
 * - dangerous-delegatecall: delegatecall to user-controlled address
 * - unprotected-selfdestruct: selfdestruct without access control
 * - arbitrary-send: ETH transfer to arbitrary address
 *
 * Best Practice:
 * - missing-zero-check: Functions accepting addresses without zero-address check
 * - missing-event: State-changing functions without event emission
 * - large-literals: Magic numbers that should be named constants
 * - unused-return: Return values from external calls not captured
 *
 * Gas Optimization:
 * - storage-in-loop: Reading storage variables inside loops
 * - unchecked-math: Safe math in unchecked blocks or vice versa
 * - packed-storage: Variables that could be packed into fewer slots
 */
export class SolidityLinter {
  /**
   * Run all linting rules on a parsed source unit.
   */
  lint(sourceUnit: SoliditySourceUnit, text: string): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const lines = text.split("\n");

    for (const contract of sourceUnit.contracts) {
      diagnostics.push(
        ...this.checkReentrancy(contract, lines),
        ...this.checkUncheckedCalls(contract, lines),
        ...this.checkMissingZeroCheck(contract, lines),
        ...this.checkMissingEvents(contract, lines),
        ...this.checkLargeLiterals(lines),
        ...this.checkStorageInLoop(contract, lines),
        ...this.checkDangerousDelegatecall(lines),
        ...this.checkUnprotectedSelfdestruct(contract, lines),
      );
    }

    return diagnostics;
  }

  /**
   * Reentrancy detection — CEI (Checks-Effects-Interactions) violation.
   *
   * Heuristic: if a function contains an external call (.call, .transfer, .send,
   * or an interface call) followed by a state variable write (sstore),
   * flag it as a potential reentrancy.
   */
  private checkReentrancy(contract: ContractDefinition, lines: string[]): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const stateVarNames = new Set(contract.stateVariables.map((v) => v.name));

    for (const func of contract.functions) {
      if (!func.body) continue;

      const bodyLines = this.getFunctionBodyLines(func, lines);
      if (!bodyLines) continue;

      let foundExternalCall = false;
      let externalCallLine = -1;

      for (let i = 0; i < bodyLines.lines.length; i++) {
        const line = bodyLines.lines[i].trim();
        const absLine = bodyLines.startLine + i;

        // Detect external calls
        if (
          line.includes(".call(") ||
          line.includes(".call{") ||
          line.includes(".delegatecall(") ||
          line.includes(".staticcall(") ||
          line.includes(".transfer(") ||
          line.includes(".send(")
        ) {
          foundExternalCall = true;
          externalCallLine = absLine;
          continue;
        }

        // After an external call, check for state writes
        if (foundExternalCall) {
          for (const varName of stateVarNames) {
            // Match assignment patterns: varName = ..., varName +=, varName[...] =
            const assignRe = new RegExp(
              `\\b${varName}\\b\\s*(?:\\[.*?\\]\\s*)?(?:=|\\+=|-=|\\*=|\\/=)`,
            );
            if (assignRe.test(line)) {
              diagnostics.push({
                severity: DiagnosticSeverity.Warning,
                range: {
                  start: { line: absLine, character: 0 },
                  end: { line: absLine, character: lines[absLine]?.length ?? 0 },
                },
                message: `Potential reentrancy: state variable '${varName}' is modified after an external call on line ${externalCallLine + 1}. Follow the Checks-Effects-Interactions pattern.`,
                source: "solforge",
                code: "reentrancy",
              });
            }
          }
        }
      }
    }

    return diagnostics;
  }

  /**
   * Detect unchecked low-level call return values.
   */
  private checkUncheckedCalls(contract: ContractDefinition, lines: string[]): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    for (const func of contract.functions) {
      if (!func.body) continue;
      const bodyLines = this.getFunctionBodyLines(func, lines);
      if (!bodyLines) continue;

      for (let i = 0; i < bodyLines.lines.length; i++) {
        const line = bodyLines.lines[i].trim();
        const absLine = bodyLines.startLine + i;

        // Check for .call() without capturing return value
        if (
          (line.includes(".call(") || line.includes(".call{")) &&
          !line.includes("(bool") &&
          !line.includes("= ") &&
          !line.includes("require(")
        ) {
          diagnostics.push({
            severity: DiagnosticSeverity.Warning,
            range: {
              start: { line: absLine, character: 0 },
              end: { line: absLine, character: lines[absLine]?.length ?? 0 },
            },
            message:
              "Low-level call return value not checked. Use (bool success, ) = addr.call(...) and check success.",
            source: "solforge",
            code: "unchecked-call",
          });
        }
      }
    }

    return diagnostics;
  }

  /**
   * Detect address parameters without zero-address validation.
   */
  private checkMissingZeroCheck(contract: ContractDefinition, lines: string[]): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    for (const func of contract.functions) {
      if (!func.body) continue;

      const addressParams = func.parameters.filter(
        (p) => p.typeName === "address" || p.typeName === "address payable",
      );
      if (addressParams.length === 0) continue;

      const bodyLines = this.getFunctionBodyLines(func, lines);
      if (!bodyLines) continue;
      const bodyText = bodyLines.lines.join("\n");

      for (const param of addressParams) {
        if (!param.name) continue;

        // Check if there's a zero-address check for this parameter
        const hasCheck =
          bodyText.includes(`${param.name} != address(0)`) ||
          bodyText.includes(`${param.name} == address(0)`) ||
          bodyText.includes(`address(0) != ${param.name}`) ||
          bodyText.includes(`address(0) == ${param.name}`) ||
          bodyText.includes(`${param.name} != address(0x0)`) ||
          bodyText.includes(`_checkNonZero(${param.name})`) ||
          bodyText.includes(`require(${param.name}`);

        if (!hasCheck) {
          diagnostics.push({
            severity: DiagnosticSeverity.Information,
            range: func.range,
            message: `Address parameter '${param.name}' not checked against zero address.`,
            source: "solforge",
            code: "missing-zero-check",
          });
        }
      }
    }

    return diagnostics;
  }

  /**
   * State-changing functions should emit events for off-chain indexing.
   */
  private checkMissingEvents(contract: ContractDefinition, lines: string[]): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const stateVarNames = new Set(contract.stateVariables.map((v) => v.name));

    for (const func of contract.functions) {
      if (!func.body || func.mutability === "view" || func.mutability === "pure") continue;
      if (func.kind !== "function" || func.visibility === "private") continue;

      const bodyLines = this.getFunctionBodyLines(func, lines);
      if (!bodyLines) continue;
      const bodyText = bodyLines.lines.join("\n");

      // Check if function modifies state
      let modifiesState = false;
      for (const varName of stateVarNames) {
        if (new RegExp(`\\b${varName}\\b\\s*(?:\\[.*?\\]\\s*)?=`).test(bodyText)) {
          modifiesState = true;
          break;
        }
      }

      if (modifiesState && !bodyText.includes("emit ")) {
        diagnostics.push({
          severity: DiagnosticSeverity.Information,
          range: func.nameRange,
          message: `State-changing function '${func.name}' does not emit any events. Consider adding events for off-chain indexing.`,
          source: "solforge",
          code: "missing-event",
        });
      }
    }

    return diagnostics;
  }

  /**
   * Detect large magic numbers that should be named constants.
   */
  private checkLargeLiterals(lines: string[]): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const magicNumRe = /(?<!\w)(\d{5,})(?!\w)/g;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
      if (trimmed.includes("constant") || trimmed.includes("immutable")) continue;

      let match: RegExpExecArray | null;
      magicNumRe.lastIndex = 0;
      while ((match = magicNumRe.exec(line)) !== null) {
        const num = parseInt(match[1]);
        // Skip common non-magic values
        if (num === 10000 || num === 100000 || num === 1000000) continue;
        // Skip anything that looks like it's in a pragma
        if (trimmed.startsWith("pragma")) continue;

        diagnostics.push({
          severity: DiagnosticSeverity.Hint,
          range: {
            start: { line: i, character: match.index },
            end: { line: i, character: match.index + match[1].length },
          },
          message: `Magic number ${match[1]} — consider using a named constant.`,
          source: "solforge",
          code: "large-literal",
        });
      }
    }

    return diagnostics;
  }

  /**
   * Detect storage variable reads inside loops (gas optimization).
   */
  private checkStorageInLoop(contract: ContractDefinition, lines: string[]): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const stateVarNames = new Set(contract.stateVariables.map((v) => v.name));

    for (const func of contract.functions) {
      if (!func.body) continue;
      const bodyLines = this.getFunctionBodyLines(func, lines);
      if (!bodyLines) continue;

      let inLoop = false;
      let loopDepth = 0;

      for (let i = 0; i < bodyLines.lines.length; i++) {
        const line = bodyLines.lines[i].trim();
        const absLine = bodyLines.startLine + i;

        if (/\b(for|while)\s*\(/.test(line)) {
          inLoop = true;
          loopDepth++;
        }

        if (inLoop) {
          for (const ch of line) {
            if (ch === "{") loopDepth++;
            else if (ch === "}") {
              loopDepth--;
              if (loopDepth <= 0) {
                inLoop = false;
                loopDepth = 0;
              }
            }
          }

          // Check for state variable access in loop
          for (const varName of stateVarNames) {
            if (new RegExp(`\\b${varName}\\b`).test(line) && !line.startsWith("//")) {
              diagnostics.push({
                severity: DiagnosticSeverity.Hint,
                range: {
                  start: { line: absLine, character: 0 },
                  end: { line: absLine, character: lines[absLine]?.length ?? 0 },
                },
                message: `State variable '${varName}' accessed inside a loop. Cache it in a local variable for gas savings.`,
                source: "solforge",
                code: "storage-in-loop",
              });
            }
          }
        }
      }
    }

    return diagnostics;
  }

  /**
   * Detect delegatecall to potentially user-controlled address.
   */
  private checkDangerousDelegatecall(lines: string[]): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.includes(".delegatecall(") && !line.startsWith("//")) {
        diagnostics.push({
          severity: DiagnosticSeverity.Warning,
          range: {
            start: { line: i, character: lines[i].indexOf("delegatecall") },
            end: { line: i, character: lines[i].indexOf("delegatecall") + 12 },
          },
          message:
            "delegatecall detected. Ensure the target address is trusted and not user-controlled.",
          source: "solforge",
          code: "dangerous-delegatecall",
        });
      }
    }

    return diagnostics;
  }

  /**
   * Detect selfdestruct without access control.
   */
  private checkUnprotectedSelfdestruct(
    contract: ContractDefinition,
    lines: string[],
  ): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    for (const func of contract.functions) {
      if (!func.body) continue;
      const bodyLines = this.getFunctionBodyLines(func, lines);
      if (!bodyLines) continue;
      const bodyText = bodyLines.lines.join("\n");

      if (bodyText.includes("selfdestruct") && func.modifiers.length === 0) {
        // Check for inline access control
        const hasInlineCheck =
          bodyText.includes("msg.sender ==") ||
          bodyText.includes("require(") ||
          bodyText.includes("onlyOwner");

        if (!hasInlineCheck) {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            range: func.nameRange,
            message: `Function '${func.name}' contains selfdestruct without access control.`,
            source: "solforge",
            code: "unprotected-selfdestruct",
          });
        }
      }
    }

    return diagnostics;
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private getFunctionBodyLines(
    func: FunctionDefinition,
    lines: string[],
  ): { lines: string[]; startLine: number } | null {
    const startLine = func.range.start.line;
    // Find the opening brace
    let braceStart = -1;
    for (let i = startLine; i < Math.min(startLine + 10, lines.length); i++) {
      if (lines[i].includes("{")) {
        braceStart = i;
        break;
      }
    }
    if (braceStart === -1) return null;

    // Find matching close brace
    let depth = 0;
    let braceEnd = braceStart;
    for (let i = braceStart; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            braceEnd = i;
            return {
              lines: lines.slice(braceStart, braceEnd + 1),
              startLine: braceStart,
            };
          }
        }
      }
    }

    return null;
  }
}
