import { randomUUID } from "node:crypto";
import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { CP_URL } from "./journey";
import { seedUserGrantPermissions, standardWorkspaceUserPermissions } from "./user-grants";

type AgentAuth = { accessToken: string; workspaceId: string };
type ToolAction = "read" | "write";
type PrincipalOptions = {
    name: string;
    actions?: ToolAction[];
    systemPrompt?: string;
    /**
     * PLAN-0623：模型意图。**可选** —— 不传时请求体与改动前完全一致（既有 24 个调用点
     * 行为不变）。参与者视图的 `defaultModelProvider/Name` 直接取自 principal，所以需要
     * "AGENT 行有模型段"的场景必须显式给值；不给值时 UI 会（正确地）不渲染模型段。
     */
    defaultModelProvider?: string;
    defaultModelName?: string;
};
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
    {
        name,
        actions = ["read"],
        systemPrompt = DEFAULT_SYSTEM_PROMPT,
        defaultModelProvider,
        defaultModelName,
    }: PrincipalOptions,
): Promise<string> {
    const headers = {
        Authorization: `Bearer ${auth.accessToken}`,
        "Content-Type": "application/json",
        // D21: WORKSPACE-scope principal creation requires an explicit workspace context.
        "X-Workspace-Id": auth.workspaceId,
    };
    // PLAN-0614: fail fast when the caller forgot `ensureWorkspace()`. Passing a null workspace
    // would seed a grant row with `resource = null`, and the real failure would surface much later
    // (workspace-scoped 404/403 deep inside the agent flow) instead of here.
    if (!auth.workspaceId) {
        throw new Error(
            "provisionWorkspaceAgentPrincipal requires a workspace; call ensureWorkspace() first",
        );
    }
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
        data: {
            name,
            templateId,
            scope: "WORKSPACE",
            // 只在调用方显式给了模型意图时才带上这两个键（不传 ⇒ 体与旧行为一致）。
            ...(defaultModelProvider ? { defaultModelProvider } : {}),
            ...(defaultModelName ? { defaultModelName } : {}),
        },
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

/**
 * 建会话。
 *
 * **0623 起**：多工作区账号上无工作区上下文的 `POST /api/v1/sessions` 会 409
 * `WORKSPACE_CONTEXT_REQUIRED`（产品刻意拒绝歧义，不猜"恰好第一个工作区"）。
 *
 * 传 `workspaceId` 时走**路径形式** `POST /api/v1/workspaces/{id}/sessions` 并同时带
 * `X-Workspace-Id`（路径与头一致，双保险；UI 的 `createSessionForWorkspace` 也用路径形式）。
 * 不传时保持旧行为，既有 0622 spec 不受影响。
 */
export async function createSessionWithPrincipal(
    request: APIRequestContext,
    auth: AgentAuth,
    { principalId, title, workspaceId }: SessionOptions & { workspaceId?: string },
): Promise<string> {
    const url = workspaceId
        ? `${CP_URL}/api/v1/workspaces/${workspaceId}/sessions`
        : `${CP_URL}/api/v1/sessions`;
    const headers: Record<string, string> = { Authorization: `Bearer ${auth.accessToken}` };
    if (workspaceId) headers["X-Workspace-Id"] = workspaceId;
    const response = await request.post(url, {
        headers,
        data: { title, agentPrincipalId: principalId },
    });
    expect(response.status(), await response.text()).toBe(201);
    const body = (await response.json()) as { id?: string; sessionId?: string },
        id = body.id ?? body.sessionId;
    expect(id, "session id must be returned").toBeTruthy();
    return id as string;
}

async function isVisible(locator: Locator): Promise<boolean> {
    return locator.isVisible().catch(() => false);
}

/**
 * 失败时把"当前页面处于哪个分支"写进报错。之前 S2 只看到 `locator.click: Test timeout`
 * （等 `workspace-create-session` 180s），无法判断是"已有会话"还是"入口换了"。
 */
async function describeSessionCreationState(page: Page): Promise<string> {
    const emptyStateButton = await page.getByTestId("workspace-create-session").count();
    const agentSelect = await page.getByTestId("workspace-agent-principal-select").count();
    return (
        `agent session creation did not reach the selector: url=${page.url()} ` +
        `emptyStateCreateButton=${emptyStateButton} agentSelect=${agentSelect}`
    );
}

/**
 * 真实用户入口是「新建对话」（`?newChat=1`）——`WorkspaceView` 看到该 query 就自己调用
 * `createSessionForWorkspace()` 打开 agent 选择器。
 *
 * 不能点 `workspace-create-session`：那是**空态**按钮（`WorkspaceView.vue` 的 `v-else` 分支），
 * 而 `sessionId` 只要 store 里有当前会话就为真（`WorkspaceView.vue` 的 computed），此时按钮根本
 * 不渲染 —— S2 曾因此干等 180s 超时。
 */
/**
 * 打开「选择 Agent」选择器（真实入口：新建对话 → `?newChat=1` → WorkspaceView 自己 pop）。
 * 幂等：选择器已经可见时什么都不做。
 */
export async function openAgentSessionSelector(page: Page): Promise<void> {
    const principalSelect = page.getByTestId("workspace-agent-principal-select");
    // `?newChat=1` 的 watcher 可能已经打开了选择器，此时不要再点入口（重复点击会重置已选值）。
    if (!(await isVisible(principalSelect))) {
        const desktopEntry = page.getByTestId("sidebar-new-chat");
        const mobileEntry = page.getByTestId("workspace-toolbar-new-chat-mobile");
        if (await isVisible(desktopEntry)) {
            await desktopEntry.click();
        } else if (await isVisible(mobileEntry)) {
            await mobileEntry.click();
        } else {
            throw new Error(
                `no new-chat entry point is visible: ${await describeSessionCreationState(page)}`,
            );
        }
    }
    await expect(principalSelect, await describeSessionCreationState(page)).toBeVisible({
        timeout: 30000,
    });
}

export async function createWorkspaceSessionWithPrincipal(
    page: Page,
    principalId: string,
): Promise<string> {
    await openAgentSessionSelector(page);
    const principalSelect = page.getByTestId("workspace-agent-principal-select");
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
