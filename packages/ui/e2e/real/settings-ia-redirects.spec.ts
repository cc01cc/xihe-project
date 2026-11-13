// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { generateE2EPassword } from "./helpers/password";
import { ensureWorkspace } from "./helpers/workspace";
import { LONG_TIMEOUT_MS } from "../timeouts";

/**
 * PLAN-0752 V2 / V3 真链路收口（task-225）。
 *
 * <p>为什么单独建文件而不改 `settings-ia.spec.ts`：task-184 的
 * `e2e/real/settings-ia.spec.ts` 已经覆盖 **V10**（/settings/* 下工作区 Sidebar count 0）、
 * **T2.5 工作区域段深链** 与 **V12 移动端**，判据不重叠；本文件只补 verify.md 里仍标
 * ⏳ 待补的两条 —— **V2（三条旧路径 redirect）** 与 **V3（层×域矩阵外组合 404 + 零请求）**。
 * 重复断言已在同一文件里做过的事只会拉长真栈窗口，不增加覆盖面。</p>
 *
 * <p><b>task-253（2026-11-10，Q-1110-45）曾把工作区块配置层整体退役</b>：当时 `?tab=config` 入口与
 * `ws-settings-domain-` 系列容器都不存在了 ⇒ 原文 V2 第三条（`/workspace/:id/settings?tab=config`）
 * 与「工作区旧 tab 入口仍渲染配置页签」用例整条删除，原位留 (a) 标注；V3 里同样指向已删面的
 * 反向断言（`ws-settings-domain-page` count 0，断「不存在的东西不存在」）也一并删除 —— 留着只会
 * 让人误以为有覆盖。存活判据：V2 的两条全局旧路径 redirect + V3 的层×域 404 与零工作区层请求。</p>
 *
 * <p><b>⚠ 上面那段「`?tab=config` 入口不存在了」只对 task-253 → M4-1 之间成立</b>（2026-11-13
 * `task-348` 更正）：PLAN-0773 M4-1（task-190，`d0864b59e`）把工作区配置 tab 按 **per-workspace 层**
 * 接了回来，`?tab=config` 与 `ws-settings-tab-config` / `ws-settings-config` 两个 testid 现在都存在；
 * 仍不存在的只是 `ws-settings-domain-` 系列（域段页随 task-253 消失，未随 M4-1 回来）。
 * 真栈对这条 tab 的覆盖：`approval-policy.spec.ts:128,155` 是**走到该 tab 上再做审批断言**，
 * 不判这两个 testid 的存在性本身 ⇒ 「`?tab=config` 能进、落点正确」这条目前只有 mock 车道在钉。</p>
 *
 * <p>判据出处：`plans/PLAN-0752-XH-settings-information-architecture/verify.md`
 * - V2：`/settings/config`、`/settings/policy` 两条全局旧路径都能到达实例层默认域（断言最终 URL 与落点）。
 * - V3：矩阵不存在的组合（此处 `/settings/user/logging`，logging 只在实例层）⇒ 404 视图，
 *   且不请求该组合的配置。</p>
 *
 * <p>V3 的「零请求」口径按 mock 侧既有裁定**收窄到工作区层**，原因不是放宽而是避免误判：
 * /settings 壳内其它组件会拉 user/instance 层域配置，它们与本页 404 判定无关；字面
 * 「零 /config/ 请求」在真栈必然红。见 `e2e/mock/plan-0752-settings-ia.spec.ts` 同位注释。</p>
 *
 * <p>但收窄方式要比 mock 更精确：mock 只比较 pathname 的 `/config/workspace/` 前缀，而工作区层
 * 的**读**路径是 `GET /api/v1/config/<domain>?layer=workspace`（stores/config.ts:277）——层在
 * query 里，pathname 永远不含 `/config/workspace/`。若照抄该写法，这条断言对真实读请求恒真
 * （假绿）。本文件因此同时接受两种形态：显式 `/config/workspace/<domain>` 写路径与
 * `?layer=workspace` 读路径。另加一条更精确的「不得请求矩阵外的 `/config/logging` 本身」。</p>
 *
 * <p>依赖：`scripts/e2e-host.mjs`（`mise run test:e2e:host`）提供的真实 CP + UI。
 * 只有 V2 的实例层用例需要管理员（凭据由 e2e-host 以 `XIHE_E2E_ADMIN_PASSWORD` 注入，
 * 同 plan-0503-config-catalog.spec.ts）；工作区页与 V3 404 用新注册账号自带的工作区，
 * 避免「管理员不是首个工作区成员」这类与判据无关的耦合（同 approval-policy.spec.ts）。</p>
 *
 * <p>本文件在 mock 车道不运行（mock 侧同判据由 plan-0752-settings-ia.spec.ts 承担）。</p>
 */
const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;
const ADMIN_EMAIL = "admin@xihe.local";

