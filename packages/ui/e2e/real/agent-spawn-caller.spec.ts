import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test, expect } from "@playwright/test";
import {
    CP_URL,
    ensureAgentWorkspaceBinding,
    getRootBranchId,
    registerJourneyUser,
    sendChat,
    seedPage,
} from "./helpers/journey";
import { workspaceChatPath } from "../../src/lib/routes";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fakeLlmUrl = new URL(CP_URL);
fakeLlmUrl.port = process.env.XIHE_FAKE_LLM_PORT ?? "13642";
const FAKE_LLM_URL = fakeLlmUrl.origin;

test.describe.configure({ mode: "serial", retries: 0 });
test.skip(
    process.env.XIHE_E2E_LLM_MODE !== "spawn_agent" ||
        Boolean(process.env.XIHE_E2E_REAL_XIAOMI_KEY),
    "requires the isolated spawn_agent fake LLM mode",
);

function requireUuid(value: string): string {
    if (!UUID_PATTERN.test(value)) throw new Error("Expected a UUID from the isolated host stack");
    return value;
}

function queryIsolatedPostgres(sql: string): string {
    const container = process.env.XIHE_E2E_PG_CONTAINER;
    const database = process.env.XIHE_E2E_PG_DATABASE;
    const user = process.env.XIHE_E2E_PG_USER;
    if (!container || !database || !user) {
        throw new Error(
            "isolated Postgres fixture metadata is unavailable; run through scripts/e2e-host.mjs",
        );
    }
    return execFileSync(
        process.platform === "win32" ? "docker.exe" : "docker",
        ["exec", container, "psql", "-X", "-A", "-t", "-U", user, "-d", database, "-c", sql],
        { encoding: "utf8", timeout: 15_000, windowsHide: true },
    ).trim();
}

function scalarCount(sql: string): number {
    const value = queryIsolatedPostgres(sql);
    if (!/^\d+$/.test(value))
        throw new Error(`Expected an isolated Postgres count, received: ${value}`);
    return Number(value);
}

function seedUserSpawnPermissions(userId: string, workspaceId: string): void {
    const permissions = JSON.stringify([
        { actionClass: "CREATE_ACCOUNT", resource: "*" },
        { actionClass: "MANAGE_WORKSPACE_AGENTS", resource: workspaceId },
        { actionClass: "SPAWN_AGENT", resource: "*" },
    ]).replaceAll("'", "''");
    queryIsolatedPostgres(`
    INSERT INTO grants (id, granter_type, granter_id, subject_type, subject_id, permissions, source, read_state)
    VALUES (gen_random_uuid(), 'user', '${userId}'::uuid, 'user', '${userId}'::uuid,
            '${permissions}'::jsonb, 'direct', 'read')
  `);
}

function addPrincipalSpawnGrant(principalId: string): void {
    const grantId = requireUuid(
        queryIsolatedPostgres(`
    SELECT id FROM grants
    WHERE subject_type = 'agent_principal' AND subject_id = '${principalId}'::uuid
    ORDER BY created_at DESC LIMIT 1
  `),
    );
    queryIsolatedPostgres(`
    UPDATE grants
    SET permissions = permissions || '[{"actionClass":"SPAWN_AGENT","resource":"*"}]'::jsonb
    WHERE id = '${grantId}'::uuid
      AND NOT (permissions @> '[{"actionClass":"SPAWN_AGENT","resource":"*"}]'::jsonb)
  `);
    if (
        scalarCount(`
    SELECT count(*) FROM grants WHERE id = '${grantId}'::uuid
      AND permissions @> '[{"actionClass":"SPAWN_AGENT","resource":"*"}]'::jsonb
  `) !== 1
    ) {
        throw new Error("The Agent principal fixture grant does not include SPAWN_AGENT");
    }
}

