import { request } from "../composables/api";
import type { CredentialKind, CredentialDeliveryTier } from "../types";

/**
 * task-165 · 实例层资源 API client（D-1008 案 B：实例作用域 = **新前缀** `/api/v1/instance/<资源>`）。
 *
 * <p><b>为什么单独一个模块</b>：`composables/api.ts` 的 `api` 对象承载的是「用户/工作区作用域」端点
 * （`/credentials`、`/agent-principals`、`/workspaces/{id}/…`）。实例作用域是**端点级**语义
 * （D-1008 A 被否决的理由：把层变成请求字段 ⇒ 误传即跨层写），所以路径前缀不同、鉴权挂法不同，
 * 混进 `api` 只会让人以为「传个参数就能切层」。这里只放实例作用域，命名也用 `…Instance…`。</p>
 *
 * <p><b>字段口径（诚实标注）</b>：截至本卡，`docs/api/openapi.yaml` 里**还没有**这三组 path 的
 * schema（由 `cp-1` 落 yaml，D-1008 只裁了形态：13 条最小端点 = 集合 GET/POST + `{id}` PATCH/DELETE，
 * credentials 另加 `{id}/reveal`）。因此本文件的 DTO 是**按现有同实体投影推导的过渡形状**，
 * 用「归一化函数」把已知的几种字段别名收口（`principalId`/`agentId` → `id`、
 * `label`/`name` → 显示名），yaml 落地后**只需改归一化函数**，页面不用动。
 * 证据 `internal/A03-xihe/evidence/2026-11-12-ui-instance-resources/README.md` §wire 差异表。</p>
 *
 * <p><b>为什么不在这里做权限判断</b>：写权限（instance admin）由 CP 在端点级判定；UI 只按
 * `capabilities` 决定**渲染哪一档**（403 卡片 vs 内容），不做第二套授权逻辑。</p>
 */

/** 三个资源段的相对路径（`request` 自带 `/api/v1` 前缀）。 */
const BASE = {
    credentials: "/instance/credentials",
    agents: "/instance/agents",
    mcp: "/instance/mcp",
} as const;

/** 依赖 id 的路径拼装统一走这里：`encodeURIComponent` 只写一次，避免某处漏转义。 */
function withId(base: string, id: string): string {
    return `${base}/${encodeURIComponent(id)}`;
}

/* ------------------------------------------------------------------ */
/* credentials                                                         */
/* ------------------------------------------------------------------ */

/**
 * 实例凭据（D-1007/D-1009）：`owner_type = INSTANCE`、**`owner_id` 为空**、只能被实例级资源使用。
 * 投影仍是脱敏元数据（不含密文/后缀/明文），reveal 是唯一取明文的入口。
 */
export interface InstanceCredential {
    id: string;
    label: string;
    kind: CredentialKind;
    deliveryTier: CredentialDeliveryTier;
    status: "active" | "disabled";
    fingerprint: string;
    revision: number;
    createdAt: string | null;
    replacedAt: string | null;
    referenceCount: number;
}

export interface InstanceCredentialListResponse {
    credentials: InstanceCredential[];
    count: number;
}

export interface InstanceCredentialCreateRequest {
    label: string;
    kind: CredentialKind;
    deliveryTier: CredentialDeliveryTier;
    token?: string;
    accessKey?: string;
    secretKey?: string;
}

/** reveal 是**一次性**明文：字段随 kind 而变（token / 或 accessKey+secretKey）。 */
export interface InstanceCredentialRevealResponse {
    id?: string;
    label?: string;
    kind?: CredentialKind;
    token?: string;
    accessKey?: string;
    secretKey?: string;
}

type RawRecord = Record<string, unknown>;

function asRecord(value: unknown): RawRecord {
    return value && typeof value === "object" ? (value as RawRecord) : {};
}

function str(value: unknown, fallback = ""): string {
    return typeof value === "string" ? value : fallback;
}

function nullableStr(value: unknown): string | null {
    return typeof value === "string" && value ? value : null;
}

