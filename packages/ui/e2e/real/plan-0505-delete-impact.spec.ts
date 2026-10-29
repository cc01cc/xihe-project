import { test, expect } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { generateE2EPassword } from "./helpers/password";

const CP_URL = `http://127.0.0.1:${process.env.XIHE_CP_PORT || "12631"}`,
    PROVIDER_ID = "custom-openai-compatible",
    CONNECTION_KEY = "cascade";

type Auth = { accessToken: string; workspaceId: string; userId: string };

async function register(request: APIRequestContext, name: string): Promise<Auth> {
    const email = `${name}-${Date.now()}@test.local`;
    const response = await request.post(`${CP_URL}/api/v1/auth/register`, {
        data: { email, password: generateE2EPassword(), name },
    });
    expect(response.status(), await response.text()).toBe(201);
    const body = await response.json();
    return {
        accessToken: body.accessToken,
        workspaceId: body.workspaceId,
        userId: body.user.id,
    };
}

function authHeaders(auth: Auth): Record<string, string> {
    return {
        Authorization: `Bearer ${auth.accessToken}`,
        "X-Workspace-Id": auth.workspaceId,
    };
}

function installAuth(page: Page, auth: Auth) {
    void page.addInitScript(
        ({ token, workspaceId, userId }) => {
            localStorage.setItem("xihe-token", token);
            localStorage.setItem("xihe-user", JSON.stringify({ workspaceId }));
            localStorage.setItem(
                "xihe-workspace",
                JSON.stringify({ id: workspaceId, name: "Default Workspace" }),
            );
            // PLAN-0577: per-tab workspace context wins over localStorage.
            // Without overwriting sessionStorage the second viewport run keeps
            // the previous user's workspace id and CP rejects the request.
            sessionStorage.setItem(
                "xihe-workspace",
                JSON.stringify({
                    id: workspaceId,
                    name: "Default Workspace",
                    workspaceRole: "OWNER",
                    ownerId: userId,
                }),
            );
        },
        { token: auth.accessToken, workspaceId: auth.workspaceId, userId: auth.userId },
    );
}

// PLAN-0505 V4（真实链路浏览器验证）：API 种子连接与三类引用 → UI 删除入口
// 拉取 delete-impact 预览 → 取消（服务端零变更）→ 确认 → 级联清理读回为零。
// PLAN-0577：同一真实流程分别覆盖桌面与移动 viewport，每次使用独立用户数据。
// 跑法：node scripts/e2e-host.mjs --skip-runtime --llm-mode=mock
//        e2e/real/plan-0505-delete-impact.spec.ts
// （连接经 API 种子而非 UI 表单：mock 夹具的 picker→form 链路存在预存债务，
//  见 PLAN-0401 evidence；删除流本身不依赖该夹具。）
const VIEWPORTS = [
    { tag: "desktop", width: 1920, height: 1080 },
    { tag: "mobile", width: 390, height: 844 },
] as const;

async function adminAccessToken(request: APIRequestContext): Promise<string | null> {
    const adminPassword = process.env.XIHE_E2E_ADMIN_PASSWORD ?? "";
    if (!adminPassword) return null;
    const login = await request.post(`${CP_URL}/api/v1/auth/login`, {
        data: { identifier: "admin@xihe.local", password: adminPassword },
    });
    if (!login.ok()) return null;
    return ((await login.json()) as { accessToken: string }).accessToken;
}

