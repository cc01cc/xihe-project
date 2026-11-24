#!/usr/bin/env node
/**
 * check-filetree-ia.mjs — 文件面板信息架构门（task-939 / R76，用户 2026-11-24 实拍批注）。
 *
 * 为什么需要静态门：这批缺陷全是「**某个块挂在错误的容器里**」—— vitest 能测组件行为，
 * 但「文件页签里不该有 git 状态块 / 不该有整块声明卡片」是跨文件的位置契约
 * （FileTreePanel + TreeNodeList + i18n 文案），只有源码能表达。
 *
 * 规则（红 = exit 1）：
 *   FT1 文件面板不得再渲染仓库状态块：`workspace-git-readface*` 与
 *       `useWorkspaceGitReadState` 都不得出现在 FileTreePanel.vue
 *       （待提交读数的权威宿主是 dock「变更」面板 WorkspaceChangesPanel 的「待提交」tab）。
 *   FT2 文件面板不得再渲染嵌套声明卡片块：`nested-repos-panel` / `nested-repo-row` 不得出现。
 *   FT3 树行展开控件必须是 `aria-expanded`，且 `▼`/`▶` 字形不得再出现在 TreeNodeList.vue。
 *   FT4 声明动作必须在树行内（TreeNodeList 带 `nested-repo-declare`），
 *       且不得由面板顶部整块承载（与 FT2 互证：入口存在的位置必须是行内组件）。
 *   FT5 内部术语不得出屏：`声明为根` / `嵌套仓` / `Declare as root` / `Nested repo`
 *       在 zh/en 两侧的用户可见文案里都必须为 0 命中；本卡拥有的键必须两侧同时存在。
 *   FT6 布局读数口径（`--ax`）：文件树可见高度 ≥ 面板高度 60%（改前实测 13.5% / 9.3%）。
 *       —— 「文件树可见高度」= **树的滚动容器**与面板的相交高度（不是树的内容高：内容只有
 *       三行时恒等于 92px，量不出顶部块被挤掉的那部分）。改前该容器被 git 状态块 +
 *       两张声明卡片压到 ~59%（面板 680px − 头 32 − git 51.4 − 搜索 33 − 卡片 160.9）。
 *   FT7 迁回判据（`--ax`）：文件面板里删掉的待提交读数必须**仍可用** —— dock「变更」页签的
 *       「待提交」tab 里能看到同一个读数（计数或「不是 Git 仓库」），否则「拆 IA」就变成了「删功能」。
 *
 * 用法：
 *   node scripts/check-filetree-ia.mjs                # 静态门（FT1-FT5）
 *   node scripts/check-filetree-ia.mjs --json         # 机器读
 *   node scripts/check-filetree-ia.mjs --selftest     # 反证：把违规写回内存源码必须 FAIL
 *   node scripts/check-filetree-ia.mjs --ax <workspaceUrl>
 *       # 真浏览器读数（FT6 + FT3/FT5 的 DOM 侧实证）
 *       # 口令只从 XIHE_ADMIN_PASSWORD_FILE 或 .local/dev/admin-password 读入，绝不打印
 *
 * 退出码：0 PASS / 1 FAIL / 2 用法或环境错误。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const EXIT = { PASS: 0, RED: 1, BAD_INPUT: 2 };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_ROOT = path.resolve(HERE, "..");

export const FILES = Object.freeze({
    panel: "src/features/workspace/components/FileTreePanel.vue",
    tree: "src/features/workspace/components/FileTree.vue",
    row: "src/features/workspace/components/TreeNodeList.vue",
    // task-1027：文件树拥有的 nestedRepo* 键在 workspace 域（locale 已按域拆分）。
    i18n: "src/i18n/messages/workspace.ts",
});

/** FT6 判据：文件树可见高度占面板高度的最小比例。 */
export const TREE_MIN_RATIO = 0.6;

/** FT5 黑名单：内部术语（键名可以留，出屏的**文案值**不行）。 */
export const BANNED_COPY = [
    "声明为根",
    "嵌套仓",
    "未声明的嵌套 Git 仓库",
    "Declare as root",
    "Nested repo",
    "Undeclared nested git repositories",
];

/** 本卡独占的 i18n 键：zh/en 必须同时存在（缺一侧 ⇒ check:dev-i18n-drift 之外再钉一层）。 */
export const OWNED_KEYS = [
    "nestedRepoDeclare",
    "nestedRepoDeclareYes",
    "nestedRepoDeclareConfirm",
    "nestedRepoDeclared",
    "nestedRepoType_nested",
    "nestedRepoType_gitdir",
];

