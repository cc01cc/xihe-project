import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { generateE2EPassword } from "./helpers/password";
import {
    ensureAgentWorkspaceBinding,
    getRootBranchId,
    waitForControlPlaneAgentReady,
} from "./helpers/journey";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;
const LLM_MODE = process.env.XIHE_E2E_LLM_MODE ?? "mock";

test.describe.configure({ mode: "serial", retries: 0 });

function seedUserGrant(userId: string, workspaceId: string) {
    const container = process.env.XIHE_E2E_PG_CONTAINER,
        database = process.env.XIHE_E2E_PG_DATABASE;
    const dbUser = process.env.XIHE_E2E_PG_USER;
    if (!container || !database || !dbUser) {
        throw new Error(
            "isolated PostgreSQL fixture metadata is unavailable; run through scripts/e2e-host.mjs",
        );
    }
    const permissions = JSON.stringify([
        { actionClass: "CREATE_ACCOUNT", resource: "*" },
        { actionClass: "CREATE_TEMPLATE", resource: "*" },
        { actionClass: "MANAGE_WORKSPACE_AGENTS", resource: workspaceId },
        { actionClass: "delete", resource: "*" },
    ]).replaceAll("'", "''");
    execFileSync(
        process.platform === "win32" ? "docker.exe" : "docker",
        [
            "exec",
            container,
            "psql",
            "-X",
            "-A",
            "-t",
            "-U",
            dbUser,
            "-d",
            database,
            "-c",
            `INSERT INTO grants (id, granter_type, granter_id, subject_type, subject_id, permissions, source, read_state) ` +
                `VALUES (gen_random_uuid(), 'user', '${userId}'::uuid, 'user', '${userId}'::uuid, ` +
                `'${permissions}'::jsonb, 'direct', 'read')`,
        ],
        { encoding: "utf8", timeout: 15_000, windowsHide: true },
    );
}

async function createBoundAgent(
    request: APIRequestContext,
    userId: string,
    workspaceId: string,
    headers: Record<string, string>,
): Promise<string> {
    seedUserGrant(userId, workspaceId);
    const roleId = randomUUID(),
        templateId = randomUUID();
    const templateWrite = await request.put(`${CP_URL}/api/v1/config/user/agent-templates`, {
        headers,
        data: {
            roles: JSON.stringify([
                {
                    id: roleId,
                    name: "Follow-up Approval Role",
                    permissions: [{ actionClass: "delete", resource: "*" }],
                },
            ]),
            templates: JSON.stringify([
                {
                    id: templateId,
                    name: "Follow-up Approval Agent",
                    description: "Bounded Agent for real Follow-up queue verification",
                    systemPrompt: "Use only the Workspace tools provided by CP.",
                    toolMode: "workspace",
                    provider: "openai",
                    model: "fake-openai",
                    roleId,
                },
            ]),
        },
    });
    expect(templateWrite.status(), await templateWrite.text()).toBe(200);

    const principalResponse = await request.post(`${CP_URL}/api/v1/agent-principals`, {
        headers,
        data: { name: "Follow-up Approval Agent", templateId },
    });
    expect(principalResponse.status(), await principalResponse.text()).toBe(201);
    const principalId = ((await principalResponse.json()) as { principalId: string }).principalId;
    const bindResponse = await request.put(
        `${CP_URL}/api/v1/workspaces/${workspaceId}/agents/${principalId}`,
        {
            headers,
            data: { permissions: [{ actionClass: "delete", resource: "*" }] },
        },
    );
    expect(bindResponse.status(), await bindResponse.text()).toBe(200);
    return principalId;
}

async function submitChat(page: Page, content: string) {
    const chatRequest = page.waitForRequest(
        (request) => request.url().endsWith("/api/v1/chat") && request.method() === "POST",
    );
    const chatResponse = page.waitForResponse(
        (response) =>
            response.url().endsWith("/api/v1/chat") && response.request().method() === "POST",
    );
    await page.getByTestId("chat-input").fill(content);
    await page.getByTestId("chat-send-button").click();
    const [request, response] = await Promise.all([chatRequest, chatResponse]);
    expect(response.status(), await response.text()).toBe(202);
    return {
        body: request.postDataJSON() as Record<string, unknown>,
        runId: ((await response.json()) as { runId: string }).runId,
    };
}

