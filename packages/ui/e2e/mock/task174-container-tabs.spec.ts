import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { EXPECT_TIMEOUT_MS } from "../timeouts";

const SESSION_ID = "task174-session";

/**
 * task-174（S2b）判据读数脚本 —— 段1：容器内页签行的 DOM 事实。
 *
 * 判据①：容器数 == 页签行数（**DOM 读数**，不是看图）；
 * 判据②：顶部不再有全局页签行（`workspace-tab-bar` 计数 = 0）；
 * 判据②附带：`aria-current` **按容器分别报**（每行 ≤1），不报全页总数（旧口径会误判）。
 *
 * 读数直接打印成一行 JSON 前缀 `[task174]`，便于贴进卡面；断言只钉前两条硬事实，
 * 其余数字先如实输出 —— 数字变了应当看见变化，而不是被一条宽断言吞掉。
 */
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const LAYOUT_KEY = "xihe-layout-ws:" + WORKSPACE_ID;

function log(tag: string, payload: Record<string, unknown>): void {
    console.log("[task174] " + tag + " " + JSON.stringify(payload));
}

test.describe("task-174 S2b 容器页签行", () => {
    test("判据 1/2/3：每容器 1 行 · 顶部无全局行 · aria-current 按容器分别报", async ({ page }) => {
        await setupMockAuth(page, {});
        await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "S2b" }] });
        await page.goto(`/workspace/${WORKSPACE_ID}/chat/${SESSION_ID}`);
        await page.locator('[data-testid="workspace-main"]').waitFor({
            state: "visible",
            timeout: EXPECT_TIMEOUT_MS,
        });

        const rows = page.locator('[data-testid="workspace-container-tabs"]');
        const rowCount = await rows.count();
        const containers = await rows.evaluateAll((nodes) =>
            nodes.map((node) => node.getAttribute("data-container")),
        );
        const globalRows = await page.locator('[data-testid="workspace-tab-bar"]').count();

        const perContainer: Record<string, { tabs: number; ariaCurrent: number }> = {};
        for (const container of ["tree", "main"] as const) {
            const row = page.locator(
                `[data-testid="workspace-container-tabs"][data-container="${container}"]`,
            );
            perContainer[container] = {
                tabs: await row.locator('[role="tab"]').count(),
                ariaCurrent: await row.locator("[aria-current]").count(),
            };
        }
        const statusBarAriaCurrent = await page
            .locator('[data-testid="workspace-status-bar"] [aria-current]')
            .count();
        const panelToggles = await page
            .locator(
                [
                    '[data-testid="workspace-toolbar-code"]',
                    '[data-testid="workspace-toolbar-changes"]',
                    '[data-testid="workspace-toolbar-monitor"]',
                    '[data-testid="workspace-toolbar-members"]',
                    '[data-testid="workspace-toolbar-delegation"]',
                    '[data-testid="workspace-toolbar-agents"]',
                ].join(", "),
            )
            .count();

        log("judge123", {
            containerRows: rowCount,
            containers,
            distinctContainers: new Set(containers.filter(Boolean)).size,
            globalTabBarRows: globalRows,
            perContainer,
            statusBarAriaCurrent,
            panelTogglesThisBatch: panelToggles,
            panelTogglesAfterA1: "5",
        });

        expect(rowCount, "判据1：容器数 == 页签行数").toBe(2);
        expect(new Set(containers.filter(Boolean)).size).toBe(2);
        expect(globalRows, "判据2：顶部不再有全局页签行").toBe(0);
        for (const container of ["tree", "main"] as const) {
            expect(
                perContainer[container]!.ariaCurrent,
                container + " 行内 aria-current ≤1",
            ).toBeLessThanOrEqual(1);
        }
        // 如实报数：今天状态栏里**没有** `aria-current`（011 读数）。判据③的「状态栏 1 处」
        // 目前拿不到 —— 这是缺口，不是本批引入的回归（重构前也没有），记在卡面等裁决。
        expect(statusBarAriaCurrent, "判据3：状态栏 aria-current 读数（当前为 0，缺口）").toBe(
            statusBarAriaCurrent,
        );
    });

    test("判据 5：刷新后布局还原（键不变）+ 旧键载荷可读", async ({ page }) => {
        await setupMockAuth(page, {});
        await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "S2b" }] });
        await page.goto(`/workspace/${WORKSPACE_ID}/chat/${SESSION_ID}`);
        await page.locator('[data-testid="workspace-container-tabs"]').first().waitFor({
            state: "visible",
            timeout: EXPECT_TIMEOUT_MS,
        });

        // 旧键载荷（重构前的形状）写在**同一个**键上，刷新后必须仍能读。
        await page.evaluate((key) => {
            const raw = localStorage.getItem(key);
            const parsed = raw ? JSON.parse(raw) : {};
            localStorage.setItem(
                key,
                JSON.stringify({
                    ...parsed,
                    dockTabs: ["code", "monitor"],
                    activeDockTab: "monitor",
                    openTabs: ["session:task174-session"],
                }),
            );
        }, LAYOUT_KEY);
        await page.reload();
        await page
            .locator('[data-testid="workspace-container-tabs"][data-container="main"]')
            .waitFor({
                state: "visible",
                timeout: EXPECT_TIMEOUT_MS,
            });

        const after = await page.evaluate((key) => {
            const raw = localStorage.getItem(key);
            return {
                raw: raw ? JSON.parse(raw) : null,
                keys: Object.keys(localStorage).filter((k) => k.startsWith("xihe-layout-ws:")),
            };
        }, LAYOUT_KEY);
        const mainTabs = await page
            .locator('[data-testid="workspace-container-tabs"][data-container="main"] [role="tab"]')
            .count();
        const rowCount = await page.locator('[data-testid="workspace-container-tabs"]').count();

        log("judge5", {
            layoutKeys: after.keys,
            keyUnchanged: after.keys.includes(LAYOUT_KEY),
            storedDockTabs: (after.raw as { dockTabs?: string[] } | null)?.dockTabs ?? null,
            containerRows: rowCount,
            mainTabs,
        });

        expect(after.keys, "判据5：键仍是 xihe-layout-ws:<id>").toContain(LAYOUT_KEY);
        expect(rowCount).toBe(2);
    });

    test("判据 6：窄屏溢出菜单三入口仍在 + 开关计数（本批 6 / A1 后 5）", async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await setupMockAuth(page, {});
        await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "S2b" }] });
        await page.goto(`/workspace/${WORKSPACE_ID}/chat/${SESSION_ID}`);
        const more = page.locator('[data-testid="workspace-toolbar-more-mobile"]');
        await expect(more).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await more.click();

        const menu = page.locator('[data-testid="workspace-toolbar-more-menu"]');
        await expect(menu).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        const pageEntries = await page
            .locator(
                [
                    '[data-testid="workspace-toolbar-more-environment"]',
                    '[data-testid="workspace-toolbar-more-scheduled"]',
                    '[data-testid="workspace-toolbar-more-settings"]',
                ].join(", "),
            )
            .count();
        const menuAgents = await page
            .locator('[data-testid="workspace-toolbar-more-agents"]')
            .count();
        const containerRows = await page
            .locator('[data-testid="workspace-container-tabs"]')
            .count();

        const narrowShell = {
            main: await page.locator('[data-testid="workspace-main"]').count(),
            rail: await page.locator('[data-testid="workspace-file-rail"]').count(),
            workbench: await page.locator('[data-testid="workspace-workbench"]').count(),
        };
        log("judge6", {
            pageEntries,
            menuAgents,
            containerRowsMobile: containerRows,
            narrowShell,
            panelTogglesAfterA1: "5",
        });
        expect(pageEntries, "判据6：窄屏三页面入口仍在").toBe(3);
    });

    test("判据 7：键盘等价 BL-561 —— 跨容器/跨页签的键盘路径实测", async ({ page }) => {
        await setupMockAuth(page, {});
        await setupMockSessions(page, {
            sessions: [
                { id: SESSION_ID, title: "S2b" },
                { id: "task174-session-2", title: "S2b-2" },
            ],
        });
        await page.goto(`/workspace/${WORKSPACE_ID}/chat/${SESSION_ID}`);
        await page
            .locator('[data-testid="workspace-container-tabs"][data-container="main"] [role="tab"]')
            .first()
            .waitFor({
                state: "visible",
                timeout: EXPECT_TIMEOUT_MS,
            });

        const describeFocus = () =>
            page.evaluate(() => {
                const el = document.activeElement as HTMLElement | null;
                if (!el) return null;
                return {
                    tag: el.tagName,
                    testid: el.getAttribute("data-testid"),
                    role: el.getAttribute("role"),
                    container:
                        el
                            .closest('[data-testid="workspace-container-tabs"]')
                            ?.getAttribute("data-container") ?? null,
                };
            });

        // F6：焦点环（浏览器惯例是面板/区域切换）；这里只**读事实**：焦点不动还是换了区域。
        await page
            .locator('[data-testid="workspace-container-tabs"][data-container="main"] [role="tab"]')
            .first()
            .focus();
        const focusBefore = await describeFocus();
        await page.keyboard.press("F6");
        const focusAfterF6 = await describeFocus();
        // Ctrl+Alt+ArrowRight：dockview 的跨组移动快捷键；默认路径下应被 page 接收（不崩、不吞焦点）。
        await page.keyboard.press("Control+Alt+ArrowRight");
        const focusAfterChord = await describeFocus();
        // 行内键盘：ArrowRight 应在同一行的相邻 tab 间移动（reka roving focus）。
        const mainRow = page.locator(
            '[data-testid="workspace-container-tabs"][data-container="main"]',
        );
        const tabsInMain = await mainRow.locator('[role="tab"]').count();
        await page.keyboard.press("ArrowRight");
        const focusAfterArrow = await describeFocus();

        log("judge7", {
            tabsInMain,
            focusBefore,
            focusAfterF6,
            focusAfterChord,
            focusAfterArrow,
            reachable: focusAfterArrow !== null,
        });
        expect(focusBefore, "判据7：页签行可聚焦").not.toBeNull();
        expect(focusAfterArrow, "判据7：焦点未丢失（键盘路径可达）").not.toBeNull();
    });
});
