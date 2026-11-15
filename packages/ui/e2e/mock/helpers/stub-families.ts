/**
 * task-149 A：`GET /api/v1/config/{domain}/meta` 的**按域生成器**。
 *
 * <p>**为什么要生成器而不是 12 个手写桩**：这个端点的路径形状是 `config/{domain}/meta`，域集合由
 * 产品侧 `src/stores/config.ts` 的 `INSTANCE_DOMAINS`（12 域）决定。手写桩会在「下一个域加进来」
 * 时静默漏掉，而漏掉的形态恰好是**静默的**（404 兜底 → 面板少一域 → 断言红在别处）。所以这里按域展开：
 * 路由只解析 URL 里的 domain，键集合由调用方（`helpers/auth.ts` 的实例夹具）给出。</p>
 *
 * <p>**形状来源（不是自造）**：`src/preview/mock/api-server.ts:1484-1539`（预览 mock 已按契约实现该
 * 端点）+ `src/stores/config.ts:52-64` 的 `ConfigKeyMeta`。预览实现里的注释把两件事故写在代码旁：
 * ① `source` 曾恒填 `"code"` —— 该值**不在契约枚举里**（openapi.yaml:6357 只有
 * instance|user|workspace-default|workspace|env|default），且恒值让「谁覆盖了这键」永远显示不出来；
 * ② `adminLocked` 曾经整个字段缺失（契约 required，openapi.yaml:6354）。这里两条都按契约给。</p>
 *
 * <p>**诚实边界**：mock 车道没有「上层覆盖内存 / 管理员锁」这两个事实源，所以一律
 * `source: "instance"`、`writable: true`、未锁。这不是近似一个假值，而是「本层就是实例层」这个
 * 真实状态 —— 换成猜一个 `user` 会让设置页显示一条**不存在的覆盖**。</p>
 */

/** `ConfigKeyMeta` 的 wire 形状（`src/stores/config.ts:52-64`，`source` 枚举见 openapi.yaml:6357）。 */
export interface ConfigKeyMetaWire {
    key: string;
    source: "env" | "workspace" | "workspace-default" | "user" | "instance" | "code" | "none";
    locked: boolean;
    writable: boolean;
    reason: string | null;
    instanceEligible: boolean;
    defaultPresent: boolean;
    overridable: boolean;
    adminLocked: boolean;
    lockReason: string | null;
}

/** 生成器输出必须逐条带齐的字段（测试按这个清单核对「结构一致」）。 */
export const CONFIG_KEY_META_FIELDS = [
    "key",
    "source",
    "locked",
    "writable",
    "reason",
    "instanceEligible",
    "defaultPresent",
    "overridable",
    "adminLocked",
    "lockReason",
] as const satisfies readonly (keyof ConfigKeyMetaWire)[];

/** `source` 的契约枚举（openapi.yaml:6357）；生成器只允许落在这里面。 */
export const CONFIG_SOURCE_ENUM = [
    "env",
    "workspace",
    "workspace-default",
    "user",
    "instance",
    "code",
    "none",
] as const;

/**
 * 从 URL 路径解析要出 meta 的域；不是本族端点则返回 `null`（调用方 `route.fallback()` ⇒ 走 404 兜底，
 * 保持「没桩」可见）。
 *
 * <p>**只认精确的 `/meta` 尾巴**：`/api/v1/config/{domain}`（无 meta）由另一条已存在的桩负责，
 * 这里若用前缀匹配会把「配置值」请求错答成「provenance」，两者信封不同（map vs `{keys}`）。</p>
 */
export function parseConfigMetaPath(pathname: string): string | null {
    const matched = /^\/api\/v1\/config\/([a-z0-9-]+)\/meta$/.exec(pathname);
    return matched ? matched[1] : null;
}

/**
 * 按该域的实例夹具生成 `keys`（对应预览实现 `api-server.ts:1500-1532` 的解析结果）。
 *
 * @param entries 该域在**实例层**已配置的键（wire 形态：值一律字符串）
 */
export function buildConfigMetaKeys(entries: Record<string, string>): ConfigKeyMetaWire[] {
    return Object.keys(entries).map((key) => ({
        key,
        source: "instance" as const,
        locked: false,
        writable: true,
        reason: null,
        instanceEligible: true,
        defaultPresent: true,
        overridable: true,
        adminLocked: false,
        lockReason: null,
    }));
}

/* ────────────────────────── B 族夹具（task-149） ────────────────────────── */

