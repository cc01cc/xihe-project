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
 * UI 可读写的配置层。task-253（用户 2026-11-10 裁定）：**移除 per-workspace layer** ——
 * 全局设置不再有 workspace 层，工作区内部设置本轮不设计、也不再走全局 config 的 workspace 层。
 * 这里收窄不是文档美化：任何还想传 "workspace" 的调用点会在 typecheck 当场失败，
 * 是「彻底移除」的编译期保证（契约侧由 task-250 只标 deprecated，不删）。
 *
 * PLAN-0766（D-928/D-931，task-160）：新增的是**共享的 workspace-default 层**，不是
 * per-workspace 层。wire 值小写 `workspace-default`（契约 b05aad952: GET
 * `/config/{domain}?layer=workspace-default`、`PUT /config/workspace-default/{domain}`）。
 * 它是部署级的一份行集，对没有显式 workspace 覆盖的所有工作区生效；层序
 * workspace > workspace-default > user > instance（env / 管理员钉仍在所有 DB 层之上）。
 */
export type ConfigLayer = "instance" | "workspace-default" | "user";

/**
 * 配置值的**来源**（GET /config/{domain}/meta 回填的 provenance），与上面的层**不是同一个轴**：
 * CP 仍可能报 source=workspace（历史行、或 CP 侧其它写入口），UI 只负责如实显示它。
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

export const LAYER_DOMAINS: Record<ConfigLayer, readonly ConfigDomain[]> = {
    instance: INSTANCE_DOMAINS,
    // PLAN-0766：CP `WORKSPACE_WRITABLE_DOMAINS` 是 9 域（b05aad952 ConfigService.java:94），
    // 但 `context-templates` 是 service-only 域 —— 契约明写 config API 只收 12 个 UI 域，
    // 其余（context-templates / pricing）返回 INVALID_DOMAIN。所以 UI 侧矩阵是 9 − 1 = 8 域，
    // 这里刻意不列 context-templates，避免左栏出现一个点进去必然失败的入口。
    "workspace-default": [
        "llm-provider",
        "context-policy",
        "embedding",
        "rag",
        "agent-runtime",
        "approval-policy",
        "agent-templates",
        "job-policy",
    ],
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

    /** Per-layer raw entries for the two settings entries (T2.17; task-253 去掉 workspace). */
    const layerConfig = ref<Record<ConfigLayer, Record<string, Record<string, string>>>>({
        instance: {},
        "workspace-default": {},
        user: {},
    });
    const layerLoading = ref(false);
    /** domain -> key -> env-effective value when an env overlay wins (decision #22). */
    const envOverridden = ref<Record<string, Record<string, string>>>({});
    /** PLAN-0554: layer -> domain -> key -> provenance metadata. */
    const layerMeta = ref<Record<ConfigLayer, Record<string, Record<string, ConfigKeyMeta>>>>({
        instance: {},
        "workspace-default": {},
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
     * PLAN-0573: `isAdmin` bypasses the non-admin domain filter (full
     * CONFIG_DOMAINS pull, admin behavior unchanged); non-admin callers omit
     * it so domains CP rejects with 403 are never requested.
     */
    async function loadAllDomains(options?: { isAdmin?: boolean }) {
        loading.value = true;
        error.value = null;
        const domains = options?.isAdmin
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

    /**
     * PLAN-0307 T2.17: load one layer's entries for all writable domains of that
     * layer, together with the env-lock metadata (`includeMeta=true`).
     */
    async function loadLayerDomains(layer: ConfigLayer): Promise<void> {
        layerLoading.value = true;
        error.value = null;
        try {
            const domains = LAYER_DOMAINS[layer];
            const results = await Promise.all(
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
            for (const { domain, body, metaBody } of results) {
                nextLayer[domain] = body.entries ?? {};
                nextEnv[domain] = body.envOverridden ?? {};
                nextMeta[domain] = Object.fromEntries(
                    (metaBody.keys ?? []).map((item) => [item.key, item]),
                );
            }
            layerConfig.value = { ...layerConfig.value, [layer]: nextLayer };
            envOverridden.value = nextEnv;
            layerMeta.value = { ...layerMeta.value, [layer]: nextMeta };
        } catch (e) {
            error.value = e instanceof Error ? e.message : "Failed to load layer config";
            throw e;
        } finally {
            layerLoading.value = false;
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
        layerConfig.value = { instance: {}, "workspace-default": {}, user: {} };
        envOverridden.value = {};
        layerMeta.value = { instance: {}, "workspace-default": {}, user: {} };
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
