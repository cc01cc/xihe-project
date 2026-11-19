import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { EXPECT_TIMEOUT_MS } from "../timeouts";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "task174-a1-session";

function log(tag: string, payload: Record<string, unknown>): void {
    console.log("[task174-a1] " + tag + " " + JSON.stringify(payload));
}

test.describe("task-174 A1", () => {
    test("工具栏零残留 + 唯一开合入口仍在", async ({ page }) => {
        await setupMockAuth(page, {});
        await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "A1" }] });
        await page.goto("/workspace/" + WORKSPACE_ID + "/chat/" + SESSION_ID);
        await page
            .locator('[data-testid="workspace-main"]')
            .waitFor({ state: "visible", timeout: EXPECT_TIMEOUT_MS });
        // task-137（D-1907 图标簇收敛）：六颗桌面面板图标已整体退役，入口收敛为
        // 「主列行尾开合图标 → 右栏 + → 选类型」。判据从「旧图标存在」翻为「零残留」：
        // 先数旧簇（期望 0），再为正数新入口（否则 0 == 0 是空断言、真空绿）。
        const toggles = await page
            .locator('#workspace-nav-actions [data-testid^="workspace-toolbar-"]')
            .count();
        const dockToggleCount = await page
            .locator(
                '[data-testid="workspace-container-tabs"][data-container="main"] [data-testid="workspace-dock-toggle"]',
            )
            .count();
        log("a1-toolbar", { panelToggles: toggles, dockToggleCount });
        expect(
            await page.locator('[data-testid="workspace-toolbar-agents"]').count(),
            "A1：工具栏 Bot 入口零残留",
        ).toBe(0);
        expect(
            await page.locator('[data-testid="workspace-toolbar-more-agents"]').count(),
            "A1：溢出菜单 agents 入口零残留",
        ).toBe(0);
        expect(toggles, "A1：六面板图标零残留").toBe(0);
        // 防真空绿：旧簇为 0 的同时，唯一开合入口必须恰好在场（主列页签行行尾宿主内）。
        expect(dockToggleCount, "A1：唯一开合入口 = 1").toBe(1);
    });

    test("成员页「智能体」tab 可切换", async ({ page }) => {
        await setupMockAuth(page, {});
        await page.goto("/workspace/" + WORKSPACE_ID + "/members");
        const agentsTab = page.locator('[data-testid="members-tab-agents"]');
        const membersTab = page.locator('[data-testid="members-tab-members"]');
        await expect(agentsTab).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        const before = {
            membersSelected: await membersTab.getAttribute("aria-selected"),
            agentsSelected: await agentsTab.getAttribute("aria-selected"),
        };
        await agentsTab.click();
        await expect(agentsTab).toHaveAttribute("aria-selected", "true", {
            timeout: EXPECT_TIMEOUT_MS,
        });
        const after = {
            membersSelected: await membersTab.getAttribute("aria-selected"),
            agentsSelected: await agentsTab.getAttribute("aria-selected"),
        };
        await agentsTab.focus();
        const focused = await page.evaluate(
            () =>
                (document.activeElement as HTMLElement | null)?.getAttribute("data-testid") ?? null,
        );
        await page.keyboard.press("ArrowLeft");
        const afterArrow = await page.evaluate(
            () =>
                (document.activeElement as HTMLElement | null)?.getAttribute("data-testid") ?? null,
        );
        log("a1-members", { before, after, focused, afterArrow });
        expect(before.agentsSelected).not.toBe("true");
        expect(after.agentsSelected).toBe("true");
        expect(focused).toBe("members-tab-agents");
    });

    test("窄屏溢出菜单三页面入口仍在（C3 守卫 task-217）", async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await setupMockAuth(page, {});
        await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "A1" }] });
        await page.goto("/workspace/" + WORKSPACE_ID + "/chat/" + SESSION_ID);
        const more = page.locator('[data-testid="workspace-toolbar-more-mobile"]');
        await expect(more).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await more.click();
        const pageEntries = await page
            .locator(
                [
                    '[data-testid="workspace-toolbar-more-environment"]',
                    '[data-testid="workspace-toolbar-more-scheduled"]',
                    '[data-testid="workspace-toolbar-more-settings"]',
                ].join(", "),
            )
            .count();
        log("a1-narrow", { pageEntries });
        expect(pageEntries, "A1：窄屏三页面入口仍为 3").toBe(3);
        expect(
            await page.locator('[data-testid="workspace-toolbar-more-agents"]').count(),
            "A1：窄屏菜单 agents 入口零残留",
        ).toBe(0);
    });
});