function num(value: unknown, fallback = 0): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeCredential(value: unknown): InstanceCredential {
    const raw = asRecord(value);
    return {
        id: str(raw.id),
        label: str(raw.label) || str(raw.name),
        kind: raw.kind === "key_pair" ? "key_pair" : "token",
        deliveryTier: raw.deliveryTier === "reveal" ? "reveal" : "lease",
        status: raw.status === "disabled" ? "disabled" : "active",
        fingerprint: str(raw.fingerprint),
        revision: num(raw.revision, 1),
        createdAt: nullableStr(raw.createdAt),
        replacedAt: nullableStr(raw.replacedAt),
        referenceCount: num(raw.referenceCount),
    };
}

export function listInstanceCredentials(): Promise<InstanceCredentialListResponse> {
    return request<unknown>(BASE.credentials).then((payload) => {
        const raw = asRecord(payload);
        const rows = Array.isArray(raw.credentials)
            ? raw.credentials
            : Array.isArray(payload)
              ? payload
              : [];
        return {
            credentials: rows.map(normalizeCredential),
            count: num(raw.count, rows.length),
        };
    });
}

export function createInstanceCredential(
    input: InstanceCredentialCreateRequest,
): Promise<InstanceCredential> {
    return request<unknown>(BASE.credentials, {
        method: "POST",
        body: JSON.stringify(input),
    }).then(normalizeCredential);
}

export function updateInstanceCredential(
    id: string,
    input: Partial<Pick<InstanceCredential, "label" | "status">>,
): Promise<InstanceCredential> {
    return request<unknown>(withId(BASE.credentials, id), {
        method: "PATCH",
        body: JSON.stringify(input),
    }).then(normalizeCredential);
}

export function deleteInstanceCredential(id: string): Promise<void> {
    return request<void>(withId(BASE.credentials, id), { method: "DELETE" });
}

/**
 * 一次性取明文（`{id}/reveal`）。注意：既有的用户作用域 reveal 要求 step-up 密码
 * （`/credentials/{id}/reveal` + `{password}`）；实例作用域是否沿用同一道 step-up 由 CP 定，
 * 这里**按同一形态发**，缺密码时 CP 的 4xx 会走错误面 —— 不在这里猜。
 */
export function revealInstanceCredential(
    id: string,
    password: string,
): Promise<InstanceCredentialRevealResponse> {
    return request<unknown>(withId(BASE.credentials, `${id}/reveal`), {
        method: "POST",
        body: JSON.stringify({ password }),
    }).then((payload) => {
        const raw = asRecord(payload);
        return {
            id: nullableStr(raw.id) ?? id,
            label: nullableStr(raw.label) ?? undefined,
            kind: raw.kind === "key_pair" ? "key_pair" : raw.kind === "token" ? "token" : undefined,
            token: nullableStr(raw.token) ?? undefined,
            accessKey: nullableStr(raw.accessKey) ?? undefined,
            secretKey: nullableStr(raw.secretKey) ?? undefined,
        };
    });
}

/* ------------------------------------------------------------------ */
/* agents（平台智能体）                                                 */
/* ------------------------------------------------------------------ */

/**
 * 平台智能体（D-1006 B4）：**默认全局可见、无需逐工作区绑定、仅 instance admin 可建**；
 * 不做 fork、不收录 `workspace_agents`。列表 = 工作区自有 + 平台预置两段拼接，
 * 本模块只负责**平台段**。
 */
export interface InstanceAgent {
    id: string;
    name: string;
    description: string | null;
    templateName: string | null;
    modelProvider: string | null;
    modelName: string | null;
    createdAt: string | null;
    disabled: boolean;
}

export interface InstanceAgentListResponse {
    agents: InstanceAgent[];
    count: number;
}

export interface InstanceAgentCreateRequest {
    name: string;
    description?: string;
    templateId?: string;
}

function normalizeAgent(value: unknown): InstanceAgent {
    const raw = asRecord(value);
    return {
        id: str(raw.id) || str(raw.principalId) || str(raw.agentId),
        name: str(raw.name) || str(raw.displayName),
        description: nullableStr(raw.description),
        templateName: nullableStr(raw.templateName),
        modelProvider: nullableStr(raw.defaultModelProvider) ?? nullableStr(raw.modelProvider),
        modelName: nullableStr(raw.defaultModelName) ?? nullableStr(raw.modelName),
        createdAt: nullableStr(raw.createdAt),
        disabled: raw.disabled === true,
    };
}

