/**
 * task-165 · mock lane 的实例层三资源（`/api/v1/instance/{credentials,agent-principals,mcp}`）。
 *
 * <p><b>task-38 修正</b>：智能体段原本写成 `/instance/agents`，而契约与 CP 都是
 * `/instance/agent-principals`（`openapi.yaml:4876`）。夹具当时也有那份错路径 ⇒ mock 绿、真栈 404。
 * 现在夹具与 `services/instanceResources.ts` 用同一条契约路径，且用
 * `__tests__/instanceResources.contract.spec.ts` 对着 yaml 断言。</p>
 *
 * <p><b>为什么把状态与判定放在这里而不是塞进 `api-server.ts`</b>：`api-server.ts` 已经 1000+ 行
 * 的 if 链，再往里加 13 条端点的分支只会让「mock 到底支持哪些路径」更难读。这里收成一张
 * 「路径 → 结果」的纯函数，`api-server` 只留一次 dispatch；顺带可以在单测里直接跑它验
 * （见 `__tests__/instanceResources.mock.spec.ts`）。</p>
 *
 * <p><b>状态是可变的**内存集合**</b>：新建/删除/PATCH 真的改数组 —— 否则拍图时点「创建」后
 * 列表不变，等于把「假保真」拍进交付图（task-146 的旧账）。进程内单例，dev server 重启即复位。</p>
 *
 * <p><b>不校验业务规则</b>：这里只做形状与状态码，不复制 CP 的授权/唯一性/引用约束。
 * mock lane 的职责是「让真组件拿到真形状的数据」，不是第二套后端。</p>
 */

export interface MockInstanceCredential {
    id: string;
    label: string;
    kind: "token" | "key_pair";
    deliveryTier: "lease" | "reveal";
    status: "active" | "disabled";
    fingerprint: string;
    revision: number;
    createdAt: string;
    replacedAt: string | null;
    referenceCount: number;
}

export interface MockInstanceAgent {
    principalId: string;
    name: string;
    description: string | null;
    templateId: string | null;
    templateName: string | null;
    defaultModelProvider: string | null;
    defaultModelName: string | null;
    /** task-401：契约 `AgentPrincipalCreateRequest.allowedModels`；null = 不限制。 */
    allowedModels: Array<{ provider: string; model: string }> | null;
    createdAt: string;
    disabled: boolean;
}

export interface MockInstanceMcpServer {
    id: string;
    name: string;
    transport: "http" | "sse" | "stdio";
    url: string;
    enabled: boolean;
    credentialId: string | null;
    createdAt: string;
}

/**
 * task-430：创建面白名单与名字格式**照契约**（openapi `AgentPrincipalCreateRequest`）。
 * 真 HTTP 实测（stack-1，2026-11-14 02:35）：多带 description ⇒ 400 INVALID_REQUEST；
 * 名字带连字符 ⇒ 400 INVALID_NAME_FORMAT。夹具此前照单全收 ⇒ mock 绿掩盖真栈 400。
 */
const CREATE_KEYS = new Set([
    "name",
    "templateId",
    "roleIds",
    "defaultModelProvider",
    "defaultModelName",
    "allowedModels",
    "hooks",
]);
const NAME_PATTERN = /^[A-Za-z\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff]*$/;

const credentials: MockInstanceCredential[] = [
    {
        id: "8831a1f5-0c6d-4a2e-9a11-2b1d7f000001",
        label: "内部 MCP 网关",
        kind: "token",
        deliveryTier: "lease",
        status: "active",
        fingerprint: "sha256:9f2c…a41d",
        revision: 3,
        createdAt: "2026-10-28T02:14:00Z",
        replacedAt: "2026-11-04T07:41:00Z",
        referenceCount: 2,
    },
    {
        id: "8831a1f5-0c6d-4a2e-9a11-2b1d7f000002",
        label: "观测平台读写",
        kind: "key_pair",
        deliveryTier: "reveal",
        status: "active",
        fingerprint: "sha256:1b70…e09c",
        revision: 1,
        createdAt: "2026-11-02T09:05:00Z",
        replacedAt: null,
        referenceCount: 0,
    },
];

