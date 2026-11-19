#!/usr/bin/env node
/**
 * task-32 / task-6（register P-4）：mise lint 窗内三条读数的**只读解析器**。
 *
 * 为什么需要它：窗口内只做三步（应用 `MISE_JOBS = "30"` 补丁 → `mise run lint` → 本解析器读日志），
 * 判据必须由**日志本身**得出，不能靠人眼在 30 行表里数。判据口径与
 * `internal/A03-xihe/docs/task30-lint-wiring-plan.md` §3 一致：
 *   C1 并行度      —— 声明门数全部**启动**过（启动证据 = mise 的 `[gate] $ <cmd>` 行）
 *   C2 首红后其余门确有执行 —— 未启动 0 门，且首红之后仍有门开始（keep-going 生效）
 *   C3 每门计时有值 —— 每门都有 `Finished in`，且汇总表无裸「—」
 *
 * 恒只读：只读一个日志文件，不跑门、不起栈、不写任何文件。
 *
 * 用法：
 *   node scripts/xh-mise-jobs-readings.mjs <log-file> [--expected=30]
 *   node scripts/xh-mise-jobs-readings.mjs --selftest
 *
 * 退出码（fail-closed）：
 *   0 = C1/C2/C3 全部 PASS 且日志结构完整
 *   1 = 有判据不满足，或日志存在但**字段缺**（缺启动行 / 缺汇总表 / 缺计时 ⇒ 明确 FAIL，绝不冒充 PASS）
 *   2 = 用法错或日志文件不存在/不可读（同样是 FAIL，不是「没查」）
 */
import fs from "node:fs";
import path from "node:path";
import { LINT_GATES } from "./lint-run.mjs";

const WRAPPER = "lint"; // `mise run lint` 的 task 名：其 stdout 会带一层 `[lint] ` 前缀

/** 去掉外层 `[lint] ` 包装前缀（同一行可能有多层，但实际只有一层）。 */
export function stripWrapper(line) {
    let out = line;
    for (let i = 0; i < 3; i += 1) {
        if (!out.startsWith("[" + WRAPPER + "] ")) break;
        out = out.slice(WRAPPER.length + 3);
    }
    return out;
}

/** 解析 mise -o prefix 日志 + lint-run.mjs 汇总表。纯函数，输入文本、输出事实。 */
export function parseLog(text) {
    const startOrder = [];
    const timed = new Map(); // gate -> ms（同名取最大：mise 可能一次输出多次 Finished in）
    const exited = new Map(); // gate -> exit code（同名取最后一次）
    const table = new Map(); // gate -> { verdict, exit, cost }
    let wallClock = null; // 优先汇总表「墙钟」，其次内层 mise 整体线
    let reported = null; // { reported, declared } 汇总表「上报计时 N/M 门」
    let overall = null; // { green } 或 { red, reds: [], others }
    let innerWallClock = null;
    const costMissing = []; // 无计时的门名：legacy 裸「—」/ 现行「未上报」/「无计时」三种写法都算缺

    for (const raw of text.split(/\r?\n/)) {
        const line = stripWrapper(raw);
        if (!line.trim()) continue;

        // ① 启动证据：mise 打印任务命令的那一行（这是唯一可靠的「该门真的启动了」痕迹）
        const start = line.match(/^\[([^\]]+)\]\s+\$\s/);
        if (start) {
            if (LINT_GATES.includes(start[1]) && !startOrder.includes(start[1])) startOrder.push(start[1]);
            continue;
        }

        // ② 计时行：`[gate] Finished in 89.1ms|4.53s`
        const fin = line.match(/^\[([^\]]+)\]\s+Finished in ([0-9.]+)(ms|s|µs)\s*$/);
        if (fin) {
            const name = fin[1];
            if (LINT_GATES.includes(name)) {
                const v = Number(fin[2]) * (fin[3] === "s" ? 1000 : fin[3] === "µs" ? 0.001 : 1);
                timed.set(name, Math.max(timed.get(name) ?? 0, v));
            } else if (name === WRAPPER) {
                innerWallClock = Number(fin[2]) * (fin[3] === "s" ? 1000 : 1);
            }
            continue;
        }

        // ③ 失败行：`[gate] exited with status 1`
        const bad = line.match(/^\[([^\]]+)\]\s+exited with status (-?\d+)\s*$/);
        if (bad && LINT_GATES.includes(bad[1])) {
            exited.set(bad[1], Number(bad[2]));
            continue;
        }

        // ④ 汇总表行：`  PASS  check:ports  exit=0  89.1ms`
        const row = line.match(/^\s*(PASS|FAIL)\s+(\S+)\s+exit=(-?\d+)\s+(.*?)\s*$/);
        if (row && LINT_GATES.includes(row[2])) {
            const cost = row[4];
            table.set(row[2], { verdict: row[1], exit: Number(row[3]), cost });
            // lint-run.mjs formatTable:126-128 现行写法：有计时通道但该门没报 ⇒ 「未上报」；整通道没有 ⇒ 「无计时」。
            // 光杆「—」是旧版写法（task-58 已换掉），保留识别是为了读旧日志时不被当 PASS。
            if (cost === "—" || cost === "未上报" || cost === "无计时") costMissing.push(row[2]);
            continue;
        }

        // ⑤ 汇总表尾：`墙钟 23.0s ｜ 上报计时 30/30 门`
        const wc = line.match(/墙钟\s+([0-9.]+)s\s+｜\s+上报计时\s+(\d+)\/(\d+)\s*门/);
        if (wc) {
            wallClock = Number(wc[1]) * 1000;
            reported = { reported: Number(wc[2]), declared: Number(wc[3]) };
            continue;
        }

        // ⑥ 整体结论行：`⇒ 30 门全绿` / `⇒ 2 门红（a=1, b=1）；其余 28 门本轮**确实跑过了**`
        const green = line.match(/⇒\s+(\d+)\s+门全绿/);
        if (green) {
            overall = { green: Number(green[1]), red: 0, reds: [], others: 0 };
            continue;
        }
        const red = line.match(/⇒\s+(\d+)\s+门红（(.+?)）；其余\s+(\d+)\s+门/);
        if (red) {
            const names = red[2].split(",").map((s) => s.trim().split("=")[0]).filter(Boolean);
            overall = { green: 0, red: Number(red[1]), reds: names, others: Number(red[3]) };
            continue;
        }

        // ⑦ 内层 mise 的整体耗时（无前缀的 `Finished in 4.56s`）
        const bare = line.match(/^Finished in ([0-9.]+)(ms|s)\s*$/);
        if (bare) innerWallClock = Number(bare[1]) * (bare[2] === "s" ? 1000 : 1);
    }

    return { startOrder, timed, exited, table, wallClock, reported, overall, innerWallClock, costMissing };
}

