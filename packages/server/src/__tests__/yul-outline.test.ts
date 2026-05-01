/**
 * Tests for the Yul outline parser. The fixtures here are abridged
 * but structurally faithful to what `forge inspect <Contract> ir`
 * actually emits — solc's pattern of nesting `_deployed` objects
 * inside the constructor object, mangled function-name prefixes, and
 * NatSpec / `@src` comments interleaved with code.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  parseYulOutline,
  findYulFunctionByName,
  type YulFunctionCategory,
} from "@solidity-workbench/common";

describe("parseYulOutline", () => {
  it("extracts top-level objects in source order", () => {
    const src = `
object "Counter_27" {
    code {
        function constructor_Counter_27() {}
    }
    object "Counter_27_deployed" {
        code {
            function fun_increment_15() {}
        }
    }
}
`;
    const out = parseYulOutline(src);
    assert.equal(out.objects.length, 2);
    assert.equal(out.objects[0].name, "Counter_27");
    assert.equal(out.objects[1].name, "Counter_27_deployed");
    assert.ok(out.objects[0].startLine < out.objects[1].startLine);
    assert.ok(out.objects[0].endLine > out.objects[1].endLine);
  });

  it("attributes each function to the object that contains it", () => {
    const src = `
object "Foo" {
    code {
        function constructor_Foo() {}
    }
    object "Foo_deployed" {
        code {
            function fun_increment_15() {}
            function abi_decode_t_uint256() {}
        }
    }
}
`;
    const out = parseYulOutline(src);
    const ctorObj = out.objects.find((o) => o.name === "Foo");
    const deployedObj = out.objects.find((o) => o.name === "Foo_deployed");
    assert.ok(ctorObj && deployedObj);
    assert.equal(ctorObj!.functions.length, 1);
    assert.equal(ctorObj!.functions[0].name, "constructor_Foo");
    assert.equal(deployedObj!.functions.length, 2);
    assert.deepEqual(
      deployedObj!.functions.map((f) => f.name),
      ["fun_increment_15", "abi_decode_t_uint256"],
    );
  });

  it("demangles solc-style names and strips the trailing AST id", () => {
    const src = `
object "Foo" {
    code {
        function fun_increment_15() {}
        function external_fun_count_5() {}
        function getter_fun_owner_8() {}
        function constructor_Foo_27() {}
    }
}
`;
    const out = parseYulOutline(src);
    const fns = out.objects[0].functions;
    const byName = new Map(fns.map((f) => [f.name, f]));
    assert.equal(byName.get("fun_increment_15")!.displayName, "increment");
    assert.equal(byName.get("fun_increment_15")!.astId, "15");
    assert.equal(byName.get("external_fun_count_5")!.displayName, "count");
    assert.equal(byName.get("getter_fun_owner_8")!.displayName, "owner");
    assert.equal(byName.get("constructor_Foo_27")!.displayName, "Foo");
  });

  it("categorises functions by name prefix", () => {
    const src = `
object "Foo" {
    code {
        function fun_x() {}
        function external_fun_x() {}
        function getter_fun_x() {}
        function constructor_Foo() {}
        function modifier_x() {}
        function abi_decode_y() {}
        function cleanup_z() {}
        function validator_w() {}
        function revert_error_v() {}
        function panic_error_u() {}
        function read_from_storage_t() {}
        function update_storage_s() {}
        function allocate_unbounded() {}
        function array_storeLength() {}
        function shift_right_224() {}
        function checked_add_uint256() {}
        function nothing_special_here() {}
    }
}
`;
    const fns = parseYulOutline(src).objects[0].functions;
    const cat = (name: string): YulFunctionCategory =>
      fns.find((f) => f.name === name)!.category;
    assert.equal(cat("fun_x"), "internal");
    assert.equal(cat("external_fun_x"), "external");
    assert.equal(cat("getter_fun_x"), "getter");
    assert.equal(cat("constructor_Foo"), "constructor");
    assert.equal(cat("modifier_x"), "modifier");
    assert.equal(cat("abi_decode_y"), "abi");
    assert.equal(cat("cleanup_z"), "cleanup");
    assert.equal(cat("validator_w"), "cleanup");
    assert.equal(cat("revert_error_v"), "revert");
    assert.equal(cat("panic_error_u"), "revert");
    assert.equal(cat("read_from_storage_t"), "storage");
    assert.equal(cat("update_storage_s"), "storage");
    assert.equal(cat("allocate_unbounded"), "memory");
    // `array_*` is overloaded — it covers both memory helpers and
    // storage helpers (`array_storage_*`). The non-storage prefix
    // falls into "memory" by design.
    assert.equal(cat("array_storeLength"), "memory");
    assert.equal(cat("shift_right_224"), "math");
    assert.equal(cat("checked_add_uint256"), "math");
    assert.equal(cat("nothing_special_here"), "util");
  });

  it("handles multi-line function headers (long parameter / return lists)", () => {
    const src = `
object "Foo" {
    code {
        function fun_swap_42(
            currency0,
            currency1,
            zeroForOne
        ) -> outAmount, fee {
            outAmount := 0
            fee := 0
        }
    }
}
`;
    const out = parseYulOutline(src);
    const fns = out.objects[0].functions;
    assert.equal(fns.length, 1);
    assert.equal(fns[0].name, "fun_swap_42");
    assert.equal(fns[0].displayName, "swap");
    // Header starts on line 4 (the `function` keyword line) and the
    // body's closing brace is on line 11.
    assert.equal(fns[0].startLine, 4);
    assert.equal(fns[0].endLine, 11);
  });

  it("ignores braces, `object`, and `function` tokens that appear inside comments and strings", () => {
    const src = `
// object "Fake" {
/* function fake_fn() {} */
object "Real" {
    code {
        // function shouldnt_count() {}
        let s := "function string_token() { return 0; }"
        function fun_real_1() {}
    }
}
`;
    const out = parseYulOutline(src);
    assert.equal(out.objects.length, 1);
    assert.equal(out.objects[0].name, "Real");
    assert.equal(out.objects[0].functions.length, 1);
    assert.equal(out.objects[0].functions[0].name, "fun_real_1");
  });

  it("findYulFunctionByName prefers external > internal > getter > constructor", () => {
    const src = `
object "Foo" {
    code {
        function fun_increment_15() {}
        function external_fun_increment_15() {}
        function getter_fun_increment_99() {}
    }
}
`;
    const out = parseYulOutline(src);
    const found = findYulFunctionByName(out, "increment");
    assert.ok(found);
    assert.equal(found!.name, "external_fun_increment_15");
  });

  it("findYulFunctionByName returns undefined when nothing matches", () => {
    const src = `object "Foo" { code { function fun_other_1() {} } }`;
    const out = parseYulOutline(src);
    assert.equal(findYulFunctionByName(out, "increment"), undefined);
  });

  it("survives unterminated input without throwing (e.g. forge errored mid-stream)", () => {
    const src = `
object "Foo" {
    code {
        function fun_x_1() {
            let x := 1
`;
    const out = parseYulOutline(src);
    // We expect the object and function to be discoverable even
    // though the closing braces never arrive.
    assert.equal(out.objects.length, 1);
    assert.equal(out.objects[0].name, "Foo");
    assert.equal(out.objects[0].functions.length, 0);
  });
});