const agents: MockInstanceAgent[] = [
    {
        principalId: "a1f0c4d2-7b3e-4c55-8f10-5d2c9b000001",
        name: "代码评审助手",
        description: "全平台默认可用：按仓库规范审 diff，输出可执行的修改建议。",
        templateId: "tpl-code-review",
        templateName: "代码评审",
        defaultModelProvider: "anthropic",
        defaultModelName: "claude-sonnet-4.5",
        allowedModels: null,
        createdAt: "2026-10-21T03:22:00Z",
        disabled: false,
    },
    {
        principalId: "a1f0c4d2-7b3e-4c55-8f10-5d2c9b000002",
        name: "需求拆解助手",
        description: "把需求文档拆成可验收的任务清单，供各工作区直接引用。",
        templateId: null,
        templateName: null,
        defaultModelProvider: "openai",
        defaultModelName: "gpt-5.1",
        allowedModels: null,
        createdAt: "2026-11-05T06:40:00Z",
        disabled: false,
    },
];

const servers: MockInstanceMcpServer[] = [
    {
        id: "6b9d2e88-3f44-4d21-9c07-7a1e4c000001",
        name: "internal-docs",
        transport: "http",
        url: "https://mcp.internal.example.com/docs",
        enabled: true,
        credentialId: "8831a1f5-0c6d-4a2e-9a11-2b1d7f000001",
        createdAt: "2026-10-30T01:10:00Z",
    },
    {
        id: "6b9d2e88-3f44-4d21-9c07-7a1e4c000002",
        name: "metric-query",
        transport: "sse",
        url: "https://mcp.internal.example.com/metrics/sse",
        enabled: false,
        credentialId: null,
        createdAt: "2026-11-06T08:55:00Z",
    },
];

export interface InstanceMockResult {
    status: number;
    body: unknown;
}

function notFound(code: string): InstanceMockResult {
    return {
        status: 404,
        body: {
            type: "about:blank",
            title: "Not Found",
            status: 404,
            code,
            requestId: "mock-request",
        },
    };
}

function badRequest(code: string, field?: string): InstanceMockResult {
    return {
        status: 400,
        body: {
            type: "about:blank",
            title: "Bad Request",
            status: 400,
            code,
            ...(field ? { field } : {}),
            requestId: "mock-request",
        },
    };
}

