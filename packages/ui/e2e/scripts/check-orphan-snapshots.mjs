#!/usr/bin/env node
/**
 * task-80：**孤儿截图基线**只读检查（report-only 起步）。
 * task-5（2026-11-12）：**收紧「被引用」的判定**，修子串假阴性。
 *
 * 病根与"被测对象不在场"同源：**目录里存在的东西没人引用** —— 看起来有保护，其实早没人用。
 * 例：`task-75` 重写 `theme.spec.ts` 后，两张主题基线已无任何 spec 引用，但目录里还在
 * （零删除纪律 ⇒ 不自动删，只报告）。
 *
 * 判据：快照文件名去掉平台后缀（`-linux`/`-win32`/`-darwin`）与扩展名得到 `base`
 * - `referenced`：`base` 出现在**截图调用/快照路径语境**的名字集合里（下面三类来源）；
 * - `dynamic`：被截图语境下的模板串覆盖（如 ``config-${tab}-tab``）；
 * - `orphan`：两者皆无。
 *
 * **为什么不再用 `sourceText.includes(base)`**（task-5 实测）：子串判定把三类"并非引用"的出现
 * 算成引用 —— ① testid 前缀（`settings-knowledge` ⊂ `settings-knowledge-heading`）；
 * ② 更长快照名的前缀（`plan-269-real-provider-picker` ⊂ `…-provider-picker-current`）；
 * ③ **只在注释里被提到**（注释写"这张基线已过期"，反而让这张基线永不判孤儿）。
 * 实测当前树上这类误判 **21 张**（testid 前缀 1 / 更长截图名 5 / 仅注释 13 / 更长 route 名 2）。
 *
 * 名字来源（`referenced`）：
 * - A 图片扩展名字面量：`expectPlatformScreenshot(page, "chat-empty.png")` / `toHaveScreenshot("x.png")`；
 * - B 对象属性名：路由表 `{ path: "/workspace", name: "workspace-default" }`（`route.name + ".png"` 间接传名）；
 * - C 截图语境里的模板串 ⇒ 归 `dynamic`（静态字符 ≥6）。
 * 整行注释（`//`、`*`、`/*` 开头）先剔除：注释里写快照名是**说明**，不是**引用**。
 *
 * 自查过的三个坑（前两个第一版都踩了）：
 * 1. **检查器把自己算进去** —— 本文件（含 `--selftest` 夹具）里就有真实快照名字面量，故整体排除自身；
 * 2. **模板匹配过宽** —— 静态字符过短的模板（如 ``${a}-${b}``）能匹配任何名字，会吞掉真孤儿
 *    （约束：静态字符 ≥6 + 截图语境）；
 * 3. **排除必须可审计** —— 旧子串规则会判成"已引用"、新判据判成孤儿的，逐条打印（`--print-excluded`），
 *    否则"判据收紧"看起来和"漏判"一样。
 *
 * 用法：
 *   node e2e/scripts/check-orphan-snapshots.mjs                # report-only（有孤儿也 exit 0）
 *   node e2e/scripts/check-orphan-snapshots.mjs --json
 *   node e2e/scripts/check-orphan-snapshots.mjs --print-excluded
 *   node e2e/scripts/check-orphan-snapshots.mjs --enforce      # 有孤儿即 exit 1（等批准再接门）
 *   node e2e/scripts/check-orphan-snapshots.mjs --selftest     # 7 例正负例，不读仓库
 * 退出码：0 = 扫过且结论可用；1 = --enforce 有孤儿 或 --selftest 有例失败；2 = 一张基线都没扫到。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const E2E_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELF = path.basename(fileURLToPath(import.meta.url));
const PLATFORM_SUFFIX = /-(linux|win32|darwin)$/u;
const SNAPSHOT_EXT = /\.(png|jpe?g|webp)$/u;
const PNG_LITERAL = /(["'])([^"'\n]+?)\.(?:png|jpe?g|webp)\1/gu;
const NAME_PROP = /\bname:\s*(["'])([^"'\n]+)\1/gu;
const SCREENSHOT_CONTEXT = /expectPlatformScreenshot|toHaveScreenshot|screenshotName|snapshot/iu;
const TEMPLATE = /`([^`]*\$\{[^`]*)`/gu;
const TESTID_CALL = /getByTestId\(\s*["'][^"']*$/u;
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/u;

const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const enforce = args.has("--enforce");
const printExcluded = args.has("--print-excluded");
const runSelftest = args.has("--selftest");

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

function lineAt(text, index) {
    let line = 1;
    for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
    return line;
}

/** 检查器自身整体排除：本文件（含 selftest 夹具）里就有真实快照名字面量。 */
function isSelf(entry) {
    return path.basename(entry.file) === SELF;
}

