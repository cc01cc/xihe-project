/**
 * task-93：reader 的三态 + 假绿用例。
 *
 * <p>本文件钉住的是**判据本身**，不是实现细节：任何「自称通过但没跑东西」的 receipt
 * 都必须被读成 ERROR，而不是 PASS。</p>
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { CODES, createReceipt } from "./lib/gate-receipt.mjs";
import { summarizeReceipts } from "./gate-receipt-read.mjs";

const pass = (gate, executed, extra = {}) =>
    createReceipt({
        gate,
        verdict: "pass",
        code: CODES.OK,
        command: gate + " --run",
        durationMs: 12,
        executed,
        ...extra,
    });

test("全绿 ⇒ PASS / exit 0", () => {
    const sum = summarizeReceipts([
        pass("typecheck", { files: 1634 }),
        pass("oxfmt", { files: 1441 }),
        pass("vitest", { tests: 19, files: 2 }),
    ]);
    assert.equal(sum.verdict, "PASS");
    assert.equal(sum.exitCode, 0);
    assert.equal(sum.totals.pass, 3);
});

test("有一条真红 ⇒ FAIL / exit 1（不是 ERROR）", () => {
    const fail = createReceipt({
        gate: "vitest",
        verdict: "fail",
        code: CODES.E_GATE_FAILED,
        command: "vitest",
        durationMs: 9,
        executed: { tests: 3, files: 1 },
        reason: "退出码 1",
    });
    const sum = summarizeReceipts([pass("oxfmt", { files: 3 }), fail]);
    assert.equal(sum.verdict, "FAIL");
    assert.equal(sum.exitCode, 1);
});

test("**假绿** ⇒ ERROR / exit 2：自称 pass 但 executed.tests=0", () => {
    const sum = summarizeReceipts([pass("oxfmt", { files: 3 }), pass("vitest", { tests: 0, files: 0 })]);
    assert.equal(sum.verdict, "ERROR");
    assert.equal(sum.exitCode, 2);
    assert.equal(sum.problems[0].kind, "fake-green");
    // 读数里那句「0 个测试通过」必须被点名，不能只给一个总数
    assert.match(sum.problems[0].detail, /executed\.tests/);
});

test("假绿：executed 整格缺失（不是 0，是根本没有）同样判 ERROR", () => {
    const sum = summarizeReceipts([pass("typecheck", {})]);
    assert.equal(sum.verdict, "ERROR");
    assert.equal(sum.problems[0].kind, "fake-green");
});

test("**全部 skipped** ⇒ ERROR：一条都没真跑过不能被当成绿", () => {
    const skipped = (gate) =>
        createReceipt({
            gate,
            verdict: "skipped",
            code: CODES.E_SKIPPED,
            command: gate,
            durationMs: 0,
            executed: {},
            reason: "缺输入",
        });
    const sum = summarizeReceipts([skipped("typecheck"), skipped("vitest")]);
    assert.equal(sum.verdict, "ERROR");
    assert.equal(sum.nothingProven, true);
});

test("空目录（0 份 receipt）⇒ ERROR，不是 PASS", () => {
    const sum = summarizeReceipts([]);
    assert.equal(sum.verdict, "ERROR");
    assert.equal(sum.exitCode, 2);
});

test("schema 不合法的 receipt ⇒ ERROR（不能静默忽略当成没这条门）", () => {
    const broken = { ...pass("oxfmt", { files: 3 }) };
    delete broken.executed;
    const sum = summarizeReceipts([broken]);
    assert.equal(sum.verdict, "ERROR");
    assert.equal(sum.problems[0].kind, "schema");
});

test("真红 + 假绿同时存在 ⇒ ERROR 优先（结论取更坏的那个）", () => {
    const fail = createReceipt({
        gate: "vitest",
        verdict: "fail",
        code: CODES.E_GATE_FAILED,
        command: "vitest",
        durationMs: 1,
        executed: { tests: 0 },
        reason: "退出码 1",
    });
    const sum = summarizeReceipts([pass("typecheck", { files: 1 }), fail, pass("oxfmt", { files: 0 })]);
    assert.equal(sum.verdict, "ERROR");
});

test("六条门各一份 receipt 的典型情形 ⇒ PASS 且总数对得上", () => {
    const sum = summarizeReceipts([
        pass("typecheck", { files: 1634 }),
        pass("oxfmt", { files: 1441 }),
        pass("oxlint", { files: 1441 }),
        pass("vitest", { tests: 1514, files: 140 }),
        pass("mutate", { mutationLegs: 1 }),
        pass("i18n-scan", { files: 618 }),
    ]);
    assert.equal(sum.verdict, "PASS");
    assert.equal(sum.totals.total, 6);
    assert.equal(sum.totals.pass, 6);
});
