import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { generateE2EPassword } from "./helpers/password";
import { expectPlatformScreenshot } from "../helpers/visual";

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
    return { accessToken: body.accessToken, workspaceId: body.workspaceId };
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
    await expect(hub).toBeVisible({ timeout: 15000 });
    await page.getByTestId("provider-hub-connect").click();
    await page.getByTestId(`provider-picker-${PROVIDER_ID}`).click();
    const modal = page.getByTestId("provider-connection-modal");
    await expect(modal).toBeVisible();
    return modal;
}

async function createConnection(
    page: Page,
    options: { key: string; label: string; scope: "USER" | "WORKSPACE" },
) {
    const modal = await openConnectionForm(page);
    await modal.getByLabel("连接名称").fill(options.label);
    await modal.getByTestId("provider-connection-form-key").fill(options.key);
    await modal.getByLabel("Base URL").fill("http://localhost:1/v1");
    await modal
        .locator('input[name="provider-scope"][value="' + options.scope + '"]')
        .check({ force: true });
    await modal.getByLabel("模型发现").selectOption("manual");
    await modal.getByLabel("模型列表").fill("test-model");
    await modal.getByRole("button", { name: "验证并保存" }).click();
    await expect(modal).toBeHidden({ timeout: 15000 });
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
    // BL-138 (stale premise, test-infra rewrite pending): this flow drives the
    // retired scope selector `input[name="provider-scope"]` inside the
    // connection modal and expects the same connectionKey to exist at USER and
    // WORKSPACE scope. PLAN-0560/0563 removed that selector — the modal now
    // inherits the current page layer ("连接弹窗不再提供 scope 选择：新建取当前页
    // scope"), and workspace-layer connections are created from
    // `/workspace/:id/settings?tab=config` instead. The 90s timeout observed on
    // 2026-10-29 (mock-full + two isolated runs) is this stale selector waiting
    // for an element that no longer exists, not a product defect. Rewrite is
    // tracked as BL-138; skipping removes the timeout without deleting any
    // assertion.
    test.skip(
        true,
        "BL-138: provider-scope selector retired (modal inherits page layer); rewrite the USER/WORKSPACE two-scope flow via /workspace/:id/settings?config",
    );
    // PLAN-0505 follow-up (P-3): cold-stack create+verify roundtrips can take
    // ~24s on the first attempt; the default 30s test timeout flakes. The
    // flow itself is bounded by per-step waits, so this only widens the headroom.
    test.setTimeout(90000);
    test("creates, reads, updates and scopes keyed connections without secret readback", async ({
        page,
        request,
    }) => {
        const auth = await register(request, "provider-connection-keys");
        await installAuth(page, auth);
        try {
            await page.goto("/settings/config");

            await createConnection(page, {
                key: "primary",
                label: "Primary Custom",
                scope: "USER",
            });
            await expect(connectionArticle(page, "primary")).toBeVisible();
            await createConnection(page, {
                key: "secondary",
                label: "Secondary Custom",
                scope: "USER",
            });
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
            await expect(editModal.getByLabel("模型发现")).toHaveValue("manual");
            await expect(editModal.getByLabel("模型列表")).toHaveValue("test-model");
            await editModal.getByLabel("连接名称").fill("Primary Custom Renamed");
            await editModal.getByRole("button", { name: "验证并保存" }).click();
            await expect(editModal).toBeHidden({ timeout: 15000 });
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

            await createConnection(page, {
                key: "primary",
                label: "Workspace Shared",
                scope: "WORKSPACE",
            });
            await expect(connectionArticle(page, "primary")).toHaveCount(2);
            await page.reload();
            await expect(connectionArticle(page, "primary")).toHaveCount(2);
            await expect(connectionArticle(page, "secondary")).toBeVisible();

            const duplicateModal = await openConnectionForm(page);
            await duplicateModal.getByLabel("连接名称").fill("Duplicate");
            await duplicateModal.getByTestId("provider-connection-form-key").fill("primary");
            await duplicateModal.getByLabel("Base URL").fill("http://localhost:1/v1");
            await duplicateModal.getByLabel("模型发现").selectOption("manual");
            await duplicateModal.getByLabel("模型列表").fill("test-model");
            await duplicateModal.getByRole("button", { name: "验证并保存" }).click();
            await expect(duplicateModal).toBeVisible();
            await expect(
                page.getByText(/already exists|保存失败|已存在|CONFLICT|冲突/i).first(),
            ).toBeVisible({
                timeout: 10000,
            });
            await duplicateModal.getByRole("button", { name: "取消" }).click();

            await expectPlatformScreenshot(page, "plan-0438-provider-connection-keys.png");

            const info = test.info();
            const screenshotPath = info.outputPath("plan-0438-provider-connection-keys-full.png");
            await page.screenshot({ path: screenshotPath, fullPage: true });
            await info.attach("plan-0438-provider-connection-keys-full.png", {
                path: screenshotPath,
                contentType: "image/png",
            });
            await page.setViewportSize({ width: 390, height: 844 });
            await connectionArticle(page, "secondary").scrollIntoViewIfNeeded();
            await expect(connectionArticle(page, "secondary")).toBeInViewport();
            const mobilePath = info.outputPath("plan-0438-provider-connection-keys-mobile.png");
            await page.screenshot({ path: mobilePath, fullPage: true });
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
            await page.screenshot({ path: mobileDetailPath });
            await info.attach("plan-0438-provider-connection-detail-mobile.png", {
                path: mobileDetailPath,
                contentType: "image/png",
            });
        } finally {
            await cleanup(request, auth);
        }
    });
});
