import { expect, test } from "./helpers/mock-test";
import type { Page } from "@playwright/test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { expectPlatformScreenshot } from "../helpers/visual";
import { EXPECT_TIMEOUT_MS } from "../timeouts";

/**
 * P-class fix coverage: the desktop navigation panel used to be a one-way door.
 * The collapse control sits in the panel head, which becomes 0px + inert, and the
 * only other re-open control (`mobile-sidebar-toggle`) renders for `isMobile`
 * only. The 56px rail survives the collapse, so it now hosts the re-open control.
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

async function collapseThenReopenFromRail(page: Page): Promise<void> {
    // `aside` alone is ambiguous: the workspace dock (`workspace-aux-panel`, PLAN-0582) is an
    // <aside> too, so the shell's navigation panel must be addressed by its stable testid.
    const sidebar = page.getByTestId("sidebar"),
        panel = page.getByTestId("sidebar-panel"),
        rail = page.getByTestId("nav-rail");
    await expect(sidebar).toHaveCount(1);
    await expect(panel).toBeVisible();
    // 展开态：面板占实际宽度，且没有被 inert/aria-hidden 关掉（折叠语义的正面）。
    await expect.poll(async () => await boxWidth(panel)).toBeGreaterThan(0);
    const expandedWidth = await settledWidth(panel);
    await expect(panel).not.toHaveAttribute("aria-hidden", "true");
    expect(await panel.evaluate((element) => (element as HTMLElement).inert)).toBe(false);

    // The collapse control lives in the panel head (S2 ruling #1); the first `<button>` inside
    // the shell is a rail item, so it must be addressed by testid as well.
    await page.getByTestId("sidebar-collapse").click();

    // Collapsed state as the user sees it: 面板缩成一条缝、并转为 inert，rail 存活。
    // 实测（1440x900）：rail = 49 px · 面板残宽 ≈ 6.9 px · 壳宽 ≈ 56.9 px —— 与旧实现写死的
    // 「width: 56px」是同一个可见结果，但通道换了（flex-grow 而不是 inline style）。
    // 所以断言改成**相对几何**：面板必须远窄于展开态、且窄于它躲在其后的 rail；壳宽 ≈ rail + 残宽。
    // 不写死 0 / 56 / 49 —— 那三个数是当前实现的快照，写死就是把下一次布局调整变成假红。
    await expect
        .poll(async () => await boxWidth(panel))
        .toBeLessThanOrEqual(Math.ceil(expandedWidth * 0.1));
    await expect(panel).toHaveAttribute("aria-hidden", "true");
    expect(await panel.evaluate((element) => (element as HTMLElement).inert)).toBe(true);
    await expect(rail).toBeVisible();
    const railWidth = await boxWidth(rail);
    expect(railWidth).toBeGreaterThan(0);
    const collapsedPanelWidth = await boxWidth(panel);
    const collapsedShellWidth = await boxWidth(sidebar);
    expect(collapsedPanelWidth).toBeLessThan(railWidth);
    expect(Math.abs(collapsedShellWidth - (railWidth + collapsedPanelWidth))).toBeLessThanOrEqual(
        2,
    );

    // The rail is the only surface that survives a collapse, so the re-open control must be
    // there — reachable, correctly labelled, and not duplicating the panel-head control.
    const reopen = page.getByTestId("nav-rail-expand");
    await expect(reopen).toBeVisible();
    await expect(reopen).toHaveAttribute("aria-label", "展开侧边栏");
    await expect(reopen).toHaveAttribute("aria-expanded", "false");
    await expect(reopen).toHaveAttribute("aria-controls", "sidebar-panel");

    await reopen.click();

    // Re-open must restore the panel (not just clear aria-hidden), and the collapsed-only
    // control must disappear so the two controls never coexist. 「恢复」用两条独立的读数证明：
    // ① 面板重新有宽度 ② 回到折叠前的宽度（±2 px，容过渡与取整）；宽度不是 0 只说明「有东西」，
    // 不说明「回到了原样」，所以两条都要。
    await expect(panel).not.toHaveAttribute("aria-hidden", "true");
    await expect.poll(async () => await boxWidth(panel)).toBeGreaterThan(0);
    expect(Math.abs((await settledWidth(panel)) - expandedWidth)).toBeLessThanOrEqual(2);
    expect(await panel.evaluate((element) => (element as HTMLElement).inert)).toBe(false);
    await expect(reopen).toHaveCount(0);
    await expect(page.getByTestId("sidebar-collapse")).toHaveAttribute("aria-expanded", "true");
    // 展开后壳宽必须大于 rail 宽（否则「恢复」只是把 panel 变回 0 又没露出 rail 之外的区域）。
    expect(await boxWidth(sidebar)).toBeGreaterThan(railWidth);
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

    test("sidebar collapse hides the navigation panel and the rail re-opens it", async ({
        page,
    }) => {
        const pageErrors = await collectPageErrors(page);
        await stubSessionProjections(page);
        await page.goto("/workspace/workspace-1/chat/sid-1");

        await collapseThenReopenFromRail(page);
        expect(pageErrors).toEqual([]);
    });

    test.describe("1440 viewport", () => {
        test.use({ viewport: { width: 1440, height: 900 } });

        test("collapse and rail re-open work at 1440 as well", async ({ page }) => {
            const pageErrors = await collectPageErrors(page);
            await stubSessionProjections(page);
            await page.goto("/workspace/workspace-1/chat/sid-1");

            await collapseThenReopenFromRail(page);
            expect(pageErrors).toEqual([]);
        });
    });
});
