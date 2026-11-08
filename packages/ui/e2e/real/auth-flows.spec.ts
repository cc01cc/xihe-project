// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
import { generateE2EPassword } from "./helpers/password";
import { ensureWorkspaceChat } from "./helpers/chat";
import { test, expect } from "@playwright/test";
import { expectPlatformScreenshot } from "../helpers/visual";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS, LONG_TIMEOUT_MS } from "../timeouts";

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;
const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();

test.describe("Auth — UI Flows & Error States", () => {
    test("register → logout → login full UI flow", async ({ page }) => {
        const email = `flow-${Date.now()}@test.com`;

        await page.goto("/register");
        await page.locator('input[type="text"]').first().fill(email);
        await page.locator('input[type="password"]').nth(0).fill(SHARED_PASSWORD);
        await page.locator('input[type="password"]').nth(1).fill(SHARED_PASSWORD);
        await page.locator('button[type="submit"]').click();
        await page.waitForURL(/\/workspace/, { timeout: LONG_TIMEOUT_MS });

        const logoutBtn = page
            .locator('[data-testid="sidebar"] button')
            .filter({ hasText: /logout|退出/i })
            .first();
        await expect(logoutBtn).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await logoutBtn.click();
        await page.waitForURL(/\/login/, { timeout: ACTION_TIMEOUT_MS });

        await page.locator('input[type="text"]').first().fill(email);
        await page.locator('input[type="password"]').first().fill(SHARED_PASSWORD);
        await page.locator('button[type="submit"]').click();
        await page.waitForURL(/\/workspace/, { timeout: LONG_TIMEOUT_MS });
        await ensureWorkspaceChat(page);
    });

    test("wrong password shows Problem Details error without layout breakage", async ({
        page,
        request,
    }) => {
        const email = `wrongpw-${Date.now()}@test.com`;
        const reg = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: { email, password: SHARED_PASSWORD, name: "WrongPw" },
        });
        expect(reg.ok()).toBe(true);

        await page.goto("/login");
        await page.locator('input[type="text"]').first().fill(email);
        await page.locator('input[type="password"]').first().fill(generateE2EPassword());
        await page.locator('button[type="submit"]').click();

        const errorEl = page.locator("p.text-destructive").first();
        await expect(errorEl).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        const errorText = await errorEl.innerText();
        expect(errorText).not.toMatch(/\[object Object\]/);
        expect(errorText).not.toMatch(/ProblemDetails|com\.cc01cc/);
        await expectPlatformScreenshot(page, "auth-login-error.png");
    });

    test("authenticated user visiting /login does not flash login form", async ({
        page,
        request,
    }) => {
        const reg = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: {
                email: `redir-${Date.now()}@test.com`,
                password: SHARED_PASSWORD,
                name: "Redir",
            },
        });
        const body = await reg.json();
        await page.addInitScript((t) => localStorage.setItem("xihe-token", t), body.accessToken);

        await page.goto("/login");
        await page.waitForURL(/\/workspace/, { timeout: ACTION_TIMEOUT_MS });
        expect(page.url()).toContain("/workspace");
    });

    test("session persists across page refresh without sidebar flicker", async ({
        page,
        request,
    }) => {
        const reg = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: {
                email: `refresh-${Date.now()}@test.com`,
                password: SHARED_PASSWORD,
                name: "Refresh",
            },
        });
        const body = await reg.json();
        await page.addInitScript((t) => localStorage.setItem("xihe-token", t), body.accessToken);

        await page.goto("/workspace");
        await expect(page.locator('[data-testid="sidebar"]')).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await page.reload();
        await expect(page.locator('[data-testid="sidebar"]')).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        expect(page.url()).toContain("/workspace");
    });
});
