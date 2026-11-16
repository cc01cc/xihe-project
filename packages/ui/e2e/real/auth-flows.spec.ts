// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
// lane 说明（T-2318 逐测试标注，先例 ui-health.spec.ts:112）：两条纯行为用例带 profile 标记
// （88bdefd3a 真栈实测绿 956ms / 1.5s，all-profile）；「register → logout → login」在 HEAD 已知红
// （Sidebar.vue:350 v-if="isMobile"，桌面视口 logout 不渲染，待定性另立卡）故不标注；
// 「wrong password」内嵌视觉断言（helpers/visual.ts 非 linux 平台 skip）故不标注。
// 分类证据：internal/A03-xihe/evidence/2026-11-16-host-spec-lane/classification.md
import { generateE2EPassword } from "./helpers/password";
import { ensureWorkspaceChat } from "./helpers/chat";
import { test, expect } from "@playwright/test";
import { expectPlatformScreenshot } from "../helpers/visual";
import { seedSession } from "../helpers/session-seed";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS, LONG_TIMEOUT_MS } from "../timeouts";

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;
const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();

test.describe("Auth — UI Flows & Error States", () => {
    test("register → logout → login full UI flow", async ({ page }) => {
        const email = `flow-${Date.now()}@test.com`;

        await page.goto("/register");
        await page.locator('input[type="text"]').first().fill(email);
        await page.locator('input[type="password"]').nth(0).fill(SHARED_PASSWORD);
        await page.locator('input[type="password"]').nth(1).fill(SHARED_PASSWORD);
        await page.locator('button[type="submit"]').click();
        // 登录/进站落模块入口 /workbench（task-34 / D-1122）：/workspace 已是 redirect 入口
        await page.waitForURL(/\/workbench/, { timeout: LONG_TIMEOUT_MS });

        // task-47: 桌面登出入口已收敛到 App.vue 常驻的 GlobalRail（PLAN-0762 T2.1），
        // testid 见 components/sidebar/GlobalRail.vue:317（global-rail-logout）；
        // Sidebar.vue:349-376 的用户/设置/退出块仅移动端抽屉渲染（v-if="isMobile"）。
        const logoutBtn = page.getByTestId("global-rail-logout");
        await expect(logoutBtn).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await logoutBtn.click();
        await page.waitForURL(/\/login/, { timeout: ACTION_TIMEOUT_MS });

        await page.locator('input[type="text"]').first().fill(email);
        await page.locator('input[type="password"]').first().fill(SHARED_PASSWORD);
        await page.locator('button[type="submit"]').click();
        // 登录/进站落模块入口 /workbench（task-34 / D-1122）：/workspace 已是 redirect 入口
        await page.waitForURL(/\/workbench/, { timeout: LONG_TIMEOUT_MS });
        await ensureWorkspaceChat(page);
    });

    test("wrong password shows Problem Details error without layout breakage", async ({
        page,
        request,
    }) => {
        const email = `wrongpw-${Date.now()}@test.com`;
        const reg = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: { email, password: SHARED_PASSWORD, name: "WrongPw" },
        });
        expect(reg.ok()).toBe(true);

        await page.goto("/login");
        await page.locator('input[type="text"]').first().fill(email);
        await page.locator('input[type="password"]').first().fill(generateE2EPassword());
        await page.locator('button[type="submit"]').click();

        const errorEl = page.locator("p.text-destructive").first();
        await expect(errorEl).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        const errorText = await errorEl.innerText();
        expect(errorText).not.toMatch(/\[object Object\]/);
        expect(errorText).not.toMatch(/ProblemDetails|com\.cc01cc/);
        await expectPlatformScreenshot(page, "auth-login-error.png");
    });

    test("@host authenticated user visiting /login does not flash login form", async ({
        page,
        request,
    }) => {
        const reg = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: {
                email: `redir-${Date.now()}@test.com`,
                password: SHARED_PASSWORD,
                name: "Redir",
            },
        });
        const body = await reg.json();
        // task-224 档 3（守卫语义变更，router/index.ts:604）：`/login` 只在**会话材料齐备**
        // （token + 缓存 user 都在）时才弹走；只有 token 的残会话会**停在登录页**。
        // 本用例验的是「完整会话访问 /login 不闪登录表单」⇒ 必须把 user 一并写入，
        // 否则测到的是残 token 情形（那条路径的正确行为是停在登录页，与本用例名相反）。
        await seedSession(page, { token: body.accessToken, user: body.user ?? {} });

        await page.goto("/login");
        // 登录/进站落模块入口 /workbench（task-34 / D-1122）：/workspace 已是 redirect 入口
        await page.waitForURL(/\/workbench/, { timeout: ACTION_TIMEOUT_MS });
        expect(page.url()).toContain("/workbench");
    });

    test("@host session persists across page refresh without sidebar flicker", async ({
        page,
        request,
    }) => {
        const reg = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: {
                email: `refresh-${Date.now()}@test.com`,
                password: SHARED_PASSWORD,
                name: "Refresh",
            },
        });
        const body = await reg.json();
        // 只种 token = **有意**造半个会话（/workspace 不是入口路由，token 即可进入）。
        await seedSession(page, { token: body.accessToken, halfSession: true });

        await page.goto("/workspace");
        await expect(page.locator('[data-testid="sidebar"]')).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await page.reload();
        await expect(page.locator('[data-testid="sidebar"]')).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        expect(page.url()).toContain("/workbench");
    });
});