async function loadFollowUpSnapshot(
    request: APIRequestContext,
    sessionId: string,
    headers: Record<string, string>,
) {
    const response = await request.get(`${CP_URL}/api/v1/sessions/${sessionId}/follow-ups`, {
        headers,
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json() as Promise<{
        outstandingCount: number;
        items: Array<{
            status: string;
            queueItemId: string;
            childRunId: string | null;
            childMessageId: string | null;
        }>;
    }>;
}

interface BootstrapSession {
    headers: Record<string, string>;
    sessionId: string;
    branchId: string;
    principalId: string;
}

async function bootstrapSession(request: APIRequestContext, page: Page): Promise<BootstrapSession> {
    const password = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();
    const register = await request.post(`${CP_URL}/api/v1/auth/register`, {
        data: {
            email: `follow-up-${Date.now()}-${randomUUID().slice(0, 8)}@test.com`,
            password,
            name: "Follow-up E2E",
        },
    });
    expect([200, 201], `register failed: ${register.status()} ${await register.text()}`).toContain(
        register.status(),
    );
    const auth = (await register.json()) as { accessToken: string; workspaceId: string };
    const headers = {
        Authorization: `Bearer ${auth.accessToken}`,
        "Content-Type": "application/json",
    };
    const me = await request.get(`${CP_URL}/api/v1/auth/me`, { headers });
    expect(me.ok(), await me.text()).toBeTruthy();
    const userId = ((await me.json()) as { id: string }).id;
    const principalId = await createBoundAgent(request, userId, auth.workspaceId, headers);

    await ensureAgentWorkspaceBinding(auth.workspaceId);
    await waitForControlPlaneAgentReady(request, headers);
    await page.addInitScript(
        (token) => localStorage.setItem("xihe-token", token),
        auth.accessToken,
    );
    await page.addInitScript(
        (value) => localStorage.setItem("xihe-user", value),
        JSON.stringify({ workspaceId: auth.workspaceId }),
    );
    await page.addInitScript(
        (workspace) => localStorage.setItem("xihe-workspace", JSON.stringify(workspace)),
        { id: auth.workspaceId, name: "Default Workspace" },
    );

    await page.goto(`/workspace/${auth.workspaceId}`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("workspace-create-session").click();
    const agentSelect = page.getByTestId("workspace-agent-principal-select");
    await expect(agentSelect).toBeVisible();
    await agentSelect.selectOption(principalId);
    await page.getByTestId("workspace-create-agent-session").click();
    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 20_000 });

    const sessionResponse = await request.get(`${CP_URL}/api/v1/sessions`, { headers });
    expect(sessionResponse.ok(), await sessionResponse.text()).toBeTruthy();
    const sessions = ((await sessionResponse.json()) as { sessions: Array<{ id: string }> })
        .sessions;
    expect(sessions.length).toBeGreaterThan(0);
    const sessionId = sessions[0]!.id,
        branchId = await getRootBranchId(request, sessionId, headers);
    return { headers, sessionId, branchId, principalId };
}

function requireApprovalMode() {
    test.skip(
        LLM_MODE !== "approval",
        `requires XIHE_E2E_LLM_MODE=approval (current: ${LLM_MODE})`,
    );
}

test("@host Follow-up is durably admitted and dispatched after parent approval", async ({
    page,
    request,
}) => {
    requireApprovalMode();
    test.setTimeout(240_000);
    const pageErrors: Error[] = [],
        consoleErrorCount = { value: 0 },
        requestFailures: string[] = [];
    const browserMessageIds = new Set<string>();
    page.on("pageerror", (error) => pageErrors.push(error));
    page.on("console", (message) => {
        if (message.type() === "error") consoleErrorCount.value++;
    });
    page.on("requestfailed", (request) => {
        const error = request.failure()?.errorText ?? "unknown";
        if (error !== "net::ERR_ABORTED") {
            requestFailures.push(`${request.method()} ${new URL(request.url()).pathname}`);
        }
    });
    const session = await bootstrapSession(request, page);
    page.on("response", (response) => {
        if (
            !response.url().includes(`/api/v1/sessions/${session.sessionId}/messages`) ||
            response.request().method() !== "GET"
        ) {
            return;
        }
        void response
            .json()
            .then((payload: unknown) => {
                if (!Array.isArray(payload)) return;
                for (const message of payload) {
                    if (
                        message &&
                        typeof message === "object" &&
                        "id" in message &&
                        typeof message.id === "string"
                    ) {
                        browserMessageIds.add(message.id);
                    }
                }
            })
            .catch((error: unknown) => {
                pageErrors.push(
                    error instanceof Error ? error : new Error("Failed to parse messages response"),
                );
            });
    });

    const parent = await submitChat(page, "please delete README.md");
    const approvalModal = page.locator('[data-testid="modal-backdrop"]:visible');
    const approval = approvalModal.getByTestId("approval-modal-content");
    await expect(approval).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("chat-queue-button")).toBeVisible({ timeout: 10_000 });
    await approvalModal.getByRole("button", { name: "Close" }).click();
    await expect(approvalModal).toBeHidden({ timeout: 10_000 });

    const followUpText = "After the first approval, summarize the result.";
    await page.getByTestId("chat-input").fill(followUpText);
    const followUpRequest = page.waitForRequest(
        (request) =>
            request.url().endsWith(`/api/v1/sessions/${session.sessionId}/follow-ups`) &&
            request.method() === "POST",
    );
    const followUpResponse = page.waitForResponse(
        (response) =>
            response.url().endsWith(`/api/v1/sessions/${session.sessionId}/follow-ups`) &&
            response.request().method() === "POST",
    );
    await page.getByTestId("chat-queue-button").click();
    expect((await followUpResponse).status()).toBe(202);
    const followUpWireRequest = await followUpRequest;
    expect(followUpWireRequest.headers()["idempotency-key"]).toBeTruthy();
    const queued = await loadFollowUpSnapshot(request, session.sessionId, session.headers);
    expect(queued.outstandingCount).toBe(1);
    expect(queued.items[0]?.status).toBe("queued");
    const queueItemId = queued.items[0]!.queueItemId;

    const beforeAdmission = await request.get(
        `${CP_URL}/api/v1/sessions/${session.sessionId}/messages?branchId=${encodeURIComponent(session.branchId)}`,
        { headers: session.headers },
    );
    expect(beforeAdmission.ok(), await beforeAdmission.text()).toBeTruthy();
    const queuedMessages = (await beforeAdmission.json()) as Array<{ content: string }>;
    expect(queuedMessages.some((message) => message.content === followUpText)).toBe(false);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 20_000 });
    await expect(approval).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("follow-up-queue-item")).toContainText(followUpText);
    await approval.locator('[data-testid="approval-approve"]').click();
    // Assert the parent approval RESOLVED semantically instead of `toBeHidden`:
    // after the releaseRun/lease A类 fixes the child run is dispatched immediately
    // after the parent settles, and its own approval modal repopulates the same
    // `modal-content` container before any hidden frame renders, so a hidden-state
    // wait races the child modal (observed 2026-10-07 full run).
    await expect(page.getByText("Approval received.").last()).toBeVisible({ timeout: 20_000 });
    await expect
        .poll(
            async () => {
                const snapshot = await loadFollowUpSnapshot(
                    request,
                    session.sessionId,
                    session.headers,
                );
                return (
                    snapshot.items.find((item) => item.queueItemId === queueItemId)?.childRunId ??
                    null
                );
            },
            { timeout: 60_000 },
        )
        .not.toBeNull();

    const admitted = await loadFollowUpSnapshot(request, session.sessionId, session.headers);
    const child = admitted.items.find((item) => item.queueItemId === queueItemId);
    expect(child?.status).toBe("admitted");
    expect(child?.childRunId).toBeTruthy();
    expect(child?.childRunId).not.toBe(parent.runId);
    expect(child?.childMessageId).toBeTruthy();
    await expect
        .poll(() => browserMessageIds.has(child!.childMessageId!), { timeout: 30_000 })
        .toBe(true);
    await expect(page.getByText(followUpText, { exact: true }).last()).toBeVisible();

    // Wait until the CHILD's approval exists SERVER-side: the parent is already
    // resolved (marker above), so a non-empty pending list proves the child request
    // landed. Visibility-only waits could race the parent->child modal handoff gap
    // (parent modal closes, child modal not yet mounted), which produced screenshots
    // with no modal at all; with pending>0 the child modal opens and stays open.
    await expect
        .poll(
            async () => {
                const response = await request.get(`${CP_URL}/api/v1/approvals/pending`, {
                    headers: session.headers,
                });
                if (!response.ok()) return 0;
                const body = (await response.json()) as unknown;
                return Array.isArray(body) ? body.length : 0;
            },
            { timeout: 60_000 },
        )
        .toBeGreaterThan(0);
    await expect(approval).toBeVisible({ timeout: 60_000 });
    await approvalModal.getByRole("button", { name: "Close" }).click();
    await expect(approvalModal).toBeHidden({ timeout: 10_000 });
    const desktopReopen = page.getByTestId("pending-approval-reopen-pill");
    await expect(desktopReopen).toBeVisible({ timeout: 20_000 });
    const desktopAdmittedItem = page.getByTestId("follow-up-queue-item").first();
    // Admission clears the QueueItem payload copy; the admitted prompt is shown
    // in ChatRun's user Message above, while the queue row retains its state.
    await expect(page.getByText(followUpText, { exact: true }).last()).toBeVisible();
    await expect(desktopAdmittedItem.getByTestId("follow-up-item-status")).toHaveAttribute(
        "data-status",
        "admitted",
    );
    await page.screenshot({
        path: test.info().outputPath("follow-up-admitted-queue-desktop-1920x1080.png"),
    });
    await desktopReopen.click();
    await expect(approval).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("approval-approve")).toBeInViewport();
    await expect(page.getByTestId("approval-reject")).toBeInViewport();
    await expect(page.getByTestId("modal-backdrop")).toHaveCSS("opacity", "1", {
        timeout: 5_000,
    });
    await expect(approval).toBeVisible();
    await page.mouse.move(0, 0);
    await page.screenshot({
        path: test.info().outputPath("follow-up-child-admitted-desktop-1920x1080.png"),
    });
    const admittedMessagesResponse = await request.get(
        `${CP_URL}/api/v1/sessions/${session.sessionId}/messages?branchId=${encodeURIComponent(session.branchId)}`,
        { headers: session.headers },
    );
    const admittedMessages = (await admittedMessagesResponse.json()) as Array<{
        id: string;
        content: string;
    }>;
    expect(
        admittedMessages
            .filter((message) => message.content === followUpText)
            .map((message) => message.id),
    ).toEqual([child?.childMessageId]);

    await approval.locator('[data-testid="approval-approve"]').click();
    await expect
        .poll(
            async () =>
                (await loadFollowUpSnapshot(request, session.sessionId, session.headers))
                    .outstandingCount,
            { timeout: 60_000 },
        )
        .toBe(0);
    await expect(page.getByTestId("follow-up-queue")).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByText("Approval received.").last()).toBeVisible({ timeout: 60_000 });
    const finalMessagesResponse = await request.get(
        `${CP_URL}/api/v1/sessions/${session.sessionId}/messages?branchId=${encodeURIComponent(session.branchId)}`,
        { headers: session.headers },
    );
    expect(finalMessagesResponse.ok(), await finalMessagesResponse.text()).toBeTruthy();
    const finalMessages = (await finalMessagesResponse.json()) as Array<{
        role: string;
        content: string;
    }>;
    expect(finalMessages.filter((message) => message.content === followUpText)).toHaveLength(1);
    expect(session.principalId).toBeTruthy();
    expect(pageErrors).toEqual([]);
    expect(consoleErrorCount.value).toBe(0);
    expect(requestFailures).toEqual([]);
});

