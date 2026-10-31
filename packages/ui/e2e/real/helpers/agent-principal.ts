import { randomUUID } from "node:crypto";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { CP_URL } from "./journey";
import { seedUserGrantPermissions, standardWorkspaceUserPermissions } from "./user-grants";

type AgentAuth = { accessToken: string; workspaceId: string };
type ToolAction = "read" | "write";
type PrincipalOptions = { name: string; actions?: ToolAction[]; systemPrompt?: string };
type SessionOptions = { principalId: string; title: string };

const DEFAULT_SYSTEM_PROMPT = "Use only the Workspace tools provided by CP.";

function seedPrincipalManagementGrant(
    userId: string,
    workspaceId: string,
    actions: ToolAction[],
): void {
    // V64/V65: one direct grant row per subject — merge into the existing row
    // (the journey user may already carry a spec-seeded direct grant).
    seedUserGrantPermissions(userId, [
        ...standardWorkspaceUserPermissions(workspaceId),
        ...actions.map((actionClass) => ({ actionClass, resource: "*" })),
    ]);
}

/**
 * PLAN-0608 C′: session creation now has TWO surfaces —
 * `POST /api/v1/sessions` (legacy header-only) and
 * `POST /api/v1/workspaces/{workspaceId}/sessions` (path form, what the UI sends).
 * Matching only the legacy path made every `waitForResponse`/`waitForRequest`
 * around a UI-created session hang until timeout, so all e2e matchers go through
 * this single predicate instead of `url().endsWith("/api/v1/sessions")`.
 */
export function isSessionCreateRequest(url: string, method: string): boolean {
    if (method !== "POST") return false;
    return /^\/api\/v1\/(workspaces\/[^/]+\/)?sessions$/.test(new URL(url).pathname);
}
export async function provisionWorkspaceAgentPrincipal(
    request: APIRequestContext,
    auth: AgentAuth,
    { name, actions = ["read"], systemPrompt = DEFAULT_SYSTEM_PROMPT }: PrincipalOptions,
): Promise<string> {
    const headers = {
        Authorization: `Bearer ${auth.accessToken}`,
        "Content-Type": "application/json",
    };
    const me = await request.get(`${CP_URL}/api/v1/auth/me`, { headers });
    expect(me.ok(), await me.text()).toBe(true);
    const { id: userId } = (await me.json()) as { id: string };
    seedPrincipalManagementGrant(userId, auth.workspaceId, actions);

    const roleId = randomUUID(),
        templateId = randomUUID();
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
                    systemPrompt,
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
    const body = (await response.json()) as { id?: string; sessionId?: string },
        id = body.id ?? body.sessionId;
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

    const responsePromise = page.waitForResponse((response) =>
        isSessionCreateRequest(response.url(), response.request().method()),
    );
    await page.getByTestId("workspace-create-agent-session").click();
    const response = await responsePromise;
    expect(response.status(), await response.text()).toBe(201);
    const body = (await response.json()) as { id?: string; sessionId?: string },
        sessionId = body.id ?? body.sessionId;
    expect(sessionId, "session id must be returned").toBeTruthy();
    await expect(page.getByTestId("chat-input")).toBeVisible();
    return sessionId as string;
}