/** 实例层默认域页 = 矩阵第一个域（settingsIa.ts#defaultLayerPath ⇒ INSTANCE_DOMAINS[0]）。 */
const DEFAULT_INSTANCE_DOMAIN_PATH = "/settings/instance/llm-provider";

/**
 * 实例层用例**不需要工作区**（/settings/* 走 SettingsLayout，不经 AppLayout）：只要 token + CP
 * 投影的 `user`。刻意**不调 ensureWorkspace** —— 管理员列 /workspaces 会拿到**别人**的第一个
 * 工作区，把与判据无关的成员关系/工作区上下文拉进来只会制造无关红点。
 */
type AdminAuth = {
    accessToken: string;
    user: Record<string, unknown>;
    workspaceId?: string;
};
type OwnerAuth = { accessToken: string; workspaceId: string };

async function loginAsAdmin(request: APIRequestContext): Promise<AdminAuth> {
    const password = process.env.XIHE_E2E_ADMIN_PASSWORD ?? "";
    expect(password, "XIHE_E2E_ADMIN_PASSWORD must be provided by e2e-host").not.toBe("");
    const login = await request.post(`${CP_URL}/api/v1/auth/login`, {
        data: { identifier: ADMIN_EMAIL, password },
    });
    expect(login.ok(), await login.text()).toBe(true);
    const body = (await login.json()) as {
        accessToken: string;
        user: Record<string, unknown>;
        workspaceId?: string | null;
    };
    return {
        accessToken: body.accessToken,
        user: body.user,
        workspaceId: body.workspaceId ?? undefined,
    };
}

/** 新注册账号 + 它自己的工作区：工作区页/成员判据不依赖「管理员是否是成员」。 */
async function registerOwner(request: APIRequestContext): Promise<OwnerAuth> {
    const password = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();
    const response = await request.post(`${CP_URL}/api/v1/auth/register`, {
        data: {
            email: `settings-ia-redirects-${Date.now()}@test.local`,
            password,
            name: "Settings IA Redirects",
        },
    });
    expect(response.status(), await response.text()).toBe(201);
    const body = (await response.json()) as { accessToken: string };
    // PLAN-0614: registration no longer creates a workspace; create one explicitly.
    const workspaceId = await ensureWorkspace(request, body.accessToken);
    return { accessToken: body.accessToken, workspaceId };
}

/**
 * 注入登录态。实例层页需要管理员能力位，所以管理员用例必须带 login 响应里的 `user`
 * （capabilities 由 CP 投影，不在前端自造）；普通账号只需要 token + 当前工作区。
 */
async function installAdminAuth(page: Page, admin: AdminAuth): Promise<void> {
    await page.addInitScript(
        ({ token, user, workspaceId }) => {
            localStorage.setItem("xihe-token", token);
            localStorage.setItem("xihe-user", JSON.stringify(user));
            // 登录响应没带工作区时**不写**这个键：塞个假 id 只会让壳去拉一个不存在的工作区。
            if (workspaceId) {
                localStorage.setItem(
                    "xihe-workspace",
                    JSON.stringify({ id: workspaceId, name: "E2E" }),
                );
            }
        },
        { token: admin.accessToken, user: admin.user, workspaceId: admin.workspaceId },
    );
}

async function installOwnerAuth(page: Page, owner: OwnerAuth): Promise<void> {
    await page.addInitScript(
        ({ token, workspaceId }) => {
            localStorage.setItem("xihe-token", token);
            localStorage.setItem("xihe-user", JSON.stringify({ workspaceId }));
            localStorage.setItem(
                "xihe-workspace",
                JSON.stringify({ id: workspaceId, name: "Default Workspace" }),
            );
        },
        { token: owner.accessToken, workspaceId: owner.workspaceId },
    );
}

test.describe.configure({ retries: 0 });

test("@host PLAN-0752 V2 两条旧设置路径重定向到实例层默认域", async ({ page, request }) => {
    const admin = await loginAsAdmin(request);
    await installAdminAuth(page, admin);

    for (const legacyPath of ["/settings/config", "/settings/policy"]) {
        await page.goto(legacyPath);
        // 判据本体：最终 URL = 实例层默认域（不是旧页、不是 404 兜底）。
        await expect(page, `${legacyPath} must redirect to the layer-in-URL form`).toHaveURL(
            new RegExp(`${DEFAULT_INSTANCE_DOMAIN_PATH}$`),
            { timeout: LONG_TIMEOUT_MS },
        );
        await expect(page.getByTestId("settings-layer-header")).toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
        await expect(page.getByTestId("settings-layer-title")).toBeVisible();
        // 落点不是 404：redirect 目标必须在矩阵里。
        await expect(page.getByTestId("settings-not-found")).toHaveCount(0);
        // 旧路径不得作为可点入口回流到左栏（mock 同判据：plan-0752-settings-ia.spec.ts）。
        await expect(page.locator(`a[href="${legacyPath}"]`)).toHaveCount(0);
    }
});