test("@host Follow-up queue stays durable and reachable on a mobile viewport", async ({
    page,
    request,
}) => {
    requireApprovalMode();
    test.setTimeout(240_000);
    const pageErrors: Error[] = [],
        consoleErrorCount = { value: 0 },
        requestFailures: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error));
    page.on("console", (message) => {
        if (message.type() === "error") consoleErrorCount.value++;
    });
    page.on("requestfailed", (request) => {
        const error = request.failure()?.errorText ?? "unknown";
        if (error !== "net::ERR_ABORTED") {
            requestFailures.push(`${request.method()} ${new URL(request.url()).pathname}`);
        }
    });

    // Create the session at desktop width: the workspace sidebar drawer that hosts
    // the create-session controls is collapsed by default at 390px, so clicking
    // them there waits until the whole test times out (observed 2026-10-07).
    // Session creation is setup, not part of the mobile matrix — every step under
    // test (queue composer, queue panel, approval modal, reload, screenshots)
    // runs below at the real 390x844 viewport.
    const session = await bootstrapSession(request, page);
    await page.setViewportSize({ width: 390, height: 844 });
    // At 390px the app shell hides the chat pane behind the "Open chat" toggle and
    // defaults to the Files pane; this is the same entry pattern the mock follow-up
    // spec uses at 390x844 (e2e/mock/follow-up-queue.spec.ts mobile tests).
    const openChat = page.getByRole("button", { name: "Open chat" });
    await expect(openChat).toBeVisible({ timeout: 20_000 });
    await openChat.click();
    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 20_000 });

    const parent = await submitChat(page, "please delete README.md");
    const approvalModal = page.locator('[data-testid="modal-backdrop"]:visible');
    const approval = approvalModal.getByTestId("approval-modal-content");
    await expect(approval).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("chat-queue-button")).toBeVisible({ timeout: 10_000 });
    await approvalModal.getByRole("button", { name: "Close" }).click();
    await expect(approvalModal).toBeHidden({ timeout: 10_000 });

    const followUpText = "Mobile follow-up after parent approval.";
    await page.getByTestId("chat-input").fill(followUpText);
    const followUpResponse = page.waitForResponse(
        (response) =>
            response.url().endsWith(`/api/v1/sessions/${session.sessionId}/follow-ups`) &&
            response.request().method() === "POST",
    );
    await page.getByTestId("chat-queue-button").click();
    expect((await followUpResponse).status()).toBe(202);
    const queued = await loadFollowUpSnapshot(request, session.sessionId, session.headers);
    expect(queued.outstandingCount).toBe(1);
    const queueItemId = queued.items[0]!.queueItemId;

    const queueItem = page.getByTestId("follow-up-queue-item").first();
    await expect(page.getByTestId("follow-up-queue")).toBeVisible();
    await expect(queueItem).toContainText(followUpText);
    await expect(queueItem.getByRole("button")).toBeVisible();
    // The enqueue success toast enters over the composer at the bottom; capture the
    // settled state after it auto-dismisses so the composer controls are unobscured.
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 10_000 });
    // Clear hover state so no tooltip overlays the composer in the evidence shot.
    await page.mouse.move(0, 0);
    await page.screenshot({
        path: test.info().outputPath("follow-up-queued-mobile-390x844.png"),
    });

    await page.reload({ waitUntil: "domcontentloaded" });
    // The mobile shell always lands on the Files pane after a reload (observed
    // 2026-10-07), so reopen chat unconditionally; click auto-waits for the toggle.
    await page.getByRole("button", { name: "Open chat" }).click({ timeout: 15_000 });
    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 20_000 });
    await expect(approval).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("follow-up-queue-item").first()).toContainText(followUpText);

    await approval.locator('[data-testid="approval-approve"]').click();
    // Same semantic-resolution wait as the desktop flow: the child approval modal
    // may replace the parent's in the same container without a hidden frame.
    await expect(page.getByText("Approval received.").last()).toBeVisible({ timeout: 20_000 });
    await expect
        .poll(
            async () => {
                const snapshot = await loadFollowUpSnapshot(
                    request,
                    session.sessionId,
                    session.headers,
                );
                return (
                    snapshot.items.find((item) => item.queueItemId === queueItemId)?.childRunId ??
                    null
                );
            },
            { timeout: 60_000 },
        )
        .not.toBeNull();

    // Same server-side pending gate as the desktop flow (child pending must exist
    // before waiting for the modal, avoiding the parent->child handoff gap).
    await expect
        .poll(
            async () => {
                const response = await request.get(`${CP_URL}/api/v1/approvals/pending`, {
                    headers: session.headers,
                });
                if (!response.ok()) return 0;
                const body = (await response.json()) as unknown;
                return Array.isArray(body) ? body.length : 0;
            },
            { timeout: 60_000 },
        )
        .toBeGreaterThan(0);
    // Hide the modal to capture the admitted queue state, then reopen it and prove
    // both approval controls remain reachable in the real mobile viewport.
    const mobileReopen = page.getByTestId("pending-approval-reopen-pill");
    if (await approvalModal.isVisible()) {
        await approvalModal.getByRole("button", { name: "Close" }).click();
    }
    await expect(approvalModal).toBeHidden({ timeout: 10_000 });
    await expect(mobileReopen).toBeVisible({ timeout: 20_000 });
    const mobileAdmittedItem = page.getByTestId("follow-up-queue-item").first();
    await expect(page.getByText(followUpText, { exact: true }).last()).toBeVisible();
    await expect(mobileAdmittedItem.getByTestId("follow-up-item-status")).toHaveAttribute(
        "data-status",
        "admitted",
    );
    await page.screenshot({
        path: test.info().outputPath("follow-up-admitted-queue-mobile-390x844.png"),
    });
    await mobileReopen.click();
    await expect(approval).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("approval-approve")).toBeInViewport();
    await expect(page.getByTestId("approval-reject")).toBeInViewport();
    await expect(page.getByTestId("modal-backdrop")).toHaveCSS("opacity", "1", {
        timeout: 5_000,
    });
    await expect(approval).toBeVisible();
    await page.screenshot({
        path: test.info().outputPath("follow-up-child-admitted-mobile-390x844.png"),
    });
    await approval.locator('[data-testid="approval-approve"]').click();
    await expect
        .poll(
            async () =>
                (await loadFollowUpSnapshot(request, session.sessionId, session.headers))
                    .outstandingCount,
            { timeout: 60_000 },
        )
        .toBe(0);
    await expect(page.getByTestId("follow-up-queue")).toHaveCount(0, { timeout: 20_000 });
    expect(parent.runId).toBeTruthy();
    expect(pageErrors).toEqual([]);
    expect(consoleErrorCount.value).toBe(0);
    expect(requestFailures).toEqual([]);
});
