// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
import { generateE2EPassword } from "./helpers/password";
import { gotoWorkspaceWithChat } from "./helpers/chat";
import {
    ACTION_TIMEOUT_MS,
    EXPECT_TIMEOUT_MS,
    LONG_TIMEOUT_MS,
    TEST_TIMEOUT_MS,
} from "../timeouts";

const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();
import { test, expect } from "@playwright/test";
import { expectPlatformScreenshot } from "../helpers/visual";

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;

async function registerAndGetToken(name: string): Promise<string> {
    const email = `${name}-${Date.now()}@test.com`;
    const reg = await fetch(`${CP_URL}/api/v1/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: SHARED_PASSWORD, name }),
    });
    const body = await reg.json();
    return body.accessToken;
}

test.describe("Chat — Interaction & UI States", () => {
    let authToken = "";

    test.beforeAll(async ({ request }) => {
        const r = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: {
                email: `chat-ui-${Date.now()}@test.com`,
                password: SHARED_PASSWORD,
                name: "ChatUI",
            },
        });
        authToken = (await r.json()).accessToken;
    });

    test.beforeEach(async ({ page }) => {
        await page.addInitScript((t) => localStorage.setItem("xihe-token", t), authToken);
        await gotoWorkspaceWithChat(page);
    });

    test("captures immediate state after sending a message", async ({ page }) => {
        const textarea = page.locator("textarea");
        await textarea.fill(`State capture ${Date.now()}`);
        await page.keyboard.press("Enter");
        await page.waitForTimeout(800);
        await expectPlatformScreenshot(page, "chat-after-send.png");
    });

    test("scroll-up reveals back-to-bottom anchor and click returns to bottom", async ({
        page,
    }) => {
        test.setTimeout(TEST_TIMEOUT_MS);
        const textarea = page.locator("textarea"),
            scroller = page.locator('[data-testid="message-scroller-viewport"]');
        const anchorBtn = page.locator('[data-testid="message-scroller-button"]');

        for (let i = 0; i < 12; i++) {
            await textarea.fill(`scroll probe message ${i}`);
            await page.keyboard.press("Enter");
            await expect
                .poll(() => scroller.locator("[data-message-id]").count(), {
                    timeout: EXPECT_TIMEOUT_MS,
                })
                .toBeGreaterThan(i);
        }

        await expect
            .poll(() => scroller.evaluate((el) => el.scrollHeight > el.clientHeight), {
                timeout: ACTION_TIMEOUT_MS,
            })
            .toBe(true);

        await scroller.hover();
        await page.mouse.wheel(0, -1500);
        await expect
            .poll(() => anchorBtn.getAttribute("data-active"), { timeout: EXPECT_TIMEOUT_MS })
            .toBe("true");
        await expect(anchorBtn).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await page.waitForTimeout(500);
        await expectPlatformScreenshot(page, "chat-scroll-anchor.png");

        await anchorBtn.click();
        await page.waitForTimeout(800);
        const atBottom = await scroller.evaluate(
            (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 80,
        );
        expect(atBottom).toBe(true);
    });

    test("user message with markdown table and code renders inside bubble bounds", async ({
        page,
    }) => {
        const md = "```js\nconst x = 1\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |",
            textarea = page.locator("textarea");
        await textarea.fill(md);
        await page.keyboard.press("Enter");

        await page.waitForTimeout(1500);
        const overflow = await page.evaluate(() => {
            const doc = document.scrollingElement;
            return doc ? doc.scrollWidth - doc.clientWidth : 0;
        });
        expect(overflow).toBeLessThanOrEqual(2);
        await expectPlatformScreenshot(page, "chat-markdown-mix.png");
    });

    test("empty chat state renders without browser-default artifacts", async ({ page }) => {
        await page.waitForTimeout(1000);
        await expectPlatformScreenshot(page, "chat-empty-state.png");
    });
});

test.describe("Chat — Session sidebar interaction", () => {
    test("creating session twice shows two entries without overlap", async ({ page }) => {
        const token = await registerAndGetToken("sidebar-two");
        await page.addInitScript((t) => localStorage.setItem("xihe-token", t), token);
        await page.goto("/workspace");
        const newBtn = page
            .locator("button")
            .filter({ hasText: /new|新建/i })
            .first();
        await expect(newBtn).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        const items = page.locator('[data-testid="sidebar"] [data-testid="session-item"]');

        // Sequence the clicks on explicit readiness: a fixed sleep could hit the
        // store's create single-flight and return the same Session twice.
        await newBtn.click();
        await expect
            .poll(() => items.count(), { timeout: LONG_TIMEOUT_MS })
            .toBeGreaterThanOrEqual(1);
        await newBtn.click();
        await expect
            .poll(() => items.count(), { timeout: LONG_TIMEOUT_MS })
            .toBeGreaterThanOrEqual(2);

        const boxes = await items.evaluateAll((els) =>
            els.slice(0, 2).map((el) => el.getBoundingClientRect().toJSON()),
        );
        expect(boxes).toHaveLength(2);
        expect(Math.abs(boxes[0].y - boxes[1].y)).toBeGreaterThan(4);
    });
});