test("@host Agent spawn uses CP logical MCP, approval retry, and child terminal link", async ({
    page,
    request,
}) => {
    test.setTimeout(240_000);
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const apiFailures: string[] = [];
    const consoleErrorEvents: Array<{
        text: string;
        sourceUrl: string;
        lineNumber: number;
        observedAt: string;
    }> = [];
    const browserHttpFailures: Array<{
        method: string;
        url: string;
        resourceType: string;
        status: number;
        requestId: string | null;
        correlationHeaders: Record<string, string>;
        observedAt: string;
        metadataCaptureFailed?: boolean;
    }> = [];
    const httpFailureCaptures: Promise<void>[] = [];
    const browserChatRequests: string[] = [];
    const browserChatSubmissions: Array<{ idempotencyKey: string | null; body: string }> = [];
    const derivedStateResponses: Array<{
        status: number;
        body: {
            sessionId?: string;
            activeChildren?: Array<{
                childSessionId: string;
                runId: string;
                name: string | null;
                status: string;
            }>;
            terminalNotices?: Array<{
                childSessionId: string;
                runId: string;
                name: string | null;
                state: string;
                terminalAt: string;
            }>;
        };
    }> = [];
    const operationTraceResponses: Array<{
        status: number;
        body: {
            items?: Array<{
                toolCallId?: string;
                waitingOnRunId?: string;
                toolName?: string;
                status?: string;
            }>;
        };
    }> = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
        if (message.type() === "error") {
            consoleErrors.push(message.text());
            const location = message.location();
            consoleErrorEvents.push({
                text: message.text(),
                sourceUrl: location.url,
                lineNumber: location.lineNumber,
                observedAt: new Date().toISOString(),
            });
        }
    });
    page.on("requestfailed", (failed) => {
        if (failed.url().startsWith(CP_URL)) apiFailures.push(`${failed.method()} ${failed.url()}`);
    });
    page.on("response", (response) => {
        if (response.status() < 400) return;
        const browserRequest = response.request(),
            safeUrl = new URL(response.url()),
            url = `${safeUrl.origin}${safeUrl.pathname}`;
        const capture = response
            .allHeaders()
            .then((responseHeaders) => {
                const requestHeaders = browserRequest.headers();
                browserHttpFailures.push({
                    method: browserRequest.method(),
                    url,
                    resourceType: browserRequest.resourceType(),
                    status: response.status(),
                    requestId: responseHeaders["x-request-id"] ?? null,
                    correlationHeaders: Object.fromEntries(
                        [
                            "x-request-id",
                            "x-chat-run-id",
                            "x-operation-id",
                            "x-agent-session-id",
                            "x-workspace-id",
                            "x-session-id",
                        ]
                            .filter((name) => requestHeaders[name])
                            .map((name) => [name, requestHeaders[name]]),
                    ),
                    observedAt: new Date().toISOString(),
                });
            })
            .catch(() => {
                browserHttpFailures.push({
                    method: browserRequest.method(),
                    url,
                    resourceType: browserRequest.resourceType(),
                    status: response.status(),
                    requestId: null,
                    correlationHeaders: {},
                    observedAt: new Date().toISOString(),
                    metadataCaptureFailed: true,
                });
            });
        httpFailureCaptures.push(capture);
    });
    page.on("request", (outgoing) => {
        if (outgoing.url().includes("/api/v1/chat")) {
            browserChatRequests.push(outgoing.method());
            if (outgoing.method() === "POST") {
                browserChatSubmissions.push({
                    idempotencyKey: outgoing.headers()["idempotency-key"] ?? null,
                    body: outgoing.postData() ?? "",
                });
            }
        }
    });
    page.on("response", async (response) => {
        if (
            !response.url().includes("/api/v1/sessions/") ||
            !response.url().endsWith("/derived-state")
        )
            return;
        try {
            derivedStateResponses.push({ status: response.status(), body: await response.json() });
        } catch {
            derivedStateResponses.push({ status: response.status(), body: {} });
        }
    });
    page.on("response", async (response) => {
        if (
            response.request().method() !== "GET" ||
            !response.url().includes("/api/v1/operations/")
        )
            return;
        try {
            operationTraceResponses.push({
                status: response.status(),
                body: await response.json(),
            });
        } catch {
            operationTraceResponses.push({ status: response.status(), body: {} });
        }
    });

    const fakeHealth = await request.get(`${FAKE_LLM_URL}/health`);
    expect(fakeHealth.ok(), "spawn fake LLM must be ready").toBeTruthy();
    expect(((await fakeHealth.json()) as { mode: string }).mode).toBe("spawn_agent");

    const owner = await registerJourneyUser(request, "agent-spawn-host");
    const ownerMe = await request.get(`${CP_URL}/api/v1/auth/me`, { headers: owner.headers });
    expect(ownerMe.ok(), await ownerMe.text()).toBeTruthy();
    const userId = requireUuid(((await ownerMe.json()) as { id: string }).id);
    const workspaceId = requireUuid(owner.workspaceId);
    const workspaceHeaders = { ...owner.headers, "X-Workspace-Id": workspaceId };
    seedUserSpawnPermissions(userId, workspaceId);

    const principalResponse = await request.post(`${CP_URL}/api/v1/agent-principals`, {
        headers: workspaceHeaders,
        data: { name: "CP MCP Spawn E2E" },
    });
    expect(principalResponse.status(), await principalResponse.text()).toBe(201);
    const principalId = requireUuid(
        ((await principalResponse.json()) as { principalId: string }).principalId,
    );
    addPrincipalSpawnGrant(principalId);

    const bindingResponse = await request.put(
        `${CP_URL}/api/v1/workspaces/${workspaceId}/agents/${principalId}`,
        {
            headers: workspaceHeaders,
            data: { permissions: [{ actionClass: "SPAWN_AGENT", resource: "*" }] },
        },
    );
    expect(bindingResponse.status(), await bindingResponse.text()).toBe(200);
    await ensureAgentWorkspaceBinding(workspaceId);

    seedPage(page, owner);
    const workspaceFileToolRequestPromise = page.waitForRequest(
        (outgoing) => {
            if (outgoing.method() !== "POST" || !outgoing.url().includes("/api/v1/mcp"))
                return false;
            try {
                const payload = outgoing.postDataJSON() as {
                    method?: string;
                    params?: { name?: string; arguments?: { path?: string } };
                };
                return payload.method === "tools/call" && payload.params?.name === "list_directory";
            } catch {
                return false;
            }
        },
        { timeout: 30_000 },
    );
    await page.goto(`/workspace/${workspaceId}`, { waitUntil: "load" });
    const workspaceFileToolRequest = await workspaceFileToolRequestPromise,
        workspaceFileToolResponse = await workspaceFileToolRequest.response();
    expect(
        workspaceFileToolResponse,
        "workspace UI list_directory must receive a response",
    ).not.toBeNull();
    expect(workspaceFileToolResponse!.status()).toBe(200);
    const workspaceFileRequestHeaders = await workspaceFileToolRequest.allHeaders(),
        workspaceFileResponseHeaders = await workspaceFileToolResponse!.allHeaders();
    expect(workspaceFileRequestHeaders.authorization).toBe(owner.headers.Authorization);
    expect(workspaceFileRequestHeaders["x-chat-run-id"]).toBeUndefined();
    expect(workspaceFileRequestHeaders["x-operation-id"]).toBeUndefined();
    expect(workspaceFileResponseHeaders["x-request-id"]).toBeTruthy();
    expect(await workspaceFileToolResponse!.json()).toHaveProperty("result");
    await expect(page.getByTestId("workspace-tree-loading")).toBeHidden({ timeout: 30_000 });
    await expect
        .poll(
            async () =>
                (await page
                    .getByTestId("workspace-empty-state")
                    .isVisible()
                    .catch(() => false)) || (await page.getByRole("treeitem").count()) > 0,
            { timeout: 30_000 },
        )
        .toBeTruthy();
    const emptyStateVisible = await page.getByTestId("workspace-empty-state").isVisible();
    const visibleTreeItemCount = await page.getByRole("treeitem").count();
    const visibleTreeState = emptyStateVisible
        ? "empty"
        : visibleTreeItemCount > 0
          ? "tree"
          : "unknown";
    expect(visibleTreeState).not.toBe("unknown");
    const workspaceFileRequestBody = workspaceFileToolRequest.postDataJSON() as {
        method: string;
        params: { name: string; arguments: { path?: string } };
    };
    const userRequestId = workspaceFileResponseHeaders["x-request-id"];
    expect(userRequestId).toMatch(UUID_PATTERN);
    const evidence = {
        method: workspaceFileRequestBody.method,
        tool: workspaceFileRequestBody.params.name,
        path: workspaceFileRequestBody.params.arguments.path ?? "",
        userBearerMatched:
            workspaceFileRequestHeaders.authorization === owner.headers.Authorization,
        hasAgentRunContext: Boolean(workspaceFileRequestHeaders["x-chat-run-id"]),
        hasAgentOperationContext: Boolean(workspaceFileRequestHeaders["x-operation-id"]),
        responseStatus: workspaceFileToolResponse!.status(),
        requestId: userRequestId,
        visibleTreeState,
        visibleTreeItemCount,
    };
    const evidenceJson = JSON.stringify(evidence, null, 2);
    const runId = (process.env.XIHE_E2E_RUN_ID ?? "manual").replace(/[^a-zA-Z0-9-]/g, "-");
    const evidencePath = resolve(
        process.cwd(),
        "../../.local/dev",
        `host-auth-${runId}-workspace-tree`,
    );
    const screenshot = await page.screenshot();
    await writeFile(`${evidencePath}.json`, evidenceJson);
    await writeFile(`${evidencePath}.png`, screenshot);
    process.stdout.write(
        `[PLAN-0420] host-auth-evidence=${evidencePath}.json; screenshot=${evidencePath}.png\n`,
    );
    await test.info().attach("workspace-ui-file-tool-auth.json", {
        body: evidenceJson,
        contentType: "application/json",
    });
    await test.info().attach("workspace-file-tree.png", {
        body: screenshot,
        contentType: "image/png",
    });
    const createSession = page.getByTestId("workspace-create-session");
    await expect(createSession).toBeVisible({ timeout: 30_000 });
    await createSession.click();
    const principalPicker = page.getByTestId("workspace-agent-principal-select");
    await expect(principalPicker).toBeVisible();
    await principalPicker.selectOption(principalId);
    const sessionResponsePromise = page.waitForResponse(
        (response) =>
            response.url().endsWith("/api/v1/sessions") && response.request().method() === "POST",
    );
    await page.getByTestId("workspace-create-agent-session").click();
    const sessionResponse = await sessionResponsePromise;
    expect(sessionResponse.status(), await sessionResponse.text()).toBe(201);
    const createdParent = (await sessionResponse.json()) as { id: string; title?: string };
    const parentSessionId = requireUuid(createdParent.id);
    const parentSessionTitle =
        createdParent.title ??
        queryIsolatedPostgres(`SELECT title FROM sessions WHERE id = '${parentSessionId}'::uuid`);
    await expect(page).toHaveURL(workspaceChatPath(workspaceId, parentSessionId));
    await expect(page.getByTestId("chat-input")).toBeVisible();
    await expect
        .poll(
            () =>
                derivedStateResponses.some(
                    (item) => item.status === 200 && item.body.sessionId === parentSessionId,
                ),
            { timeout: 30_000 },
        )
        .toBeTruthy();

    queryIsolatedPostgres(
        `UPDATE sessions SET approval_mode = 'manual' WHERE id = '${parentSessionId}'::uuid`,
    );
    const sessionView = await request.get(`${CP_URL}/api/v1/sessions/${parentSessionId}`, {
        headers: workspaceHeaders,
    });
    expect(sessionView.ok(), await sessionView.text()).toBeTruthy();
    expect(((await sessionView.json()) as { agentPrincipalId: string }).agentPrincipalId).toBe(
        principalId,
    );

    let childReleaseNeeded = false;
    try {
        const token = `spawn-${Date.now().toString(36)}`;
        const derivedResponsesBeforeSpawn = derivedStateResponses.length;
        childReleaseNeeded = true;
        await sendChat(page, `XIHE-E2E-SPAWN ${token}`);
        const approvalModal = page.locator('[data-testid="modal-content"]');
        await expect(approvalModal, "spawn must use the existing MCP approval gate").toBeVisible({
            timeout: 60_000,
        });
        await approvalModal.locator('[data-testid="approval-approve"]').click();
        await expect(approvalModal).toBeHidden({ timeout: 20_000 });

        await expect
            .poll(
                async () => {
                    const stateResponse = await request.get(
                        `${FAKE_LLM_URL}/__test/spawn-child-state`,
                    );
                    if (!stateResponse.ok()) return -1;
                    return ((await stateResponse.json()) as { pending: number }).pending;
                },
                { timeout: 60_000, intervals: [250, 500, 1_000] },
            )
            .toBe(1);

        const parentOperationId = requireUuid(
            queryIsolatedPostgres(
                `SELECT id FROM ledger_operations WHERE session_id = '${parentSessionId}'::uuid ORDER BY created_at DESC LIMIT 1`,
            ),
        );
        const parentRunId = requireUuid(
            queryIsolatedPostgres(
                `SELECT run_id FROM ledger_operations WHERE id = '${parentOperationId}'::uuid`,
            ),
        );
        const traceUrl = `${CP_URL}/api/v1/operations/${parentOperationId}`;
        let parentItem:
            | {
                  source?: string;
                  toolName?: string;
                  status?: string;
                  waitingOnRunId?: string | null;
              }
            | undefined;
        await expect
            .poll(
                async () => {
                    const traceResponse = await request.get(traceUrl, {
                        headers: workspaceHeaders,
                    });
                    if (!traceResponse.ok()) return "";
                    const trace = (await traceResponse.json()) as {
                        items?: Array<typeof parentItem>;
                    };
                    parentItem = trace.items?.find(
                        (item) => item?.source === "agent" && item.toolName === "spawn_agent",
                    );
                    return parentItem?.waitingOnRunId ?? "";
                },
                { timeout: 30_000, intervals: [250, 500, 1_000] },
            )
            .not.toBe("");

        const childRunId = requireUuid(parentItem?.waitingOnRunId ?? "");
        const childSessionId = requireUuid(
            queryIsolatedPostgres(
                `SELECT session_id FROM chat_runs WHERE id = '${childRunId}'::uuid`,
            ),
        );
        const childName = queryIsolatedPostgres(
            `SELECT title FROM sessions WHERE id = '${childSessionId}'::uuid`,
        );
        expect(childName).not.toBe("");
        await expect
            .poll(
                () =>
                    derivedStateResponses
                        .slice(derivedResponsesBeforeSpawn)
                        .some(
                            (item) =>
                                item.status === 200 &&
                                item.body.activeChildren?.some(
                                    (child) => child.runId === childRunId,
                                ),
                        ),
                { timeout: 30_000, intervals: [250, 500, 1_000] },
            )
            .toBeTruthy();
        await expect
            .poll(
                () =>
                    operationTraceResponses.some(
                        (response) =>
                            response.status === 200 &&
                            response.body.items?.some((item) => item.waitingOnRunId === childRunId),
                    ),
                { timeout: 30_000, intervals: [250, 500, 1_000] },
            )
            .toBeTruthy();
        const waitLinkEvidence = operationTraceResponses
            .flatMap((response) => response.body.items ?? [])
            .filter((item) => item.waitingOnRunId === childRunId)
            .map(({ toolCallId, waitingOnRunId, toolName, status }) => ({
                toolCallId,
                waitingOnRunId,
                toolName,
                status,
            }));
        await test.info().attach("parent-operation-waiting-link.json", {
            body: JSON.stringify(waitLinkEvidence, null, 2),
            contentType: "application/json",
        });
        await expect(page.getByTestId("derived-active-child")).toContainText(childName);
        await expect(page.getByTestId("tool-call-waiting-on")).toContainText(childName);

        const childSessionResponse = await request.get(
            `${CP_URL}/api/v1/sessions/${childSessionId}`,
            {
                headers: workspaceHeaders,
            },
        );
        expect(childSessionResponse.ok(), await childSessionResponse.text()).toBeTruthy();
        const childSession = (await childSessionResponse.json()) as {
            id: string;
            workspaceId: string;
            agentPrincipalId: string;
        };
        expect(childSession).toMatchObject({
            id: childSessionId,
            workspaceId,
            agentPrincipalId: principalId,
        });
        expect(
            scalarCount(
                `SELECT count(*) FROM sessions WHERE id = '${childSessionId}'::uuid ` +
                    `AND spawned_from_run_id = '${parentRunId}'::uuid AND kind = 'spawn'`,
            ),
        ).toBe(1);
        expect(
            scalarCount(
                `SELECT count(*) FROM audit_logs WHERE action = 'agent_spawn_created' AND resource_id = '${childSessionId}'`,
            ),
        ).toBe(1);

        const parentAssistant = page.locator('[data-slot="message"][data-align="start"]').last();
        await expect(parentAssistant).toContainText("SPAWN_PARENT_DONE child dispatched", {
            timeout: 60_000,
        });
        const parentRunStatus = queryIsolatedPostgres(
            `SELECT status FROM chat_runs WHERE id = '${parentRunId}'::uuid`,
        );
        expect(parentRunStatus).toBe("succeeded");

        const derivedResponsesBeforeTerminal = derivedStateResponses.length;
        const releaseResponse = await request.post(`${FAKE_LLM_URL}/__test/release-spawn-child`);
        expect(releaseResponse.ok(), await releaseResponse.text()).toBeTruthy();
        expect(((await releaseResponse.json()) as { released: number }).released).toBe(1);
        childReleaseNeeded = false;

        await expect
            .poll(
                async () =>
                    queryIsolatedPostgres(
                        `SELECT status FROM chat_runs WHERE id = '${childRunId}'::uuid`,
                    ),
                { timeout: 60_000, intervals: [250, 500, 1_000] },
            )
            .toBe("succeeded");
        await expect
            .poll(
                () =>
                    derivedStateResponses
                        .slice(derivedResponsesBeforeTerminal)
                        .some(
                            (item) =>
                                item.status === 200 &&
                                item.body.terminalNotices?.some(
                                    (notice) =>
                                        notice.runId === childRunId && notice.state === "success",
                                ),
                        ),
                { timeout: 30_000, intervals: [250, 500, 1_000] },
            )
            .toBeTruthy();
        await expect(page.getByTestId("derived-terminal-notice")).toContainText(childName);
        await expect(page.getByTestId("derived-active-child")).toHaveCount(0);
        await expect(page.getByTestId("tool-call-waiting-on")).toHaveCount(0);
        const terminalScreenshotPath = test.info().outputPath("derived-state-terminal-visible.png");
        await page.screenshot({ path: terminalScreenshotPath, fullPage: false });
        await test.info().attach("derived-state-terminal-visible.png", {
            path: terminalScreenshotPath,
            contentType: "image/png",
        });

        const derivedResponsesBeforeReconnect = derivedStateResponses.length;
        await page.goto(`/workspace/${workspaceId}`, { waitUntil: "load" });
        await page.goto(workspaceChatPath(workspaceId, parentSessionId), { waitUntil: "load" });
        await expect(page.getByTestId("derived-terminal-notice")).toContainText(childName);
        await expect
            .poll(
                () =>
                    derivedStateResponses
                        .slice(derivedResponsesBeforeReconnect)
                        .some(
                            (item) =>
                                item.status === 200 &&
                                item.body.terminalNotices?.some(
                                    (notice) => notice.runId === childRunId,
                                ),
                        ),
                { timeout: 30_000, intervals: [250, 500, 1_000] },
            )
            .toBeTruthy();

        const derivedResponsesBeforeReload = derivedStateResponses.length;
        await page.reload({ waitUntil: "load" });
        await expect(page.getByTestId("derived-terminal-notice")).toContainText(childName);
        await expect
            .poll(
                () =>
                    derivedStateResponses
                        .slice(derivedResponsesBeforeReload)
                        .some(
                            (item) =>
                                item.status === 200 &&
                                item.body.terminalNotices?.some(
                                    (notice) => notice.runId === childRunId,
                                ),
                        ),
                { timeout: 30_000, intervals: [250, 500, 1_000] },
            )
            .toBeTruthy();

        const childAssistantMessageId = requireUuid(
            queryIsolatedPostgres(
                `SELECT assistant_message_id FROM chat_runs WHERE id = '${childRunId}'::uuid`,
            ),
        );
        await expect
            .poll(
                async () =>
                    JSON.parse(
                        queryIsolatedPostgres(`
      SELECT coalesce(json_agg(json_build_object(
        'status', status,
        'waitingOnRunId', waiting_on_run_id,
        'resultRef', result_ref
      ) ORDER BY sequence)::text, '[]')
      FROM operation_items
      WHERE operation_id = '${parentOperationId}'::uuid
        AND kind = 'tool_call' AND source = 'agent' AND tool_name = 'spawn_agent'
    `),
                    ) as Array<{
                        status: string;
                        waitingOnRunId: string | null;
                        resultRef: string | null;
                    }>,
                { timeout: 30_000, intervals: [250, 500, 1_000] },
            )
            .toEqual([
                {
                    status: "completed",
                    waitingOnRunId: null,
                    resultRef: childAssistantMessageId,
                },
            ]);

        const childBranchId = await getRootBranchId(request, childSessionId, workspaceHeaders);
        const childMessagesResponse = await request.get(
            `${CP_URL}/api/v1/sessions/${childSessionId}/messages?branchId=${childBranchId}`,
            { headers: workspaceHeaders },
        );
        expect(childMessagesResponse.ok(), await childMessagesResponse.text()).toBeTruthy();
        const childMessages = (await childMessagesResponse.json()) as Array<{
            role?: string;
            content?: string;
        }>;
        expect(
            childMessages.some(
                (message) =>
                    message.role.toLowerCase() === "assistant" &&
                    message.content?.includes("SPAWN_CHILD_DONE"),
            ),
        ).toBe(true);

        const pendingInboxId = requireUuid(
            queryIsolatedPostgres(
                `SELECT id FROM inbox WHERE to_session_id = '${parentSessionId}'::uuid AND injected_run_id IS NULL`,
            ),
        );
        const parentRunsBeforeClaim = scalarCount(
            `SELECT count(*) FROM chat_runs WHERE session_id = '${parentSessionId}'::uuid`,
        );
        const parentOperationsBeforeClaim = scalarCount(
            `SELECT count(*) FROM ledger_operations WHERE session_id = '${parentSessionId}'::uuid`,
        );
        const submissionsBeforeClaim = browserChatSubmissions.length;
        await sendChat(page, `Acknowledge completed child ${token}`);
        await expect.poll(() => browserChatSubmissions.length).toBe(submissionsBeforeClaim + 1);

        const claimSubmission = browserChatSubmissions.at(-1);
        expect(claimSubmission?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
        expect(claimSubmission?.body).not.toBe("");
        const claimBody = JSON.parse(claimSubmission!.body) as { sessionId?: string };
        expect(claimBody.sessionId).toBe(parentSessionId);
        await expect
            .poll(
                () =>
                    scalarCount(
                        `SELECT count(*) FROM chat_runs WHERE session_id = '${parentSessionId}'::uuid`,
                    ),
                { timeout: 30_000, intervals: [100, 250, 500] },
            )
            .toBe(parentRunsBeforeClaim + 1);

        const claimRunId = requireUuid(
            queryIsolatedPostgres(
                `SELECT id FROM chat_runs WHERE session_id = '${parentSessionId}'::uuid ORDER BY created_at DESC LIMIT 1`,
            ),
        );
        const claimedRunId = () =>
            queryIsolatedPostgres(
                `SELECT injected_run_id FROM inbox WHERE id = '${pendingInboxId}'::uuid`,
            );
        await expect
            .poll(claimedRunId, { timeout: 30_000, intervals: [100, 250, 500] })
            .toBe(claimRunId);
        expect(claimSubmission!.body.branchId).toBeTruthy();

        const replayResponse = await request.post(`${CP_URL}/api/v1/chat`, {
            headers: {
                ...workspaceHeaders,
                "Content-Type": "application/json",
                "Idempotency-Key": claimSubmission!.idempotencyKey!,
            },
            data: claimSubmission!.body,
        });
        expect(replayResponse.status(), await replayResponse.text()).toBe(202);
        const replay = (await replayResponse.json()) as { runId?: string; operationId?: string };
        expect(replay.runId).toBe(claimRunId);
        const claimOperationId = requireUuid(
            queryIsolatedPostgres(
                `SELECT id FROM ledger_operations WHERE run_id = '${claimRunId}'::uuid`,
            ),
        );
        expect(replay.operationId).toBe(claimOperationId);
        expect(
            scalarCount(
                `SELECT count(*) FROM chat_runs WHERE session_id = '${parentSessionId}'::uuid`,
            ),
        ).toBe(parentRunsBeforeClaim + 1);
        expect(
            scalarCount(
                `SELECT count(*) FROM ledger_operations WHERE session_id = '${parentSessionId}'::uuid`,
            ),
        ).toBe(parentOperationsBeforeClaim + 1);
        expect(claimedRunId()).toBe(claimRunId);

        await expect
            .poll(
                () =>
                    queryIsolatedPostgres(
                        `SELECT status FROM chat_runs WHERE id = '${claimRunId}'::uuid`,
                    ),
                { timeout: 30_000, intervals: [250, 500, 1_000] },
            )
            .toBe("succeeded");
        await expect(page.getByText("SPAWN_CHILD_READY", { exact: true })).toBeVisible();
        const inboxClaimScreenshotPath = test.info().outputPath("inbox-claim-run-completed.png");
        await page.screenshot({ path: inboxClaimScreenshotPath, fullPage: false });
        await test.info().attach("inbox-claim-run-completed.png", {
            path: inboxClaimScreenshotPath,
            contentType: "image/png",
        });

        const claimReplayEvidencePath = test.info().outputPath("inbox-claim-replay.json");
        await writeFile(
            claimReplayEvidencePath,
            JSON.stringify(
                {
                    parentSessionId,
                    childSessionId,
                    childRunId,
                    inboxId: pendingInboxId,
                    claimRunId,
                    replayRunId: replay.runId,
                    claimOperationId,
                    replayOperationId: replay.operationId,
                    inboxInjectedRunId: claimedRunId(),
                    runCount: scalarCount(
                        `SELECT count(*) FROM chat_runs WHERE session_id = '${parentSessionId}'::uuid`,
                    ),
                    operationCount: scalarCount(
                        `SELECT count(*) FROM ledger_operations WHERE session_id = '${parentSessionId}'::uuid`,
                    ),
                },
                null,
                2,
            ),
        );
        await test.info().attach("inbox-claim-replay.json", {
            path: claimReplayEvidencePath,
            contentType: "application/json",
        });

        const parentSessionItem = page.locator('[data-testid="session-item"][aria-current="page"]');
        await expect(parentSessionItem).toBeVisible();
        await expect(parentSessionItem).toContainText(parentSessionTitle);
        await parentSessionItem.click({ button: "right" });
        await page.getByTestId("session-item-delete").click();
        const deleteWarning = page.getByTestId("session-delete-warning");
        await expect(deleteWarning).toBeVisible();
        await expect(page.getByTestId("modal-backdrop")).toHaveCSS("opacity", "1");
        await expect(deleteWarning).toContainText(
            /子会话和运行会保留|Spawned child sessions and runs remain/,
        );
        const confirmDelete = page.getByTestId("session-delete-confirm");
        await expect(confirmDelete).toBeVisible();
        const deleteButtonStyle = await confirmDelete.evaluate((element) => {
            const style = getComputedStyle(element);
            return {
                color: style.color,
                backgroundColor: style.backgroundColor,
                pointerEvents: style.pointerEvents,
            };
        });
        expect(deleteButtonStyle.pointerEvents).toBe("auto");
        expect(deleteButtonStyle.color).not.toBe(deleteButtonStyle.backgroundColor);
        const deleteWarningScreenshotPath = test.info().outputPath("parent-delete-warning.png");
        await page.screenshot({ path: deleteWarningScreenshotPath, fullPage: false });
        await test.info().attach("parent-delete-warning.png", {
            path: deleteWarningScreenshotPath,
            contentType: "image/png",
        });
        await confirmDelete.click();
        await expect(deleteWarning).toHaveCount(0);
        expect(
            scalarCount(`SELECT count(*) FROM sessions WHERE id = '${parentSessionId}'::uuid`),
        ).toBe(0);
        expect(
            scalarCount(
                `SELECT count(*) FROM inbox WHERE to_session_id = '${parentSessionId}'::uuid`,
            ),
        ).toBe(0);
        expect(
            scalarCount(`SELECT count(*) FROM sessions WHERE id = '${childSessionId}'::uuid`),
        ).toBe(1);
        expect(scalarCount(`SELECT count(*) FROM chat_runs WHERE id = '${childRunId}'::uuid`)).toBe(
            1,
        );

        await page.goto(workspaceChatPath(workspaceId, childSessionId), { waitUntil: "load" });
        await expect(page).toHaveURL(workspaceChatPath(workspaceId, childSessionId));
        await expect(page.getByTestId("chat-input")).toBeVisible();
        await expect(page.getByTestId("workspace-tree-loading")).toBeHidden({ timeout: 30_000 });
        const childAfterDeleteScreenshotPath = test
            .info()
            .outputPath("child-after-parent-delete.png");
        await page.screenshot({ path: childAfterDeleteScreenshotPath, fullPage: false });
        await test.info().attach("child-after-parent-delete.png", {
            path: childAfterDeleteScreenshotPath,
            contentType: "image/png",
        });

        await Promise.allSettled(httpFailureCaptures);
        expect(browserChatRequests).toContain("POST");
        expect(pageErrors).toEqual([]);
        expect(consoleErrors).toEqual([]);
        expect(apiFailures).toEqual([]);
        expect(browserHttpFailures, JSON.stringify(browserHttpFailures, null, 2)).toEqual([]);
        expect(derivedStateResponses.every((item) => item.status === 200)).toBe(true);

        await test.info().attach("agent-spawn-evidence.json", {
            body: Buffer.from(
                JSON.stringify(
                    {
                        parentSessionId,
                        parentOperationId,
                        parentRunId,
                        childSessionId,
                        childRunId,
                        principalId,
                        browserChatRequests,
                    },
                    null,
                    2,
                ),
            ),
            contentType: "application/json",
        });
    } finally {
        await Promise.allSettled(httpFailureCaptures);
        const browserErrorsPath = test.info().outputPath("host-browser-errors.json");
        await writeFile(
            browserErrorsPath,
            JSON.stringify({ consoleErrorEvents, browserHttpFailures, pageErrors, apiFailures }, null, 2),
        );
        await test.info().attach("host-browser-errors.json", {
            path: browserErrorsPath,
            contentType: "application/json",
        });
        if (childReleaseNeeded) {
            const release = await request
                .post(`${FAKE_LLM_URL}/__test/release-spawn-child`)
                .catch((cause) => {
                    console.warn("Could not release fake spawn child during test cleanup", cause);
                    return null;
                });
            if (release && !release.ok()) {
                console.warn("Fake spawn child cleanup returned an error", release.status());
            }
        }
    }
});
