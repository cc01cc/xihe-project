import { request } from "../composables/api";
import type { CredentialKind, CredentialDeliveryTier } from "../types";
import { wireStateOf, type FieldStates } from "./fieldState";

/**
 * task-165 · 实例层资源 API client（D-1008 案 B：实例作用域 = **新前缀** `/api/v1/instance/<资源>`）。
 *
 * <p><b>为什么单独一个模块</b>：`composables/api.ts` 的 `api` 对象承载的是「用户/工作区作用域」端点
 * （`/credentials`、`/agent-principals`、`/workspaces/{id}/…`）。实例作用域是**端点级**语义
 * （D-1008 A 被否决的理由：把层变成请求字段 ⇒ 误传即跨层写），所以路径前缀不同、鉴权挂法不同，
 * 混进 `api` 只会让人以为「传个参数就能切层」。这里只放实例作用域，命名也用 `…Instance…`。</p>
 *
 * <p><b>字段口径（诚实标注，task-42 复核）</b>：契约**已落地** —— `docs/api/openapi.yaml` 的
 * `/api/v1/instance/**` 共 9 条 path（`:4905-5175`，任务卡当时的「yaml 里还没有这三组 path 的 schema」
 * 已过期）。但本文件的 DTO **仍是过渡形状**：归一化函数把已知的几种字段别名收口
 * （`principalId`/`agentId` → `id`、`label`/`name` → 显示名），所以 DTO 的键与契约字段名不是一一对应。</p>
 *
 * <p><b>归一化的代价（task-42）</b>：`nullableStr` / `num` / `str` 会把「键缺席」「键在但值为空」
 * 「有值」抹平成同一批默认值（`null` / `""` / `0`，`revision` 给了 `1`、`enabled` 给了 `true`）——
 * 于是调用方**无法**区分「契约没给这个字段」与「给了但这条没填」。本文件因此给每个 DTO 补 `states`
 * （见 `wireStateOf`）：值字段保持原样（面板依赖既有默认值，本卡不动它们），三态只由 `states` 承担。</p>
 * 证据 `internal/A03-xihe/evidence/2026-11-12-ui-instance-resources/README.md` §wire 差异表。</p>
 *
 * <p><b>为什么不在这里做权限判断</b>：写权限（instance admin）由 CP 在端点级判定；UI 只按
 * `capabilities` 决定**渲染哪一档**（403 卡片 vs 内容），不做第二套授权逻辑。</p>
 */

/**
 * 三个资源段的相对路径（`request` 自带 `/api/v1` 前缀）。
 *
 * task-38：**导出**是为了让 `__tests__/instanceResources.contract.spec.ts` 能对着
 * `docs/api/openapi.yaml` 断言「每个段都在契约里」。写死路径 + 没人对账 = 这个 P0 的成因。
 */