/** Read the instance-layer `llm-provider.profile` exactly as stored (null = absent). */
async function readInstanceLlmProfile(request: APIRequestContext): Promise<string | null> {
    const token = await adminAccessToken(request);
    if (!token) return null;
    const response = await request.get(
        `${CP_URL}/api/v1/config/llm-provider?layer=instance&includeMeta=true`,
        { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok()) return null;
    const entries = ((await response.json()) as { entries?: Record<string, string> }).entries ?? {};
    return entries.profile ?? null;
}

/** Restore the snapshot so later specs in the batch keep a resolvable profile. */
async function restoreInstanceLlmProfile(
    request: APIRequestContext,
    originalProfile: string | null,
): Promise<void> {
    const token = await adminAccessToken(request);
    expect(token, "admin login must succeed to restore the instance llm-provider profile").not.toBe(
        null,
    );
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const response =
        originalProfile === null
            ? // The key was absent before the seed: remove it again (404 = already gone).
              await request.delete(`${CP_URL}/api/v1/config/instance/llm-provider/profile`, {
                  headers,
              })
            : await request.put(`${CP_URL}/api/v1/config/instance/llm-provider`, {
                  headers,
                  data: { profile: originalProfile },
              });
    expect(
        [200, 204, 404],
        `restore instance llm-provider: ${response.status()} ${await response.text()}`,
    ).toContain(response.status());
}

test.describe.serial("@host PLAN-0505 delete impact and cascade (browser)", () => {
    // Snapshot of the pre-test instance `llm-provider.profile` (null = absent).
    let originalInstanceProfile: string | null = null;
    let instanceProfileCaptured = false;

    test.afterAll(async ({ request }) => {
        if (!instanceProfileCaptured) return;
        await restoreInstanceLlmProfile(request, originalInstanceProfile);
        instanceProfileCaptured = false;
    });

    test("preview counts, cancel keeps zero mutation, confirm cascades references away (desktop + mobile)", async ({
        page,
        request,
    }, testInfo) => {
        test.setTimeout(180000);

        for (const viewport of VIEWPORTS) {
            await page.setViewportSize({ width: viewport.width, height: viewport.height });
            const auth = await register(request, `plan0505-${viewport.tag}`);
            installAuth(page, auth);

            // Seed: user connection (UNVERIFIED is fine — delete needs no READY).
            const created = await request.post(`${CP_URL}/api/v1/provider-connections`, {
                headers: authHeaders(auth),
                data: {
                    providerId: PROVIDER_ID,
                    label: `Browser Cascade ${viewport.tag}`,
                    scope: "USER",
                    apiKey: "isolated-test-only",
                    baseUrl: "http://localhost:1/v1",
                    modelDiscovery: "manual",
                    manualModels: ["m1", "m2"],
                    connectionKey: CONNECTION_KEY,
                },
            });
            expect(created.status(), await created.text()).toBe(201);
            const connection = (await created.json()) as {
                id: string;
                revision: number;
            };
            const id = connection.id;

            // Seed: user-layer model bindings (m1 + m2) against the instance builtin ref.
            const definitions = await request.get(
                `${CP_URL}/api/v1/config/api-request-templates?layer=instance`,
                { headers: authHeaders(auth) },
            );
            expect(definitions.ok(), await definitions.text()).toBe(true);
            const list = (await definitions.json()) as {
                templates: string | Array<{ id: string; version: number; apiTypeId: string }>;
            };
            const parsed = (
                typeof list.templates === "string" ? JSON.parse(list.templates) : list.templates
            ) as Array<{ id: string; version: number; apiTypeId: string }>;
            const openai = parsed.find((item) => item.apiTypeId === "openai-chat-completions");
            expect(openai, "instance openai-chat-completions builtin must exist").toBeTruthy();
            const ref = { layer: "instance", templateId: openai!.id, version: openai!.version };
            const bindings = await request.put(
                `${CP_URL}/api/v1/config/user/api-request-templates`,
                {
                    headers: { ...authHeaders(auth), "Content-Type": "application/json" },
                    data: {
                        providerModelBindings: JSON.stringify({
                            [id]: { m1: ref, m2: ref },
                        }),
                    },
                },
            );
            expect(bindings.status(), await bindings.text()).toBe(200);

            // Seed: owner-layer connectionDefaultTemplates entry.
            const patched = await request.patch(`${CP_URL}/api/v1/provider-connections/${id}`, {
                headers: { ...authHeaders(auth), "Content-Type": "application/json" },
                data: {
                    expectedRevision: connection.revision,
                    connectionDefaultTemplateRef: ref,
                },
            });
            expect(patched.status(), await patched.text()).toBe(200);

            // Seed: instance llm-provider profile pointing at this connection
            // (admin seed: instance writes skip the connection readiness check).
            // State-leak guard (2026-10-29 mock-full finding): this write is
            // global (instance layer) and used to survive the spec, so later
            // Agent rebinds resolved a deleted connection and reported
            // missing_credentials. Snapshot the pre-test value once and restore
            // it in the describe-level afterAll.
            if (!instanceProfileCaptured) {
                originalInstanceProfile = await readInstanceLlmProfile(request);
                instanceProfileCaptured = true;
            }
            const adminPassword = process.env.XIHE_E2E_ADMIN_PASSWORD ?? "";
            expect(adminPassword, "XIHE_E2E_ADMIN_PASSWORD must be provided by e2e-host").not.toBe(
                "",
            );
            const adminLogin = await request.post(`${CP_URL}/api/v1/auth/login`, {
                data: { identifier: "admin@xihe.local", password: adminPassword },
            });
            expect(adminLogin.ok(), await adminLogin.text()).toBe(true);
            const adminToken = ((await adminLogin.json()) as { accessToken: string }).accessToken;
            const profile = await request.put(`${CP_URL}/api/v1/config/instance/llm-provider`, {
                headers: {
                    Authorization: `Bearer ${adminToken}`,
                    "Content-Type": "application/json",
                },
                data: {
                    profile: JSON.stringify({
                        providerId: PROVIDER_ID,
                        connectionKey: CONNECTION_KEY,
                        model: "m1",
                    }),
                },
            });
            expect(profile.status(), await profile.text()).toBe(200);

            // UI: open the settings hub and drive the delete confirm flow.
            await page.goto("/settings/config");
            const article = page.locator(
                `[data-testid="provider-connection-${PROVIDER_ID}"][data-connection-key="${CONNECTION_KEY}"]`,
            );
            await expect(article).toBeVisible({ timeout: 15000 });
            await article.getByTestId(`provider-connection-delete-${id}`).click();
            const dialog = page.getByTestId("provider-delete-confirm-modal");
            await expect(dialog).toBeVisible();
            await expect(dialog.getByText("删除 Provider 连接")).toBeVisible();
            const summary = page.getByTestId("provider-delete-impact-summary");
            await expect(summary).toContainText("模型绑定 2 项（1 个用户）");
            await expect(summary).toContainText("连接默认模板指向 1 项");
            await expect(summary).toContainText("默认身份 profile 1 项");
            const screenshot = testInfo.outputPath(`plan-0505-delete-confirm-${viewport.tag}.png`);
            await page.screenshot({ scale: "css", path: screenshot, fullPage: false });
            await testInfo.attach(`plan-0505-delete-confirm-${viewport.tag}.png`, {
                path: screenshot,
                contentType: "image/png",
            });

            // Cancel: no server-side mutation of the connection or its references.
            await page.getByTestId("provider-delete-cancel").click();
            await expect(dialog).not.toBeVisible();
            await expect(article).toBeVisible();

            const connectionsAfterCancel = await request.get(
                `${CP_URL}/api/v1/provider-connections`,
                { headers: authHeaders(auth) },
            );
            expect(connectionsAfterCancel.ok()).toBe(true);
            const connectionsBody = (await connectionsAfterCancel.json()) as {
                connections: Array<{ id: string }>;
            };
            expect(
                connectionsBody.connections.some((entry) => entry.id === id),
                "cancel must not delete the connection",
            ).toBe(true);

            const templatesAfterCancel = await request.get(
                `${CP_URL}/api/v1/config/api-request-templates?layer=user`,
                { headers: authHeaders(auth) },
            );
            expect(templatesAfterCancel.ok()).toBe(true);
            expect(
                JSON.stringify(await templatesAfterCancel.json()),
                "cancel must keep model bindings and the connection default ref",
            ).toContain(id);

            const profileAfterCancel = await request.get(
                `${CP_URL}/api/v1/config/llm-provider?layer=instance`,
                { headers: { Authorization: `Bearer ${adminToken}` } },
            );
            expect(profileAfterCancel.ok(), await profileAfterCancel.text()).toBe(true);
            expect(
                JSON.stringify(await profileAfterCancel.json()),
                "cancel must keep the instance profile",
            ).toContain(CONNECTION_KEY);

            // Confirm: cascade delete succeeds.
            await article.getByTestId(`provider-connection-delete-${id}`).click();
            await expect(dialog).toBeVisible();
            await page.getByTestId("provider-delete-confirm").click();
            await expect(article).toHaveCount(0, { timeout: 15000 });
            await expect(page.getByTestId("provider-delete-confirm-modal")).not.toBeVisible();

            // V1 read-back: the connection and all three reference kinds are gone.
            const remaining = await request.get(`${CP_URL}/api/v1/provider-connections`, {
                headers: authHeaders(auth),
            });
            expect(remaining.ok()).toBe(true);
            const remainingBody = (await remaining.json()) as {
                connections: Array<{ id: string }>;
            };
            expect(
                remainingBody.connections.some((entry) => entry.id === id),
                "the deleted connection must disappear from the list",
            ).toBe(false);

            const templatesRead = await request.get(
                    `${CP_URL}/api/v1/config/api-request-templates?layer=user`,
                    { headers: authHeaders(auth) },
                ),
                profileRead = await request.get(
                    `${CP_URL}/api/v1/config/llm-provider?layer=instance`,
                    {
                        headers: { Authorization: `Bearer ${adminToken}` },
                    },
                );
            expect(templatesRead.ok()).toBe(true);
            expect(profileRead.ok(), await profileRead.text()).toBe(true);
            const templatesBody = JSON.stringify(await templatesRead.json()),
                profileBody = JSON.stringify(await profileRead.json());
            expect(templatesBody, "bindings and default refs must be cascaded away").not.toContain(
                id,
            );
            expect(
                profileBody,
                "the instance profile pointing at the connection must be gone",
            ).not.toContain(CONNECTION_KEY);
        }
    });
});
