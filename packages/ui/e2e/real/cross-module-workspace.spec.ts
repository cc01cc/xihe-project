import { generateE2EPassword } from "./helpers/password";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS } from "../timeouts";
import { test, expect } from "@playwright/test";
import { ensureWorkspace } from "./helpers/workspace";

const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;

interface RegisteredUser {
    token: string;
    workspaceId: string;
}

async function registerUser(name: string): Promise<RegisteredUser> {
    const email = `${name}-${Date.now()}@test.com`;
    const reg = await fetch(`${CP_URL}/api/v1/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: SHARED_PASSWORD, name }),
    });
    const body = await reg.json();
    return { token: body.accessToken, workspaceId: body.workspaceId };
}

test.describe("Cross-Module — Workspace", () => {
    test("@host workspace page shows file panel and editor after login", async ({
        page,
        request,
    }) => {
        const { token } = await registerUser("ws");
        // task-769 / PLAN-0614：注册不再创建默认工作区（workspace.ts:8-14），必须 ensureWorkspace。
        const workspaceId = await ensureWorkspace(request, token);
        await page.addInitScript(
            ({ t, ws }) => {
                localStorage.setItem("xihe-token", t);
                localStorage.setItem(
                    "xihe-workspace",
                    JSON.stringify({ id: ws, name: "Default Workspace" }),
                );
            },
            { t: token, ws: workspaceId },
        );

        await page.goto(`/workspace/${workspaceId}`);

        // C3: workspace page identity marker = secondary-nav "会话" entry.
        await expect(page.getByTestId("workspace-nav-sessions")).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        expect(page.url()).toContain("/workspace");
    });

    test("@host workspace page shows empty state when no files exist", async ({
        page,
        request,
    }) => {
        const { token } = await registerUser("ws-empty");
        const workspaceId = await ensureWorkspace(request, token);
        await page.addInitScript(
            ({ t, ws }) => {
                localStorage.setItem("xihe-token", t);
                localStorage.setItem(
                    "xihe-workspace",
                    JSON.stringify({ id: ws, name: "Default Workspace" }),
                );
            },
            { t: token, ws: workspaceId },
        );

        await page.goto(`/workspace/${workspaceId}`);

        await expect(page.getByTestId("workspace-nav-sessions")).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(page.getByText("工作区暂无文件")).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
    });

    test("unauthenticated user is redirected to login", async ({ page }) => {
        const { workspaceId } = await registerUser("ws-anon");
        await page.goto(`/workspace/${workspaceId}`);
        await page.waitForURL(/\/login/, { timeout: ACTION_TIMEOUT_MS });
        expect(page.url()).toContain("/login");
    });
});
