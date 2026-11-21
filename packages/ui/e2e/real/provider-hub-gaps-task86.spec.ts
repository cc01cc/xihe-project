// timeout-exempt: long E2E step(s) reviewed in task-86 (LONG_TIMEOUT_MS, default 30 s)
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { generateE2EPassword } from "./helpers/password";
import { ensureWorkspace } from "./helpers/workspace";
import { LONG_TIMEOUT_MS, TEST_TIMEOUT_MS } from "../timeouts";

/**
 * task-86：补 task-78 删除 `plan-0503-config-catalog.spec.ts` 后留下的三条覆盖缺口。
 *
 * 为什么这三条要单独补：原 spec 的 5 个用例里有 4 个驱动的是**已退役的 testid**
 * （`llm-provider-profile` 等，`src/**` 0 命中），整文件被 describe.skip 挂着；删文件是正确处置，
 * 但其中 V4 漂移注解、V5 手写模型、V7 orphan 三条对应的**能力仍然活着**，只是活在新入口上：
 *
 * - V4：`ProviderHub.vue:1354 provider-default-drift`（PLAN-0523 T3.2 漂移条目）
 * - V5：`ProviderHub.vue:2675-2684` 手写模型 textarea（`form.modelDiscovery === 'manual'`）
 * - V7：`ProviderHub.vue:1983-1999 provider-orphan-bindings / provider-orphan-model-<model>`
 *
 * 每条都按「能力现在在哪 → 怎么驱动 → 断言什么」写，驱动面只用**存活**的选择器与公开 API；
 * 不许用 `test.skip` 顶替（task-78 同一口径）。V7 的原始场景要求真栈，本文件在起栈窗口内跑。
 */
const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;
const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();
const PROVIDER_ID = "custom-openai-compatible";
const PAGE = "/settings/user/llm-provider";

type Auth = {
    accessToken: string;
    workspaceId: string;
};

type ConnectionRow = {
    id: string;
    providerId: string;
    connectionKey: string;
    scope: string;
    modelDiscovery: string;
    manualModels: string[];
};

async function register(request: APIRequestContext, name: string): Promise<Auth> {
    const email = `${name}-${Date.now()}@test.local`;
    const response = await request.post(`${CP_URL}/api/v1/auth/register`, {
        data: { email, password: SHARED_PASSWORD, name },
    });
    expect(response.status(), await response.text()).toBe(201);
    const body = await response.json();
    // PLAN-0614: registration no longer creates a workspace — create one explicitly.
    return {
        accessToken: body.accessToken,
        workspaceId: await ensureWorkspace(request, body.accessToken),
    };
}

async function installAuth(page: Page, auth: Auth) {
    await page.addInitScript(
        ({ token, workspaceId }) => {
            localStorage.setItem("xihe-token", token);
            localStorage.setItem("xihe-user", JSON.stringify({ workspaceId }));
            localStorage.setItem(
                "xihe-workspace",
                JSON.stringify({ id: workspaceId, name: "Default Workspace" }),
            );
        },
        { token: auth.accessToken, workspaceId: auth.workspaceId },
    );
}

function workspaceHeaders(auth: Auth) {
    return { Authorization: `Bearer ${auth.accessToken}`, "X-Workspace-Id": auth.workspaceId };
}

/** 用户层配置：`PUT /config/{layer}/{domain}` 的 body 就是该域的 entries（`stores/config.ts:457`）。 */
async function putUserConfig(
    request: APIRequestContext,
    auth: Auth,
    domain: string,
    entries: Record<string, string>,
) {
    const response = await request.put(`${CP_URL}/api/v1/config/user/${domain}`, {
        headers: { Authorization: `Bearer ${auth.accessToken}` },
        data: entries,
    });
    expect(response.status(), await response.text()).toBe(200);
}

/** 读回该层 entries：漂移/绑定是否被自动改写，只能以数据面为准。 */
async function readUserConfig(request: APIRequestContext, auth: Auth, domain: string) {
    const response = await request.get(
        `${CP_URL}/api/v1/config/${domain}?layer=user&includeMeta=true`,
        { headers: { Authorization: `Bearer ${auth.accessToken}` } },
    );
    expect(response.ok(), await response.text()).toBeTruthy();
    const body = (await response.json()) as { entries?: Record<string, string> };
    return body.entries ?? {};
}

async function createUserConnection(
    request: APIRequestContext,
    auth: Auth,
    options: { key: string; label: string; models: string[] },
): Promise<ConnectionRow> {
    const response = await request.post(`${CP_URL}/api/v1/provider-connections`, {
        headers: workspaceHeaders(auth),
        data: {
            providerId: PROVIDER_ID,
            label: options.label,
            connectionKey: options.key,
            scope: "USER",
            baseUrl: "http://localhost:1/v1",
            modelDiscovery: "manual",
            manualModels: options.models,
        },
    });
    expect(response.status(), await response.text()).toBe(201);
    const created = (await response.json()) as ConnectionRow;
    expect(created.connectionKey).toBe(options.key);
    expect(created.scope).toBe("USER");
    return created;
}

