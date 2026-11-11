#!/usr/bin/env node
/**
 * task-80：**孤儿截图基线**只读检查（report-only 起步）。
 *
 * 病根与"被测对象不在场"同源：**目录里存在的东西没人引用** —— 看起来有保护，其实早没人用。
 * 例：`task-75` 重写 `theme.spec.ts` 后，两张主题基线已无任何 spec 引用，但目录里还在
 * （零删除纪律 ⇒ 不自动删，只报告）。
 *
 * 判据：快照文件名去掉平台后缀（`-linux`/`-win32`/`-darwin`）与扩展名得到 `base`
 * - `referenced`：某个 e2e 源码里出现 `base` 字面量；
 * - `dynamic`：被截图语境下的模板串覆盖（如 `` `config-${tab}-tab` ``）；
 * - `orphan`：两者皆无。
 *
 * 自查过的两个坑（第一版都踩了）：
 * 1. **检查器把自己算进去** —— 本文件注释里举例就含真实快照名，于是"孤儿"被自己"引用"变成了已引用；
 * 2. **模板匹配过宽** —— 静态字符过短的模板（如 `` `${a}-${b}` ``）能匹配任何名字，会吞掉真孤儿。
 * 两者都会让这个门自己变成假绿，故都加了约束（排除自身 + 静态字符 ≥6 + 截图语境）。
 *
 * 用法：
 *   node e2e/scripts/check-orphan-snapshots.mjs             # report-only（有孤儿也 exit 0）
 *   node e2e/scripts/check-orphan-snapshots.mjs --json
 *   node e2e/scripts/check-orphan-snapshots.mjs --enforce    # 有孤儿即 exit 1（等批准再接门）
 * 退出码：0 = 扫过且结论可用；2 = 一张基线都没扫到（"不知道"≠"没有"）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const E2E_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELF = path.basename(fileURLToPath(import.meta.url));
const PLATFORM_SUFFIX = /-(linux|win32|darwin)$/u;
const SNAPSHOT_EXT = /\.(png|jpe?g|webp)$/u;

const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const enforce = args.has("--enforce");

function walkFiles(dir, filter, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "test-results") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walkFiles(full, filter, out);
        else if (filter(entry.name)) out.push(full);
    }
    return out;
}

/** 目录也要能扫：第一版只扫文件 ⇒ 快照目录数恒为 0，于是"无孤儿 ✅"（又一种假绿）。 */
function walkDirs(dir, predicate, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === "test-results")
            continue;
        const full = path.join(dir, entry.name);
        if (predicate(entry.name)) out.push(full);
        walkDirs(full, predicate, out);
    }
    return out;
}

const sourceEntries = walkFiles(
    E2E_ROOT,
    (name) => /\.(ts|mts|js|mjs)$/u.test(name) && name !== SELF,
).map((file) => ({ file, text: fs.readFileSync(file, "utf8") }));
const sourceText = sourceEntries.map((entry) => entry.text).join("\n");

const SCREENSHOT_CONTEXT = /expectPlatformScreenshot|toHaveScreenshot|screenshotName|snapshot/iu;
const templatePatterns = [];
for (const entry of sourceEntries) {
    for (const match of entry.text.matchAll(/`([^`]*\$\{[^`]*)`/gu)) {
        const template = match[1];
        const statics = template.replace(/\$\{[^}]*\}/gu, "").replace(/[^\p{L}\p{N}_-]/gu, "");
        if (statics.length < 6) continue;
        // 截图语境判定要看**前文一段**：调用常写成多行（模板串单独一行时，只看同一行会漏）
        const context = entry.text.slice(Math.max(0, match.index - 200), match.index) + template;
        if (!SCREENSHOT_CONTEXT.test(context)) continue;
        const body = template
            .split(/\$\{[^}]*\}/u)
            .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
            .join("[^/`\"']*");
        try {
            templatePatterns.push({
                file: path.relative(E2E_ROOT, entry.file).split(path.sep).join("/"),
                regex: new RegExp(`^${body}$`, "u"),
            });
        } catch {
            // 模板编译不过就不算"可证引用"：宁可多报孤儿，也不静默放过
        }
    }
}

const snapshotDirs = walkDirs(E2E_ROOT, (name) => name.endsWith("-snapshots"));
const snapshotFiles = [];
for (const dir of snapshotDirs) {
    for (const name of fs.readdirSync(dir)) {
        if (SNAPSHOT_EXT.test(name)) snapshotFiles.push(path.join(dir, name));
    }
}

const rows = snapshotFiles
    .map((file) => {
        const name = path.basename(file);
        const base = name.replace(SNAPSHOT_EXT, "").replace(PLATFORM_SUFFIX, "");
        const literal = sourceText.includes(base);
        // 模板里常带扩展名（`` `x-${tag}.png` ``），而 base 是去扩展名的 ⇒ 两种形态都要试。
        const dynamic = literal
            ? null
            : templatePatterns.find(
                  (pattern) => pattern.regex.test(base) || pattern.regex.test(name),
              );
        return {
            file: path.relative(E2E_ROOT, file).split(path.sep).join("/"),
            base,
            state: literal ? "referenced" : dynamic ? "dynamic" : "orphan",
            via: dynamic?.file ?? null,
        };
    })
    .sort((a, b) => a.file.localeCompare(b.file));

const orphans = rows.filter((row) => row.state === "orphan");
const dynamicRows = rows.filter((row) => row.state === "dynamic");
const scannedNothing = rows.length === 0;

if (asJson) {
    console.log(
        JSON.stringify(
            {
                root: E2E_ROOT,
                scanned: {
                    sourceFiles: sourceEntries.length,
                    snapshotDirs: snapshotDirs.length,
                    snapshots: rows.length,
                },
                status: scannedNothing ? "unknown" : orphans.length > 0 ? "orphans" : "clean",
                orphanCount: orphans.length,
                dynamicCount: dynamicRows.length,
                orphans,
                dynamic: dynamicRows,
            },
            null,
            2,
        ),
    );
} else {
    console.log(
        `[orphan-snapshots] 扫描 ${sourceEntries.length} 个 e2e 源码文件 / ${snapshotDirs.length} 个 *-snapshots 目录 / ${rows.length} 张基线`,
    );
    if (scannedNothing) {
        console.log("[orphan-snapshots] UNKNOWN：一张基线都没扫到 ⇒ 无法判断（不等于「无孤儿」）");
    } else if (orphans.length === 0) {
        console.log(
            `[orphan-snapshots] 无孤儿 ✅（另有 ${dynamicRows.length} 张由截图模板动态引用）`,
        );
    } else {
        console.log(
            `[orphan-snapshots] 孤儿 ${orphans.length} 张（既无字面引用也无模板引用）；另有 ${dynamicRows.length} 张为模板动态引用：`,
        );
        for (const orphan of orphans) console.log(`  - ${orphan.file}   (base=${orphan.base})`);
        console.log(
            "[orphan-snapshots] 处置：保留待批（零删除纪律），批后按清单删除并留痕；本检查 report-only。",
        );
    }
}

if (scannedNothing) process.exit(2);
if (enforce && orphans.length > 0) process.exit(1);