/**
 * 三条判据。任何一条无法判定（字段缺）都记 FAIL 并写明「缺什么」——
 * 「没读到」与「读到了但不满足」都不许落成 PASS。
 */
export function judge(facts, expected = LINT_GATES.length) {
    const declared = LINT_GATES.slice(0, expected);
    const started = facts.startOrder.filter((g) => declared.includes(g));
    const missing = declared.filter((g) => !started.includes(g));
    const timed = started.filter((g) => facts.timed.has(g));
    const rows = [];

    // C1：启动 30/30（启动证据 = 每门的 `[gate] $ <cmd>` 行）
    rows.push({
        id: "C1",
        name: "并行度：声明门全部启动",
        pass: started.length === declared.length,
        reading:
            "启动 " + started.length + "/" + declared.length + " 门" +
            (missing.length ? "；未启动：" + missing.join(", ") : ""),
    });

    // C2：首红之后其余门确有执行（keep-going 生效、且没有被首红掐掉）
    const reds = declared.filter((g) => {
        const t = facts.table.get(g);
        return (t && t.exit !== 0) || (facts.exited.get(g) ?? 0) !== 0;
    });
    if (reds.length === 0) {
        rows.push({
            id: "C2",
            name: "首红后其余门确有执行",
            pass: missing.length === 0 && facts.overall !== null && facts.overall.green === declared.length,
            reading: "本轮无红门 ⇒ 该条只在「全绿」意义上成立（依据汇总行 " +
                (facts.overall ? "⇒ " + facts.overall.green + " 门全绿" : "缺失") + "）",
        });
    } else {
        const firstRed = reds[0];
        const idx = facts.startOrder.indexOf(firstRed);
        const afterRed = idx >= 0 ? facts.startOrder.length - (idx + 1) : 0;
        rows.push({
            id: "C2",
            name: "首红后其余门确有执行",
            pass: missing.length === 0 && afterRed > 0,
            reading:
                "首红门 = " + firstRed + "（启动序第 " + (idx + 1) + " 个）；其后仍有 " + afterRed +
                " 门开始执行；未启动 " + missing.length + " 门",
        });
    }

    // C3：每门计时有值（「—」/「未上报」/「无计时」都判红）
    rows.push({
        id: "C3",
        name: "每门计时有值（无「—」/「未上报」）",
        // 判据面 = 汇总表（formatTable 是计时的权威输出面）：红门在 mise 侧很多时候根本不产 Finished in
        // （只打 ERROR task failed）⇒ 拿「Finished 行数 == 启动门数」当门槛会构造性恒红。表里写 `未上报` 才是真缺。
        pass: started.length > 0 && facts.costMissing.length === 0,
        reading:
            "计时 " + timed.length + "/" + started.length + " 门；汇总表缺计时 " + facts.costMissing.length + " 处" +
            (facts.costMissing.length ? "（" + facts.costMissing.join(", ") + "）" : "") +
            (timed.length !== started.length
                ? "；缺计时：" + started.filter((g) => !facts.timed.has(g)).join(", ")
                : ""),
    });

    // 结构完整性：日志里连一条启动行都没有 ⇒ 不是「0 门启动」，是这份日志不可判
    const structural = facts.startOrder.length > 0 && (facts.table.size > 0 || facts.overall !== null);
    if (!structural) {
        rows.push({
            id: "S",
            name: "日志结构完整性",
            pass: false,
            reading: "缺启动行或汇总表/汇总结论行 ⇒ 不可判（fail-closed：不冒充 PASS）",
        });
    }

    const elapsed = facts.wallClock ?? facts.innerWallClock;
    return { rows, declared: declared.length, started: started.length, elapsed, structural };
}

