// lane: 非 host —— 唯一用例内嵌视觉断言（helpers/visual.ts 非 linux 平台 skip），且用例名「creates new session and navigates to chat」与行为不符（未建会话）；重写后再定 lane（T-2318 分类表）。
import { generateE2EPassword } from "./helpers/password";
import { EXPECT_TIMEOUT_MS } from "../timeouts";
import { test, expect } from "@playwright/test";
import { expectPlatformScreenshot } from "../helpers/visual";

const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;

test.describe("Session Management — Real Backend", () => {
    let authToken = "";

    test.beforeAll(async ({ request }) => {
        const r = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: {
                email: `real-session-${Date.now()}@test.com`,
                password: SHARED_PASSWORD,
                name: "SessionTest",
            },
        });
        if (r.ok()) {
            const body = await r.json();
            authToken = body.accessToken;
        }
    });

    test.beforeEach(async ({ page }) => {
        await page.addInitScript((t) => {
            localStorage.setItem("xihe-token", t);
        }, authToken);
    });

    test("creates new session and navigates to chat", async ({ page }) => {
        await page.goto("/workspace");
        await page.waitForLoadState("load");
        await expect(page.locator('[data-testid="sidebar"]')).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expectPlatformScreenshot(page, "real-session-list.png");
    });
});
