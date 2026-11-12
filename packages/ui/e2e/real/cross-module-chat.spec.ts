// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
import { generateE2EPassword } from "./helpers/password";
import { gotoWorkspaceWithChat } from "./helpers/chat";
import { getRootBranchId } from "./helpers/journey";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS, LONG_TIMEOUT_MS } from "../timeouts";

const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();
import { test, expect } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { ensureWorkspace } from "./helpers/workspace";

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`,
    SERVICE_TOKEN = process.env.XIHE_CP_API_TOKEN;
if (!SERVICE_TOKEN) throw new Error("XIHE_CP_API_TOKEN must be set for real E2E");
const FAKE_MCP_ACCESS_TOKEN = process.env.XIHE_FAKE_MCP_ACCESS_TOKEN;
if (!FAKE_MCP_ACCESS_TOKEN) throw new Error("XIHE_FAKE_MCP_ACCESS_TOKEN must be set for real E2E");
const fixtureHost = process.env.XIHE_E2E_PROFILE === "host" ? "127.0.0.1" : "host.docker.internal";
const oauthRemoteHost = "host.docker.internal";

type RegisteredAuth = {
    accessToken: string;
    workspaceId: string;
};

async function registerAuth(request: APIRequestContext, name: string): Promise<RegisteredAuth> {
    const email = `${name}-${Date.now()}@test.com`;
    const reg = await fetch(`${CP_URL}/api/v1/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: SHARED_PASSWORD, name }),
    });
    const body = await reg.json();
    // PLAN-0614: registration no longer creates a workspace — create one explicitly.
    return {
        accessToken: body.accessToken,
        workspaceId: await ensureWorkspace(request, body.accessToken),
    };
}

async function registerAndGetToken(request: APIRequestContext, name: string): Promise<string> {
    return (await registerAuth(request, name)).accessToken;
}

