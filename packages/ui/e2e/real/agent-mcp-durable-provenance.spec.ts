import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
    CP_URL,
    ensureAgentWorkspaceBinding,
    seedPage,
    waitForControlPlaneAgentReady,
} from "./helpers/journey";
import { generateE2EPassword } from "./helpers/password";

test.describe.configure({ mode: "serial", retries: 0 });

function seedUserGrants(userId: string, workspaceId: string) {
    const container = process.env.XIHE_E2E_PG_CONTAINER;
    const database = process.env.XIHE_E2E_PG_DATABASE;
    const dbUser = process.env.XIHE_E2E_PG_USER;
    if (!container || !database || !dbUser) {
        throw new Error("isolated PostgreSQL fixture metadata is unavailable; run via e2e-host");
    }
    const permissions = JSON.stringify([
        { actionClass: "CREATE_ACCOUNT", resource: "*" },
        { actionClass: "CREATE_TEMPLATE", resource: "*" },
        { actionClass: "MANAGE_WORKSPACE_AGENTS", resource: workspaceId },
        { actionClass: "read", resource: "*" },
        { actionClass: "write", resource: "*" },
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

function queryIsolatedPostgres(sql: string): string {
    const container = process.env.XIHE_E2E_PG_CONTAINER;
    const database = process.env.XIHE_E2E_PG_DATABASE;
    const dbUser = process.env.XIHE_E2E_PG_USER;
    if (!container || !database || !dbUser) {
        throw new Error("isolated PostgreSQL fixture metadata is unavailable; run via e2e-host");
    }
    return execFileSync(
        process.platform === "win32" ? "docker.exe" : "docker",
        ["exec", container, "psql", "-X", "-A", "-t", "-U", dbUser, "-d", database, "-c", sql],
        { encoding: "utf8", timeout: 15_000, windowsHide: true },
    ).trim();
}

test("@host PLAN-0387 T3.2 — CP checks durable Agent MCP tool-call provenance", async ({
    page,
    request,
}, testInfo) => {
    test.skip(
        process.env.XIHE_E2E_LLM_MODE !== "write_file",
        "requires XIHE_E2E_LLM_MODE=write_file for one deterministic Runtime tool call",
    );
    test.setTimeout(240_000);

    const password = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();
    const registered = await request.post(`${CP_URL}/api/v1/auth/register`, {
        data: {
            email: `mcp-provenance-${Date.now()}@test.com`,
            password,
            name: "McpProvenance",
        },
    });
    expect(
        [200, 201],
        `register failed: ${registered.status()} ${await registered.text()}`,
    ).toContain(registered.status());
    const auth = (await registered.json()) as { accessToken: string; workspaceId: string };
    const workspaceId = auth.workspaceId;
    const headers = {
        Authorization: `Bearer ${auth.accessToken}`,
        "Content-Type": "application/json",
    };
    const me = await request.get(`${CP_URL}/api/v1/auth/me`, { headers });
    expect(me.ok(), await me.text()).toBe(true);
    const userId = ((await me.json()) as { id: string }).id;
    seedUserGrants(userId, workspaceId);

    const roleId = randomUUID();
    const templateId = randomUUID();
    const templateWrite = await request.put(`${CP_URL}/api/v1/config/user/agent-templates`, {
        headers,
        data: {
            roles: JSON.stringify([
                {
                    id: roleId,
                    name: "Provenance Writer",
                    permissions: [
                        { actionClass: "read", resource: "*" },
                        { actionClass: "write", resource: "*" },
                    ],
                },
            ]),
            templates: JSON.stringify([
                {
                    id: templateId,
                    name: "Provenance Writer",
                    description: "Workspace tool permissions for the T3.2 flow",
                    systemPrompt:
                        "Use the Workspace tool named write_file for the requested marker.",
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
        data: { name: "Provenance Writer", templateId },
    });
    expect(principalResponse.status(), await principalResponse.text()).toBe(201);
    const principalId = ((await principalResponse.json()) as { principalId: string }).principalId;
    const bindingResponse = await request.put(
        `${CP_URL}/api/v1/workspaces/${workspaceId}/agents/${principalId}`,
        {
            headers,
            data: {
                permissions: [
                    { actionClass: "read", resource: "*" },
                    { actionClass: "write", resource: "*" },
                ],
            },
        },
    );
    expect(bindingResponse.status(), await bindingResponse.text()).toBe(200);

    await ensureAgentWorkspaceBinding(workspaceId);
    await waitForControlPlaneAgentReady(request, headers);
    seedPage(page, { authToken: auth.accessToken, workspaceId, headers });
    await page.goto(`/workspace/${workspaceId}`, { waitUntil: "load" });
    await page.getByTestId("workspace-create-session").click();
    const agentSelect = page.getByTestId("workspace-agent-principal-select");
    await expect(agentSelect).toBeVisible();
    await agentSelect.selectOption({ index: 1 });
    const sessionCreatedPromise = page.waitForResponse(
        (response) =>
            response.url().endsWith("/api/v1/sessions") && response.request().method() === "POST",
    );
    await page.getByTestId("workspace-create-agent-session").click();
    const sessionCreated = await sessionCreatedPromise;
    expect([200, 201], await sessionCreated.text()).toContain(sessionCreated.status());
    const sessionBody = (await sessionCreated.json()) as { id?: string; sessionId?: string };
    const sessionId = sessionBody.id ?? sessionBody.sessionId ?? "";
    expect(sessionId).not.toBe("");
    const sessionDetails = await request.get(`${CP_URL}/api/v1/sessions/${sessionId}`, { headers });
    expect(sessionDetails.ok(), await sessionDetails.text()).toBe(true);
    expect(((await sessionDetails.json()) as { agentPrincipalId: string }).agentPrincipalId).toBe(
        principalId,
    );
    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 20_000 });

    const fileName = `t3-2-provenance-${Date.now().toString(36)}.txt`;
    const content = `durable Run and ToolCall verified ${randomUUID()}`;
    const marker = `XIHE-E2E-WRITE ${fileName} ${content}`;
    const chatPostPromise = page.waitForResponse(
        (response) =>
            response.url().endsWith("/api/v1/chat") && response.request().method() === "POST",
    );
    await page.getByTestId("chat-input").fill(marker);
    await page.getByTestId("chat-send-button").click();
    const chatPost = await chatPostPromise;
    expect(chatPost.status(), await chatPost.text()).toBe(202);
    const runId = ((await chatPost.json()) as { runId: string }).runId;
    expect(runId).toBeTruthy();

    const approvalModal = page.getByTestId("modal-content");
    await expect(approvalModal).toBeVisible({ timeout: 120_000 });
    await expect(approvalModal).toContainText("write_file");
    await expect(approvalModal).toContainText(fileName);
    await page.screenshot({ path: testInfo.outputPath("mcp-durable-call-approval.png") });
    await approvalModal.getByTestId("approval-approve").click();
    await expect(approvalModal).toBeHidden({ timeout: 20_000 });

    const runRoot = process.env.XIHE_E2E_RUN_ID;
    if (!runRoot) throw new Error("XIHE_E2E_RUN_ID is required for isolated file assertions");
    const hostFile = path.resolve(
        process.cwd(),
        "../../.tmp/e2e-host",
        runRoot,
        workspaceId,
        fileName,
    );
    await expect
        .poll(
            () => {
                try {
                    return readFileSync(hostFile, "utf8");
                } catch {
                    return "";
                }
            },
            { timeout: 90_000, message: `approved Runtime write did not land at ${hostFile}` },
        )
        .toBe(content);
    await expect(page.getByText(fileName, { exact: true }).first()).toBeVisible({
        timeout: 30_000,
    });
    await page.screenshot({ path: testInfo.outputPath("mcp-durable-call-result.png") });

    const invocationResponse = await request.get(
        `${CP_URL}/api/v1/audit/entries?type=mcp_invocation&workspaceId=${workspaceId}&size=50`,
        { headers },
    );
    expect(invocationResponse.ok(), await invocationResponse.text()).toBe(true);
    const invocations = (await invocationResponse.json()) as {
        entries: Array<{
            id: string;
            runId: string;
            sessionId: string;
            workspaceId: string;
            source: string;
            summary: string;
            status: string;
            toolCallId?: string;
        }>;
    };
    const invocation = invocations.entries.find((item) => item.runId === runId);
    expect(invocation).toMatchObject({
        runId,
        sessionId,
        workspaceId,
        source: "agent",
        summary: "write_file",
    });
    expect(invocation?.toolCallId).toBeTruthy();
    const detailResponse = await request.get(
        `${CP_URL}/api/v1/audit/entries/mcp_invocation/${invocation!.id}`,
        { headers },
    );
    expect(detailResponse.ok(), await detailResponse.text()).toBe(true);
    const detail = (await detailResponse.json()) as {
        attempts: Array<{ stage: string; status: string }>;
    };
    expect(detail.attempts).toEqual(
        expect.arrayContaining([
            expect.objectContaining({ stage: "agent_tool", status: "succeeded" }),
            expect.objectContaining({ stage: "cp_forward", status: "succeeded" }),
        ]),
    );

    const cpGateApprovals = Number(
        queryIsolatedPostgres(
            `SELECT count(*) FROM approval_requests WHERE session_id = '${sessionId}'::uuid AND origin = 'cp_gate'`,
        ),
    );
    expect(cpGateApprovals).toBe(1);
});
