import { defineStore } from "pinia";
import { ref } from "vue";
import { useLocalStorage } from "@vueuse/core";
import { type ModelCache } from "../types/provider";
import type { SessionModelBinding, ModelFavorite } from "../types";
import type { ProviderConnection } from "../types/providerConnection";
import { api, request } from "../composables/api";
import { listProviderConnections } from "../services/providerConnectionService";
import { parseLlmProfileValue } from "../services/llmProviderProfile";
import { logger } from "../lib/logger";
import {
    primaryAgentPrincipalId,
    resolveChatModelSource,
    type ChatModelSourceKind,
} from "../features/workspace/chat/modelDisplay";
import { useSessionParticipantsStore } from "../features/workspace/stores/sessionParticipants";
import { useSessionStore } from "./session";

/**
 * UI 可读写的配置层。task-253（用户 2026-11-10 裁定）：**全局设置不再暴露 workspace 层** ——
 * 工作区层是每工作区的覆盖层，编辑面在工作区设置页，不在全局设置左栏。
 * 这里收窄不是文档美化：任何还想在全局设置传 "workspace" 的调用点会在 typecheck 当场失败，
 * 是「全局面不写 workspace 层」的编译期保证（CP 契约侧该层仍在，只按 deprecated 处理）。
 *
 * PLAN-0766（D-928/D-931，task-160）：新增的是**共享的 workspace-default 层**，不是
 * per-workspace 层。wire 值小写 `workspace-default`（契约 b05aad952: GET
 * `/config/{domain}?layer=workspace-default`、`PUT /config/workspace-default/{domain}`）。
 * 它是部署级的一份行集，对没有显式 workspace 覆盖的所有工作区生效；层序
 * workspace > workspace-default > user > instance（env / 管理员钉仍在所有 DB 层之上）。
 *
 * PLAN-0773 M4-1（task-190）：**新增的是 per-workspace 层** `workspace` —— 与上面那个
 * `workspace-default` **不是一回事**，两者并存且命名必须能一眼区分：
 * - `workspace-default` = **部署级共享默认值**（一份行集，对所有没显式覆盖的工作区生效，`D-928`）；
 * - `workspace` = **某一个工作区自己的行集**（身份由 `X-Workspace-Id` 头承载，CP 侧
 *   `ConfigController.java:172-180` 解析，契约 `PUT /api/v1/config/workspace/{domain}` 现为
 *   `deprecated: true` 但仍在服务；退役前置条件「工作区设置重构落地」= 本条）。
 *
 * 设置区**不得**因此变成四层：`lib/settingsIa.ts` 的 `SettingsLayer` 同批收窄为
 * `Exclude<ConfigLayer, "workspace">` —— 加层与收窄**必须同一批**，否则中间态会让
 * `task-253` 刚删掉的「工作区层」从后门回到全局设置页，而且不会有任何报错。
 */
export type ConfigLayer = "instance" | "workspace-default" | "workspace" | "user";

/**
 * 配置值的**来源**（GET /config/{domain}/meta 回填的 provenance），与上面的层**不是同一个轴**：
 * workspace 层仍在 CP（每工作区的覆盖层），只是全局设置不写它；CP 仍可能报
 * source=workspace（该层的行为、历史行或 CP 侧其它写入口），UI 只负责如实显示它。
 * 所以这里保留 "workspace" 这个取值，不随 ConfigLayer 一起收窄。
 */
export type ConfigSource =
    | "env"
    | "workspace"
    | "workspace-default"
    | "user"
    | "instance"
    | "code"
    | "none";

/** PLAN-0554: per-key provenance returned by GET /config/{domain}/meta. */
export interface ConfigKeyMeta {
    key: string;
    source: ConfigSource;
    locked: boolean;
    writable: boolean;
    reason: string | null;
    instanceEligible: boolean;
    defaultPresent: boolean;
    overridable: boolean;
    /** PLAN-0556: administrator lock; the instance value is pinned above workspace/user. */
    adminLocked?: boolean;
    lockReason?: string | null;
}

/** PLAN-0307 target domain set (decision #37). Instance layer only. */
export const INSTANCE_DOMAINS = [
    "llm-provider",
    "context-policy",
    "embedding",
    "rag",
    "agent-runtime",
    "agent-profile",
    "user-preference",
    "logging",
    "approval-policy",
    "agent-templates",
    "api-request-templates",
    "job-policy",
] as const;

export type ConfigDomain = (typeof INSTANCE_DOMAINS)[number];

/**
 * Merged-config domains; agent/context templates only have explicit-layer reads
 * (PLAN-0414: api-request-templates rejects merged effective on the CP side).
 */
export const CONFIG_DOMAINS: readonly Exclude<
    ConfigDomain,
    "agent-templates" | "api-request-templates"
>[] = INSTANCE_DOMAINS.filter(
    (domain): domain is Exclude<ConfigDomain, "agent-templates" | "api-request-templates"> =>
        domain !== "agent-templates" && domain !== "api-request-templates",
);

