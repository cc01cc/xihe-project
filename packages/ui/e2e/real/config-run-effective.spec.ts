import { generateE2EPassword } from "./helpers/password";

const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();
import { test, expect } from "@playwright/test";
import {
    createSessionWithPrincipal,
    provisionWorkspaceAgentPrincipal,
} from "./helpers/agent-principal";
import { ensureAgentWorkspaceBinding } from "./helpers/journey";

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;
const LLM_MODE = process.env.XIHE_E2E_LLM_MODE ?? "mock";
const FAKE_LLM_BASE = `http://127.0.0.1:${process.env.XIHE_FAKE_LLM_PORT || "12639"}/openai/v1`;

// PLAN-0504：用户层 profile 改动必须真正到达下一轮 chat 的 run payload。
// 链路：UI 保存 profile → CP user 层存储 → 合并配置 → getEffectiveModel 解析 →
// POST /api/v1/chat 的 provider/model。会话经 API 创建（不携带 model 绑定），
// 因此 payload 即 UI 默认解析结果；PLAN-0439 后未绑定会话在 Agent 侧按设计拒绝
// 派发（PROVIDER_CONNECTION_UNAVAILABLE），故以 payload 为断言边界。
// 跑法：node scripts/e2e-host.mjs --llm-mode=success e2e/real/config-run-effective.spec.ts
test.describe("@host PLAN-0504 — UI profile reaches the Agent run payload", () => {
    test.skip(LLM_MODE !== "success", "requires XIHE_E2E_LLM_MODE=success (fake LLM)");

    test("user-layer llm-provider profile drives the next chat run payload", async ({
        page,
        request,
    }) => {
        test.setTimeout(240000);

        const reg = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: {
                email: `p0504-${Date.now()}@test.com`,
                password: SHARED_PASSWORD,
                name: "P0504",
            },
        });
        expect(reg.ok()).toBe(true);
        const auth = await reg.json();
        const headers = {
            Authorization: `Bearer ${auth.accessToken}`,
            "Content-Type": "application/json",
        };
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

        // 0. The user-layer profile write requires a visible READY chat connection.
        const uniqueModel = `fake-p0504-${Date.now()}`;
        const created = await request.post(`${CP_URL}/api/v1/provider-connections`, {
            headers,
            data: {
                providerId: "openai",
                apiTypeId: "openai-chat-completions",
                apiTypeVersion: 1,
                apiKey: "sk-fake-openai-key",
                connectionKey: "default",
                label: "E2E profile default",
                scope: "USER",
                modelDiscovery: "manual",
                manualModels: [uniqueModel],
                baseUrl: FAKE_LLM_BASE,
            },
        });
        expect(created.ok(), await created.text()).toBe(true);
        const connection = (await created.json()) as { id: string };
        const verified = await request.post(
            `${CP_URL}/api/v1/provider-connections/${connection.id}/verify`,
            { headers },
        );
        expect(verified.ok(), await verified.text()).toBe(true);

        // 1. Save the whole profile unit through the real settings UI.
        await page.goto("/settings/config", { waitUntil: "load" });
        await expect(page.getByTestId("settings-config-heading")).toBeVisible({ timeout: 10000 });
        await page.getByTestId("config-tab-user").click();

        const panel = page.getByTestId("llm-provider-profile");
        await expect(panel).toBeVisible({ timeout: 8000 });
        await page.getByTestId("llm-profile-connection-select").selectOption(connection.id);
        await page.getByTestId("llm-profile-model-select").selectOption("__custom__");
        await page.getByTestId("llm-profile-model-custom").fill(uniqueModel);

        const [saveResponse] = await Promise.all([
            page.waitForResponse(
                (response) =>
                    response.url().includes("/api/v1/config/user/llm-provider") &&
                    response.request().method() === "PUT",
            ),
            page.getByTestId("llm-profile-save").click(),
        ]);
        expect(saveResponse.status()).toBe(200);
        expect(JSON.parse(saveResponse.request().postData() ?? "{}").profile).toBe(
            JSON.stringify({
                providerId: "openai",
                connectionKey: "default",
                model: uniqueModel,
            }),
        );
        await expect(page.getByText(/默认 LLM 配置已保存/)).toBeVisible({ timeout: 10000 });
        await page.screenshot({
            scale: "css",
            path: test.info().outputPath("config-run-effective-saved.png"),
            fullPage: true,
        });

        // 2. The chat UI must have refreshed its resolved config cache before the
        //    send, so the payload cannot come from the stale store.
        await page.goto("/workspace", { waitUntil: "load" });
        await page.waitForFunction(
            (expected) => {
                const raw = localStorage.getItem("xihe-config-merged");
                if (!raw) return false;
                try {
                    const profile = JSON.parse(raw)["llm-provider"]?.profile;
                    return profile !== undefined && JSON.parse(profile).model === expected;
                } catch {
                    return false;
                }
            },
            uniqueModel,
            { timeout: 15000 },
        );

        // 3. A session without a model binding: its first send resolves the
        //    provider/model through the saved profile (the chain PLAN-0504 owns).
        await ensureAgentWorkspaceBinding(auth.workspaceId);
        const principalId = await provisionWorkspaceAgentPrincipal(request, auth, {
            name: "P0504 Profile Agent",
        });
        const sessionId = await createSessionWithPrincipal(request, auth, {
            principalId,
            title: "P0504 profile default",
        });
        await page.goto(`/workspace/${auth.workspaceId}/chat/${sessionId}`, { waitUntil: "load" });
        await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 15000 });

        const marker = `p0504-${Date.now()}`;
        const [sendRequest] = await Promise.all([
            page.waitForRequest(
                (req) => req.method() === "POST" && req.url().includes("/api/v1/chat"),
            ),
            (async () => {
                await page.locator('[data-testid="chat-input"]').fill(marker);
                await page.locator('[data-testid="chat-send-button"]').click();
            })(),
        ]);
        const payload = JSON.parse(sendRequest.postData() ?? "{}") as {
            provider?: string;
            model?: string;
        };
        expect(payload.provider).toBe("openai");
        expect(payload.model).toBe(uniqueModel);
        await page.screenshot({
            scale: "css",
            path: test.info().outputPath("config-run-effective-applied.png"),
            fullPage: true,
        });
    });
});
