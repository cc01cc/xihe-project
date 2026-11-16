// lane: 待重写 —— 断言仅 "#app" attached（任何页面恒真），与用例名「shows search placeholder」不符，无回归价值；重写断言后再定 lane（T-2318 分类表）。
import { generateE2EPassword } from "./helpers/password";
import { EXPECT_TIMEOUT_MS } from "../timeouts";
import { test, expect } from "@playwright/test";

const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;

test.describe("Message Search", () => {
    let authToken = "";

    test.beforeAll(async ({ request }) => {
        const r = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: { email: `msg-${Date.now()}@test.com`, password: SHARED_PASSWORD, name: "Test" },
        });
        if (r.ok()) {
            const body = await r.json();
            authToken = body.accessToken;
        }
    });

    test("chat page loads with real auth and shows search placeholder", async ({ page }) => {
        expect(authToken).toBeTruthy();
        await page.goto("/workspace");
        await page.evaluate((t) => {
            localStorage.setItem("xihe-token", t);
            localStorage.setItem("xihe-user", JSON.stringify({ id: "real", name: "Test" }));
        }, authToken);
        await page.reload();
        await page.waitForLoadState("load");
        // Chat page rendered
        await expect(page.locator("#app")).toBeAttached({ timeout: EXPECT_TIMEOUT_MS });
    });
});