// (a) 删 —— 「工作区旧 tab 入口仍渲染配置页签」（原 @host PLAN-0752 V2 第三条）：task-253 把工作区
// 配置层整体退役后，`ws-settings-tab-config` 与 `ws-settings-config` 两个 testid 在
// WorkspaceSettingsView.vue 里都已不存在 ⇒ 当时断言对象消失，整条删除。
//
// ⚠ **这段话只对 task-253 → M4-1 之间的那一段成立，不要把它当现状读**（2026-11-13 `task-348` 更正）：
// PLAN-0773 M4-1（task-190，`d0864b59e`）把工作区配置 tab **按 per-workspace 层接了回来**
// （`ConfigLayer` 新增 `workspace`），两个 testid 现在是**存在的** —— `ws-settings-tab-config`
// 与 `ws-settings-config` 都在，现存页签是 `general|config`。当时那句「现存页签只有
// general|mcp|members|credentials|knowledge」也已全部过期（mcp/members/credentials/knowledge
// 分别随 task-209 / task-236 撤走）。
// 保留这段而不是删掉：它记录的是「曾有一段时间它们不存在」这个事实（墓碑形态）。
// 现状判据在 mock 车道（都能跑，不必相信这段注释）：
//   - `plan-0752-settings-ia.spec.ts` —— 两个 testid 的存在/不挂载 + 防复活守卫
//   - `config-settings.spec.ts:225,236` —— `?tab=config` 的直接进入与高亮
// 真栈侧对这条 tab 的用例**不复活**：`approval-policy.spec.ts:128,155` 已走到 `?tab=config`（当审批
// 断言的前置），但「`?tab=config` 落点 = 配置页签且高亮」这条判据目前只在 mock 车道（见文件头）。

test("@host PLAN-0752 V3 用户层矩阵外组合 404 且不发工作区层配置请求", async ({
    page,
    request,
}) => {
    const owner = await registerOwner(request);
    await installOwnerAuth(page, owner);

    // 在导航之前挂监听，确保把首个请求也收进来。
    // 收 **full URL** 而不是 pathname：工作区层的**读**形态是
    // `GET /api/v1/config/<domain>?layer=workspace`（stores/config.ts:277），层在 query 里；
    // 只比较 pathname 会让「零工作区层请求」永远恒真 —— 那是假绿，不是判据。
    const configRequestUrls: string[] = [];
    page.on("request", (outgoing) => {
        const url = outgoing.url();
        if (!url.includes("/api/v1/config/")) return;
        configRequestUrls.push(url);
    });

    // logging 在 INSTANCE_DOMAINS 里但不在 LAYER_DOMAINS.user（stores/config.ts:31-44 / 87-99）
    // ⇒ 该「层×域」组合根本不注册路由，落到 /settings 的 404 兜底（router/index.ts:181-188）。
    await page.goto("/settings/user/logging");
    await expect(page.getByTestId("settings-not-found")).toBeVisible({ timeout: LONG_TIMEOUT_MS });

    // 仍是设置区壳（左栏在），只是内容区是 404 —— 区别于白屏/静默空页。
    await expect(page.getByTestId("settings-sidebar")).toBeVisible({ timeout: LONG_TIMEOUT_MS });
    await expect(page.getByTestId("settings-nav-domain-user-llm-provider")).toBeVisible();
    // 矩阵外的条目不得出现在左栏（V3 附带判据；V25 的左栏快照是另一条）。
    await expect(page.getByTestId("settings-nav-domain-user-logging")).toHaveCount(0);
    // (a) 删 —— 原文此处断 `ws-settings-domain-page` count 0：该容器已随 task-253 退役，全树不存在，
    // 这条断言恒真且零信息量（断「不存在的东西不存在」），删掉以免被当成有效覆盖。

    // 零工作区层配置请求（口径收窄见文件头：排除 user/instance 层，壳内其它组件会拉）。
    // 两种形态都算：显式路径 `/config/workspace/<domain>`（写路径，stores/config.ts:321）
    // 与读路径的 `?layer=workspace` query。只认前者会漏掉本页最可能出现的读请求。
    expect(
        configRequestUrls.filter(
            (requestUrl) =>
                requestUrl.includes("/config/workspace/") ||
                /[?&]layer=workspace(&|$)/.test(requestUrl),
        ),
        "404 域段不得发工作区层 /config 请求",
    ).toEqual([]);
    // 更精确的一条：不得请求这个矩阵外的域本身（`/config/logging` 与 `/config/logging/meta` 都算）。
    expect(
        configRequestUrls.filter((requestUrl) => requestUrl.includes("/config/logging")),
        "矩阵外组合不得请求该域配置",
    ).toEqual([]);
});
