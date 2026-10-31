import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { generateE2EPassword } from "./helpers/password";
import { CP_URL, evidenceDir } from "./helpers/journey";

// PLAN-0581 T3.3 — 浏览器侧验收：管理员停用账号后，用户上下文的**下一请求** 401 →
// 静默刷新失败 → 跳登录页，且 `xihe-token` / `xihe-refresh-token` / `xihe-user` 三键清空。
// 判据来源：`plans/PLAN-0581-XH-user-management/tasks.md` T3.3（原文）。
// 网络断言口径（Lead 2026-10-31 裁定）：以浏览器侧 `page.on("response")` 为准。
// 本 spec 不依赖 provider / fake LLM（登录与撤销链路和模型无关）。

const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();
const ADMIN_EMAIL = "admin@xihe.local";
const EVIDENCE = evidenceDir("plan-0581-t33");
const AUTH_KEYS = ["xihe-token", "xihe-refresh-token", "xihe-user"] as const;

async function adminToken(request: APIRequestContext): Promise<string> {
    const password = process.env.XIHE_E2E_ADMIN_PASSWORD ?? "";
    expect(password, "XIHE_E2E_ADMIN_PASSWORD must be provided by e2e-host").not.toBe("");
    const login = await request.post(`${CP_URL}/api/v1/auth/login`, {
        data: { identifier: ADMIN_EMAIL, password },
    });
    expect(login.ok(), await login.text()).toBe(true);
    return ((await login.json()) as { accessToken: string }).accessToken;
}

async function registerUser(request: APIRequestContext, name: string) {
    const username = `${name}${Date.now().toString(36).slice(-5)}`;
    const email = `${username}@test.com`;
    const reg = await request.post(`${CP_URL}/api/v1/auth/register`, {
        data: { email, password: SHARED_PASSWORD, username },
    });
    expect([200, 201], `register failed: ${reg.status()} ${await reg.text()}`).toContain(
        reg.status(),
    );
    const body = (await reg.json()) as {
        accessToken: string;
        workspaceId: string;
        user?: { id?: string };
        userId?: string;
    };
    const userId = body.user?.id ?? body.userId;
    expect(userId, "register must return the user id").toBeTruthy();
    return {
        email,
        accessToken: body.accessToken,
        workspaceId: body.workspaceId,
        userId: userId as string,
    };
}

async function loginThroughUi(page: Page, email: string): Promise<void> {
    await page.goto("/login");
    await page.fill('input[name="identifier"]', email);
    await page.fill('input[name="password"]', SHARED_PASSWORD);
    await page.press('input[name="password"]', "Enter");
    await expect(page).toHaveURL(/\/workspace/);
}

/** 浏览器侧 `/api/v1/auth/**` 响应记录器（判据以它为准）。 */
function trackAuthCalls(page: Page) {
    const calls: { path: string; status: number }[] = [];
    page.on("response", (response) => {
        const url = new URL(response.url());
        if (!url.pathname.startsWith("/api/v1/auth/")) return;
        calls.push({ path: url.pathname, status: response.status() });
    });
    return calls;
}

async function authStorage(page: Page) {
    return page.evaluate(
        (keys) => {
            const out: Record<string, string | null> = {};
            for (const key of keys) out[key] = localStorage.getItem(key);
            return out;
        },
        AUTH_KEYS as unknown as string[],
    );
}

test.describe("@host PLAN-0581 T3.3 — 停用账号的浏览器侧失效链路", () => {
    test("1. 被停用用户：下一请求 401 → 刷新失败 → 跳登录页，三键清空", async ({
        page,
        request,
    }) => {
        test.setTimeout(240_000);
        const user = await registerUser(request, "p0581disabled");
        const token = await adminToken(request);
        const calls = trackAuthCalls(page);

        await loginThroughUi(page, user.email);
        const before = await authStorage(page);
        expect(before["xihe-token"], "登录后应有 access token").toBeTruthy();
        expect(before["xihe-user"], "登录后应有 user 快照").toBeTruthy();

        const disabled = await request.patch(`${CP_URL}/api/v1/users/${user.userId}/status`, {
            headers: { Authorization: `Bearer ${token}` },
            data: { status: "DISABLED" },
        });
        expect(disabled.ok(), await disabled.text()).toBe(true);

        // 用户上下文发下一个请求：点选择面里的工作区 → 触发受保护请求
        await page.getByTestId("workspace-picker").waitFor();
        await page.getByTestId(`workspace-picker-item-${user.workspaceId}`).click();

        await expect(page).toHaveURL(/\/login/, { timeout: 60_000 });

        const after = await authStorage(page);
        for (const key of AUTH_KEYS) {
            expect(after[key], `${key} 必须被清除`).toBeNull();
        }

        expect(
            calls.some((c) => c.status === 401),
            `应出现 401：${JSON.stringify(calls)}`,
        ).toBe(true);
        expect(
            calls.some((c) => c.path.endsWith("/auth/refresh") && c.status >= 400),
            `刷新必须失败：${JSON.stringify(calls)}`,
        ).toBe(true);

        await page.screenshot({ path: `${EVIDENCE}/disabled-redirect-login.png` });
    });

    test("2. 反向对照：未被停用的用户同样动作保持登录", async ({ page, request }) => {
        test.setTimeout(180_000);
        const user = await registerUser(request, "p0581active");

        await loginThroughUi(page, user.email);
        await page.getByTestId("workspace-picker").waitFor();
        await page.getByTestId(`workspace-picker-item-${user.workspaceId}`).click();

        await expect(page).toHaveURL(new RegExp(`/workspace/${user.workspaceId}`));
        const storage = await authStorage(page);
        expect(storage["xihe-token"], "正常用户不得被登出").toBeTruthy();
        await page.screenshot({ path: `${EVIDENCE}/active-stays-signed-in.png` });
    });
});
