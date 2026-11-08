// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import {
    createSessionWithPrincipal,
    provisionWorkspaceAgentPrincipal,
} from "./helpers/agent-principal";
import { generateE2EPassword } from "./helpers/password";
import { ensureChatBinding, getRootBranchId } from "./helpers/journey";
import { ensureWorkspace } from "./helpers/workspace";
import { bindSessionViaApi } from "./helpers/session-binding";
import {
    ACTION_TIMEOUT_MS,
    EXPECT_TIMEOUT_MS,
    LONG_TIMEOUT_MS,
    TEST_TIMEOUT_MS,
} from "../timeouts";

const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();
const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;
const mode = process.env.XIHE_E2E_LLM_MODE ?? "mock";

type Auth = { accessToken: string; workspaceId: string };
const rootBranchIds = new Map<string, string>();

async function register(request: APIRequestContext, name: string): Promise<Auth> {
    const response = await request.post(`${CP_URL}/api/v1/auth/register`, {
        data: {
            email: `${name}-${Date.now()}@test.com`,
            password: SHARED_PASSWORD,
            name,
        },
    });
    expect(response.ok()).toBe(true);
    const body = await response.json();
    // PLAN-0614: registration no longer creates a workspace — create one explicitly.
    return {
        accessToken: body.accessToken,
        workspaceId: await ensureWorkspace(request, body.accessToken),
    };
}

async function sessionId(request: APIRequestContext, auth: Auth): Promise<string> {
    let id = "";
    await expect
        .poll(
            async () => {
                const response = await request.get(`${CP_URL}/api/v1/sessions`, {
                    headers: {
                        Authorization: `Bearer ${auth.accessToken}`,
                        "X-Workspace-Id": auth.workspaceId,
                    },
                });
                if (!response.ok()) return "";
                const body = await response.json();
                id = body.sessions?.[0]?.id ?? "";
                return id;
            },
            { timeout: ACTION_TIMEOUT_MS },
        )
        .not.toBe("");
    return id;
}

async function messages(request: APIRequestContext, auth: Auth, id: string) {
    const headers = {
        Authorization: `Bearer ${auth.accessToken}`,
        "X-Workspace-Id": auth.workspaceId,
    };
    let branchId = rootBranchIds.get(id);
    if (!branchId) {
        branchId = await getRootBranchId(request, id, headers);
        rootBranchIds.set(id, branchId);
    }
    const response = await request.get(
        `${CP_URL}/api/v1/sessions/${id}/messages?branchId=${branchId}`,
        { headers },
    );
    return response.ok() ? await response.json() : [];
}

async function openChat(
    page: Page,
    request: APIRequestContext,
    auth: Auth,
    sessionId = "",
): Promise<string> {
    // BL-177 classification B: `/workspace` no longer lands on a composer that creates the Session
    // implicitly. Since PLAN-0614 blank start it is the workspace home, and its "create chat" CTA
    // needs an Agent principal the blank-start account does not have — so clicking it leaves the
    // empty state up and the composer never appears (the reproduced 10s textarea timeout). Provision
    // the principal + Session explicitly, exactly like the real lane documents, and open its route.
    let chatSessionId = sessionId;
    if (!chatSessionId) {
        const principalId = await provisionWorkspaceAgentPrincipal(request, auth, {
            name: "ChatAvailabilityAgent",
        });
        chatSessionId = await createSessionWithPrincipal(request, auth, {
            principalId,
            title: "Chat availability",
        });
    }
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
    await page.goto(`/workspace/${auth.workspaceId}/chat/${chatSessionId}`, {
        waitUntil: "load",
    });
    await expect(page.locator("textarea")).toBeVisible({ timeout: LONG_TIMEOUT_MS });
    return chatSessionId;
}

/**
 * Mock lane landing walk: register → workspace picker → workspace view. Drives only visible
 * affordances (event-driven waits, no fixed sleeps) and returns nothing; the case asserts what the
 * blank-start landing must offer.
 */