function printReport(result, logPath) {
    console.log("mise lint 三条读数（task-32 / task-6 P-4）  日志：" + logPath);
    for (const r of result.rows) {
        console.log("  " + (r.pass ? "PASS" : "FAIL") + "  " + r.id + "  " + r.name);
        console.log("        " + r.reading);
    }
    console.log("  墙钟 = " + (result.elapsed === null ? "未读到（缺汇总表墙钟与内层 Finished in）" : (result.elapsed / 1000).toFixed(1) + "s"));
    const failed = result.rows.filter((r) => !r.pass);
    console.log(
        failed.length === 0
            ? "  ⇒ C1/C2/C3 全部 PASS"
            : "  ⇒ " + failed.length + " 条不满足（" + failed.map((r) => r.id).join(", ") + "）：窗内按 FAIL 处理",
    );
    return failed.length === 0 ? 0 : 1;
}

function fixtureGates(gates, opts = {}) {
    const lines = [];

    // 模拟 `mise run lint`：外层把 lint-run.mjs 的输出整体加 [lint] 前缀
    const inner = [];
    for (const g of gates) {
        inner.push("[" + g + "] $ node stub-gate.mjs " + g);
        inner.push("[" + g + "] ok");
    }
    for (const g of gates) {
        if (opts.red === g) {
            inner.push("[" + g + "] exited with status 1");
        } else if (opts.unreported === g) {
            // 该门没产完成行 ⇒ 表里写「未上报」（与 lint-run.mjs:128 一致）
        } else {
            inner.push("[" + g + "] Finished in " + (opts.ms ?? 100) + "ms");
        }
    }
    inner.push("");
    inner.push("════════ lint-gates 汇总（共 " + gates.length + " 门，keep-going，全部执行）════════");
    for (const g of gates) {
        const red = opts.red === g;
        const cost = opts.bareDash === g ? "—" : opts.unreported === g ? "未上报" : opts.ms !== undefined ? opts.ms + "ms" : "12ms";
        inner.push("  " + (red ? "FAIL" : "PASS") + "  " + g.padEnd(26) + " exit=" + (red ? 1 : 0) + "  " + cost);
    }
    inner.push("  墙钟 " + ((opts.wall ?? 23000) / 1000).toFixed(1) + "s ｜ 上报计时 " + (gates.length - (opts.red ? 1 : 0)) + "/" + gates.length + " 门");
    inner.push("");
    if (opts.red) {
        inner.push("  ⇒ 1 门红（" + opts.red + "=1）；其余 " + (gates.length - 1) + " 门本轮**确实跑过了**");
    } else {
        inner.push("  ⇒ " + gates.length + " 门全绿");
    }
    for (const l of inner) lines.push("[lint] " + l);
    return lines.join("\n");
}

