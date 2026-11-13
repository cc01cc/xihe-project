import { defineStore } from "pinia";
import { ref } from "vue";
import { useLocalStorage } from "@vueuse/core";
import { type ModelCache } from "../types/provider";
import type { SessionModelBinding, ModelFavorite } from "../types";
import type { ProviderConnection } from "../types/providerConnection";
import { request } from "../composables/api";
import { listProviderConnections } from "../services/providerConnectionService";
import { parseLlmProfileValue } from "../services/llmProviderProfile";

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
 * `WORKSPACE_WRITABLE_DOMAINS` 已是 5 域（4 个行为域 + service-only 的 `context-templates`），
 * 通用 config API 只能服务 12 个 UI 域 ⇒ `WORKSPACE_DEFAULT_WRITABLE` = 交集 = **4 域**
 * （`ConfigService.java:115-118`）。这里列的就是那 4 域，**逐域与 CP 派生集对齐**
 * （判据：`stores/__tests__/configStore.spec.ts` 的矩阵事实断言 + 本文件无 5 域残留）。</p>
 */
const GENERIC_WORKSPACE_DOMAINS = [
    "agent-runtime",
    "approval-policy",
    "agent-templates",
    "job-policy",
] as const;

export const LAYER_DOMAINS: Record<ConfigLayer, readonly ConfigDomain[]> = {
    instance: INSTANCE_DOMAINS,
    // T2.4 后 CP `WORKSPACE_WRITABLE_DOMAINS` 是 5 域，其中 `context-templates` 是 service-only
    // （契约明写 config API 只收 12 个 UI 域，其余返回 INVALID_DOMAIN）⇒ 交集 4 域。
    // 刻意不列 context-templates：列了就是左栏出现一个点进去必然失败的入口。
    "workspace-default": GENERIC_WORKSPACE_DOMAINS,
    // PLAN-0773 M4-1：**per-workspace 层**与 `workspace-default` 用的是**同一张 4 域矩阵**，
    // 且共用同一个数组常量 —— 不是巧合，是同一个 CP 常量 `WORKSPACE_WRITABLE_DOMAINS` 的两个落库面：
    // 一个写"某一工作区自己的行"，一个写"没显式覆盖时的部署级默认行"。分成两份数组等于
    // 允许两层的可写域集漂移（今天相同、明天有人只改一处），而契约里它们是**同一个集合**。
    workspace: GENERIC_WORKSPACE_DOMAINS,
    user: [
        "llm-provider",
        "context-policy",
        "embedding",
        "rag",
        "agent-runtime",
        "agent-profile",
        "user-preference",
        "agent-templates",
        "api-request-templates",
    ],
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

    function getEffectiveModel(sessionId: string): SessionModelBinding | undefined {
        const sessionBinding = sessionModels.value[sessionId];
        // PLAN-0503 review P2: legacy migrated bindings may carry provider "" —
        // availability is unverifiable for them, so fall through to the merged
        // defaults (restores the pre-union semantics for that population).
        if (
            sessionBinding?.provider &&
            isChatModelAvailable(
                sessionBinding.provider,
                sessionBinding.model,
                sessionBinding.connectionId,
            )
        ) {
            return sessionBinding;
        }

        // PLAN-0504: the default identity is the whole resolved profile unit.
        // With no profile there is no implicit fallback model (decision #10) —
        // callers prompt for an explicit selection instead.
        const profile = parseLlmProfileValue(mergedConfig.value["llm-provider"]?.profile);
        if (profile && isChatModelAvailable(profile.providerId, profile.model)) {
            return { provider: profile.providerId, model: profile.model };
        }

        return undefined;
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
