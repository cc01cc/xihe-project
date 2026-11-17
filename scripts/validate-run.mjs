#!/usr/bin/env node
// task-176（方案甲，Lead 2026-11-18 裁）：validate 的**聚合执行器**——门段 keep-going 并行 → test 串行末段。
//
// 为什么需要它（根因实证，one/.tmp/task176-ABORT.log）：旧 validate 把 test 与 lint/typecheck/build
// 一起挂 depends，mise depends **并行、首个失败即中止**。实测无 -c 的 `mise run validate` 在 **5.4 s**
// 就被一个快静态红（check:api-docs inventory 漂移）掐死，test:ui / test:cp / build:runtime / typecheck:ui
// **零执行**——600 s 的 UI 单测和文案门永远轮不到跑。这正是「门是绿的但没在守」：一个被快红永久遮住的
// 慢门，比开不了的门更糟（D-1074 同族）。串行末段 alone 也不治：保留首红 abort，test 恒末段反而**保证**
// 被任何门红掐掉。故门段必须 keep-going。
//
// 怎么治（复用成熟机制，不自造调度器）：
//   ① 门段：`mise run -c <12 门>`——mise 自己的 --continue-on-error 恒跑完所有门、jobs=4 控并发、
//      逐门报退出（mise 尾部「N task(s) failed: [task] exited with status X」）。
//   ② test 末段：门段全跑完后 `mise run -c test`——test 不再与门并行，门红不再掐 test，test 红也不掩门。
//   ③ overall exit = 任一門红即非 0（2 环境/用法 > 1 判定失败 > 0 全绿，同 run-e2e-static-gates.mjs）。
// 本脚本只做「相位排序 + keep-going 兜底 + 汇总」，并行/keep-going/逐门退出全部委托 mise（乙方案靠人记
// -c 被否决：那是「门没人跑等于没有门」的同型陷阱）。5 个共享树既有恒红门会如实显示为红（归他卡），
// validate 从此诚实：恒跑完、报全景。
//
// 跑法：mise run validate（= 本执行器，无需用户记 -c）
//       node scripts/validate-run.mjs         # 直接用
//       node scripts/validate-run.mjs --json  # 机读（捕获 mise 输出解析逐门退出）
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** 门段登记表（镜像旧 validate.depends 去掉 test；新增门**只加一行**）。test 单独走末段。 */
export const GATES = [
    "check:mise-env",
    "check:openapi",
    "check:openapi:lint",
    "check:api-docs",
    "check:plan-anchors",
    "check:runtime:ignored",
    "check:commit-msg",
    "lint",
    "typecheck",
    "build",
    "test:e2e:fixtures",
    "lint:links",
];

/** 聚合规则：环境/用法错误压过判定失败，判定失败压过全绿（同 run-e2e-static-gates.mjs）。 */
export function aggregateExit(exitCodes) {
    if (exitCodes.some((code) => code === 2)) return 2;
    if (exitCodes.some((code) => code === 1)) return 1;
    return 0;
}

function runPhase(args, asJson) {
    const started = Date.now();
    const result = spawnSync("mise", args, {
        cwd: ROOT,
        stdio: asJson ? ["ignore", "pipe", "pipe"] : "inherit",
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
    });
    const elapsedMs = Date.now() - started;
    // spawnSync 自身失败（找不到 mise）⇒ status null ⇒ 按环境错误 2，不冒充 0 通过。
    const exit = result.error ? 2 : (result.status ?? 2);
    const output = asJson ? (result.stdout ?? "") + (result.stderr ?? "") : "";
    return { exit, elapsedMs, output, error: result.error?.message };
}

/** 从 mise -c 输出解析逐门退出：失败行「[task] exited with status N」；未出现的门 = 跑过且绿（0）。 */
export function parseTaskExits(output, tasks) {
    const failed = {};
    for (const line of output.split(/\r?\n/)) {
        const m = line.match(/^\[([^\]]+)\] exited with status (\d+)/);
        if (m) failed[m[1]] = Number(m[2]);
    }
    return tasks.map((name) => ({ name, exit: failed[name] ?? 0 }));
}

function main(argv) {
    const asJson = argv.includes("--json");
    // mise 的多任务分隔符是 `:::` —— 空格分隔会被当成「第一个 task + 其余作为它的参数」（实测 2026-11-18：
    // `mise run a b c` 只跑 a 并把 b/c 当 argv；必须 `a ::: b ::: c`）。这一步写错会令门段只跑 check:mise-env 就结束。
    const gateArgs = ["run", "-c", "-o", "prefix", ...GATES.flatMap((g, i) => (i === 0 ? [g] : [":::", g]))];
    const testArgs = ["run", "-c", "-o", "prefix", "test"];

    const gates = runPhase(gateArgs, asJson);
    const test = runPhase(testArgs, asJson);
    const overall = aggregateExit([gates.exit, test.exit]);

    if (asJson) {
        const gateRows = parseTaskExits(gates.output, GATES);
        console.log(
            JSON.stringify(
                {
                    gates: { exit: gates.exit, elapsedMs: gates.elapsedMs, tasks: gateRows },
                    test: { exit: test.exit, elapsedMs: test.elapsedMs },
                    overall,
                },
                null,
                2,
            ),
        );
    } else {
        console.log("");
        console.log("[validate] 门段 keep-going 并行 → test 串行末段（task-176 甲）：");
        console.log(`  门段（${GATES.length} 门）exit=${gates.exit}  ${(gates.elapsedMs / 1000).toFixed(1)}s`);
        console.log(`  test 末段          exit=${test.exit}  ${(test.elapsedMs / 1000).toFixed(1)}s`);
        if (gates.error) console.log(`  门段 spawn error: ${gates.error}`);
        if (test.error) console.log(`  test spawn error: ${test.error}`);
        console.log(
            `[validate] overall exit=${overall}` +
                (overall === 0 ? " (all green)" : " (有红门——上方 mise 已逐门点名；恒跑完不再 5s abort)"),
        );
    }
    process.exit(overall);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exit(main(process.argv.slice(2)));
}
