#!/usr/bin/env node
/**
 * check:ui-copy —— UI 文案判据快档（task-172，来源 task-101 判定 (b)）。
 *
 * 把 packages/ui 的 i18n 判据簇（terminology / locale / settingsCopyRules / usageCopyRules，
 * 4 文件 42 例，实测 ~4.75 s）从 604 s 全量单测里拆出来高频执行。这些是「判产品不变量」的
 * 文案判据（术语主名词 / 层名 SSOT / locale 解析 / 文案规则），不是行为型组件单测 ⇒ 适合快档。
 *
 * 为什么是薄包装而不是直接 vitest：vitest 没有 --report-only。新门按纪律先「只报不阻断」
 * 试运行一档（默认 --report-only：有失败也 exit 0，只打印），:enforce 兄弟任务才阻断。
 * **禁 || true**：那会把 vitest 自身崩溃也吞成绿。这里区分三态：
 *   0  跑完且全过；或 report-only 下有失败但只报
 *   1  --enforce 且有测试失败
 *   2  判不了：vitest 没跑起来 / 崩溃 / 被杀 / 无汇总行 —— 绝不装绿（即使 report-only）
 *
 * 用法
 *   node scripts/check-ui-copy.mjs                # report-only（默认）
 *   node scripts/check-ui-copy.mjs --enforce      # 阻断（手工 / :enforce 任务）
 *   node scripts/check-ui-copy.mjs --selftest     # 决策逻辑夹具（6 例）+ 一次真跑冒烟
 *
 * 转阻断判据（照 check:a11y-refs 形态）：连续两个窗口 findings=0 才提 :enforce 接线。
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_ROOT = resolve(HERE, "../packages/ui");
const VITEST = resolve(UI_ROOT, "node_modules/vitest/vitest.mjs");
const TARGETS = ["src/i18n/__tests__/"];

/**
 * 纯决策：把 vitest 进程结果映射成门的退出码。selftest 直接打这个函数（不起真 vitest）。
 * ran=false 一律 exit 2（判不了），与 enforce 无关 —— 崩溃不许装绿。
 */
export function classify(result, enforce) {
    const { spawnError, status, output } = result;
    if (spawnError) return { exit: 2, ran: false, failed: false, reason: "vitest spawn failed: " + spawnError };
    if (status === null || status === undefined) return { exit: 2, ran: false, failed: false, reason: "vitest killed (no exit status)" };
    const ran = /Test Files\s+\d/.test(output) && /Tests\s+\d/.test(output);
    if (!ran) return { exit: 2, ran: false, failed: false, reason: "no vitest summary (crash before/at run)" };
    const failed = /Tests\s+[^\n]*?(\d+) failed/.test(output);
    if (!failed) return { exit: 0, ran: true, failed: false, reason: "clean" };
    return { exit: enforce ? 1 : 0, ran: true, failed: true, reason: "test failures" };
}

function runVitest() {
    const res = spawnSync(process.execPath, [VITEST, "run", ...TARGETS], {
        cwd: UI_ROOT,
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, CI: "1" },
        maxBuffer: 64 * 1024 * 1024,
    });
    return {
        spawnError: res.error ? String(res.error.message ?? res.error) : null,
        status: res.status,
        output: (res.stdout ?? "") + (res.stderr ?? ""),
    };
}

function selftest() {
    const cases = [];
    const check = (name, ok, detail = "") => {
        cases.push(ok);
        console.log("  [" + (ok ? "PASS" : "FAIL") + "] " + name + (detail ? " — " + detail : ""));
    };
    const cleanOut = " Test Files  4 passed (4)\n      Tests  42 passed (42)\n";
    const failOut = " Test Files  1 failed | 3 passed (4)\n      Tests  1 failed | 41 passed (42)\n";
    check("spawn 失败 ⇒ exit 2（两态都不装绿）", classify({ spawnError: "ENOENT", status: null, output: "" }, false).exit === 2 && classify({ spawnError: "ENOENT", status: null, output: "" }, true).exit === 2);
    check("被杀（status null）⇒ exit 2", classify({ spawnError: null, status: null, output: cleanOut }, true).exit === 2);
    check("非零但无汇总行（崩溃）⇒ exit 2", classify({ spawnError: null, status: 1, output: "SyntaxError: boom" }, false).exit === 2);
    check("跑完全过 ⇒ exit 0 / ran", classify({ spawnError: null, status: 0, output: cleanOut }, true).exit === 0 && classify({ spawnError: null, status: 0, output: cleanOut }, true).ran === true);
    check("有失败：report-only ⇒ 0，enforce ⇒ 1", classify({ spawnError: null, status: 1, output: failOut }, false).exit === 0 && classify({ spawnError: null, status: 1, output: failOut }, true).exit === 1);
    check("有失败时 failed=true（供打印分支）", classify({ spawnError: null, status: 1, output: failOut }, false).failed === true);

    // 真跑冒烟：只断言 vitest 确实跑起来（ran），不耦合产品文案是否全绿。
    const real = runVitest();
    const verdict = classify(real, false);
    check("真跑冒烟：vitest 起得来且有汇总行", verdict.ran === true, "exit=" + verdict.exit + " failed=" + verdict.failed);

    const passed = cases.filter(Boolean).length;
    console.log("check-ui-copy selftest: " + passed + "/" + cases.length + " passed");
    if (passed !== cases.length) process.exit(1);
}

function main() {
    const args = new Set(process.argv.slice(2));
    if (args.has("--selftest")) {
        selftest();
        return;
    }
    const enforce = args.has("--enforce");
    const mode = enforce ? "enforce" : "report-only";
    const result = runVitest();
    const verdict = classify(result, enforce);
    if (!verdict.ran) {
        console.error("[check:ui-copy] mode=" + mode + " CANNOT ANSWER (exit 2): " + verdict.reason);
        process.exit(2);
    }
    if (verdict.failed) {
        console.error("[check:ui-copy] mode=" + mode + " 文案判据有失败" + (enforce ? "（阻断）" : "（只报不阻断；转阻断见 check:ui-copy:enforce）"));
        const summary = result.output.split("\n").filter((l) => /FAIL|Test Files|Tests |×/.test(l)).slice(0, 40);
        console.error(summary.join("\n"));
        process.exit(verdict.exit);
    }
    console.log("[check:ui-copy] mode=" + mode + " clean（i18n 判据簇 4 文件全过）");
    process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    main();
}
