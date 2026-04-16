import type { Diagnostic, Range } from "vscode-languageserver/node.js";
import { DiagnosticSeverity } from "vscode-languageserver/node.js";
import { visit } from "@solidity-parser/parser";
import type {
  SoliditySourceUnit,
  ContractDefinition,
  FunctionDefinition,
  SourceRange,
} from "@solidity-workbench/common";

/**
 * Custom linting rules for Solidity — security and best-practice checks
 * that go beyond what solhint provides, focused on DeFi/protocol patterns.
 *
 * Implementation:
 *   - Rules that reason about program structure (reentrancy,
 *     missing-event, storage-in-loop, unchecked-call,
 *     dangerous-delegatecall, unprotected-selfdestruct) walk the raw
 *     `@solidity-parser/parser` AST when it's available — passed in as
 *     the optional third argument to `lint()`. This eliminates the
 *     regex false-positives we had on:
 *         - code inside `/* ... *\/` block comments
 *         - multiline expressions
 *         - string literals that happened to contain matching syntax
 *   - Rules that only need text (large-literal suggestions, suppression
 *     comments) still scan lines directly.
 *   - When the raw AST is absent (parse failure), AST-based rules quietly
 *     skip themselves — we prefer silence to a false-positive flood.
 *
 * Rules:
 *   Security:
 *     - reentrancy:            state writes after external calls (CEI)
 *     - unchecked-call:        low-level calls without return check
 *     - dangerous-delegatecall: any delegatecall
 *     - unprotected-selfdestruct: selfdestruct with no access control
 *   Best Practice:
 *     - missing-zero-check:    address params without zero check
 *     - missing-event:         state-changing funcs without emit
 *     - large-literal:         magic numbers
 *   Gas:
 *     - storage-in-loop:       state var reads inside loops
 */
export class SolidityLinter {
  /**
   * Run all linting rules on a parsed source unit.
   *
   * @param sourceUnit  The mapped `SoliditySourceUnit` for the file.
   * @param text        Raw source text (for ranges and line-based rules).
   * @param rawAst      Optional raw `@solidity-parser/parser` AST. When
   *                    provided, AST-based rules run; when absent (e.g.
   *                    parse failure) only line-based rules do.
   */
  lint(sourceUnit: SoliditySourceUnit, text: string, rawAst?: unknown): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const lines = text.split("\n");

    // Build a name → FunctionDefinition (raw AST) mapping keyed by contract
    // so AST rules can cross-reference modifier names without re-walking.
    const rawContracts = this.extractRawContracts(rawAst);

    for (const contract of sourceUnit.contracts) {
      const rawContract = rawContracts.get(contract.name);

      if (rawContract) {
        diagnostics.push(
          ...this.checkReentrancyAst(contract, rawContract, lines),
          ...this.checkUncheckedCallsAst(contract, rawContract, lines),
          ...this.checkMissingEventsAst(contract, rawContract, lines),
          ...this.checkStorageInLoopAst(contract, rawContract, lines),
          ...this.checkDangerousDelegatecallAst(rawContract, lines),
          ...this.checkUnprotectedSelfdestructAst(contract, rawContract, lines),
        );
      }

      // Rules that don't (yet) benefit from AST walking — these already
      // reason in terms of parameter lists we have on the mapped AST.
      diagnostics.push(...this.checkMissingZeroCheck(contract, lines));
    }

    // Line-only rules
    diagnostics.push(...this.checkLargeLiterals(lines));