export const BASE = {
    credentials: "/instance/credentials",
    // task-38（R1，P0 真栈 404）：契约与 CP 都是 `/api/v1/instance/agent-principals`
    // （openapi.yaml:4876、InstanceAgentPrincipalController.java:52）。原先写 `/instance/agents`
    // ⇒ 真栈 404；mock 夹具当时也有同名路径 ⇒ mock 绿、真栈红。改这里必须同批改夹具。
    agents: "/instance/agent-principals",
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
export type InstanceCredentialField =
    | "label"
    | "kind"
    | "deliveryTier"
    | "status"
    | "fingerprint"
    | "revision"
    | "references"
    | "createdAt"
    | "replacedAt";

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
    /** 每个展示字段在载荷里到底属于三态中的哪一种（见 `wireStateOf`）。 */
    states: FieldStates<InstanceCredentialField>;
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

/**
 * 本文件只**消费**三态判据，不自己实现它（实现见 `services/fieldState.ts`）。
 *
 * <p>为什么要这一层：归一化函数（`nullableStr` / `num` / `str`）会把「键缺席」「键在但值为空」
 * 「有值」抹平成 `null` / `""` / `0`，于是详情页分不出**契约问题**（后端根本没返回这个字段）与
 * **数据问题**（返回了、这条没填）。`states` 是唯一还分得清的地方；值字段保持原样不动
 * （面板依赖它们的既有默认值）。</p>
 */
export { wireStateOf } from "./fieldState";
export type { FieldState, FieldStates } from "./fieldState";

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
        states: {
            label: wireStateOf(raw, ["label", "name"]),
            kind: wireStateOf(raw, ["kind"]),
            deliveryTier: wireStateOf(raw, ["deliveryTier"]),
            status: wireStateOf(raw, ["status"]),
            fingerprint: wireStateOf(raw, ["fingerprint"]),
            revision: wireStateOf(raw, ["revision"]),
            references: wireStateOf(raw, ["referenceCount"]),
            createdAt: wireStateOf(raw, ["createdAt"]),
            replacedAt: wireStateOf(raw, ["replacedAt"]),
        },
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
export type InstanceAgentField =
    | "name"
    | "description"
    | "template"
    | "modelProvider"
    | "modelName"
    | "createdAt"
    | "disabled";

export interface InstanceAgent {
    id: string;
    name: string;
    description: string | null;
    templateName: string | null;
    modelProvider: string | null;
    modelName: string | null;
    createdAt: string | null;
    disabled: boolean;
    /** 每个展示字段在载荷里到底属于三态中的哪一种（见 `wireStateOf`）。 */
    states: FieldStates<InstanceAgentField>;
}

export interface InstanceAgentListResponse {
    agents: InstanceAgent[];
    count: number;
}

export interface InstanceAgentCreateRequest {
    name: string;
    // task-430：**没有 description** —— 契约 `AgentPrincipalCreateRequest` 是
    // `additionalProperties: false` 且白名单只有 name/templateId/roleIds/defaultModel*/allowedModels/hooks。
    // 真 HTTP 实测（stack-1，2026-11-14 02:35）发 description ⇒ 400 INVALID_REQUEST，
    // detail 原文「Body must contain name plus optional templateId, defaultModelProvider,
    // defaultModelName, allowedModels, hooks and roleIds only」。UI 曾比契约宽 ⇒ 填说明必 400。
    templateId?: string;
    /**
     * task-401 / `D-1248`：契约 `AgentPrincipalCreateRequest`（openapi.yaml:6950）**已收**这三个，
     * CP `InstanceAgentPrincipalService#create` 也透传 ⇒ 创建面是纯 UI 缺口。
     * 语义：`defaultModel*` 是**模型意图**，principal 不持有连接（契约原文）；
     * `allowedModels` 省略/null = 不限制，给值 = 白名单。
     */
    defaultModelProvider?: string;
    defaultModelName?: string;
    allowedModels?: Array<{ provider: string; model: string }>;
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
        states: {
            name: wireStateOf(raw, ["name", "displayName"]),
            description: wireStateOf(raw, ["description"]),
            template: wireStateOf(raw, ["templateName"]),
            modelProvider: wireStateOf(raw, ["defaultModelProvider", "modelProvider"]),
            modelName: wireStateOf(raw, ["defaultModelName", "modelName"]),
            createdAt: wireStateOf(raw, ["createdAt"]),
            disabled: wireStateOf(raw, ["disabled"]),
        },
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

/**
 * task-401 / `D-1248` + cp-1 `task-413`（dedd832a5）：实例层 PATCH 现在收**模型意图三字段**
 * （外加 documents），`additionalProperties: false`、`minProperties: 1`。
 * 语义（契约原文）：present key 替换、absent key 保留存量、显式 null 清除；
 * `defaultModelProvider` 与 `defaultModelName` 在**合并结果**上 both-or-neither。
 * 名称/说明/disabled **仍不在**这个写面上 ⇒ 不发（发了就是 400）。
 */
export interface InstanceAgentUpdateRequest {
    defaultModelProvider?: string | null;
    defaultModelName?: string | null;
    allowedModels?: Array<{ provider: string; model: string }> | null;
}

/** PATCH 回的是 `AgentPrincipalUpdateView`（回读存量），**不是**整行智能体。 */
export interface InstanceAgentUpdateView {
    principalId: string;
    defaultModelProvider: string | null;
    defaultModelName: string | null;
    allowedModels: Array<{ provider: string; model: string }> | null;
}

function normalizeUpdateView(value: unknown): InstanceAgentUpdateView {
    const raw = asRecord(value);
    const list = Array.isArray(raw.allowedModels) ? raw.allowedModels : [];
    return {
        principalId: str(raw.principalId) || str(raw.id),
        defaultModelProvider: nullableStr(raw.defaultModelProvider),
        defaultModelName: nullableStr(raw.defaultModelName),
        allowedModels: list.length
            ? list.map((item) => {
                  const entry = asRecord(item);
                  return { provider: str(entry.provider), model: str(entry.model) };
              })
            : null,
    };
}

export function updateInstanceAgent(
    id: string,
    input: InstanceAgentUpdateRequest,
): Promise<InstanceAgentUpdateView> {
    return request<unknown>(withId(BASE.agents, id), {
        method: "PATCH",
        body: JSON.stringify(input),
    }).then(normalizeUpdateView);
}

/**
 * 历史留痕：这里原先有一个 `updateInstanceAgent(id, {name, description, disabled})`。
 * 它与契约不符且**无任何消费方**：`PATCH /instance/agent-principals/{id}` 的 body 是
 * `AgentPrincipalUpdateRequest`（只有 hooks / contextPolicy / delegationPolicy，
 * `additionalProperties: false`；控制器走 `parseDocuments`）⇒ 发 name/description 会 400。
 * 留着一个「看起来能改名字/模型」的函数就是给后人埋假入口（`D-1136`），故移除。
 * 实例层的改名/改模型写面是 CP 缺口，承接卡 task-413；落地后再按真契约加回来。
 */

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
export type InstanceMcpField =
    | "name"
    | "transport"
    | "url"
    | "enabled"
    | "credentialId"
    | "createdAt";

export interface InstanceMcpServer {
    id: string;
    name: string;
    transport: string;
    url: string | null;
    enabled: boolean;
    credentialId: string | null;
    createdAt: string | null;
    /** 每个展示字段在载荷里到底属于三态中的哪一种（见 `wireStateOf`）。 */
    states: FieldStates<InstanceMcpField>;
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
        states: {
            name: wireStateOf(raw, ["name"]),
            transport: wireStateOf(raw, ["transport", "type"]),
            url: wireStateOf(raw, ["url"]),
            enabled: wireStateOf(raw, ["enabled"]),
            credentialId: wireStateOf(raw, ["credentialId"]),
            createdAt: wireStateOf(raw, ["createdAt"]),
        },
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
