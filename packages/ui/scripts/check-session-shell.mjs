#!/usr/bin/env node
/**
 * check-session-shell.mjs — 会话壳层/composer 结构门（task-936 / R66-R73）。
 *
 * 为什么需要静态门：这批问题全是「DOM 里多了/少了某个节点、节点挂在错的分组」——
 * vitest 能测组件，但跨文件（WorkspaceView + WorkspaceWorkbench + InputArea + MessageItem）
 * 的**位置契约**只有源码/DOM 能表达。
 *
 * 规则（红 = exit 1）：
 *   SS1 composer 发送区唯一发送键：InputArea 里 `chat-send-button` 恰好 1 处；
 *   SS2 R70：`tier`（权限档位）必须在左工具组；R72：`model` 也在左（右侧只留发送）；
 *   SS3 R71：`delegate` 动作不得可见（`visible: false`，入口下线）；
 *   SS4 R69：WorkspaceView 会话头块内不得出现 `workspace-usage-cost/source` 或 `in {{ usageInput }}`；
 *   SS5 R66：会话头标题必须 `sr-only`（可见标题唯一归属容器页签行）；
 *   SS6 R67：会话头必须有唯一 `data-testid="workspace-dock-toggle"`，且 Workbench 那颗
 *       在会话路由让位（`v-if="!onSessionRoute"`），状态经 `defineExpose` 暴露；
 *   SS7 R73：MessageItem 气泡统一 `max-w-[85%]`，不得回退 `md:max-w-[75%]` / `lg:max-w-(--chat-bubble-max)`。
 *
 * 用法：
 *   node scripts/check-session-shell.mjs                 # 静态门（默认）
 *   node scripts/check-session-shell.mjs --json
 *   node scripts/check-session-shell.mjs --selftest      # 反证：把违规写回夹具必须 FAIL
 *   node scripts/check-session-shell.mjs --ax <sessionUrl>
 *       # 真浏览器 AX/DOM 读数（需 XIHE_ADMIN_PASSWORD_FILE 或默认 .local/dev/admin-password）
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
    view: "src/features/workspace/pages/WorkspaceView.vue",
    workbench: "src/features/workspace/components/WorkspaceWorkbench.vue",
    input: "src/features/workspace/chat/components/InputArea.vue",
    message: "src/features/workspace/chat/components/MessageItem.vue",
});

const HEADER_MARKER =
    'class="h-8 shrink-0 border-b px-3 flex items-center gap-2 text-xs text-muted-foreground bg-muted/5"';
const HEADER_END = "<!-- PLAN-0622";

function read(root, relative) {
    return readFileSync(path.join(root, relative), "utf8");
}

function headerBlock(viewSource) {
    const start = viewSource.indexOf(HEADER_MARKER);
    if (start < 0) return "";
    const end = viewSource.indexOf(HEADER_END, start);
    return viewSource.slice(start, end < 0 ? viewSource.length : end);
}

function toolbarBlock(inputSource) {
    const start = inputSource.indexOf("const toolbarActions = computed<ToolbarAction[]>(() => [");
    if (start < 0) return inputSource;
    const end = inputSource.indexOf("\nasync function handleSend", start);
    return inputSource.slice(start, end < 0 ? inputSource.length : end);
}

function actionPosition(toolbar, key) {
    const re = new RegExp(`key:\\s*"${key}"[\\s\\S]*?position:\\s*"(left|right)"`);
    const match = toolbar.match(re);
    return match ? match[1] : null;
}

function actionBlock(toolbar, key) {
    const start = toolbar.indexOf(`key: "${key}"`);
    if (start < 0) return "";
    const next = toolbar.indexOf("key: ", start + 5);
    return toolbar.slice(start, next < 0 ? toolbar.length : next);
}

export function evaluate(sources) {
    const problems = [];
    const view = sources.view;
    const workbench = sources.workbench;
    const input = sources.input;
    const message = sources.message;

    const toolbar = toolbarBlock(input);
    if ((toolbar.match(/"chat-send-button"/g) ?? []).length !== 1) {
        problems.push("SS1 composer 必须有且只有一处 chat-send-button");
    }
    if (actionPosition(toolbar, "tier") !== "left") {
        problems.push("SS2 权限档位（tier）必须在左工具组");
    }
    if (actionPosition(toolbar, "model") !== "left") {
        problems.push("SS2 模型 chip 必须在左工具组（右侧只留发送）");
    }
    const delegate = actionBlock(toolbar, "delegate");
    if (delegate && !/visible:\s*false/.test(delegate)) {
        problems.push("SS3 委派按钮不得留在 composer 发送区（visible 必须为 false）");
    }
    const rightKeys = [...toolbar.matchAll(/key:\s*"([\w-]+)",\s*\n\s*position:\s*"right"/g)].map(
        (m) => m[1],
    );
    for (const key of rightKeys) {
        if (!["delegate", "stop", "send"].includes(key)) {
            problems.push(`SS2 右侧出现第二组控件：${key}`);
        }
    }

    const header = headerBlock(view);
    if (!header) problems.push("SS4 找不到 WorkspaceView 会话头块");
    for (const marker of ["workspace-usage-cost", "workspace-usage-source", "usageInput"]) {
        if (header.includes(marker)) problems.push(`SS4 会话头仍渲染用量（${marker}）`);
    }
    if (
        !/data-testid="workspace-session-title"[\s\S]{0,200}?sr-only|sr-only[\s\S]{0,200}?data-testid="workspace-session-title"/.test(
            header,
        )
    ) {
        problems.push("SS5 会话头标题必须 sr-only（可见标题只留在容器页签行）");
    }
    if ((header.match(/data-testid="workspace-dock-toggle"/g) ?? []).length !== 1) {
        problems.push("SS6 会话头必须有且只有一颗 workspace-dock-toggle");
    }
    if (
        !/v-if="sessionId && onSessionRoute"[\s\S]{0,200}?data-testid="workspace-dock-toggle"/.test(
            header,
        )
    ) {
        problems.push("SS6 会话头开关只能在会话路由渲染（否则 root 页出现第二颗）");
    }
    if (!header.includes(":aria-pressed=")) {
        problems.push("SS6 会话头右栏开关必须带 aria-pressed");
    }
    if (
        !/v-if="!onSessionRoute"[\s\S]{0,200}?data-testid="workspace-dock-toggle"/.test(workbench)
    ) {
        problems.push("SS6 WorkspaceWorkbench 的右栏开关必须在会话路由让位");
    }
    if (!/defineExpose\(\{[^}]*dockOpen[^}]*toggleDock/.test(workbench)) {
        problems.push("SS6 WorkspaceWorkbench 必须 defineExpose dockOpen/toggleDock");
    }

    if (!message.includes("max-w-[85%]")) problems.push("SS7 气泡必须用 max-w-[85%]");
    if (message.includes("md:max-w-[75%]")) problems.push("SS7 气泡不得回退 md:max-w-[75%]");
    if (message.includes("lg:max-w-(--chat-bubble-max)")) {
        problems.push("SS7 气泡不得回退 lg:max-w-(--chat-bubble-max)");
    }
    return problems;
}

function loadSources(root) {
    return Object.fromEntries(Object.entries(FILES).map(([key, rel]) => [key, read(root, rel)]));
}

function runStatic(root, json) {
    const sources = loadSources(root);
    const problems = evaluate(sources);
    if (json) {
        process.stdout.write(
            `${JSON.stringify({ ok: problems.length === 0, problems }, null, 2)}\n`,
        );
    } else if (problems.length === 0) {
        process.stdout.write("[session-shell] PASS（SS1-SS7）\n");
    } else {
        process.stderr.write(`[session-shell] FAIL ${problems.length} 项\n`);
        for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
    }
    return problems.length === 0 ? EXIT.PASS : EXIT.RED;
}

function runSelftest(root) {
    const base = loadSources(root);
    const expectFail = (name, mutate, needle) => {
        const sources = { ...base };
        mutate(sources);
        const problems = evaluate(sources);
        if (!problems.some((problem) => problem.includes(needle))) {
            process.stderr.write(`[session-shell] SELFTEST FAIL ${name}: 未命中 ${needle}\n`);
            process.exit(EXIT.RED);
        }
        process.stdout.write(`[session-shell] selftest ok: ${name}\n`);
    };

    expectFail(
        "把 tier 挪回右侧",
        (s) => {
            s.input = s.input.replace(
                'key: "tier",\n        position: "left"',
                'key: "tier",\n        position: "right"',
            );
        },
        "tier",
    );
    expectFail(
        "把用量塞回会话头",
        (s) => {
            s.view = s.view.replace(
                HEADER_MARKER,
                `${HEADER_MARKER}\n<span data-testid="workspace-usage-cost"></span>`,
            );
        },
        "workspace-usage-cost",
    );
    expectFail(
        "把气泡宽度改回 md 75%",
        (s) => {
            s.message = s.message.replace("max-w-[85%]", "md:max-w-[75%]");
        },
        "SS7",
    );
    expectFail(
        "让委派按钮重新可见",
        (s) => {
            s.input = s.input.replace(
                "// composer 发送区不再承载它。保留动作定义与对话框供右侧面板复用，但入口不渲染。\n        visible: false",
                "visible: !workspaceLess.value && !props.queueMode",
            );
        },
        "委派",
    );
    process.stdout.write("[session-shell] selftest PASS（4 组反证全部命中）\n");
    return EXIT.PASS;
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

async function runAx(sessionUrl) {
    const { chromium } = await import("@playwright/test");
    const chrome =
        process.env.CHROME_BETA_PATH ??
        "C:/Program Files/Google/Chrome Beta/Application/chrome.exe";
    const passwordFile =
        process.env.XIHE_ADMIN_PASSWORD_FILE ??
        path.resolve(HERE, "../../.local/dev/admin-password");
    const password = readFileSync(passwordFile, "utf8").trim();
    const origin = new URL(sessionUrl).origin;
    const browser = await chromium.launch({ executablePath: chrome, headless: true });
    try {
        const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
        const page = await context.newPage();
        await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(1000);
        if (await page.locator('input[type="password"]').count()) {
            const email = page.locator(
                'input[autocomplete="username"], input[type="email"], input[name="email"]',
            );
            if (await email.count())
                await email.first().fill(process.env.XIHE_ADMIN_EMAIL ?? "admin@xihe.local");
            await page.locator('input[type="password"]').first().fill(password);
            await page.locator('button[type="submit"]').first().click();
            await page.waitForTimeout(1500);
        }
        await page.goto(sessionUrl, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(2500);

        const reading = await page.evaluate(() => {
            const toggles = Array.from(
                document.querySelectorAll('[data-testid="workspace-dock-toggle"]'),
            );
            const title = document.querySelector('[data-testid="workspace-session-title"]');
            const tabs = Array.from(
                document.querySelectorAll('[data-testid="workspace-container-tabs"] [role="tab"]'),
            ).map((node) => node.textContent?.trim() ?? "");
            return {
                toggleCount: toggles.length,
                toggleTag: toggles[0]?.tagName ?? null,
                togglePressed: toggles[0]?.getAttribute("aria-pressed") ?? null,
                toggleLabel: toggles[0]?.getAttribute("aria-label") ?? null,
                delegate: document.querySelectorAll('[data-testid="chat-delegate-button"]').length,
                usageInHeader: document.querySelectorAll(
                    '[data-testid="workspace-usage-cost"], [data-testid="workspace-usage-source"]',
                ).length,
                titleVisible: title
                    ? (() => {
                          const rect = title.getBoundingClientRect();
                          return rect.width > 0 && rect.height > 0;
                      })()
                    : null,
                titleText: title?.textContent?.trim() ?? null,
                tabLabels: tabs,
            };
        });

        assert(reading.toggleCount === 1, `右栏开关数量应为 1，实测 ${reading.toggleCount}`);
        assert(reading.toggleTag === "BUTTON", `右栏开关必须是 button，实测 ${reading.toggleTag}`);
        assert(reading.togglePressed !== null, "右栏开关缺 aria-pressed");
        assert(Boolean(reading.toggleLabel), "右栏开关缺可访问名");
        assert(reading.delegate === 0, `composer 不应有委派按钮，实测 ${reading.delegate}`);
        assert(reading.usageInHeader === 0, "会话头不应有用量节点");
        assert(reading.titleVisible === false, "会话头标题必须不可见（sr-only）");
        const matches = reading.tabLabels.filter((label) => label === reading.titleText);
        assert(matches.length === 1, `会话标题可见节点应 ≤1，实测 ${matches.length}`);

        process.stdout.write(`[session-shell] AX PASS ${JSON.stringify(reading)}\n`);
        return EXIT.PASS;
    } finally {
        await browser.close();
    }
}

function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (!token.startsWith("--")) {
            out._.push(token);
            continue;
        }
        const name = token.slice(2);
        if (["json", "selftest"].includes(name)) {
            out[name] = true;
            continue;
        }
        if (name === "ax" || name === "root") {
            const value = argv[i + 1];
            if (!value || value.startsWith("--")) {
                process.stderr.write(`[session-shell] --${name} 缺取值\n`);
                process.exit(EXIT.BAD_INPUT);
            }
            out[name] = value;
            i += 1;
            continue;
        }
        process.stderr.write(`[session-shell] 未知参数 --${name}\n`);
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
            process.stderr.write(`[session-shell] AX FAIL ${error?.message ?? error}\n`);
            process.exit(EXIT.RED);
        }
    }
    process.exit(runStatic(root, Boolean(args.json)));
}

main();
