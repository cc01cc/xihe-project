import { generateE2EPassword } from "./helpers/password";

const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();
import { test, expect } from "@playwright/test";
import { expectPlatformScreenshot } from "../helpers/visual";

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;

test.describe("Auth — Real Backend", () => {
    let _authToken = "";

    test.beforeAll(async ({ request }) => {
        const r = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: {
                email: `real-auth-${Date.now()}@test.com`,
                password: SHARED_PASSWORD,
                name: "RealAuth",
            },
        });
        if (r.ok()) {
            const body = await r.json();
            _authToken = body.accessToken;
        }
    });

    test("login page loads and shows form", async ({ page }) => {
        await page.goto("/login");
        await expect(page.locator("h1")).toBeVisible({ timeout: 8000 });
        await expectPlatformScreenshot(page, "real-login-page.png");
    });

    test("register page loads and shows form", async ({ page }) => {
        await page.goto("/register");
        await expect(page.locator("h1")).toBeVisible({ timeout: 8000 });
        await expectPlatformScreenshot(page, "real-register-page.png");
    });

    test("navigates to chat after successful login", async ({ page }) => {
        const email = `real-login-${Date.now()}@test.com`;
        // Register first
        const reg = await fetch(`${CP_URL}/api/v1/auth/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password: SHARED_PASSWORD, name: "LoginTest" }),
        });
        expect(reg.ok).toBeTruthy();

        // Login via UI
        await page.goto("/login");
        await page.fill('input[name="email"]', email);
        await page.fill('input[type="password"]', SHARED_PASSWORD);
        await page.click('button[type="submit"]');
        await page.waitForURL(/\/workspace/, { timeout: 10000 });
        await expect(page.locator("#app")).toBeAttached();
    });

    test("double submit during the login transition sends one request", async ({ page }) => {
        const email = `real-once-${Date.now()}@test.com`;
        const reg = await fetch(`${CP_URL}/api/v1/auth/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password: SHARED_PASSWORD, name: "OnceTest" }),
        });
        expect(reg.ok).toBeTruthy();

        let loginRequests = 0;
        page.on("request", (request) => {
            if (request.method() === "POST" && request.url().endsWith("/api/v1/auth/login")) {
                loginRequests += 1;
            }
        });
        // Latency injection keeps the transition observable; the backend is real.
        await page.route("**/api/v1/auth/login", async (route) => {
            await new Promise((resolve) => setTimeout(resolve, 600));
            await route.continue();
        });

        await page.goto("/login");
        await page.fill('input[name="email"]', email);
        await page.fill('input[type="password"]', SHARED_PASSWORD);
        await page.evaluate(() => {
            const form = document.querySelector("form");
            form?.requestSubmit();
            form?.requestSubmit();
        });

        await expect(page.locator('form[aria-busy="true"]')).toBeVisible();
        await expect(page.locator('input[name="email"]')).toBeDisabled();
        await expect(page.locator('input[name="password"]')).toBeDisabled();
        await page.waitForURL(/\/workspace/, { timeout: 10000 });
        expect(loginRequests).toBe(1);
    });

    test("token present redirects /login without a second login POST", async ({ page }) => {
        const email = `real-redirect-${Date.now()}@test.com`;
        const reg = await fetch(`${CP_URL}/api/v1/auth/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password: SHARED_PASSWORD, name: "RedirectTest" }),
        });
        expect(reg.ok).toBeTruthy();

        await page.goto("/login");
        await page.fill('input[name="email"]', email);
        await page.fill('input[type="password"]', SHARED_PASSWORD);
        await page.click('button[type="submit"]');
        await page.waitForURL(/\/workspace/, { timeout: 10000 });

        let loginRequests = 0;
        page.on("request", (request) => {
            if (request.method() === "POST" && request.url().endsWith("/api/v1/auth/login")) {
                loginRequests += 1;
            }
        });
        await page.goto("/login");
        await page.waitForURL(/\/workspace/, { timeout: 10000 });
        expect(loginRequests).toBe(0);
    });

    test("login page fits a 390x844 mobile viewport", async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto("/login");
        await expect(page.locator("h1")).toBeVisible({ timeout: 8000 });
        const overflows = await page.evaluate(
            () => document.documentElement.scrollWidth > window.innerWidth,
        );
        expect(overflows).toBe(false);
        await page.screenshot({ scale: "css", path: "plan-0558-login-mobile.png", fullPage: true });
    });
});
