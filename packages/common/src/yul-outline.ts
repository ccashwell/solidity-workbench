/**
 * Parses the textual Yul (IR) output of `forge inspect <Contract>
 * (ir|irOptimized)` into a structured outline of objects and the
 * functions defined inside them. Used by the IR Viewer panel to render
 * a clickable table of contents alongside the dump.
 *
 * The parser is intentionally tolerant: it scans token-by-token with
 * brace-depth tracking, skips over `//` and `/* ... *\/` comments and
 * `"..."` string literals, and recognises only the headers it needs
 * (`object "Name" {`, `function name(...) {`). It does NOT validate
 * the surrounding Yul syntax. If the compiler ever changes the IR
 * shape, the worst case is a missing TOC entry — never a crash.
 *
 * Function naming convention emitted by `solc` follows fixed prefixes
 * we use to demangle a display name and bucket each function:
 *   - `external_fun_<solName>_<id>`     external dispatcher entry
 *   - `fun_<solName>_<id>`              user-defined function body
 *   - `getter_fun_<solName>_<id>`       auto-generated public-state-var getter
 *   - `constructor_<Contract>_<id>`     constructor body
 *   - `modifier_<solName>_<id>`         (rare; modifiers are usually inlined)
 *   - `abi_decode_*`, `abi_encode_*`    calldata / return-value encoders
 *   - `revert_error_*`, `panic_error_*` revert / panic dispatchers
 *   - `read_from_storage_*`, `update_storage_*`, ...   storage helpers
 *   - `allocate_*`, `array_*`           memory helpers
 *   - `shift_*`, `checked_*`, ...       arithmetic helpers
 * The trailing `_<id>` is the source AST identifier; it's preserved on
 * `name` (so users can disambiguate overloads) but stripped from
 * `displayName`.
 */

export type YulFunctionCategory =
  | "external"
  | "internal"
  | "getter"
  | "constructor"
  | "modifier"
  | "abi"
  | "cleanup"
  | "revert"
  | "storage"
  | "memory"
  | "math"
  | "util";

export interface YulFunction {
  /** Mangled name as it appears in the Yul source. */
  name: string;
  /** Demangled, source-level identifier (e.g. `increment`). `null` for runtime helpers. */
  displayName: string | null;
  /** Trailing AST id stripped from `name`, or `null` if absent. */
  astId: string | null;
  category: YulFunctionCategory;
  /** 1-based line of the `function ...` header. */
  startLine: number;
  /** 1-based line of the closing `}` of the body, or the start line if unterminated. */
  endLine: number;
  /** Name of the enclosing Yul `object`. */
  objectName: string;
}

export interface YulObject {
  name: string;
  startLine: number;
  endLine: number;
  functions: YulFunction[];
}

export interface YulOutline {
  objects: YulObject[];
}

/**
 * Parse a Yul source string into its outline. Top-level objects are
 * returned in source order; functions inside each object are likewise
 * in source order.
 */
