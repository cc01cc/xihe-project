#!/usr/bin/env node
// task-66: E2E 静态卫生门的**聚合执行器**。
//
// 为什么需要它：`lint:e2e` 原来用 `&&` 串两个门，于是**前一个门红 ⇒ 后一个门永远不执行**。
// 一个被旧红永久遮住的新门，比"开不了的门"更糟 —— 连"它开没开过"都没人知道（D-1074 同族：
// 开不了的门等于没有门）。这里改成：**每门都跑，各自报 exit，退出码按最严聚合**
// （2 环境/用法错误 > 1 判定失败 > 0 全绿）。红也要红得看得见全景，而不是只看得到第一个。
//
// 跑法：mise run lint:e2e（= 本执行器）
//       node scripts/run-e2e-static-gates.mjs        # 直接用
//       node scripts/run-e2e-static-gates.mjs --json # 机读
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** 门的登记表：新增静态卫生门时**只加一行**，不要回到 `&&` 串联。 */
export const GATES = [
    {
        name: "timeout-budget",
        script: "scripts/check-e2e-timeouts.mjs",
        summary: "E2E 超时预算（task-252）",
    },
    {
        name: "block-comments",
        script: "scripts/check-e2e-block-comments.mjs",
        summary: "块注释提前闭合（task-66）",
    },
    {
        // task-118 ②：夹具失败诊断必须「红点指向真因」——未知 id 分支登记原因、收集器取回并拼进
        // `>=400` 条目、三通道合并成一次断言（D-1475）。全部 fail-closed：判据被搬走 ⇒ 红（D-1470）。
        name: "fixture-diagnostics",
        script: "scripts/check-e2e-fixture-diagnostics.mjs",
        summary: "夹具失败诊断可读性（task-118）",
    },
];

/** 聚合规则：环境/用法错误压过判定失败，判定失败压过全绿。 */
export function aggregateExit(exitCodes) {
    if (exitCodes.some((code) => code === 2)) return 2;
    if (exitCodes.some((code) => code === 1)) return 1;
    return 0;
}

function runGate(gate) {
    const started = Date.now();
    const result = spawnSync(process.execPath, [path.join(ROOT, gate.script)], {
        stdio: "inherit",
    });
    const elapsedMs = Date.now() - started;
    // spawnSync 自身失败（找不到 node / 脚本路径错）时 status 为 null ⇒ 按环境错误 2 处理，
    // 不让它冒充「0 通过」。
    const exit = result.error ? 2 : (result.status ?? 2);
    return { name: gate.name, script: gate.script, exit, elapsedMs, error: result.error?.message };
}

function main(argv) {
    const asJson = argv.includes("--json");
    const results = [];
    for (const gate of GATES) results.push(runGate(gate));
    const aggregate = aggregateExit(results.map((row) => row.exit));

    if (asJson) {
        console.log(JSON.stringify({ gates: results, aggregate }, null, 2));
    } else {
        console.log("");
        console.log(`[e2e-static-gates] executed ${results.length}/${GATES.length} gates:`);
        for (const [index, row] of results.entries()) {
            const gate = GATES[index];
            const verdict = row.exit === 0 ? "OK" : row.exit === 1 ? "FAIL" : "ENV";
            console.log(
                `  ${index + 1}. ${row.name.padEnd(20)} exit=${row.exit} (${verdict}) ${row.elapsedMs}ms  — ${gate.summary}`,
            );
            if (row.error) console.log(`     spawn error: ${row.error}`);
        }
        const failing = results.filter((row) => row.exit !== 0).map((row) => row.name);
        console.log(
            `[e2e-static-gates] aggregate exit=${aggregate}` +
                (failing.length ? ` (failing: ${failing.join(", ")})` : " (all gates green)"),
        );
    }
    return aggregate;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exit(main(process.argv.slice(2)));
}
