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
          ...this.checkEmptyBlockAst(rawContract, lines),
          ...this.checkPayableFallbackAst(rawContract, lines),
          ...this.checkFuncVisibilityExplicitAst(rawContract, lines),
          ...this.checkBooleanEqualityAst(rawContract, lines),
          ...this.checkDivideBeforeMultiplyAst(rawContract),
          ...this.checkIncorrectStrictEqualityAst(rawContract),
          ...this.checkWeakPrngAst(rawContract),
          ...this.checkEcrecoverZeroCheckAst(rawContract),
          ...this.checkUnsafeErc20CallAst(rawContract),
          ...this.checkShadowingStateAst(contract, rawContract),
          ...this.checkStateOptimizableAst(rawContract),
        );
      }

      // Rules that don't (yet) benefit from AST walking — these already
      // reason in terms of parameter lists we have on the mapped AST.
      diagnostics.push(...this.checkMissingZeroCheck(contract, lines));
    }

    // File-level rules (need raw AST top-level children)
    diagnostics.push(...this.checkMultiplePragma(rawAst, lines));

    // Line-only rules
    diagnostics.push(...this.checkLargeLiterals(lines));

    return diagnostics.filter((d) => !this.isSuppressed(d, lines));
  }

  // ── Empty function body ────────────────────────────────────────────

  /**
   * Flag function definitions whose body has no statements. Skipped:
   *   - Interfaces / abstract functions (`body` is absent — not empty)
   *   - Constructors (occasionally empty by design when a base contract
   *     requires explicit construction)
   *   - `fallback` / `receive` (intentional empty bodies are the common
   *     "accept ETH" idiom)
   *   - Modifiers (a `_;` placeholder still parses as a statement; an
   *     empty modifier body is rare and almost always intentional)
   */
  private checkEmptyBlockAst(rawContract: RawContract, lines: string[]): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    for (const sub of rawContract.subNodes ?? []) {
      if (sub?.type !== "FunctionDefinition") continue;
      const func = sub as RawFunction;
      if (!func.body) continue;
      if (func.isConstructor || func.isFallback || func.isReceiveEther) continue;
      const stmts = (func.body as { statements?: RawNode[] }).statements ?? [];
      if (stmts.length > 0) continue;
      const range = this.nodeRange(func.body);
      diagnostics.push({
        severity: DiagnosticSeverity.Information,
        range: this.fullLineRange(range.start.line, lines),
        message: `Function '${func.name ?? "<anonymous>"}' has an empty body.`,
        source: "solidity-workbench",
        code: "empty-block",
      });
    }
    return diagnostics;
  }

  // ── Non-payable fallback ───────────────────────────────────────────

  /**
   * `fallback()` is invoked when calldata doesn't match any function.
   * In Solidity 0.6+, `receive()` handles bare-ETH transfers and
   * `fallback()` handles everything else. If `fallback()` isn't
   * payable AND the contract has no `receive()`, the contract can't
   * accept ETH at all — sends will revert at runtime.
   *
   * We only flag the non-payable fallback when no `receive()` is
   * present; with a payable `receive()`, a non-payable `fallback()`
   * is intentional and correct.
   */
  private checkPayableFallbackAst(rawContract: RawContract, lines: string[]): Diagnostic[] {
    let hasReceive = false;
    let nonPayableFallback: RawFunction | null = null;

    for (const sub of rawContract.subNodes ?? []) {
      if (sub?.type !== "FunctionDefinition") continue;
      const func = sub as RawFunction;
      if (func.isReceiveEther) hasReceive = true;
      if (func.isFallback && func.stateMutability !== "payable") {
        nonPayableFallback = func;
      }
    }

    if (!nonPayableFallback || hasReceive) return [];

    const range = this.nodeRange(nonPayableFallback);
    return [
      {
        severity: DiagnosticSeverity.Warning,
        range: this.fullLineRange(range.start.line, lines),
        message:
          "fallback() is not payable and there is no receive(); plain ETH transfers to this contract will revert. Mark fallback() payable or add a receive().",
        source: "solidity-workbench",
        code: "payable-fallback",
      },
    ];
  }

  // ── Explicit function visibility ───────────────────────────────────

  /**
   * Solidity 0.5+ requires every function to declare its visibility.
   * Older code (and code under permissive parsers) may omit it; the
   * default is `internal`, which is rarely what was intended. Flag any
   * regular function that the parser reports with `visibility: "default"`.
   * Constructor / fallback / receive are skipped — their visibility
   * rules differ across compiler versions and false-positives there
   * would be noisy.
   */
  private checkFuncVisibilityExplicitAst(
    rawContract: RawContract,
    lines: string[],
  ): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    for (const sub of rawContract.subNodes ?? []) {
      if (sub?.type !== "FunctionDefinition") continue;
      const func = sub as RawFunction;
      if (func.isConstructor || func.isFallback || func.isReceiveEther) continue;
      if (func.visibility !== "default") continue;
      const range = this.nodeRange(func);
      diagnostics.push({
        severity: DiagnosticSeverity.Information,
        range: this.fullLineRange(range.start.line, lines),
        message: `Function '${func.name ?? "<anonymous>"}' has no explicit visibility — declare it as public, external, internal, or private.`,
        source: "solidity-workbench",
        code: "func-visibility-explicit",
      });
    }
    return diagnostics;
  }

  // ── Boolean equality ───────────────────────────────────────────────

  /**
   * Flag `x == true` / `x == false` / `x != true` / `x != false` (and
   * the symmetric forms). Using the boolean directly is shorter, more
   * idiomatic, and avoids a class of bugs where a typo turns the
   * expression into an assignment-and-compare on a non-bool variable.
   */
  private checkBooleanEqualityAst(rawContract: RawContract, lines: string[]): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    void lines;
    for (const sub of rawContract.subNodes ?? []) {
      if (sub?.type !== "FunctionDefinition") continue;
      const func = sub as RawFunction;
      if (!func.body) continue;
      visit(func.body as any, {
        BinaryOperation: (n: any) => {
          if (n.operator !== "==" && n.operator !== "!=") return undefined;
          const isBoolLit = (e: { type?: string } | undefined): boolean =>
            e?.type === "BooleanLiteral";
          if (!isBoolLit(n.left) && !isBoolLit(n.right)) return undefined;
          diagnostics.push({
            severity: DiagnosticSeverity.Warning,
            range: this.nodeRange(n),
            message:
              "Avoid comparing a boolean to a literal `true`/`false`; use the boolean directly (e.g. `if (x)` or `if (!x)`).",
            source: "solidity-workbench",
            code: "boolean-equality",
          });
          return undefined;
        },
      });
    }
    return diagnostics;
  }

  // ── Divide before multiply ─────────────────────────────────────────

  /**
   * Integer division in Solidity truncates, so `(a / b) * c` loses
   * precision compared to `(a * c) / b`. Flag any multiplication whose
   * direct operand is a division. We don't recurse into nested
   * sub-expressions — the canonical "lost precision" pattern is the
   * one-step `(a / b) * c`; deeper structures are usually intentional.
   */
  private checkDivideBeforeMultiplyAst(rawContract: RawContract): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    for (const sub of rawContract.subNodes ?? []) {
      if (sub?.type !== "FunctionDefinition") continue;
      const func = sub as RawFunction;
      if (!func.body) continue;
      visit(func.body as any, {
        BinaryOperation: (n: any) => {
          if (n.operator !== "*") return undefined;
          if (!this.isDivisionExpression(n.left) && !this.isDivisionExpression(n.right)) {
            return undefined;
          }
          diagnostics.push({
            severity: DiagnosticSeverity.Warning,
            range: this.nodeRange(n),
            message:
              "Division before multiplication loses precision in integer arithmetic. Reorder so the multiplication runs first (e.g. `(a * c) / b` instead of `(a / b) * c`).",
            source: "solidity-workbench",
            code: "divide-before-multiply",
          });
          return undefined;
        },
      });
    }
    return diagnostics;
  }

  // ── state-could-be-constant / state-could-be-immutable ────────────

  /**
   * Suggest `constant` or `immutable` for state variables that never
   * change after deployment.
   *
   *   - Only initialized at declaration, never assigned anywhere → could be `constant`.
   *   - Assigned exactly once in the constructor and never again → could be `immutable`.
   *
   * `constant` requires a compile-time-evaluable init expression; we
   * skip the suggestion when the init reaches `block.*` / `msg.*` /
   * `tx.*` (clearly runtime values). Solc will reject anything else
   * non-constexpr at compile time — keeping the rule a Hint rather
   * than a Warning since the verification is necessarily incomplete.
   */
  private checkStateOptimizableAst(rawContract: RawContract): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    const subs = rawContract.subNodes ?? [];
    const ctorBody = subs
      .filter((s): s is RawFunction => s?.type === "FunctionDefinition")
      .find((f) => f.isConstructor)?.body;
    const otherBodies = subs
      .filter((s): s is RawFunction => s?.type === "FunctionDefinition")
      .filter((f) => !f.isConstructor)
      .map((f) => f.body)
      .filter((b): b is NonNullable<typeof b> => !!b);

    for (const sub of subs) {
      if (sub?.type !== "StateVariableDeclaration") continue;
      const decls = (sub as RawNode & { variables?: RawNode[] }).variables ?? [];
      for (const raw of decls) {
        const v = raw as RawNode & {
          name?: string;
          identifier?: RawNode;
          expression?: RawNode | null;
          isDeclaredConst?: boolean;
          isImmutable?: boolean;
        };
        if (!v?.name) continue;
        if (v.isDeclaredConst || v.isImmutable) continue;

        const nameSet = new Set([v.name]);
        const ctorAssigns = ctorBody ? this.countStateAssignments(ctorBody, nameSet) : 0;
        let otherAssigns = 0;
        for (const body of otherBodies) {
          otherAssigns += this.countStateAssignments(body, nameSet);
          if (otherAssigns > 0) break;
        }
        if (otherAssigns > 0) continue;

        const hasInit = !!v.expression;
        const range = this.nodeRange(v.identifier ?? v);

        if (hasInit && ctorAssigns === 0) {
          if (this.containsRuntimeReference(v.expression)) continue;
          diagnostics.push({
            severity: DiagnosticSeverity.Hint,
            range,
            message: `State variable '${v.name}' is only initialized at declaration and never reassigned — consider declaring it 'constant' (saves storage, deploy gas, and reads).`,
            source: "solidity-workbench",
            code: "state-could-be-constant",
          });
        } else if (!hasInit && ctorAssigns === 1) {
          diagnostics.push({
            severity: DiagnosticSeverity.Hint,
            range,
            message: `State variable '${v.name}' is only assigned in the constructor — consider declaring it 'immutable' (saves an SLOAD per read).`,
            source: "solidity-workbench",
            code: "state-could-be-immutable",
          });
        }
      }
    }

    return diagnostics;
  }

  /** Count assignments / `++` / `--` mutations of any name in `names` within `body`. */
  private countStateAssignments(body: RawNode, names: Set<string>): number {
    let count = 0;
    visit(body as any, {
      BinaryOperation: (n: any) => {
        if (!this.isAssignmentOperator(n.operator)) return undefined;
        if (this.targetsStateVariable(n.left, names)) count++;
        return undefined;
      },
      UnaryOperation: (n: any) => {
        if (n.operator !== "++" && n.operator !== "--") return undefined;
        if (this.targetsStateVariable(n.subExpression, names)) count++;
        return undefined;
      },
    });
    return count;
  }

  /**
   * True when `expr`'s subtree references a runtime-only value: `block`,
   * `msg`, `tx`, or an immediate `Identifier` access of one of those
   * three. These exclude a state variable from being declared
   * `constant` (the compiler would reject it).
   */
  private containsRuntimeReference(expr: RawNode | null | undefined): boolean {
    if (!expr) return false;
    let found = false;
    visit(expr as any, {
      MemberAccess: (n: any) => {
        const baseName = n.expression?.type === "Identifier" ? n.expression?.name : undefined;
        if (baseName === "block" || baseName === "msg" || baseName === "tx") {
          found = true;
          return false;
        }
        return undefined;
      },
    });
    return found;
  }

  // ── Shadowing state ────────────────────────────────────────────────

  /**
   * Flag function parameters or locally-declared variables whose name
   * collides with a state variable of the same contract. Shadowed
   * names are confusing at best (the local wins, the state var becomes
   * inaccessible without `this.`) and a real bug source — typos can
   * silently shift writes from state to a stack variable.
   *
   * Inherited state-var shadowing is not yet detected (would need an
   * inheritance walk). The immediate-contract case catches the common
   * footgun.
   */
  private checkShadowingStateAst(
    contract: ContractDefinition,
    rawContract: RawContract,
  ): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const stateVarNames = new Set(
      contract.stateVariables.map((v) => v.name).filter((n): n is string => !!n),
    );
    if (stateVarNames.size === 0) return diagnostics;

    for (const sub of rawContract.subNodes ?? []) {
      if (sub?.type !== "FunctionDefinition") continue;
      const func = sub as RawFunction & { parameters?: RawNode[] };

      for (const p of func.parameters ?? []) {
        const param = p as RawNode & {
          name?: string;
          identifier?: RawNode;
        };
        if (!param.name || !stateVarNames.has(param.name)) continue;
        diagnostics.push({
          severity: DiagnosticSeverity.Information,
          range: this.nodeRange(param.identifier ?? param),
          message: `Parameter '${param.name}' shadows a state variable in '${contract.name}'.`,
          source: "solidity-workbench",
          code: "shadowing-state",
        });
      }

      if (!func.body) continue;
      visit(func.body as any, {
        VariableDeclarationStatement: (stmt: any) => {
          for (const v of stmt.variables ?? []) {
            if (!v?.name || !stateVarNames.has(v.name)) continue;
            diagnostics.push({
              severity: DiagnosticSeverity.Information,
              range: this.nodeRange(v.identifier ?? v),
              message: `Local variable '${v.name}' shadows a state variable in '${contract.name}'.`,
              source: "solidity-workbench",
              code: "shadowing-state",
            });
          }
          return undefined;
        },
      });
    }

    return diagnostics;
  }

  // ── Unsafe ERC-20 call ─────────────────────────────────────────────

  /**
   * Flag direct calls to `transfer` / `transferFrom` / `approve` on a
   * variable whose declared type matches an ERC-20-like interface
   * (anything containing `ERC20` or `ERC4626` in the type name).
   *
   * Background: many real-world tokens don't return `bool` (USDT) or
   * revert on partial success (BNB pre-fix), so naive `.transfer`
   * silently fails or reverts the calling transaction. The standard
   * fix is OpenZeppelin's `SafeERC20` or solmate's `SafeTransferLib`
   * via a `using ... for IERC20` directive. We suppress the warning
   * when that directive is present in the contract.
   */
  private checkUnsafeErc20CallAst(rawContract: RawContract): Diagnostic[] {
    const subs = rawContract.subNodes ?? [];

    const usesSafeWrapper = subs.some((sub) => {
      if (sub?.type !== "UsingForDeclaration") return false;
      const lib = (sub as RawNode & { libraryName?: string }).libraryName ?? "";
      return /SafeERC20|SafeTransferLib/.test(lib);
    });
    if (usesSafeWrapper) return [];

    const erc20Names = new Set<string>();
    for (const sub of subs) {
      if (sub?.type !== "StateVariableDeclaration") continue;
      for (const v of (sub as RawNode & { variables?: RawNode[] }).variables ?? []) {
        if (this.isErc20TypeName((v as { typeName?: RawNode }).typeName)) {
          const name = (v as { name?: string }).name;
          if (name) erc20Names.add(name);
        }
      }
    }

    const diagnostics: Diagnostic[] = [];

    for (const sub of subs) {
      if (sub?.type !== "FunctionDefinition") continue;
      const func = sub as RawFunction & { parameters?: RawNode[] };
      if (!func.body) continue;

      const inScope = new Set(erc20Names);
      for (const p of func.parameters ?? []) {
        if (this.isErc20TypeName((p as { typeName?: RawNode }).typeName)) {
          const name = (p as { name?: string }).name;
          if (name) inScope.add(name);
        }
      }
      visit(func.body as any, {
        VariableDeclarationStatement: (stmt: any) => {
          for (const v of stmt.variables ?? []) {
            // Tuple destructuring slots can be null (e.g.
            // `(bool ok, ) = ...`); guard before reading typeName.
            if (!v) continue;
            if (this.isErc20TypeName(v.typeName) && v.name) inScope.add(v.name);
          }
          return undefined;
        },
      });

      visit(func.body as any, {
        FunctionCall: (n: any) => {
          const callee = n.expression;
          if (callee?.type !== "MemberAccess") return undefined;
          const member = callee.memberName;
          if (member !== "transfer" && member !== "transferFrom" && member !== "approve") {
            return undefined;
          }
          const receiver = callee.expression;
          if (receiver?.type !== "Identifier" || !inScope.has(receiver.name)) {
            return undefined;
          }
          diagnostics.push({
            severity: DiagnosticSeverity.Warning,
            range: this.nodeRange(n),
            message: `Unsafe direct call to \`${receiver.name}.${member}\`. Many real-world ERC-20 tokens (USDT, BNB pre-fix) don't return bool — use \`SafeERC20\` (OpenZeppelin) or \`SafeTransferLib\` (solmate) via a \`using ... for ${receiver.name}\` directive.`,
            source: "solidity-workbench",
            code: "unsafe-erc20-call",
          });
          return undefined;
        },
      });
    }

    return diagnostics;
  }

  /**
   * True if `typeName` is a `UserDefinedTypeName` whose name contains
   * `ERC20` or `ERC4626` (the latter inherits the IERC20 interface so
   * `transfer`/`approve` still apply with the same risk).
   */
  private isErc20TypeName(typeName: unknown): boolean {
    const t = typeName as { type?: string; namePath?: string; name?: string } | undefined;
    if (t?.type !== "UserDefinedTypeName") return false;
    const name = t.namePath ?? t.name ?? "";
    return /ERC20|ERC4626/.test(name);
  }

  // ── ecrecover zero-check ───────────────────────────────────────────

  /**
   * `ecrecover(...)` returns `address(0)` for an invalid signature. If
   * the result is captured into a local variable and then used (e.g.
   * `balances[signer] += amount`) without a `signer != address(0)`
   * check, malformed signatures pass authentication.
   *
   * Strategy:
   *   1. Find every `address X = ecrecover(...)` site, recording the
   *      capture name and the call node.
   *   2. Walk the same function body for any `==` / `!=` comparison
   *      against `address(0)` and record which Identifier names get
   *      a zero-check.
   *   3. Flag any captured ecrecover whose name is NOT in the
   *      zero-checked set.
   *
   * Inline uses (e.g. `require(ecrecover(...) == owner, "...")`) are
   * not flagged: the comparison naturally rejects `address(0)` so
   * long as the RHS isn't itself zero, and we can't statically prove
   * that here.
   */
  private checkEcrecoverZeroCheckAst(rawContract: RawContract): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    for (const sub of rawContract.subNodes ?? []) {
      if (sub?.type !== "FunctionDefinition") continue;
      const func = sub as RawFunction;
      if (!func.body) continue;

      const captured = new Map<string, RawNode>();
      visit(func.body as any, {
        VariableDeclarationStatement: (stmt: any) => {
          const init = stmt.initialValue;
          if (init?.type !== "FunctionCall") return undefined;
          if (init.expression?.type !== "Identifier" || init.expression.name !== "ecrecover") {
            return undefined;
          }
          const varName = stmt.variables?.[0]?.name;
          if (varName) captured.set(varName, init);
          return undefined;
        },
      });

      if (captured.size === 0) continue;

      const zeroChecked = new Set<string>();
      visit(func.body as any, {
        BinaryOperation: (n: any) => {
          if (n.operator !== "==" && n.operator !== "!=") return undefined;
          const other = this.isAddressZero(n.left)
            ? n.right
            : this.isAddressZero(n.right)
              ? n.left
              : null;
          if (other?.type === "Identifier" && other.name) {
            zeroChecked.add(other.name);
          }
          return undefined;
        },
      });

      for (const [name, node] of captured) {
        if (zeroChecked.has(name)) continue;
        diagnostics.push({
          severity: DiagnosticSeverity.Warning,
          range: this.nodeRange(node),
          message: `ecrecover result captured into '${name}' is not checked against address(0). An invalid signature returns address(0); without the check, malformed inputs pass authentication.`,
          source: "solidity-workbench",
          code: "ecrecover-zero-check",
        });
      }
    }
    return diagnostics;
  }

  /**
   * True if `expr` is an `address(0)` / `address(0x0)` literal call.
   */
  private isAddressZero(expr: unknown): boolean {
    const e = expr as
      | {
          type?: string;
          expression?: { type?: string; name?: string };
          arguments?: { type?: string; number?: string }[];
        }
      | undefined;
    if (e?.type !== "FunctionCall") return false;
    if (e.expression?.type !== "Identifier" || e.expression?.name !== "address") return false;
    const arg = e.arguments?.[0];
    if (arg?.type !== "NumberLiteral") return false;
    const num = arg.number ?? "";
    return num === "0" || /^0x0+$/i.test(num);
  }

  // ── Weak PRNG ──────────────────────────────────────────────────────

  /**
   * Block fields are predictable: validators see them before any
   * transaction in their block runs, and historical block fields are
   * public. Using `block.timestamp` / `block.number` /
   * `block.difficulty` / `block.prevrandao` / `blockhash(...)` as a
   * randomness source — recognised by a `% N` modulo against an
   * expression that touches one of those fields — is exploitable.
   *
   * We don't flag the same fields used as deadlines / timestamps; the
   * modulo is the load-bearing signal.
   */
  private checkWeakPrngAst(rawContract: RawContract): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    for (const sub of rawContract.subNodes ?? []) {
      if (sub?.type !== "FunctionDefinition") continue;
      const func = sub as RawFunction;
      if (!func.body) continue;
      visit(func.body as any, {
        BinaryOperation: (n: any) => {
          if (n.operator !== "%") return undefined;
          if (
            !this.containsBlockEntropySource(n.left) &&
            !this.containsBlockEntropySource(n.right)
          ) {
            return undefined;
          }
          diagnostics.push({
            severity: DiagnosticSeverity.Warning,
            range: this.nodeRange(n),
            message:
              "Block fields (`block.timestamp`, `block.number`, `block.prevrandao`, `blockhash`) are predictable; a `% N` against them is not a secure source of randomness. Use a VRF (Chainlink VRF, Pyth Entropy) instead.",
            source: "solidity-workbench",
            code: "weak-prng",
          });
          return undefined;
        },
      });
    }
    return diagnostics;
  }

  private static readonly BLOCK_ENTROPY_MEMBERS = new Set([
    "timestamp",
    "number",
    "difficulty",
    "prevrandao",
  ]);

  /** True if any node in `expr`'s subtree is a block-entropy source. */
  private containsBlockEntropySource(expr: unknown): boolean {
    let found = false;
    visit(expr as any, {
      MemberAccess: (n: any) => {
        if (
          SolidityLinter.BLOCK_ENTROPY_MEMBERS.has(n.memberName) &&
          n.expression?.type === "Identifier" &&
          n.expression?.name === "block"
        ) {
          found = true;
          return false;
        }
        return undefined;
      },
      FunctionCall: (n: any) => {
        if (n.expression?.type === "Identifier" && n.expression?.name === "blockhash") {
          found = true;
          return false;
        }
        return undefined;
      },
    });
    return found;
  }

  // ── Strict equality on volatile values ─────────────────────────────

  /**
   * Flag `==` / `!=` against `block.timestamp` / `block.number` /
   * `block.difficulty` / `block.prevrandao` / `addr.balance`. These
   * values change between blocks and across calls; strict equality
   * almost never does what the author intended (off-by-one errors,
   * trivially front-runnable). Use `>=` / `<=` ranges instead.
   */
  private checkIncorrectStrictEqualityAst(rawContract: RawContract): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    for (const sub of rawContract.subNodes ?? []) {
      if (sub?.type !== "FunctionDefinition") continue;
      const func = sub as RawFunction;
      if (!func.body) continue;
      visit(func.body as any, {
        BinaryOperation: (n: any) => {
          if (n.operator !== "==" && n.operator !== "!=") return undefined;
          const volatileSide = this.volatileExpressionLabel(n.left) ?? this.volatileExpressionLabel(n.right);
          if (!volatileSide) return undefined;
          diagnostics.push({
            severity: DiagnosticSeverity.Warning,
            range: this.nodeRange(n),
            message: `Strict equality (\`${n.operator}\`) on \`${volatileSide}\` is fragile — the value changes between blocks. Use a range comparison (\`>=\` / \`<=\`) instead.`,
            source: "solidity-workbench",
            code: "incorrect-strict-equality",
          });
          return undefined;
        },
      });
    }
    return diagnostics;
  }

  private static readonly VOLATILE_BLOCK_MEMBERS = new Set([
    "timestamp",
    "number",
    "difficulty",
    "prevrandao",
  ]);

  /**
   * If `expr` is a known volatile chain access, return a human-readable
   * label for it (`block.timestamp`, `addr.balance`, etc.); otherwise
   * `null`. Used by the strict-equality rule to format the diagnostic.
   */
  private volatileExpressionLabel(expr: unknown): string | null {
    const e = expr as
      | {
          type?: string;
          memberName?: string;
          expression?: { type?: string; name?: string };
        }
      | undefined;
    if (e?.type !== "MemberAccess" || !e.memberName) return null;
    if (e.memberName === "balance") return `${e.expression?.name ?? "<expr>"}.balance`;
    if (
      SolidityLinter.VOLATILE_BLOCK_MEMBERS.has(e.memberName) &&
      e.expression?.type === "Identifier" &&
      e.expression?.name === "block"
    ) {
      return `block.${e.memberName}`;
    }
    return null;
  }

  /**
   * Peel `TupleExpression` parens (`(expr)` parses as a one-element
   * tuple) and report whether the underlying expression is a binary
   * division.
   */
  private isDivisionExpression(expr: unknown): boolean {
    let cur: { type?: string; operator?: string; components?: unknown[] } | undefined = expr as {
      type?: string;
      operator?: string;
      components?: unknown[];
    };
    while (cur?.type === "TupleExpression" && cur.components?.length === 1) {
      cur = cur.components[0] as typeof cur;
    }
    return cur?.type === "BinaryOperation" && cur.operator === "/";
  }

  // ── Multiple pragma directives (file-level) ────────────────────────

  /**
   * Solidity allows only one `pragma solidity ...` per file. Multiple
   * directives are accepted by `@solidity-parser/parser` but rejected
   * by the compiler with a confusing error; surface it earlier.
   */
  private checkMultiplePragma(rawAst: unknown, lines: string[]): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    if (!rawAst) return diagnostics;
    const ast = rawAst as { children?: RawNode[] };
    let seenSolidityPragma = false;
    for (const child of ast.children ?? []) {
      if (child?.type !== "PragmaDirective") continue;
      const name = (child as RawNode & { name?: string }).name;
      if (name !== "solidity") continue;
      if (!seenSolidityPragma) {
        seenSolidityPragma = true;
        continue;
      }
      const range = this.nodeRange(child);
      diagnostics.push({
        severity: DiagnosticSeverity.Warning,
        range: this.fullLineRange(range.start.line, lines),
        message:
          "Multiple `pragma solidity` directives in one file — Solidity only honors one and the compiler will reject this.",
        source: "solidity-workbench",
        code: "multiple-pragma",
      });
    }
    return diagnostics;
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
  name?: string | null;
  body?: RawNode & { statements?: RawNode[] };
  isConstructor?: boolean;
  isReceiveEther?: boolean;
  isFallback?: boolean;
  stateMutability?: string | null;
  visibility?: string;
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
