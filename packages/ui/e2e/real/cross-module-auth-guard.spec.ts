import { generateE2EPassword } from "./helpers/password";
import { gotoWorkspaceWithChat } from "./helpers/chat";
import { ACTION_TIMEOUT_MS } from "../timeouts";
import { seedSession } from "../helpers/session-seed";
import { test, expect } from "@playwright/test";

const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();

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

        // 只种 token = **有意**造半个会话（本用例之后的路径不依赖 user）⇒ 显式声明。
        await seedSession(page, { token: accessToken, halfSession: true });

        await gotoWorkspaceWithChat(page);
    });

    test("unauthenticated user is redirected to login", async ({ page }) => {
        await page.goto("/workspace");
        await page.waitForURL(/\/login/, { timeout: ACTION_TIMEOUT_MS });
        expect(page.url()).toContain("/login");
    });

    // task-373 / D-1228 + D-1236（router/index.ts:546-558）：/chat/:sessionId 自 f36c85895
    // 起是**真实产品路由**（StandaloneChatView，meta.requiresAuth: true），不再 redirect 到
    // workspace landing。原用例「legacy chat route recovers to workspace landing」的前提被
    // 这两条决策取消（该 spec 末次实质修改 0d57f664c / 2026-09-23，前提失效约 7.5 周）。
    // ⇒ E 类处置：按新契约**重写**，而不是把断言改到另一个 URL 蒙过去 —— 本文件是
    //   「Cross-Module — Auth Guard」，/chat 这条路线在守卫面要验的本来就是「需要登录」。
    test("standalone chat route is guarded: unauthenticated access lands on login", async ({
        page,
    }) => {
        await page.goto("/chat/legacy-session");
        await page.waitForURL(/\/login/, { timeout: ACTION_TIMEOUT_MS });
        expect(page.url()).toContain("/login");
    });
});