export function listInstanceAgents(): Promise<InstanceAgentListResponse> {
    return request<unknown>(BASE.agents).then((payload) => {
        const raw = asRecord(payload);
        const rows = Array.isArray(raw.agents)
            ? raw.agents
            : Array.isArray(raw.principals)
              ? raw.principals
              : Array.isArray(payload)
                ? payload
                : [];
        return { agents: rows.map(normalizeAgent), count: num(raw.count, rows.length) };
    });
}

export function createInstanceAgent(input: InstanceAgentCreateRequest): Promise<InstanceAgent> {
    return request<unknown>(BASE.agents, {
        method: "POST",
        body: JSON.stringify(input),
    }).then(normalizeAgent);
}

export function updateInstanceAgent(
    id: string,
    input: Partial<Pick<InstanceAgent, "name" | "description" | "disabled">>,
): Promise<InstanceAgent> {
    return request<unknown>(withId(BASE.agents, id), {
        method: "PATCH",
        body: JSON.stringify(input),
    }).then(normalizeAgent);
}

export function deleteInstanceAgent(id: string): Promise<void> {
    return request<void>(withId(BASE.agents, id), { method: "DELETE" });
}

/* ------------------------------------------------------------------ */
/* mcp（实例级 MCP 注册表）                                             */
/* ------------------------------------------------------------------ */

/**
 * 实例级 MCP（D-1006 B5）：实例注册表 + 与工作区级「继承 + 工作区可覆盖同名」；
 * 唯一标识用 **`name`**（D-1007 第 2 条：同 url 可换协议/auth，换掉不该算同一 server）；
 * 只可引用**实例凭据**。子动作（oauth/session/bindings）按 D-1008 不铺开。
 */
export interface InstanceMcpServer {
    id: string;
    name: string;
    transport: string;
    url: string | null;
    enabled: boolean;
    credentialId: string | null;
    createdAt: string | null;
}

export interface InstanceMcpListResponse {
    servers: InstanceMcpServer[];
    count: number;
}

export interface InstanceMcpCreateRequest {
    name: string;
    transport: string;
    url?: string;
    credentialId?: string;
}

function normalizeMcpServer(value: unknown): InstanceMcpServer {
    const raw = asRecord(value);
    return {
        id: str(raw.id) || str(raw.serverId) || str(raw.name),
        name: str(raw.name),
        transport: str(raw.transport) || str(raw.type) || "http",
        url: nullableStr(raw.url),
        enabled: raw.enabled !== false,
        credentialId: nullableStr(raw.credentialId),
        createdAt: nullableStr(raw.createdAt),
    };
}

export function listInstanceMcpServers(): Promise<InstanceMcpListResponse> {
    return request<unknown>(BASE.mcp).then((payload) => {
        const raw = asRecord(payload);
        const rows = Array.isArray(raw.servers)
            ? raw.servers
            : Array.isArray(raw.items)
              ? raw.items
              : Array.isArray(payload)
                ? payload
                : [];
        return { servers: rows.map(normalizeMcpServer), count: num(raw.count, rows.length) };
    });
}

export function createInstanceMcpServer(
    input: InstanceMcpCreateRequest,
): Promise<InstanceMcpServer> {
    return request<unknown>(BASE.mcp, {
        method: "POST",
        body: JSON.stringify(input),
    }).then(normalizeMcpServer);
}

export function updateInstanceMcpServer(
    id: string,
    input: Partial<InstanceMcpCreateRequest> & { enabled?: boolean },
): Promise<InstanceMcpServer> {
    return request<unknown>(withId(BASE.mcp, id), {
        method: "PATCH",
        body: JSON.stringify(input),
    }).then(normalizeMcpServer);
}

export function deleteInstanceMcpServer(id: string): Promise<void> {
    return request<void>(withId(BASE.mcp, id), { method: "DELETE" });
}