export function parseYulOutline(source: string): YulOutline {
  const objects: (YulObject & { _openDepth: number })[] = [];
  const objectStack: number[] = [];
  const fnStack: {
    mangled: string;
    startLine: number;
    bodyDepth: number;
    objIdx: number;
  }[] = [];

  let depth = 0;
  let line = 1;
  let i = 0;
  const n = source.length;

  while (i < n) {
    const ch = source[i];

    if (ch === "\n") {
      line++;
      i++;
      continue;
    }

    // `// ...` line comment
    if (ch === "/" && source[i + 1] === "/") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }

    // `/* ... */` block comment
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < n) {
        if (source[i] === "\n") line++;
        if (source[i] === "*" && source[i + 1] === "/") {
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }

    // `"..."` string literal
    if (ch === '"') {
      i++;
      while (i < n && source[i] !== '"') {
        if (source[i] === "\\" && i + 1 < n) {
          if (source[i + 1] === "\n") line++;
          i += 2;
        } else if (source[i] === "\n") {
          line++;
          i++;
        } else {
          i++;
        }
      }
      if (i < n) i++;
      continue;
    }

    if (ch === "{") {
      depth++;
      i++;
      continue;
    }

    if (ch === "}") {
      depth--;
      i++;

      // Close any functions whose body just ended.
      while (fnStack.length > 0 && fnStack[fnStack.length - 1].bodyDepth - 1 === depth) {
        const fn = fnStack.pop() as (typeof fnStack)[number];
        const obj = objects[fn.objIdx];
        const { displayName, astId } = demangle(fn.mangled);
        obj.functions.push({
          name: fn.mangled,
          displayName,
          astId,
          category: categorize(fn.mangled),
          startLine: fn.startLine,
          endLine: line,
          objectName: obj.name,
        });
      }

      // Close any objects whose body just ended.
      while (
        objectStack.length > 0 &&
        objects[objectStack[objectStack.length - 1]]._openDepth - 1 === depth
      ) {
        const idx = objectStack.pop() as number;
        objects[idx].endLine = line;
      }

      continue;
    }

    // Identifier — could be `object`, `function`, or anything else.
    if (isIdStart(ch)) {
      let end = i + 1;
      while (end < n && isIdCont(source[end])) end++;
      const word = source.slice(i, end);

      if (word === "object") {
        const opened = consumeObjectHeader(source, end, line);
        if (opened) {
          const obj: (YulObject & { _openDepth: number }) = {
            name: opened.name,
            startLine: line,
            endLine: -1,
            functions: [],
            _openDepth: depth + 1,
          };
          objects.push(obj);
          objectStack.push(objects.length - 1);
          depth++;
          i = opened.afterBraceIndex;
          line = opened.line;
          continue;
        }
      }

      if (word === "function") {
        const opened = consumeFunctionHeader(source, end, line);
        if (opened) {
          if (objectStack.length > 0) {
            fnStack.push({
              mangled: opened.name,
              startLine: opened.headerLine,
              bodyDepth: depth + 1,
              objIdx: objectStack[objectStack.length - 1],
            });
          }
          depth++;
          i = opened.afterBraceIndex;
          line = opened.line;
          continue;
        }
      }

      i = end;
      continue;
    }

    i++;
  }

  // Strip the internal `_openDepth` field before returning.
  return {
    objects: objects.map((o) => ({
      name: o.name,
      startLine: o.startLine,
      endLine: o.endLine === -1 ? o.startLine : o.endLine,
      functions: o.functions,
    })),
  };
}

/**
 * Find the first function whose `displayName` matches `solidityName`,
 * preferring an `external` match over `internal` over `getter` (the
 * order a user clicking "show me increment" would expect).
 */
export function findYulFunctionByName(
  outline: YulOutline,
  solidityName: string,
): YulFunction | undefined {
  const priority: YulFunctionCategory[] = ["external", "internal", "getter", "constructor"];
  for (const cat of priority) {
    for (const obj of outline.objects) {
      const hit = obj.functions.find((f) => f.category === cat && f.displayName === solidityName);
      if (hit) return hit;
    }
  }
  return undefined;
}

/**
 * Strip the trailing `_<digits>` AST identifier and the well-known
 * solc prefix to produce a Solidity-level display name. Returns the
 * full AST id alongside so callers can disambiguate overloads.
 */
function demangle(mangled: string): { displayName: string | null; astId: string | null } {
  const idMatch = /_(\d+)$/.exec(mangled);
  const astId = idMatch ? idMatch[1] : null;
  const stripped = idMatch ? mangled.slice(0, -idMatch[0].length) : mangled;

  const PREFIXES = [
    "external_fun_",
    "getter_fun_",
    "fun_",
    "constructor_",
    "modifier_",
  ] as const;
  for (const p of PREFIXES) {
    if (stripped.startsWith(p)) {
      const rest = stripped.slice(p.length);
      return { displayName: rest.length > 0 ? rest : null, astId };
    }
  }
  return { displayName: null, astId };
}

