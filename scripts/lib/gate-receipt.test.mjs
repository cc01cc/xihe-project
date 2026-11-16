/**
 * task-93：门禁结论契约的用例。
 *
 * <p>解析器全部用**真实抓下来的输出**做夹具（不是编的），否则「解析器能跑」和
 * 「解析器能读真输出」是两件事。</p>
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
    CODES,
    GATES,
    SCHEMA_VERSION,
    VERDICTS,
    assertBareCommand,
    createReceipt,
    isFakeGreen,
    parseI18nScan,
    parseMutate,
    parseOxfmt,
    parseOxlint,
    parseTypecheck,
    parseVitest,
    receiptFromRun,
    validateReceipt,
} from "./gate-receipt.mjs";

/* ── 真实输出夹具（2026-11-16 实跑抓取） ── */

const OUT_OXFMT_OK = "\nAll matched files use the correct format.\nFinished in 45ms on 8 files using 32 threads.\n";
const OUT_OXLINT = "Found 0 warnings and 0 errors.\nFinished in 150ms on 1 file with 220 rules using 32 threads.\n";
const OUT_VITEST = " Test Files  2 passed (2)\n      Tests  19 passed (19)\n   Duration  1.2s\n";
const OUT_VITEST_FAIL = " Test Files  1 failed | 1 passed (2)\n      Tests  1 failed | 18 passed (19)\n";
const OUT_MUTATE = [
    "MATCH_COUNT=1",
    "BASELINE_EXIT=0",
    "MUTATION_APPLIED=yes",
    "MUTATED_EXIT=1",
    "VERDICT=gate-catches",
].join("\n");
const OUT_I18N = JSON.stringify({
    schema: 1,
    ok: false,
    counts: { sourceFiles: 618, keyLiterals: 3711, uniqueKeys: 3258 },
    findings: [{ kind: "unresolved-t" }, { kind: "unresolved-key" }],
});
/** task-2 拍图前置门的真实输出形状（stdout = 自己的 receipt JSON）。 */
const OUT_PREFLIGHT_RECEIPT = JSON.stringify({
    schemaVersion: 1,
    gate: "screenshot-preflight",
    verdict: "pass",
    code: "OK",
    numbers: { stack: "stack-2", treeVerdict: "equal", behind: 0, servicesReady: 4, dirtyCount: 23 },
    command: "node scripts/gate-screenshot-preflight.mjs --stack stack-2 --pages WorkspaceView.vue",
    durationMs: 4210,
    executed: { checks: 4, servicesProbed: 4, pagesChecked: 1 },
    reason: null,
    at: "2026-11-16T11:41:02.000Z",
});

const OUT_TSC_LISTFILES = [
    "H:/x/node_modules/typescript/lib/lib.es5.d.ts",
    "H:/x/packages/ui/src/a.ts",
    "H:/x/packages/ui/src/b.vue",
].join("\n");

test("oxfmt：成功态能读出匹配文件数", () => {
    const r = parseOxfmt(OUT_OXFMT_OK);
    assert.equal(r.parsed, true);
    assert.equal(r.executed.files, 8);
    assert.equal(r.numbers.unformatted, 0);
});

test("oxlint：能读出 warnings/errors/文件数", () => {
    const r = parseOxlint(OUT_OXLINT);
    assert.equal(r.parsed, true);
    assert.deepEqual({ w: r.numbers.warnings, e: r.numbers.errors }, { w: 0, e: 0 });
    assert.equal(r.executed.files, 1);
});

test("vitest：pass 与 fail 都能读出计数（且 tests 含 failed 才叫执行量）", () => {
    const ok = parseVitest(OUT_VITEST);
    assert.equal(ok.executed.tests, 19);
    assert.equal(ok.numbers.testsPassed, 19);

    const bad = parseVitest(OUT_VITEST_FAIL);
    assert.equal(bad.numbers.testsFailed, 1);
    // 执行量 = passed + failed + skipped，不是「只数通过的」——
    // 只数通过的话，全失败的一次运行会得出 executed=0，反被当成假绿。
    assert.equal(bad.executed.tests, 19);
});

