import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { generateE2EPassword } from "./helpers/password";

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;
const UI_URL = `http://localhost:${process.env.XIHE_UI_PORT || "12630"}`;
const MODEL = "tongyi-embedding-vision-flash-2026-03-06";

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

async function createConnection(
    request: import("@playwright/test").APIRequestContext,
    connectionKey: string,
    baseUrl?: string,
): Promise<{ status: number; body: string; id?: string }> {
    const created = await request.post(`${CP_URL}/api/v1/provider-connections`, {
        headers: { Authorization: `Bearer ${auth.accessToken}` },
        data: {
            providerId: "dashscope-qwen",
            label: `E2E embedding ${connectionKey}`,
            scope: "USER",
            connectionKey,
            apiTypeId: "dashscope-multimodal-embedding",
            apiTypeVersion: 1,
            modelDiscovery: "manual",
            manualModels: [MODEL],
            ...(baseUrl ? { baseUrl } : {}),
            apiKey: `sk-e2e-not-real-${randomUUID()}`,
        },
    });
    const body = await created.text();
    if (created.status() !== 201) {
        return { status: created.status(), body };
    }
    const connection = JSON.parse(body) as { id: string };
    const verified = await request.post(
        `${CP_URL}/api/v1/provider-connections/${connection.id}/verify`,
        { headers: { Authorization: `Bearer ${auth.accessToken}` } },
    );
    expect(verified.ok(), await verified.text()).toBe(true);
    return { status: created.status(), body, id: connection.id };
}

async function saveProfile(
    request: import("@playwright/test").APIRequestContext,
    connectionKey: string,
): Promise<void> {
    const saved = await request.put(`${CP_URL}/api/v1/config/user/embedding`, {
        headers: { Authorization: `Bearer ${auth.accessToken}` },
        data: {
            profile: JSON.stringify({ providerId: "dashscope-qwen", connectionKey, model: MODEL }),
        },
    });
    expect(saved.status(), await saved.text()).toBe(200);
}

test.describe.serial("@host PLAN-0485 embedding provider settings", () => {
    test("settings panel: selection, fixed contract, save, reload, mobile and sanitized test action", async ({
        page,
        request,
    }) => {
        test.setTimeout(120000);
        const connectionKey = `embed-${randomUUID().slice(0, 8)}`;
        const created = await createConnection(request, connectionKey);
        expect(created.status).toBe(201);
        const connectionId = created.id as string;

        await page.addInitScript(
            ({ token, workspaceId }) => {
                localStorage.setItem("xihe-token", token);
                localStorage.setItem(
                    "xihe-user",
                    JSON.stringify({ id: "e2e", email: "embedding@test.local", role: "USER" }),
                );
                localStorage.setItem(
                    "xihe-workspace",
                    JSON.stringify({ id: workspaceId, name: "E2E" }),
                );
            },
            { token: auth.accessToken, workspaceId: auth.workspaceId },
        );
        await page.goto(`${UI_URL}/settings/config`);

        const panel = page.getByTestId("embedding-settings");
        await expect(panel).toBeVisible({ timeout: 15000 });
        const select = panel.getByTestId("embedding-connection-select");
        await expect(select).toContainText(`E2E embedding ${connectionKey}`, { timeout: 15000 });
        await select.selectOption(connectionId);

        // Fixed V1 model/dimension contract is displayed, never editable.
        const contract = panel.getByTestId("embedding-contract");
        await expect(contract).toContainText(MODEL);
        await expect(contract).toContainText("768");

        await panel.getByTestId("embedding-save").click();
        await expect(contract).toContainText("768");

        // Effective profile survives a reload (prefilled to the saved connection).
        await page.reload();
        const reloaded = page.getByTestId("embedding-settings");
        await expect(reloaded.getByTestId("embedding-connection-select")).toHaveValue(
            connectionId,
            {
                timeout: 15000,
            },
        );

        // Sanitized test action: a stable status/code only, never the credential.
        await reloaded.getByTestId("embedding-test").click();
        const result = reloaded.getByTestId("embedding-test-result");
        await expect(result).toBeVisible({ timeout: 30000 });
        const resultText = (await result.textContent()) ?? "";
        expect(resultText).toMatch(/ok|EMBEDDING_PROVIDER_|API_TYPE_|PROVIDER_CREDENTIAL_/i);
        expect(resultText).not.toContain("sk-e2e");

        // Mobile viewport keeps the panel usable.
        await page.setViewportSize({ width: 390, height: 844 });
        await page.reload();
        await expect(page.getByTestId("embedding-settings")).toBeVisible({ timeout: 15000 });
        await expect(page.getByTestId("embedding-contract")).toContainText("768");
    });

    test("the embedding API Type rejects custom hosts (type-contract pin)", async ({ request }) => {
        const created = await createConnection(
            request,
            `embed-pin-${randomUUID().slice(0, 8)}`,
            "http://127.0.0.1:9/api/v1",
        );
        expect(created.status, created.body).toBe(400);
        expect(created.body).toContain("PROVIDER_CONNECTION_INVALID");
    });

    test("public RAG routes are profile-scoped and never leak credentials", async ({ request }) => {
        test.setTimeout(90000);
        const connectionKey = `embed-${randomUUID().slice(0, 8)}`;
        const created = await createConnection(request, connectionKey);
        expect(created.status).toBe(201);
        await saveProfile(request, connectionKey);
        const authHeaders = { Authorization: `Bearer ${auth.accessToken}` };

        // stats reads only the active partition and never touches a provider.
        const stats = await request.get(`${CP_URL}/api/v1/rag/stats`, { headers: authHeaders });
        expect(stats.status(), await stats.text()).toBe(200);
        const statsBody = (await stats.json()) as { totalDocuments: number; documents: unknown[] };
        expect(statsBody.totalDocuments).toBe(0);
        expect(statsBody.documents).toEqual([]);

        // Deleting an unknown document is a scoped 404, not a cross-partition hit.
        const missing = await request.delete(`${CP_URL}/api/v1/rag/documents/${randomUUID()}`, {
            headers: authHeaders,
        });
        expect(missing.status()).toBe(404);

        // Provider-touching operations fail sanitized (no key, stable code) when
        // the credential is not usable; a reachable provider would be the 200 path
        // proven at the adapter wire level (probe evidence).
        const ingest = await request.post(`${CP_URL}/api/v1/rag/ingest`, {
            headers: authHeaders,
            multipart: {
                file: {
                    name: "notes.txt",
                    mimeType: "text/plain",
                    buffer: Buffer.from("xihe embedding partition probe. ".repeat(20)),
                },
                chunkSize: "400",
                chunkOverlap: "40",
            },
        });
        const ingestBody = await ingest.text();
        expect([200, 502]).toContain(ingest.status());
        expect(ingestBody).not.toContain("sk-e2e");
        if (ingest.status() === 502) {
            expect(ingestBody).toMatch(/EMBEDDING_PROVIDER_/);
        }

        const search = await request.post(`${CP_URL}/api/v1/rag/search`, {
            headers: authHeaders,
            data: { query: "xihe embedding", topK: 3, minScore: 0.0 },
        });
        const searchBody = await search.text();
        expect([200, 502]).toContain(search.status());
        expect(searchBody).not.toContain("sk-e2e");
    });
});
