/**
 * 双侧轨迹对账（task-50）—— 比对器（纯函数 + CLI）。
 *
 * 判据三条（对 `compared: true` 的请求逐条判定）：
 * ① 请求集合一致（A 有 B 没有 / B 有 A 没有，都报）；
 * ② 同一请求 `status` 一致；
 * ③ 响应**顶层键集合**一致（`{principals}` vs `{agents}` 会被抓出来）。
 *
 * 为什么失败信息里要同时打印两侧的完整行：这条闸的读者是「要判断形状差到底是谁错了」的人，
 * 只说「不一致」等于把取证工作推回给人；把两侧并列贴出来，他一眼就知道该改哪边。
 */

import fs from "node:fs";
import { traceKey } from "./normalize.mjs";

/** 把 trace 数组折成 `key -> row`（同键多次请求只留**第一次**，重复次数另记）。 */
export function indexTrace(rows) {
    const byKey = new Map();
    const dupes = new Map();
    for (const row of rows) {
        if (row.compared === false) continue;
        const key = traceKey(row);
        if (byKey.has(key)) {
            dupes.set(key, (dupes.get(key) ?? 1) + 1);
            continue;
        }
        byKey.set(key, row);
    }
    return { byKey, dupes };
}

function showKeys(row) {
    if (row.keys === null) return "<no-json-body>";
    return "[" + row.keys.join(", ") + "]";
}

/** 纯比对：返回差异行数组（空数组 = 两车道一致）。 */
export function diffTraces(leftRows, rightRows, labels = {}) {
    const leftName = labels.left ?? "left";
    const rightName = labels.right ?? "right";
    const left = indexTrace(leftRows);
    const right = indexTrace(rightRows);
    const lines = [];
    const keys = [...new Set([...left.byKey.keys(), ...right.byKey.keys()])].sort();
    for (const key of keys) {
        const a = left.byKey.get(key);
        const b = right.byKey.get(key);
        if (a && !b) {
            lines.push("REQ-MISSING-IN-" + rightName.toUpperCase() + "  " + key);
            continue;
        }
        if (b && !a) {
            lines.push("REQ-MISSING-IN-" + leftName.toUpperCase() + "  " + key);
            continue;
        }
        if (a.status !== b.status) {
            lines.push(
                "STATUS    " +
                    key +
                    "  " +
                    leftName +
                    "=" +
                    a.status +
                    " " +
                    rightName +
                    "=" +
                    b.status,
            );
        }
        const aKeys = a.keys === null ? null : a.keys.join(",");
        const bKeys = b.keys === null ? null : b.keys.join(",");
        if (aKeys !== bKeys) {
            lines.push(
                "KEYS      " +
                    key +
                    "  " +
                    leftName +
                    "=" +
                    showKeys(a) +
                    " " +
                    rightName +
                    "=" +
                    showKeys(b),
            );
        }
    }
    return lines;
}

export function renderDiffReport(lines, meta = {}) {
    const header = [
        "# 双侧轨迹对账（task-50）",
        "",
        "- 用例: " + (meta.case ?? "?"),
        "- 左侧: " +
            (meta.leftFile ?? "?") +
            (meta.leftRows === undefined ? "" : " (" + meta.leftRows + " 行)"),
        "- 右侧: " +
            (meta.rightFile ?? "?") +
            (meta.rightRows === undefined ? "" : " (" + meta.rightRows + " 行)"),
        "- 结论: " +
            (lines.length === 0 ? "一致（diff 为空）" : "不一致（" + lines.length + " 条）"),
        "",
    ];
    if (lines.length === 0) return header.concat(["(diff 为空)", ""]).join("\n");
    return header.concat(lines, [""]).join("\n");
}

function readTrace(file) {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    const rows = Array.isArray(parsed) ? parsed : parsed.rows;
    if (!Array.isArray(rows)) throw new Error("trace file has no rows array: " + file);
    return { rows, meta: Array.isArray(parsed) ? {} : parsed };
}

/** CLI: `node diff.mjs left.json right.json [--out report.txt]`；diff 非空 ⇒ exit 1。 */
export function runCli(argv) {
    const files = argv.filter((arg) => !arg.startsWith("--"));
    const outIndex = argv.indexOf("--out");
    const outFile = outIndex === -1 ? null : argv[outIndex + 1];
    if (files.length < 2) {
        console.error("usage: node diff.mjs <left.json> <right.json> [--out report.txt]");
        return 2;
    }
    const left = readTrace(files[0]);
    const right = readTrace(files[1]);
    const lines = diffTraces(left.rows, right.rows, {
        left: left.meta.lane ?? "left",
        right: right.meta.lane ?? "right",
    });
    const report = renderDiffReport(lines, {
        case: left.meta.case ?? right.meta.case,
        leftFile: files[0],
        rightFile: files[1],
        leftRows: left.rows.length,
        rightRows: right.rows.length,
    });
    if (outFile && outFile !== "true") fs.writeFileSync(outFile, report, "utf8");
    process.stdout.write(report);
    return lines.length === 0 ? 0 : 1;
}

if (import.meta.url === "file://" + process.argv[1].replace(/\\/g, "/")) {
    process.exit(runCli(process.argv.slice(2)));
}