test("typecheck：--listFiles 输出能给出被检查文件数", () => {
    const r = parseTypecheck(OUT_TSC_LISTFILES);
    assert.equal(r.parsed, true);
    assert.equal(r.executed.files, 3);
    assert.equal(r.numbers.errors, 0);
});

test("typecheck：**不给 --listFiles 时成功态无计数 ⇒ 判不可解析**（这是必须改命令形态的理由）", () => {
    const r = parseTypecheck("");
    assert.equal(r.parsed, false);
    assert.equal(r.executed.files, null);
});

test("mutate：能读出 matchCount 与 verdict，并按两次退出码判定是否真跑过", () => {
    const r = parseMutate(OUT_MUTATE);
    assert.equal(r.parsed, true);
    assert.equal(r.numbers.verdict, "gate-catches");
    assert.equal(r.executed.mutationLegs, 1);
});

test("mutate：没有 VERDICT ⇒ 不可解析（不许把空输出当跑过）", () => {
    assert.equal(parseMutate("").parsed, false);
});

test("i18n-scan：执行量取 counts.sourceFiles，findings 是结果不是执行量", () => {
    const r = parseI18nScan(OUT_I18N);
    assert.equal(r.executed.files, 618);
    assert.equal(r.numbers.findings, 2);
});

test("i18n-scan：坏 JSON ⇒ 不可解析", () => {
    assert.equal(parseI18nScan("not json").parsed, false);
});

/* ── D-1736：参数形态的检查点在被调用方 ── */

test("assertBareCommand：环境变量前缀必须被拒，并给可判码", () => {
    const bad = assertBareCommand("FOO=1 pnpm exec vitest run");
    assert.equal(bad.ok, false);
    assert.equal(bad.code, CODES.E_CMD_NOT_BARE);
});

test("assertBareCommand：env 前缀同样被拒", () => {
    const bad = assertBareCommand("env FOO=1 pnpm test");
    assert.equal(bad.ok, false);
    assert.equal(bad.code, CODES.E_CMD_NOT_BARE);
});

test("assertBareCommand：裸命令放行", () => {
    for (const cmd of ["pnpm exec vitest run src", "node scripts/x.mjs", "pnpm test"]) {
        const r = assertBareCommand(cmd);
        assert.equal(r.ok, true, cmd + " 应放行");
        assert.equal(r.code, CODES.OK);
    }
});

test("assertBareCommand：空串属用法错，不是「非裸」", () => {
    assert.equal(assertBareCommand("").code, CODES.E_USAGE);
});

/* ── 假绿：本契约的核心防线 ── */

test("假绿：executed.tests=0 而 verdict=pass ⇒ 必须被判出来", () => {
    const r = createReceipt({
        gate: "vitest",
        verdict: "pass",
        code: CODES.OK,
        command: "pnpm exec vitest run",
        durationMs: 10,
        executed: { tests: 0, files: 0 },
    });
    assert.equal(isFakeGreen(r), true);
});

test("假绿：executed 里那格是 null ⇒ 同样算假绿（不是「未知可以放过」）", () => {
    const r = createReceipt({
        gate: "typecheck",
        verdict: "pass",
        code: CODES.OK,
        command: "vue-tsc",
        durationMs: 10,
        executed: { files: null },
    });
    assert.equal(isFakeGreen(r), true);
});

test("真绿不被误判：executed 有正数就不算假绿", () => {
    const r = createReceipt({
        gate: "oxfmt",
        verdict: "pass",
        code: CODES.OK,
        command: "oxfmt --check .",
        durationMs: 10,
        executed: { files: 8 },
    });
    assert.equal(isFakeGreen(r), false);
});

test("fail 态不是假绿（红就是红，不需要 executed 自证）", () => {
    const r = createReceipt({
        gate: "vitest",
        verdict: "fail",
        code: CODES.E_GATE_FAILED,
        command: "x",
        durationMs: 1,
        executed: { tests: 0 },
        reason: "退出码 1",
    });
    assert.equal(isFakeGreen(r), false);
});

