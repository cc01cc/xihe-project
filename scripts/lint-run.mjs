#!/usr/bin/env node
// task-33（Lead 2026-11-18 裁）：mise lint 的 keep-going 聚合执行器 —— **免窗预备件**。
// 方案档：one/internal/A03-xihe/evidence/2026-11-18-mise-lint-keepgoing/README.md §4.2。
//
// 为什么需要它（实测，非推测）：mise 的并行 depends **首个失败即中止**。现行 mise run lint
// 在 30 门里只起 12 门、只完成 5 门、**18 门从未开始**，墙钟 3.25 s 自杀；中止时 mise 还会
// 打出「process could not be terminated」把在跑的门连带杀。被跳过的 18 门含 check:types
// （A03-xihe/AGENTS.md 明文「每个 verify 窗必跑」）、check:commit-msg、check:trace、
// check:md-tables、check:ports —— 而 mise 只报「N 个 task failed」，**不报「我跳过了哪些」**。
// 这正是 D-1457-S1「被并行 depends 首个失败掐掉」与 D-1074「门是绿的但没在守」同族。
//
// 怎么治（复用成熟机制，**零复制**，不自造第二套聚合语义）：
//   ① 委托 mise 自己的 --continue-on-error（-c）恒跑完所有门、jobs=4 控并发、逐门报退出；
//   ② 退出码聚合与逐门退出解析**直接 import validate-run.mjs 的 aggregateExit / parseTaskExits**
//      （task-176 已实装并在产线跑），不在本文件重写 2 > 1 > 0；
//   ③ 多任务分隔符必须 ::: （写空格会被当成「第一个 task + 其余作参数」⇒ 只跑首门就结束，
//      坑同 validate-run.mjs:79-80）。
//
// 接线状态（重要）：**本文件当前无人引用** —— mise.toml 一字节未改（改 [tasks.lint] 的
// depends/run 属 T2 窗口类，见方案档 §4.1）。落地顺序按 l2-window-protocol §22.2 表 C
// 「工具脚本本身可直提，但它的接入点（mise/.github）属表 B ⇒ 拆成两条提交」：
//   本卡（task-33，免窗）＝ 只落这个 runner；
//   task-30（W2 窗内）＝ 把 [tasks.lint] 的 depends 整行换成 run = "node scripts/lint-run.mjs"。
// ⇒ 本文件此刻是**零行为变化**的：没有任何入口调用它，改动不影响现行 mise run lint。
//
// 跑法：node scripts/lint-run.mjs                # 跑全 30 门（keep-going）+ 逐门 PASS/FAIL 表
//       node scripts/lint-run.mjs --selftest     # 纯函数自检（不碰真实门）
//       node scripts/lint-run.mjs --list         # 只打印门清单（供与 mise.toml depends 对账）
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 零复制复用：validate-run.mjs 的聚合口径与逐门退出解析（:46 / :68，均已 export）。
import { aggregateExit, parseTaskExits } from "./validate-run.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * 门清单**数据**（31 个成员；顺序无执行语义）。task-124 起本清单是 lint 的**唯一**门集合来源
 * （[tasks.lint] 已改为 run 本文件），不再与 mise.toml depends 对账。
 * 新增门只加一行 —— 与 validate-run.mjs 的 GATES 同惯例。
 * ⚠️ 有产物依赖的门**不得**加进来（方案档 §6 反例保护）：
 *   check:api-docs（消费 gen:api-docs 产物，先写后查）、check:mock-baseline（需新鲜报告）。
 */
export const LINT_GATES = [
    "lint:ui",
    "lint:agent",
    "lint:cp",
    "lint:runtime",
    "lint:log-secrets",
    "lint:i18n",
    "lint:scripts",
    "check:config-schema",
    "lint:e2e",
    "check:lint-warnings",
    "check:ui-copy",
    "check:i18n-fixture-copies",
    "check:dev-i18n-drift",
    "check:md-tables",
    "check:ports",
    "check:migrations",
    "check:bl-count",
    "check:bl-decision-ref",
    "check:docs-index",
    "check:md-emphasis",
    "check:terms",
    "check:types",
    "check:internal-scripts",
    "check:root-residue",
    "check:commit-msg",
    "check:plan-anchors",
    "check:fixtures",
    "check:event-keys",
    "check:a11y-refs",
    "check:trace",
    "check:decision-test-map",
];

/**
 * 组装 mise 参数。空清单 ⇒ null（调用方按用法错误 exit 2，**绝不返回绿**）。
 * ::: 与 -c 都是必需的：少了 -c 就回到首红中止，少了 ::: 就只跑第一门。
 */
export function buildMiseArgs(gates) {
    if (!Array.isArray(gates) || gates.length === 0) return null;
    return ["run", "-c", "-o", "prefix", ...gates.flatMap((g, i) => (i === 0 ? [g] : [":::", g]))];
}

