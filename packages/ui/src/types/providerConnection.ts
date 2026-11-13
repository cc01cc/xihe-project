/**
 * 连接归属层（`ProviderConnection.owner_type` 的 UI 侧词表）。
 *
 * <p>task-284（D-1140 / D-922）：实例层与用户层同构后，连接也能归属实例 ——
 * CP 侧的枚举值就是 `ProviderConnection.OWNER_INSTANCE = "INSTANCE"`（大写），本类型与它逐字对齐；
 * 曾长期只有 USER/WORKSPACE 两值，属 UI 类型漂移。
 * 注意与<b>设置层</b>（`SettingsLayer` = instance/user/workspace-default）是两根轴：
 * 本类型描述「这条连接属于谁」，设置层描述「这份配置写在哪一层」。</p>
 */
export type ProviderScope = "USER" | "WORKSPACE" | "INSTANCE";
export type ProviderAdapter = "native-litellm" | "openai-compatible" | "manual-model";
export type ProviderCredentialType = "api-key" | "none";
export type ApiTypeOperation = "chat" | "embedding";
export type ProviderConnectionStatus =
    | "UNVERIFIED"
    | "VERIFYING"
    | "READY"
    | "INVALID_CREDENTIALS"
    | "UNREACHABLE"
    | "DISABLED";

export interface ApiTypePair {
    apiTypeId: string;
    version: number;
    defaultBaseUrl?: string | null;
    modelDiscovery?: ProviderDefinition["modelDiscovery"];
}

/**
 * PLAN-0591 P2-1: capability lives only on the catalog `supportedApiTypes`
 * entries (OpenAPI `SupportedApiTypeEntry`), never on `defaultApiType` or the
 * API-Type change impact, which stay a plain `ApiTypePair`.
 */
export interface ProviderApiTypeCapability {
    tools?: boolean;
}

export interface SupportedApiTypeEntry extends ApiTypePair {
    /** Per-API-Type tool capability decision source; omitted means unsupported. */
    capability?: ProviderApiTypeCapability;
}

type AssertNever<T extends never> = T;
/**
 * PLAN-0591 P2-1 compile-time guard (spec files are excluded from
 * `vue-tsc`, so the assertion lives here): adding `capability` back to the
 * shared `ApiTypePair` must break `pnpm run typecheck`.
 */
export type ApiTypePairHasNoCapability = AssertNever<Extract<keyof ApiTypePair, "capability">>;

/**
 * CP `/api-input-types` 的读面投影。**9 个字段全部是契约 required**
 * （`docs/api/openapi.yaml:8050` 的 `ApiInputType.required`，逐字段见 `:8051-8059`）。
 *
 * <p>task-465（D-1318）：此前缺 `requiredBaseSuffix` —— 它是**base URL 必须带的后缀**，
 * 与 `path` 分工：CP 注册表里 `path` **不含** `/v1`（如 `/chat/completions`），前缀由
 * `requiredBaseSuffix`（`/v1`）承载；embedding 型是 `/api/v1`。漏了它，UI 就无法从契约
 * 还原完整端点，只能靠猜或硬编码（`preview/mock/api-server.ts` 已在 task-457 按真源补上）。</p>
 *
 * <p>**当前无消费者**（grep 实测：9 处命中全是类型标注，没有读该字段的代码）⇒ 本条是
 * **读面投影完整性**修复，不是行为修复；不因此声称「UI 已按后缀拼端点」。真值来源是 CP
 * `control-plane/src/main/resources/api-input-types/api-input-types.json`，UI 不另造词表。</p>
 */
export interface ApiInputType {
    apiTypeId: string;
    version: number;
    operation: ApiTypeOperation;
    method: "POST";
    path: string;
    /** base URL 必备后缀（`/v1`、`/api/v1`）；`path` 不含它。契约 required（openapi:8057）。 */
    requiredBaseSuffix: string;
    requestShape: string;
    responseShape: string;
    streamShape: string;
}

export interface ProviderDefinition {
    id: string;
    displayName: string;
    category?: "recommended" | "other" | "custom";
    description?: string;
    adapter: ProviderAdapter;
    litellmProvider?: string | null;
    defaultBaseUrl?: string | null;
    modelDiscovery: "remote-models" | "litellm-catalog" | "curated" | "manual";
    credential: {
        type: ProviderCredentialType;
        required: boolean;
        placeholder?: string | null;
    };
    supports: {
        customBaseUrl: boolean;
        streaming: boolean;
        tools?: boolean;
        toolsPartial?: boolean;
        vision?: boolean;
    };
    supportedApiTypes: SupportedApiTypeEntry[];
    defaultApiType: ApiTypePair;
}

export interface ProviderConnection {
    id: string;
    providerId: string;
    connectionKey: string;
    apiTypeId: string;
    apiTypeVersion: number;
    operation: ApiTypeOperation;
    label: string;
    scope: ProviderScope;
    ownerId?: string;
    workspaceId?: string | null;
    baseUrl?: string | null;
    modelDiscovery: ProviderDefinition["modelDiscovery"];
    manualModels: string[];
    hasKey: boolean;
    credentialId?: string | null;
    maskedKey?: string | null;
    enabled: boolean;
    status: ProviderConnectionStatus;
    lastVerifiedAt?: string | null;
    lastErrorCode?: string | null;
    revision: number;
    /**
     * PLAN-0622 Resource Governor（连接级）：`null`/缺省 = 不限额。
     * 超限时 CP 返回 `429 RESOURCE_EXHAUSTED` + `Retry-After`。
     */
    maxInflight?: number | null;
    maxQueue?: number | null;
    windowTokenBudget?: number | null;
    windowSeconds?: number | null;
    /** 模型级限额（同一连接下不同模型配额可不同）。 */
    modelLimits?: ConnectionModelLimit[] | null;
}

export interface ConnectionModelLimit {
    provider: string;
    model: string;
    maxInflight?: number | null;
    windowTokenBudget?: number | null;
    windowSeconds?: number | null;
}

export interface ProviderConnectionInput {
    providerId: string;
    label: string;
    scope: ProviderScope;
    connectionKey: string;
    apiKey?: string;
    credentialId?: string;
    baseUrl?: string;
    modelDiscovery?: ProviderDefinition["modelDiscovery"];
    manualModels?: string[];
    enabled?: boolean;
    apiTypeId?: string;
    apiTypeVersion?: number;
    expectedRevision?: number;
    connectionDefaultTemplateRef?: import("../services/apiRequestTemplates").TemplateRef;
    confirmedTypeChange?: boolean;
    /** PLAN-0622：连接级资源限额（PATCH 时可只带这几项）。 */
    maxInflight?: number | null;
    maxQueue?: number | null;
    windowTokenBudget?: number | null;
    windowSeconds?: number | null;
    modelLimits?: ConnectionModelLimit[] | null;
}
