import { expect, test } from "./helpers/mock-test";
import type { Page } from "@playwright/test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { expectPlatformScreenshot } from "../helpers/visual";
import { EXPECT_TIMEOUT_MS } from "../timeouts";

/**
 * P-class fix coverage: the desktop navigation panel used to be a one-way door.
 * The collapse control sits in the panel head, and the only other re-open control
 * (`mobile-sidebar-toggle`) renders for `isMobile` only.
 *
 * PLAN-0762 T2.1（`f97bdf039`，2026-11-11）之后机制又变了一次：全局 56px 条上移到 `App.vue`
 * 的 `GlobalRail`，工作区面板折叠时不再以 0 宽留在 DOM，而是**改渲染**折叠条
 * `sidebar-collapsed-strip`（`Sidebar.vue:155-170`，`v-if`；面板走 `v-else` 不进 DOM），
 * 重开控件 = 同一条上的 `sidebar-expand`。自动让位（`forceCollapsed`）不渲染该条 ——
 * 那时面板保留但被 `aria-hidden`/`inert` 关掉。
 *
 * 行号口径：本文件引用的源码行号均截至 `a813ffab01d2`；不带 SHA 的行号会漂。
 */
async function collectPageErrors(page: Page): Promise<string[]> {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
        if (message.type() !== "error") return;
        // The stub traffic below deliberately 404s nothing, but keep the browser's own
        // resource line out of the app-error budget like the other mock specs do.
        if (/Failed to load resource/.test(message.text())) return;
        errors.push(message.text());
    });
    return errors;
}

/**
 * The workspace page also projects the bound session's derived state and follow-up
 * queue. The shared session helper answers 404 for those two sub-paths, which is a
 * fixture gap unrelated to layout; stub them here so the console assertion below
 * stays about the sidebar.
 */
async function stubSessionProjections(page: Page): Promise<void> {
    await page.route("**/api/v1/sessions/*/derived-state", async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ sessionId: "sid-1", activeChildren: [], terminalNotices: [] }),
        });
    });
    await page.route("**/api/v1/sessions/*/follow-ups", async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                sessionId: "sid-1",
                queueState: "empty",
                outstandingCount: 0,
                capacityLimit: 8,
                pauseReason: null,
                items: [],
            }),
        });
    });
}

/**
 * Width of a shell box in CSS px, read from the **layout box**.
 *
 * 68140c7bb (导航面板迁 reka Splitter) 之后宽度由 flex-grow 拥有：Sidebar.vue:79 的 panelStyle 在桌面端
 * 返回 undefined、Sidebar.vue:100 明确「本组件不再写 style.width」⇒ `element.style.width` 恒为空串，
 * `parseFloat("")` 得 NaN。NaN 不是「宽度很小」，是「读数来源不存在」—— 所以这里改读 getBoundingClientRect。
 */
async function boxWidth(locator: ReturnType<Page["getByTestId"]>): Promise<number> {
    return Math.round(await locator.evaluate((element) => element.getBoundingClientRect().width));
}

/**
 * 宽度稳定值：连续两次采样相同才返回。
 *
 * 折叠/展开有 300 ms 过渡（Sidebar.vue: `transition-[flex-grow] duration-300`），
 * 只 poll 一次「> 0」会抓到过渡中途的宽度（实测曾抓到 57，而稳态是 337）⇒
 * 「回到展开宽度」这条断言会拿中途值当基准，差 280 px 假红。
 *
 * 为什么是「连续两次采样相同」而不是固定等待一段时长：
 *   ① 固定等待把**过渡时长的具体值**写进测试（300 ms 只是当前实现），实现改成 150/500 ms 就假红或假绿；
 *      「连续两次相同」只假设「布局稳定后不再变化」，与时长无关 —— 与 D-889 同一条逻辑（写性质，不写结果值）。
 *   ② 过渡可能被中途打断或重定向（连续点折叠/展开），固定等待会在被打断时提前返回一个不稳定的值；
 *      轮询式判据在下一次采样发现变化会继续等。
 *   ③ 代价（写清楚才不会误用）：若两次采样恰好落在过渡的平缓段，会提前返回一次 —— 所以它只用来取**基准**，
 *      终态另有离散断言兜底（`sidebar-expand` 的计数 + 折叠条可见性），不靠宽度量测证明「折叠了」。
 */
async function settledWidth(locator: ReturnType<Page["getByTestId"]>): Promise<number> {
    let previous = -1;
    await expect
        .poll(
            async () => {
                const width = await boxWidth(locator);
                const stable = width === previous;
                previous = width;
                return stable;
            },
            { timeout: EXPECT_TIMEOUT_MS },
        )
        .toBe(true);
    return await boxWidth(locator);
}