/* ── receipt 结构与四态 ── */

test("四态齐全，且 receipt 带 schemaVersion", () => {
    assert.deepEqual([...VERDICTS], ["pass", "fail", "error", "skipped"]);
    const r = createReceipt({
        gate: "vitest",
        verdict: "pass",
        code: CODES.OK,
        command: "c",
        durationMs: 1,
        executed: { tests: 1 },
    });
    assert.equal(r.schemaVersion, SCHEMA_VERSION);
    assert.equal(validateReceipt(r).ok, true);
});

test("校验：skipped / error 必须带 reason", () => {
    const skipped = createReceipt({ gate: "vitest", verdict: "skipped", code: CODES.E_SKIPPED, command: "c", durationMs: 1, executed: {} });
    assert.equal(validateReceipt(skipped).ok, false);
    const errored = createReceipt({ gate: "vitest", verdict: "error", code: CODES.E_UNPARSABLE, command: "c", durationMs: 1, executed: {} });
    assert.equal(validateReceipt(errored).ok, false);
});

test("校验：executed 缺失 ⇒ 不合法（本契约的核心字段）", () => {
    const r = createReceipt({ gate: "oxfmt", verdict: "pass", code: CODES.OK, command: "c", durationMs: 1, executed: { files: 1 } });
    delete r.executed;
    assert.equal(validateReceipt(r).ok, false);
});

test("校验：过期 receipt 被拒（拿旧树结论判新树是本卡要防的另一类假绿）", () => {
    const r = createReceipt({
        gate: "oxfmt",
        verdict: "pass",
        code: CODES.OK,
        command: "c",
        durationMs: 1,
        executed: { files: 1 },
        at: new Date(Date.now() - 60_000).toISOString(),
    });
    assert.equal(validateReceipt(r, { maxAgeMs: 1000 }).ok, false);
});

test("receiptFromRun：退出非 0 且能解析 ⇒ fail，不是 error", () => {
    const r = receiptFromRun({
        gate: "vitest",
        stdout: OUT_VITEST_FAIL,
        exitCode: 1,
        durationMs: 5,
        command: "vitest",
    });
    assert.equal(r.verdict, "fail");
    assert.equal(r.code, CODES.E_GATE_FAILED);
});

test("receiptFromRun：解析不出 ⇒ error（无法判定不许当绿）", () => {
    const r = receiptFromRun({ gate: "vitest", stdout: "", exitCode: 0, durationMs: 5, command: "vitest" });
    assert.equal(r.verdict, "error");
    assert.equal(r.code, CODES.E_UNPARSABLE);
});

test("receiptFromRun：未知门 ⇒ error/E_USAGE", () => {
    const r = receiptFromRun({ gate: "nope", stdout: "", exitCode: 0, durationMs: 1, command: "x" });
    assert.equal(r.code, CODES.E_USAGE);
});

test("门表里每条门都声明了 counter，且 counter 在该门 executed 里出现过", () => {
    const samples = {
        typecheck: OUT_TSC_LISTFILES,
        oxfmt: OUT_OXFMT_OK,
        oxlint: OUT_OXLINT,
        vitest: OUT_VITEST,
        mutate: OUT_MUTATE,
        "i18n-scan": OUT_I18N,
        // task-2：本门 stdout 就是自己的 receipt ⇒ 夹具用**真跑出来的 receipt**（2026-11-16 19:3x 抓取形状）。
        "screenshot-preflight": OUT_PREFLIGHT_RECEIPT,
    };
    for (const [gate, spec] of Object.entries(GATES)) {
        assert.ok(spec.counter, gate + " 未声明 counter");
        const parsed = spec.parse(samples[gate]);
        assert.ok(spec.counter in parsed.executed, gate + " 的 executed 里没有 " + spec.counter);
        assert.ok(parsed.executed[spec.counter] > 0, gate + " 的 " + spec.counter + " 应为正数");
    }
});
