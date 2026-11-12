import { test, expect } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { generateE2EPassword } from "./helpers/password";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS } from "../timeouts";

/**
 * PLAN-0772 / task-224 档 3 — 登录入口守卫的三态（**真栈 lane，@host**）。
 *
 * ## 为什么需要这一条（task-224 的遗留）
 * 档 3 把入口页判据从「localStorage 里有 token 就弹 `/workspace`」改成「token **且** 缓存 user
 * 齐备才弹」。mock lane 完全不触 `/login`（`grep` 证实 `e2e/mock/**` 没有任何 `/login` 导航），
 * 所以这个**浏览器可见的行为变更**只能靠真栈证据：
 *  - A：完整会话误访问 `/login` ⇒ 仍弹 `/workspace`（**旧体验必须保住**，不许被顺手改坏）；
 *  - B：残 token（有 token 无 user）访问 `/login` ⇒ 停在 `/login`（新语义，也是 401 风暴的起点）；
 *  - C：同一批并发 401 ⇒ 登出跳转只发生 **1 次**（档 2 单飞幂等；造不出来就写明未覆盖）。
 *
 * ## 前置（真栈窗口）
 * - 栈已就绪、CP 可 POST `/api/v1/auth/register`（本文件用**随机邮箱现注册**，不依赖既有账号；
 *   `XIHE_CP_PORT` 由 host runner 注入，缺省 12631 与单栈一致）；
 * - 浏览器为 Chrome Beta（`XIHE_E2E_BROWSER_CHANNEL=chrome-beta`，host runner 已注入）；
 * - 运行方式（spec 在 `mock-full`/`real-full` 批的 `e2e/real` 目录里，无需改批清单）：
 *   `mise run test:e2e:host -- --batch=mock-full --only=plan0772-login-entry`
 * - **本卡没有真栈窗口，因此这三条在本卡里只做静态校验**（`typecheck:e2e` + 用例评审），
 *   执行证据要等窗口；`@host` 标签是 host profile 的 grep 门（`playwright.config.ts:42`），
 *   少了它 host lane 会"跑 0 条"而不是红。
 *
 * ## 判据纪律
 * - A/B **断言最终 URL 与登录表单是否渲染**，不断言中间跳转次数（那是 C 的事）；
 * - B 的"停在 `/login`"用 **正面等待**（等登录表单出现）而不是 `waitForURL(/workspace/)` 超时，
 *   避免"没弹走"与"弹得慢"混为一谈；
 * - C 先断言 **401 真的发生过 ≥2 次**（前置成立），再断言跳转 = 1 次 —— 否则前置没造出来时
 *   断言会**空转通过**，那是假绿。
 */

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;

/** 登录表单渲染标志（`LoginView.vue` 的标识输入框，登录页唯一 `#identifier`）。 */
const LOGIN_FORM = "#identifier";

interface RegisteredAccount {
    accessToken: string;
    refreshToken: string;
    user: unknown;
}

/** 每个用例现注册一个账号：真栈上跨用例共享账号会被限流/锁定用例污染。 */
async function registerAccount(
    request: APIRequestContext,
    tag: string,
): Promise<RegisteredAccount> {
    const password = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();
    const response = await request.post(`${CP_URL}/api/v1/auth/register`, {
        data: {
            email: `plan0772-${tag}-${Date.now()}@test.com`,
            password,
            name: `Plan0772 ${tag}`,
        },
    });
    expect(response.ok(), `register failed: ${response.status()}`).toBeTruthy();
    const body = (await response.json()) as Partial<RegisteredAccount>;
    expect(typeof body.accessToken).toBe("string");
    expect(typeof body.refreshToken).toBe("string");
    // 用例 A 的"完整会话"靠 `xihe-user` 才能成立：注册响应必须带 user（store 写缓存的就是它）。
    expect(typeof body.user).toBe("object");
    return body as RegisteredAccount;
}

/** 在页面脚本运行前写 localStorage —— 与既有 `e2e/real` 用例（`cross-module-auth-guard`）同一手法。 */
async function seedSession(
    page: Page,
    seed: { token: string; user?: unknown; refreshToken?: string },
): Promise<void> {
    await page.addInitScript(
        (payload) => {
            localStorage.setItem("xihe-token", payload.token);
            if (payload.user !== undefined) localStorage.setItem("xihe-user", payload.user);
            if (payload.refreshToken)
                localStorage.setItem("xihe-refresh-token", payload.refreshToken);
        },
        {
            token: seed.token,
            user: seed.user === undefined ? undefined : JSON.stringify(seed.user),
            refreshToken: seed.refreshToken,
        },
    );
}