async function collapseThenReopenFromCollapsedStrip(page: Page): Promise<void> {
    // `aside` alone is ambiguous: the workspace dock (`workspace-aux-panel`, PLAN-0582) is an
    // <aside> too, so the shell's navigation panel must be addressed by its stable testid.
    const sidebar = page.getByTestId("sidebar"),
        panel = page.getByTestId("sidebar-panel");
    await expect(sidebar).toHaveCount(1);
    await expect(panel).toBeVisible();
    // 展开态：面板占实际宽度，且没有被 inert/aria-hidden 关掉（折叠语义的正面）。
    await expect.poll(async () => await boxWidth(panel)).toBeGreaterThan(0);
    const expandedWidth = await settledWidth(panel);
    await expect(panel).not.toHaveAttribute("aria-hidden", "true");
    expect(await panel.evaluate((element) => (element as HTMLElement).inert)).toBe(false);

    // The collapse control lives in the panel head (S2 ruling #1).
    await page.getByTestId("sidebar-collapse").click();

    // 折叠态（PLAN-0762 T2.1）：面板不再以 0 宽留在 DOM —— `Sidebar.vue` 改渲染 56px 折叠条
    // （`sidebar-collapsed-strip`，`v-if`；面板走 `v-else` 不进 DOM）。所以判据从旧实现的
    // 「aria-hidden/inert + 残宽≈0」改成「面板不可见 + 折叠条可见 + 折叠条比展开态窄」。
    // 仍不写死 56：宽度由壳层 splitter 的 `collapsedSize` 决定，写死就是把下一次布局调整变成
    // 假红（同 D-889 的写法：写性质，不写结果值）。
    const strip = page.getByTestId("sidebar-collapsed-strip");
    await expect(strip).toBeVisible();
    await expect(panel).toBeHidden(); // 对「元素不在 DOM」同样成立
    // 宽度要**等到达稳态再取**：折叠有 300 ms 过渡，点击后第一帧的折叠条还是展开宽，
    // 直接取值会把过渡中途当终态（与 `settledWidth` 注释里那次 57 vs 337 同一个坑）。
    await expect.poll(async () => await boxWidth(strip)).toBeLessThan(expandedWidth);
    const stripWidth = await boxWidth(strip);
    expect(stripWidth).toBeGreaterThan(0);
    await expect.poll(async () => await boxWidth(sidebar)).toBeLessThan(expandedWidth);

    // 折叠条是折叠后唯一存活的入口面，重开控件必须在那上面 —— 可达、标签正确、
    // 且不与面板头控件共存（两个控件同时可见就是新缺陷，不是「多一条路」）。
    const reopen = page.getByTestId("sidebar-expand");
    await expect(reopen).toBeVisible();
    await expect(reopen).toHaveAttribute("aria-label", "展开侧边栏");
    await expect(reopen).toHaveAttribute("title", "展开侧边栏");
    // 旧 `NavRail` 的展开按钮带 `aria-controls`/`aria-expanded`，折叠条这版只有 label/title
    // （`Sidebar.vue:160-169`）⇒ 这里只断它确实位于折叠条内，不断言那两个属性。
    await expect(strip.getByTestId("sidebar-expand")).toHaveCount(1);

    await reopen.click();

    // Re-open must restore the panel (not just clear aria-hidden), and the collapsed-only
    // control must disappear so the two controls never coexist. 「恢复」用两条独立的读数证明：
    // ① 面板重新可见且有宽度 ② 回到折叠前的宽度（±2 px，容过渡与取整）；宽度不是 0 只说明
    // 「有东西」，不说明「回到了原样」，所以两条都要。
    await expect(panel).toBeVisible();
    await expect.poll(async () => await boxWidth(panel)).toBeGreaterThan(0);
    expect(Math.abs((await settledWidth(panel)) - expandedWidth)).toBeLessThanOrEqual(2);
    expect(await panel.evaluate((element) => (element as HTMLElement).inert)).toBe(false);
    await expect(reopen).toHaveCount(0);
    await expect(page.getByTestId("sidebar-collapse")).toHaveAttribute("aria-expanded", "true");
    // 展开后壳宽必须大于折叠条宽（否则「恢复」只是把面板变回 0 又没露出条之外的区域）。
    expect(await boxWidth(sidebar)).toBeGreaterThan(stripWidth);
}

