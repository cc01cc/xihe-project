// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
import { randomUUID } from "node:crypto";
import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { CP_URL } from "./journey";
import { seedUserGrantPermissions, standardWorkspaceUserPermissions } from "./user-grants";

import { AGENT_NAME_PATTERN } from "./agent-name";
import { chooseRekaOption } from "./reka-select";
import { LONG_TIMEOUT_MS } from "../../timeouts";

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * BL-547（task-175）：reka Select 的选项只以可见文本渲染（reka SelectItem 不出
 * data-value），按 principalId 选不了项。从页面 localStorage 取 token，经列表端点
 * 反查 principal 名，供 chooseRekaOption 按 "agent.name · templateName" 文本匹配。
 */
async function resolvePrincipalNameForPicker(page: Page, principalId: string): Promise<string> {
    const token = await page.evaluate(() => localStorage.getItem("xihe-token") ?? "");
    expect(
        token,
        "resolvePrincipalNameForPicker needs xihe-token (installAuth first)",
    ).toBeTruthy();
    const res = await page.request.get(CP_URL + "/api/v1/agent-principals", {
        headers: { Authorization: "Bearer " + token },
    });
    expect(res.ok(), await res.text()).toBe(true);
    const body = (await res.json()) as {
        principals?: Array<{ id?: string; principalId?: string; name?: string }>;
    };
    const hit = (body.principals ?? []).find((p) => (p.id ?? p.principalId) === principalId);
    expect(hit?.name, "principal " + principalId + " must be listed for the caller").toBeTruthy();
    return hit!.name!;
}

/** 按 id 在 reka 工作区 agent 选择器里点选项（选项文本 = "agent.name · templateName"）。 */
export async function chooseWorkspacePrincipalById(
    page: Page,
    trigger: Locator,
    principalId: string,
): Promise<void> {
    const name = await resolvePrincipalNameForPicker(page, principalId);
    await chooseRekaOption(page, trigger, new RegExp(escapeRegExp(name)));
}
type AgentAuth = { accessToken: string; workspaceId: string };
/** GET /api/v1/provider-connections 的 connections[] 元素里本夹具用到的字段。 */
type ProviderConnectionRow = {
    id: string;
    providerId: string;
    connectionKey: string;
    status?: string;
    enabled?: boolean;
};
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
type SessionOptions = {
    principalId: string;
    title: string;
    /**
     * task-174：显式钉定建会话用的 provider 连接与模型身份（PLAN-0438：模型身份 =
     * connectionId + modelId，SessionService.bindApiTemplate:505 对显式连接强制
     * requireModel ⇒ modelName 必须同批给）。G2 创建门把「多条 READY 候选」显式化为
     * 400 PROVIDER_CONNECTION_AMBIGUOUS 并提示 pass providerConnectionId explicitly；
     * 三个字段均可选透传，不传 = 逐字节旧行为（隐式解析）。
     */
    providerConnectionId?: string;
    modelProvider?: string;
    modelName?: string;
    /**
     * PLAN-0601 显式绑定（可选）：POST /api/v1/sessions 的 binding 字段，满足
     * `ApiRequestTemplateService.admissionSnapshot` —— 不传则**裸会话**，agent dispatch 会
     * 409 `API_TYPE_REBIND_REQUIRED`。字段名即 wire 名（providerConnectionId/modelProvider/modelName/
     * contextTemplateLayer/Id/Version）。
     */
    binding?: {
        providerConnectionId: string;
        modelProvider: string;
        modelName: string;
        contextTemplateLayer: string;
        contextTemplateId: string;
        contextTemplateVersion: number;
    };
};

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
/**
 * task-158：为「当前 token 的消费用户」补齐一条 USER 层的默认 fake 连接。
 *
 * 为什么需要（实测机制，不是猜）：mock 车道 runner 只写 **instance 层** profile
 * `{providerId: openai, connectionKey: default, model: mock}`（`scripts/e2e-host.mjs`
 * configureFakeLlm 分支），而 `ConfigService.strictResolveConnection` 对
 * `profileScope ∈ {user, instance}` 一律要求 **消费用户自己** 有一条
 * `OWNER_USER + userId + providerId + connectionKey` 且 READY 的连接
 * （`ConfigService.java:1204-1217`）。spec 里新注册的用户天然没有连接 ⇒ 建会话
 * 409 `LLM_PROFILE_CONFLICT`（证据：task-158 诊断，建连接前后同一调用 409→201）。
 *
 * 幂等：已有同 providerId+connectionKey 的 READY 连接时直接复用；否则 verify 到 READY。
 */
