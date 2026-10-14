import { createHash, randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { generateE2EPassword } from "./helpers/password";

// PLAN-0504 supersedes the PLAN-0503 defaultProvider/defaultModel UI: the
// llm-provider default identity is the whole `profile` unit edited by the
// dedicated connection+model panel. This host spec keeps the original file
// name (PLAN-0503 history) but now exercises the profile panel with the same
// catalog sourcing / drift / hand-fill semantics, plus the 0504 write gate.
const CP_URL = `http://127.0.0.1:${process.env.XIHE_CP_PORT || "12631"}`;
const UI_URL = `http://localhost:${process.env.XIHE_UI_PORT || "12630"}`;
const FAKE_LLM_PORT = process.env.XIHE_FAKE_LLM_PORT || "";
const ADMIN_EMAIL = "admin@xihe.local";
const DRIFT_MODEL = "gone-model-0503";
const DRIFT_CONNECTION_KEY = "gone-0503";

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

function profileUnit(providerId: string, connectionKey: string, model: string): string {
    return JSON.stringify({ providerId, connectionKey, model });
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

test.describe.serial("@host PLAN-0504 llm-provider profile panel", () => {
    test.beforeAll(async ({ request }) => {
        expect(FAKE_LLM_PORT, "XIHE_FAKE_LLM_PORT must be provided by e2e-host").not.toBe("");
        await loginAsAdmin(request);
        const registration = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: {
                email: `plan0504-${randomUUID()}@test.local`,
                password: generateE2EPassword(),
                name: "PLAN-0504",
            },
        });
        expect(registration.status()).toBe(201);
        userAuth = (await registration.json()) as LoginResult;
    });

    test("V4: instance profile with an invisible connection is annotated, kept and never rewritten", async ({
        page,
        request,
    }) => {
        test.setTimeout(120000);
        // Instance layer skips the connection check (decision #11): a pattern
        // profile pointing at a connection that does not exist here is legal.
        const seeded = await request.put(`${CP_URL}/api/v1/config/instance/llm-provider`, {
            headers: { Authorization: `Bearer ${adminAuth.accessToken}` },
            data: { profile: profileUnit("openai", DRIFT_CONNECTION_KEY, DRIFT_MODEL) },
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

        // V4: the stored connection is no longer visible — the panel keeps the
        // value visible, labels it and never silently rewrites it.
        const panel = page.getByTestId("llm-provider-profile");
        await expect(panel).toBeVisible({ timeout: 15000 });
        await expect(page.getByTestId("llm-profile-connection-select")).toHaveValue("__stored__");
        await expect(page.getByTestId("llm-profile-connection-drift")).toBeVisible();
        await expect(page.getByTestId("llm-profile-connection-drift-option")).toContainText(
            `openai/${DRIFT_CONNECTION_KEY}`,
        );
        const modelSelect = page.getByTestId("llm-profile-model-select");
        await expect(modelSelect).toHaveValue(DRIFT_MODEL);
        await expect(modelSelect.locator("option")).toHaveCount(3);

        // PLAN-0503 catalog sourcing still holds for the kept provider select.
        const domainPanel = page.getByTestId("config-domain-llm-provider");
        await domainPanel.locator("button").first().click();
        const providerSelect = page.getByTestId("config-select-llm-provider-imageProvider");
        await expect(providerSelect).toBeVisible({ timeout: 15000 });
        const optionValues = await providerSelect
            .locator("option")
            .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
        expect(optionValues).toEqual([...catalogIds, ""]);
        await expect(page.getByTestId("config-domain-note-llm-provider")).toContainText(
            directoryRevision,
        );
        await page.screenshot({
            path: test.info().outputPath("plan0504-instance-drift.png"),
            fullPage: true,
        });

        // Re-saving the drifted profile keeps it byte-identical (no rewrite).
        const [saved] = await Promise.all([
            page.waitForResponse(
                (response) =>
                    response.url().includes("/api/v1/config/instance/llm-provider") &&
                    response.request().method() === "PUT",
            ),
            page.getByTestId("llm-profile-save").click(),
        ]);
        expect(saved.status()).toBe(200);
        expect(JSON.parse(saved.request().postData() ?? "{}").profile).toBe(
            profileUnit("openai", DRIFT_CONNECTION_KEY, DRIFT_MODEL),
        );

        // Reload + API read-back: the value survived without any other write.
        await page.reload();
        await expect(page.getByTestId("llm-profile-model-select")).toHaveValue(DRIFT_MODEL, {
            timeout: 15000,
        });
        const readBack = await request.get(
            `${CP_URL}/api/v1/config/llm-provider?layer=instance&includeMeta=true`,
            { headers: { Authorization: `Bearer ${adminAuth.accessToken}` } },
        );
        expect(readBack.ok()).toBe(true);
        const entries = ((await readBack.json()) as { entries: Record<string, string> }).entries;
        expect(entries.profile).toBe(profileUnit("openai", DRIFT_CONNECTION_KEY, DRIFT_MODEL));

        // Mobile viewport keeps the drift label visible.
        await page.setViewportSize({ width: 390, height: 844 });
        await page.reload();
        await expect(page.getByTestId("llm-profile-connection-drift")).toBeVisible({
            timeout: 15000,
        });
        await page.screenshot({
            path: test.info().outputPath("plan0504-instance-drift-mobile.png"),
            fullPage: true,
        });
    });

    test("V4: user candidates come from the READY connection directory; save writes the whole unit", async ({
        page,
        request,
    }) => {
        test.setTimeout(120000);
        const connectionKey = `profile-${randomUUID().slice(0, 8)}`;
        const created = await request.post(`${CP_URL}/api/v1/provider-connections`, {
            headers: { Authorization: `Bearer ${userAuth.accessToken}` },
            data: {
                providerId: "openai",
                label: `PLAN-0504 chat ${connectionKey}`,
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
        const panel = page.getByTestId("llm-provider-profile");
        await expect(panel).toBeVisible({ timeout: 15000 });

        // V4: the connection selector lists visible chat-ready connections.
        const connectionSelect = page.getByTestId("llm-profile-connection-select");
        const connectionOptions = await connectionSelect
            .locator("option")
            .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
        expect(connectionOptions).toContain(userConnectionId);
        await connectionSelect.selectOption(userConnectionId);

        // V3: ready + chat only (the -asr catalog entry is filtered out).
        const modelSelect = page.getByTestId("llm-profile-model-select");
        await expect(modelSelect.locator("option")).toHaveCount(3, { timeout: 15000 });
        const optionValues = await modelSelect
            .locator("option")
            .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
        expect(optionValues).toEqual(["", "fake-openai", "__custom__"]);
        await modelSelect.selectOption("fake-openai");
        await page.screenshot({
            path: test.info().outputPath("plan0504-user-candidates.png"),
            fullPage: true,
        });

        // Saving writes the whole profile unit for the selected connection+model.
        const [saved] = await Promise.all([
            page.waitForResponse(
                (response) =>
                    response.url().includes("/api/v1/config/user/llm-provider") &&
                    response.request().method() === "PUT",
            ),
            page.getByTestId("llm-profile-save").click(),
        ]);
        expect(saved.status()).toBe(200);
        expect(JSON.parse(saved.request().postData() ?? "{}").profile).toBe(
            profileUnit("openai", connectionKey, "fake-openai"),
        );
        await page.reload();
        await page.getByTestId("config-tab-user").click();
        await expect(page.getByTestId("llm-profile-connection-select")).toHaveValue(
            userConnectionId,
            { timeout: 15000 },
        );
        await expect(page.getByTestId("llm-profile-model-select")).toHaveValue("fake-openai");
    });

    test("V5: a hand-written model saves through the real PUT", async ({ page, request }) => {
        test.setTimeout(120000);
        expect(userConnectionId).not.toBe("");
        const manualModel = `manual-model-0504-${randomUUID().slice(0, 6)}`;

        await injectSession(page, userAuth);
        await page.goto(`${UI_URL}/settings/config`);
        await page.getByTestId("config-tab-user").click();
        const panel = page.getByTestId("llm-provider-profile");
        await expect(panel).toBeVisible({ timeout: 15000 });

        await page.getByTestId("llm-profile-connection-select").selectOption(userConnectionId);
        await page.getByTestId("llm-profile-model-select").selectOption("__custom__");
        await page.getByTestId("llm-profile-model-custom").fill(manualModel);
        const [saved] = await Promise.all([
            page.waitForResponse(
                (response) =>
                    response.url().includes("/api/v1/config/user/llm-provider") &&
                    response.request().method() === "PUT",
            ),
            page.getByTestId("llm-profile-save").click(),
        ]);
        expect(saved.status()).toBe(200);

        const readBack = await request.get(
            `${CP_URL}/api/v1/config/llm-provider?layer=user&includeMeta=true`,
            { headers: { Authorization: `Bearer ${userAuth.accessToken}` } },
        );
        expect(readBack.ok()).toBe(true);
        const entries = ((await readBack.json()) as { entries: Record<string, string> }).entries;
        const profile = JSON.parse(entries.profile ?? "{}") as { model?: string };
        expect(profile.model).toBe(manualModel);
    });

    test("V7: no profile shows the explicit-selection hint; the user gate holds", async ({
        page,
        request,
    }) => {
        test.setTimeout(120000);
        const registration = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: {
                email: `plan0504-noconn-${randomUUID()}@test.local`,
                password: generateE2EPassword(),
                name: "PLAN-0504 no-conn",
            },
        });
        expect(registration.status()).toBe(201);
        const noConnAuth = (await registration.json()) as LoginResult;

        await injectSession(page, noConnAuth);
        await page.goto(`${UI_URL}/settings/config`);
        await page.getByTestId("config-tab-user").click();
        const panel = page.getByTestId("llm-provider-profile");
        await expect(panel).toBeVisible({ timeout: 15000 });

        // V7: with no profile the panel prompts for an explicit selection and
        // offers no implicit fallback model.
        await expect(page.getByTestId("llm-profile-empty-hint")).toBeVisible();
        await expect(page.getByTestId("llm-profile-save")).toBeDisabled();
        const connectionOptions = await page
            .getByTestId("llm-profile-connection-select")
            .locator("option")
            .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
        expect(connectionOptions).toEqual([""]);

        // The user-layer readiness gate is unchanged: a profile without a READY
        // connection is rejected by CP (400 INVALID_REQUEST).
        const rejected = await request.put(`${CP_URL}/api/v1/config/user/llm-provider`, {
            headers: { Authorization: `Bearer ${noConnAuth.accessToken}` },
            data: { profile: profileUnit("openai", "default", "gpt-4o") },
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
            path: test.info().outputPath("plan0504-orphan-bindings.png"),
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
