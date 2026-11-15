import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { EXPECT_TIMEOUT_MS } from "../timeouts";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "task174-a1-session";

function log(tag: string, payload: Record<string, unknown>): void {
    console.log("[task174-a1] " + tag + " " + JSON.stringify(payload));
}

test.describe("task-174 A1", () => {
    test("工具栏零残留 + 开关 6→5", async ({ page }) => {
        await setupMockAuth(page, {});
        await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "A1" }] });
        await page.goto("/workspace/" + WORKSPACE_ID + "/chat/" + SESSION_ID);
        await page
            .locator('[data-testid="workspace-main"]')
            .waitFor({ state: "visible", timeout: EXPECT_TIMEOUT_MS });
        const legacyEntry = await page.locator('[data-testid="workspace-toolbar-agents"]').count();
        const menuEntry = await page
            .locator('[data-testid="workspace-toolbar-more-agents"]')
            .count();
        const toggles = await page
            .locator(
                [
                    '[data-testid="workspace-toolbar-code"]',
                    '[data-testid="workspace-toolbar-changes"]',
                    '[data-testid="workspace-toolbar-monitor"]',
                    '[data-testid="workspace-toolbar-members"]',
                    '[data-testid="workspace-toolbar-delegation"]',
                ].join(", "),
            )
            .count();
        log("a1-toolbar", { legacyEntry, menuEntry, panelToggles: toggles });
        expect(legacyEntry, "A1：工具栏 Bot 入口零残留").toBe(0);
        expect(menuEntry, "A1：溢出菜单 agents 入口零残留").toBe(0);
        expect(toggles, "A1：面板开关 = 5").toBe(5);
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
        const menuAgents = await page
            .locator('[data-testid="workspace-toolbar-more-agents"]')
            .count();
        log("a1-narrow", { pageEntries, menuAgents });
        expect(pageEntries, "A1：窄屏三页面入口仍为 3").toBe(3);
        expect(menuAgents, "A1：窄屏菜单 agents 入口零残留").toBe(0);
    });
});
