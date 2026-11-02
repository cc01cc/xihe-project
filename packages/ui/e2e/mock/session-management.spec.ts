import { test, expect } from "@playwright/test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { expectPlatformScreenshot } from "../helpers/visual";

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

        await expect(page.locator("aside >> text=Alpha")).toBeVisible({ timeout: 5000 });
        await expect(page.locator("aside >> text=Beta")).toBeVisible();
        await expect(page.locator("aside >> text=Gamma")).toBeVisible();
        await expectPlatformScreenshot(page, "session-list-all.png");
    });

    test("clicking a session selects it as active", async ({ page }) => {
        await page.goto("/workspace/workspace-1/chat/sid-1");

        await page.locator("aside >> text=Beta").click();

        await expect(page.locator("aside >> text=Beta").locator("xpath=..")).toHaveClass(
            /bg-accent/,
        );
    });

    test("sidebar time group headers are visible", async ({ page }) => {
        await page.goto("/workspace/workspace-1/chat/sid-1");

        await expect(page.locator("aside >> text=今天").first()).toBeVisible({ timeout: 5000 });
        await expectPlatformScreenshot(page, "session-time-groups.png");
    });

    test("sidebar collapse hides the navigation panel and keeps the icon rail", async ({
        page,
    }) => {
        await page.goto("/workspace/workspace-1/chat/sid-1");

        // `aside` alone is ambiguous: the workspace dock (`workspace-aux-panel`, PLAN-0582) is an
        // <aside> too, so the shell's navigation panel must be addressed by its stable testid.
        const sidebar = page.getByTestId("sidebar"),
            panel = page.getByTestId("sidebar-panel");
        await expect(sidebar).toHaveCount(1);
        await expect(panel).toBeVisible();
        const expandedWidth = await panel.evaluate((element) => parseFloat(element.style.width));
        expect(expandedWidth).toBeGreaterThan(0);

        // The collapse control lives in the panel head (S2 ruling #1); the first `<button>` inside
        // the shell is a rail item, so it must be addressed by testid as well.
        await page.getByTestId("sidebar-collapse").click();

        // Collapsed state as the user sees it: the panel takes 0 px and is inert, while the 56 px
        // icon rail stays — the shell no longer shrinks to a 1 px border.
        await expect(panel).toHaveAttribute("style", /width: 0px/);
        await expect(panel).toHaveAttribute("aria-hidden", "true");
        await expect(sidebar).toHaveAttribute("style", /width: 56px/);
        await expect(page.getByTestId("nav-rail")).toBeVisible();

        // NOTE (reported, not asserted): re-expanding is impossible on desktop today — the collapse
        // control lives inside the now-0-px inert panel, and the only other re-open control
        // (`mobile-sidebar-toggle`) is rendered for `isMobile` only (`AppLayout.vue:175-185`).
        // `useWorkspaceLayout.toggleNav()` exists but has no UI caller. That is a product gap
        // (P-class), so this case stops at the observable collapsed state instead of encoding it.
    });
});
