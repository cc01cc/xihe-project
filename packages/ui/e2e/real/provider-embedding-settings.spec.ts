import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { generateE2EPassword } from "./helpers/password";

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;
let auth: { accessToken: string; workspaceId: string };

test.beforeAll(async ({ request }) => {
    const registration = await request.post(`${CP_URL}/api/v1/auth/register`, {
        data: {
            email: `embedding-${randomUUID()}@test.local`,
            password: generateE2EPassword(),
            name: "Embedding Settings",
        },
    });
    expect(registration.status()).toBe(201);
    auth = await registration.json();
});

test.describe.serial("@host PLAN-0485 embedding provider settings", () => {
    test("creates an embedding connection, saves the whole-unit profile and shows the fixed contract", async ({
        page,
        request,
    }) => {
        test.setTimeout(90000);

        // Log in through the UI origin to carry the session into settings.
        await page.goto("/");
        await page.evaluate((token) => {
            localStorage.setItem("xihe-token", token);
            localStorage.setItem(
                "xihe-user",
                JSON.stringify({ id: "e2e", email: "embedding@test.local", role: "USER" }),
            );
            localStorage.setItem(
                "xihe-workspace",
                JSON.stringify({ id: auth.workspaceId, name: "E2E" }),
            );
        }, auth.accessToken);

        const providerKey = `sk-e2e-not-a-real-key-${randomUUID()}`,
            connectionKey = `embed-${randomUUID().slice(0, 8)}`;

        // Create the embedding connection through the API (the ProviderHub modal
        // flow is covered by PLAN-0439 spec); the settings panel is the surface
        // under test here. The catalog sanity check doubles as an auth probe.
        const catalog = await request.get(`${CP_URL}/api/v1/providers`, {
            headers: { Authorization: `Bearer ${auth.accessToken}` },
        });
        expect(catalog.status()).toBe(200);
        const created = await request.post(`${CP_URL}/api/v1/provider-connections`, {
            headers: {
                Authorization: `Bearer ${auth.accessToken}`,
                "X-Workspace-Id": auth.workspaceId,
            },
            data: {
                providerId: "dashscope-qwen",
                label: "E2E embedding",
                scope: "USER",
                connectionKey,
                apiTypeId: "dashscope-multimodal-embedding",
                apiTypeVersion: 1,
                modelDiscovery: "manual",
                manualModels: ["tongyi-embedding-vision-flash-2026-03-06"],
                apiKey: providerKey,
            },
        });
        expect(created.status()).toBe(201);
        const connection = (await created.json()) as { id: string };
        expect(connection.id).toBeTruthy();

        await page.goto("/settings/config");

        // The whole-unit profile selects the only READY embedding connection.
        const panel = page.getByTestId("embedding-settings");
        await expect(panel).toBeVisible({ timeout: 15000 });
        const select = panel.getByTestId("embedding-connection-select");
        await expect(select).toBeEnabled({ timeout: 15000 });
        await expect(select).toContainText("E2E embedding");

        // Fixed V1 contract is displayed, never editable.
        const contract = panel.getByTestId("embedding-contract");
        await expect(contract).toContainText("tongyi-embedding-vision-flash-2026-03-06");
        await expect(contract).toContainText("768");

        await panel.getByTestId("embedding-save").click();
        await expect(page.getByText(/嵌入配置已保存|Embedding profile saved/)).toBeVisible({
            timeout: 15000,
        });

        // Effective scope flips to user after save; profile survives a reload.
        await page.reload();
        const reloaded = page.getByTestId("embedding-settings");
        await expect(reloaded.getByTestId("embedding-connection-select")).toHaveValue(
            connection.id,
            { timeout: 15000 },
        );
        await expect(reloaded.getByTestId("embedding-contract")).toContainText("768");

        // The test button must not offer a body input; provider failure surfaces
        // as a stable code only (no key, no provider payload).
        await reloaded.getByTestId("embedding-test").click();
        await expect(page.getByTestId("embedding-test-result")).toBeVisible({ timeout: 30000 });
        const result = page.getByTestId("embedding-test-result");
        const resultText = await result.textContent();
        expect(resultText).toMatch(/status/i);
        expect(resultText).not.toContain(providerKey);
        // The fake key cannot authenticate upstream; either a sanitized provider
        // error code or a transport-unreachable code is acceptable, both stable.
        expect(resultText).toMatch(/EMBEDDING_PROVIDER_|API_TYPE_|PROVIDER_CREDENTIAL_|ok/i);
    });
});