/**
 * PLAN-0573: domains a non-admin session may read via the merged
 * `GET /config/{domain}` view. Mirror of the CP semantics
 * (ConfigService.java:90-96,137-141: USER_WRITABLE ∪ WORKSPACE_WRITABLE ∪
 * EXPLICIT_ONLY; today only `logging` falls outside). CP stays authoritative —
 * the UI merely avoids issuing requests it knows will be rejected with 403.
 * Keep in sync when the CP sets change.
 */
const NON_ADMIN_READABLE_DOMAINS: ReadonlySet<ConfigDomain> = new Set<ConfigDomain>([
    "llm-provider",
    "context-policy",
    "embedding",
    "rag",
    "agent-runtime",
    "agent-profile",
    "user-preference",
    "approval-policy",
    "agent-templates",
    "api-request-templates",
    "job-policy",
]);

/** True when the merged view of this domain is readable without the ADMIN bypass. */
export function isDomainReadableWithoutAdmin(domain: ConfigDomain): boolean {
    return NON_ADMIN_READABLE_DOMAINS.has(domain);
}

/**
 * `workspace-default`（部署级共享默认，PLAN-0766/D-928）与 `workspace`（per-workspace，
 * PLAN-0773 M4-1）**共用**这张矩阵：CP 侧两者都由 `WORKSPACE_WRITABLE_DOMAINS` 约束。
 *
 * <p><b>2026-11-13 D-1122 49A / PLAN-0766 T2.4</b>：模型 4 域（llm-provider / context-policy /
 * embedding / rag）**退出工作区层** —— 它们在实例层与用户层仍可写、工作区层仍可读合并值，但
 * 不再是工作区层（含 workspace-default）的可写面。CP 侧 `ConfigService.java:102-103` 的
 * `WORKSPACE_WRITABLE_DOMAINS` 是 5 域（4 个行为域 + service-only 的 `context-templates`），
 * 通用 config API 只能服务 12 个 UI 域 ⇒ T2.4 后交集 = 4 域（`ConfigService.java:115-118`）。</p>
 *
 * <p><b>2026-11-14 task-485 / task-226（用户裁定）</b>：`agent-templates` 也**撤下工作区层**
 * ⇒ 交集 = **3 域**。用户原话「工作区没有智能体模板与角色，工作区（能）有的是能用的智能体」：
 * 模板与角色归**智能体配置**（实例/用户层），工作区只做**绑定**（绑定面 = task-226 P1，未实施）。
 * CP 侧 `WORKSPACE_WRITABLE_DOMAINS` **本轮未改**（仍含 `agent-templates`，那是 P1 的事）——
 * 本数组是「UI 有哪些域」的事实镜像，UI 不再出现的域不必等 CP 收缩。判据：
 * `stores/__tests__/configStore.spec.ts` 的矩阵事实断言 + 矩阵 v2 正文
 * `internal/A03-xihe/docs/settings-layer-domain-matrix-v2.md` §3。</p>
 */
const GENERIC_WORKSPACE_DOMAINS = ["agent-runtime", "approval-policy", "job-policy"] as const;

/**
 * **实例层在设置区出现的域集**（task-485 / task-226 D4，2026-11-14）。
 *
 * <p>为什么与 `INSTANCE_DOMAINS` 分成两个常量：后者是**域宇宙**（12 域 = CP `UI_DOMAINS` 的
 * 镜像，也是 `ConfigDomain` 的类型来源），前者是**矩阵事实**（哪些域在实例层的设置页出现）。
 * `agent-profile`（智能体个人）按用户 2026-11-14 裁定「属于成员管理，不在设置域里」迁出设置区
 * —— 它**仍是 CP 的合法域**（`ConfigService.DOMAINS` 里有，成员页仍要写这个域的 `userName`），
 * 只是不再有 `/settings/<层>/agent-profile` 路由。所以：**域类不减、矩阵格减**。
 * 矩阵口径的唯一正文见 `internal/A03-xihe/docs/settings-layer-domain-matrix-v2.md`。</p>
 */
const SETTINGS_INSTANCE_DOMAINS: readonly ConfigDomain[] = INSTANCE_DOMAINS.filter(
    (domain) => domain !== "agent-profile",
);

/** **用户层在设置区出现的域集**：同上，实例独有的 3 域（logging / approval-policy / job-policy）不在其中。 */
const SETTINGS_USER_DOMAINS: readonly ConfigDomain[] = [
    "llm-provider",
    "context-policy",
    "embedding",
    "rag",
    "agent-runtime",
    "user-preference",
    "agent-templates",
    "api-request-templates",
];

