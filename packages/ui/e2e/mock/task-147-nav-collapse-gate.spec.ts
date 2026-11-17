/**
 * task-147（P0）：**collapse()/expand() 与 resizeToWidth() 同口径 gate `layoutReady`** 的回归判据
 * （mock lane，L0 单 spec）。
 *
 * ── 被测机制（崩栈）────────────────────────────────────────────────────────────────
 * ```
 * assert(panelSize != null) ← reka-ui Splitter/SplitterGroup.js:383 collapsePanel
 *                          ← useSplitterPanelBridge collapse()      （修前无门）
 *                          ← AppLayout.vue watch(navPanelCollapsed) (flush: "post")
 * ```
 * `panelDataHelper` 的 `panelSize` 就是 `layout[panelIndex]`（`SplitterGroup.js:494`）；
 * layout 尚未初始化时它是 `undefined` ⇒ 断言必抛。reka 不提供 `isLayoutReady`，只提供
 * 「它自己报过一次尺寸」这个信号，所以桥接层把「就绪」定义成「首帧 @resize 已到」，
 * 三条命令式入口（resize / collapse / expand）共用它（task-51 只 gate 了宽度）。
 *
 * ── 触发链是几何派生的，所以阈值是 5px 的差 ────────────────────────────────────────
 *   nav 面板 = RAIL(56) + navWidth(280) = 336，手柄 4px，树收起 40，**pinned** dock 360
 *   ⇒ workbench 行宽 = 视口 − 340；main 再减去 dock（pinned 才占空间）
 *     · ≤1455 ⇒ 主列低于 720（comfort）/640（硬底线）⇒ **会话列（本面板）让位**
 *     · 1460 起 ⇒ 不再触发让位（实测 1600/1920 已完全展开）
 * 让位是 mount 之后的**状态转移**（measure → squeeze → navPanelCollapsed 翻转），所以它会落在
 * 「reka 还没报过尺寸」的窗口里 —— 崩的那一下。
 *
 * ── 修前 / 修后读数（同一棵树、同一份 mock 布局，一个 spec 跑完）────────────────────
 * | 视口 | 修前 | 修后 |
 * | 1280 | **崩**（pageerror + console 各 1 条） | 0 |
 * | 1440 | **崩** | 0 |
 * | 1455 | **崩** | 0 |
 * | 1460 | 0 | 0 |
 * | 1500 / 1600 / 1920 | 0 | 0 |
 * 崩的指纹 = `Panel size not found for panel "reka-splitter-panel-v-<n>"`（vendor 断言原文）。
 *
 * ── 跑法 ──────────────────────────────────────────────────────────────────────────
 * 自带 webServer（lane 端口自选，别落在共享 stack 段）：
 *   $env:XIHE_UI_PORT='12784'; pnpm exec playwright test --config e2e/playwright.config.ts \
 *     e2e/mock/task-147-nav-collapse-gate.spec.ts --reporter=line
 * 复用已起的 dev server（多次复跑更快，也避开 vite 首次预打包的 504）：
 *   $env:XIHE_E2E_EXTERNAL_SERVER='1'; ... 同上
 */
import { expect, test } from "./helpers/mock-test";
import type { Page } from "@playwright/test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { EXPECT_TIMEOUT_MS } from "../timeouts";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_PATH = `/workspace/${WORKSPACE_ID}`;
const LAYOUT_KEY = `xihe-layout-ws:${WORKSPACE_ID}`;
const GLOBAL_KEY = "xihe-layout-global";

/** 崩栈的指纹：vendor 的断言文本（`SplitterGroup.js:383`），不是我们的措辞。 */
const CRASH_TOKEN = "Panel size not found";

interface Reading {
    /** nav 面板（splitter panel #1）的实渲染宽度；-1 = 没读到。 */
    aside: number;
    /** `data-state`：`collapsed` 就是让位真的发生了（reka 自己写的）。 */
    state: string | null;
    /** 分隔条是否在（`navHandleVisible = !navPanelCollapsed`）⇒ 折叠的直接证据。 */
    handle: boolean;
}