/**
 * `GET /api/v1/provider-catalog` —— **逐字**取自预览 mock 的 CP 镜像
 * （`src/preview/mock/api-server.ts:1190-1301`，该处注释写明真源 =
 * `packages/control-plane/src/main/resources/provider-catalog/providers.json`
 * 的 openai `:2-15` / anthropic `:16-29` / dashscope-qwen `:100-122`）。
 *
 * <p>**为什么不能给「最小桩」**：这个端点决定「新建连接」弹窗里可选哪些 provider × API Type，
 * 且 `ProviderConnectionService.create` 会按 `supportedPair(providerId, apiTypeId, version)` 校验
 * 组合合法性（预览注释 :1179-1183）。最小桩（空 providers）会让弹窗**看起来**能用、实际一个都选不了；
 * 编一个不在 CP 词表里的 apiTypeId 则会让 UI 通过校验而真实 CP 400 —— 两种都是「桩绿、语义假」。</p>
 *
 * <p>**镜像的是哪份文件、什么时候抄的**：`packages/control-plane/src/main/resources/provider-catalog/providers.json`
 * 的 `openai`（:2-15）/ `anthropic`（:16-29）/ `dashscope-qwen`（:100-122）三段；采集时刻
 * **2026-11-15**（本夹具落地当日，与预览 mock `api-server.ts:1190-1301` 同源）。</p>
 *
 * <p>**这是子集，不是全集**（照抄预览注释 :1185-1188）：CP 共 **23 个 provider / 5 个 API Type**，
 * 这里只有 **3 + 3**。下一批加 provider 时别把「已镜像 CP」读成「夹具已完整」—— 缺的 20 个 provider
 * 仍会让对应组合在新建连接弹窗里**选不到**。</p>
 */
export const PROVIDER_CATALOG_FIXTURE = {
    catalogRevision: "v3",
    providers: [
        {
            id: "openai",
            displayName: "OpenAI",
            category: "recommended",
            description: "GPT 系列模型，支持流式与工具调用。",
            adapter: "native-litellm",
            litellmProvider: "openai",
            defaultBaseUrl: "https://api.openai.com/v1",
            modelDiscovery: "remote-models",
            supportedApiTypes: [
                {
                    apiTypeId: "openai-chat-completions",
                    version: 1,
                    capability: { tools: true, vision: false },
                },
            ],
            defaultApiType: { apiTypeId: "openai-chat-completions", version: 1 },
            credential: { type: "api-key", required: true, placeholder: "sk-..." },
            supports: {
                customBaseUrl: true,
                streaming: true,
                tools: true,
                vision: true,
                toolsPartial: false,
                visionPartial: false,
            },
        },
        {
            id: "anthropic",
            displayName: "Anthropic",
            category: "recommended",
            description: "Claude 系列模型，支持流式与工具调用。",
            adapter: "native-litellm",
            litellmProvider: "anthropic",
            defaultBaseUrl: "https://api.anthropic.com/v1",
            modelDiscovery: "remote-models",
            supportedApiTypes: [
                {
                    apiTypeId: "anthropic-messages",
                    version: 1,
                    capability: { tools: true, vision: false },
                },
            ],
            defaultApiType: { apiTypeId: "anthropic-messages", version: 1 },
            credential: { type: "api-key", required: true, placeholder: "sk-ant-..." },
            supports: {
                customBaseUrl: true,
                streaming: true,
                tools: true,
                vision: true,
                toolsPartial: false,
                visionPartial: false,
            },
        },
        {
            id: "dashscope-qwen",
            displayName: "通义千问 Qwen",
            category: "recommended",
            description: "阿里云百炼 Qwen 系列，兼容模式接入。",
            adapter: "native-litellm",
            litellmProvider: "dashscope",
            defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            modelDiscovery: "remote-models",
            supportedApiTypes: [
                {
                    apiTypeId: "openai-chat-completions",
                    version: 1,
                    capability: { tools: true, vision: true },
                },
                {
                    apiTypeId: "dashscope-multimodal-embedding",
                    version: 1,
                    defaultBaseUrl: "https://dashscope.aliyuncs.com/api/v1",
                    modelDiscovery: "manual",
                    capability: { tools: false, vision: false },
                },
            ],
            defaultApiType: { apiTypeId: "openai-chat-completions", version: 1 },
            credential: { type: "api-key", required: true, placeholder: "sk-..." },
            supports: {
                customBaseUrl: true,
                streaming: true,
                tools: true,
                vision: true,
                toolsPartial: true,
                visionPartial: true,
            },
        },
    ],
} as const;