export const LAYER_DOMAINS: Record<ConfigLayer, readonly ConfigDomain[]> = {
    // task-485：`agent-profile` 已迁出设置区 ⇒ 实例层 12 → 11 域（见 `SETTINGS_INSTANCE_DOMAINS`）。
    instance: SETTINGS_INSTANCE_DOMAINS,
    // task-485 / D-1122 49A + PLAN-0766 T2.4：工作区层（workspace-default 与 per-workspace 共用）
    // 在 T2.4 后是 4 域，task-485 再把 `agent-templates` 撤下 ⇒ **3 域**（用户裁定「工作区没有
    // 智能体模板与角色，只有能用的智能体」）。CP 侧 `WORKSPACE_WRITABLE_DOMAINS` 仍是 5 域
    // （含 service-only 的 `context-templates`），本数组是「UI 可服务 ∩ 矩阵允许」的交集。
    // 刻意不列 context-templates：列了就是左栏出现一个点进去必然失败的入口。
    "workspace-default": GENERIC_WORKSPACE_DOMAINS,
    // PLAN-0773 M4-1：**per-workspace 层**与 `workspace-default` 用的是**同一张矩阵**（task-485 起 3 域），
    // 且共用同一个数组常量 —— 不是巧合，是同一个 CP 常量 `WORKSPACE_WRITABLE_DOMAINS` 的两个落库面：
    // 一个写"某一工作区自己的行"，一个写"没显式覆盖时的部署级默认行"。分成两份数组等于
    // 允许两层的可写域集漂移（今天相同、明天有人只改一处），而契约里它们是**同一个集合**。
    workspace: GENERIC_WORKSPACE_DOMAINS,
    // task-485：`agent-profile` 迁出 ⇒ 用户层 9 → 8 域（见 `SETTINGS_USER_DOMAINS`）。
    user: SETTINGS_USER_DOMAINS,
};

export interface ConfigImportReport {
    status: string;
    imported: number;
    skipped: number;
    warnings: string[];
}

const MODEL_CACHE_KEY = "xihe-model-cache",
    SESSION_MODELS_KEY = "xihe-session-models",
    MODEL_FAVORITES_KEY = "xihe-model-favorites",
    MERGED_CONFIG_KEY = "xihe-config-merged";

/**
 * task-140：模型来源判定的结果。`loading`、`unavailable` 与 `none` 必须分开 ——
 * `loading` 是"数据还没到，不确定"，`unavailable` 是"该读的读失败了，仍然不确定"
 * （名册 403/失败、工作区主体默认读失败），`none` 才是"链路上确实没有来源"。
 * 把前两者渲染成 `none` 会让用户看到"未绑定模型"的告警态 —— 那是假否定：
 * CP 侧同一会话仍可能从主体默认/profile 解析出模型并发送成功。
 *
 * task-2（task-140 收尾）：`unavailable` 是本轮新增的第三态。它**不猜来源**：
 * provider/model 置 null、source 保持 `none`，由展示层画「来源未知」并指向 explain 面
 * （模型来源 explain 端点属 task-8，命名以本状态串 `unavailable` 为准，别另造）。
 */
export type ChatModelSourceStatus = "loading" | "ready" | "unavailable";

export interface ChatModelSourceResolution {
    status: ChatModelSourceStatus;
    provider: string | null;
    model: string | null;
    source: ChatModelSourceKind;
    inDiscoveredList: boolean | null;
}

