#!/usr/bin/env node
/**
 * AGENTS.md 注入预算守卫（task-178 B5；Lead 2026-11-18 批 B1–B5）。
 *
 * 判据：packages/ui/AGENTS.md 必须 ≤ 63,488 B（= DSH 会话指令注入预算 65,536 B − 2 KiB 余量）。
 * 依据 [实测] 2026-11-17：65,572 B 时注入被截断到 65,200 B，尾部「设置信息架构」等 5 行整块丢失
 * ——「读它的 agent 拿到截断版」是真实风险，本门防回涨。瘦身的登记册外置（B1）见 docs/lint-rule-registry.md。
 *
 * 退出码：0 合规 / 1 超预算（打印越界字节数与最大 3 行作为瘦身入口）/ 2 环境错误。
 * 用法：node scripts/check-agents-md-budget.mjs [文件]   // 可选文件参数仅作自检（over 路径）用
 */
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const TARGET = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, "AGENTS.md");
const BUDGET = 63_488; // 65,536 − 2 KiB

let bytes;
try {
    bytes = statSync(TARGET).size;
} catch {
    console.error("FAIL 读取失败：" + TARGET);
    process.exit(2);
}
if (bytes <= BUDGET) {
    console.log(
        "AGENTS.md " + bytes + " B / 上限 " + BUDGET + " B（余 " + (BUDGET - bytes) + " B）",
    );
    process.exit(0);
}
const lines = readFileSync(TARGET, "utf8").split("\n");
const top = lines
    .map((text, i) => ({ n: i + 1, b: Buffer.byteLength(text) + 1 }))
    .sort((a, b) => b.b - a.b)
    .slice(0, 3);
console.error(
    "FAIL AGENTS.md " +
        bytes +
        " B 超预算上限 " +
        BUDGET +
        " B（越 " +
        (bytes - BUDGET) +
        " B）。最大 3 行：",
);
for (const entry of top)
    console.error("  L" + entry.n + " " + entry.b + " B: " + lines[entry.n - 1].slice(0, 80));
process.exit(1);