async function openWorkspaceFromLanding(page: Page, auth: Auth): Promise<void> {
    await page.addInitScript(
        (token) => localStorage.setItem("xihe-token", token),
        auth.accessToken,
    );
    await page.goto("/workspace", { waitUntil: "load" });
    // PLAN-0608 I6 / PLAN-0614: without a tab context the app shows the workspace picker.
    const pickerItem = page.locator('[data-testid^="workspace-picker-item-"]').first();
    await pickerItem.waitFor({ state: "visible", timeout: LONG_TIMEOUT_MS });
    await pickerItem.click();
}

async function expectNoHorizontalOverflow(page: Page) {
    const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
}

test.describe("PLAN-247 Chat availability @host", () => {
    if (mode === "missing") {
        test("missing credentials preserve input and create no messages", async ({
            page,
            request,
        }) => {
            const auth = await register(request, "missing-credentials");
            await openChat(page, request, auth);

            const text = `missing-${Date.now()}`,
                textarea = page.locator("textarea");
            await textarea.fill(text);
            await page.keyboard.press("Enter");

            await expect(page.getByText(/LLM_NOT_CONFIGURED/)).toBeVisible({
                timeout: EXPECT_TIMEOUT_MS,
            });
            await expect(textarea).toHaveValue(text);
            const id = await sessionId(request, auth);
            await expect
                .poll(async () => (await messages(request, auth, id)).length, {
                    timeout: EXPECT_TIMEOUT_MS,
                })
                .toBe(0);
            await expectNoHorizontalOverflow(page);
            await page.screenshot({
                scale: "css",
                path: test.info().outputPath("PLAN-247-host-no-credentials.png"),
                fullPage: true,
            });
        });
    }

    if (mode === "invalid") {
        test("provider credential failure is visible without a ghost assistant", async ({
            page,
            request,
        }) => {
            const auth = await register(request, "invalid-credentials");
            await openChat(page, request, auth);

            const text = `invalid-${Date.now()}`,
                textarea = page.locator("textarea");
            await textarea.fill(text);
            await page.keyboard.press("Enter");

            await expect(page.getByText(/LLM_CREDENTIALS_INVALID/)).toBeVisible({
                timeout: EXPECT_TIMEOUT_MS,
            });
            await expect(textarea).toHaveValue(text);
            const id = await sessionId(request, auth),
                stored = await messages(request, auth, id);
            expect(stored.some((message: { role?: string }) => message.role === "ASSISTANT")).toBe(
                false,
            );
            await expectNoHorizontalOverflow(page);
            await page.screenshot({
                scale: "css",
                path: test.info().outputPath("PLAN-247-host-credential-error.png"),
                fullPage: true,
            });
        });
    }

    if (mode === "success") {
        test("fake provider streams multiple tokens and persists the canonical binding", async ({
            page,
            request,
        }) => {
            const auth = await register(request, "fake-success"),
                mcpRequests: string[] = [];
            page.on("request", (outgoing) => {
                if (/\/api\/v1\/mcp|tools\/list/.test(outgoing.url()))
                    mcpRequests.push(outgoing.url());
            });
            await openChat(page, request, auth);

            // 2026-11-04 用户裁定移除 composer 模型选择器：绑定改走产品 PATCH API
            // （原 ModelPopover 内部调用的同一端点），"选择器 UI 可选模型"的断言随之作废。
            const id = await sessionId(request, auth);
            await bindSessionViaApi(
                request,
                CP_URL,
                {
                    Authorization: `Bearer ${auth.accessToken}`,
                    "X-Workspace-Id": auth.workspaceId,
                },
                id,
                "deepseek",
                "fake-deepseek",
            );
            await expect
                .poll(
                    async () => {
                        const response = await request.get(`${CP_URL}/api/v1/sessions/${id}`, {
                            headers: {
                                Authorization: `Bearer ${auth.accessToken}`,
                                "X-Workspace-Id": auth.workspaceId,
                            },
                        });
                        if (!response.ok()) return "";
                        const body = await response.json();
                        return `${body.modelProvider ?? ""}/${body.modelName ?? ""}`;
                    },
                    { timeout: ACTION_TIMEOUT_MS },
                )
                .toBe("deepseek/fake-deepseek");

            const text = `success-${Date.now()}`;
            await page.locator("textarea").fill(text);
            await page.keyboard.press("Enter");
            await expect(page.getByText(text, { exact: true })).toBeVisible({
                timeout: EXPECT_TIMEOUT_MS,
            });
            await expect
                .poll(
                    async () => {
                        const stored = await messages(request, auth, id);
                        return stored.filter(
                            (message: { role?: string; content?: string }) =>
                                message.role === "ASSISTANT" &&
                                message.content?.includes("deepseek fake"),
                        ).length;
                    },
                    { timeout: LONG_TIMEOUT_MS },
                )
                .toBeGreaterThan(0);
            await expect(page.getByText(/Thinking/)).not.toBeVisible({ timeout: LONG_TIMEOUT_MS });
            expect(mcpRequests).toEqual([]);
            await expectNoHorizontalOverflow(page);
            await page.screenshot({
                scale: "css",
                path: test.info().outputPath("PLAN-247-host-fake-success.png"),
                fullPage: true,
            });

            await page.reload({ waitUntil: "load" });
            await expect(page.locator("textarea")).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
            await expect(page.getByText(text, { exact: true })).toBeVisible({
                timeout: LONG_TIMEOUT_MS,
            });
            await expect(page.getByText(/deepseek fake/)).toBeVisible({ timeout: LONG_TIMEOUT_MS });
            await expectNoHorizontalOverflow(page);
        });
    }

    // BL-177: the mock lane used to collect ZERO cases from this spec — `mode` defaults to `mock`
    // and no branch matched it ("No tests found"), so mock-full never covered this spec at all.
    //
    // It cannot simply reuse the success-lane case (classification A, reproduced):
    //   * scripts/e2e-host.mjs seeds the mock lane with `profile.model = mock` — there is no
    //     fake-openai / fake-deepseek catalog, which is exactly what that case asserts;
    //   * and the blank-start UI creates a Session only through the agent-selection dialog, which needs
    //     an Agent *bound to the workspace*; a fresh account has none, so the empty-state CTA cannot
    //     reach a composer (that is also why the success-lane reproduction stopped at `textarea`).
    //
    // What the mock lane *can* assert without weakening anything is the property this spec is named
    // for and the exact thing that regressed: from the blank-start landing, chat must stay reachable.
    if (mode === "mock") {
        test("blank-start landing keeps the chat entry point reachable", async ({
            page,
            request,
        }) => {
            const auth = await register(request, "mock-availability");
            await openWorkspaceFromLanding(page, auth);

            // No Session yet: the workspace view must still offer both entry points to chat.
            await expect(page.getByTestId("workspace-create-session")).toBeVisible({
                timeout: LONG_TIMEOUT_MS,
            });
            await expect(page.getByTestId("sidebar-new-chat")).toBeVisible();

            // Chat availability also means the addressable surface answers: the Session list is a
            // real 200 with an empty page (not a 401 logout, not a 409 context error).
            const sessions = await request.get(`${CP_URL}/api/v1/sessions`, {
                headers: {
                    Authorization: `Bearer ${auth.accessToken}`,
                    "X-Workspace-Id": auth.workspaceId,
                },
            });
            expect(sessions.status(), await sessions.text()).toBe(200);
            const body = (await sessions.json()) as { sessions?: unknown[] };
            expect(body.sessions ?? []).toHaveLength(0);

            await expectNoHorizontalOverflow(page);
        });
    }

    if (mode === "real") {
        test("real Xiaomi streams a reply and persists the canonical binding", async ({
            page,
            request,
        }) => {
            test.setTimeout(TEST_TIMEOUT_MS);
            // BL-148: the real lane has no fake-LLM fixture and no auto-created
            // Session. Provision the Agent principal + Session explicitly, open
            // the Chat route and bind the runner-provided real connection. The
            // key stays in the node test process (ensureChatBinding).
            test.skip(
                mode === "real" && !process.env.XIHE_E2E_REAL_KEY,
                "BL-148: real lane requires the runner-provided provider identity (XIHE_E2E_REAL_KEY)",
            );
            const auth = await register(request, "real-xiaomi");
            const principalId = await provisionWorkspaceAgentPrincipal(
                request,
                { accessToken: auth.accessToken, workspaceId: auth.workspaceId },
                { name: "RealXiaomiAgent" },
            );
            const chatSessionId = await createSessionWithPrincipal(
                request,
                { accessToken: auth.accessToken, workspaceId: auth.workspaceId },
                { principalId, title: "Real Xiaomi chat" },
            );
            await openChat(page, request, auth, chatSessionId);
            await ensureChatBinding(page, chatSessionId);
            // Re-enter the route so the store refetches the now-bound session.
            await page.reload({ waitUntil: "load" });
            await expect(page.locator("textarea")).toBeVisible({ timeout: LONG_TIMEOUT_MS });

            // 2026-11-04 用户裁定移除 composer 模型选择器：绑定改走产品 PATCH API。
            const id = await sessionId(request, auth);
            await bindSessionViaApi(
                request,
                CP_URL,
                {
                    Authorization: `Bearer ${auth.accessToken}`,
                    "X-Workspace-Id": auth.workspaceId,
                },
                id,
                "xiaomi",
                "mimo-v2.6-flash",
            );
            await expect
                .poll(
                    async () => {
                        const response = await request.get(`${CP_URL}/api/v1/sessions/${id}`, {
                            headers: {
                                Authorization: `Bearer ${auth.accessToken}`,
                                "X-Workspace-Id": auth.workspaceId,
                            },
                        });
                        if (!response.ok()) return "";
                        const body = await response.json();
                        return `${body.modelProvider ?? ""}/${body.modelName ?? ""}`;
                    },
                    { timeout: LONG_TIMEOUT_MS },
                )
                .toBe("xiaomi/mimo-v2.6-flash");

            const text = `real-${Date.now()}`;
            await page.locator("textarea").fill(text);
            await page.keyboard.press("Enter");
            await expect(page.getByText(text, { exact: true })).toBeVisible({
                timeout: LONG_TIMEOUT_MS,
            });
            await expect
                .poll(
                    async () => {
                        const stored = await messages(request, auth, id);
                        return stored.filter(
                            (message: { role?: string; content?: string }) =>
                                message.role === "ASSISTANT" && (message.content?.length ?? 0) > 0,
                        ).length;
                    },
                    { timeout: LONG_TIMEOUT_MS },
                )
                .toBeGreaterThan(0);
            await expect(page.getByText(/Thinking/)).not.toBeVisible({ timeout: LONG_TIMEOUT_MS });
            await expectNoHorizontalOverflow(page);
            await page.screenshot({
                scale: "css",
                path: test.info().outputPath("PLAN-247-host-real-xiaomi.png"),
                fullPage: true,
            });
        });
    }

    if (mode === "disconnect") {
        test("provider disconnect is durable ambiguous and not auto-retried", async ({
            page,
            request,
        }) => {
            const auth = await register(request, "ambiguous-disconnect");
            await openChat(page, request, auth);

            const id = await sessionId(request, auth),
                text = `disconnect-${Date.now()}`;
            await page.locator("textarea").fill(text);
            await page.keyboard.press("Enter");
            await expect
                .poll(
                    async () => {
                        const stored = await messages(request, auth, id);
                        return stored.some(
                            (message: { runStatus?: string }) => message.runStatus === "ambiguous",
                        );
                    },
                    { timeout: LONG_TIMEOUT_MS },
                )
                .toBe(true);
            await expectNoHorizontalOverflow(page);
            await page.screenshot({
                scale: "css",
                path: test.info().outputPath("PLAN-247-host-run-ambiguous.png"),
                fullPage: true,
            });
        });
    }
});
