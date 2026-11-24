#!/usr/bin/env node
/**
 * check:atom-display —— 界面不得直接把 canonical 权限原子名渲染给用户（task-949 / R78）。
 *
 * 判据层选择：**源码模板层**，不是渲染层。理由：
 *   - 渲染层已有 `check:copy-leak`（需要活栈、SKIP 时不能判），本门要能进 `mise run lint` 的
 *     无栈聚合，所以必须能在源码上机械判定；
 *   - R78 的形态是「mustache 里直接印原子字段」，`{{ expr }}` 是可穷举的形状，误报面小。
 *
 * 判据（每条命中 = 一个签名 `相对路径|<归一化表达式>`）：
 *   模板 `{{ … }}` 里出现 `.actionClass`，且**同一个插值内没有**本地化函数
 *   （`atomDisplayLabel(` / `hookActionLabel(` / `actionLabel(`）。
 *   canonical 名（`action:…` / `cap:…` / `MANAGE_…`）只用于 API 与审计，展示层必须换词。
 *
 * 基线：`scripts/atom-display-baseline.json`（存量只减不增）。新命中 > 基线计数 ⇒ exit 1。
 * 已有 surface（审批弹窗 / 审计 / 授权总览 / 工具面）尚未迁移，登记在基线里逐条计数；
 * 任何一处**新增**裸显都会红。
 *
 * 用法：
 *   node packages/ui/scripts/check-atom-display.mjs
 *   node packages/ui/scripts/check-atom-display.mjs --json .tmp/atom-display.json
 *   node packages/ui/scripts/check-atom-display.mjs --write-baseline   # 只在确认存量后手工用
 *   node packages/ui/scripts/check-atom-display.mjs --selftest
 *
 * 退出码：0 无回归；1 有新命中；2 结构/IO 错误。
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_ROOT = resolve(HERE, "..");
const SRC_ROOT = resolve(UI_ROOT, "src");
const BASELINE_PATH = resolve(HERE, "atom-display-baseline.json");

const SKIP_DIRS = new Set(["__tests__", "node_modules", ".tmp"]);
const SKIP_FILES = new Set(["src/i18n/index.ts"]);
const LOCALIZERS = ["atomDisplayLabel(", "hookActionLabel(", "actionLabel("];
const MUSTACHE = /{{([\s\S]*?)}}/g;
/** 只匹配「直接打印字段」的插值表达式；函数调用/条件表达式在被本地化函数包裹时不算。 */
const RAW_ATOM = /\.actionClass\b/;

export function scanMustaches(text) {
    const hits = [];
    for (const m of text.matchAll(MUSTACHE)) {
        const expr = m[1].replace(/\s+/g, " ").trim();
        if (!RAW_ATOM.test(expr)) continue;
        // `t("…explain.actionClass")` 是 i18n **键名**里带 actionClass，不是打印该字段。
        if (/^(?:\$t|t)\(/.test(expr)) continue;
        if (LOCALIZERS.some((fn) => expr.includes(fn))) continue;
        hits.push(expr);
    }
    return hits;
}

async function walk(dir, out = []) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            await walk(full, out);
            continue;
        }
        if (!/\.(vue|ts)$/.test(entry.name) || /\.spec\.ts$/.test(entry.name)) continue;
        out.push(full);
    }
    return out;
}

async function collect() {
    const rows = [];
    for (const file of await walk(SRC_ROOT)) {
        const rel = relative(UI_ROOT, file).split(sep).join("/");
        if (SKIP_FILES.has(rel)) continue;
        const text = await readFile(file, "utf8");
        for (const expr of scanMustaches(text)) rows.push({ sig: `${rel}|${expr}` });
    }
    const bySig = new Map();
    for (const row of rows) bySig.set(row.sig, (bySig.get(row.sig) ?? 0) + 1);
    return { rows, bySig };
}

async function readBaseline() {
    try {
        const doc = JSON.parse(await readFile(BASELINE_PATH, "utf8"));
        return doc.entries ?? {};
    } catch (cause) {
        if (cause?.code === "ENOENT") return {};
        throw cause;
    }
}

function selftest() {
    const cases = [
        ["{{ permission.actionClass }}", 1],
        ["{{ atomDisplayLabel(permission.actionClass) }}", 0],
        ["{{ hookActionLabel(atom) }}", 0],
        ["{{ permission.resource }}", 0],
        ['{{ t("settings.explain.actionClass") }}', 0],
        ["{{ atom.actionClass }} · {{ p.actionClass }}", 2],
    ];
    let bad = 0;
    cases.forEach(([text, want], i) => {
        const got = scanMustaches(text).length;
        const ok = got === want;
        if (!ok) bad++;
        console.log(`  ${ok ? "PASS" : "FAIL"} #${i + 1} want=${want} got=${got}`);
    });
    console.log(
        `[atom-display] selftest ${cases.length - bad}/${cases.length}${bad ? " 有失败" : " 全过"}`,
    );
    process.exit(bad === 0 ? 0 : 1);
}

async function main() {
    const argv = process.argv.slice(2);
    if (argv.includes("--selftest")) return selftest();
    const jsonArg = argv.indexOf("--json");
    const writeBaseline = argv.includes("--write-baseline");

    let collected;
    try {
        collected = await collect();
    } catch (cause) {
        console.error("[atom-display] cannot scan:", cause?.message ?? cause);
        return 2;
    }

    if (writeBaseline) {
        const entries = {};
        for (const [sig, count] of collected.bySig) entries[sig] = count;
        await writeFile(
            BASELINE_PATH,
            JSON.stringify({ generatedAt: "2026-11-24", entries }, null, 2) + "\n",
            "utf8",
        );
        console.log(`[atom-display] baseline written: ${Object.keys(entries).length} signatures`);
        return 0;
    }

    let baseline;
    try {
        baseline = await readBaseline();
    } catch (cause) {
        console.error("[atom-display] baseline unreadable:", cause?.message ?? cause);
        return 2;
    }

    const regressions = [];
    for (const [sig, count] of collected.bySig) {
        const allowed = baseline[sig] ?? 0;
        if (count > allowed) regressions.push({ sig, count, allowed });
    }
    const shrunk = Object.keys(baseline).filter((sig) => !collected.bySig.has(sig));

    if (jsonArg >= 0) {
        const out = resolve(argv[jsonArg + 1] ?? ".tmp/atom-display.json");
        await writeFile(
            out,
            JSON.stringify({ regressions, shrunk, total: collected.rows.length }, null, 2) + "\n",
            "utf8",
        );
        console.log(`[atom-display] json: ${out}`);
    }

    console.log(`[atom-display] raw atom interpolations: ${collected.rows.length}`);
    for (const shrunkSig of shrunk) {
        console.log(`  STALE baseline entry (now 0, delete it): ${shrunkSig}`);
    }
    for (const row of regressions) {
        console.log(`  NEW/INCREASED ${row.sig} (now ${row.count}, baseline ${row.allowed})`);
    }
    if (regressions.length > 0) {
        console.error(`[atom-display] ${regressions.length} regression(s)`);
        return 1;
    }
    console.log("[atom-display] PASS (no new raw atom display)");
    return 0;
}

process.exit(await main());
