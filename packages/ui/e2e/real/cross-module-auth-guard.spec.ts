import { generateE2EPassword } from "./helpers/password";
import { gotoWorkspaceWithChat } from "./helpers/chat";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS } from "../timeouts";

const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();
import { test, expect } from "@playwright/test";

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;

test.describe("Cross-Module — Auth Guard", () => {
    test("authenticated user can access chat page", async ({ page }) => {
        const email = `auth-${Date.now()}@test.com`;
        const reg = await fetch(`${CP_URL}/api/v1/auth/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password: SHARED_PASSWORD, name: "AuthTest" }),
        });
        const { accessToken } = await reg.json();

        await page.addInitScript((token) => {
            localStorage.setItem("xihe-token", token);
        }, accessToken);

        await gotoWorkspaceWithChat(page);
    });

    test("unauthenticated user is redirected to login", async ({ page }) => {
        await page.goto("/workspace");
        await page.waitForURL(/\/login/, { timeout: ACTION_TIMEOUT_MS });
        expect(page.url()).toContain("/login");
    });

    test("legacy chat route recovers to workspace landing", async ({ page }) => {
        const reg = await fetch(`${CP_URL}/api/v1/auth/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                email: `legacy-${Date.now()}@test.com`,
                password: SHARED_PASSWORD,
                name: "Legacy",
            }),
        });
        const { accessToken } = await reg.json();

        await page.addInitScript((token) => {
            localStorage.setItem("xihe-token", token);
        }, accessToken);

        await page.goto("/chat/legacy-session");
        await page.waitForURL(/\/workspace/, { timeout: ACTION_TIMEOUT_MS });
        await expect(page.locator('[data-testid="sidebar"]')).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
    });
});
