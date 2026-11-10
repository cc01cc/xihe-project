import { expect, test } from "./helpers/mock-test";
import { expectPlatformScreenshot } from "../helpers/visual";

test.describe("Authentication", () => {
    test.beforeEach(async ({ page }) => {
        await page.route("**/api/v1/**", async (route) => {
            const url = route.request().url();

            // PLAN-0699 M1：本 spec 的 catch-all 后注册于公共 fixture，会把 bootstrap-status
            // 落回 Vite proxy（无后端 ⇒ 502 + console-error 门禁假红）；这里显式桩成与路由守卫
            // 失败回退一致的语义（`router/index.ts` `{initialized:true}`）。
            if (url.includes("/auth/bootstrap-status")) {
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({ initialized: true }),
                });
            } else if (url.includes("/register")) {
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({
                        token: "mock-token",
                        user: { id: "user-1", username: "newuser" },
                    }),
                });
            } else if (url.includes("/login")) {
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({
                        token: "mock-token",
                        user: { id: "user-1", username: "testuser" },
                    }),
                });
            } else if (url.includes("/events")) {
                await route.fulfill({
                    status: 200,
                    headers: { "Content-Type": "text/event-stream" },
                    body: new ReadableStream({
                        start(controller) {
                            controller.enqueue(new TextEncoder().encode("retry: 5000\n\n"));
                        },
                    }),
                });
            } else {
                await route.continue();
            }
        });
    });

    test("login page renders", async ({ page }) => {
        await page.goto("/login");
        await expect(page).toHaveURL(/\/login/);
        await expectPlatformScreenshot(page, "login-page.png");
    });

    test("register page renders", async ({ page }) => {
        await page.goto("/register");
        await expect(page).toHaveURL(/\/register/);
        await expectPlatformScreenshot(page, "register-page.png");
    });
});
