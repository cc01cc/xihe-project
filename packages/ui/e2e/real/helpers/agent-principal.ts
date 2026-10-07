import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { CP_URL } from "./journey";

type AgentAuth = { accessToken: string; workspaceId: string };
type ToolAction = "read" | "write";
type PrincipalOptions = { name: string; actions?: ToolAction[] };
type SessionOptions = { principalId: string; title: string };

function seedPrincipalManagementGrant(
    userId: string,
    workspaceId: string,
    actions: ToolAction[],
): void {
    const container = process.env.XIHE_E2E_PG_CONTAINER;
    const database = process.env.XIHE_E2E_PG_DATABASE;
    const dbUser = process.env.XIHE_E2E_PG_USER;
    if (!container || !database || !dbUser) {
        throw new Error(
            "isolated PostgreSQL fixture metadata is unavailable; run through e2e-host",
        );
    }

    const permissions = JSON.stringify([
        { actionClass: "CREATE_ACCOUNT", resource: "*" },
        { actionClass: "CREATE_TEMPLATE", resource: "*" },
        { actionClass: "MANAGE_WORKSPACE_AGENTS", resource: workspaceId },
        ...actions.map((actionClass) => ({ actionClass, resource: "*" })),
    ]).replace(/'/g, "''");
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

export async function provisionWorkspaceAgentPrincipal(
    request: APIRequestContext,
    auth: AgentAuth,
    { name, actions = ["read"] }: PrincipalOptions,
): Promise<string> {
    const headers = {
        Authorization: `Bearer ${auth.accessToken}`,
        "Content-Type": "application/json",
    };
    const me = await request.get(`${CP_URL}/api/v1/auth/me`, { headers });
    expect(me.ok(), await me.text()).toBe(true);
    const { id: userId } = (await me.json()) as { id: string };
    seedPrincipalManagementGrant(userId, auth.workspaceId, actions);

    const roleId = randomUUID();
    const templateId = randomUUID();
    const toolPermissions = actions.map((actionClass) => ({ actionClass, resource: "*" }));
    const template = await request.put(`${CP_URL}/api/v1/config/user/agent-templates`, {
        headers,
        data: {
            roles: JSON.stringify([
                { id: roleId, name: `${name} Role`, permissions: toolPermissions },
            ]),
            templates: JSON.stringify([
                {
                    id: templateId,
                    name,
                    description: "Isolated Agent principal fixture for host E2E",
                    systemPrompt: "Use only the Workspace tools provided by CP.",
                    toolMode: "workspace",
                    provider: "openai",
                    model: "fake-openai",
                    roleId,
                },
            ]),
        },
    });
    expect(template.status(), await template.text()).toBe(200);

    const created = await request.post(`${CP_URL}/api/v1/agent-principals`, {
        headers,
        data: { name, templateId },
    });
    expect(created.status(), await created.text()).toBe(201);
    const { principalId } = (await created.json()) as { principalId: string };

    const bound = await request.put(
        `${CP_URL}/api/v1/workspaces/${auth.workspaceId}/agents/${principalId}`,
        {
            headers,
            data: { permissions: toolPermissions },
        },
    );
    expect(bound.status(), await bound.text()).toBe(200);
    return principalId;
}

export async function createSessionWithPrincipal(
    request: APIRequestContext,
    auth: AgentAuth,
    { principalId, title }: SessionOptions,
): Promise<string> {
    const response = await request.post(`${CP_URL}/api/v1/sessions`, {
        headers: { Authorization: `Bearer ${auth.accessToken}` },
        data: { title, agentPrincipalId: principalId },
    });
    expect(response.status(), await response.text()).toBe(201);
    const body = (await response.json()) as { id?: string; sessionId?: string };
    const id = body.id ?? body.sessionId;
    expect(id, "session id must be returned").toBeTruthy();
    return id as string;
}

export async function createWorkspaceSessionWithPrincipal(
    page: Page,
    principalId: string,
): Promise<string> {
    await page.getByTestId("workspace-create-session").click();
    const principalSelect = page.getByTestId("workspace-agent-principal-select");
    await expect(principalSelect).toBeVisible();
    await principalSelect.selectOption(principalId);

    const responsePromise = page.waitForResponse(
        (response) =>
            response.url().endsWith("/api/v1/sessions") && response.request().method() === "POST",
    );
    await page.getByTestId("workspace-create-agent-session").click();
    const response = await responsePromise;
    expect(response.status(), await response.text()).toBe(201);
    const body = (await response.json()) as { id?: string; sessionId?: string };
    const sessionId = body.id ?? body.sessionId;
    expect(sessionId, "session id must be returned").toBeTruthy();
    await expect(page.getByTestId("chat-input")).toBeVisible();
    return sessionId as string;
}