async function listConnections(request: APIRequestContext, auth: Auth): Promise<ConnectionRow[]> {
    const response = await request.get(`${CP_URL}/api/v1/provider-connections`, {
        headers: workspaceHeaders(auth),
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    const body = (await response.json()) as { connections?: ConnectionRow[] };
    return body.connections ?? [];
}

async function openConnectionForm(page: Page) {
    const hub = page.getByTestId("provider-hub");
    await expect(hub).toBeVisible({ timeout: LONG_TIMEOUT_MS });
    await page.getByTestId("provider-hub-connect").click();
    await page.getByTestId(`provider-picker-${PROVIDER_ID}`).click();
    const modal = page.getByTestId("provider-connection-modal");
    await expect(modal).toBeVisible();
    return modal;
}

/**
 * V5 的驱动面：模型发现选「手动输入模型」→ 手写模型 textarea（`ProviderHub.vue:2675-2684`）。
 * 提交时按 `/[,\n]/` 切分并 trim（`:1104-1107`），所以这里故意用换行 + 逗号混排验证切分。
 */
async function createConnectionThroughModal(
    page: Page,
    options: { key: string; label: string; models: string },
) {
    const modal = await openConnectionForm(page);
    await modal.getByLabel("连接名称").fill(options.label);
    await modal.getByTestId("provider-connection-form-key").fill(options.key);
    await modal.getByLabel("Base URL").fill("http://localhost:1/v1");
    await page.getByTestId("provider-connection-field-discovery").click();
    await page.getByTestId("provider-connection-discovery-option-manual").click();
    await modal.getByLabel("模型列表").fill(options.models);
    await modal.getByRole("button", { name: "验证并保存" }).click();
    await expect(modal).toBeHidden({ timeout: LONG_TIMEOUT_MS });
}

function connectionArticle(page: Page, key: string) {
    return page.locator(
        `[data-testid="provider-connection-${PROVIDER_ID}"][data-connection-key="${key}"]`,
    );
}

async function selectConnection(page: Page, key: string) {
    const article = connectionArticle(page, key);
    await expect(article).toBeVisible({ timeout: LONG_TIMEOUT_MS });
    await article.locator("button[aria-pressed]").first().click();
    const detail = page.getByTestId("provider-connection-detail");
    await expect(detail).toHaveAttribute("data-connection-key", key);
    return detail;
}

async function cleanup(request: APIRequestContext, auth: Auth) {
    const connections = await listConnections(request, auth);
    for (const connection of connections) {
        if (connection.providerId !== PROVIDER_ID) continue;
        const response = await request.delete(
            `${CP_URL}/api/v1/provider-connections/${connection.id}`,
            { headers: workspaceHeaders(auth) },
        );
        expect(
            response.status(),
            `cleanup DELETE for ${connection.connectionKey} must succeed`,
        ).toBe(204);
    }
}

test.describe("@host task-86 provider hub 三条覆盖缺口", () => {
    test.setTimeout(TEST_TIMEOUT_MS);

    /**
     * V4：默认 profile 指向的连接在列表里不可见时，必须**保留**琥珀失效条目并原样保留配置，
     * 等用户「设为默认」替换（`PLAN-0523 T3.2` / `ProviderHub.vue:555-558` 的 never auto-rewritten）。
     * 能力活着的反证：把该 connectionKey 的行造出来 ⇒ 条目消失、默认连接卡片出现。
     */
    test("V4 漂移默认连接保留为失效条目且不被自动改写", async ({ page, request }) => {
        const auth = await register(request, "task86-v4-drift");
        await installAuth(page, auth);
        const ghostProfile = {
            providerId: PROVIDER_ID,
            connectionKey: "ghost-default",
            model: "ghost-model",
        };
        try {
            // 漂移条目只在「已有连接」分支里渲染（`ProviderHub.vue:1340/1345`）⇒ 先造一条无关连接，
            // 否则这条用例会因空态而被误判为「漂移根本不渲染」。
            await createUserConnection(request, auth, {
                key: "kept-line",
                label: "Kept Line",
                models: ["kept-model"],
            });
            await putUserConfig(request, auth, "llm-provider", {
                profile: JSON.stringify(ghostProfile),
            });

            await page.goto(PAGE);
            const drift = page.getByTestId("provider-default-drift");
            await expect(
                drift,
                "profile 指向不可见连接时必须保留失效条目（ProviderHub.vue:1354）",
            ).toBeVisible({ timeout: LONG_TIMEOUT_MS });
            await expect(drift).toContainText("ghost-default");
            await expect(drift, "失效徽标文案").toContainText("已失效 · 保留中");

            const stored = await readUserConfig(request, auth, "llm-provider");
            expect(
                stored.profile,
                "漂移态必须原样保留：UI 不得把存储的 profile 自动改写或清空",
            ).toBe(JSON.stringify(ghostProfile));

            // 能力活着的正证：connectionKey 对应行出现 ⇒ 同一份 profile 变成正常默认连接。
            await createUserConnection(request, auth, {
                key: "ghost-default",
                label: "Ghost Default",
                models: ["ghost-model"],
            });
            await page.reload();
            await expect(page.getByTestId("provider-default-drift")).toHaveCount(0);
            await expect(page.getByTestId("provider-default-connection")).toHaveAttribute(
                "data-connection-key",
                "ghost-default",
            );
        } finally {
            await cleanup(request, auth);
        }
    });

    /**
     * V5：手写模型是 `modelDiscovery === "manual"` 时唯一的模型来源（`ProviderHub.vue:553`）。
     * 断言三段：弹窗保存 → 模型区渲染 → 数据面 `manualModels` 与回填 textarea 一致。
     */
    test("V5 手写模型经弹窗保存后进入模型区并回填", async ({ page, request }) => {
        const auth = await register(request, "task86-v5-manual-models");
        await installAuth(page, auth);
        try {
            await page.goto(PAGE);
            await createConnectionThroughModal(page, {
                key: "manual-models",
                label: "Manual Models",
                models: "alpha-model, beta-model",
            });

            const detail = await selectConnection(page, "manual-models");
            const models = detail.getByTestId("provider-connection-models");
            await expect(
                models.getByTestId("provider-model-alpha-model"),
                "手写模型必须逐个渲染成模型行（不是一行合并文本）",
            ).toBeVisible();
            await expect(models.getByTestId("provider-model-beta-model")).toBeVisible();

            const rows = await listConnections(request, auth);
            const row = rows.find(
                (item) => item.connectionKey === "manual-models" && item.scope === "USER",
            );
            expect(row, "数据面必须存在 USER 档 manual-models 行").toBeTruthy();
            expect(row!.modelDiscovery).toBe("manual");
            expect(row!.manualModels, "逗号分隔同样按 [,\n] 切分并 trim").toEqual([
                "alpha-model",
                "beta-model",
            ]);

            // 手写模型的编辑面：重新打开弹窗，textarea 必须按换行回填（`ProviderHub.vue:906`）。
            await connectionArticle(page, "manual-models")
                .getByRole("button", { name: "管理" })
                .click();
            const modal = page.getByTestId("provider-connection-modal");
            await expect(modal).toBeVisible();
            await expect(modal.getByLabel("模型列表")).toHaveValue("alpha-model\nbeta-model");
        } finally {
            await cleanup(request, auth);
        }
    });

    /**
     * V7：按模型绑定了模板、但该模型已不在当前目录时，绑定必须**保留并可见**，且可由用户清除
     * （`ProviderHub.vue:587-598` / `1983-2041`）。清除走真实 UI（Select → 继承连接默认模板），
     * 再以数据面读回证明绑定被删而不是仅从界面隐藏。
     */
    test("V7 orphan 模型绑定保留可见且可由 UI 清除", async ({ page, request }) => {
        const auth = await register(request, "task86-v7-orphan-binding");
        await installAuth(page, auth);
        try {
            const connection = await createUserConnection(request, auth, {
                key: "orphan-line",
                label: "Orphan Line",
                models: ["kept-model"],
            });
            const ref = { layer: "user", templateId: "ghost-template", version: 1 };
            await putUserConfig(request, auth, "api-request-templates", {
                providerModelBindings: JSON.stringify({ [connection.id]: { "ghost-model": ref } }),
            });

            await page.goto(PAGE);
            const detail = await selectConnection(page, "orphan-line");
            const orphan = detail.getByTestId("provider-orphan-bindings");
            await expect(
                orphan,
                "已绑定但不在目录的模型必须单独列出（不许渲染成缺席行）",
            ).toBeVisible({ timeout: LONG_TIMEOUT_MS });
            await expect(detail.getByTestId("provider-orphan-model-ghost-model")).toBeVisible();

            // chat 连接才有清除控件（`ProviderHub.vue:2004`），选「继承连接默认模板」即删除该绑定。
            await page.getByRole("combobox", { name: "ghost-model 请求模板" }).click();
            await page.getByRole("option", { name: "继承连接默认模板" }).click();
            await expect(
                page.getByTestId("provider-orphan-model-ghost-model"),
                "清除后该行必须消失",
            ).toHaveCount(0, { timeout: LONG_TIMEOUT_MS });

            const entries = await readUserConfig(request, auth, "api-request-templates");
            const bindings = JSON.parse(entries.providerModelBindings ?? "{}") as Record<
                string,
                Record<string, unknown>
            >;
            expect(
                bindings[connection.id],
                "数据面读回：该连接的模型绑定条目已被删除（不是只在界面上隐藏）",
            ).toBeUndefined();
        } finally {
            await cleanup(request, auth);
        }
    });
});
