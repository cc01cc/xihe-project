import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { assertEnvValues, makeChildEnv } from "./env-values.mjs";

// BL-527 同类风险闸（task-56）：Node 对 env 的非 string 值会静默 String() 强转，
// `{X: {ok:true, password:"..."}}` ⇒ `"[object Object]"` 传给子进程。这组测试钉住「宁可抛错」。
describe("assertEnvValues：env 值必须是 string（BL-527 通道）", () => {
    test("①全 string ⇒ 通过，且原样返回", () => {
        const env = { PATH: "/usr/bin", XIHE_STACK_ID: "stack-1" };
        assert.equal(assertEnvValues(env, "t"), env);
    });

    test("②对象值 ⇒ TypeError，消息含 label/键名/类型", () => {
        assert.throws(
            () => assertEnvValues({ XIHE_DEV_ADMIN_PASSWORD: { ok: true, password: "x" } }, "spawn:cp"),
            (error) => {
                assert.ok(error instanceof TypeError);
                assert.match(error.message, /spawn:cp/);
                assert.match(error.message, /XIHE_DEV_ADMIN_PASSWORD/);
                assert.match(error.message, /object/);
                assert.match(error.message, /BL-527/);
                return true;
            },
        );
    });

    test("③数字值 ⇒ TypeError（含 toString 也不会用）", () => {
        assert.throws(() => assertEnvValues({ PORT: 12630 }, "t"), /PORT.*必须是 string.*number/s);
    });

    test("④undefined / null 值 ⇒ TypeError（env 里不该有）", () => {
        assert.throws(() => assertEnvValues({ A: undefined }, "t"), /A.*必须是 string.*undefined/s);
        assert.throws(() => assertEnvValues({ B: null }, "t"), /B.*必须是 string.*null/s);
    });

    test("⑤冻结对象再赋值 ⇒ 严格模式抛 TypeError（ESM 恒严格）", () => {
        const env = makeChildEnv({ stackId: "stack-1", env: { PATH: "/x" } });
        assert.equal(env.XIHE_STACK_ID, "stack-1");
        assert.equal(env.XIHE_ENV, "dev");
        assert.throws(() => {
            env.XIHE_DEV_ADMIN_PASSWORD = { ok: true };
        }, TypeError);
        assert.equal("XIHE_DEV_ADMIN_PASSWORD" in env, false, "冻结对象不得被写入");
    });

    test("⑥makeChildEnv 的 extra 也过闸（对象 ⇒ TypeError）", () => {
        assert.throws(
            () => makeChildEnv({ stackId: "stack-1", env: {}, extra: { XIHE_X: { a: 1 } } }),
            /makeChildEnv\(stackId=stack-1\).*XIHE_X/s,
        );
    });
});