/**
 * 种子：**pinned 且真渲染**的右栏。task-162 后 `deriveDockMode` 与 `dockModeManual` 已删
 * （D-1754 ④：右栏恒为正常列），pinned 恒成立 —— <1800 也无需任何"手选"就能保持
 * pinned（正是本复现场景；seedLayout 只写现行持久面键）。
 */
async function seedLayout(page: Page): Promise<void> {
    await page.addInitScript(
        ({ globalKey, layoutKey }: { globalKey: string; layoutKey: string }) => {
            localStorage.setItem(globalKey, JSON.stringify({ navOpen: true, navWidth: 280 }));
            localStorage.setItem(
                layoutKey,
                JSON.stringify({
                    treeCollapsed: true,
                    treeWidth: 240,
                    dockCollapsed: false,
                    dockWidth: 360,
                    dockTabs: ["files", "monitor"],
                    activeDockTab: "files",
                    dockMode: "pinned",
                }),
            );
        },
        { globalKey: GLOBAL_KEY, layoutKey: LAYOUT_KEY },
    );
}

function read(page: Page): Promise<Reading> {
    return page.evaluate(() => {
        const aside = document.querySelector('[data-testid="sidebar"]');
        return {
            aside: aside ? aside.getBoundingClientRect().width : -1,
            state: aside ? aside.getAttribute("data-state") : null,
            handle: Boolean(document.querySelector('[data-testid="sidebar-resizer"]')),
        };
    });
}

/** 错误现场：pageerror 与 console error 两条通道都收（watcher 抛错可能只落后者）。 */
function collectErrors(page: Page): string[] {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
        if (message.type() === "error") errors.push(`console: ${message.text()}`);
    });
    return errors;
}

/** 等几何落定：连续两次读数一致（轮询由框架做，不是固定 sleep）。 */
async function settle(page: Page): Promise<Reading> {
    let previous = -1;
    let stable = 0;
    await expect
        .poll(
            async () => {
                const current = (await read(page)).aside;
                if (Math.abs(current - previous) < 0.01) stable += 1;
                else {
                    stable = 0;
                    previous = current;
                }
                return stable;
            },
            { timeout: EXPECT_TIMEOUT_MS, intervals: [100] },
        )
        .toBeGreaterThan(3);
    return read(page);
}

/** 挂载一个工作台：种布局 → 定视口 → 进工作区 → 等壳出现。 */
async function boot(page: Page, width: number): Promise<void> {
    await setupMockAuth(page);
    await setupMockSessions(page, { sessions: [{ id: "session-1", title: "Session 1" }] });
    await page.setViewportSize({ width, height: 900 });
    await seedLayout(page);
    await page.goto(WORKSPACE_PATH);
    await page.waitForSelector('[data-testid="workspace-workbench"]', {
        state: "attached",
        timeout: EXPECT_TIMEOUT_MS,
    });
}

test("① 1455：pinned 右栏挤压 ⇒ 会话列（nav）让位 ⇒ 不崩（崩栈消失）", async ({ page }) => {
    const errors = collectErrors(page);
    await boot(page, 1455);
    const settled = await settle(page);
    const crashes = errors.filter((line) => line.includes(CRASH_TOKEN));
    console.log(
        `[task-147] 1455 ⇒ aside=${settled.aside.toFixed(1)} state=${settled.state} ` +
            `handle=${settled.handle} crash=${crashes.length} err=${errors.length}`,
    );
    if (errors.length > 0) console.log("[task-147] 1455 errors:\n" + errors.join("\n"));
    expect(crashes, "1455 档不得出现 reka 的 Panel size not found 断言").toEqual([]);
    // 让位真的发生了（否则"不崩"可能只是因为压根没走那条路）。
    expect(settled.state, "1455 档必须真的让位（reka 的 data-state=collapsed）").toBe("collapsed");
    expect(settled.handle, "让位后分隔条被 v-if 掉").toBe(false);
});