/**
 * `GET /api/v1/api-input-types` → `{ types }`（`src/services/providerConnectionService.ts:83-85`
 * `ApiInputTypeListResponse`）。同 provider-catalog 一样**逐字镜像 CP**
 * （`control-plane/src/main/resources/api-input-types/api-input-types.json`，见
 * `src/preview/mock/api-server.ts:1360-1408` 的注释与三条夹具）。
 *
 * <p>注意 `requiredBaseSuffix`：契约 required（openapi.yaml:8050/:8057），旧 mock 漏过它，
 * 漏了会让「Base URL + 后缀」拼接示例算错。</p>
 */
export const API_INPUT_TYPES_FIXTURE = {
    types: [
        {
            apiTypeId: "openai-chat-completions",
            version: 1,
            operation: "chat",
            method: "POST",
            path: "/chat/completions",
            requiredBaseSuffix: "/v1",
            requestShape: "messages, model, stream, tools, temperature, max_tokens",
            responseShape: "choices, usage",
            streamShape: "chat.completion.chunk",
        },
        {
            apiTypeId: "anthropic-messages",
            version: 1,
            operation: "chat",
            method: "POST",
            path: "/messages",
            requiredBaseSuffix: "/v1",
            requestShape: "messages, model, stream, tools, max_tokens",
            responseShape: "content, usage",
            streamShape: "message.delta",
        },
        {
            apiTypeId: "dashscope-multimodal-embedding",
            version: 1,
            operation: "embedding",
            method: "POST",
            path: "/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding",
            requiredBaseSuffix: "/api/v1",
            requestShape: "model, input.contents, parameters.dimension",
            responseShape: "output.embeddings, usage, requestId",
            streamShape: "none",
        },
    ],
} as const;

/**
 * `GET /api/v1/org-units` → `{ nodes }`（`src/preview/mock/api-server.ts:495-507`；
 * 节点字段 `src/composables/api.ts:253-259 ApiOrgUnitNode`，以 openapi `OrgUnitNode` 为准）。
 *
 * <p>`hasChildren` 是懒加载的**唯一**依据（UI 不猜）⇒ 夹具必须自洽：父节点声明
 * `hasChildren: true`，其子节点必须在按 `parentId` 查询时真的能返回，否则树展开后是空的。</p>
 */
export const ORG_UNIT_NODES_FIXTURE = [
    { id: "unit-root", name: "实例根", parentId: null, depth: 0, hasChildren: true },
    { id: "unit-eng", name: "工程组", parentId: "unit-root", depth: 1, hasChildren: false },
] as const;

/**
 * `GET /api/v1/agent-templates?layer=&workspaceId=` → `AgentTemplateLayerResponse`
 * （`src/preview/mock/api-server.ts:866-875`）。
 *
 * <p>空 `templates` 是**合法空集**（与实例夹具同口径：mock 车道没有模板库），不是「不知道」。
 * `layer` 原样回显，因为调用方要么按 `layer=workspace` 取、要么取 instance 层。</p>
 */
export function agentTemplatesResponse(layer: string | null, workspaceId: string | null) {
    return {
        layer: layer === "user" || layer === "workspace" ? layer : "instance",
        workspaceId,
        templates: [],
    };
}

/**
 * `GET /api/v1/workspaces/{id}/checkpoints/retention` —— 四个**非负整数**，缺一个就会让
 * `normalizeCheckpointRetention` 抛 `Invalid checkpoint retention response`
 * （`src/composables/api.ts:1934-1949`，调用方故意让异常冒出来）。
 *
 * <p>给的是「未设上限、无历史」的中性值：`maxRuns`/`ttlDays` = 0 表示不限制，`currentRuns`/
 * `currentRefs` = 0 表示当前没有检查点行。**不编**一个看起来有数据的上限，否则页面上会显示
 * 一个假的配额。</p>
 */
export const CHECKPOINT_RETENTION_FIXTURE = {
    maxRuns: 0,
    ttlDays: 0,
    currentRuns: 0,
    currentRefs: 0,
} as const;

/**
 * `GET /api/v1/context/{sessionId}/sources` → **单对象**（不是数组）
 * `{ sourceKey, status, hashPrefix, envBranch?, envHead? }`
 * （`src/composables/api.ts:3391-3399`；CP `ContextPublicController:66-68` 只给元数据、永不带正文）。
 *
 * <p>`status: "unknown"` 是 CP 自己的缺省值，`hashPrefix: ""` 表示 mock 车道没有真实快照 ——
 * 编一个「已加载」的哈希会让上下文面板显示一条不存在的证据。</p>
 */
export function contextSourcesResponse(sessionId: string) {
    return { sourceKey: `session:${sessionId}`, status: "unknown", hashPrefix: "" };
}