function str(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function nextId(prefix: string, index: number): string {
    return `${prefix}-mock-${String(index).padStart(4, "0")}`;
}

/**
 * 单条路径的 mock 判定。返回 `null` ⇒ 不是本模块的路径（交回 `api-server` 的后续分支）。
 *
 * `readBody` 是**惰性**的：GET/DELETE 不该去读请求体（读了在 keep-alive 连接上会等待）。
 */
export async function handleInstanceResource(
    method: string,
    path: string,
    readBody: () => Promise<Record<string, unknown>>,
): Promise<InstanceMockResult | null> {
    const upper = method.toUpperCase();

    if (path === "/instance/credentials") {
        if (upper === "GET")
            return { status: 200, body: { credentials, count: credentials.length } };
        if (upper === "POST") {
            const body = await readBody();
            const label = str(body.label).trim();
            if (!label) return badRequest("LABEL_REQUIRED", "label");
            const kind = body.kind === "key_pair" ? "key_pair" : "token";
            const created: MockInstanceCredential = {
                id: nextId("cred", credentials.length + 1),
                label,
                kind,
                deliveryTier: body.deliveryTier === "reveal" ? "reveal" : "lease",
                status: "active",
                fingerprint: `sha256:${(credentials.length + 1).toString(16).repeat(4)}…mock`,
                revision: 1,
                createdAt: new Date().toISOString(),
                replacedAt: null,
                referenceCount: 0,
            };
            credentials.push(created);
            return { status: 201, body: created };
        }
        return null;
    }

    const credentialId = path.match(/^\/instance\/credentials\/([^/]+)$/);
    if (credentialId) {
        const id = decodeURIComponent(credentialId[1] ?? "");
        const index = credentials.findIndex((item) => item.id === id);
        if (index < 0) return notFound("CREDENTIAL_NOT_FOUND");
        if (upper === "PATCH") {
            const body = await readBody();
            const current = credentials[index] as MockInstanceCredential;
            const updated: MockInstanceCredential = {
                ...current,
                ...(str(body.label).trim() ? { label: str(body.label).trim() } : {}),
                ...(body.status === "disabled" || body.status === "active"
                    ? { status: body.status }
                    : {}),
            };
            credentials.splice(index, 1, updated);
            return { status: 200, body: updated };
        }
        if (upper === "DELETE") {
            credentials.splice(index, 1);
            return { status: 204, body: null };
        }
        return null;
    }

    const reveal = path.match(/^\/instance\/credentials\/([^/]+)\/reveal$/);
    if (reveal && upper === "POST") {
        const id = decodeURIComponent(reveal[1] ?? "");
        const credential = credentials.find((item) => item.id === id);
        if (!credential) return notFound("CREDENTIAL_NOT_FOUND");
        const body = await readBody();
        if (!str(body.password)) return badRequest("STEP_UP_REQUIRED", "password");
        // 明文只在响应里出现一次；这里给的是**形状**，不是任何真实密钥。
        return {
            status: 200,
            body:
                credential.kind === "key_pair"
                    ? {
                          id: credential.id,
                          label: credential.label,
                          kind: credential.kind,
                          accessKey: "AKIA-MOCK-EXAMPLE",
                          secretKey: "mock-secret-value-not-a-real-key",
                      }
                    : {
                          id: credential.id,
                          label: credential.label,
                          kind: credential.kind,
                          token: "mock-token-value-not-a-real-token",
                      },
        };
    }

    // task-38（R1）：路径以契约为准（openapi.yaml:4876）；响应信封按 `AgentPrincipalListResponse`
    // 给 `principals`（CP `InstanceAgentPrincipalController.list` 实测也是 `{principals}`）。
    // 夹具若继续用 `/instance/agents` + `{agents}`，就会一边掩盖 404、一边掩盖信封漂移。
    if (path === "/instance/agent-principals") {
        if (upper === "GET")
            return { status: 200, body: { principals: agents, count: agents.length } };
        if (upper === "POST") {
            const body = await readBody();
            // task-430：白名单照契约（多一键就 400，与真 CP 同口径）。
            const foreign = Object.keys(body).filter((key) => !CREATE_KEYS.has(key));
            if (foreign.length > 0) {
                return badRequest(
                    "INVALID_REQUEST",
                    "Body must contain name plus optional templateId, defaultModelProvider, " +
                        "defaultModelName, allowedModels, hooks and roleIds only",
                );
            }
            const name = str(body.name).trim();
            if (!name) return badRequest("NAME_REQUIRED", "name");
            if (!NAME_PATTERN.test(name)) return badRequest("INVALID_NAME_FORMAT", "name");
            const created: MockInstanceAgent = {
                principalId: nextId("agent", agents.length + 1),
                name,
                // 契约不收 description ⇒ 新建行恒 null（读面那个字段是另一笔账，见 task-430 报告）。
                description: null,
                templateId: str(body.templateId) || null,
                templateName: null,
                // task-401 / `D-1248`：创建面**已收**模型意图三字段（契约 6950 行，CP
                // `InstanceAgentPrincipalService#create` 透传）。夹具此前硬写 null ⇒ 选了模型
                // 也看不到，等于用 mock 掩盖「UI 没接线」这件事。现按 body 原样承载。
                defaultModelProvider: str(body.defaultModelProvider).trim() || null,
                defaultModelName: str(body.defaultModelName).trim() || null,
                allowedModels: Array.isArray(body.allowedModels)
                    ? body.allowedModels
                          .filter(
                              (item): item is Record<string, unknown> =>
                                  typeof item === "object" && item !== null,
                          )
                          .map((item) => ({
                              provider: str(item.provider).trim(),
                              model: str(item.model).trim(),
                          }))
                          .filter((item) => item.provider && item.model)
                    : null,
                createdAt: new Date().toISOString(),
                disabled: false,
            };
            agents.push(created);
            return { status: 201, body: created };
        }
        return null;
    }

    const agentId = path.match(/^\/instance\/agent-principals\/([^/]+)$/);
    if (agentId) {
        const id = decodeURIComponent(agentId[1] ?? "");
        const index = agents.findIndex((item) => item.principalId === id);
        if (index < 0) return notFound("AGENT_NOT_FOUND");
        if (upper === "PATCH") {
            const body = await readBody();
            // task-401 / `D-1248`：契约 `AgentPrincipalUpdateRequest` **只收 documents 三键**
            // （hooks / contextPolicy / delegationPolicy，`additionalProperties: false`、
            // `minProperties: 1`；CP 控制器走 `parseDocuments`）。夹具此前照单全收 name /
            // description / disabled ⇒ 一边掩盖真栈 400，一边让人以为实例层能改名改模型。
            // 现按契约拒绝；实例层的改名/改模型写面是 CP 缺口（task-413），不是 UI 缺口。
            // documents 本身不在本 lane 建模（无消费方），故合法请求回当前行。
            // task-401 编辑半：cp-1 `task-413`（dedd832a5）把模型意图三字段接进了同一个 PATCH。
            const documentKeys = new Set([
                "hooks",
                "contextPolicy",
                "delegationPolicy",
                "defaultModelProvider",
                "defaultModelName",
                "allowedModels",
            ]);
            const keys = Object.keys(body);
            const foreign = keys.find((key) => !documentKeys.has(key));
            if (keys.length === 0 || foreign !== undefined)
                return badRequest("INVALID_REQUEST", foreign);
            const current = agents[index] as MockInstanceAgent;
            // 模型三字段：present 替换 / absent 保留 / 显式 null 清除（契约语义）。
            const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);
            const updated: MockInstanceAgent = {
                ...current,
                ...(has("defaultModelProvider")
                    ? {
                          defaultModelProvider: str(body.defaultModelProvider).trim() || null,
                      }
                    : {}),
                ...(has("defaultModelName")
                    ? { defaultModelName: str(body.defaultModelName).trim() || null }
                    : {}),
                ...(has("allowedModels")
                    ? {
                          allowedModels: Array.isArray(body.allowedModels)
                              ? body.allowedModels
                                    .filter(
                                        (item): item is Record<string, unknown> =>
                                            typeof item === "object" && item !== null,
                                    )
                                    .map((item) => ({
                                        provider: str(item.provider).trim(),
                                        model: str(item.model).trim(),
                                    }))
                                    .filter((item) => item.provider && item.model)
                              : null,
                      }
                    : {}),
            };
            agents.splice(index, 1, updated);
            // 回的是 `AgentPrincipalUpdateView`（回读存量），不是整行。
            return {
                status: 200,
                body: {
                    principalId: updated.principalId,
                    defaultModelProvider: updated.defaultModelProvider,
                    defaultModelName: updated.defaultModelName,
                    allowedModels: updated.allowedModels,
                    hooks: null,
                    contextPolicy: null,
                    delegationPolicy: null,
                },
            };
        }
        if (upper === "DELETE") {
            agents.splice(index, 1);
            return { status: 204, body: null };
        }
        return null;
    }

    if (path === "/instance/mcp") {
        if (upper === "GET") return { status: 200, body: { servers, count: servers.length } };
        if (upper === "POST") {
            const body = await readBody();
            const name = str(body.name).trim();
            if (!name) return badRequest("NAME_REQUIRED", "name");
            if (servers.some((item) => item.name === name)) {
                return {
                    status: 409,
                    body: {
                        type: "about:blank",
                        title: "Conflict",
                        status: 409,
                        code: "MCP_NAME_TAKEN",
                        requestId: "mock-request",
                    },
                };
            }
            const transport =
                body.transport === "sse" || body.transport === "stdio" ? body.transport : "http";
            const created: MockInstanceMcpServer = {
                id: nextId("mcp", servers.length + 1),
                name,
                transport,
                url: str(body.url),
                enabled: true,
                credentialId: str(body.credentialId) || null,
                createdAt: new Date().toISOString(),
            };
            servers.push(created);
            return { status: 201, body: created };
        }
        return null;
    }

    const serverId = path.match(/^\/instance\/mcp\/([^/]+)$/);
    if (serverId) {
        const id = decodeURIComponent(serverId[1] ?? "");
        const index = servers.findIndex((item) => item.id === id);
        if (index < 0) return notFound("MCP_SERVER_NOT_FOUND");
        if (upper === "PATCH") {
            const body = await readBody();
            const current = servers[index] as MockInstanceMcpServer;
            const updated: MockInstanceMcpServer = {
                ...current,
                ...(str(body.url) ? { url: str(body.url) } : {}),
                ...(body.enabled === true || body.enabled === false
                    ? { enabled: body.enabled }
                    : {}),
            };
            servers.splice(index, 1, updated);
            return { status: 200, body: updated };
        }
        if (upper === "DELETE") {
            servers.splice(index, 1);
            return { status: 204, body: null };
        }
        return null;
    }

    return null;
}

/** 复位（单测用）：让每个用例从同一份种子开始。 */
export function resetInstanceResourceFixtures(): void {
    credentials.length = 0;
    credentials.push({
        id: "8831a1f5-0c6d-4a2e-9a11-2b1d7f000001",
        label: "内部 MCP 网关",
        kind: "token",
        deliveryTier: "lease",
        status: "active",
        fingerprint: "sha256:9f2c…a41d",
        revision: 3,
        createdAt: "2026-10-28T02:14:00Z",
        replacedAt: "2026-11-04T07:41:00Z",
        referenceCount: 2,
    });
    credentials.push({
        id: "8831a1f5-0c6d-4a2e-9a11-2b1d7f000002",
        label: "观测平台读写",
        kind: "key_pair",
        deliveryTier: "reveal",
        status: "active",
        fingerprint: "sha256:1b70…e09c",
        revision: 1,
        createdAt: "2026-11-02T09:05:00Z",
        replacedAt: null,
        referenceCount: 0,
    });
}