test("② 1460：同布局、主列不再被挤压 ⇒ 同样不崩（阈值对照）", async ({ page }) => {
    const errors = collectErrors(page);
    await boot(page, 1460);
    const settled = await settle(page);
    const crashes = errors.filter((line) => line.includes(CRASH_TOKEN));
    console.log(
        `[task-147] 1460 ⇒ aside=${settled.aside.toFixed(1)} state=${settled.state} ` +
            `handle=${settled.handle} crash=${crashes.length} err=${errors.length}`,
    );
    if (errors.length > 0) console.log("[task-147] 1460 errors:\n" + errors.join("\n"));
    expect(crashes, "1460 档不得出现 reka 的 Panel size not found 断言").toEqual([]);
});

/**
 * ④ 反向路径：让位**解除**时 AppLayout 先 expand() 再 resizeToWidth(显示夹取)。修前 expand()
 * 同样没过门；修后它进同一条有序队列，重放顺序必须保住（expand 会用 panelSizeBeforeCollapse
 * 覆盖布局，resize 必须落在它之后）。这条在真浏览器里钉住"展开方向也不崩、且真的展开回去"。
 */
test("④ 1455 让位 → 视口放大到 1920：展开重放不崩，nav 回到 336", async ({ page }) => {
    const errors = collectErrors(page);
    await boot(page, 1455);
    await settle(page);
    await expect
        .poll(async () => (await read(page)).state, { timeout: EXPECT_TIMEOUT_MS })
        .toBe("collapsed");

    errors.length = 0;
    await page.setViewportSize({ width: 1920, height: 900 });
    await expect
        .poll(async () => (await read(page)).state, { timeout: EXPECT_TIMEOUT_MS })
        .toBe("expanded");
    const settled = await settle(page);
    const crashes = errors.filter((line) => line.includes(CRASH_TOKEN));
    console.log(
        `[task-147] 1455→1920 ⇒ aside=${settled.aside.toFixed(1)} state=${settled.state} ` +
            `handle=${settled.handle} crash=${crashes.length} err=${errors.length}`,
    );
    if (errors.length > 0) console.log("[task-147] 1455→1920 errors:\n" + errors.join("\n"));
    expect(crashes).toEqual([]);
    expect(settled.handle, "展开后分隔条回来").toBe(true);
});

/**
 * ③ 这条覆盖的是 P0 的理由本身：`D-1754 ④` 判据 3 一旦让 `deriveDockMode` 恒 pinned，
 * **所有 ≤1455 档**都会走同一条让位时序。修前它们是"按视口宽度成片崩"，所以判据必须是
 * 全档位扫一遍（而不是只钉 1455 一个点）。
 */
test("③ 扫全档位：1280 / 1440 / 1455 / 1500 / 1600 / 1920 全部零崩栈", async ({ page }) => {
    const errors = collectErrors(page);
    await setupMockAuth(page);
    await setupMockSessions(page, { sessions: [{ id: "session-1", title: "Session 1" }] });
    await seedLayout(page);
    const readings: string[] = [];
    for (const width of [1280, 1440, 1455, 1500, 1600, 1920]) {
        await page.setViewportSize({ width, height: 900 });
        errors.length = 0;
        await page.goto(WORKSPACE_PATH);
        await page.waitForSelector('[data-testid="workspace-workbench"]', {
            state: "attached",
            timeout: EXPECT_TIMEOUT_MS,
        });
        const settled = await settle(page);
        const crashes = errors.filter((line) => line.includes(CRASH_TOKEN));
        readings.push(
            `${width}: aside=${settled.aside.toFixed(1)} state=${settled.state} crash=${crashes.length}`,
        );
        expect(crashes, `${width} 档出现崩栈：` + crashes.join(" || ")).toEqual([]);
    }
    console.log("[task-147] sweep ⇒ " + readings.join(" | "));
    // 至少一个档位必须真的让位，否则这条 sweep 什么也没覆盖。
    expect(readings.some((line) => line.includes("state=collapsed"))).toBe(true);
});
