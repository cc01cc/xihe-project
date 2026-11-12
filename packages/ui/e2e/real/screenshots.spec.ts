// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
import { generateE2EPassword } from "./helpers/password";
import { test, expect } from "@playwright/test";
import { expectPlatformScreenshot } from "../helpers/visual";
import { LONG_TIMEOUT_MS } from "../timeouts";

const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();
const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;

interface Route {
    path: string;
    name: string;
    requiresAuth: boolean;
    useRegisteredWorkspace?: boolean;
    /**
     * 用 register 返回的真实 workspaceId + 一个**必然不存在**的 sessionId 打 chat 路由。
     * 真栈没有「创建会话」夹具（BL 已登记），此前写死 `/workspace/workspace-1/chat/test-session`
     * 的 id 在真库不存在 ⇒ 页面永远是「暂无活动会话」空壳，`chat-input` 永不出现。
     * 本用例改为诚实地拍这张空壳：基线名带 `no-session`，landmark 用工作区视口。
     */
    chatWithoutSession?: boolean;
}

const allRoutes: Route[] = [
    { path: "/login", name: "real-login", requiresAuth: false },
    { path: "/register", name: "real-register", requiresAuth: false },
    { path: "/workspace", name: "real-workspace-default", requiresAuth: true },
    {
        path: "/workspace/workspace-1/chat/test-session",
        name: "real-workspace-chat-route-no-session",
        requiresAuth: true,
        chatWithoutSession: true,
    },
    {
        path: "/settings/user/llm-provider",
        name: "real-settings-user-llm-provider",
        requiresAuth: true,
    },
    { path: "/resources/knowledge", name: "real-resources-knowledge", requiresAuth: true },
    { path: "/settings/data", name: "real-settings-data", requiresAuth: true },
    { path: "/settings/monitoring", name: "real-settings-monitoring", requiresAuth: true },
    {
        path: "/workspace",
        name: "real-workspace",
        requiresAuth: true,
        useRegisteredWorkspace: true,
    },
];

/**
 * 就绪门（task-35 / BL-601 real 车道，与 mock 侧同一套判据）：每条路由等自己的 landmark，
 * 不靠固定 sleep。判据见 evidence/2026-11-13-visual-baseline-readiness/README.md 第 1 节。
 *
 * 为什么必须有门：toHaveScreenshot 对**白页**也会收敛（两次都白就 blank==blank 永久绿），
 * 所以「比较通过」不能当「画出来了」的证据（D-1085 的 2：截图必须带非空断言）。
 */
const readinessLandmarks: Record<string, { testId: string } | { selector: string }> = {
    "real-login": { selector: "form[aria-busy]" },
    "real-register": { selector: "form[aria-busy]" },
    "real-workspace-default": { testId: "workspace-picker" },
    "real-workspace-chat-route-no-session": { testId: "workspace-route-viewport" },
    "real-settings-user-llm-provider": { testId: "settings-domain-title" },
    "real-resources-knowledge": { testId: "resources-knowledge-gap" },
    "real-settings-data": {
        selector:
            '[data-testid="settings-checkpoint-constants"], [data-testid="settings-checkpoint-error"], [data-testid="settings-checkpoint-no-workspace"]',
    },
    "real-settings-monitoring": { testId: "settings-monitoring-heading" },
    "real-workspace": { testId: "workspace-route-viewport" },
};
for (const route of allRoutes) {
    test(`${route.name} renders and captures screenshot`, async ({ page }) => {
        let registeredWorkspaceId: string | undefined;
        if (route.requiresAuth) {
            const email = `screenshot-${Date.now()}@test.com`;
            const reg = await fetch(`${CP_URL}/api/v1/auth/register`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email, password: SHARED_PASSWORD, name: "Screenshot" }),
            });
            if (reg.ok) {
                const body = await reg.json();
                registeredWorkspaceId = body.workspaceId;
                await page.addInitScript((token: string) => {
                    localStorage.setItem("xihe-token", token);
                }, body.accessToken);
            }
        }

        const NO_SUCH_SESSION = "00000000-0000-0000-0000-000000000000";
        const routePath =
            route.chatWithoutSession && registeredWorkspaceId
                ? `/workspace/${registeredWorkspaceId}/chat/${NO_SUCH_SESSION}`
                : route.useRegisteredWorkspace && registeredWorkspaceId
                  ? `/workspace/${registeredWorkspaceId}`
                  : route.path;
        const resp = await page.goto(routePath, { waitUntil: "load", timeout: LONG_TIMEOUT_MS });
        expect(resp?.status()).toBe(200);
        await expect(page.locator("#app")).toBeVisible();
        if (route.useRegisteredWorkspace) {
            await expect(page.getByTestId("workspace-empty-state")).toBeVisible();
        }

        // 就绪门（不用固定 sleep）：等本路由的 landmark 出现。
        const landmark = readinessLandmarks[route.name];
        if (!landmark) throw new Error("no readiness landmark for route " + route.name);
        const gate =
            "testId" in landmark
                ? page.getByTestId(landmark.testId)
                : page.locator(landmark.selector).first();
        await expect(gate).toBeVisible({ timeout: LONG_TIMEOUT_MS });

        // D-1085 的 2 的非空断言：截图前先证明主内容真的挂载了、且占了版面。
        // 只比 sha 相等是禁止的 —— 两次都拍白也能逐字节相同。
        const gateBox = await gate.boundingBox();
        expect(gateBox, "landmark of " + route.name + " has no layout box").not.toBeNull();
        const gateArea = (gateBox?.width ?? 0) * (gateBox?.height ?? 0);
        expect(
            gateArea,
            "landmark of " + route.name + " has ~zero area (blank capture?)",
        ).toBeGreaterThan(1000);
        const bodyTextLength = await page.evaluate(() => document.body.innerText.trim().length);
        expect(
            bodyTextLength,
            "page " + route.name + " rendered no text (blank capture?)",
        ).toBeGreaterThan(0);
        // 逐张把准入级三条读数打出来（不只报 passed）。
        const landmarkName = "testId" in landmark ? landmark.testId : landmark.selector;
        console.log(
            "[readiness] " +
                route.name +
                " landmark=" +
                landmarkName +
                " visible=true box=" +
                Math.round(gateBox?.width ?? 0) +
                "x" +
                Math.round(gateBox?.height ?? 0) +
                " area=" +
                Math.round(gateArea) +
                " bodyTextLength=" +
                bodyTextLength,
        );
        // 字体落地再拍：字体没到时文本度量未定（显式事件等待，不是等时间）。
        await page.evaluate(() => document.fonts.ready.then(() => true));
        await expectPlatformScreenshot(page, route.name + ".png");
    });
}