/** 整行注释替换成空行（保留换行 ⇒ 行号不变）。注释里的名字是说明，不是引用。 */
function stripCommentLines(text) {
    return text
        .split("\n")
        .map((line) => (COMMENT_LINE.test(line) ? "" : line))
        .join("\n");
}

/** 名字来源 A/B。整行注释先剔除；同一 base 只留首次命中，便于审计。 */
function collectReferences(sources) {
    const refs = new Map();
    for (const entry of sources) {
        if (isSelf(entry)) continue;
        const text = stripCommentLines(entry.text);
        for (const match of text.matchAll(PNG_LITERAL)) {
            const base = match[2];
            if (refs.has(base)) continue;
            refs.set(base, {
                kind: "png-literal",
                file: entry.file,
                line: lineAt(text, match.index),
            });
        }
        for (const match of text.matchAll(NAME_PROP)) {
            const base = match[2];
            if (refs.has(base)) continue;
            refs.set(base, {
                kind: "name-prop",
                file: entry.file,
                line: lineAt(text, match.index),
            });
        }
    }
    return refs;
}

/** 名字来源 C：截图语境里的模板串（归 `dynamic`）。 */
function collectTemplates(sources) {
    const patterns = [];
    for (const entry of sources) {
        if (isSelf(entry)) continue;
        for (const match of entry.text.matchAll(TEMPLATE)) {
            const template = match[1];
            const statics = template.replace(/\$\{[^}]*\}/gu, "").replace(/[^\p{L}\p{N}_-]/gu, "");
            if (statics.length < 6) continue;
            // 截图语境判定要看**前文一段**：调用常写成多行（模板串单独一行时，只看同一行会漏）
            const context =
                entry.text.slice(Math.max(0, match.index - 200), match.index) + template;
            if (!SCREENSHOT_CONTEXT.test(context)) continue;
            const body = template
                .split(/\$\{[^}]*\}/u)
                .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
                .join("[^/`\"']*");
            try {
                patterns.push({ file: entry.file, regex: new RegExp("^" + body + "$", "u") });
            } catch {
                // 模板编译不过就不算"可证引用"：宁可多报孤儿，也不静默放过
            }
        }
    }
    return patterns;
}

/**
 * 排除面的取证：**故意用旧子串语义**（indexOf）回查首次命中，只为解释"旧规则会说什么、
 * 新规则为什么不算"。它不参与 state 判定 —— 判定只认 `collectReferences`/`collectTemplates`。
 */
function findLegacyHit(sources, base) {
    for (const entry of sources) {
        if (isSelf(entry)) continue;
        const index = entry.text.indexOf(base);
        if (index < 0) continue;
        const line = lineAt(entry.text, index);
        const lineStart = entry.text.lastIndexOf("\n", index) + 1;
        const lineEnd = entry.text.indexOf("\n", index);
        const lineText = entry.text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
        const col = index - lineStart;
        const before = lineText.slice(0, col);
        const after = lineText.slice(col + base.length);
        let kind = "other";
        if (COMMENT_LINE.test(lineText)) kind = "comment";
        else if (TESTID_CALL.test(before)) kind = "testid-prefix";
        else if (/^[A-Za-z0-9_-]/u.test(after)) kind = "longer-name-prefix";
        else if (/[A-Za-z0-9_-]$/u.test(before)) kind = "longer-name-suffix";
        return { kind, file: entry.file, line, snippet: lineText.trim().slice(0, 160) };
    }
    return null;
}

