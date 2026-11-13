import { expect, test } from "./helpers/mock-test";
import { expectPlatformScreenshot } from "../helpers/visual";

test.describe("Authentication", () => {
    test.beforeEach(async ({ page }) => {
        // task-466（D-1322 / D-1363 可达性裁定）：本 spec **不加**会话集合桩，两条理由 —
        // ① **不是同形兜底**：下面 else 分支是 `route.continue()`，不是把一切答成 `200 {}`；
        // ② /login 与 /register 不挂工作区左栏会话分组 ⇒ 不发 `/sessions` 与 `/workspaces/{id}/sessions`。
        // 若将来登录后直跳工作区外壳，按 task-461 / BL-318 先例在兜底**之后**补两形态正则桩（非 GET fallback）。
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
