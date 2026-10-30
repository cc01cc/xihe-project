import { test, expect } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
    createSessionWithPrincipal,
    provisionWorkspaceAgentPrincipal,
} from "./helpers/agent-principal";

// Passed runs recycle test-results (screenshots included), so evidence lands in
// a persistent gitignored dir for the PLAN T3.2/T4.1 record.
const EVIDENCE_DIR = resolve(process.cwd(), "../../.tmp/loop-guard-evidence");

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;
const LLM_MODE = process.env.XIHE_E2E_LLM_MODE ?? "mock";
const SHARED_EMAIL = "loop-guard@test.com";
// The batch reuses one stack, so the shared account's password must be stable
// across runs (a fresh random password would 401 on the second run).
const SHARED_PASSWORD =
    process.env.XIHE_E2E_PASSWORD ??
    `Lg${createHash("sha256").update(SHARED_EMAIL).digest("hex").slice(0, 16)}`;

// The Agent process binds one MCP workspace context per lifetime, so the mobile
// viewport pass must reuse the desktop pass's user/workspace (xh-host-e2e-pitfalls).
test.describe.configure({ mode: "serial" });

/**
 * PLAN-0493 T3.2/T4.1 host lane — real UI → CP → Agent → Runtime chain, fake
 * LLM scripted into an identical-signature loop (`repeat` mode):
 *
 * 1. The scripted agent calls `glob` with the same arguments every turn. The
 *    observation window warns on the 2nd identical attempt, refuses the 3rd
 *    and 4th WITHOUT executing them, and escalates on the 5th → the runner
 *    stops and the CP converges a `failed` terminal with RUN_NO_PROGRESS.
 * 2. The UI shows the localized no-progress reason plus the takeover hint, no
 *    retry button; a second send resumes the session (ordinary send path).
 * 3. The durable execution count proves tier-1: exactly 2 of 5 attempts reach
 *    the workspace (`mcp_invocations` rows for the run) — refusals never
 *    executed, and the escalation left no third execution behind.
 * 4. A serial mobile pass (390x844) re-checks the same surface (same
 *    user/workspace because of the single-workspace Agent binding).
 *
 * Run: mise run test:e2e:host -- --batch=loop-guard
 */