/** 纯分析入口：`--selftest` 用内存夹具，不读磁盘。 */
function analyze({ sources, snapshots }) {
    const references = collectReferences(sources);
    const templates = collectTemplates(sources);
    const rows = snapshots
        .map((file) => {
            const name = path.basename(file);
            const base = name.replace(SNAPSHOT_EXT, "").replace(PLATFORM_SUFFIX, "");
            const ref = references.get(base);
            const dynamic = ref
                ? null
                : templates.find((p) => p.regex.test(base) || p.regex.test(name));
            return {
                file,
                base,
                state: ref ? "referenced" : dynamic ? "dynamic" : "orphan",
                via: ref ? ref.kind + " @ " + ref.file + ":" + ref.line : (dynamic?.file ?? null),
            };
        })
        .sort((a, b) => a.file.localeCompare(b.file));

    const excluded = [];
    for (const row of rows) {
        if (row.state !== "orphan") continue;
        const hit = findLegacyHit(sources, row.base);
        if (!hit) continue;
        excluded.push({ file: row.file, base: row.base, hit });
    }

    const counts = { pngLiteral: 0, nameProp: 0 };
    for (const ref of references.values()) {
        if (ref.kind === "png-literal") counts.pngLiteral += 1;
        else counts.nameProp += 1;
    }
    return { rows, excluded, referenceSources: { ...counts, template: templates.length } };
}

// ---------------------------------------------------------------------------
// --selftest：7 例正负例（内存夹具，不读仓库、不起服务）
// ---------------------------------------------------------------------------
const SELFTEST_CASES = [
    {
        name: "负例/testid 前缀（卡面原案）",
        sources: [
            {
                file: "mock/x.spec.ts",
                text: 'await expect(page.getByTestId("settings-knowledge-heading")).toBeVisible();',
            },
        ],
        snapshots: ["mock/screenshots.spec.ts-snapshots/settings-knowledge-linux.png"],
        expect: "orphan",
    },
    {
        name: "负例/更长截图名前缀",
        sources: [
            {
                file: "real/y.spec.ts",
                text: 'await expectPlatformScreenshot(page, "plan-269-real-provider-picker-current.png");',
            },
        ],
        snapshots: [
            "real/full-ui-acceptance.spec.ts-snapshots/plan-269-real-provider-picker-win32.png",
        ],
        expect: "orphan",
    },
    {
        name: "负例/只在整行注释里被提到",
        sources: [
            {
                file: "mock/z.spec.ts",
                text: '// "plan-269-viewport-mobile-chat.png" is stale: the chat sheet changed',
            },
        ],
        snapshots: [
            "mock/viewport-matrix.spec.ts-snapshots/plan-269-viewport-mobile-chat-win32.png",
        ],
        expect: "orphan",
    },
    {
        name: "正例/图片扩展名字面量",
        sources: [
            {
                file: "mock/chat.spec.ts",
                text: 'await expectPlatformScreenshot(page, "chat-empty.png");',
            },
        ],
        snapshots: ["mock/chat.spec.ts-snapshots/chat-empty-win32.png"],
        expect: "referenced",
    },
    {
        name: "正例/路由表 name 属性 + route.name 间接传名",
        sources: [
            {
                file: "mock/screenshots.spec.ts",
                text: 'const allRoutes = [{ path: "/workspace", name: "workspace-default" }];\nawait expectPlatformScreenshot(page, route.name + ".png");',
            },
        ],
        snapshots: ["mock/screenshots.spec.ts-snapshots/workspace-default-win32.png"],
        expect: "referenced",
    },
    {
        name: "正例/截图语境里的模板串仍归 dynamic",
        sources: [
            {
                file: "mock/full-ui-acceptance.spec.ts",
                text: "await expectPlatformScreenshot(page, ``plan-269-route-${index}.png``);",
            },
        ],
        snapshots: ["mock/full-ui-acceptance.spec.ts-snapshots/plan-269-route-1-win32.png"],
        expect: "dynamic",
    },
    {
        name: "负例/检查器自身排除（非注释里的字面量也不算）",
        sources: [
            {
                file: SELF,
                text: 'const fixture = "chat-empty.png";',
            },
        ],
        snapshots: ["mock/chat.spec.ts-snapshots/chat-empty-win32.png"],
        expect: "orphan",
    },
];

