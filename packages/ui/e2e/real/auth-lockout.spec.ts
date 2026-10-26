import { expect, test } from "@playwright/test";
import { generateE2EPassword } from "./helpers/password";

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;
const PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();

/**
 * PLAN-0558: exercises the account lockout contract against a stack started
 * with XIHE_CP_AUTH_LOGIN_ACCOUNT_MAX_FAILURES=3 and
 * XIHE_CP_AUTH_LOGIN_ACCOUNT_LOCK_SECONDS=6.
 */
test.describe("Auth lockout — Real Backend", () => {
    test("locks after repeated failures, shows localized copy, then unlocks", async ({ page }) => {
        const email = `real-lockout-${Date.now()}@test.com`;
        const registered = await fetch(`${CP_URL}/api/v1/auth/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password: PASSWORD, name: "LockoutTest" }),
        });
        expect(registered.ok).toBeTruthy();

        await page.goto("/login");
        for (let attempt = 0; attempt < 3; attempt += 1) {
            await page.fill('input[name="email"]', email);
            await page.fill('input[type="password"]', "wrong-password");
            const [response] = await Promise.all([
                page.waitForResponse(
                    (res) =>
                        res.url().endsWith("/api/v1/auth/login") &&
                        res.request().method() === "POST",
                ),
                page.click('button[type="submit"]'),
            ]);
            expect(response.status()).toBe(401);
        }

        await page.fill('input[name="email"]', email);
        await page.fill('input[type="password"]', "wrong-password");
        const [locked] = await Promise.all([
            page.waitForResponse(
                (res) =>
                    res.url().endsWith("/api/v1/auth/login") && res.request().method() === "POST",
            ),
            page.click('button[type="submit"]'),
        ]);
        expect(locked.status()).toBe(429);
        const retryAfter = Number(locked.headers()["retry-after"]);
        expect(retryAfter).toBeGreaterThanOrEqual(1);
        expect(retryAfter).toBeLessThanOrEqual(6);
        await expect(page.getByText(/尝试过于频繁|Too many attempts/)).toBeVisible();

        await expect
            .poll(
                async () => {
                    await page.fill('input[name="email"]', email);
                    await page.fill('input[type="password"]', PASSWORD);
                    const [response] = await Promise.all([
                        page.waitForResponse(
                            (res) =>
                                res.url().endsWith("/api/v1/auth/login") &&
                                res.request().method() === "POST",
                        ),
                        page.click('button[type="submit"]'),
                    ]);
                    return response.status();
                },
                { timeout: 20000, intervals: [1000] },
            )
            .toBe(200);
        await page.waitForURL(/\/workspace/, { timeout: 10000 });
    });
});
