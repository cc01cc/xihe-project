#!/usr/bin/env node
/**
 * lint 规则豁免登记校验（task-171 ①；判据 D-1532 ③「逐步规范化」的前置）。
 *
 * 判据：packages/ui/.oxlintrc.json 里**每一条 off** 都必须在 packages/ui/AGENTS.md
 * 的 `lint-rule-registry:begin` … `lint-rule-registry:end` 区间里有一行登记；
 * 反之，登记了但配置里已不是 off ⇒ 也算不一致（登记会腐烂）。
 *
 * 退出码：0 一致 / 1 不一致（逐条点名 missing 与 stale）/ 2 用法或环境错误。
 * 用法：node scripts/check-lint-rule-registry.mjs [--json]
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const CONFIG = join(ROOT, ".oxlintrc.json");
const AGENTS = join(ROOT, "AGENTS.md");
const BEGIN = "<!-- lint-rule-registry:begin -->";
const END = "<!-- lint-rule-registry:end -->";

function collectOffRules() {
    const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
    const out = [];
    for (const [rule, value] of Object.entries(cfg.rules ?? {})) {
        if (value === "off") out.push({ rule, scope: "main" });
    }
    for (const [index, override] of (cfg.overrides ?? []).entries()) {
        const scope = "override" + index + ":" + JSON.stringify(override.files ?? []);
        for (const [rule, value] of Object.entries(override.rules ?? {})) {
            if (value === "off") out.push({ rule, scope });
        }
    }
    return out;
}

function registryRegion() {
    const text = readFileSync(AGENTS, "utf8");
    const from = text.indexOf(BEGIN);
    const to = text.indexOf(END);
    if (from < 0 || to < 0 || to < from) return null;
    return text.slice(from + BEGIN.length, to);
}

const offRules = collectOffRules();
const region = registryRegion();
if (!region) {
    console.error(
        "FAIL 找不到登记区间标记 " + BEGIN + " … " + END + "（在 packages/ui/AGENTS.md）",
    );
    process.exit(2);
}
// 登记行 = 表格行首格，或测试块里的裸规则名一行一个。
// 只认这两种形态，避免散文里提到 `oxfmt`/`warnings` 之类的词被当成登记。
const FENCE = String.fromCharCode(96, 96, 96);
const registered = new Set();
let inFence = false;
for (const raw of region.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith(FENCE)) {
        inFence = !inFence;
        continue;
    }
    if (inFence) {
        if (/^[a-z0-9-]+\/[a-z0-9-]+$/.test(line)) registered.add(line);
        continue;
    }
    const cell = /^\|\s*`([^`]+)`\s*\|/.exec(line);
    if (cell) registered.add(cell[1]);
}
const offNames = new Set(offRules.map((entry) => entry.rule));
const missing = offRules.filter((entry) => !registered.has(entry.rule));
const stale = [...registered].filter((name) => !offNames.has(name));
const scopes = {};
for (const entry of offRules) {
    const key = entry.scope.split(":")[0];
    scopes[key] = (scopes[key] ?? 0) + 1;
}
const result = {
    off: offRules.length,
    registered: offRules.length - missing.length,
    missing: missing.map((entry) => entry.rule + "  (" + entry.scope + ")"),
    stale,
    scopes,
};

if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
} else {
    console.log(
        "off 规则 " +
            result.off +
            " 条 / 已登记 " +
            result.registered +
            " 条 / 分区 " +
            JSON.stringify(result.scopes),
    );
    if (missing.length) {
        console.log("未登记（" + missing.length + "）：");
        for (const entry of missing) console.log("  - " + entry.rule + "  (" + entry.scope + ")");
    }
    if (stale.length) {
        console.log("登记已过期（配置里已不是 off，共 " + stale.length + "）：" + stale.join(", "));
    }
}
process.exit(missing.length === 0 && stale.length === 0 ? 0 : 1);