function read(root, rel) {
    return readFileSync(path.join(root, rel), "utf8");
}

/** 取 `<template>` 段：静态门只判渲染产物，注释里的历史说明不该算违规。 */
function templateOf(source) {
    const start = source.indexOf("<template>");
    if (start < 0) return source;
    return source.slice(start);
}

/** 去掉 HTML 注释（模板注释是留给人的，不是 DOM）。 */
function withoutComments(template) {
    return template.replace(/<!--[\s\S]*?-->/g, "");
}

/** locale 块（zh-CN / en-US）—— 用两个顶层 locale 键切分。 */
function localeBlocks(i18nSource) {
    const zhStart = i18nSource.indexOf('"zh-CN": {');
    const enStart = i18nSource.indexOf('"en-US": {');
    if (zhStart < 0 || enStart < 0) return null;
    return { zh: i18nSource.slice(zhStart, enStart), en: i18nSource.slice(enStart) };
}

export function evaluate(sources) {
    const problems = [];
    const panel = withoutComments(templateOf(sources.panel));
    const row = withoutComments(templateOf(sources.row));
    const locales = localeBlocks(sources.i18n);

    // FT1 —— 仓库状态块不得在文件面板里（含取数入口，藏块不算修）。
    if (panel.includes("workspace-git-readface")) {
        problems.push("FT1 文件面板仍渲染仓库状态块（workspace-git-readface）");
    }
    if (/useWorkspaceGitReadState|getWorkspaceGitStatus/.test(sources.panel)) {
        problems.push("FT1 文件面板仍是 git-status 的消费者（读数只归 dock「变更」面板）");
    }

    // FT2 —— 嵌套声明不得再占顶部整块。
    for (const marker of ["nested-repos-panel", "nested-repo-row"]) {
        if (panel.includes(marker)) problems.push(`FT2 文件面板仍渲染声明卡片（${marker}）`);
    }

    // FT3 —— 展开控件：aria-expanded 必须在，箭头字形必须没。
    if (!/aria-expanded/.test(row)) {
        problems.push("FT3 树行展开控件缺 aria-expanded（读屏只能念出字形）");
    }
    // 只判**渲染产物**（模板去掉注释）：历史说明写在注释里不算出屏，
    // 但写在模板里就是读屏念出来的字形。
    if (/[▼▶]/.test(row)) {
        problems.push("FT3 TreeNodeList 仍出现 ▼/▶ 文本字符（必须换成图标）");
    }

    // FT4 —— 声明入口在树行内。
    if (!row.includes("nested-repo-declare")) {
        problems.push("FT4 树行内没有声明入口（声明动作不得回到面板顶部）");
    }

    // FT5 —— 内部术语出屏 + 双语同批。
    if (!locales) {
        problems.push("FT5 读不到 zh-CN / en-US locale 块（脚本口径失效）");
    } else {
        for (const [name, block] of [
            ["zh-CN", locales.zh],
            ["en-US", locales.en],
        ]) {
            for (const banned of BANNED_COPY) {
                if (block.includes(`"${banned}"`)) {
                    problems.push(`FT5 ${name} 用户可见文案仍写内部术语「${banned}」`);
                }
            }
            for (const key of OWNED_KEYS) {
                if (!new RegExp(`${key}:`).test(block)) {
                    problems.push(`FT5 ${name} 缺本卡拥有的键 ${key}（中英必须同批）`);
                }
            }
            if (/"nestedReposTitle:/.test(block)) {
                problems.push(`FT5 ${name} 仍保留卡片标题键 nestedReposTitle（卡片已退场）`);
            }
        }
    }

    return problems;
}

function loadSources(root) {
    const out = {};
    for (const [key, rel] of Object.entries(FILES)) out[key] = read(root, rel);
    return out;
}

function report(problems, json) {
    if (json) {
        process.stdout.write(
            `${JSON.stringify({ ok: problems.length === 0, problems }, null, 2)}\n`,
        );
    } else if (problems.length === 0) {
        process.stdout.write("[filetree-ia] PASS（FT1-FT5）\n");
    } else {
        process.stderr.write(`[filetree-ia] FAIL ${problems.length} 项\n`);
        for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
    }
    return problems.length === 0 ? EXIT.PASS : EXIT.RED;
}