/** 内置自测：PASS 样本 + 四个必须 FAIL 的反例（红门仍在跑 / 裸「—」/ 日志截断 / 空日志）。 */
export function selftest() {
    const fails = [];
    const check = (ok, label, detail) => {
        console.log((ok ? "PASS  " : "FAIL  ") + label + (detail ? "  [" + detail + "]" : ""));
        if (!ok) fails.push(label);
    };

    // ① 全绿：C1/C2/C3 全 PASS，墙钟读回
    const g = fixtureGates(LINT_GATES);
    const a = judge(parseLog(g));
    check(a.rows.filter((r) => r.id !== "C2").every((r) => r.pass), "全绿样本 ⇒ C1/C3 PASS");
    check(a.rows.find((r) => r.id === "C2").pass, "全绿样本 ⇒ C2 以「全绿」依据成立");
    check(a.elapsed === 23000, "墙钟读回 23000ms", String(a.elapsed));

    // ② 首红 keep-going：第 7 门红，其后仍有门开始 ⇒ C2 PASS、C1 PASS
    const b = judge(parseLog(fixtureGates(LINT_GATES, { red: LINT_GATES[6] })));
    check(b.rows.find((r) => r.id === "C1").pass, "首红样本 ⇒ C1 仍 PASS（30 门都启动过）");
    check(b.rows.find((r) => r.id === "C2").pass, "首红样本 ⇒ C2 PASS（首红后仍有门开始）");
    check(/其后仍有 23 门开始执行/.test(b.rows.find((r) => r.id === "C2").reading), "C2 报出首红后启动门数", b.rows.find((r) => r.id === "C2").reading);

    // ③ 裸「—」⇒ C3 必须红
    const c = judge(parseLog(fixtureGates(LINT_GATES, { bareDash: LINT_GATES[3] })));
    check(!c.rows.find((r) => r.id === "C3").pass, "裸「—」⇒ C3 FAIL");
    check(c.rows.find((r) => r.id === "C3").reading.includes("缺计时 1 处"), "C3 报出缺计时处数");

    // ③c 现行「未上报」写法（lint-run.mjs:126-128 的真实输出）⇒ C3 必须红并点名
    const c2 = judge(parseLog(fixtureGates(LINT_GATES, { unreported: LINT_GATES[5] })));
    check(!c2.rows.find((r) => r.id === "C3").pass, "「未上报」⇒ C3 FAIL（现行写法不冒充 PASS）");
    check(c2.rows.find((r) => r.id === "C3").reading.includes(LINT_GATES[5]), "C3 点名未上报的门", LINT_GATES[5]);

    // ④ 日志截断（只启动 2 门）⇒ C1 FAIL 且不冒充 PASS
    const truncated = judge(parseLog(fixtureGates(LINT_GATES.slice(0, 2))));
    check(!truncated.rows.find((r) => r.id === "C1").pass, "截断日志 ⇒ C1 FAIL");
    check(truncated.rows.find((r) => r.id === "C1").reading.includes("未启动："), "C1 点名未启动的门");

    // ⑤ 空日志 / 缺字段 ⇒ 结构性 FAIL（不是「0 门启动所以 PASS」）
    const empty = judge(parseLog(""));
    check(empty.rows.some((r) => r.id === "S" && !r.pass), "空日志 ⇒ 结构完整性 FAIL");

    // ⑥ 真实样本（2026-11-19 20:16 本机实跑 2 门：mise run -c -o prefix check:ports ::: check:md-tables）
    const real2 = [
        "[check:ports] $ node scripts/check-ports-parity.mjs --require-mirror",
        "[check:md-tables] $ node scripts/check-md-tables.mjs --enforce",
        "[check:ports] [ports-parity] OK (no drift)",
        "[check:ports] Finished in 89.1ms",
        "[check:md-tables] Finished in 4.53s",
        "Finished in 4.56s",
    ].join("\n");
    const real = judge(parseLog(real2));
    check(real.started === 2, "真实样本 ⇒ 识别出 2 门启动", String(real.started));
    check(!real.rows.find((r) => r.id === "C1").pass, "真实样本（不足 30 门）⇒ C1 FAIL（fail-closed）");
    check(real.elapsed === 4560, "真实样本 ⇒ 读回内层整体耗时 4560ms", String(real.elapsed));

    console.log(fails.length === 0 ? "selftest: ALL PASS" : "selftest: " + fails.length + " FAIL");
    return fails.length === 0 ? 0 : 1;
}

function main(argv) {
    if (argv.includes("--selftest")) return selftest();
    if (argv.length === 0 || argv[0].startsWith("--")) {
        console.error("用法：node scripts/xh-mise-jobs-readings.mjs <lint-log-file> [--expected=30]");
        console.error("      node scripts/xh-mise-jobs-readings.mjs --selftest");
        return 2;
    }
    const logPath = path.resolve(argv[0]);
    const expArg = argv.find((x) => x.startsWith("--expected="));
    const expected = expArg ? Number(expArg.slice("--expected=".length)) : LINT_GATES.length;
    if (!Number.isInteger(expected) || expected <= 0) {
        console.error("--expected 必须是正整数：" + expArg);
        return 2;
    }
    let text;
    try {
        text = fs.readFileSync(logPath, "utf8");
    } catch (e) {
        // 日志不存在/不可读 ⇒ FAIL（exit 2），不是「没查所以放行」
        console.error("FAIL  读不到日志：" + logPath + "  [" + (e && e.code) + "]");
        console.error("      ⇒ 未取得读数，窗内必须重跑 lint 后重试本解析器");
        return 2;
    }
    return printReport(judge(parseLog(text), expected), logPath);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
    process.exit(main(process.argv.slice(2)));
}