/**
 * 子 mise 的环境：必须显式把计时打开（task-52 的修法本体）。
 * 实测单变量（同一条 `mise run -c -o prefix check:ports`，2026-11-19 05:0x 本机）：
 *   MISE_TASK_TIMINGS 未设 ⇒ 1 行 Finished in ｜ =1 ⇒ 1 行 ｜ =true ⇒ 1 行 ｜ =0 ⇒ **0 行**（整条计时消失，退出码不受影响）。
 * 而外层 `mise run lint` 给 task 子进程注入的正是 MISE_TASK_TIMINGS=0（直跑时该键根本不存在，
 * 嵌套时 env 里多出 9 个 MISE_* 键，这是唯一影响计时的一个）⇒ 「B 档只报 1/30」不是解析问题，是**上游按设计关掉了**，
 * 所以修在这里：调用方自己声明要计时，不指望上游默认值。
 */
export function childEnv(base = process.env) {
    return { ...base, MISE_TASK_TIMINGS: "1" };
}

/**
 * 逐门耗时（本文件新增，不是复制）：mise 的 -o prefix 会把每个 task 自己的
 * 「Finished in Xms / X.XXs」加上 [task] 前缀。上报率是既成事实（现行 28/30 上报），
 * 不上报不等于红 —— 表里以 exit 码为准；缺失分两种写法见 formatTable（未上报 / 无计时）。
 */
export function parseTaskTimings(output) {
    const ms = {};
    for (const line of output.split(/\r?\n/)) {
        const m = line.match(/^\[([^\]]+)\] Finished in ([0-9.]+)(ms|s)/);
        if (!m) continue;
        const v = Number(m[2]) * (m[3] === "s" ? 1000 : 1);
        if (ms[m[1]] === undefined || v > ms[m[1]]) ms[m[1]] = v;
    }
    return ms;
}

/** 逐门 PASS/FAIL 表（全量可见，不是只给聚合码）。 */
export function formatTable(rows, timings, gates, elapsedMs) {
    const lines = [];
    lines.push("════════ lint-gates 汇总（共 " + gates.length + " 门，keep-going，全部执行）════════");
    let reported = 0;
    // 「没报」和「测不到」是两件事，必须写成两个不同的词（同 task-58 的 skip ≠ 0 命中）：
    // 整通道一行 Finished in 都没有 ⇒ 上游把计时关了（测不到）；有行但这门缺 ⇒ 这门自己没报。
    // 两者都写光杆「—」就等于让读表的人替我们猜，历史事故是拿猜的结果当验收依据。
    const available = Object.keys(timings).length > 0;
    for (const row of rows) {
        const t = timings[row.name];
        if (t !== undefined) reported += 1;
        const cost = t !== undefined
            ? (t >= 1000 ? (t / 1000).toFixed(1) + "s" : Math.round(t) + "ms")
            : available ? "未上报" : "无计时";
        lines.push("  " + (row.exit === 0 ? "PASS" : "FAIL") + "  " + row.name.padEnd(26) + " exit=" + row.exit + "  " + cost);
    }
    lines.push(
        "  墙钟 " + (elapsedMs / 1000).toFixed(1) + "s ｜ 上报计时 " + reported + "/" + gates.length + " 门" +
        (available ? "" : " ⇒ **测不到**：子 mise 一行 Finished in 都没产（已按 task-52 强制 MISE_TASK_TIMINGS=1，仍无 ⇒ 上游行为又变了，别把这轮当「没有慢门」读）"),
    );
    return { text: lines.join("\n"), reported, available };
}