    return diagnostics.filter((d) => !this.isSuppressed(d, lines));
  }

  // ── Suppression ────────────────────────────────────────────────────

  private isSuppressed(d: Diagnostic, lines: string[]): boolean {
    if (d.range.start.line === 0) return false;
    const prevLine = lines[d.range.start.line - 1]?.trim() ?? "";
    if (!prevLine.includes("solidity-workbench-disable-next-line")) return false;
    if (d.code && prevLine.includes(String(d.code))) return true;
    return !prevLine.includes("solidity-workbench-disable-next-line ");
  }

  // ── AST helpers ────────────────────────────────────────────────────

  /**
   * Index raw contracts by name so linter rules can look them up without
   * walking the source unit on every invocation.
   */
  private extractRawContracts(rawAst: unknown): Map<string, RawContract> {
    const out = new Map<string, RawContract>();
    if (!rawAst) return out;
    const ast = rawAst as { children?: RawNode[] };
    for (const child of ast.children ?? []) {
      if (child?.type !== "ContractDefinition") continue;
      const maybe = child as Partial<RawContract>;
      if (typeof maybe.name === "string") {
        out.set(maybe.name, child as RawContract);
      }
    }
    return out;
  }

  private findRawFunction(rawContract: RawContract, name: string): RawFunction | undefined {
    for (const sub of rawContract.subNodes ?? []) {
      if (sub?.type === "FunctionDefinition" && (sub as RawFunction).name === name) {
        return sub as RawFunction;
      }
    }
    return undefined;
  }

  private nodeRange(node: RawNode): Range {
    const loc = node.loc ?? {
      start: { line: 1, column: 0 },
      end: { line: 1, column: 0 },
    };
    return {
      start: { line: (loc.start.line ?? 1) - 1, character: loc.start.column ?? 0 },
      end: { line: (loc.end.line ?? 1) - 1, character: loc.end.column ?? 0 },
    };
  }

  private fullLineRange(line: number, lines: string[]): Range {
    return {
      start: { line, character: 0 },
      end: { line, character: lines[line]?.length ?? 0 },
    };
  }

  // ── External-call detection ────────────────────────────────────────

  private static readonly EXTERNAL_CALL_MEMBERS = new Set([
    "call",
    "delegatecall",
    "staticcall",
    "transfer",
    "send",
  ]);

  /**
   * True if `node` is a FunctionCall whose callee chain represents an
   * external call: `addr.call(...)`, `addr.call{value: x}(...)`,
   * `addr.transfer(...)`, `addr.send(...)`, or `.delegatecall` /
   * `.staticcall`.
   *
   * `addr.call{value: x}(data)` parses as
   *   FunctionCall(
   *     expression: FunctionCallOptions(
   *       expression: MemberAccess(..., memberName: "call")
   *     )
   *   )
   * so we peel FunctionCallOptions / NameValueExpression layers.
   */
  private isExternalCallNode(node: RawNode): boolean {
    if (node.type !== "FunctionCall") return false;
    let expr = (node as RawFunctionCall).expression;
    while (expr?.type === "FunctionCallOptions" || expr?.type === "NameValueExpression") {
      expr = (expr as { expression?: RawNode }).expression ?? undefined;
    }
    if (!expr || expr.type !== "MemberAccess") return false;
    const memberName = (expr as { memberName?: string }).memberName;
    return !!memberName && SolidityLinter.EXTERNAL_CALL_MEMBERS.has(memberName);
  }

  // ── Reentrancy (AST) ───────────────────────────────────────────────

  /**
   * CEI-violation heuristic on the AST:
   *
   * 1. Collect all state-variable names into a Set.
   * 2. For each function (no nonReentrant-style modifier, has a body):
   *    walk the top-level statement list in order. Track whether we've
   *    seen an external call. For every statement after the first
   *    external call, look for assignments that target state-variable
   *    identifiers and flag them.
   *
   * This is strictly more accurate than the regex version:
   *   - Doesn't fire on code inside `/* ... *\/` comments.
   *   - Doesn't fire on literal assignments that happen to contain
   *     a state-var name as a substring.
   *   - Correctly distinguishes `balances[msg.sender] -= amount` (an
   *     assignment-to-state) from `balances.length` (a read).
   */
  private checkReentrancyAst(
    contract: ContractDefinition,
    rawContract: RawContract,
    lines: string[],
  ): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const stateVarNames = new Set(contract.stateVariables.map((v) => v.name));
    if (stateVarNames.size === 0) return diagnostics;

    for (const func of contract.functions) {
      if (!func.body || !func.name) continue;
      if (
        func.modifiers.some(
          (m) => m.toLowerCase().includes("nonreentrant") || m.toLowerCase().includes("reentrancy"),
        )
      ) {
        continue;
      }

      const raw = this.findRawFunction(rawContract, func.name);
      if (!raw?.body?.statements) continue;

      let firstExternalCall: RawNode | null = null;
      for (const stmt of raw.body.statements) {
        const containsExternal = this.containsExternalCall(stmt);
        if (firstExternalCall && this.containsStateAssignment(stmt, stateVarNames)) {
          const range = this.nodeRange(stmt);
          diagnostics.push({
            severity: DiagnosticSeverity.Warning,
            range,
            message:
              `Potential reentrancy: state variable is modified after an external call on line ` +
              `${this.nodeRange(firstExternalCall).start.line + 1}. Follow the ` +
              `Checks-Effects-Interactions pattern.`,
            source: "solidity-workbench",
            code: "reentrancy",
          });
        }
        if (containsExternal && !firstExternalCall) {
          firstExternalCall = stmt;
        }
      }

      void lines; // kept only for the signature symmetry with other rules
    }

    return diagnostics;
  }

  private containsExternalCall(node: RawNode | undefined | null): boolean {
    if (!node) return false;
    let found = false;
    visit(node as any, {
      FunctionCall: (n: any) => {
        if (this.isExternalCallNode(n)) {
          found = true;
          return false; // stop descending into this subtree
        }
        return undefined;
      },
    });
    return found;
  }

  private containsStateAssignment(node: RawNode, stateVarNames: Set<string>): boolean {
    let found = false;
    visit(node as any, {
      BinaryOperation: (n: any) => {
        if (!this.isAssignmentOperator(n.operator)) return undefined;
        if (this.targetsStateVariable(n.left, stateVarNames)) {
          found = true;
          return false;
        }
        return undefined;
      },
      // `++x` / `x++` / `--x` / `x--` also mutate state when the operand
      // is a state variable.
      UnaryOperation: (n: any) => {
        if (n.operator !== "++" && n.operator !== "--") return undefined;
        if (this.targetsStateVariable(n.subExpression, stateVarNames)) {
          found = true;
          return false;
        }
        return undefined;
      },
    });
    return found;
  }

  private isAssignmentOperator(op: string | undefined): boolean {
    if (!op) return false;
    return (
      op === "=" ||
      op === "+=" ||
      op === "-=" ||
      op === "*=" ||
      op === "/=" ||
      op === "%=" ||
      op === "&=" ||
      op === "|=" ||
      op === "^=" ||
      op === "<<=" ||
      op === ">>="
    );
  }

  /**
   * True if `expr` is (or refers through index / member access to) a
   * state variable by name:
   *   foo         — Identifier("foo")
   *   foo[x]      — IndexAccess(base: Identifier("foo"))
   *   foo.bar     — MemberAccess(expression: Identifier("foo"))
   *   foo[x].bar  — MemberAccess(expression: IndexAccess(base: Identifier("foo")))
   */
  private targetsStateVariable(expr: RawNode | undefined, names: Set<string>): boolean {
    let cur: RawNode | undefined = expr;
    while (cur) {
      if (cur.type === "Identifier") {
        const id = cur as { name?: string };
        return !!id.name && names.has(id.name);
      }
      if (cur.type === "IndexAccess") {
        cur = (cur as { base?: RawNode }).base;
        continue;
      }
      if (cur.type === "MemberAccess") {
        cur = (cur as { expression?: RawNode }).expression;
        continue;
      }
      if (cur.type === "TupleExpression") {
        // For (a, b) = (...), we don't track tuple destructuring for now;
        // the upstream check assumes a single LHS. Skip.
        return false;
      }
      return false;
    }
    return false;
  }

  // ── Unchecked low-level calls (AST) ────────────────────────────────

  /**
   * Flag `addr.call(...)` / `addr.delegatecall(...)` / `addr.staticcall(...)`
   * whose return tuple is discarded.
   *
   * We do this by finding every FunctionCall that is an
   * `isExternalCallNode` match on one of `call/delegatecall/staticcall`
   * (not `transfer`/`send`, which return `void`/`bool`), then walking
   * up the parent chain looking at the *statement* that immediately
   * contains it:
   *   - VariableDeclarationStatement: has `(bool success, )` etc → OK
   *   - ExpressionStatement whose expression is the FunctionCall itself
   *     → unchecked, flag it
   *   - Anything else (used in a `require(...)`, passed as an argument,
   *     part of a larger expression) → considered "checked enough".
   */
  private checkUncheckedCallsAst(
    contract: ContractDefinition,
    rawContract: RawContract,
    lines: string[],
  ): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    for (const func of contract.functions) {
      if (!func.body || !func.name) continue;
      const raw = this.findRawFunction(rawContract, func.name);
      if (!raw?.body) continue;

      // Walk the body's statements and, for every top-level
      // ExpressionStatement that IS itself an external call to
      // call/delegatecall/staticcall, emit a diagnostic.
      this.walkStatements(raw.body, (stmt) => {
        if (stmt.type !== "ExpressionStatement") return;
        const expr = (stmt as { expression?: RawNode }).expression;
        if (!expr || expr.type !== "FunctionCall") return;

        const memberName = this.externalCallMember(expr);
        if (memberName !== "call" && memberName !== "delegatecall" && memberName !== "staticcall") {
          return;
        }
        diagnostics.push({
          severity: DiagnosticSeverity.Warning,
          range: this.fullLineRange(this.nodeRange(stmt).start.line, lines),
          message:
            "Low-level call return value not checked. Use `(bool success, ) = addr.call(...)` and check `success`.",
          source: "solidity-workbench",
          code: "unchecked-call",
        });
      });
    }

    return diagnostics;
  }

  /**
   * For a FunctionCall that represents an external member call, return
   * the member name (`call` / `delegatecall` / etc). Otherwise `null`.
   */
  private externalCallMember(node: RawNode): string | null {
    if (node.type !== "FunctionCall") return null;
    let expr: RawNode | undefined = (node as RawFunctionCall).expression;
    while (expr?.type === "FunctionCallOptions" || expr?.type === "NameValueExpression") {
      expr = (expr as { expression?: RawNode }).expression;
    }
    if (!expr || expr.type !== "MemberAccess") return null;
    const memberName = (expr as { memberName?: string }).memberName;
    if (!memberName || !SolidityLinter.EXTERNAL_CALL_MEMBERS.has(memberName)) {
      return null;
    }
    return memberName;
  }

  // ── Missing events (AST) ───────────────────────────────────────────

  /**
   * AST-based `missing-event`:
   *   for each public / external / internal non-view non-pure function
   *   with a body, check whether it both writes to a state variable
   *   AND does not contain any `emit X(...)` statement. If both are
   *   true, surface a diagnostic pointed at the function name.
   */
  private checkMissingEventsAst(
    contract: ContractDefinition,
    rawContract: RawContract,
    _lines: string[],
  ): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const stateVarNames = new Set(contract.stateVariables.map((v) => v.name));
    if (stateVarNames.size === 0) return diagnostics;

    for (const func of contract.functions) {
      if (!func.body || !func.name) continue;
      if (func.mutability === "view" || func.mutability === "pure") continue;
      if (func.visibility === "private") continue;
      if (func.kind !== "function") continue;

      const raw = this.findRawFunction(rawContract, func.name);
      if (!raw?.body) continue;

      const { modifiesState, emitsEvent } = this.analyseForMissingEvent(raw.body, stateVarNames);
      if (modifiesState && !emitsEvent) {
        diagnostics.push({
          severity: DiagnosticSeverity.Information,
          range: func.nameRange,
          message:
            `State-changing function '${func.name}' does not emit any events. ` +
            `Consider adding events for off-chain indexing.`,
          source: "solidity-workbench",
          code: "missing-event",
        });
      }
    }

    return diagnostics;
  }

  private analyseForMissingEvent(
    body: RawNode,
    stateVarNames: Set<string>,
  ): { modifiesState: boolean; emitsEvent: boolean } {
    let modifiesState = false;
    let emitsEvent = false;

    visit(body as any, {
      EmitStatement: () => {
        emitsEvent = true;
        return undefined;
      },
      BinaryOperation: (n: any) => {
        if (!modifiesState && this.isAssignmentOperator(n.operator)) {
          if (this.targetsStateVariable(n.left, stateVarNames)) {
            modifiesState = true;
          }
        }
        return undefined;
      },
      UnaryOperation: (n: any) => {
        if (!modifiesState && (n.operator === "++" || n.operator === "--")) {
          if (this.targetsStateVariable(n.subExpression, stateVarNames)) {
            modifiesState = true;
          }
        }
        return undefined;
      },
    });

    return { modifiesState, emitsEvent };
  }

  // ── Storage-in-loop (AST) ──────────────────────────────────────────

  /**
   * Warn when a state-variable Identifier appears inside a For / While
   * / DoWhile body. AST walking means:
   *   - Comments never fire
   *   - Loops that iterate over a function parameter `p` with the same
   *     name as a state var are NOT flagged (we only count Identifier
   *     nodes whose name is in the state-var set; parameter shadows
   *     would need scope analysis, which we defer to SolcBridge).
   *
   * We dedupe by (line, state-var) so a single loop that reads one
   * state var 3 times on the same line emits a single hint.
   */
  private checkStorageInLoopAst(
    contract: ContractDefinition,
    rawContract: RawContract,
    lines: string[],
  ): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const stateVarNames = new Set(contract.stateVariables.map((v) => v.name));
    if (stateVarNames.size === 0) return diagnostics;

    for (const func of contract.functions) {
      if (!func.body || !func.name) continue;
      const raw = this.findRawFunction(rawContract, func.name);
      if (!raw?.body) continue;

      visit(raw.body as any, {
        ForStatement: (n: any) => this.emitStorageInLoopHints(n, stateVarNames, diagnostics, lines),
        WhileStatement: (n: any) =>
          this.emitStorageInLoopHints(n, stateVarNames, diagnostics, lines),
        DoWhileStatement: (n: any) =>
          this.emitStorageInLoopHints(n, stateVarNames, diagnostics, lines),
      });
    }

    return diagnostics;
  }

  private emitStorageInLoopHints(
    loop: RawNode,
    stateVarNames: Set<string>,
    diagnostics: Diagnostic[],
    lines: string[],
  ): undefined {
    const seen = new Set<string>();
    visit(loop as any, {
      Identifier: (n: any) => {
        if (!stateVarNames.has(n.name)) return undefined;
        const range = this.nodeRange(n);
        const key = `${range.start.line}:${n.name}`;
        if (seen.has(key)) return undefined;
        seen.add(key);
        diagnostics.push({
          severity: DiagnosticSeverity.Hint,
          range: this.fullLineRange(range.start.line, lines),
          message: `State variable '${n.name}' accessed inside a loop. Cache it in a local variable for gas savings.`,
          source: "solidity-workbench",
          code: "storage-in-loop",
        });
        return undefined;
      },
    });
    return undefined;
  }

  // ── Dangerous delegatecall (AST) ───────────────────────────────────

  private checkDangerousDelegatecallAst(rawContract: RawContract, lines: string[]): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    for (const sub of rawContract.subNodes ?? []) {
      if (sub?.type !== "FunctionDefinition") continue;
      const func = sub as RawFunction;
      if (!func.body) continue;
      visit(func.body as any, {
        FunctionCall: (n: any) => {
          if (this.externalCallMember(n) !== "delegatecall") return undefined;
          const range = this.nodeRange(n);
          diagnostics.push({
            severity: DiagnosticSeverity.Warning,
            range: this.fullLineRange(range.start.line, lines),
            message:
              "delegatecall detected. Ensure the target address is trusted and not user-controlled.",
            source: "solidity-workbench",
            code: "dangerous-delegatecall",
          });
          return undefined;
        },
      });
    }

    return diagnostics;
  }

  // ── Unprotected selfdestruct (AST) ─────────────────────────────────

  private checkUnprotectedSelfdestructAst(
    contract: ContractDefinition,
    rawContract: RawContract,
    _lines: string[],
  ): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    for (const func of contract.functions) {
      if (!func.body || !func.name) continue;
      const raw = this.findRawFunction(rawContract, func.name);
      if (!raw?.body) continue;

      let hasSelfdestruct = false;
      let hasAccessCheck = func.modifiers.length > 0;

      visit(raw.body as any, {
        FunctionCall: (n: any) => {
          const callee = n.expression;
          if (
            callee?.type === "Identifier" &&
            (callee.name === "selfdestruct" || callee.name === "suicide")
          ) {
            hasSelfdestruct = true;
          }
          // Any require() call counts as an access check for our purposes.
          if (callee?.type === "Identifier" && callee.name === "require") {
            hasAccessCheck = true;
          }
          return undefined;
        },
        MemberAccess: (n: any) => {
          // `msg.sender == owner`-style comparisons elsewhere in the body
          // count as an inline check.
          if (n.memberName === "sender" && n.expression?.name === "msg") {
            hasAccessCheck = true;
          }
          return undefined;
        },
      });

      if (hasSelfdestruct && !hasAccessCheck) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: func.nameRange,
          message: `Function '${func.name}' contains selfdestruct without access control.`,
          source: "solidity-workbench",
          code: "unprotected-selfdestruct",
        });
      }
    }

    return diagnostics;
  }

  // ── Non-AST rules (unchanged behaviour) ────────────────────────────

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

        const hasCheck =
          bodyText.includes(`${param.name} != address(0)`) ||
          bodyText.includes(`${param.name} == address(0)`) ||
          bodyText.includes(`address(0) != ${param.name}`) ||
          bodyText.includes(`address(0) == ${param.name}`) ||
          bodyText.includes(`${param.name} != address(0x0)`) ||
          bodyText.includes(`_checkNonZero(${param.name})`) ||
          (bodyText.includes(`require(${param.name}`) && bodyText.includes("address(0)"));

        if (!hasCheck) {
          const range = this.paramRange(param.name, lines, func.range.start.line) ?? func.nameRange;
          diagnostics.push({
            severity: DiagnosticSeverity.Information,
            range,
            message: `Address parameter '${param.name}' not checked against zero address.`,
            source: "solidity-workbench",
            code: "missing-zero-check",
          });
        }
      }
    }

    return diagnostics;
  }

  private paramRange(paramName: string, lines: string[], startLine: number): Range | null {
    const maxLine = Math.min(startLine + 20, lines.length - 1);
    let lastHeaderLine = maxLine;
    for (let i = startLine; i <= maxLine; i++) {
      const line = lines[i] ?? "";
      if (line.includes("{") || line.includes(";")) {
        lastHeaderLine = i;
        break;
      }
    }

    const headerLines = lines.slice(startLine, lastHeaderLine + 1);
    const headerText = headerLines.join("\n");

    const match = new RegExp(`\\b${paramName}\\b`).exec(headerText);
    if (!match) return null;

    let idx = match.index;
    let lineOffset = 0;
    while (lineOffset < headerLines.length - 1 && idx > headerLines[lineOffset].length) {
      idx -= headerLines[lineOffset].length + 1;
      lineOffset++;
    }

    const absLine = startLine + lineOffset;
    return {
      start: { line: absLine, character: idx },
      end: { line: absLine, character: idx + paramName.length },
    };
  }

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
        if (num === 10000 || num === 100000 || num === 1000000) continue;
        if (trimmed.startsWith("pragma")) continue;

        diagnostics.push({
          severity: DiagnosticSeverity.Hint,
          range: {
            start: { line: i, character: match.index },
            end: { line: i, character: match.index + match[1].length },
          },
          message: `Magic number ${match[1]} — consider using a named constant.`,
          source: "solidity-workbench",
          code: "large-literal",
        });
      }
    }

    return diagnostics;
  }

  // ── Misc helpers ───────────────────────────────────────────────────

  /**
   * Run a side-effectful callback on every statement in `body`
   * (top-level plus any descendant block's statements).
   */
  private walkStatements(body: RawNode, fn: (stmt: RawNode) => void): void {
    visit(body as any, {
      ExpressionStatement: (n: any) => {
        fn(n);
        return undefined;
      },
    });
  }

  private getFunctionBodyLines(
    func: FunctionDefinition,
    lines: string[],
  ): { lines: string[]; startLine: number } | null {
    const startLine = func.range.start.line;
    let braceStart = -1;
    for (let i = startLine; i < Math.min(startLine + 10, lines.length); i++) {
      if (lines[i].includes("{")) {
        braceStart = i;
        break;
      }
    }
    if (braceStart === -1) return null;

    let depth = 0;
    for (let i = braceStart; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            return {
              lines: lines.slice(braceStart, i + 1),
              startLine: braceStart,
            };
          }
        }
      }
    }
    return null;
  }
}

// ── Shape interfaces for the raw AST subset we rely on ───────────────
//
// `@solidity-parser/parser` exports concrete types, but importing them
// here forces every consumer of `linter.ts` to resolve the parser's
// type graph. Instead we hand-roll the subset we touch — every field
// read by the rules above appears here.

interface RawLoc {
  start: { line?: number; column?: number };
  end: { line?: number; column?: number };
}

interface RawNode {
  type: string;
  loc?: RawLoc;
}

interface RawContract extends RawNode {
  type: "ContractDefinition";
  name: string;
  subNodes?: RawNode[];
}

interface RawFunction extends RawNode {
  type: "FunctionDefinition";
  name?: string;
  body?: RawNode & { statements?: RawNode[] };
}

interface RawFunctionCall extends RawNode {
  type: "FunctionCall";
  expression?: RawNode;
  arguments?: RawNode[];
}

// `visit` takes a typed `ASTVisitor` per the parser's type defs, but
// the handlers we pass return `undefined` / `false` and take broadly-
// typed nodes. `(n: any)` keeps the surface clean; see ESLint
// warnings — these are acceptable because the bottom of this file is
// explicitly the AST boundary.

// Retained for potential future use / interface parity with the mapped AST.
void (undefined as unknown as SourceRange);