test.describe("@host PLAN-0493 loop guard", () => {
    test.skip(LLM_MODE !== "repeat", "requires XIHE_E2E_LLM_MODE=repeat (scripted loop)");

    test.beforeAll(() => {
        mkdirSync(EVIDENCE_DIR, { recursive: true });
    });

    type Auth = { accessToken: string; workspaceId: string };
    let auth: Auth;
    let sessionId: string;

    function installAuth(page: Page, value: Auth): Promise<void> {
        return page.addInitScript(
            ({ token, workspaceId }) => {
                localStorage.setItem("xihe-token", token);
                localStorage.setItem("xihe-user", JSON.stringify({ workspaceId }));
                localStorage.setItem(
                    "xihe-workspace",
                    JSON.stringify({ id: workspaceId, name: "Default Workspace" }),
                );
            },
            { token: value.accessToken, workspaceId: value.workspaceId },
        );
    }

    async function registerUser(request: APIRequestContext): Promise<Auth> {
        const reg = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: { email: SHARED_EMAIL, password: SHARED_PASSWORD, name: "Loop Guard" },
        });
        if (reg.ok()) return (await reg.json()) as Auth;
        const login = await request.post(`${CP_URL}/api/v1/auth/login`, {
            data: { identifier: SHARED_EMAIL, password: SHARED_PASSWORD },
        });
        expect(login.ok()).toBe(true);
        return (await login.json()) as Auth;
    }

    /**
     * PLAN-0439 admission for the fake-LLM lane. The shared browser helper
     * (`ensureChatBinding`) creates its fixture connection with the
     * `e2e-chat-binding-fixture` key, which the fake LLM rejects with 401 (it
     * enforces `Bearer sk-fake-openai-key`); bound dispatch would fail with
     * LLM_CREDENTIALS_INVALID before any tool loop starts. This API-side
     * binding points the session at the fake endpoint with the accepted key —
     * key stays a fixture placeholder, never a real credential.
     */
    async function ensureFakeChatBinding(
        request: APIRequestContext,
        sessionId: string,
    ): Promise<void> {
        const fakePort = process.env.XIHE_FAKE_LLM_PORT;
        expect(fakePort, "XIHE_FAKE_LLM_PORT must be set by the host runner").toBeTruthy();
        const headers = { Authorization: `Bearer ${auth.accessToken}` };
        const baseUrl = `http://127.0.0.1:${fakePort}/openai/v1`;
        const modelName = "wire-model";
        type ConnectionView = {
            id: string;
            providerId: string;
            revision: number;
            enabled: boolean;
            status: string;
            operation?: string;
            manualModels?: string[];
        };
        // The batch reuses one stack; a retry after a leftover bind finds the
        // connection already present (uq_provider_connection_scope) — reuse it.
        const list = await request.get(`${CP_URL}/api/v1/provider-connections`, { headers });
        expect(list.ok(), await list.text()).toBeTruthy();
        let connection = (
            (await list.json()) as { connections?: ConnectionView[] }
        ).connections?.find(
            (item) => item.enabled && item.status === "READY" && item.operation === "chat",
        );
        if (!connection) {
            const created = await request.post(`${CP_URL}/api/v1/provider-connections`, {
                headers,
                data: {
                    providerId: "custom-openai-compatible",
                    apiTypeId: "openai-chat-completions",
                    apiTypeVersion: 1,
                    apiKey: "sk-fake-openai-key",
                    connectionKey: "e2e-loop-guard",
                    label: "E2E loop-guard binding",
                    scope: "USER",
                    modelDiscovery: "manual",
                    manualModels: [modelName],
                    baseUrl,
                },
            });
            expect(
                created.ok(),
                `connection create ${created.status()}: ${await created.text()}`,
            ).toBeTruthy();
            const draft = (await created.json()) as ConnectionView;
            const verified = await request.post(
                `${CP_URL}/api/v1/provider-connections/${draft.id}/verify`,
                { headers },
            );
            expect(
                verified.ok(),
                `verify ${verified.status()}: ${await verified.text()}`,
            ).toBeTruthy();
            connection = ((await verified.json()) as { connection: ConnectionView }).connection;
        }
        if (!(connection.manualModels ?? []).includes(modelName)) {
            const patched = await request.patch(
                `${CP_URL}/api/v1/provider-connections/${connection.id}`,
                {
                    headers,
                    data: {
                        manualModels: [...(connection.manualModels ?? []), modelName],
                        expectedRevision: connection.revision,
                    },
                },
            );
            expect(patched.ok(), await patched.text()).toBeTruthy();
            connection = (await patched.json()) as ConnectionView;
        }
        const bound = await request.patch(`${CP_URL}/api/v1/sessions/${sessionId}`, {
            headers,
            data: {
                providerConnectionId: connection.id,
                modelProvider: connection.providerId,
                modelName,
                connectionRevision: connection.revision,
            },
        });
        expect(bound.ok(), `session bind ${bound.status()}: ${await bound.text()}`).toBeTruthy();
    }

    // Tier-1 proof from the CP forward log of THIS host run: one
    // `tool_forward_result tool=glob outcome=ok` line per execution that
    // actually reached the workspace — refused and escalated attempts never
    // forward, so the count stays exactly 2 per run of the repeat fixture.
    // (The isolated cp.log holds only this run's traffic; mcp-init probes use
    // list_directory and are excluded by the tool filter.)
    function forwardedGlobCalls(): number {
        const base = resolve(process.cwd(), "../../.tmp/e2e-host");
        const latest = readdirSync(base)
            .map((name) => ({ name, mtime: statSync(resolve(base, name)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime)[0];
        expect(latest, "the current host run root must exist while the test runs").toBeTruthy();
        const cpLog = readFileSync(resolve(base, latest.name, "logs", "cp.log"), "utf8");
        return cpLog
            .split("\n")
            .filter(
                (line) =>
                    line.includes("tool_forward_result") &&
                    line.includes("tool=glob") &&
                    line.includes("outcome=ok"),
            ).length;
    }

    // PLAN-0493 T3.1: a zero-content tier-2 stop surfaces through the recovery
    // banner (no assistant message exists to carry the error box), so the
    // reason + takeover hint are asserted there.
    function recoveryBanner(page: import("@playwright/test").Page) {
        return page.locator('[data-testid="run-recovery-banner"]');
    }

    test("repeated identical calls stop the run with a visible reason and stay resumable", async ({
        page,
        request,
    }) => {
        test.setTimeout(180_000);

        auth = await registerUser(request);
        const principalId = await provisionWorkspaceAgentPrincipal(request, auth, {
            name: "Loop Guard Agent",
            actions: ["read"],
        });
        sessionId = await createSessionWithPrincipal(request, auth, {
            principalId,
            title: "Loop Guard",
        });
        await installAuth(page, auth);

        await page.goto(`/workspace/${auth.workspaceId}/chat/${sessionId}`, { waitUntil: "load" });
        const textarea = page.locator("textarea");
        await expect(textarea).toBeVisible({ timeout: 15000 });
        // PLAN-0439 admission: bind the session before the first send (fake key).
        await ensureFakeChatBinding(request, sessionId);

        const firstMarker = `loop-first-${Date.now()}`;
        await textarea.fill(firstMarker);
        await page.keyboard.press("Enter");
        await expect(page.getByText(firstMarker, { exact: true })).toBeVisible({ timeout: 10000 });

        const banner = recoveryBanner(page);
        await expect(banner).toBeVisible({ timeout: 60000 });
        await expect(banner).toContainText("检测到重复或无进展动作，运行已停止");
        await expect(banner).toContainText("接续本次会话");
        await page.screenshot({
            scale: "css",
            path: `${EVIDENCE_DIR}/loop-guard-no-progress.png`,
            fullPage: true,
        });

        // Tier-1 durable proof: 5 attempts, only the first two executed.
        expect(forwardedGlobCalls()).toBe(2);

        // Takeover entry: the same input starts a new run in the same session.
        const secondMarker = `loop-second-${Date.now()}`;
        await expect(textarea).toBeEnabled({ timeout: 10000 });
        await textarea.fill(secondMarker);
        await page.keyboard.press("Enter");
        await expect(page.getByText(secondMarker, { exact: true })).toBeVisible({ timeout: 15000 });
        // Second stop converges the same way; the durable count doubles (2 more
        // executions), proving refusals never executed in either run.
        await expect(banner).toContainText("检测到重复或无进展动作，运行已停止", {
            timeout: 60000,
        });
        await expect.poll(async () => forwardedGlobCalls(), { timeout: 30000 }).toBe(4);
        await page.screenshot({
            scale: "css",
            path: `${EVIDENCE_DIR}/loop-guard-takeover.png`,
            fullPage: true,
        });
    });

    test("no-progress surface stays readable on a mobile viewport", async ({ page }) => {
        test.setTimeout(180_000);

        // Reuse the same user/workspace as the desktop pass (Agent single-workspace
        // MCP binding).
        await installAuth(page, auth);
        await page.goto(`/workspace/${auth.workspaceId}/chat/${sessionId}`, { waitUntil: "load" });
        await page.setViewportSize({ width: 390, height: 844 });
        // At 390px the app shell defaults to the Files pane; the chat composer is
        // reachable through the "Open chat" toggle (same entry as queue mobile spec).
        const openChat = page.getByRole("button", { name: "Open chat" });
        await expect(openChat).toBeVisible({ timeout: 20000 });
        await openChat.click();
        const textarea = page.locator("textarea");
        await expect(textarea).toBeVisible({ timeout: 15000 });
        const marker = `loop-mobile-${Date.now()}`;
        await textarea.fill(marker);
        await page.keyboard.press("Enter");
        await expect(page.getByText(marker, { exact: true })).toBeVisible({ timeout: 10000 });

        // The third run converges the same way; the session banner shows the
        // localized reason + takeover hint at the mobile viewport.
        const banner = recoveryBanner(page);
        await expect(banner).toBeVisible({ timeout: 60000 });
        await expect(banner).toContainText("检测到重复或无进展动作，运行已停止");
        await expect(banner).toContainText("接续本次会话");
        await expect.poll(async () => forwardedGlobCalls(), { timeout: 30000 }).toBe(6);

        const bannerBox = await banner.boundingBox();
        expect(bannerBox).not.toBeNull();
        expect(bannerBox!.x + bannerBox!.width).toBeLessThanOrEqual(390 + 1);
        await page.screenshot({
            scale: "css",
            path: `${EVIDENCE_DIR}/loop-guard-mobile.png`,
            fullPage: true,
        });
    });
});