function runSelftest() {
    let fail = 0;
    const check = (ok, label, detail) => {
        console.log((ok ? "PASS  " : "FAIL  ") + label + (detail ? "  [" + detail + "]" : ""));
        if (!ok) fail += 1;
    };

    // ① 空清单不是绿：buildMiseArgs ⇒ null，执行侧 exit 2
    check(buildMiseArgs([]) === null, "空清单 ⇒ 不产出可执行参数");
    check(buildMiseArgs(undefined) === null, "缺清单 ⇒ 不产出可执行参数");

    // ② keep-going 的形态必须在参数里（少了 -c 就退回首红中止）
    const args = buildMiseArgs(["a", "b", "c"]);
    check(args.includes("-c"), "参数含 -c（continue-on-error）", args.join(" "));
    check(args.filter((x) => x === ":::").length === 2, "三门之间用 ::: 连接（不能用空格）");
    check(args[0] === "run", "首参是 run");

    // ③ 反向：合成一段「首门红、后门照跑」的 mise -c 输出 ⇒ 解析必须把后门列为绿（0）
    const synth = [
        "[lint:ui] Finished in 100ms",
        "[lint:agent] exited with status 1",
        "[check:types] Finished in 2.5s",
        "ERROR 1 task(s) failed:",
        "[lint:agent] exited with status 1",
    ].join("\n");
    const gateList = ["lint:ui", "lint:agent", "check:types", "check:ports"];
    const rows = parseTaskExits(synth, gateList);
    const byName = Object.fromEntries(rows.map((r) => [r.name, r.exit]));
    check(byName["lint:agent"] === 1, "首门红 ⇒ 记为 FAIL", "exit=" + byName["lint:agent"]);
    check(byName["check:types"] === 0, "首门红之后，后门仍算跑过且绿（未被短路）", "exit=" + byName["check:types"]);
    check(byName["check:ports"] === 0, "更后面的门也在表里（跑了几门=" + rows.length + "）");
    check(rows.length === gateList.length, "门清单里有几门就出几行（全量可见）", "rows=" + rows.length);

    // ④ 聚合口径来自 validate-run.mjs（同一实现，不复制）：2 > 1 > 0
    check(aggregateExit([0, 0]) === 0, "全绿 ⇒ 0");
    check(aggregateExit([1, 0]) === 1, "判定失败 ⇒ 1");
    check(aggregateExit([1, 2]) === 2, "环境/用法错误压过判定失败 ⇒ 2");

    // ⑤ 耗时解析口径：缺失不等于 0
    const timings = parseTaskTimings(synth);
    check(timings["check:types"] === 2500, "Finished in 2.5s ⇒ 2500ms", String(timings["check:types"]));
    check(timings["lint:agent"] === undefined, "未上报耗时的门不记为 0（缺失≠绿）");

    // ⑥ 表必须把红门点名，且给出「其余门跑过了」的计数
    const t = formatTable(rows, timings, gateList, 1234);
    check(t.text.includes("FAIL  lint:agent"), "表里点名红门");
    check(t.text.includes("共 4 门"), "表里给出门总数");
    check(t.reported === 2, "上报计时数如实（2/4）", "reported=" + t.reported);

    // ⑦ 嵌套计时修法本体：childEnv 必须把上游关掉的计时重新声明为「要」
    const ce = childEnv({ MISE_TASK_TIMINGS: "0", PATH: "keep" });
    check(ce.MISE_TASK_TIMINGS === "1", "上游注入 =0 也强制成 1（B 档 1/30 的根因）", "got=" + ce.MISE_TASK_TIMINGS);
    check(ce.PATH === "keep", "其余环境原样继承，不重造 env");

    // ⑧ 两种缺失分开写：测不到 ≠ 没报（负例 = 老版一律写 —，读表人分不清）
    const none = formatTable(rows, {}, gateList, 1000);
    check(none.available === false, "整通道无计时 ⇒ available=false");
    check(none.text.includes("无计时") && none.text.includes("测不到"), "无计时写成「无计时 + 测不到」", none.text.split("\n").pop().slice(0, 40));
    const part = formatTable(rows, { "lint:ui": 100 }, gateList, 1000);
    check(part.available === true && part.text.includes("未上报"), "有能力但个别门缺 ⇒ 写「未上报」");
    check(!part.text.includes("无计时"), "有计时能力时不得冒充「测不到」");

    console.log(fail === 0 ? "selftest: ALL PASS" : "selftest: " + fail + " FAIL");
    return fail === 0 ? 0 : 1;
}

function main(argv) {
    if (argv.includes("--selftest")) return runSelftest();

    if (argv.includes("--list")) {
        console.log(LINT_GATES.join("\n"));
        console.error(LINT_GATES.length + " gates");
        return 0;
    }

    const args = buildMiseArgs(LINT_GATES);
    if (args === null) {
        // 空清单绝不冒充绿（同 validate-run.mjs 的 fail-closed 方向）。
        console.error("lint-run: 门清单为空 ⇒ 无门可跑，按用法错误 exit 2（不是绿）");
        return 2;
    }

    const started = Date.now();
    const result = spawnSync("mise", args, {
        cwd: ROOT,
        env: childEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
    });
    const elapsedMs = Date.now() - started;
    // spawnSync 自身失败（找不到 mise）⇒ 2，不冒充 0 通过（同 validate-run.mjs:61-62）。
    const phaseExit = result.error ? 2 : (result.status ?? 2);
    const output = (result.stdout ?? "") + (result.stderr ?? "");
    process.stdout.write(output);
    if (result.error) console.error("lint-run: mise 启动失败：" + result.error.message);

    const rows = parseTaskExits(output, LINT_GATES);
    const { text } = formatTable(rows, parseTaskTimings(output), LINT_GATES, elapsedMs);
    console.log("");
    console.log(text);

    const overall = aggregateExit([phaseExit]);
    const reds = rows.filter((r) => r.exit !== 0);
    console.log(
        overall === 0
            ? "  ⇒ " + LINT_GATES.length + " 门全绿"
            : "  ⇒ " +
              reds.length +
              " 门红（" +
              reds.map((r) => r.name + "=" + r.exit).join(", ") +
              "）；其余 " +
              (LINT_GATES.length - reds.length) +
              " 门本轮**确实跑过了**",
    );
    return overall;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exit(main(process.argv.slice(2)));
}