function categorize(mangled: string): YulFunctionCategory {
  if (mangled.startsWith("external_fun_")) return "external";
  if (mangled.startsWith("getter_fun_")) return "getter";
  if (mangled.startsWith("fun_")) return "internal";
  if (mangled.startsWith("constructor_")) return "constructor";
  if (mangled.startsWith("modifier_")) return "modifier";
  if (mangled.startsWith("abi_")) return "abi";
  if (mangled.startsWith("cleanup_") || mangled.startsWith("validator_")) return "cleanup";
  if (
    mangled.startsWith("revert_error_") ||
    mangled.startsWith("panic_error_") ||
    mangled.startsWith("require_helper_")
  )
    return "revert";
  if (
    mangled.startsWith("read_from_storage_") ||
    mangled.startsWith("update_storage_") ||
    mangled.startsWith("extract_from_storage_") ||
    mangled.startsWith("write_to_storage_") ||
    mangled.startsWith("update_byte_slice_") ||
    mangled.startsWith("array_storage_")
  )
    return "storage";
  if (mangled.startsWith("allocate_") || mangled.startsWith("array_") || mangled.startsWith("memory_"))
    return "memory";
  if (
    mangled.startsWith("shift_") ||
    mangled.startsWith("checked_") ||
    mangled.startsWith("mod_") ||
    mangled.startsWith("zero_value_") ||
    mangled.startsWith("convert_") ||
    mangled.startsWith("identity")
  )
    return "math";
  return "util";
}

/**
 * Consume `<whitespace>"NAME"<whitespace>{` after the `object` keyword.
 * Returns the position just past the `{` and the (possibly updated)
 * line number, or `null` if the header doesn't parse cleanly.
 */
function consumeObjectHeader(
  source: string,
  start: number,
  startLine: number,
): { name: string; afterBraceIndex: number; line: number } | null {
  let i = start;
  let line = startLine;
  const n = source.length;

  while (i < n && /\s/.test(source[i])) {
    if (source[i] === "\n") line++;
    i++;
  }
  if (source[i] !== '"') return null;
  i++;
  const nameStart = i;
  while (i < n && source[i] !== '"' && source[i] !== "\n") i++;
  if (source[i] !== '"') return null;
  const name = source.slice(nameStart, i);
  i++;

  while (i < n && source[i] !== "{") {
    if (source[i] === "\n") line++;
    i++;
  }
  if (source[i] !== "{") return null;
  return { name, afterBraceIndex: i + 1, line };
}

/**
 * Consume `<whitespace>NAME(...)<whitespace>(-> ...)?<whitespace>{`
 * after the `function` keyword. The header may span multiple lines for
 * functions with long parameter / return lists. Returns the position
 * just past the `{`, the header's start line, and the body's start
 * line; or `null` if the header doesn't parse.
 */
function consumeFunctionHeader(
  source: string,
  start: number,
  startLine: number,
): { name: string; headerLine: number; afterBraceIndex: number; line: number } | null {
  let i = start;
  let line = startLine;
  const n = source.length;

  while (i < n && /\s/.test(source[i])) {
    if (source[i] === "\n") line++;
    i++;
  }
  if (i >= n || !isIdStart(source[i])) return null;
  const headerLine = line;
  const nameStart = i;
  i++;
  while (i < n && isIdCont(source[i])) i++;
  const name = source.slice(nameStart, i);

  while (i < n && /\s/.test(source[i])) {
    if (source[i] === "\n") line++;
    i++;
  }
  if (source[i] !== "(") return null;
  let parenDepth = 1;
  i++;
  while (i < n && parenDepth > 0) {
    if (source[i] === "(") parenDepth++;
    else if (source[i] === ")") parenDepth--;
    else if (source[i] === "\n") line++;
    i++;
  }
  if (parenDepth !== 0) return null;

  // Optional `-> ...` return list, then `{`.
  while (i < n && source[i] !== "{") {
    if (source[i] === "\n") line++;
    i++;
  }
  if (source[i] !== "{") return null;
  return { name, headerLine, afterBraceIndex: i + 1, line };
}

function isIdStart(ch: string): boolean {
  return (
    (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_" || ch === "$"
  );
}

function isIdCont(ch: string): boolean {
  return isIdStart(ch) || (ch >= "0" && ch <= "9") || ch === ".";
}
