/**
 * PLAN-0702 / BL-327 — 390px mobile safe-area + on-screen keyboard.
 *
 * Judged mechanically (no screenshots-as-assertions):
 * 1. 390x844: every bottom control (composer + input) ends inside 844.5 and the document has no
 *    horizontal overflow (scrollWidth <= 390);
 * 2. keyboard proxy 390x520: the same controls stay inside the shorter viewport and the composer
 *    input is still editable;
 * 3. dark-theme evidence at 1920x1080@2x (chat + workspace settings) for V1.
 */
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { collectPageFailures, expectNoPageFailures } from "./helpers/page-failures";

const SESSION_ID = "plan0702-safe-area";
const MOBILE = { width: 390, height: 844 };
const KEYBOARD = { width: 390, height: 520 };
const DESKTOP = { width: 1920, height: 1080 };

test.use({ viewport: MOBILE, deviceScaleFactor: 2 });

function bottomOf(box: { x: number; y: number; width: number; height: number }): number {
    return box.y + box.height;
}

test("390 composer stays inside viewport before and after the keyboard opens", async ({ page }) => {
    const failures = collectPageFailures(page);
    await setupMockAuth(page);
    await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "Safe area" }] });
    await page.goto(`/workspace/workspace-1/chat/${SESSION_ID}`);

    // At 390px the chat lives in the bottom sheet; open it through the mobile entry.
    await page.getByTestId("mobile-chat-open").first().click();

    // Wait for the sheet's open animation to settle before measuring boxes (a mid-slide
    // boundingBox would report a transient +40px offset).
    const sheet = page.getByTestId("mobile-chat-sheet");
    await expect(sheet).toBeVisible();
    await sheet.evaluate(async (el) => {
        await Promise.all(
            el
                .getAnimations({ subtree: true })
                .map((animation) => animation.finished.catch(() => undefined)),
        );
    });

    const composer = page.getByTestId("chat-composer");
    const input = page.getByTestId("chat-input");
    await expect(composer).toBeVisible();
    await expect(input).toBeVisible();

    const assertInside = async (height: number): Promise<void> => {
        for (const [label, locator] of [
            ["chat-composer", composer],
            ["chat-input", input],
        ] as const) {
            const box = await locator.boundingBox();
            expect(box, label + " must have a bounding box").not.toBeNull();
            expect(
                bottomOf(box!),
                label + " bottom must stay inside " + height,
            ).toBeLessThanOrEqual(height + 0.5);
            expect(box!.x, label + " left edge").toBeGreaterThanOrEqual(-0.5);
            expect(box!.x + box!.width, label + " right edge").toBeLessThanOrEqual(
                MOBILE.width + 0.5,
            );
        }
        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(scrollWidth, "390 layout must not overflow horizontally").toBeLessThanOrEqual(
            MOBILE.width,
        );
    };

    await assertInside(MOBILE.height);

    // Keyboard proxy: a shorter visual viewport (same shape as a virtual keyboard opening).
    await page.setViewportSize(KEYBOARD);
    await page.waitForFunction((h) => window.innerHeight === h, KEYBOARD.height);
    await assertInside(KEYBOARD.height);
    await input.fill("safe-area keyboard check");
    await expect(input).toHaveValue("safe-area keyboard check");

    await page.setViewportSize(MOBILE);
    await assertInside(MOBILE.height);
    expectNoPageFailures(failures);
});

test("dark theme evidence screenshots at 1920x1080@2x", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.addInitScript(() => localStorage.setItem("xihe-theme", JSON.stringify("dark")));
    await setupMockAuth(page);
    await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "Dark evidence" }] });

    // 运行时截图不得写进仓库（曾导致 A03 dirty / promote E_DIRTY_CHECKOUT）。
    // 默认落系统临时目录；正式副本在 one/plans/archive/PLAN-0702-XH-ux-dark-safearea/evidence/screenshots。
    // 需要固定落点时可注入 XIHE_0702_SHOT_DIR（仓库外路径）。
    const outDir = process.env.XIHE_0702_SHOT_DIR ?? join(tmpdir(), "xihe-0702-shots");
    mkdirSync(outDir, { recursive: true });

    await page.goto(`/workspace/workspace-1/chat/${SESSION_ID}`);
    await expect(page.getByTestId("chat-composer")).toBeVisible();
    await page.screenshot({ path: join(outDir, "dark-chat-1920x1080.png") });

    await page.goto("/workspace/workspace-1/settings");
    await expect(page.locator("body")).toBeVisible();
    await page.screenshot({ path: join(outDir, "dark-workspace-settings-1920x1080.png") });
});
