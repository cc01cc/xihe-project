// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { generateE2EPassword } from "./helpers/password";
import { expectPlatformScreenshot } from "../helpers/visual";
import { ensureWorkspace } from "./helpers/workspace";
import { ACTION_TIMEOUT_MS, LONG_TIMEOUT_MS, TEST_TIMEOUT_MS } from "../timeouts";

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;
const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();
const PROVIDER_ID = "custom-openai-compatible";

type Auth = {
    accessToken: string;
    workspaceId: string;
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
 * BL-476 L1：模型发现字段已从原生 select 换成 reka `Select`（combobox + listbox），
 * `selectOption` 不再适用 —— 改为「点触发器 → 点 portal 里的选项」。
 */
async function selectDiscovery(page: Page, value: "manual" | "curated" | "remote-models") {
    await page.getByTestId("provider-connection-field-discovery").click();
    await page.getByTestId(`provider-connection-discovery-option-${value}`).click();
}

async function createConnection(page: Page, options: { key: string; label: string }) {
    const modal = await openConnectionForm(page);
    // task-78：弹窗只继承当前页 layer（USER），不再有 scope 选择器（PLAN-0560/0563）。
    await expect(
        modal.locator('input[name="provider-scope"]'),
        "连接弹窗不应再有 scope 选择器（PLAN-0560/0563 已移除）；它复活说明 UI 回退",
    ).toHaveCount(0);
    await modal.getByLabel("连接名称").fill(options.label);
    await modal.getByTestId("provider-connection-form-key").fill(options.key);
    await modal.getByLabel("Base URL").fill("http://localhost:1/v1");
    await selectDiscovery(page, "manual");
    await modal.getByLabel("模型列表").fill("test-model");
    await modal.getByRole("button", { name: "验证并保存" }).click();
    await expect(modal).toBeHidden({ timeout: LONG_TIMEOUT_MS });
}

/**
 * task-78：工作区层没有 UI 建面（工作区配置 tab 已随 task-253 移除），改用 API 建同 key 的
 * WORKSPACE 行，再回用户层列表验证两档并存。body 键名取 OpenAPI `ProviderConnectionCreateRequest`
 * （docs/api/openapi.yaml:9495-9509）；`custom-openai-compatible` 的 `credential.required=false`
 * （provider-catalog/providers.json:330）⇒ 不需要 apiKey。
 */
async function createWorkspaceConnection(
    request: APIRequestContext,
    auth: Auth,
    options: { key: string; label: string },
) {
    const response = await request.post(`${CP_URL}/api/v1/provider-connections`, {
        headers: {
            Authorization: `Bearer ${auth.accessToken}`,
            "X-Workspace-Id": auth.workspaceId,
        },
        data: {
            providerId: PROVIDER_ID,
            label: options.label,
            connectionKey: options.key,
            scope: "WORKSPACE",
            baseUrl: "http://localhost:1/v1",
            modelDiscovery: "manual",
            manualModels: ["test-model"],
        },
    });
    expect(response.status(), await response.text()).toBe(201);
    const created = (await response.json()) as {
        connectionKey: string;
        scope: string;
        id: string;
    };
    expect(created.scope).toBe("WORKSPACE");
    expect(created.connectionKey).toBe(options.key);
    return created;
}

function connectionArticle(page: Page, key: string) {
    return page.locator(
        `[data-testid="provider-connection-${PROVIDER_ID}"][data-connection-key="${key}"]`,
    );
}

async function cleanup(request: APIRequestContext, auth: Auth) {
    const list = await request.get(`${CP_URL}/api/v1/provider-connections`, {
        headers: {
            Authorization: `Bearer ${auth.accessToken}`,
            "X-Workspace-Id": auth.workspaceId,
        },
    });
    if (!list.ok()) return;
    const body = await list.json();
    for (const connection of body.connections ?? []) {
        if (connection.providerId !== PROVIDER_ID) continue;
        // PLAN-0505: DELETE now blocks (409 CONNECTION_IN_USE) while sessions
        // reference the connection. Each test registers a fresh user on an
        // isolated DB, so no session can reference these connections; keep the
        // direct API cleanup and fail loudly if the precondition ever breaks.
        const response = await request.delete(
            `${CP_URL}/api/v1/provider-connections/${connection.id}`,
            {
                headers: {
                    Authorization: `Bearer ${auth.accessToken}`,
                    "X-Workspace-Id": auth.workspaceId,
                },
            },
        );
        expect(
            response.status(),
            `cleanup DELETE for ${connection.connectionKey} must succeed ` +
                "(isolated per-test registration must not leave session references)",
        ).toBe(204);
    }
}

test.describe("@host PLAN-0438 Provider Connection keys", () => {
    // task-78（原 BL-138 跳过项，重写为真实现而不是继续 skip）：flow 保留，两处前提按现状落地 ——
    // ① 连接弹窗自 PLAN-0560/0563 起不再提供 scope 选择（"连接弹窗不再提供 scope 选择：
    //    新建取当前页 scope"）⇒ USER 档由 UI 创建，且**每次创建都负向断言**
    //    `input[name="provider-scope"]` 计数为 0（选择器复活的当天就红，不再是一行等待超时）；
    // ② 工作区层没有 UI 建面：`/workspace/:id/settings?tab=config` 深链已随 task-253 移除
    //    （ConfigLayerPanels.vue:67 注释），ProviderHub 的 `layer` 只剩 instance|user
    //    （ConfigLayerPanels.vue:486-490）⇒ WORKSPACE 档改由 API 建同一 connectionKey 的行，
    //    再回用户层列表断言同 key 两行并存（listVisible 同时返回 USER 行 + 当前 WORKSPACE 行，
    //    ProviderConnectionService.java:108-124）。
    // PLAN-0505 follow-up (P-3): cold-stack create+verify roundtrips can take
    // ~24s on the first attempt; the default 30s test timeout flakes. The
    // flow itself is bounded by per-step waits, so this only widens the headroom.
    test.setTimeout(TEST_TIMEOUT_MS);
    test("creates, reads, updates and scopes keyed connections without secret readback", async ({
        page,
        request,
    }) => {
        const auth = await register(request, "provider-connection-keys");
        await installAuth(page, auth);
        try {
            await page.goto("/settings/user/llm-provider");

            await createConnection(page, { key: "primary", label: "Primary Custom" });
            await expect(connectionArticle(page, "primary")).toBeVisible();
            await createConnection(page, { key: "secondary", label: "Secondary Custom" });
            await expect(connectionArticle(page, "secondary")).toBeVisible();

            for (const key of ["primary", "secondary"]) {
                const article = connectionArticle(page, key);
                await expect(article).toContainText(key);
                await article.locator("button[aria-pressed]").click();
                const detail = page.getByTestId("provider-connection-detail");
                await expect(detail).toHaveAttribute("data-connection-key", key);
                await expect(detail).toContainText("openai-chat-completions@1");
                await expect(detail).toContainText("chat");
                await expect(page.getByTestId("provider-connection-models")).toContainText(
                    "test-model",
                );
            }

            await connectionArticle(page, "primary").getByRole("button", { name: "管理" }).click();
            const editModal = page.getByTestId("provider-connection-modal");
            await expect(editModal).toBeVisible();
            await expect(editModal.getByTestId("provider-connection-form-key")).toHaveValue(
                "primary",
            );
            await expect(editModal.getByTestId("provider-connection-form-key")).toHaveAttribute(
                "readonly",
                "",
            );
            await expect(
                editModal.getByTestId("provider-connection-field-discovery"),
            ).toContainText("手动输入模型");
            await expect(editModal.getByLabel("模型列表")).toHaveValue("test-model");
            await editModal.getByLabel("连接名称").fill("Primary Custom Renamed");
            await editModal.getByRole("button", { name: "验证并保存" }).click();
            await expect(editModal).toBeHidden({ timeout: LONG_TIMEOUT_MS });
            await expect(connectionArticle(page, "primary")).toContainText(
                "Primary Custom Renamed",
            );
            const persisted = await request.get(`${CP_URL}/api/v1/provider-connections`, {
                headers: {
                    Authorization: `Bearer ${auth.accessToken}`,
                    "X-Workspace-Id": auth.workspaceId,
                },
            });
            expect(persisted.ok()).toBeTruthy();
            const persistedBody = await persisted.json();
            const primary = persistedBody.connections.find(
                (entry: { connectionKey: string; scope: string }) =>
                    entry.connectionKey === "primary" && entry.scope === "USER",
            );
            expect(primary.modelDiscovery).toBe("manual");
            expect(primary.manualModels).toEqual(["test-model"]);
            expect(primary.maskedKey).toBeNull();

            // WORKSPACE 档同 key 行（API 建）：UI 无建面，但用户层列表要把两档一起列出来。
            await createWorkspaceConnection(request, auth, {
                key: "primary",
                label: "Workspace Shared",
            });
            await page.reload();
            await expect(connectionArticle(page, "primary")).toHaveCount(2);
            await expect(connectionArticle(page, "secondary")).toBeVisible();

            // 两档并存的硬判据落数据面：同一 (providerId, connectionKey) 出现 USER + WORKSPACE 两行。
            const scoped = await request.get(`${CP_URL}/api/v1/provider-connections`, {
                headers: {
                    Authorization: `Bearer ${auth.accessToken}`,
                    "X-Workspace-Id": auth.workspaceId,
                },
            });
            expect(scoped.ok()).toBeTruthy();
            const scopedBody = await scoped.json();
            const primaryRows = scopedBody.connections.filter(
                (entry: { providerId: string; connectionKey: string }) =>
                    entry.providerId === PROVIDER_ID && entry.connectionKey === "primary",
            );
            expect(
                primaryRows.map((entry: { scope: string }) => entry.scope).sort(),
                "同 key 必须 USER + WORKSPACE 两档并存（PLAN-0438 双档语义）",
            ).toEqual(["USER", "WORKSPACE"]);

            const duplicateModal = await openConnectionForm(page);
            await duplicateModal.getByLabel("连接名称").fill("Duplicate");
            await duplicateModal.getByTestId("provider-connection-form-key").fill("primary");
            await duplicateModal.getByLabel("Base URL").fill("http://localhost:1/v1");
            await selectDiscovery(page, "manual");
            await duplicateModal.getByLabel("模型列表").fill("test-model");
            await duplicateModal.getByRole("button", { name: "验证并保存" }).click();
            await expect(duplicateModal).toBeVisible();
            await expect(
                page.getByText(/already exists|保存失败|已存在|CONFLICT|冲突/i).first(),
            ).toBeVisible({
                timeout: ACTION_TIMEOUT_MS,
            });
            await duplicateModal.getByRole("button", { name: "取消" }).click();

            await expectPlatformScreenshot(page, "plan-0438-provider-connection-keys.png");

            const info = test.info();
            const screenshotPath = info.outputPath("plan-0438-provider-connection-keys-full.png");
            await page.screenshot({ scale: "css", path: screenshotPath, fullPage: true });
            await info.attach("plan-0438-provider-connection-keys-full.png", {
                path: screenshotPath,
                contentType: "image/png",
            });
            await page.setViewportSize({ width: 390, height: 844 });
            await connectionArticle(page, "secondary").scrollIntoViewIfNeeded();
            await expect(connectionArticle(page, "secondary")).toBeInViewport();
            const mobilePath = info.outputPath("plan-0438-provider-connection-keys-mobile.png");
            await page.screenshot({ scale: "css", path: mobilePath, fullPage: true });
            await info.attach("plan-0438-provider-connection-keys-mobile.png", {
                path: mobilePath,
                contentType: "image/png",
            });
            const mobileModels = page.getByTestId("provider-connection-models");
            await mobileModels.scrollIntoViewIfNeeded();
            await expect(mobileModels).toBeInViewport();
            await expect(mobileModels).toContainText("test-model");
            const mobileDetailPath = info.outputPath(
                "plan-0438-provider-connection-detail-mobile.png",
            );
            await page.screenshot({ scale: "css", path: mobileDetailPath });
            await info.attach("plan-0438-provider-connection-detail-mobile.png", {
                path: mobileDetailPath,
                contentType: "image/png",
            });
        } finally {
            await cleanup(request, auth);
        }
    });
});