/**
 * D-933（用户 2026-11-11 裁定）：全局条上的 admin 入口**直接移除、不设替代入口** ——
 * `config-locks`/`roles` 归设置区安全组（导航按能力过滤）。所以这条断言的是「不存在」，
 * 不是「换个元素继续找入口」：谁把 `NavRail`（或等价 admin 独立入口）挂回来，这里必红。
 *
 * 为什么挂在既有用例上而不新开一条：`mise run check:mock-baseline` 以 `expected`/`skipped`
 * 计数对齐 `e2e/mock-baseline.json`，**新增用例 = 计数漂移**；本卡边界只动两个 spec 文件、
 * 不动基线，所以两个折叠用例各带一次这条断言（默认视口 + 1440）。
 */
async function expectNoAdminEntryOnGlobalRail(page: Page): Promise<void> {
    const rail = page.getByTestId("global-rail");
    await expect(rail).toBeVisible();
    // 旧 NavRail 的两个 testid 整体不得再出现在页面上（组件本体仍在树里，但产品零挂载）。
    await expect(page.getByTestId("nav-rail")).toHaveCount(0);
    await expect(page.getByTestId("nav-rail-admin")).toHaveCount(0);
    // 全局条恰好四个入口（工作台 / 资源 / 设置 / 登出）；模块入口三个，登出单列。
    await expect(page.getByTestId("global-rail-module-workbench")).toHaveCount(1);
    await expect(page.getByTestId("global-rail-module-resources")).toHaveCount(1);
    await expect(page.getByTestId("global-rail-module-settings")).toHaveCount(1);
    await expect(page.getByTestId("global-rail-logout")).toHaveCount(1);
    await expect(rail.getByTestId(/^global-rail-module-/)).toHaveCount(3);
}

test.describe("Session Management", () => {
    test.beforeEach(async ({ page }) => {
        await setupMockAuth(page);
        await setupMockSessions(page, {
            sessions: [
                { id: "sid-1", title: "Alpha" },
                {
                    id: "sid-2",
                    title: "Beta",
                    createdAt: new Date(Date.now() - 86400000).toISOString(),
                },
                {
                    id: "sid-3",
                    title: "Gamma",
                    createdAt: new Date(Date.now() - 2 * 86400000).toISOString(),
                },
            ],
        });
    });

    test("sidebar lists all seeded sessions", async ({ page }) => {
        await page.goto("/workspace/workspace-1/chat/sid-1");

        await expect(page.locator("aside >> text=Alpha")).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(page.locator("aside >> text=Beta")).toBeVisible();
        await expect(page.locator("aside >> text=Gamma")).toBeVisible();
        await expectPlatformScreenshot(page, "session-list-all.png");
    });

    test("clicking a session selects it as active", async ({ page }) => {
        await page.goto("/workspace/workspace-1/chat/sid-1");

        await page.locator("aside >> text=Beta").click();

        // 行选中态在外层 [data-testid=session-item]（SessionItem.vue:96）；delegation badge
        // 引入后 text 的父节点是内层 flex 行，旧的 xpath=.. 已漂移。
        const betaRow = page.locator('[data-testid="session-item"]').filter({ hasText: "Beta" });
        await expect(betaRow).toHaveClass(/bg-accent/);
        await expect(betaRow).toHaveAttribute("aria-current", "page");
    });

    test("sidebar time group headers are visible", async ({ page }) => {
        await page.goto("/workspace/workspace-1/chat/sid-1");

        await expect(page.locator("aside >> text=今天").first()).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expectPlatformScreenshot(page, "session-time-groups.png");
    });

    test("sidebar collapse hides the navigation panel and the collapsed strip re-opens it", async ({
        page,
    }) => {
        const pageErrors = await collectPageErrors(page);
        await stubSessionProjections(page);
        await page.goto("/workspace/workspace-1/chat/sid-1");

        await collapseThenReopenFromCollapsedStrip(page);
        await expectNoAdminEntryOnGlobalRail(page);
        expect(pageErrors).toEqual([]);
    });

    test.describe("1440 viewport", () => {
        test.use({ viewport: { width: 1440, height: 900 } });

        test("collapse and strip re-open work at 1440 as well", async ({ page }) => {
            const pageErrors = await collectPageErrors(page);
            await stubSessionProjections(page);
            await page.goto("/workspace/workspace-1/chat/sid-1");

            await collapseThenReopenFromCollapsedStrip(page);
            await expectNoAdminEntryOnGlobalRail(page);
            expect(pageErrors).toEqual([]);
        });
    });
});