/**
 * 埋点：记录 `history.pushState` 里落到 `/login` 的次数。
 * 用 pushState 而不是 `page.on("framenavigated")`：后者也会统计 `page.goto` 本身，
 * 而这里要数的是**登出触发的 SPA 跳转**；pushState 也不受同一 URL 去重影响。
 */
async function instrumentLoginPushes(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const state = window as unknown as { __xhLoginPushes?: string[] };
        state.__xhLoginPushes = [];
        const original = history.pushState.bind(history);
        const counting = (data: unknown, unused: string, url?: string | URL | null): void => {
            const href = String(url ?? "");
            if (href.includes("/login")) state.__xhLoginPushes?.push(href);
            original(data, unused, url);
        };
        history.pushState = counting as unknown as typeof history.pushState;
    });
}

async function loginPushes(page: Page): Promise<string[]> {
    return await page.evaluate(
        () => (window as unknown as { __xhLoginPushes?: string[] }).__xhLoginPushes ?? [],
    );
}

test.describe("PLAN-0772 — Login entry guard (task-224 档 3)", () => {
    test("@host 完整会话误访问 /login 仍弹到 /workspace（旧体验不许退化）", async ({
        page,
        request,
    }) => {
        const account = await registerAccount(request, "complete");
        await seedSession(page, {
            token: account.accessToken,
            user: account.user,
            refreshToken: account.refreshToken,
        });

        await page.goto("/login");
        // 只断言最终落点：完整会话（token + 缓存 user）必须让路给 /workspace。
        await page.waitForURL(/\/workspace/, { timeout: ACTION_TIMEOUT_MS });
        const landed = new URL(page.url());
        expect(landed.pathname.startsWith("/workspace")).toBe(true);
        expect(landed.pathname).not.toContain("/login");
    });

    test("@host 残 token（有 token 无缓存 user）访问 /login 停在登录页", async ({
        page,
        request,
    }) => {
        const account = await registerAccount(request, "stale");
        // 只写 token / refresh，**故意不写 `xihe-user`**：这正是旧判据会误当成"已登录"的半会话。
        await seedSession(page, {
            token: account.accessToken,
            refreshToken: account.refreshToken,
        });

        await page.goto("/login");
        // 正面等待登录表单渲染：它一旦出现就说明守卫**没有**把这次访问弹走。
        const identifier = page.locator(LOGIN_FORM);
        await expect(identifier).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });

        const current = new URL(page.url());
        expect(current.pathname).toBe("/login");
        // `?redirect=` 里不许出现 `login`（task-224 的自增链正是这么长出来的）。
        expect(current.searchParams.get("redirect") ?? "").not.toContain("login");
    });

    test("@host 同一批并发 401 只触发一次登录跳转（档 2 单飞）", async ({ page }) => {
        // 本用例**不需要注册账号**：token 与 refresh 都塞无效值，CP 永远不会认它；
        // 于是 `/auth/refresh` 必然 401 ⇒ 每个 401 都走 `forceLogout` 分支
        //（复现 task-223 的必要条件 b：同屏并发多个 401）。
        await seedSession(page, { token: "invalid-token", refreshToken: "invalid-refresh" });
        await instrumentLoginPushes(page);

        // 只数**业务请求**的 401（排除 `/auth/refresh` 自己那一发）：否则 1 个业务 401 +
        // 1 个刷新 401 也能凑够 ≥2，前置就失去意义了。
        let businessUnauthorized = 0;
        page.on("response", (response) => {
            if (response.status() === 401 && !response.url().includes("/auth/refresh"))
                businessUnauthorized += 1;
        });

        // 进**工作区子路由**而不是裸 /workspace：裸 /workspace 在无 tab 上下文时渲染选择面
        // （只有 1 个 GET /workspaces 请求），造不出"同屏并发多个 401"这个必要条件；
        // 走 :workspaceId 才会让 WorkspaceView 并行拉起 workspace/sessions/config 等一批请求。
        await page.goto("/workspace/00000000-0000-4000-8000-000000000001", { waitUntil: "load" });
        // 先证明前提成立：确有并发 401（否则下面的 =1 会"空转通过"，是假绿）。
        await expect
            .poll(() => businessUnauthorized, { timeout: ACTION_TIMEOUT_MS })
            .toBeGreaterThanOrEqual(2);

        await page.waitForURL(/\/login/, { timeout: ACTION_TIMEOUT_MS });
        const form = page.locator(LOGIN_FORM);
        await expect(form).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });

        // 跳转恰好一次：一批并发 401 里只有第一个真正登出+跳转（档 2 的单飞幂等）。
        await expect.poll(() => loginPushes(page).then((list) => list.length)).toBe(1);

        const current = new URL(page.url());
        const redirect = current.searchParams.get("redirect") ?? "";
        expect(redirect).not.toContain("login");
    });
});
