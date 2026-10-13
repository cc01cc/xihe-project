import { createHash, randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { generateE2EPassword } from "./helpers/password";

const CP_URL = `http://127.0.0.1:${process.env.XIHE_CP_PORT || "12631"}`;
const UI_URL = `http://localhost:${process.env.XIHE_UI_PORT || "12630"}`;
const FAKE_LLM_PORT = process.env.XIHE_FAKE_LLM_PORT || "";
const ADMIN_EMAIL = "admin@xihe.local";
const DRIFT_MODEL = "gone-model-0503";

// Java UUID.nameUUIDFromBytes（v3, MD5）复刻：与 CP builtins() 的确定性 id 对齐。
function nameUuidFromBytes(name: string): string {
    const bytes = Buffer.from(createHash("md5").update(name, "utf8").digest()),
        versioned = ((bytes[6] & 0x0f) | 0x30) as number,
        variant = ((bytes[8] & 0x3f) | 0x80) as number;
    bytes[6] = versioned;
    bytes[8] = variant;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

interface LoginResult {
    accessToken: string;
    user: Record<string, unknown>;
    workspaceId: string;
}

let adminAuth: LoginResult;
let userAuth: LoginResult;
let userConnectionId = "";

async function loginAsAdmin(request: APIRequestContext) {
    const password = process.env.XIHE_E2E_ADMIN_PASSWORD ?? "";
    expect(password, "XIHE_E2E_ADMIN_PASSWORD must be provided by e2e-host").not.toBe("");
    const login = await request.post(`${CP_URL}/api/v1/auth/login`, {
        data: { email: ADMIN_EMAIL, password },
    });
    expect(login.ok(), await login.text()).toBe(true);
    adminAuth = (await login.json()) as LoginResult;
}

async function injectSession(page: Page, auth: LoginResult) {
    await page.addInitScript(
        ({ token, user, workspaceId }) => {
            localStorage.setItem("xihe-token", token);
            localStorage.setItem("xihe-user", JSON.stringify(user));
            localStorage.setItem(
                "xihe-workspace",
                JSON.stringify({ id: workspaceId, name: "E2E" }),
            );
        },
        { token: auth.accessToken, user: auth.user, workspaceId: auth.workspaceId },
    );
}

async function expandLlmPanel(page: Page) {
    const panel = page.getByTestId("config-domain-llm-provider");
    await expect(panel).toBeVisible({ timeout: 15000 });
    await panel.locator("button").first().click();
    return panel;
}

/**
 * Readiness probe: wait until the user-scoped directory (the same response the
 * config page consumes) lists the connection as ready with the given model.
 * Fails with the last response body so a directory regression is diagnosable.
 */
async function waitForDirectoryCatalog(
    request: APIRequestContext,
    connectionId: string,
    model: string,
) {
    const deadline = Date.now() + 30000;
    let last = "";
    while (Date.now() < deadline) {
        const response = await request.get(`${CP_URL}/api/v1/models`, {
            headers: { Authorization: `Bearer ${userAuth.accessToken}` },
        });
        last = await response.text();
        try {
            const body = JSON.parse(last) as {
                models?: Record<string, string[]>;
                providers?: Record<string, { status?: string }>;
            };
            if (
                body.providers?.[connectionId]?.status === "ready" &&
                body.models?.[connectionId]?.includes(model)
            ) {
                return;
            }
        } catch {
            // keep polling until the deadline; last body is reported on failure
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`directory never exposed ${model} for ${connectionId}: ${last.slice(0, 800)}`);
}

test.describe.serial("@host PLAN-0503 config catalog sourcing", () => {
    test.beforeAll(async ({ request }) => {
        expect(FAKE_LLM_PORT, "XIHE_FAKE_LLM_PORT must be provided by e2e-host").not.toBe("");
        await loginAsAdmin(request);
        const registration = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: {
                email: `plan0503-${randomUUID()}@test.local`,
                password: generateE2EPassword(),
                name: "PLAN-0503",
            },
        });
        expect(registration.status()).toBe(201);
        userAuth = (await registration.json()) as LoginResult;
    });

    test("V2/V4: instance dropdown matches the catalog and drift stays visible", async ({
        page,
        request,
    }) => {
        test.setTimeout(120000);
        // Seed an in-catalog provider plus a catalog-external model at instance layer.
        const seeded = await request.put(`${CP_URL}/api/v1/config/instance/llm-provider`, {
            headers: { Authorization: `Bearer ${adminAuth.accessToken}` },
            data: { defaultProvider: "openrouter", defaultModel: DRIFT_MODEL },
        });
        expect(seeded.status(), await seeded.text()).toBe(200);

        const catalogResponse = await request.get(`${CP_URL}/api/v1/provider-catalog`, {
            headers: { Authorization: `Bearer ${adminAuth.accessToken}` },
        });
        expect(catalogResponse.ok()).toBe(true);
        const catalog = (await catalogResponse.json()) as {
            providers: { id: string }[];
        };
        const catalogIds = catalog.providers.map((provider) => provider.id);
        expect(catalogIds.length).toBeGreaterThan(5);

        const directoryResponse = await request.get(`${CP_URL}/api/v1/models`, {
            headers: { Authorization: `Bearer ${adminAuth.accessToken}` },
        });
        expect(directoryResponse.ok()).toBe(true);
        const directory = (await directoryResponse.json()) as { configRevision?: string };
        const directoryRevision = directory.configRevision ?? "";
        expect(directoryRevision).not.toBe("");

        await injectSession(page, adminAuth);
        await page.goto(`${UI_URL}/settings/config`);
        await expandLlmPanel(page);

        // V2: option-by-option comparison against the catalog after the async
        // catalog fetch settles.
        const providerSelect = page.getByTestId("config-select-llm-provider-defaultProvider");
        await expect(providerSelect).toBeVisible({ timeout: 15000 });
        await expect(providerSelect.locator("option")).toHaveCount(catalogIds.length, {
            timeout: 15000,
        });
        const optionValues = await providerSelect
            .locator("option")
            .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
        expect(optionValues).toEqual(catalogIds);

        // V4: drifted stored value is kept and labelled, never silently rewritten.
        const modelSelect = page.getByTestId("config-select-llm-provider-defaultModel");
        await expect(modelSelect).toHaveValue(DRIFT_MODEL);
        await expect(page.getByTestId("config-drift-llm-provider-defaultModel")).toBeVisible();
        await expect(page.getByTestId("config-domain-note-llm-provider")).toContainText(
            directoryRevision,
        );
        await page.screenshot({
            path: test.info().outputPath("plan0503-instance-drift.png"),
            fullPage: true,
        });

        // Reload + API read-back: the value survived without any write.
        await page.reload();
        await expandLlmPanel(page);
        await expect(page.getByTestId("config-select-llm-provider-defaultModel")).toHaveValue(
            DRIFT_MODEL,
        );
        const readBack = await request.get(
            `${CP_URL}/api/v1/config/llm-provider?layer=instance&includeMeta=true`,
            { headers: { Authorization: `Bearer ${adminAuth.accessToken}` } },
        );
        expect(readBack.ok()).toBe(true);
        const entries = ((await readBack.json()) as { entries: Record<string, string> }).entries;
        expect(entries.defaultModel).toBe(DRIFT_MODEL);

        // Mobile viewport keeps the drift label visible.
        await page.setViewportSize({ width: 390, height: 844 });
        await page.reload();
        await expandLlmPanel(page);
        await expect(page.getByTestId("config-drift-llm-provider-defaultModel")).toBeVisible();
        await page.screenshot({
            path: test.info().outputPath("plan0503-instance-drift-mobile.png"),
            fullPage: true,
        });
    });

    test("V3/V5: user candidates come from the READY directory; handfill saves", async ({
        page,
        request,
    }) => {
        test.setTimeout(120000);
        const connectionKey = `catalog-${randomUUID().slice(0, 8)}`;
        const created = await request.post(`${CP_URL}/api/v1/provider-connections`, {
            headers: { Authorization: `Bearer ${userAuth.accessToken}` },
            data: {
                providerId: "openai",
                label: `PLAN-0503 chat ${connectionKey}`,
                scope: "USER",
                connectionKey,
                apiTypeId: "openai-chat-completions",
                apiTypeVersion: 1,
                modelDiscovery: "remote-models",
                baseUrl: `http://127.0.0.1:${FAKE_LLM_PORT}/openai/v1`,
                // The fake LLM validates credentials per provider; 200 on verify
                // does NOT imply READY (the status field decides).
                apiKey: "sk-fake-openai-key",
            },
        });
        expect(created.status(), await created.text()).toBe(201);
        userConnectionId = ((await created.json()) as { id: string }).id;
        const verified = await request.post(
            `${CP_URL}/api/v1/provider-connections/${userConnectionId}/verify`,
            { headers: { Authorization: `Bearer ${userAuth.accessToken}` } },
        );
        const verifiedText = await verified.text();
        expect(verified.ok(), verifiedText).toBe(true);
        expect(
            (JSON.parse(verifiedText) as { connection?: { status?: string } }).connection?.status,
            verifiedText,
        ).toBe("READY");
        await waitForDirectoryCatalog(request, userConnectionId, "fake-openai");

        await injectSession(page, userAuth);
        await page.goto(`${UI_URL}/settings/config`);
        await page.getByTestId("config-tab-user").click();
        const panel = await expandLlmPanel(page);
        await page.getByTestId("config-select-llm-provider-defaultProvider").selectOption("openai");

        // V3: ready + chat only (the -asr catalog entry is filtered out).
        const modelSelect = page.getByTestId("config-select-llm-provider-defaultModel");
        await expect(modelSelect.locator("option")).toHaveCount(3, { timeout: 15000 });
        const optionValues = await modelSelect
            .locator("option")
            .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
        expect(optionValues).toEqual(["", "fake-openai", "__custom__"]);
        await page.screenshot({
            path: test.info().outputPath("plan0503-user-candidates.png"),
            fullPage: true,
        });

        // V5: directory-independent manual entry saves through the real PUT.
        await modelSelect.selectOption("__custom__");
        await page.getByTestId("config-custom-llm-provider-defaultModel").fill("manual-model-0503");
        const [saved] = await Promise.all([
            page.waitForResponse(
                (response) =>
                    response.url().includes("/api/v1/config/user/llm-provider") &&
                    response.request().method() === "PUT",
            ),
            panel.getByRole("button", { name: "保存", exact: true }).click(),
        ]);
        expect(saved.status()).toBe(200);
        await page.reload();
        await page.getByTestId("config-tab-user").click();
        await expandLlmPanel(page);
        await expect(page.getByTestId("config-select-llm-provider-defaultModel")).toHaveValue(
            "manual-model-0503",
        );
    });

    test("V5: an empty directory still allows manual entry; the provider gate holds", async ({
        page,
        request,
    }) => {
        test.setTimeout(120000);
        const registration = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: {
                email: `plan0503-noconn-${randomUUID()}@test.local`,
                password: generateE2EPassword(),
                name: "PLAN-0503 no-conn",
            },
        });
        expect(registration.status()).toBe(201);
        const noConnAuth = (await registration.json()) as LoginResult;

        await injectSession(page, noConnAuth);
        await page.goto(`${UI_URL}/settings/config`);
        await page.getByTestId("config-tab-user").click();
        const panel = await expandLlmPanel(page);

        // V5: with no READY connection the model field still accepts a manual
        // value through the escape and saves through the real PUT.
        await page
            .getByTestId("config-select-llm-provider-defaultModel")
            .selectOption("__custom__");
        await page
            .getByTestId("config-custom-llm-provider-defaultModel")
            .fill("manual-no-conn-0503");
        const [saved] = await Promise.all([
            page.waitForResponse(
                (response) =>
                    response.url().includes("/api/v1/config/user/llm-provider") &&
                    response.request().method() === "PUT",
            ),
            panel.getByRole("button", { name: "保存", exact: true }).click(),
        ]);
        expect(saved.status()).toBe(200);

        // The user-layer readiness gate is unchanged: writing a provider
        // without a READY connection is rejected by CP.
        const rejected = await request.put(`${CP_URL}/api/v1/config/user/llm-provider`, {
            headers: { Authorization: `Bearer ${noConnAuth.accessToken}` },
            data: { defaultProvider: "openai" },
        });
        expect(rejected.status()).toBe(400);
    });

    test("V7: provider hub lists orphan bindings and clears them on demand", async ({
        page,
        request,
    }) => {
        test.setTimeout(120000);
        expect(userConnectionId).not.toBe("");
        const builtinId = nameUuidFromBytes("api-request-templates:openai-chat-completions@1");
        const seeded = await request.put(`${CP_URL}/api/v1/config/user/api-request-templates`, {
            headers: { Authorization: `Bearer ${userAuth.accessToken}` },
            data: {
                providerModelBindings: JSON.stringify({
                    [userConnectionId]: {
                        "ghost-model": { layer: "instance", templateId: builtinId, version: 1 },
                    },
                }),
            },
        });
        expect(seeded.status(), await seeded.text()).toBe(200);

        await injectSession(page, userAuth);
        await page.goto(`${UI_URL}/settings/config`);
        await page.getByTestId("config-tab-user").click();

        const orphanRow = page.getByTestId("provider-orphan-model-ghost-model");
        await expect(orphanRow).toBeVisible({ timeout: 15000 });
        await expect(page.getByTestId("provider-orphan-bindings")).toContainText(
            "已绑定但当前不可用",
        );
        await page.screenshot({
            path: test.info().outputPath("plan0503-orphan-bindings.png"),
            fullPage: true,
        });

        // Clearing the orphan binding goes through the real PUT and drops the row.
        const [cleared] = await Promise.all([
            page.waitForResponse(
                (response) =>
                    response.url().includes("/api/v1/config/user/api-request-templates") &&
                    response.request().method() === "PUT",
            ),
            orphanRow.locator("select").selectOption(""),
        ]);
        expect(cleared.status()).toBe(200);
        await expect(page.getByTestId("provider-orphan-bindings")).toHaveCount(0);

        const readBack = await request.get(
            `${CP_URL}/api/v1/config/api-request-templates?layer=user&includeMeta=true`,
            { headers: { Authorization: `Bearer ${userAuth.accessToken}` } },
        );
        const entries = ((await readBack.json()) as { entries: Record<string, string> }).entries;
        const bindings = JSON.parse(entries.providerModelBindings ?? "{}") as Record<
            string,
            unknown
        >;
        expect(bindings[userConnectionId]).toBeUndefined();
    });
});