export async function ensureUserDefaultFakeConnection(
    request: APIRequestContext,
    auth: AgentAuth,
): Promise<void> {
    const headers: Record<string, string> = {
        Authorization: `Bearer ${auth.accessToken}`,
        "Content-Type": "application/json",
    };
    if (auth.workspaceId) headers["X-Workspace-Id"] = auth.workspaceId;
    const list = await request.get(`${CP_URL}/api/v1/provider-connections`, { headers });
    expect(list.ok(), await list.text()).toBe(true);
    const rows =
        ((await list.json()) as { connections?: ProviderConnectionRow[] }).connections ?? [];
    const found = rows.find(
        (row) => row.providerId === "openai" && row.connectionKey === "default",
    );
    if (found?.status === "READY" && found.enabled !== false) return;
    let connection = found;
    if (!connection) {
        const fakeLlmPort = process.env.XIHE_FAKE_LLM_PORT;
        if (!fakeLlmPort) {
            throw new Error(
                "ensureUserDefaultFakeConnection needs XIHE_FAKE_LLM_PORT (the host runner provides it)",
            );
        }
        const created = await request.post(`${CP_URL}/api/v1/provider-connections`, {
            headers,
            data: {
                providerId: "openai",
                apiTypeId: "openai-chat-completions",
                apiTypeVersion: 1,
                apiKey: "sk-fake-openai-key",
                connectionKey: "default",
                label: "e2e default fake connection (USER)",
                scope: "USER",
                modelDiscovery: "manual",
                // 解析只看 providerId+connectionKey；mock 车道 profile.model 是 "mock"，
                // write_file 车道是 "fake-openai" —— 两个都登记，聊天选模型时才不会空。
                manualModels: ["mock", "fake-openai"],
                baseUrl: `http://127.0.0.1:${fakeLlmPort}/openai/v1`,
            },
        });
        expect(created.ok(), await created.text()).toBe(true);
        connection = (await created.json()) as ProviderConnectionRow;
    }
    const verified = await request.post(
        `${CP_URL}/api/v1/provider-connections/${connection.id}/verify`,
        { headers },
    );
    expect(verified.ok(), await verified.text()).toBe(true);
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
    // PLAN-0661: CP 对不合法主体名回答 400 INVALID_NAME_FORMAT；夹具名先在本层 fail-fast，
    // 免得错误在 agent 流程深处才冒出来（新夹具名一律用 agentName() 生成）。
    if (!AGENT_NAME_PATTERN.test(name)) {
        throw new Error(
            `provisionWorkspaceAgentPrincipal: invalid agent principal name ${JSON.stringify(name)}`,
        );
    }
    if (!auth.workspaceId) {
        throw new Error(
            "provisionWorkspaceAgentPrincipal requires a workspace; call ensureWorkspace() first",
        );
    }
    // task-158：建 principal 的用户必须自己有一条 key=default 的 USER 连接，否则后续建会话 409。
    await ensureUserDefaultFakeConnection(request, auth);
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
            // BL-343：D-174（`51d3fa95`）起 create 的 body 白名单不再收 `scope`
            // （"body 去 scope，旧值 400，无兼容分支"）；主体归属改由**工作区上下文**
            // （上面的 `X-Workspace-Id`）表达。这里既不送 `scope`，也不做"兼容旧值"分支——
            // 契约变了就在夹具侧同步，而不是放宽断言。
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
    {
        principalId,
        title,
        workspaceId,
        binding,
        providerConnectionId,
        modelProvider,
        modelName,
    }: SessionOptions & { workspaceId?: string },
): Promise<string> {
    const url = workspaceId
        ? `${CP_URL}/api/v1/workspaces/${workspaceId}/sessions`
        : `${CP_URL}/api/v1/sessions`;
    const headers: Record<string, string> = { Authorization: `Bearer ${auth.accessToken}` };
    if (workspaceId) headers["X-Workspace-Id"] = workspaceId;
    // task-158：兜底保证「用它自己的 token 建会话的这个用户」有一条 key=default 的 USER 连接。
    await ensureUserDefaultFakeConnection(request, auth);
    const response = await request.post(url, {
        headers,
        data: {
            title,
            agentPrincipalId: principalId,
            // 有绑定才带（不传 ⇒ 与旧行为逐字节一致）。
            ...(binding ? binding : {}),
            // task-174：有显式模型身份才带（同上，缺席 = 隐式解析旧行为）。
            ...(providerConnectionId ? { providerConnectionId } : {}),
            ...(modelProvider ? { modelProvider } : {}),
            ...(modelName ? { modelName } : {}),
        },
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
        timeout: LONG_TIMEOUT_MS,
    });
}

export async function createWorkspaceSessionWithPrincipal(
    page: Page,
    principalId: string,
): Promise<string> {
    await openAgentSessionSelector(page);
    const principalSelect = page.getByTestId("workspace-agent-principal-select");
    // BL-547（task-175）：reka Select —— 按 id 反查名字后点选项（见 resolvePrincipalNameForPicker）。
    await chooseWorkspacePrincipalById(page, principalSelect, principalId);

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