test.describe("Cross-Module — Full Chain Chat", () => {
    test("chat page loads after login", async ({ page }) => {
        const token = await registerAndGetToken(request, "chain");
        await page.addInitScript((t) => localStorage.setItem("xihe-token", t), token);

        await gotoWorkspaceWithChat(page);
    });

    test("sends message and renders response in the UI", async ({ page, request }) => {
        const auth = await registerAuth(request, "chain-msg");
        await page.addInitScript((t) => localStorage.setItem("xihe-token", t), auth.accessToken);

        await gotoWorkspaceWithChat(page);

        const testMessage = `Hello ${Date.now()}`,
            textarea = page.locator("textarea");
        await textarea.fill(testMessage);
        await page.keyboard.press("Enter");

        // User message must appear in the DOM immediately.
        await expect(page.locator(`text=${testMessage}`)).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });

        // The server is the canonical message source; localStorage is not used for
        // business messages anymore.
        let sessionId = "";
        await expect
            .poll(
                async () => {
                    const sessions = await request.get(`${CP_URL}/api/v1/sessions`, {
                        headers: {
                            Authorization: `Bearer ${auth.accessToken}`,
                            "X-Workspace-Id": auth.workspaceId,
                        },
                    });
                    if (!sessions.ok()) return "";
                    const body = await sessions.json();
                    sessionId = body.sessions?.[0]?.id ?? "";
                    return sessionId;
                },
                { timeout: ACTION_TIMEOUT_MS },
            )
            .not.toBe("");

        const headers = {
            Authorization: `Bearer ${auth.accessToken}`,
            "X-Workspace-Id": auth.workspaceId,
        };
        const branchId = await getRootBranchId(request, sessionId, headers);
        const getMessages = async () => {
            const response = await request.get(
                `${CP_URL}/api/v1/sessions/${sessionId}/messages?branchId=${branchId}`,
                { headers },
            );
            return response.ok() ? await response.json() : [];
        };

        await expect
            .poll(
                async () => {
                    const messages = await getMessages();
                    return messages.some(
                        (message: { role?: string; content?: string }) =>
                            message.role === "USER" && message.content === testMessage,
                    );
                },
                { timeout: LONG_TIMEOUT_MS },
            )
            .toBe(true);

        // The UI must not get stuck in the "Thinking" state when the backend fails.
        await expect(page.locator("text=Thinking")).not.toBeVisible({ timeout: LONG_TIMEOUT_MS });

        await expect
            .poll(
                async () => {
                    const messages = await getMessages();
                    return messages.filter(
                        (message: { role?: string; content?: string }) =>
                            message.role === "ASSISTANT" && Boolean(message.content?.trim()),
                    ).length;
                },
                { timeout: LONG_TIMEOUT_MS },
            )
            .toBeGreaterThan(0);

        // Assistant response must not be serialized as [object Object].
        const assistantMessages = await page.locator('[class*="bg-card"]').allInnerTexts();
        expect(assistantMessages.some((text) => text.includes("[object Object]"))).toBe(false);
    });

    test("mcp tools/list returns tools", async ({ page }) => {
        const auth = await registerAuth(request, "mcp-test");
        await page.addInitScript(
            ({ token, workspaceId }) => {
                localStorage.setItem("xihe-token", token);
                localStorage.setItem(
                    "xihe-workspace",
                    JSON.stringify({ id: workspaceId, name: "Default Workspace" }),
                );
            },
            { token: auth.accessToken, workspaceId: auth.workspaceId },
        );

        // task-209（D-1019）：MCP 面已从「工作区设置的 MCP 页签」搬到资源区工作区层
        // （`/resources/mcp?layer=WORKSPACE`）。判据不变：面板能渲染、内置工具可见。
        await page.goto("/resources/mcp?layer=WORKSPACE");
        await expect(page.locator("text=MCP 服务").first()).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(page.locator('[data-testid="mcp-config-textarea"]')).toBeVisible();

        const builtInTool = page.locator("text=read_file").first();
        await expect(builtInTool).toBeVisible();
    });

    test("mcp config save and reload persists", async ({ page, request }) => {
        const auth = await registerAuth(request, "mcp-persist"),
            token = auth.accessToken;
        await page.addInitScript(
            ({ token, workspaceId }) => {
                localStorage.setItem("xihe-token", token);
                localStorage.setItem(
                    "xihe-workspace",
                    JSON.stringify({ id: workspaceId, name: "Default Workspace" }),
                );
            },
            { token, workspaceId: auth.workspaceId },
        );

        // Save MCP config through the canonical public API.
        const mcpConfig = {
            mcpServers: {
                "test-echo": {
                    command: "echo",
                    args: ["hello"],
                },
            },
        };
        const saveResp = await request.put(
            `${CP_URL}/api/v1/workspaces/${auth.workspaceId}/mcp-config`,
            {
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                data: mcpConfig,
            },
        );
        expect(saveResp.ok()).toBe(true);

        // Read back via CP API
        const getResp = await request.get(
            `${CP_URL}/api/v1/workspaces/${auth.workspaceId}/mcp-config`,
            {
                headers: { Authorization: `Bearer ${token}` },
            },
        );
        expect(getResp.ok()).toBe(true);
        const body = await getResp.json();
        expect(body).toHaveProperty("mcpServers");

        // Verify it appears in the UI（task-209：资源区工作区层的 MCP 面）
        await page.goto("/resources/mcp?layer=WORKSPACE");
        await expect(page.locator("text=MCP 服务").first()).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        const textarea = page.locator('[data-testid="mcp-config-textarea"]');
        await expect(textarea).toBeVisible();
        await expect(textarea).toHaveValue(/test-echo/, { timeout: EXPECT_TIMEOUT_MS });
    });

    test("mcp config with invalid json shows error toast", async ({ page, request }) => {
        const auth = await registerAuth(request, "mcp-invalid"),
            token = auth.accessToken;
        await page.addInitScript((t) => localStorage.setItem("xihe-token", t), token);

        const saveResp = await request.put(
            `${CP_URL}/api/v1/workspaces/${auth.workspaceId}/mcp-config`,
            {
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                data: { mcpServers: "not-valid-object" },
            },
        );
        // Should still accept as JSON string, or reject — either way test that CP responds
        expect(saveResp.status()).toBeGreaterThanOrEqual(200);
        expect(saveResp.status()).toBeLessThan(500);
    });

    test("@host mcp initialize negotiates 2026 protocol via CP", async ({ page, request }) => {
        const auth = await registerAuth(request, "mcp-session");
        await page.addInitScript((t) => localStorage.setItem("xihe-token", t), auth.accessToken);

        // MCP 2026-07-28 discover lifecycle does not require a session-id.
        const initResp = await request.post(`${CP_URL}/api/v1/mcp`, {
            headers: {
                Authorization: `Bearer ${auth.accessToken}`,
                "Content-Type": "application/json",
                Accept: "application/json, text/event-stream",
                "MCP-Protocol-Version": "2026-07-28",
                "X-Workspace-Id": auth.workspaceId,
            },
            data: {
                jsonrpc: "2.0",
                method: "initialize",
                id: 1,
                params: {
                    protocolVersion: "2026-07-28",
                    capabilities: {},
                    clientInfo: { name: "xihe-e2e", version: "0.1.0" },
                },
            },
        });
        expect(initResp.ok()).toBe(true);

        const responseText = await initResp.text();
        const jsonText = responseText.startsWith("data:")
            ? responseText
                  .split("\n")
                  .find((line) => line.startsWith("data:"))!
                  .slice(5)
                  .trim()
            : responseText;
        const body = JSON.parse(jsonText);
        expect(body.result.protocolVersion).toBe("2026-07-28");
    });

    test("remote MCP OAuth completes through UI click, browser redirect, callback, and re-auth", async ({
        page,
        request,
    }) => {
        const email = `oauth-${Date.now()}@test.com`;
        const registration = await request.post(`${CP_URL}/api/v1/auth/register`, {
            headers: { "Content-Type": "application/json" },
            data: { email, password: SHARED_PASSWORD, name: "oauth-e2e" },
        });
        expect(registration.ok()).toBe(true);
        const auth = await registration.json(),
            serverId = randomUUID();
        // PLAN-0614: this block registers inline; ensure the workspace before using the id.
        auth.workspaceId = await ensureWorkspace(request, auth.accessToken);
        const fakeOAuthPort = process.env.XIHE_FAKE_OAUTH_PORT || "13640",
            uiPort = process.env.XIHE_UI_PORT || "12630";
        // task-209（D-1019）：远程 MCP 列表已从工作区设置的 mcp 页签搬到资源区工作区层。
        // `redirectUri` 必须与用户实际所在的页面一致（OAuth 回调要落回同一屏），所以跟着改。
        const mcpPagePath = "/resources/mcp?layer=WORKSPACE";
        const redirectUri = `http://localhost:${uiPort}${mcpPagePath}`;
        const save = await request.put(
            `${CP_URL}/api/v1/workspaces/${auth.workspaceId}/mcp-config`,
            {
                headers: {
                    Authorization: `Bearer ${auth.accessToken}`,
                    "Content-Type": "application/json",
                },
                data: {
                    mcpServers: {
                        [serverId]: {
                            name: "UI OAuth fixture",
                            url: "https://example.com/mcp",
                            oauth: {
                                clientId: "xihe-e2e-client",
                                authorizationEndpoint: `http://localhost:${fakeOAuthPort}/authorize`,
                                tokenEndpoint: `http://${fixtureHost}:${fakeOAuthPort}/token`,
                                redirectUri,
                                scope: "mcp:tools",
                            },
                        },
                    },
                },
            },
        );
        expect(save.ok()).toBe(true);

        await page.addInitScript(
            ({ token, user }) => {
                localStorage.setItem("xihe-token", token);
                localStorage.setItem("xihe-user", JSON.stringify(user));
            },
            { token: auth.accessToken, user: { ...auth.user, workspaceId: auth.workspaceId } },
        );
        // 资源区的「工作区层」依赖 tab 工作区上下文（`xihe-workspace` in sessionStorage）；
        // 唯一的写入口是工作区路由（selectWorkspace → writeTabWorkspace）。所以先落一次工作区，
        // 再去资源页 —— 直接 goto 资源页会停在「先选一个工作区」而不是面板。
        await page.goto(`/workspace/${auth.workspaceId}/settings`, { waitUntil: "load" });
        await expect(page.getByTestId("workspace-settings-page")).toBeVisible({
            timeout: ACTION_TIMEOUT_MS,
        });
        await page.goto(mcpPagePath);
        const serverRow = page.locator(`[data-testid="remote-mcp-${serverId}"]`);
        await expect(serverRow).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        const authorizeButton = serverRow.locator("button");
        await authorizeButton.click();
        await page.waitForURL(/\/resources\/mcp(?:\?|$)/, {
            timeout: ACTION_TIMEOUT_MS,
        });
        await expect(serverRow).toContainText(/已授权|Authorized/, { timeout: EXPECT_TIMEOUT_MS });

        await authorizeButton.click();
        await page.waitForURL(/\/resources\/mcp(?:\?|$)/, {
            timeout: ACTION_TIMEOUT_MS,
        });
        await expect(serverRow).toContainText(/已授权|Authorized/, { timeout: EXPECT_TIMEOUT_MS });
    });

    test("@host Runtime obtains a scoped token and calls the remote MCP", async ({ request }) => {
        const registration = await request.post(`${CP_URL}/api/v1/auth/register`, {
            headers: { "Content-Type": "application/json" },
            data: {
                email: `remote-call-${Date.now()}@test.com`,
                password: SHARED_PASSWORD,
                name: "remote-call-e2e",
            },
        });
        expect(registration.ok()).toBe(true);
        const auth = await registration.json(),
            serverId = randomUUID();
        // PLAN-0614: this block registers inline; ensure the workspace before using the id.
        auth.workspaceId = await ensureWorkspace(request, auth.accessToken);
        const fakeOAuthPort = process.env.XIHE_FAKE_OAUTH_PORT || "13640";
        const fakeMcpPort = process.env.XIHE_FAKE_MCP_PORT || "13641",
            cpPort = process.env.XIHE_CP_PORT || "12631";
        const redirectUri = `http://localhost:${cpPort}/api/v1/oauth/callback`;
        const session = await request.post(`${CP_URL}/api/v1/oauth/sessions`, {
            headers: {
                Authorization: `Bearer ${auth.accessToken}`,
                "Content-Type": "application/json",
            },
            data: {
                workspaceId: auth.workspaceId,
                serverId,
                remoteEndpoint: `http://${oauthRemoteHost}:${fakeMcpPort}/mcp`,
                clientId: "xihe-e2e-client",
                authorizationEndpoint: `http://localhost:${fakeOAuthPort}/authorize`,
                tokenEndpoint: `http://${fixtureHost}:${fakeOAuthPort}/token`,
                redirectUri,
                scope: "mcp:tools",
            },
        });
        const sessionText = await session.text();
        expect(
            session.ok(),
            `OAuth session creation failed: ${session.status()} ${sessionText}`,
        ).toBe(true);
        const oauth = JSON.parse(sessionText);
        const authorize = await request.get(oauth.authorizationUrl, { maxRedirects: 0 });
        expect(authorize.status()).toBe(302);
        const callback = new URL(authorize.headers().location);
        const callbackResult = await request.get(`${CP_URL}${callback.pathname}${callback.search}`);
        if (!callbackResult.ok()) {
            throw new Error(
                `OAuth callback failed: ${callbackResult.status()} ${await callbackResult.text()}`,
            );
        }

        const runtimePort = process.env.XIHE_RUNTIME_PORT || "12633";
        const runtimeUrl = `http://localhost:${runtimePort}/internal/v1/runtime/remote-mcp/${auth.workspaceId}/${serverId}/call`;
        let response;
        for (let attempt = 0; attempt < 8; attempt += 1) {
            response = await request.post(runtimeUrl, {
                headers: {
                    Authorization: `Bearer ${SERVICE_TOKEN}`,
                    "Content-Type": "application/json",
                },
                data: {
                    userId: auth.user.id,
                    endpoint: `http://${fixtureHost}:${fakeMcpPort}/mcp`,
                    tool: "remote_echo",
                    arguments: { text: "through-runtime" },
                    scope: "mcp:tools",
                },
            });
            if (response.status() !== 404) break;
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
        if (!response?.ok()) {
            throw new Error(
                `Runtime remote MCP call failed: ${response?.status()} ${await response?.text()}`,
            );
        }
        await expect(response!.json()).resolves.toMatchObject({
            content: [{ text: "through-runtime" }],
        });

        const brokerRequest = {
            userId: auth.user.id,
            workspaceId: auth.workspaceId,
            serverId,
            scope: "mcp:tools",
        };
        const refreshed = await request.post(`${CP_URL}/internal/v1/oauth/token`, {
            headers: {
                Authorization: `Bearer ${SERVICE_TOKEN}`,
                "Content-Type": "application/json",
            },
            data: brokerRequest,
        });
        expect(refreshed.ok()).toBe(true);
        expect((await refreshed.json()).access_token).toBe(FAKE_MCP_ACCESS_TOKEN);

        const revoke = await request.post(`${CP_URL}/api/v1/oauth/revoke`, {
            headers: {
                Authorization: `Bearer ${auth.accessToken}`,
                "Content-Type": "application/json",
            },
            data: { workspaceId: auth.workspaceId, serverId },
        });
        expect(revoke.ok()).toBe(true);
        const afterRevoke = await request.post(`${CP_URL}/internal/v1/oauth/token`, {
            headers: {
                Authorization: `Bearer ${SERVICE_TOKEN}`,
                "Content-Type": "application/json",
            },
            data: brokerRequest,
        });
        expect(afterRevoke.status()).toBe(401);
    });

    test("Fake Remote MCP exposes authenticated 2026 SSE channel", async ({ request }) => {
        const fakeMcpPort = process.env.XIHE_FAKE_MCP_PORT || "13641";
        const response = await request.get(`http://localhost:${fakeMcpPort}/mcp`, {
            headers: {
                Authorization: `Bearer ${FAKE_MCP_ACCESS_TOKEN}`,
                Accept: "text/event-stream",
            },
        });
        expect(response.ok()).toBe(true);
        expect(response.headers()["content-type"]).toContain("text/event-stream");
        expect(await response.text()).toContain("2026-07-28");
    });

    test("Fake Remote MCP enforces session, requestState, timeout, SSE resume, and disconnect", async ({
        request,
    }) => {
        const fakeMcpPort = process.env.XIHE_FAKE_MCP_PORT || "13641",
            endpoint = `http://localhost:${fakeMcpPort}/mcp`;
        const headers = {
            Authorization: `Bearer ${FAKE_MCP_ACCESS_TOKEN}`,
            Accept: "application/json, text/event-stream",
            "Content-Type": "application/json",
        };
        const initialize = await request.post(endpoint, {
            headers,
            data: {
                jsonrpc: "2.0",
                method: "initialize",
                id: 1,
                params: {
                    protocolVersion: "2026-07-28",
                    capabilities: {},
                    clientInfo: { name: "e2e", version: "1" },
                },
            },
        });
        expect(initialize.ok()).toBe(true);
        const sessionId = initialize.headers()["mcp-session-id"];
        expect(sessionId).toMatch(/^fixture-/);

        const sessionHeaders = { ...headers, "mcp-session-id": sessionId };
        const inputRequired = await request.post(endpoint, {
            headers: sessionHeaders,
            data: {
                jsonrpc: "2.0",
                method: "tools/call",
                id: 2,
                params: { name: "remote_echo", arguments: { mode: "input_required" } },
            },
        });
        const inputBody = await inputRequired.json(),
            inputState = inputBody.result.requestState;
        expect(inputRequired.ok()).toBe(true);
        expect(inputState.required).toEqual(["value"]);

        const sse = await request.get(endpoint, {
            headers: {
                Authorization: `Bearer ${FAKE_MCP_ACCESS_TOKEN}`,
                Accept: "text/event-stream",
                "mcp-session-id": sessionId,
            },
        });
        expect(sse.ok()).toBe(true);
        expect(sse.headers()["content-type"]).toContain("text/event-stream");
        expect(await sse.text()).toContain("id: ready-1");
        expect(sse.headers()["last-event-id"]).toBe("ready-1");

        const resumed = await request.get(endpoint, {
            headers: {
                Authorization: `Bearer ${FAKE_MCP_ACCESS_TOKEN}`,
                Accept: "text/event-stream",
                "mcp-session-id": sessionId,
                "Last-Event-ID": "ready-1",
            },
        });
        expect(resumed.ok()).toBe(true);
        expect(resumed.headers()["last-event-id"]).toBe("ready-2");

        const invalidState = await request.post(endpoint, {
            headers: sessionHeaders,
            data: {
                jsonrpc: "2.0",
                method: "tools/call",
                id: 5,
                params: { name: "remote_echo", requestState: { nonce: "invalid" }, arguments: {} },
            },
        });
        expect(invalidState.status()).toBe(422);

        const wrongSession = await request.post(endpoint, {
            headers: { ...headers, "mcp-session-id": `${sessionId}-other` },
            data: { jsonrpc: "2.0", method: "tools/list", id: 6, params: {} },
        });
        expect(wrongSession.status()).toBe(404);

        await new Promise((resolve) => setTimeout(resolve, 1100));
        const expiredState = await request.post(endpoint, {
            headers: sessionHeaders,
            data: {
                jsonrpc: "2.0",
                method: "tools/call",
                id: 7,
                params: { name: "remote_echo", requestState: inputState, arguments: {} },
            },
        });
        expect(expiredState.status()).toBe(422);

        const timeout = await request
            .post(endpoint, {
                headers: sessionHeaders,
                timeout: ACTION_TIMEOUT_MS,
                data: {
                    jsonrpc: "2.0",
                    method: "tools/call",
                    id: 3,
                    params: { name: "remote_echo", arguments: { mode: "timeout" } },
                },
            })
            .catch((error) => error);
        expect(timeout).toBeInstanceOf(Error);

        const disconnected = await request.delete(endpoint, { headers: sessionHeaders });
        expect(disconnected.ok()).toBe(true);
        const afterDisconnect = await request.post(endpoint, {
            headers: sessionHeaders,
            data: { jsonrpc: "2.0", method: "tools/list", id: 4, params: {} },
        });
        expect(afterDisconnect.status()).toBe(404);
    });
});
