#!/usr/bin/env node
/**
 * gate-receipt-read — 把一目录的 receipts 变成**一行总体结论**（task-93）。
 *
 * <p><b>本工具的灵魂是一条判据</b>：`verdict=pass` 但 `executed` 里没有正数工作计数 ⇒ **判 ERROR，不许当绿**。
 * 「0 个测试通过」与「跑了很多都通过」在退出码上无法区分；这里是唯一能区分的地方。</p>
 *
 * <p>三态与退出码：PASS ⇒ 0，FAIL ⇒ 1，ERROR ⇒ 2。
 * `fail` 与 `error` 分属不同码，因为「我的代码红了」和「你的工具没跑起来」不是同一件事。</p>
 *
 * 用法：
 *   node scripts/gate-receipt-read.mjs <dir>
 *   node scripts/gate-receipt-read.mjs <dir> --json
 *   node scripts/gate-receipt-read.mjs <dir> --max-age-ms 3600000
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { CODES, GATES, createReceipt, isFakeGreen, validateReceipt } from "./lib/gate-receipt.mjs";

/**
 * 读一批 receipt 并判定总体结论。
 *
 * @param {Array<object>} receipts
 * @param {{now?: number, maxAgeMs?: number|null}} [opts]
 */
export function summarizeReceipts(receipts, { now = Date.now(), maxAgeMs = null } = {}) {
    const rows = [];
    const problems = [];

    for (const raw of receipts) {
        const v = validateReceipt(raw, { now, maxAgeMs });
        if (!v.ok) {
            problems.push({ gate: raw?.gate ?? "<unknown>", kind: "schema", detail: v.problems.join("; ") });
            rows.push({ ...raw, verdict: "error", code: CODES.E_SCHEMA, reason: v.problems.join("; ") });
            continue;
        }
        // **假绿**：结构合法、自称 pass、但什么都没跑 ⇒ 改判 error（不是改写 receipt，是读者不采信）。
        if (isFakeGreen(raw)) {
            const counter = GATES[raw.gate].counter;
            problems.push({
                gate: raw.gate,
                kind: "fake-green",
                detail: "verdict=pass 但 executed." + counter + "=" + JSON.stringify(raw.executed?.[counter])
                    + "（没有任何工作被执行就报通过）",
            });
            rows.push({
                ...raw,
                verdict: "error",
                code: CODES.E_FAKE_GREEN,
                reason: "假绿：executed." + counter + " 非正数",
            });
            continue;
        }
        rows.push(raw);
    }

    const count = (s) => rows.filter((r) => r.verdict === s).length;
    const passed = count("pass");
    const failed = count("fail");
    const errored = count("error");
    const skipped = count("skipped");

    // 一条都没真跑过（全 skip / 空目录）⇒ 不能被当成绿 —— 与「0 个测试通过」同一条病。
    const nothingProven = passed === 0;

    let verdict;
    let exitCode;
    if (errored > 0 || nothingProven) {
        verdict = "ERROR";
        exitCode = 2;
    } else if (failed > 0) {
        verdict = "FAIL";
        exitCode = 1;
    } else {
        verdict = "PASS";
        exitCode = 0;
    }

    return {
        verdict,
        exitCode,
        totals: { total: rows.length, pass: passed, fail: failed, error: errored, skipped },
        rows,
        problems,
        nothingProven,
    };
}

/** 从目录（或若干 .json）读 receipt。 */
export function loadReceipts(target) {
    const p = resolve(target);
    const st = statSync(p);
    const files = st.isDirectory()
        ? readdirSync(p).filter((n) => n.endsWith(".json")).map((n) => join(p, n))
        : [p];
    return files.map((f) => {
        try {
            return JSON.parse(readFileSync(f, "utf8"));
        } catch (err) {
            // 坏 JSON 也要能被判成 error，不能静默跳过（跳过 = 把它当绿）。
            return createReceipt({
                gate: "<unreadable>",
                verdict: "error",
                code: CODES.E_SCHEMA,
                command: "",
                durationMs: 0,
                executed: {},
                reason: "无法解析 " + f + "：" + String(err.message ?? err),
            });
        }
    }).map((r) => r);
}

function formatOneLine(sum) {
    const t = sum.totals;
    const head = "GATES " + sum.verdict
        + "  total=" + t.total + " pass=" + t.pass + " fail=" + t.fail
        + " error=" + t.error + " skipped=" + t.skipped;
    const detail = sum.rows
        .filter((r) => r.verdict !== "pass")
        .map((r) => "  - " + r.gate + " [" + r.verdict + "/" + r.code + "] " + (r.reason ?? ""));
    if (sum.nothingProven) detail.push("  - 没有任何一条门真正通过：全部 skip/为空，不能当绿");
    return [head, ...detail].join("\n");
}

function main() {
    const argv = process.argv.slice(2);
    const target = argv.find((a) => !a.startsWith("--"));
    const json = argv.includes("--json");
    const ageIdx = argv.indexOf("--max-age-ms");
    const maxAgeMs = ageIdx >= 0 ? Number(argv[ageIdx + 1]) : null;
    if (!target) {
        console.error("用法: node scripts/gate-receipt-read.mjs <dir> [--json] [--max-age-ms N]");
        process.exit(2);
    }
    const sum = summarizeReceipts(loadReceipts(target), { maxAgeMs });
    if (json) {
        console.log(JSON.stringify({ verdict: sum.verdict, totals: sum.totals, problems: sum.problems, rows: sum.rows }, null, 2));
    } else {
        console.log(formatOneLine(sum));
    }
    process.exit(sum.exitCode);
}

if (process.argv[1]?.endsWith("gate-receipt-read.mjs")) main();

export { formatOneLine };