function runSelftest(root) {
    const base = loadSources(root);
    const clean = evaluate(base);
    if (clean.length > 0) {
        process.stderr.write("[filetree-ia] SELFTEST FAIL 基线不干净：\n");
        for (const problem of clean) process.stderr.write(`  - ${problem}\n`);
        return EXIT.RED;
    }
    const expectFail = (name, mutate, needle) => {
        const sources = { ...base };
        mutate(sources);
        const problems = evaluate(sources);
        if (!problems.some((problem) => problem.includes(needle))) {
            process.stderr.write(`[filetree-ia] SELFTEST FAIL ${name}: 未命中 ${needle}\n`);
            return false;
        }
        process.stdout.write(`[filetree-ia] selftest ok: ${name}\n`);
        return true;
    };

    const cases = [
        // FT1：把状态块塞回文件面板（DOM 侧）。
        expectFail(
            "把仓库状态块塞回文件面板",
            (s) => {
                s.panel = s.panel.replace(
                    '<div v-if="creatingFile"',
                    '<div data-testid="workspace-git-readface"></div>\n        <div v-if="creatingFile"',
                );
            },
            "FT1",
        ),
        // FT1 反证 B：只藏块、仍取数 ⇒ 也必须红（否则「v-if=false」能骗过门）。
        expectFail(
            "藏块但保留取数通道",
            (s) => {
                s.panel = `${s.panel}\n// const gitRead = useWorkspaceGitReadState();\n`;
                // 注释不算 ⇒ 用真 import 再判一次。
                s.panel = s.panel.replace(
                    'import FileTree from "./FileTree.vue";',
                    'import FileTree from "./FileTree.vue";\nimport { useWorkspaceGitReadState } from "../composables/useWorkspaceGitReadState";',
                );
            },
            "FT1",
        ),
        // FT2：声明卡片块回到顶部。
        expectFail(
            "把声明卡片放回面板顶部",
            (s) => {
                s.panel = s.panel.replace(
                    '<div v-if="creatingFile"',
                    '<div data-testid="nested-repos-panel"></div>\n        <div v-if="creatingFile"',
                );
            },
            "FT2",
        ),
        // FT3：箭头字形回到行内 + aria-expanded 撤掉。
        expectFail(
            "展开控件退回文本箭头",
            (s) => {
                s.row = s.row.replace(
                    ":aria-expanded=\"node.type === 'directory' ? isExpanded : undefined\"",
                    "",
                );
                s.row = s.row.replace(
                    "</button>",
                    '{{ isExpanded ? "▼" : "▶" }}\n                        </button>',
                );
            },
            "FT3",
        ),
        // FT4：行内入口消失（挪回面板 ⇒ FT2 也会红，但 FT4 单独钉一次位置契约）。
        expectFail(
            "树行内不再有声明入口",
            (s) => {
                s.row = s.row.replace(/nested-repo-declare/g, "row-action-removed");
            },
            "FT4",
        ),
        // FT5：内部术语回到 zh 文案。
        expectFail(
            "zh 文案写回「声明为根」",
            (s) => {
                s.i18n = s.i18n.replace(
                    'nestedRepoDeclare: "纳入快照"',
                    'nestedRepoDeclare: "声明为根"',
                );
            },
            "FT5",
        ),
        // FT5 反证 B：只改一侧（en 漏改）⇒ 双语同批也必须红。
        expectFail(
            "只改中文不改英文",
            (s) => {
                s.i18n = s.i18n.replace(
                    'nestedRepoDeclare: "Include in snapshots"',
                    'nestedRepoDeclare: "Declare as root"',
                );
            },
            "FT5",
        ),
        // FT5 反证 C：卡片标题键复活。
        expectFail(
            "卡片标题键复活",
            (s) => {
                s.i18n = s.i18n.replace(
                    'nestedRepoDeclare: "纳入快照"',
                    'nestedReposTitle: "未声明的嵌套 Git 仓库",\n            nestedRepoDeclare: "纳入快照"',
                );
            },
            "FT5",
        ),
    ];

    if (!cases.every(Boolean)) return EXIT.RED;
    process.stdout.write(`[filetree-ia] selftest PASS（${cases.length} 组反证全部命中）\n`);
    return EXIT.PASS;
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

/**
 * FT6 真浏览器读数：文件树可见高度 / 面板高度 ≥ 60%，并顺带实证 FT3（无箭头字形、
 * 有 aria-expanded）与 FT5（面板文本里没有内部术语）。
 */
async function runAx(workspaceUrl) {
    const { chromium } = await import("@playwright/test");
    const chrome =
        process.env.CHROME_BETA_PATH ??
        "C:/Program Files/Google/Chrome Beta/Application/chrome.exe";
    const passwordFile =
        process.env.XIHE_ADMIN_PASSWORD_FILE ??
        path.resolve(UI_ROOT, "../../.local/dev/admin-password");
    const password = readFileSync(passwordFile, "utf8").trim();
    const url = new URL(workspaceUrl);
    const browser = await chromium.launch({ executablePath: chrome, headless: true });
    try {
        const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
        const page = await context.newPage();
        await page.goto(`${url.origin}/login`, { waitUntil: "domcontentloaded" });
        await page.locator("#identifier").fill(process.env.XIHE_ADMIN_EMAIL ?? "admin@xihe.local");
        await page.locator("#password").fill(password);
        await page.locator('button[type="submit"]').first().click();
        await page.waitForFunction(() => localStorage.getItem("xihe-token") !== null, undefined, {
            timeout: 30000,
        });
        // 读数对象是「文件面板」，所以必须保证 files 面板真的开着（用户的持久布局可能
        // 把它关掉或停在别的页签）。写死一份布局只影响本视口，不改产品行为。
        await page.addInitScript(
            (wsId) => {
                localStorage.setItem(
                    `xihe-layout-ws:${wsId}`,
                    JSON.stringify({
                        treeCollapsed: false,
                        dockTabs: ["files", "monitor", "changes"],
                        activeDockTab: "files",
                        activeDockTabs: { main: null, right: "files" },
                        dockWidth: 360,
                        dockCollapsed: false,
                        dockFocus: false,
                    }),
                );
            },
            url.pathname.split("/").filter(Boolean)[1] ?? "",
        );
        await page.goto(workspaceUrl, { waitUntil: "domcontentloaded" });
        const panel = page.getByTestId("workspace-file-tree");
        await panel.waitFor({ state: "visible", timeout: 60000 });
        await page
            .locator('[data-testid="workspace-file-tree"] [role="treeitem"]')
            .first()
            .waitFor({ state: "visible", timeout: 60000 });
        // 等有限次动画结束再量（task-924 口径：无限循环动画不参与）。
        await page.evaluate(async () => {
            const finite = document
                .getAnimations()
                .filter((a) => a.effect?.getTiming().iterations !== Infinity);
            await Promise.race([
                Promise.allSettled(finite.map((a) => a.finished)),
                new Promise((resolve) => setTimeout(resolve, 3000)),
            ]);
        });

        const reading = await page.evaluate(() => {
            const panelEl = document.querySelector('[data-testid="workspace-file-tree"]');
            // 树的**滚动容器**（flex-1 overflow-y-auto 那一层），不是内容高。
            const scroller = document
                .querySelector('[data-testid="workspace-file-tree"] [role="tree"]')
                ?.closest(".overflow-y-auto");
            const clip = (a, b) =>
                Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
            const panelBox = panelEl?.getBoundingClientRect();
            const scrollerBox = scroller?.getBoundingClientRect();
            const rows = Array.from(
                document.querySelectorAll('[data-testid="workspace-file-tree"] [role="treeitem"]'),
            );
            const rowButtons = rows.map((row) => row.querySelector("button")).filter(Boolean);
            const text = panelEl ? (panelEl.textContent ?? "") : "";
            return {
                panelHeight: panelBox ? panelBox.height : null,
                treeVisibleHeight: panelBox && scrollerBox ? clip(scrollerBox, panelBox) : null,
                scrollerFound: Boolean(scrollerBox),
                readfaceNodes: document.querySelectorAll('[data-testid="workspace-git-readface"]')
                    .length,
                cardNodes: document.querySelectorAll(
                    '[data-testid="nested-repos-panel"], [data-testid="nested-repo-row"]',
                ).length,
                rowButtons: rowButtons.length,
                rowsWithAriaExpanded: rowButtons.filter((b) => b.hasAttribute("aria-expanded"))
                    .length,
                glyphRows: rowButtons.filter((b) => /[▼▶]/.test(b.textContent ?? "")).length,
                declareEntries: document.querySelectorAll(
                    '[data-testid="workspace-file-tree"] [data-testid="nested-repo-declare"]',
                ).length,
                jargonHits: [
                    "声明为根",
                    "嵌套仓",
                    "仓库状态（待提交）",
                    "当前工作区不是 Git 仓库",
                ].filter((term) => text.includes(term)),
            };
        });

        assert(reading.panelHeight && reading.panelHeight > 0, "读不到文件面板高度");
        const ratio = reading.treeVisibleHeight / reading.panelHeight;
        assert(
            ratio >= TREE_MIN_RATIO,
            `FT6 文件树可见高度 ${(reading.treeVisibleHeight ?? 0).toFixed(1)}px / 面板 ${reading.panelHeight.toFixed(1)}px = ${(ratio * 100).toFixed(1)}% < ${TREE_MIN_RATIO * 100}%`,
        );
        assert(reading.readfaceNodes === 0, `FT1 文件面板仍有 ${reading.readfaceNodes} 个状态块`);
        assert(reading.cardNodes === 0, `FT2 文件面板仍有 ${reading.cardNodes} 个声明卡片`);
        assert(reading.glyphRows === 0, `FT3 仍有 ${reading.glyphRows} 行把箭头字形念出来`);
        assert(reading.rowsWithAriaExpanded > 0, "FT3 没有任何行带 aria-expanded（展开态不可读）");
        assert(
            reading.jargonHits.length === 0,
            `FT5 出屏内部术语：${reading.jargonHits.join(", ")}`,
        );

        // FT7：被移出文件面板的读数必须在 dock「变更」页签里仍然可用（否则就是删功能）。
        await page.getByTestId("dock-tab-changes").click();
        const pendingTab = page.getByTestId("workspace-diff-tab-pending");
        await pendingTab.waitFor({ state: "visible", timeout: 20000 });
        await pendingTab.click();
        const pendingCount = page.getByTestId("workspace-diff-pending-count");
        const pendingNoRepo = page.getByTestId("workspace-diff-pending-no-repo");
        await Promise.race([
            pendingCount.waitFor({ state: "visible", timeout: 20000 }).catch(() => {}),
            pendingNoRepo.waitFor({ state: "visible", timeout: 20000 }).catch(() => {}),
        ]);
        const movedFace = await page.evaluate(() => ({
            count:
                document
                    .querySelector('[data-testid="workspace-diff-pending-count"]')
                    ?.textContent?.trim() ?? null,
            noRepo:
                document
                    .querySelector('[data-testid="workspace-diff-pending-no-repo"]')
                    ?.textContent?.trim() ?? null,
            listEntries: document.querySelectorAll('[data-testid="workspace-diff-pending-entry"]')
                .length,
            error:
                document
                    .querySelector('[data-testid="workspace-diff-pending-error"]')
                    ?.textContent?.trim() ?? null,
        }));
        assert(
            movedFace.count !== null || movedFace.noRepo !== null || movedFace.listEntries > 0,
            `FT7 「变更」页签的待提交读数不可用（count/noRepo/list 全空，error=${movedFace.error ?? ""}）`,
        );

        const roundedRatio = Number(ratio.toFixed(4));
        const payload = JSON.stringify({
            ...reading,
            ratio: roundedRatio,
            changesPanel: movedFace,
        });
        process.stdout.write(
            `[filetree-ia] AX PASS ratio=${(ratio * 100).toFixed(1)}% ${payload}\n`,
        );
        return EXIT.PASS;
    } finally {
        await browser.close();
    }
}

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (!token.startsWith("--")) {
            process.stderr.write(`[filetree-ia] 多余参数 ${token}\n`);
            process.exit(EXIT.BAD_INPUT);
        }
        const name = token.slice(2);
        if (["json", "selftest"].includes(name)) {
            out[name] = true;
            continue;
        }
        if (name === "ax" || name === "root") {
            const value = argv[i + 1];
            if (!value || value.startsWith("--")) {
                process.stderr.write(`[filetree-ia] --${name} 缺取值\n`);
                process.exit(EXIT.BAD_INPUT);
            }
            out[name] = value;
            i += 1;
            continue;
        }
        process.stderr.write(`[filetree-ia] 未知参数 --${name}\n`);
        process.exit(EXIT.BAD_INPUT);
    }
    return out;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const root = args.root ? path.resolve(args.root) : UI_ROOT;
    if (args.selftest) {
        process.exit(runSelftest(root));
    }
    if (args.ax) {
        try {
            process.exit(await runAx(args.ax));
        } catch (error) {
            process.stderr.write(`[filetree-ia] AX FAIL ${error?.message ?? error}\n`);
            process.exit(EXIT.RED);
        }
    }
    let sources;
    try {
        sources = loadSources(root);
    } catch (error) {
        process.stderr.write(`[filetree-ia] 读文件失败：${error?.message ?? error}\n`);
        process.exit(EXIT.BAD_INPUT);
    }
    process.exit(report(evaluate(sources), Boolean(args.json)));
}

await main();