export const useConfigStore = defineStore("config", () => {
    const mergedConfig = useLocalStorage<Record<string, Record<string, string>>>(
        MERGED_CONFIG_KEY,
        {},
    );
    const loading = ref(false),
        error = ref<string | null>(null);

    /**
     * Per-layer raw entries (T2.17)。`workspace`（per-workspace 层，PLAN-0773 M4-1）与
     * `workspace-default`（部署级共享默认值，PLAN-0766）是两个不同的行集，都存在这里。
     */
    const layerConfig = ref<Record<ConfigLayer, Record<string, Record<string, string>>>>({
        instance: {},
        "workspace-default": {},
        workspace: {},
        user: {},
    });
    const layerLoading = ref(false);
    /**
     * BL-619：**per-layer** 加载标志。`layerLoading` 是瞬时全局标志 —— 任何一层在飞的加载都会翻转它，
     * 而「首次加载遮罩」只能看**当前层**是否在加载。否则 A 层的加载会把 B 层的面板卸载，B 层重新挂载
     * 又发一次加载 ⇒ 自持回环（`SettingsDomainView.vue:99-105` 记的是同一条回环在另一个视图上的形态）。
     */
    const layerLoadingByLayer = ref<Record<ConfigLayer, boolean>>({
        instance: false,
        "workspace-default": false,
        workspace: false,
        user: false,
    });
    /** domain -> key -> env-effective value when an env overlay wins (decision #22). */
    const envOverridden = ref<Record<string, Record<string, string>>>({});
    /** PLAN-0554: layer -> domain -> key -> provenance metadata. */
    const layerMeta = ref<Record<ConfigLayer, Record<string, Record<string, ConfigKeyMeta>>>>({
        instance: {},
        "workspace-default": {},
        workspace: {},
        user: {},
    });

    const modelCache = useLocalStorage<ModelCache>(MODEL_CACHE_KEY, { models: {}, providers: {} }),
        sessionModels = useLocalStorage<Record<string, SessionModelBinding>>(
            SESSION_MODELS_KEY,
            {},
        ),
        modelFavorites = useLocalStorage<ModelFavorite[]>(MODEL_FAVORITES_KEY, []),
        modelError = ref<string | null>(null),
        // PLAN-0523 T3.5: single-source provider connection list; consumers
        // subscribe here instead of issuing their own listProviderConnections.
        providerConnections = ref<ProviderConnection[]>([]),
        providerConnectionsLoaded = ref(false),
        providerConnectionsError = ref(false);
    let providerConnectionsInflight: Promise<void> | null = null;

    async function loadProviderConnections(options?: { force?: boolean }): Promise<void> {
        if (providerConnectionsLoaded.value && !options?.force) return;
        if (providerConnectionsInflight) return providerConnectionsInflight;
        providerConnectionsInflight = (async () => {
            try {
                const list = await listProviderConnections();
                providerConnections.value = list.connections ?? [];
                providerConnectionsLoaded.value = true;
                providerConnectionsError.value = false;
            } catch (cause) {
                // PLAN-0555: the composer must distinguish "not loaded" from
                // "load failed" so it does not claim "no connection recorded".
                providerConnectionsError.value = true;
                throw cause;
            }
        })();
        try {
            await providerConnectionsInflight;
        } finally {
            providerConnectionsInflight = null;
        }
    }

    /** Mutation hook: create/update/delete/verify must invalidate before reload. */
    function invalidateProviderConnections() {
        providerConnectionsLoaded.value = false;
        providerConnectionsError.value = false;
    }

    function findProviderForModel(modelId: string): string | undefined {
        for (const [catalogKey, catalog] of Object.entries(modelCache.value.providers ?? {})) {
            if (
                catalog.status === "ready" &&
                catalog.models.some((entry) => entry.name === modelId && entry.capabilities.chat)
            ) {
                return catalog.providerId ?? catalogKey;
            }
        }
        return undefined;
    }

    function migrateSessionModels() {
        try {
            const raw = sessionModels.value;
            let changed = false;
            for (const [sid, val] of Object.entries(raw)) {
                if (typeof val === "string") {
                    const provider = findProviderForModel(val as unknown as string);
                    raw[sid] = { provider: provider ?? "", model: val as unknown as string };
                    changed = true;
                }
            }
            if (changed) sessionModels.value = { ...raw };
        } catch {
            sessionModels.value = {};
        }
    }

    migrateSessionModels();

    async function fetchDomain(domain: string): Promise<Record<string, string>> {
        return request<Record<string, string>>(`/config/${domain}`);
    }

    /**
     * PLAN-0573 + task-74：入参是**能否读实例内容**，判据与 CP 同源 ——
     * `config/ConfigController.java:89-90` 的 `canReadInstanceContent()`（原子 `READ_INSTANCE_CONTENT`）
     * 决定 `GET /config/{domain}` 是否放行非白名单域（`:207-220`）。**不是能力位，也不是角色**：
     * 传 `auth.isAdmin` 会让「有原子无 `cap:instance:admin`」的账号少拉几个域（UI 比 CP 严）。
     * 非持有者按白名单过滤，CP 会 403 的域一个都不请求。
     */
    async function loadAllDomains(options?: { canReadInstanceContent?: boolean }) {
        loading.value = true;
        error.value = null;
        const domains = options?.canReadInstanceContent
            ? [...CONFIG_DOMAINS]
            : CONFIG_DOMAINS.filter(isDomainReadableWithoutAdmin);
        try {
            const results = await Promise.all(
                domains.map((d) => fetchDomain(d).then((data) => ({ domain: d, data }))),
            );
            const nextConfig: Record<string, Record<string, string>> = {};
            for (const { domain, data } of results) {
                nextConfig[domain] = data;
            }
            mergedConfig.value = nextConfig;
        } catch (e) {
            error.value = e instanceof Error ? e.message : "Failed to load config";
        } finally {
            loading.value = false;
        }
    }

    /** BL-619：读写 per-layer 标志，并让全局 `layerLoading` 继续反映「是否有任何层在加载」。 */
    function setLayerLoading(layer: ConfigLayer, loading: boolean): void {
        layerLoadingByLayer.value = { ...layerLoadingByLayer.value, [layer]: loading };
        layerLoading.value = Object.values(layerLoadingByLayer.value).some(Boolean);
    }

    /** BL-619：设置页的首次加载遮罩只认**当前层**，不认别的层在飞的加载。 */
    function isLayerLoading(layer: ConfigLayer): boolean {
        return layerLoadingByLayer.value[layer] ?? false;
    }

    /**
     * PLAN-0307 T2.17: load one layer's entries for all writable domains of that
     * layer, together with the env-lock metadata (`includeMeta=true`).
     */
    async function loadLayerDomains(layer: ConfigLayer): Promise<void> {
        setLayerLoading(layer, true);
        error.value = null;
        try {
            const domains = LAYER_DOMAINS[layer];
            // BL-619：**按域隔离**。旧写法 `Promise.all` 让任一个域 500 时整层 reject ⇒ `layerConfig`
            // 永不落库 ⇒ 设置页 `hasLayerData` 恒假 ⇒ 首次加载遮罩反复卸载/重挂面板（README §0 的回环）。
            // 失败域仍必须显式呈现（`error` 落文案 + 调用方照旧收到 reject），不许变成静默成功。
            const settled = await Promise.allSettled(
                domains.map(async (domain) => {
                    const [body, metaBody] = await Promise.all([
                        request<{
                            domain: string;
                            entries: Record<string, string>;
                            envOverridden?: Record<string, string>;
                        }>(`/config/${domain}?layer=${layer}&includeMeta=true`),
                        request<{ keys?: ConfigKeyMeta[] }>(
                            `/config/${domain}/meta?layer=${layer}`,
                        ),
                    ]);
                    return { domain, body, metaBody };
                }),
            );
            const nextLayer: Record<string, Record<string, string>> = {
                ...layerConfig.value[layer],
            };
            const nextEnv: Record<string, Record<string, string>> = { ...envOverridden.value };
            const nextMeta: Record<string, Record<string, ConfigKeyMeta>> = {
                ...layerMeta.value[layer],
            };
            const failedDomains: string[] = [];
            settled.forEach((result, index) => {
                const domain = domains[index];
                if (result.status === "fulfilled") {
                    const { body, metaBody } = result.value;
                    nextLayer[domain] = body.entries ?? {};
                    nextEnv[domain] = body.envOverridden ?? {};
                    nextMeta[domain] = Object.fromEntries(
                        (metaBody.keys ?? []).map((item) => [item.key, item]),
                    );
                    return;
                }
                failedDomains.push(domain);
            });
            layerConfig.value = { ...layerConfig.value, [layer]: nextLayer };
            envOverridden.value = nextEnv;
            layerMeta.value = { ...layerMeta.value, [layer]: nextMeta };
            if (failedDomains.length > 0) {
                const message = `config domains failed to load: ${failedDomains.join(", ")}`;
                error.value = message;
                throw new Error(message);
            }
        } catch (e) {
            error.value =
                error.value ?? (e instanceof Error ? e.message : "Failed to load layer config");
            throw e;
        } finally {
            setLayerLoading(layer, false);
        }
    }

    /** PLAN-0307 T2.17: write one layer/domain through the unified layer endpoint. */
    async function putLayerConfig(
        layer: ConfigLayer,
        domain: string,
        body: Record<string, string>,
    ): Promise<void> {
        await request(`/config/${layer}/${domain}`, {
            method: "PUT",
            body: JSON.stringify(body),
        });
    }

    /**
     * PLAN-0766：清掉某层的一个键（workspace-default 用 `DELETE /config/workspace-default/{domain}/{key}`，
     * 契约 b05aad952 里与 PUT 同批登记；清空后该键回落到 user/instance/code default）。
     */
    async function deleteLayerKey(layer: ConfigLayer, domain: string, key: string): Promise<void> {
        await request(`/config/${layer}/${domain}/${encodeURIComponent(key)}`, {
            method: "DELETE",
        });
    }

    /** PLAN-0554: clear one instance-layer default (falls back to code default). */
    async function deleteInstanceKey(domain: string, key: string): Promise<void> {
        await deleteLayerKey("instance", domain, key);
    }

    /** Admin export (instance layer, T2.21/T2.25). */
    async function exportConfig(includeSecrets: boolean): Promise<string> {
        const data = await request<Record<string, unknown>>(
            `/config/export?layer=instance&includeSecrets=${includeSecrets}`,
        );
        return JSON.stringify(data, null, 2);
    }

    /** Admin import (instance layer, per-domain merge; credentials are never restored). */
    async function importConfig(content: string): Promise<ConfigImportReport> {
        return request<ConfigImportReport>("/config/import?layer=instance", {
            method: "POST",
            body: content,
        });
    }

    /**
     * task-140：工作区智能体列表里的**默认模型**，key = workspaceId。
     *
     * 为什么不用参与者 view 上的 `defaultModelProvider/Name`：那是 CP 联表直读
     * （`SessionParticipantService.java:911-912`），**没有工作区 binding 门**；而真正决定
     * dispatch 的 `AgentPrincipalService#defaultModel` 要求主体在该工作区有 active binding。
     * 用 view 会对着一个"其实没绑上"的默认模型显示来源，所以这里按工作区读一遍
     * `GET /workspaces/{id}/agents`（与 CP 的 binding 门同构），缓存按 workspaceId 隔离
     * （切工作区天然失效，不需要 watch）。
     */
    const workspaceAgentDefaults = ref<
        Record<string, Record<string, { provider: string; model: string } | null>>
    >({});
    const workspaceAgentDefaultsInflight = new Map<string, Promise<void>>();
    /**
     * task-2：按 workspaceId 记"这份主体默认读失败了"。
     *
     * 为什么需要它：`ensureWorkspaceAgentDefaults` 失败时把该工作区写成 `{}`（与"读到但没有默认"
     * 同形），于是 `getChatModelSource` 会把「没读到」判成「主体没有默认」再回落到 profile，
     * 最后甚至可能落在 `none` 显示"未绑定模型" —— 这就是 Lead 说的"取不到来源时不许猜"。
     * 失败面单独记，展示层据此画「来源未知」而不是「没有来源」。
     */
    const workspaceAgentDefaultsFailed = ref<Record<string, boolean>>({});

    function getActiveModel(sessionId: string): SessionModelBinding | undefined {
        return sessionModels.value[sessionId];
    }

    function isChatModelAvailable(provider: string, model: string, connectionId?: string): boolean {
        return getChatModels(provider, connectionId).includes(model);
    }

    /**
     * PLAN-0503: ready + chat-capable models for a provider. An empty
     * `provider` returns the union across providers (config-page candidates
     * when no provider is selected yet).
     */
    function getChatModels(provider: string, connectionId?: string): string[] {
        const entries = connectionId
            ? ([[connectionId, modelCache.value.providers?.[connectionId]]] as const)
            : Object.entries(modelCache.value.providers ?? {});
        return [
            ...new Set(
                entries.flatMap(([catalogKey, catalog]) => {
                    // Legacy provider-keyed catalogs omit providerId; the map key IS the
                    // provider id for that shape. Scoped catalogs carry providerId explicitly.
                    const catalogProvider = catalog?.providerId ?? catalogKey;
                    if (!catalog || catalog.status !== "ready") {
                        return [];
                    }
                    if (provider && catalogProvider !== provider) {
                        return [];
                    }
                    return catalog.models
                        .filter((entry) => entry.capabilities.chat)
                        .map((entry) => entry.name);
                }),
            ),
        ];
    }

    /**
     * task-140：薄兼容层 —— 保留旧名字与旧签名给既有调用方，内部转调唯一解析器。
     *
     * 与旧实现的差异只有一条：**不再用本地模型清单否决来源**（清单只做角标）。
     * 旧实现在 `/models` 缓存过期时会把会话绑定判成不可用，于是 UI 说"未绑定"、CP 却照常
     * 成功发送 —— 展示与事实反了。来源链（会话 → 主体默认 → profile）与 CP 完全一致。
     *
     * 这里不读主体默认（那是 `getChatModelSource` 的职责）：调用方要么已经拿到 store 里的
     * 解析结果，要么只需要"会话或 profile"这一层的兜底值。
     */
    function getEffectiveModel(sessionId: string): SessionModelBinding | undefined {
        const sessionBinding = sessionModels.value[sessionId];
        const profile = parseLlmProfileValue(mergedConfig.value["llm-provider"]?.profile);
        const resolved = resolveChatModelSource({ sessionBinding, profile });
        if (!resolved.provider || !resolved.model) return undefined;
        if (resolved.source === "session" && sessionBinding) return sessionBinding;
        return { provider: resolved.provider, model: resolved.model };
    }

    function setSessionModel(
        sessionId: string,
        provider: string,
        model: string,
        connectionId?: string,
        connectionRevision?: number,
    ) {
        sessionModels.value = {
            ...sessionModels.value,
            [sessionId]: { provider, model, connectionId, connectionRevision },
        };
    }

    /** 读一次工作区智能体默认模型（幂等；失败只记日志 ⇒ 来源回落 profile，不阻塞发送）。 */
    async function ensureWorkspaceAgentDefaults(workspaceId: string | null): Promise<void> {
        if (!workspaceId) return;
        if (workspaceAgentDefaults.value[workspaceId]) return;
        const inflight = workspaceAgentDefaultsInflight.get(workspaceId);
        if (inflight) return inflight;
        const task = (async () => {
            try {
                const agents = await api.getWorkspaceAgents(workspaceId);
                const defaults: Record<string, { provider: string; model: string } | null> = {};
                for (const agent of agents) {
                    const provider = (agent.defaultModelProvider ?? "").trim();
                    const model = (agent.defaultModelName ?? "").trim();
                    defaults[agent.principalId] = provider && model ? { provider, model } : null;
                }
                workspaceAgentDefaults.value = {
                    ...workspaceAgentDefaults.value,
                    [workspaceId]: defaults,
                };
            } catch (cause) {
                // 读面失败 ≠ 主体没有默认：宁可回落 profile 并把失败留在日志里，
                // 也不要把"没读到"渲染成"未绑定"（那正是 task-140 要修的那类假否定）。
                logger.warn(
                    "workspace agent defaults read failed; model source falls back to the profile layer",
                    cause,
                );
                workspaceAgentDefaults.value = {
                    ...workspaceAgentDefaults.value,
                    [workspaceId]: {},
                };
                // task-2：读失败要和"读到但没有默认"分开记，否则下一句就变成猜。
                workspaceAgentDefaultsFailed.value = {
                    ...workspaceAgentDefaultsFailed.value,
                    [workspaceId]: true,
                };
            } finally {
                workspaceAgentDefaultsInflight.delete(workspaceId);
            }
        })();
        workspaceAgentDefaultsInflight.set(workspaceId, task);
        return task;
    }

    /** 主体默认模型被改过后失效（抽屉保存时调用；不传 = 全部失效）。 */
    function invalidateWorkspaceAgentDefaults(workspaceId?: string): void {
        if (!workspaceId) {
            workspaceAgentDefaults.value = {};
            // 失效即作废失败标记：下次 ensure 是一条新的读取，成败都重新记。
            workspaceAgentDefaultsFailed.value = {};
            return;
        }
        const next = { ...workspaceAgentDefaults.value };
        delete next[workspaceId];
        workspaceAgentDefaults.value = next;
        if (workspaceAgentDefaultsFailed.value[workspaceId]) {
            const failedNext = { ...workspaceAgentDefaultsFailed.value };
            delete failedNext[workspaceId];
            workspaceAgentDefaultsFailed.value = failedNext;
        }
    }

    function discoveredChatModels(provider: string | null): string[] | null {
        // 清单未就绪（没有任何 provider catalog）⇒ `null` = 角标未知。
        // 绝不能把"清单还没拉到"当成"清单里没有它"（那会把角标变成假否定）。
        if (!provider || Object.keys(modelCache.value.providers ?? {}).length === 0) return null;
        return getChatModels(provider);
    }

    /**
     * task-140（J1/J4）：**运行期模型来源**的唯一判定入口。
     *
     * 三个消费方（composer chip / SSEStream 发送 / ChatPanel 幂等签名）都读这一份，
     * 解析本身在 `chat/modelDisplay.ts` 的 `resolveChatModelSource`（与 CP 同构）。
     * 这里只做"数据够不够"的判断：名册没到 / 主体默认没读到 ⇒ `loading`，
     * 让调用方知道"现在还不知道"，而不是显示成"没有来源"。
     */
    function getChatModelSource(
        sessionId: string,
        workspaceId: string | null,
    ): ChatModelSourceResolution {
        const roster = useSessionParticipantsStore();
        const participants = roster.participants;
        const principalId = primaryAgentPrincipalId(participants);
        // 第 1 层的数据源顺序：本地镜像（手选/自动回填，含连接与修订号）→ 会话行四列（CP dispatch 的真源）。
        const mirror = sessionModels.value[sessionId];
        const mirrorBound = Boolean(
            (mirror?.provider ?? "").trim() && (mirror?.model ?? "").trim(),
        );
        const row = mirrorBound ? { complete: null, partial: false } : sessionRowBinding(sessionId);
        const sessionBinding = mirrorBound ? mirror : (row.complete ?? mirror);
        const sessionBound = Boolean(
            (sessionBinding?.provider ?? "").trim() && (sessionBinding?.model ?? "").trim(),
        );
        const profile = parseLlmProfileValue(mergedConfig.value["llm-provider"]?.profile);
        const pending = (): ChatModelSourceResolution => ({
            status: "loading",
            provider: null,
            model: null,
            source: "none",
            inDiscoveredList: null,
        });
        // task-2：读失败 = 仍然不知道，**不等于**没有来源。provider/model 一律 null，
        // 由展示层画「来源未知」并指向 explain 面（task-8），绝不回落到下一层去猜。
        const unreadable = (): ChatModelSourceResolution => ({
            status: "unavailable",
            provider: null,
            model: null,
            source: "none",
            inDiscoveredList: null,
        });

        // 会话覆盖优先 ⇒ 名册还没到也不影响答案（它只会影响第 2 步）。
        if (!sessionBound) {
            // 会话行半绑（CP 409 partial_binding）：既不是"没绑"，也不能替 CP 看下一层。
            if (row.partial) return unreadable();
            if (participants === null) {
                // 名册 403/失败 ⇒ To 主体是谁都不知道，第二步无从判定。
                if (roster.forbidden || roster.error) return unreadable();
                return pending();
            }
            if (principalId && workspaceId) {
                // 主体默认模型读失败（不是"读到但没有默认"）⇒ 第二步同样无从判定。
                if (workspaceAgentDefaultsFailed.value[workspaceId]) return unreadable();
                if (!workspaceAgentDefaults.value[workspaceId]) return pending();
            }
        }

        const defaults = workspaceId ? workspaceAgentDefaults.value[workspaceId] : undefined;
        const principalDefault = principalId ? (defaults?.[principalId] ?? null) : null;
        const base = resolveChatModelSource({ sessionBinding, principalDefault, profile });
        const resolved = resolveChatModelSource({
            sessionBinding,
            principalDefault,
            profile,
            discoveredModels: discoveredChatModels(base.provider),
        });
        return { status: "ready", ...resolved };
    }

    /**
     * task-2（J1 同构）：**会话行**的模型绑定 —— 会话覆盖那一层的唯一真源。
     *
     * 为什么必须读会话行、而不是只读 `sessionModels` 本地镜像：CP 的 dispatch 用的是会话行四列
     * （`ChatSubmissionService.java:1110-1122` + `ApiRequestTemplateService.java:637-648`：
     * provider/model/providerConnectionId/connectionRevision 全有 = complete）。
     * 而 `sessionModels` 只在「用户手选模型」或「bind-defaults 自动回填」时才写，
     * 真栈里打开一个历史会话根本不会写它 —— 于是 chip 会跳过第 1 层直接报 `llm-profile`，
     * 与 CP 实际派发的模型相反（实测 8/8 会话：行里是 deepseek/deepseek-chat，chip 却说全局配置）。
     *
     * `partial`：CP 对「四列有值但不全」抛 409 `API_TYPE_REBIND_REQUIRED`（reason=partial_binding），
     * 那不是"没有来源"也不是"看下一层" —— 判定为不可知，绝不回落到主体默认/profile 去猜。
     *
     * **判据只用三列（provider/model/providerConnectionId），不看 connectionRevision**：
     * 会话列表投影不返回该列（实测 `GET /api/v1/sessions` 每行只有前三列，参
     * `stores/session.ts` 的 toSession 与 `ChatPanel.vue:107-115` BL-270 同类投影缺口）。
     * 若照 CP 的四列判据，真栈里每个已绑会话都会被判成 partial ⇒ 全部显示"未绑定"，
     * 比现状更假。因此：三列齐 = 会话覆盖（已足够回答"这层有没有绑定"），
     * partial 只认"三列部分有值"。与 CP 四列判据的偏差登记在此，不做静默对齐。
     */
    function sessionRowBinding(sessionId: string): {
        complete: { provider: string; model: string } | null;
        partial: boolean;
    } {
        const row = useSessionStore().sessions.find((item) => item.id === sessionId);
        if (!row) return { complete: null, partial: false };
        const provider = (row.modelProvider ?? "").trim();
        const model = (row.modelName ?? "").trim();
        const connectionId = (row.providerConnectionId ?? "").trim();
        const complete = Boolean(provider && model && connectionId);
        return {
            complete: complete ? { provider, model } : null,
            partial: !complete && Boolean(provider || model || connectionId),
        };
    }

    /** 幂等补齐 `getChatModelSource` 需要的数据（名册 + 工作区主体默认）。 */
    async function ensureChatModelSource(
        sessionId: string,
        workspaceId: string | null,
    ): Promise<void> {
        if (!sessionId) return;
        const roster = useSessionParticipantsStore();
        await roster.ensureLoaded(sessionId);
        if (workspaceId && primaryAgentPrincipalId(roster.participants)) {
            await ensureWorkspaceAgentDefaults(workspaceId);
        }
    }

    function toggleFavorite(provider: string, model: string) {
        const idx = modelFavorites.value.findIndex(
            (f) => f.provider === provider && f.model === model,
        );
        if (idx >= 0) {
            modelFavorites.value = modelFavorites.value.filter((_, i) => i !== idx);
        } else {
            modelFavorites.value = [...modelFavorites.value, { provider, model }];
        }
    }

    function isFavorite(provider: string, model: string): boolean {
        return modelFavorites.value.some((f) => f.provider === provider && f.model === model);
    }

    function clearForUserSwitch() {
        mergedConfig.value = {};
        modelCache.value = { models: {}, providers: {} };
        sessionModels.value = {};
        modelFavorites.value = [];
        modelError.value = null;
        layerConfig.value = { instance: {}, "workspace-default": {}, workspace: {}, user: {} };
        envOverridden.value = {};
        layerMeta.value = { instance: {}, "workspace-default": {}, workspace: {}, user: {} };
        providerConnections.value = [];
        providerConnectionsLoaded.value = false;
        providerConnectionsError.value = false;
        // task-140：主体默认模型是"某个工作区里某个主体的"数据，换用户必须一起丢。
        workspaceAgentDefaults.value = {};
        workspaceAgentDefaultsFailed.value = {};
        workspaceAgentDefaultsInflight.clear();
    }

    async function fetchModels() {
        try {
            modelError.value = null;
            const data = await request<{
                models?: Record<string, string[]>;
                providers?: typeof modelCache.value.providers;
                configRevision?: string;
            }>("/models");
            modelCache.value = {
                models: data.models ?? {},
                providers: data.providers ?? {},
                configRevision: data.configRevision,
                lastFetched: Date.now(),
            };
        } catch (e) {
            modelError.value = e instanceof Error ? e.message : "Failed to fetch models";
        }
    }

    return {
        mergedConfig,
        loading,
        error,
        layerConfig,
        layerLoading,
        layerLoadingByLayer,
        isLayerLoading,
        envOverridden,
        layerMeta,
        modelError,
        modelCache,
        modelFavorites,
        providerConnections,
        providerConnectionsLoaded,
        providerConnectionsError,
        loadProviderConnections,
        invalidateProviderConnections,
        fetchDomain,
        loadAllDomains,
        loadLayerDomains,
        putLayerConfig,
        deleteInstanceKey,
        exportConfig,
        importConfig,
        getActiveModel,
        getEffectiveModel,
        getChatModelSource,
        ensureChatModelSource,
        ensureWorkspaceAgentDefaults,
        invalidateWorkspaceAgentDefaults,
        findProviderForModel,
        isChatModelAvailable,
        getChatModels,
        setSessionModel,
        toggleFavorite,
        isFavorite,
        clearForUserSwitch,
        fetchModels,
    };
});