function runSelftestCases() {
    let failed = 0;
    for (const [index, testCase] of SELFTEST_CASES.entries()) {
        const { rows } = analyze({ sources: testCase.sources, snapshots: testCase.snapshots });
        const actual = rows[0]?.state ?? "(no-row)";
        if (actual === testCase.expect) {
            console.log(`  ✓ ${index + 1}/${SELFTEST_CASES.length} ${testCase.name} ⇒ ${actual}`);
            continue;
        }
        failed += 1;
        console.log(`  ✗ ${index + 1}/${SELFTEST_CASES.length} ${testCase.name}`);
        console.log(`      期望 ${testCase.expect} / 实际 ${actual}`);
        console.log(`      夹具：${JSON.stringify(testCase.sources)}`);
    }
    const total = SELFTEST_CASES.length;
    if (failed > 0) {
        console.log(`[orphan-snapshots] selftest FAILED：${total - failed}/${total} 通过`);
        process.exit(1);
    }
    console.log(`[orphan-snapshots] selftest ${total}/${total} 通过（不读仓库、不起服务）`);
    process.exit(0);
}

if (runSelftest) runSelftestCases();

const sources = walkFiles(
    E2E_ROOT,
    (name) => /\.(ts|mts|js|mjs)$/u.test(name) && name !== SELF,
).map((file) => ({
    file: path.relative(E2E_ROOT, file).split(path.sep).join("/"),
    text: fs.readFileSync(file, "utf8"),
}));
const snapshotDirs = walkDirs(E2E_ROOT, (name) => name.endsWith("-snapshots"));
const snapshotFiles = [];
for (const dir of snapshotDirs) {
    for (const name of fs.readdirSync(dir)) {
        if (SNAPSHOT_EXT.test(name))
            snapshotFiles.push(
                path.relative(E2E_ROOT, path.join(dir, name)).split(path.sep).join("/"),
            );
    }
}

const { rows, excluded, referenceSources } = analyze({ sources, snapshots: snapshotFiles });
const orphans = rows.filter((row) => row.state === "orphan");
const dynamicRows = rows.filter((row) => row.state === "dynamic");
const referencedRows = rows.filter((row) => row.state === "referenced");
const scannedNothing = rows.length === 0;

if (asJson) {
    console.log(
        JSON.stringify(
            {
                root: E2E_ROOT,
                scanned: {
                    sourceFiles: sources.length,
                    snapshotDirs: snapshotDirs.length,
                    snapshots: rows.length,
                },
                status: scannedNothing ? "unknown" : orphans.length > 0 ? "orphans" : "clean",
                referencedCount: referencedRows.length,
                orphanCount: orphans.length,
                dynamicCount: dynamicRows.length,
                referenceSources,
                excludedCount: excluded.length,
                orphans,
                dynamic: dynamicRows,
                excluded,
            },
            null,
            2,
        ),
    );
} else {
    console.log(
        `[orphan-snapshots] 扫描 ${sources.length} 个 e2e 源码文件 / ${snapshotDirs.length} 个 *-snapshots 目录 / ${rows.length} 张基线`,
    );
    console.log(
        `[orphan-snapshots] 被引用 ${referencedRows.length}（字面量 ${referenceSources.pngLiteral} / name 属性 ${referenceSources.nameProp}）/ 模板动态 ${dynamicRows.length} / 孤儿 ${orphans.length}`,
    );
    if (scannedNothing) {
        console.log("[orphan-snapshots] UNKNOWN：一张基线都没扫到 ⇒ 无法判断（不等于「无孤儿」）");
    } else if (orphans.length === 0) {
        console.log("[orphan-snapshots] 无孤儿 ✅");
    } else {
        console.log("[orphan-snapshots] 孤儿（既无字面量/name 属性引用，也无模板引用）：");
        for (const orphan of orphans) console.log(`  - ${orphan.file}   (base=${orphan.base})`);
        console.log(
            "[orphan-snapshots] 处置：保留待批（零删除纪律），批后按清单删除并留痕；本检查 report-only。",
        );
    }
    if (excluded.length > 0) {
        console.log(
            `[orphan-snapshots] 排除面 ${excluded.length} 张：旧子串规则会判成「已引用」，新判据判孤儿（逐条可审计${printExcluded ? "" : "，加 --print-excluded 展开"}）`,
        );
        if (printExcluded) {
            for (const item of excluded) {
                console.log(
                    `  ~ ${item.file}  [${item.hit.kind}] ${item.hit.file}:${item.hit.line}`,
                );
                console.log(`      ${item.hit.snippet}`);
            }
        }
    }
}

if (scannedNothing) process.exit(2);
if (enforce && orphans.length > 0) process.exit(1);
