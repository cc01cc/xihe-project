import { expect, test } from "./helpers/mock-test";
import type { Page } from "@playwright/test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { expectPlatformScreenshot } from "../helpers/visual";

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

async function collapseThenReopenFromRail(page: Page): Promise<void> {
    // `aside` alone is ambiguous: the workspace dock (`workspace-aux-panel`, PLAN-0582) is an
    // <aside> too, so the shell's navigation panel must be addressed by its stable testid.
    const sidebar = page.getByTestId("sidebar"),
        panel = page.getByTestId("sidebar-panel");
    await expect(sidebar).toHaveCount(1);
    await expect(panel).toBeVisible();
    expect(await panel.evaluate((element) => parseFloat(element.style.width))).toBeGreaterThan(0);

    // The collapse control lives in the panel head (S2 ruling #1); the first `<button>` inside
    // the shell is a rail item, so it must be addressed by testid as well.
    await page.getByTestId("sidebar-collapse").click();

    // Collapsed state as the user sees it: the panel takes 0 px and is inert, while the 56 px
    // icon rail stays — the shell no longer shrinks to a 1 px border.
    await expect(panel).toHaveAttribute("style", /width: 0px/);
    await expect(panel).toHaveAttribute("aria-hidden", "true");
    await expect(sidebar).toHaveAttribute("style", /width: 56px/);
    await expect(page.getByTestId("nav-rail")).toBeVisible();

    // The rail is the only surface that survives a collapse, so the re-open control must be
    // there — reachable, correctly labelled, and not duplicating the panel-head control.
    const reopen = page.getByTestId("nav-rail-expand");
    await expect(reopen).toBeVisible();
    await expect(reopen).toHaveAttribute("aria-label", "展开侧边栏");
    await expect(reopen).toHaveAttribute("aria-expanded", "false");
    await expect(reopen).toHaveAttribute("aria-controls", "sidebar-panel");

    await reopen.click();

    // Re-open must restore the panel (not just clear aria-hidden), and the collapsed-only
    // control must disappear so the two controls never coexist.
    await expect(panel).not.toHaveAttribute("aria-hidden", "true");
    await expect
        .poll(async () => panel.evaluate((element) => parseFloat(element.style.width)))
        .toBeGreaterThan(0);
    await expect(reopen).toHaveCount(0);
    await expect(page.getByTestId("sidebar-collapse")).toHaveAttribute("aria-expanded", "true");
    await expect(sidebar).not.toHaveAttribute("style", /width: 56px/);
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
