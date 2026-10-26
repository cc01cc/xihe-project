<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { logger } from "../../lib/logger";
import { ApiError, request } from "../../composables/api";
import type { ProviderCatalog, CatalogModel, ModelPricing } from "../../types/provider";
import { parseLlmProfileValue } from "../../services/llmProviderProfile";
import { Search } from "@lucide/vue";
import {
    createProviderConnection,
    deleteProviderConnection,
    listProviderCatalog,
    updateProviderConnection,
    verifyProviderConnection,
    getConnectionTypeImpact,
    getDeleteImpact,
    type ConnectionTypeImpact,
    type DeleteImpact,
} from "../../services/providerConnectionService";
import { useConfigStore } from "../../stores/config";
import {
    listVisibleTemplates,
    readTemplateConfig,
    templateKey,
    type TemplateOption,
    type TemplateRef,
} from "../../services/apiRequestTemplates";
import type {
    ProviderConnection,
    ProviderConnectionInput,
    ProviderDefinition,
    ProviderScope,
} from "../../types/providerConnection";

const props = withDefaults(
    defineProps<{
        scope: ProviderScope;
        workspaceId?: string;
        readonly?: boolean;
    }>(),
    {
        readonly: false,
    },
);

const { t } = useI18n();

// PLAN-0523 T3.5: single-source connection list lives in the config store.
const configStore = useConfigStore(),
    providers = ref<ProviderDefinition[]>([]),
    connections = computed<ProviderConnection[]>(() => configStore.providerConnections),
    search = ref("");

// PLAN-0523 T3.2: layer-scope default identity (profile) and per-model
// sampling params, both read/written on the current scope layer's
// llm-provider domain. The default connection is pinned to the top of the
// list; a stored profile whose connection is no longer visible renders as an
// amber "kept" entry (drift, spec/ui-surfaces.md S2).
const currentLayer = computed<"user" | "workspace">(() =>
        props.scope === "USER" ? "user" : "workspace",
    ),
    layerLlmEntries = computed<Record<string, string>>(
        () => configStore.layerConfig[currentLayer.value]?.["llm-provider"] ?? {},
    ),
    storedProfile = computed(() => parseLlmProfileValue(layerLlmEntries.value.profile)),
    defaultConnection = computed(() => {
        const profile = storedProfile.value;
        if (!profile) return null;
        return (
            connections.value.find(
                (item) =>
                    item.providerId === profile.providerId &&
                    item.connectionKey === profile.connectionKey,
            ) ?? null
        );
    }),
    driftedProfile = computed(() =>
        storedProfile.value && !defaultConnection.value ? storedProfile.value : null,
    );
const loading = ref(false),
    modalOpen = ref(false),
    formOpen = ref(false);
const selectedProvider = ref<ProviderDefinition | null>(null),
    editingConnection = ref<ProviderConnection | null>(null);
const formScope = ref<"USER" | "WORKSPACE">("USER"),
    saving = ref(false),
    verifyingId = ref<string | null>(null);
const pickerSearch = ref("");
const selectedConnectionId = ref<string | null>(null);
const modelCatalogs = ref<Record<string, ProviderCatalog>>({});
const modelsError = ref(false);
const templateOptions = ref<TemplateOption[]>([]);
const ownerTemplateEntries = ref<Record<string, string>>({});
const userTemplateEntries = ref<Record<string, string>>({});
const bindingBusy = ref(false);
const typeImpact = ref<ConnectionTypeImpact | null>(null);
const confirmedTypeChange = ref(false);
const targetDefaultKey = ref("");
function parseMap<T>(source?: string): Record<string, T> {
    if (!source) return {};
    try {
        return JSON.parse(source) as Record<string, T>;
    } catch (cause) {
        logger.warn("Invalid template binding configuration", cause);
        return {};
    }
}
const connectionDefaults = computed(() =>
    parseMap<TemplateRef>(ownerTemplateEntries.value.connectionDefaultTemplates),
);
const modelBindings = computed(() =>
    parseMap<Record<string, TemplateRef>>(userTemplateEntries.value.providerModelBindings),
);
const activeTemplates = computed(() =>
    templateOptions.value.filter(
        (item) =>
            item.apiTypeId === activeConnection.value?.apiTypeId &&
            item.apiTypeVersion === activeConnection.value?.apiTypeVersion,
    ),
);
const formType = computed(() =>
    selectedProvider.value?.supportedApiTypes.find(
        (item) => item.apiTypeId + "@" + item.version === form.apiType,
    ),
);
const formOperation = computed(
    () =>
        apiInputTypes.value.find(
            (item) =>
                item.apiTypeId === formType.value?.apiTypeId &&
                item.version === formType.value?.version,
        )?.operation,
);
const apiInputTypes = ref<import("../../types/providerConnection").ApiInputType[]>([]);
const formTemplates = computed(() =>
    templateOptions.value.filter(
        (item) =>
            item.apiTypeId === formType.value?.apiTypeId &&
            item.apiTypeVersion === formType.value?.version,
    ),
);
function refOnly(item: TemplateRef): TemplateRef {
    return { layer: item.layer, templateId: item.templateId, version: item.version };
}
function currentDefaultKey() {
    const connection = activeConnection.value;
    const ref = connection && connectionDefaults.value[connection.id];
    return ref ? templateKey(ref) : "";
}
function currentModelKey(model: string) {
    const ref = activeConnection.value && modelBindings.value[activeConnection.value.id]?.[model];
    return ref ? templateKey(ref) : "";
}
async function saveBinding(model: string | null, value: string) {
    const connection = activeConnection.value;
    if (!connection || bindingBusy.value || props.readonly) return;
    const option = activeTemplates.value.find((item) => templateKey(item) === value);
    if (value && !option) return;
    bindingBusy.value = true;
    try {
        const layer =
            model === null ? (connection.scope === "USER" ? "user" : "workspace") : "user";
        const entries = await readTemplateConfig(
            layer,
            connection.workspaceId ?? props.workspaceId,
        );
        if (model === null) {
            const refs = parseMap<TemplateRef>(entries.connectionDefaultTemplates);
            if (option) refs[connection.id] = refOnly(option);
            else delete refs[connection.id];
            entries.connectionDefaultTemplates = JSON.stringify(refs);
        } else {
            const refs = parseMap<Record<string, TemplateRef>>(entries.providerModelBindings);
            const models = { ...refs[connection.id] };
            if (option) models[model] = refOnly(option);
            else delete models[model];
            if (Object.keys(models).length) refs[connection.id] = models;
            else delete refs[connection.id];
            entries.providerModelBindings = JSON.stringify(refs);
        }
        const workspaceId = connection.workspaceId ?? props.workspaceId;
        const query =
            layer === "workspace" && workspaceId
                ? `?workspaceId=${encodeURIComponent(workspaceId)}`
                : "";
        await request(`/config/${layer}/api-request-templates${query}`, {
            method: "PUT",
            body: JSON.stringify(entries),
        });
        if (activeConnection.value?.id !== connection.id) return;
        if (model === null) ownerTemplateEntries.value = entries;
        else userTemplateEntries.value = entries;
    } catch (cause) {
        logger.warn("Template binding save failed", cause);
        toast.error(
            cause instanceof Error
                ? cause.message
                : t("settings.providerHub.toastTemplateBindingFailed"),
        );
    } finally {
        bindingBusy.value = false;
    }
}

// PLAN-0523 T3.2: in-place default identity + per-model sampling params.
const savingDefault = ref(false),
    savingParams = ref(false),
    expandedModel = ref<string | null>(null),
    paramDrafts = reactive<
        Record<
            string,
            { maxTokens: string | number; temperature: string | number; timeout: string | number }
        >
    >({});

/** Chat models usable as the layer default model for a connection. */
function chatModelsOf(connection: ProviderConnection): string[] {
    const catalog = modelCatalogs.value[connection.id],
        models = catalog?.connectionId === connection.id ? catalog.models : [],
        chat = models.filter((model) => model.capabilities?.chat).map((model) => model.name);
    if (chat.length) return chat;
    return connection.operation === "chat" && connection.modelDiscovery === "manual"
        ? connection.manualModels
        : [];
}

/**
 * 就地设定默认连接（列表项「设为默认」）。模型取 stored（若存在于该连接
 * 目录）否则目录首个 chat 模型；无可用模型则拒绝写入（T3.2 实施语义）。
 * modelOverride pins a specific model (默认模型置顶行)。
 */
async function setAsDefault(connection: ProviderConnection, modelOverride?: string) {
    if (props.readonly || savingDefault.value) return;
    const models = chatModelsOf(connection),
        profile = storedProfile.value,
        model =
            modelOverride ??
            (profile && models.includes(profile.model) ? profile.model : models[0]);
    if (!model) {
        toast.error(t("settings.providerHub.toastNoModel"));
        return;
    }
    savingDefault.value = true;
    try {
        await configStore.putLayerConfig(
            currentLayer.value,
            "llm-provider",
            {
                ...layerLlmEntries.value,
                profile: JSON.stringify({
                    providerId: connection.providerId,
                    connectionKey: connection.connectionKey,
                    model,
                }),
            },
            props.workspaceId,
        );
        await configStore.loadLayerDomains(currentLayer.value, props.workspaceId);
        toast.success(
            modelOverride
                ? t("settings.providerHub.toastDefaultModelUpdated")
                : t("settings.providerHub.toastDefaultConnectionUpdated"),
        );
    } catch (cause) {
        logger.warn("Set default failed", cause);
        toast.error(
            cause instanceof Error
                ? cause.message
                : t("settings.providerHub.toastDefaultUpdateFailed"),
        );
    } finally {
        savingDefault.value = false;
    }
}

interface ModelSamplingParams {
    maxTokens?: number;
    temperature?: number;
    timeout?: number;
}
/** 当前层 `modelParams` 整域 map（模型名 → 采样参数）。 */
const storedModelParams = computed<Record<string, ModelSamplingParams>>(() => {
    try {
        const parsed: unknown = JSON.parse(layerLlmEntries.value.modelParams ?? "{}");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        return parsed as Record<string, ModelSamplingParams>;
    } catch {
        return {};
    }
});
function toggleModel(model: string) {
    if (expandedModel.value === model) {
        expandedModel.value = null;
        return;
    }
    expandedModel.value = model;
    const stored = storedModelParams.value[model] ?? {};
    paramDrafts[model] = {
        maxTokens: stored.maxTokens?.toString() ?? "",
        temperature: stored.temperature?.toString() ?? "",
        timeout: stored.timeout?.toString() ?? "",
    };
}
/** 每模型参数配置就地保存：整域 map 合并该模型项后写回当前层。 */
async function saveModelParams(model: string) {
    if (props.readonly || savingParams.value) return;
    const draft = paramDrafts[model];
    if (!draft) return;
    const parse = (raw: string | number): number | undefined => {
        const trimmed = String(raw).trim();
        if (!trimmed) return undefined;
        const value = Number(trimmed);
        return Number.isFinite(value) ? value : undefined;
    };
    savingParams.value = true;
    try {
        await configStore.putLayerConfig(
            currentLayer.value,
            "llm-provider",
            {
                ...layerLlmEntries.value,
                modelParams: JSON.stringify({
                    ...storedModelParams.value,
                    [model]: {
                        maxTokens: parse(draft.maxTokens),
                        temperature: parse(draft.temperature),
                        timeout: parse(draft.timeout),
                    },
                }),
            },
            props.workspaceId,
        );
        await configStore.loadLayerDomains(currentLayer.value, props.workspaceId);
        toast.success(t("settings.providerHub.toastParamsSaved"));
    } catch (cause) {
        logger.warn("Model params save failed", cause);
        toast.error(
            cause instanceof Error
                ? cause.message
                : t("settings.providerHub.toastParamsSaveFailed"),
        );
    } finally {
        savingParams.value = false;
    }
}

// T3.3 详情格式化（缺省「未知」）。
function formatModalities(modalities?: string[]): string {
    return modalities?.length ? modalities.join(" / ") : t("settings.providerHub.unknown");
}
function formatTokenCount(value?: number): string {
    return value === undefined ? t("settings.providerHub.unknown") : value.toLocaleString();
}
function formatPricing(pricing?: ModelPricing): string {
    if (!pricing) return t("settings.providerHub.unknown");
    return t("settings.providerHub.pricingFormat", {
        currency: pricing.currency,
        input: pricing.input,
        unit: pricing.unit,
        output: pricing.output,
    });
}

const connectionGroups = computed(() => {
    const query = search.value.trim().toLowerCase();
    const groups = new Map<string, ProviderConnection[]>();
    for (const connection of connections.value) {
        // T3.2: the default connection renders pinned above the groups.
        if (defaultConnection.value && connection.id === defaultConnection.value.id) continue;
        if (
            query &&
            !`${providerName(connection.providerId)} ${connection.connectionKey} ${connection.label} ${connection.scope}`
                .toLowerCase()
                .includes(query)
        )
            continue;
        const items = groups.get(connection.providerId) ?? [];
        items.push(connection);
        groups.set(connection.providerId, items);
    }
    return Array.from(groups, ([providerId, items]) => ({ providerId, items }));
});
const activeConnection = computed(() => {
    const visible = connectionGroups.value.flatMap((group) => group.items),
        pinned = defaultConnection.value,
        pool = pinned ? [pinned, ...visible] : visible;
    return pool.find((connection) => connection.id === selectedConnectionId.value) ?? pool[0];
});
const isDefaultConnectionActive = computed(
    () => !!defaultConnection.value && activeConnection.value?.id === defaultConnection.value.id,
);
const activeModels = computed(() => {
    const connection = activeConnection.value;
    if (!connection) return [];
    const catalog = modelCatalogs.value[connection.id];
    if (catalog?.connectionId === connection.id) return catalog.models.map((model) => model.name);
    return connection.modelDiscovery === "manual" ? connection.manualModels : [];
});
/**
 * PLAN-0523 T3.2: on the default connection the profile model is pinned to
 * the top of the model list; a stored model missing from the catalog is kept
 * as a drifted row (amber), never auto-rewritten.
 */
const displayModels = computed(() => {
    const models = [...activeModels.value];
    if (!isDefaultConnectionActive.value) return models;
    const pinnedModel = storedProfile.value?.model,
        index = models.indexOf(pinnedModel ?? "");
    if (pinnedModel && index > 0) {
        models.splice(index, 1);
        models.unshift(pinnedModel);
    } else if (pinnedModel && index === -1) {
        models.unshift(pinnedModel);
    }
    return models;
});
/** T3.3: per-model catalog metadata (absent = unknown → 未知). */
const activeModelDetails = computed<Record<string, CatalogModel>>(() => {
    const connection = activeConnection.value;
    if (!connection) return {};
    const catalog = modelCatalogs.value[connection.id];
    if (catalog?.connectionId !== connection.id) return {};
    return Object.fromEntries(catalog.models.map((model) => [model.name, model]));
});
function isDefaultModel(model: string): boolean {
    return isDefaultConnectionActive.value && storedProfile.value?.model === model;
}
function isDriftedDefaultModel(model: string): boolean {
    return isDefaultModel(model) && !!activeConnection.value && !activeModels.value.includes(model);
}
/**
 * PLAN-0503 T2.6 (I4): models with a stored template binding that are not in
 * the current catalog must stay visible (never rendered as an absent row);
 * the binding is kept and can be cleared by the user, never auto-deleted.
 */
const orphanModels = computed(() => {
    const connection = activeConnection.value;
    if (!connection) return [];
    const bound = Object.keys(modelBindings.value[connection.id] ?? {});
    const active = new Set(activeModels.value);
    return bound.filter((model) => !active.has(model));
});
/**
 * PLAN-0503 review P2: a directory fetch failure means availability is
 * unknown, not "gone" — never nudge clearing in that state, and only mention
 * clearing when the row actually has the control (chat connections).
 */
const orphanNotice = computed(() => {
    if (modelsError.value) return t("settings.providerHub.orphanNoticeError");
    return activeConnection.value?.operation === "chat"
        ? t("settings.providerHub.orphanNoticeChat")
        : t("settings.providerHub.orphanNoticeOther");
});

/** T3.2: 离开连接时收起展开行，避免参数草稿串连接。 */
watch(
    () => activeConnection.value?.id,
    () => {
        expandedModel.value = null;
    },
);

watch(
    () => [activeConnection.value?.id, props.workspaceId] as const,
    async ([id]) => {
        const connection = activeConnection.value;
        if (!id || !connection) return;
        try {
            const [options, owner, user] = await Promise.all([
                listVisibleTemplates(connection.workspaceId ?? props.workspaceId),
                readTemplateConfig(
                    connection.scope === "USER" ? "user" : "workspace",
                    connection.workspaceId ?? props.workspaceId,
                ),
                readTemplateConfig("user"),
            ]);
            if (activeConnection.value?.id !== id) return;
            templateOptions.value = options;
            ownerTemplateEntries.value = owner;
            userTemplateEntries.value = user;
        } catch (cause) {
            logger.warn("Connection templates load failed", cause);
            toast.error(t("settings.providerHub.toastTemplatesLoadFailed"));
        }
    },
);

async function loadModels() {
    try {
        const data = await request<{ providers?: Record<string, ProviderCatalog> }>("/models");
        modelCatalogs.value = data.providers ?? {};
        modelsError.value = false;
    } catch (cause: unknown) {
        modelCatalogs.value = {};
        modelsError.value = true;
        logger.warn("Provider Hub models load failed", cause);
    }
}

const form = reactive({
    label: "",
    apiKey: "",
    baseUrl: "",
    connectionKey: "default",
    modelDiscovery: "remote-models" as ProviderDefinition["modelDiscovery"],
    manualModels: "",
    apiType: "",
});

const connectedProviderIds = computed(
    () => new Set(connections.value.map((connection) => connection.providerId)),
);

const needsKeyConnections = computed(() =>
    connections.value.filter((connection) => {
        const provider = providers.value.find((item) => item.id === connection.providerId);
        return !connection.hasKey && provider?.credential.required !== false;
    }),
);

function providerName(providerId: string): string {
    return (
        providers.value.find((provider) => provider.id === providerId)?.displayName ?? providerId
    );
}

function adapterLabel(provider: ProviderDefinition): string {
    return {
        "native-litellm": t("settings.providerHub.adapterNative"),
        "openai-compatible": t("settings.providerHub.adapterOpenAi"),
        "manual-model": t("settings.providerHub.adapterManual"),
    }[provider.adapter];
}

const selectableProviders = computed(() => {
    const query = pickerSearch.value.trim().toLowerCase();
    return providers.value
        .filter(() => !props.readonly)
        .filter((provider) => {
            if (!query) return true;
            return `${provider.displayName} ${provider.id} ${provider.description ?? ""}`
                .toLowerCase()
                .includes(query);
        });
});

function pickerGroupLabel(provider: ProviderDefinition): string {
    // PLAN-0364 M4：按协议族（catalog adapter）一级分组，未来可加组（如 Anthropic）。
    if (provider.adapter === "openai-compatible") return t("settings.providerHub.groupOpenAi");
    if (provider.adapter === "native-litellm") return t("settings.providerHub.groupNative");
    return t("settings.providerHub.groupLocal");
}

const pickerGroups = computed(() => {
    const groups: Array<{ label: string; items: ProviderDefinition[] }> = [],
        labels = [
            t("settings.providerHub.groupNative"),
            t("settings.providerHub.groupOpenAi"),
            t("settings.providerHub.groupLocal"),
        ];
    for (const label of labels) {
        const items = selectableProviders.value.filter(
            (provider) => pickerGroupLabel(provider) === label,
        );
        if (items.length > 0) groups.push({ label, items });
    }
    return groups;
});

function statusLabel(status: ProviderConnection["status"]): string {
    return {
        READY: t("settings.providerHub.statusReady"),
        VERIFYING: t("settings.providerHub.statusVerifying"),
        INVALID_CREDENTIALS: t("settings.providerHub.statusInvalidCredentials"),
        UNREACHABLE: t("settings.providerHub.statusUnreachable"),
        DISABLED: t("settings.providerHub.statusDisabled"),
        UNVERIFIED: t("settings.providerHub.statusUnverified"),
    }[status];
}

function statusClass(status: ProviderConnection["status"]): string {
    if (status === "READY") return "text-emerald-600 dark:text-emerald-400";
    if (status === "VERIFYING") return "text-amber-600 dark:text-amber-400";
    if (status === "INVALID_CREDENTIALS" || status === "UNREACHABLE")
        return "text-red-600 dark:text-red-400";
    return "text-muted-foreground";
}

function formatVerifiedAt(value?: string | null): string {
    if (!value) return t("settings.providerHub.neverVerified");
    const time = new Date(value);
    if (Number.isNaN(time.getTime())) return t("settings.providerHub.neverVerified");
    const diff = Date.now() - time.getTime();
    if (diff < 60_000) return t("settings.providerHub.justVerified");
    if (diff < 3_600_000)
        return t("settings.providerHub.minutesAgo", { count: Math.floor(diff / 60_000) });
    if (diff < 86_400_000)
        return t("settings.providerHub.hoursAgo", { count: Math.floor(diff / 3_600_000) });
    return t("settings.providerHub.daysAgo", { count: Math.floor(diff / 86_400_000) });
}

function resetForm(provider: ProviderDefinition, connection?: ProviderConnection) {
    selectedProvider.value = provider;
    editingConnection.value = connection ?? null;
    formScope.value = connection?.scope ?? props.scope;
    form.label =
        connection?.label ??
        t("settings.providerHub.connectionNameFallback", { name: provider.displayName });
    form.apiKey = "";
    form.apiType =
        (connection?.apiTypeId ?? provider.defaultApiType.apiTypeId) +
        "@" +
        (connection?.apiTypeVersion ?? provider.defaultApiType.version);
    typeImpact.value = null;
    confirmedTypeChange.value = false;
    targetDefaultKey.value = "";
    const pair = provider.supportedApiTypes.find(
        (item) =>
            item.apiTypeId === (connection?.apiTypeId ?? provider.defaultApiType.apiTypeId) &&
            item.version === (connection?.apiTypeVersion ?? provider.defaultApiType.version),
    );
    form.baseUrl =
        connection?.baseUrl ??
        (pair?.defaultBaseUrl !== undefined ? pair.defaultBaseUrl : provider.defaultBaseUrl) ??
        "";
    form.connectionKey = connection?.connectionKey ?? "default";
    form.modelDiscovery =
        connection?.modelDiscovery ?? pair?.modelDiscovery ?? provider.modelDiscovery;
    form.manualModels = connection?.manualModels.join("\n") ?? "";
}

async function previewTypeChange() {
    const connection = editingConnection.value;
    const pair = formType.value;
    typeImpact.value = null;
    confirmedTypeChange.value = false;
    targetDefaultKey.value = "";
    if (!pair) return;
    form.baseUrl = pair.defaultBaseUrl ?? selectedProvider.value?.defaultBaseUrl ?? "";
    form.modelDiscovery = pair.modelDiscovery ?? selectedProvider.value?.modelDiscovery ?? "manual";
    try {
        if (connection) {
            const impact = await getConnectionTypeImpact(
                connection.id,
                pair.apiTypeId,
                pair.version,
            );
            if (editingConnection.value?.id !== connection.id || formType.value !== pair) return;
            typeImpact.value = impact;
        }
        const options = await listVisibleTemplates(connection?.workspaceId ?? props.workspaceId);
        if (formType.value !== pair) return;
        templateOptions.value = options;
    } catch (cause) {
        logger.warn("Connection Type impact failed", cause);
        toast.error(
            cause instanceof Error ? cause.message : t("settings.providerHub.toastImpactFailed"),
        );
    }
}

function openPicker() {
    if (props.readonly) return;
    pickerSearch.value = "";
    modalOpen.value = true;
}

function openConnect(provider: ProviderDefinition) {
    modalOpen.value = false;
    resetForm(provider);
    formOpen.value = true;
}

function openManage(connection: ProviderConnection) {
    if (props.readonly) return;
    const provider = providers.value.find((item) => item.id === connection.providerId);
    if (provider) {
        resetForm(provider, connection);
        formOpen.value = true;
    }
}

function closeForm() {
    if (saving.value) return;
    formOpen.value = false;
    selectedProvider.value = null;
    editingConnection.value = null;
    form.apiKey = "";
}

async function load() {
    loading.value = true;
    try {
        const catalog = await listProviderCatalog();
        // Defensive: a malformed/partial response must not leave undefined state
        // (template and computed read `.length`/`.map`).
        providers.value = catalog.providers ?? [];
        await configStore.loadProviderConnections();
        // T3.2: profile / modelParams live on the current layer's llm-provider domain.
        // Non-fatal: a config-backend hiccup must not block connection/model loading.
        try {
            await configStore.loadLayerDomains(currentLayer.value, props.workspaceId);
        } catch (cause) {
            logger.warn("Layer config load failed", cause);
        }
        try {
            const typeList = await request<{
                types: import("../../types/providerConnection").ApiInputType[];
            }>("/api-input-types");
            apiInputTypes.value = typeList.types ?? [];
        } catch (cause) {
            logger.warn("API Type metadata load failed", cause);
            apiInputTypes.value = [];
        }
        if (!connections.value.some((connection) => connection.id === selectedConnectionId.value)) {
            selectedConnectionId.value = connections.value[0]?.id ?? null;
        }
        await loadModels();
    } catch (cause: unknown) {
        logger.warn("Provider Hub load failed", cause);
        toast.error(
            cause instanceof Error ? cause.message : t("settings.providerHub.toastLoadFailed"),
        );
    } finally {
        loading.value = false;
    }
}

async function save() {
    const provider = selectedProvider.value;
    if (!provider) return;
    const pair = formType.value;
    if (!pair) return;
    const existing = editingConnection.value;
    const label = form.label.trim();
    if (!label) {
        toast.error(t("settings.providerHub.toastLabelRequired"));
        return;
    }
    if (label.length > 128) {
        toast.error(t("settings.providerHub.toastLabelTooLong"));
        return;
    }
    const duplicateLabel = connections.value.some(
        (item) =>
            item.id !== existing?.id &&
            item.providerId === provider.id &&
            item.scope === formScope.value &&
            item.label.trim().toLowerCase() === label.toLowerCase(),
    );
    const changedType =
        existing &&
        (existing.apiTypeId !== pair.apiTypeId || existing.apiTypeVersion !== pair.version);
    const defaultTemplate = formTemplates.value.find(
        (item) => templateKey(item) === targetDefaultKey.value,
    );
    if (
        changedType &&
        (!typeImpact.value ||
            !confirmedTypeChange.value ||
            (formOperation.value === "chat" && !defaultTemplate))
    ) {
        toast.error(t("settings.providerHub.toastTypePreviewRequired"));
        return;
    }
    if (provider.credential.required && !editingConnection.value && !form.apiKey.trim()) {
        toast.error(t("settings.providerHub.toastApiKeyRequired"));
        return;
    }
    const connectionKey = form.connectionKey.trim();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(connectionKey) || connectionKey.length > 64) {
        toast.error(t("settings.providerHub.toastKeyInvalid"));
        return;
    }
    // PLAN-0555: warn early but let the server's unique index decide; the 409
    // below is the authoritative answer (another writer may race).
    if (duplicateLabel) toast.warning(t("settings.providerHub.toastLabelDuplicate"));

    saving.value = true;
    try {
        const input: ProviderConnectionInput = {
            providerId: provider.id,
            label,
            scope: formScope.value,
            connectionKey,
            apiTypeId: pair.apiTypeId,
            apiTypeVersion: pair.version,
            ...(existing
                ? { expectedRevision: typeImpact.value?.connectionRevision ?? existing.revision }
                : {}),
            ...(changedType
                ? {
                      confirmedTypeChange: true,
                      ...(defaultTemplate
                          ? { connectionDefaultTemplateRef: refOnly(defaultTemplate) }
                          : {}),
                  }
                : {}),
            ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
            baseUrl: form.baseUrl.trim(),
            modelDiscovery: form.modelDiscovery,
            manualModels: form.manualModels
                .split(/[,\n]/)
                .map((item) => item.trim())
                .filter(Boolean),
        };
        const connection = editingConnection.value
            ? await updateProviderConnection(editingConnection.value.id, input)
            : await createProviderConnection(input);
        selectedConnectionId.value = connection.id;
        form.apiKey = "";
        const verification = await verifyProviderConnection(connection.id);
        configStore.invalidateProviderConnections();
        await load();
        if (verification.connection.status === "READY")
            toast.success(t("settings.providerHub.toastConnectedVerified"));
        else
            toast.warning(
                t("settings.providerHub.toastStatus", {
                    status: statusLabel(verification.connection.status),
                }),
            );
        saving.value = false;
        closeForm();
    } catch (cause: unknown) {
        logger.warn("Provider Hub save failed", cause);
        const problem = cause instanceof ApiError ? cause.problem : undefined;
        if (problem?.code === "PROVIDER_CONNECTION_LABEL_CONFLICT") {
            toast.error(t("settings.providerHub.toastLabelConflict"));
        } else if (problem?.code === "PROVIDER_CONNECTION_INVALID" && problem.field === "label") {
            toast.error(t("settings.providerHub.toastLabelInvalid"));
        } else {
            toast.error(
                cause instanceof Error ? cause.message : t("settings.providerHub.toastSaveFailed"),
            );
        }
    } finally {
        saving.value = false;
    }
}

async function verify(connection: ProviderConnection) {
    verifyingId.value = connection.id;
    try {
        const result = await verifyProviderConnection(connection.id);
        configStore.invalidateProviderConnections();
        await load();
        if (result.connection.status === "READY")
            toast.success(t("settings.providerHub.toastVerifyOk"));
        else
            toast.error(
                t("settings.providerHub.toastStatus", {
                    status: statusLabel(result.connection.status),
                }),
            );
    } catch (cause: unknown) {
        logger.warn("Provider Hub verification failed", cause);
        toast.error(
            cause instanceof Error ? cause.message : t("settings.providerHub.toastVerifyFailed"),
        );
    } finally {
        verifyingId.value = null;
    }
}

// PLAN-0505: 删除走「预览 → 二次确认（展示数量）→ 删除 → 回显」流。
const deleteTarget = ref<ProviderConnection | null>(null),
    deleteImpact = ref<DeleteImpact | null>(null),
    deleteImpactLoading = ref(false),
    deleting = ref(false),
    deleteError = ref("");

function impactSummary(impact: DeleteImpact): string[] {
    const parts: string[] = [];
    if (impact.bindingCount > 0) {
        parts.push(
            t("settings.providerHub.impactModelBindings", {
                count: impact.bindingCount,
                scopes: impact.bindingUserScopes,
            }),
        );
    }
    if (impact.defaultTemplateRef) parts.push(t("settings.providerHub.impactDefaultTemplate"));
    if (impact.profileCount > 0)
        parts.push(t("settings.providerHub.impactProfiles", { count: impact.profileCount }));
    return parts;
}

async function remove(connection: ProviderConnection) {
    deleteError.value = "";
    deleteImpact.value = null;
    deleteTarget.value = connection;
    deleteImpactLoading.value = true;
    try {
        deleteImpact.value = await getDeleteImpact(connection.id);
    } catch (cause: unknown) {
        logger.warn("Provider Hub delete impact failed", cause);
        deleteError.value =
            cause instanceof Error
                ? cause.message
                : t("settings.providerHub.toastDeletePreviewFailed");
    } finally {
        deleteImpactLoading.value = false;
    }
}

function closeDeleteDialog() {
    deleteTarget.value = null;
    deleteImpact.value = null;
    deleteError.value = "";
}

function cancelDelete() {
    // User-initiated close; no-op while a delete is in flight so the dialog
    // stays mounted and the outcome remains visible.
    if (deleting.value) return;
    closeDeleteDialog();
}

async function confirmDelete() {
    const target = deleteTarget.value;
    if (!target || deleting.value) return;
    deleting.value = true;
    deleteError.value = "";
    try {
        await deleteProviderConnection(target.id);
        configStore.invalidateProviderConnections();
        await load();
        toast.success(t("settings.providerHub.toastDeleted"));
        closeDeleteDialog();
    } catch (cause: unknown) {
        logger.warn("Provider Hub delete failed", cause);
        deleteError.value =
            cause instanceof Error ? cause.message : t("settings.providerHub.toastDeleteFailed");
    } finally {
        deleting.value = false;
    }
}

onMounted(() => {
    void load();
});
</script>

<template>
    <section data-testid="provider-hub" class="space-y-6 rounded-xl border bg-card p-5 sm:p-7">
        <header>
            <div class="text-xs font-semibold uppercase tracking-widest text-primary">
                {{ t("settings.providerHub.kicker") }}
            </div>
            <h3 class="mt-1 text-xl font-semibold tracking-tight sm:text-2xl">
                {{ t("settings.providerHub.title") }}
            </h3>
            <p class="mt-1.5 text-sm text-muted-foreground">{{ t("settings.providerHub.desc") }}</p>
        </header>

        <div v-if="loading" class="py-10 text-center text-sm text-muted-foreground">
            {{ t("settings.providerHub.loading") }}
        </div>

        <template v-else>
            <div class="flex flex-col gap-2.5 sm:flex-row sm:items-center">
                <label
                    class="flex flex-1 items-center gap-2.5 rounded-lg border bg-background px-3.5 py-2.5"
                >
                    <Search class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <input
                        v-model="search"
                        data-testid="provider-connection-search"
                        class="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                        :placeholder="t('settings.providerHub.searchPlaceholder')"
                    />
                </label>
                <button
                    v-if="!props.readonly"
                    data-testid="provider-hub-connect"
                    class="shrink-0 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                    :disabled="providers.length === 0"
                    @click="openPicker"
                >
                    {{ t("settings.providerHub.connect") }}
                </button>
            </div>

            <div
                v-if="needsKeyConnections.length > 0"
                data-testid="provider-needs-key-banner"
                class="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900"
            >
                {{
                    t("settings.providerHub.needsKeyBanner", { count: needsKeyConnections.length })
                }}
            </div>

            <section
                data-testid="provider-master-detail"
                class="grid min-w-0 gap-4 lg:grid-cols-[minmax(240px,0.31fr)_minmax(0,0.69fr)]"
            >
                <nav :aria-label="t('settings.providerHub.navLabel')" class="min-w-0">
                    <div class="mb-2.5 flex items-center justify-between">
                        <h4 class="text-sm font-semibold">
                            {{ t("settings.providerHub.connected") }}
                        </h4>
                        <span class="text-xs text-muted-foreground">{{
                            t("settings.providerHub.connectionCount", { count: connections.length })
                        }}</span>
                    </div>
                    <div
                        v-if="connections.length === 0"
                        class="rounded-lg border border-dashed px-4 py-7 text-center text-sm text-muted-foreground"
                    >
                        {{ t("settings.providerHub.empty") }}
                    </div>
                    <div v-else class="space-y-4">
                        <p
                            v-if="connectionGroups.length === 0 && !defaultConnection"
                            class="text-sm text-muted-foreground"
                        >
                            {{ t("settings.providerHub.noMatch") }}
                        </p>
                        <!-- PLAN-0523 T3.2 漂移：存储的默认连接已不可见 → 顶部保留琥珀色失效条目 -->
                        <article
                            v-if="driftedProfile"
                            data-testid="provider-default-drift"
                            class="min-w-0 rounded-lg border border-amber-300 bg-amber-50 p-3"
                        >
                            <div class="flex flex-wrap items-center gap-2">
                                <span class="break-all font-mono text-sm font-semibold">{{
                                    driftedProfile.connectionKey
                                }}</span>
                                <span
                                    class="rounded bg-amber-200 px-1.5 py-0.5 text-[10px] font-semibold text-amber-900"
                                    >{{ t("settings.providerHub.badgeDefault") }}</span
                                >
                                <span
                                    class="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700"
                                >
                                    <span class="size-1.5 rounded-full bg-current" />{{
                                        t("settings.providerHub.driftBadge")
                                    }}
                                </span>
                            </div>
                            <p class="mt-1 text-xs text-amber-700">
                                {{ t("settings.providerHub.driftDesc") }}
                            </p>
                        </article>
                        <!-- PLAN-0523 T3.2 默认连接置顶（徽标） -->
                        <article
                            v-if="defaultConnection"
                            data-testid="provider-default-connection"
                            class="min-w-0 rounded-lg border bg-background p-3"
                            :class="{
                                'border-primary': activeConnection?.id === defaultConnection.id,
                            }"
                            :data-connection-key="defaultConnection.connectionKey"
                        >
                            <button
                                type="button"
                                class="block w-full min-w-0 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                                :aria-pressed="activeConnection?.id === defaultConnection.id"
                                @click="selectedConnectionId = defaultConnection.id"
                            >
                                <div class="flex flex-wrap items-center gap-2">
                                    <span class="break-all font-mono text-sm font-semibold">{{
                                        defaultConnection.connectionKey
                                    }}</span>
                                    <span
                                        class="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary"
                                        >{{ t("settings.providerHub.badgeDefault") }}</span
                                    >
                                    <span class="text-xs text-muted-foreground">{{
                                        defaultConnection.scope === "WORKSPACE"
                                            ? t("settings.providerHub.scopeWorkspace")
                                            : t("settings.providerHub.scopeUser")
                                    }}</span>
                                    <span
                                        class="inline-flex items-center gap-1.5 text-xs font-semibold"
                                        :class="statusClass(defaultConnection.status)"
                                    >
                                        <span class="size-1.5 rounded-full bg-current" />{{
                                            statusLabel(defaultConnection.status)
                                        }}
                                    </span>
                                </div>
                                <div
                                    class="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground"
                                >
                                    <span class="break-all">{{ defaultConnection.label }}</span>
                                </div>
                            </button>
                            <div class="mt-3 flex flex-wrap gap-1.5">
                                <button
                                    class="rounded-md border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground disabled:opacity-50"
                                    :disabled="
                                        verifyingId === defaultConnection.id || props.readonly
                                    "
                                    @click="verify(defaultConnection)"
                                >
                                    {{
                                        verifyingId === defaultConnection.id
                                            ? t("settings.providerHub.verifying")
                                            : t("settings.providerHub.verify")
                                    }}
                                </button>
                                <button
                                    class="rounded-md border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground disabled:opacity-50"
                                    :disabled="props.readonly"
                                    @click="openManage(defaultConnection)"
                                >
                                    {{ t("settings.providerHub.manage") }}
                                </button>
                                <button
                                    class="rounded-md border px-2.5 py-1.5 text-xs text-destructive transition-colors hover:border-destructive disabled:opacity-50"
                                    :disabled="props.readonly"
                                    :data-testid="`provider-connection-delete-${defaultConnection.id}`"
                                    @click="remove(defaultConnection)"
                                >
                                    {{ t("settings.providerHub.delete") }}
                                </button>
                            </div>
                        </article>
                        <section
                            v-for="group in connectionGroups"
                            :key="group.providerId"
                            class="space-y-2"
                        >
                            <h5 class="text-xs font-semibold text-muted-foreground">
                                {{ providerName(group.providerId) }}
                            </h5>
                            <article
                                v-for="connection in group.items"
                                :key="connection.id"
                                class="min-w-0 rounded-lg border bg-background p-3"
                                :class="{
                                    'border-primary': activeConnection?.id === connection.id,
                                }"
                                :data-testid="`provider-connection-${connection.providerId}`"
                                :data-connection-key="connection.connectionKey"
                            >
                                <button
                                    type="button"
                                    class="block w-full min-w-0 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                                    :aria-pressed="activeConnection?.id === connection.id"
                                    @click="selectedConnectionId = connection.id"
                                >
                                    <div class="flex flex-wrap items-center gap-2">
                                        <span class="break-all font-mono text-sm font-semibold">{{
                                            connection.connectionKey
                                        }}</span>
                                        <span class="text-xs text-muted-foreground">{{
                                            connection.scope === "WORKSPACE"
                                                ? t("settings.providerHub.scopeWorkspace")
                                                : t("settings.providerHub.scopeUser")
                                        }}</span>
                                        <span
                                            class="inline-flex items-center gap-1.5 text-xs font-semibold"
                                            :class="statusClass(connection.status)"
                                        >
                                            <span class="size-1.5 rounded-full bg-current" />{{
                                                statusLabel(connection.status)
                                            }}
                                        </span>
                                    </div>
                                    <div
                                        class="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground"
                                    >
                                        <span class="break-all">{{ connection.label }}</span>
                                    </div>
                                </button>
                                <div class="mt-3 flex flex-wrap gap-1.5">
                                    <button
                                        class="rounded-md border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground disabled:opacity-50"
                                        :disabled="verifyingId === connection.id || props.readonly"
                                        @click="verify(connection)"
                                    >
                                        {{
                                            verifyingId === connection.id
                                                ? t("settings.providerHub.verifying")
                                                : t("settings.providerHub.verify")
                                        }}
                                    </button>
                                    <button
                                        class="rounded-md border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground disabled:opacity-50"
                                        :disabled="props.readonly"
                                        @click="openManage(connection)"
                                    >
                                        {{ t("settings.providerHub.manage") }}
                                    </button>
                                    <!-- PLAN-0523 T3.2 就地设定默认连接 -->
                                    <button
                                        class="rounded-md border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground disabled:opacity-50"
                                        :disabled="
                                            props.readonly ||
                                            savingDefault ||
                                            chatModelsOf(connection).length === 0
                                        "
                                        :data-testid="`provider-connection-default-${connection.id}`"
                                        @click="setAsDefault(connection)"
                                    >
                                        {{ t("settings.providerHub.setAsDefault") }}
                                    </button>
                                    <button
                                        class="rounded-md border px-2.5 py-1.5 text-xs text-destructive transition-colors hover:border-destructive disabled:opacity-50"
                                        :disabled="props.readonly"
                                        :data-testid="`provider-connection-delete-${connection.id}`"
                                        @click="remove(connection)"
                                    >
                                        {{ t("settings.providerHub.delete") }}
                                    </button>
                                </div>
                            </article>
                        </section>
                    </div>
                </nav>
                <section
                    v-if="activeConnection"
                    data-testid="provider-connection-detail"
                    :data-connection-key="activeConnection.connectionKey"
                    :data-connection-id="activeConnection.id"
                    class="min-w-0 space-y-5 rounded-lg border bg-background p-4"
                >
                    <header>
                        <h4 class="break-all text-base font-semibold">
                            {{ providerName(activeConnection.providerId) }} ·
                            {{ activeConnection.connectionKey }}
                        </h4>
                        <p class="mt-1 text-xs text-muted-foreground">
                            {{
                                activeConnection.scope === "WORKSPACE"
                                    ? t("settings.providerHub.scopeWorkspace")
                                    : t("settings.providerHub.scopeUser")
                            }}
                            ·
                            {{ activeConnection.label }}
                        </p>
                    </header>
                    <dl class="space-y-3 text-sm">
                        <div>
                            <dt class="text-xs text-muted-foreground">
                                {{ t("settings.providerHub.apiTypeReadonly") }}
                            </dt>
                            <dd data-testid="provider-connection-readonly-type" class="break-all">
                                {{ activeConnection.apiTypeId }}@{{
                                    activeConnection.apiTypeVersion
                                }}
                                · {{ activeConnection.operation }}
                            </dd>
                        </div>
                        <div>
                            <dt class="text-xs text-muted-foreground">
                                {{ t("settings.providerHub.endpoint") }}
                            </dt>
                            <dd class="break-all">
                                {{
                                    activeConnection.baseUrl ||
                                    t("settings.providerHub.defaultEndpoint")
                                }}
                            </dd>
                        </div>
                        <div>
                            <dt class="text-xs text-muted-foreground">
                                {{ t("settings.providerHub.credential") }}
                            </dt>
                            <dd>
                                {{
                                    providers.find(
                                        (provider) => provider.id === activeConnection?.providerId,
                                    )?.credential.required === false
                                        ? t("settings.providerHub.credentialNotRequired")
                                        : activeConnection.hasKey
                                          ? t("settings.providerHub.credentialConfigured")
                                          : t("settings.providerHub.credentialMissing")
                                }}
                            </dd>
                            <button
                                v-if="
                                    !props.readonly &&
                                    providers.find(
                                        (provider) => provider.id === activeConnection?.providerId,
                                    )?.credential.type !== 'none'
                                "
                                type="button"
                                class="mt-1 rounded-md border px-2.5 py-1.5 text-xs hover:border-primary"
                                @click="openManage(activeConnection)"
                            >
                                {{
                                    activeConnection.hasKey
                                        ? t("settings.providerHub.replaceKey")
                                        : t("settings.providerHub.addKey")
                                }}
                            </button>
                        </div>
                        <div>
                            <dt class="text-xs text-muted-foreground">
                                {{ t("settings.providerHub.statusLabel") }}
                            </dt>
                            <dd :class="statusClass(activeConnection.status)">
                                {{ statusLabel(activeConnection.status) }} ·
                                {{ formatVerifiedAt(activeConnection.lastVerifiedAt) }}
                            </dd>
                            <dd
                                v-if="activeConnection.lastErrorCode"
                                class="mt-1 break-all text-xs text-destructive"
                            >
                                {{
                                    t("settings.providerHub.verifyError", {
                                        code: activeConnection.lastErrorCode,
                                    })
                                }}
                            </dd>
                        </div>
                    </dl>
                    <section v-if="activeConnection.operation === 'chat'" class="border-t pt-4">
                        <label class="block text-xs"
                            >{{ t("settings.providerHub.connDefaultTemplate") }}
                            <select
                                :value="currentDefaultKey()"
                                :disabled="props.readonly || bindingBusy"
                                class="mt-1 w-full rounded border bg-background p-2"
                                :aria-label="t('settings.providerHub.connDefaultTemplate')"
                                @change="
                                    saveBinding(null, ($event.target as HTMLSelectElement).value)
                                "
                            >
                                <option value="">
                                    {{ t("settings.providerHub.builtinTemplate") }}
                                </option>
                                <option
                                    v-for="item in activeTemplates"
                                    :key="templateKey(item)"
                                    :value="templateKey(item)"
                                >
                                    {{ item.name }} v{{ item.version }}
                                </option>
                            </select>
                        </label>
                    </section>
                    <section data-testid="provider-connection-models" class="border-t pt-4">
                        <!-- PLAN-0523 批注 v5-①: 模型区标题即「模型」，请求模板与参数配置地位相同（两个平级块）。 -->
                        <h5 class="text-sm font-semibold">
                            {{ t("settings.providerHub.models") }}
                        </h5>
                        <p class="mt-1 text-xs text-muted-foreground">
                            {{
                                t("settings.providerHub.modelDiscovery", {
                                    mode: activeConnection.modelDiscovery,
                                })
                            }}
                        </p>
                        <p v-if="modelsError" class="mt-2 text-xs text-destructive">
                            {{ t("settings.providerHub.modelsError") }}
                        </p>
                        <ul v-if="displayModels.length" class="mt-2 divide-y">
                            <li
                                v-for="model in displayModels"
                                :key="model"
                                class="py-2 text-xs"
                                :data-testid="`provider-model-${model}`"
                            >
                                <div class="flex flex-wrap items-center justify-between gap-2">
                                    <button
                                        type="button"
                                        class="flex min-w-0 items-center gap-2 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                                        :aria-expanded="expandedModel === model"
                                        @click="toggleModel(model)"
                                    >
                                        <span aria-hidden="true" class="text-muted-foreground">{{
                                            expandedModel === model ? "▾" : "▸"
                                        }}</span>
                                        <span class="break-all font-medium">{{ model }}</span>
                                        <span
                                            v-if="isDefaultModel(model)"
                                            class="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary"
                                            >{{ t("settings.providerHub.badgeDefault") }}</span
                                        >
                                        <span
                                            v-if="isDriftedDefaultModel(model)"
                                            class="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700"
                                            >{{ t("settings.providerHub.driftBadge") }}</span
                                        >
                                    </button>
                                    <!-- 默认连接的其余模型：就地设定为层默认模型 -->
                                    <button
                                        v-if="
                                            isDefaultConnectionActive &&
                                            !isDefaultModel(model) &&
                                            activeConnection
                                        "
                                        class="rounded-md border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary hover:text-foreground disabled:opacity-50"
                                        :disabled="props.readonly || savingDefault"
                                        :data-testid="`provider-model-default-${model}`"
                                        @click="setAsDefault(activeConnection, model)"
                                    >
                                        {{ t("settings.providerHub.setAsDefault") }}
                                    </button>
                                </div>
                                <!-- 展开区：模型详情（T3.3）+ 请求模板 / 参数配置两个平级块（T3.2 批注⑤） -->
                                <div
                                    v-if="expandedModel === model"
                                    class="mt-2 space-y-3 rounded-md border bg-muted/20 p-3"
                                >
                                    <dl
                                        class="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3"
                                        :data-testid="`provider-model-detail-${model}`"
                                    >
                                        <div>
                                            <dt class="text-muted-foreground">
                                                {{ t("settings.providerHub.detailInput") }}
                                            </dt>
                                            <dd>
                                                {{
                                                    formatModalities(
                                                        activeModelDetails[model]?.inputModalities,
                                                    )
                                                }}
                                            </dd>
                                        </div>
                                        <div>
                                            <dt class="text-muted-foreground">
                                                {{ t("settings.providerHub.detailOutput") }}
                                            </dt>
                                            <dd>
                                                {{
                                                    formatModalities(
                                                        activeModelDetails[model]?.outputModalities,
                                                    )
                                                }}
                                            </dd>
                                        </div>
                                        <div>
                                            <dt class="text-muted-foreground">
                                                {{ t("settings.providerHub.detailContext") }}
                                            </dt>
                                            <dd>
                                                {{
                                                    formatTokenCount(
                                                        activeModelDetails[model]
                                                            ?.contextWindowTokens,
                                                    )
                                                }}
                                            </dd>
                                        </div>
                                        <div>
                                            <dt class="text-muted-foreground">
                                                {{ t("settings.providerHub.detailMaxOutput") }}
                                            </dt>
                                            <dd>
                                                {{
                                                    formatTokenCount(
                                                        activeModelDetails[model]?.maxOutputTokens,
                                                    )
                                                }}
                                            </dd>
                                        </div>
                                        <div class="col-span-2">
                                            <dt class="text-muted-foreground">
                                                {{ t("settings.providerHub.detailPricing") }}
                                            </dt>
                                            <dd>
                                                {{
                                                    formatPricing(
                                                        activeModelDetails[model]?.pricing,
                                                    )
                                                }}
                                            </dd>
                                        </div>
                                    </dl>
                                    <div v-if="activeConnection?.operation === 'chat'">
                                        <h6
                                            class="mb-1 text-xs font-semibold text-muted-foreground"
                                        >
                                            {{ t("settings.providerHub.requestTemplate") }}
                                        </h6>
                                        <select
                                            :value="currentModelKey(model)"
                                            :disabled="props.readonly || bindingBusy"
                                            class="w-full max-w-full rounded border bg-background p-1.5"
                                            :aria-label="
                                                t('settings.providerHub.modelTemplateAria', {
                                                    model,
                                                })
                                            "
                                            @change="
                                                saveBinding(
                                                    model,
                                                    ($event.target as HTMLSelectElement).value,
                                                )
                                            "
                                        >
                                            <option value="">
                                                {{ t("settings.providerHub.inheritTemplate") }}
                                            </option>
                                            <option
                                                v-for="item in activeTemplates"
                                                :key="templateKey(item)"
                                                :value="templateKey(item)"
                                            >
                                                {{ item.name }} v{{ item.version }}
                                            </option>
                                        </select>
                                    </div>
                                    <div>
                                        <h6
                                            class="mb-1 text-xs font-semibold text-muted-foreground"
                                        >
                                            {{ t("settings.providerHub.params") }}
                                        </h6>
                                        <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
                                            <label class="block">
                                                <span class="text-muted-foreground">{{
                                                    t("settings.providerHub.maxTokens")
                                                }}</span>
                                                <input
                                                    v-model="paramDrafts[model].maxTokens"
                                                    type="number"
                                                    min="0"
                                                    class="mt-0.5 w-full rounded border bg-background p-1.5"
                                                    :disabled="props.readonly"
                                                    :aria-label="
                                                        t('settings.providerHub.maxTokensAria', {
                                                            model,
                                                        })
                                                    "
                                                />
                                            </label>
                                            <label class="block">
                                                <span class="text-muted-foreground">{{
                                                    t("settings.providerHub.temperature")
                                                }}</span>
                                                <input
                                                    v-model="paramDrafts[model].temperature"
                                                    type="number"
                                                    step="0.1"
                                                    class="mt-0.5 w-full rounded border bg-background p-1.5"
                                                    :disabled="props.readonly"
                                                    :aria-label="
                                                        t('settings.providerHub.temperatureAria', {
                                                            model,
                                                        })
                                                    "
                                                />
                                            </label>
                                            <label class="block">
                                                <span class="text-muted-foreground">{{
                                                    t("settings.providerHub.timeout")
                                                }}</span>
                                                <input
                                                    v-model="paramDrafts[model].timeout"
                                                    type="number"
                                                    min="0"
                                                    class="mt-0.5 w-full rounded border bg-background p-1.5"
                                                    :disabled="props.readonly"
                                                    :aria-label="
                                                        t('settings.providerHub.timeoutAria', {
                                                            model,
                                                        })
                                                    "
                                                />
                                            </label>
                                        </div>
                                        <div class="mt-2 flex items-center gap-2">
                                            <button
                                                class="rounded-md border px-2.5 py-1.5 text-xs transition-colors hover:border-primary disabled:opacity-50"
                                                :disabled="props.readonly || savingParams"
                                                :data-testid="`provider-model-params-save-${model}`"
                                                @click="saveModelParams(model)"
                                            >
                                                {{
                                                    savingParams
                                                        ? t("settings.providerHub.savingParams")
                                                        : t("settings.providerHub.saveParams")
                                                }}
                                            </button>
                                            <span class="text-[11px] text-muted-foreground">
                                                {{ t("settings.providerHub.paramsHint") }}
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            </li>
                        </ul>
                        <p
                            v-else-if="!orphanModels.length"
                            class="mt-2 text-sm text-muted-foreground"
                        >
                            {{ t("settings.providerHub.noModels") }}
                        </p>
                        <section
                            v-if="orphanModels.length"
                            data-testid="provider-orphan-bindings"
                            class="mt-3"
                        >
                            <h6 class="text-xs font-semibold text-amber-600">
                                {{
                                    modelsError
                                        ? t("settings.providerHub.orphanTitleError")
                                        : t("settings.providerHub.orphanTitle")
                                }}
                            </h6>
                            <ul class="mt-1 divide-y">
                                <li
                                    v-for="model in orphanModels"
                                    :key="`orphan-${model}`"
                                    :data-testid="`provider-orphan-model-${model}`"
                                    class="flex flex-wrap justify-between gap-2 py-2 text-xs"
                                >
                                    <span class="break-all">{{ model }}</span>
                                    <select
                                        v-if="activeConnection.operation === 'chat'"
                                        :value="currentModelKey(model)"
                                        :disabled="props.readonly || bindingBusy"
                                        class="max-w-full rounded border bg-background p-1"
                                        :aria-label="
                                            t('settings.providerHub.modelTemplateAria', { model })
                                        "
                                        @change="
                                            saveBinding(
                                                model,
                                                ($event.target as HTMLSelectElement).value,
                                            )
                                        "
                                    >
                                        <option value="">
                                            {{ t("settings.providerHub.inheritTemplate") }}
                                        </option>
                                        <option
                                            v-for="item in activeTemplates"
                                            :key="templateKey(item)"
                                            :value="templateKey(item)"
                                        >
                                            {{ item.name }} v{{ item.version }}
                                        </option>
                                    </select>
                                    <span class="break-all text-amber-600">
                                        {{ orphanNotice }}
                                    </span>
                                </li>
                            </ul>
                        </section>
                    </section>
                </section>
                <p v-else class="py-7 text-sm text-muted-foreground">
                    {{ t("settings.providerHub.selectConnection") }}
                </p>
            </section>

            <div
                class="flex items-start gap-3 rounded-lg border-l-[3px] border-primary bg-muted/40 px-4 py-3 text-xs leading-relaxed text-muted-foreground"
            >
                <span
                    class="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground"
                    >i</span
                >
                <div>
                    <strong class="font-semibold text-foreground">{{
                        t("settings.providerHub.scopeNoteTitle")
                    }}</strong
                    ><br />
                    {{ t("settings.providerHub.scopeNoteBody") }}
                </div>
            </div>
        </template>

        <!-- PLAN-0505 删除二次确认：预览计数 → 确认 → 回显；取消即零变更。 -->
        <div
            v-if="deleteTarget"
            class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 sm:p-6"
            data-testid="provider-delete-confirm-modal"
            @click.self="cancelDelete"
        >
            <!-- cancelDelete no-ops while deleting -->
            <div
                class="flex w-full max-w-md flex-col rounded-xl border bg-card shadow-2xl"
                role="alertdialog"
                aria-modal="true"
            >
                <header class="border-b px-5 py-4">
                    <h3 class="text-lg font-semibold text-destructive">
                        {{ t("settings.providerHub.deleteTitle") }}
                    </h3>
                    <p class="mt-1 text-sm text-muted-foreground">
                        {{
                            t("settings.providerHub.deleteConfirmDesc", {
                                label: deleteTarget.label,
                            })
                        }}
                    </p>
                </header>
                <div class="px-5 py-4 text-sm">
                    <p v-if="deleteImpactLoading" class="text-muted-foreground">
                        {{ t("settings.providerHub.deleteImpactLoading") }}
                    </p>
                    <template v-else-if="deleteImpact">
                        <div
                            v-if="deleteImpact.blocked"
                            class="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2.5"
                            data-testid="provider-delete-blocked"
                        >
                            <p class="font-semibold text-destructive">
                                {{
                                    t("settings.providerHub.deleteBlocked", {
                                        count: deleteImpact.sessionCount,
                                    })
                                }}
                            </p>
                            <p class="mt-1 text-xs text-muted-foreground">
                                {{ t("settings.providerHub.deleteBlockedHint") }}
                            </p>
                        </div>
                        <div
                            v-else-if="impactSummary(deleteImpact).length > 0"
                            data-testid="provider-delete-impact-summary"
                        >
                            <p class="mb-1.5 font-semibold">
                                {{ t("settings.providerHub.deleteCascade") }}
                            </p>
                            <ul class="list-inside list-disc space-y-0.5 text-muted-foreground">
                                <li v-for="part in impactSummary(deleteImpact)" :key="part">
                                    {{ part }}
                                </li>
                            </ul>
                            <p class="mt-2 text-xs text-muted-foreground">
                                {{ t("settings.providerHub.deleteCascadeNote") }}
                            </p>
                        </div>
                        <p v-else class="text-muted-foreground">
                            {{ t("settings.providerHub.deleteNoRefs") }}
                        </p>
                    </template>
                    <p
                        v-if="deleteError"
                        class="mt-2 text-destructive"
                        data-testid="provider-delete-error"
                    >
                        {{ deleteError }}
                    </p>
                </div>
                <footer class="flex justify-end gap-2 border-t bg-muted/30 px-5 py-3.5">
                    <button
                        type="button"
                        class="rounded-md border px-3.5 py-2 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground disabled:opacity-50"
                        :disabled="deleting"
                        data-testid="provider-delete-cancel"
                        @click="cancelDelete"
                    >
                        {{ t("settings.providerHub.cancel") }}
                    </button>
                    <button
                        type="button"
                        class="rounded-md bg-destructive px-3.5 py-2 text-xs font-semibold text-destructive-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                        :disabled="
                            deleteImpactLoading ||
                            deleting ||
                            !deleteImpact ||
                            !!deleteImpact.blocked
                        "
                        data-testid="provider-delete-confirm"
                        @click="confirmDelete"
                    >
                        {{
                            deleting
                                ? t("settings.providerHub.deleting")
                                : t("settings.providerHub.confirmDelete")
                        }}
                    </button>
                </footer>
            </div>
        </div>

        <div
            v-if="modalOpen"
            class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 sm:p-6"
            data-testid="provider-picker-modal"
            @click.self="modalOpen = false"
        >
            <div
                class="flex max-h-[calc(100vh-48px)] w-full max-w-lg flex-col overflow-hidden rounded-xl border bg-card shadow-2xl"
            >
                <header class="border-b px-5 py-4">
                    <h3 class="text-lg font-semibold">{{ t("settings.providerHub.pickTitle") }}</h3>
                    <label
                        class="mt-3 flex items-center gap-2.5 rounded-lg border bg-background px-3 py-2"
                    >
                        <Search class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <input
                            v-model="pickerSearch"
                            data-testid="provider-picker-search"
                            class="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                            :placeholder="t('settings.providerHub.pickSearchPlaceholder')"
                        />
                    </label>
                </header>
                <div class="flex-1 overflow-y-auto px-2 py-2">
                    <p
                        v-if="selectableProviders.length === 0"
                        class="px-3 py-8 text-center text-sm text-muted-foreground"
                    >
                        {{ t("settings.providerHub.pickNoMatch") }}
                    </p>
                    <template v-for="group in pickerGroups" :key="group.label">
                        <div
                            class="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
                        >
                            {{ group.label }}
                        </div>
                        <button
                            v-for="provider in group.items"
                            :key="provider.id"
                            class="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-muted"
                            :data-testid="`provider-picker-${provider.id}`"
                            @click="openConnect(provider)"
                        >
                            <span class="min-w-0 flex-1">
                                <span class="block text-sm font-medium">{{
                                    provider.displayName
                                }}</span>
                                <span class="block truncate text-xs text-muted-foreground">
                                    {{ provider.description || provider.displayName }}
                                </span>
                                <span class="mt-0.5 block text-[10px] text-muted-foreground">
                                    {{ adapterLabel(provider) }} · {{ provider.modelDiscovery }}
                                </span>
                                <span
                                    class="mt-0.5 flex flex-wrap items-center gap-1"
                                    :data-testid="`provider-supports-${provider.id}`"
                                >
                                    <span
                                        v-if="provider.supports.streaming"
                                        class="rounded bg-muted px-1 text-[10px] text-muted-foreground"
                                        >{{ t("settings.providerHub.supportsStreaming") }}</span
                                    >
                                    <span
                                        v-if="provider.supports.tools"
                                        class="rounded bg-muted px-1 text-[10px] text-muted-foreground"
                                        >{{ t("settings.providerHub.supportsTools") }}</span
                                    >
                                    <span
                                        v-if="provider.supports.vision"
                                        class="rounded bg-muted px-1 text-[10px] text-muted-foreground"
                                        >{{ t("settings.providerHub.supportsVision") }}</span
                                    >
                                    <span
                                        v-if="provider.supports.customBaseUrl"
                                        class="rounded bg-muted px-1 text-[10px] text-muted-foreground"
                                        >{{ t("settings.providerHub.supportsCustomBaseUrl") }}</span
                                    >
                                </span>
                            </span>
                            <span
                                v-if="connectedProviderIds.has(provider.id)"
                                class="shrink-0 text-[11px] text-muted-foreground"
                                >{{ t("settings.providerHub.pickConnected") }}</span
                            >
                        </button>
                    </template>
                </div>
                <footer
                    class="flex items-center justify-between border-t px-5 py-3 text-xs text-muted-foreground"
                >
                    <span>{{
                        t("settings.providerHub.pickCount", { count: selectableProviders.length })
                    }}</span>
                    <button
                        class="rounded-md border px-3 py-1.5 transition-colors hover:border-primary hover:text-foreground"
                        @click="modalOpen = false"
                    >
                        {{ t("settings.providerHub.cancel") }}
                    </button>
                </footer>
            </div>
        </div>

        <div
            v-if="formOpen && selectedProvider"
            class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 sm:p-6"
            data-testid="provider-connection-modal"
            @click.self="closeForm"
        >
            <form
                class="max-h-[calc(100vh-48px)] w-full max-w-xl overflow-y-auto rounded-xl border bg-card shadow-2xl"
                @submit.prevent="save"
            >
                <header class="flex items-center justify-between border-b px-5 py-4">
                    <h3 class="text-lg font-semibold">
                        {{
                            editingConnection
                                ? t("settings.providerHub.formManageTitle")
                                : t("settings.providerHub.formConnectTitle")
                        }}
                    </h3>
                    <button
                        type="button"
                        class="text-2xl leading-none text-muted-foreground transition-colors hover:text-foreground"
                        :aria-label="t('settings.providerHub.close')"
                        @click="closeForm"
                    >
                        ×
                    </button>
                </header>
                <div class="px-5 py-5">
                    <div class="mb-5">
                        <strong class="block text-sm">{{ selectedProvider.displayName }}</strong>
                        <span class="text-xs text-muted-foreground"
                            >{{ adapterLabel(selectedProvider) }} · {{ form.modelDiscovery }} ·
                            {{
                                editingConnection
                                    ? `${editingConnection.apiTypeId}@${editingConnection.apiTypeVersion}`
                                    : `${selectedProvider.defaultApiType.apiTypeId}@${selectedProvider.defaultApiType.version}`
                            }}</span
                        >
                        <label class="mt-3 block text-xs"
                            >API Type
                            <select
                                v-model="form.apiType"
                                data-testid="provider-connection-api-type"
                                class="mt-1 w-full rounded border bg-background p-2 text-sm"
                                @change="previewTypeChange"
                            >
                                <option
                                    v-for="pair in selectedProvider.supportedApiTypes"
                                    :key="pair.apiTypeId + '@' + pair.version"
                                    :value="pair.apiTypeId + '@' + pair.version"
                                >
                                    {{ pair.apiTypeId }}@{{ pair.version }}
                                </option>
                            </select>
                        </label>
                        <div
                            v-if="typeImpact"
                            class="mt-3 space-y-2 rounded border p-3 text-xs"
                            data-testid="connection-type-impact"
                        >
                            <p>
                                {{
                                    t("settings.providerHub.typeImpactSummary", {
                                        overrides: typeImpact.incompatibleOverrides.reduce(
                                            (sum, item) => sum + item.count,
                                            0,
                                        ),
                                        sessions: typeImpact.sessionRebindCount,
                                    })
                                }}
                            </p>
                            <label v-if="formOperation === 'chat'" class="block"
                                >{{ t("settings.providerHub.newDefaultTemplate") }}
                                <select
                                    v-model="targetDefaultKey"
                                    class="mt-1 w-full rounded border bg-background p-2"
                                    :aria-label="t('settings.providerHub.newDefaultTemplate')"
                                >
                                    <option value="" disabled>
                                        {{ t("settings.providerHub.chooseCompatible") }}
                                    </option>
                                    <option
                                        v-for="item in formTemplates"
                                        :key="templateKey(item)"
                                        :value="templateKey(item)"
                                    >
                                        {{ item.name }} v{{ item.version }}
                                    </option>
                                </select>
                            </label>
                            <label class="flex items-center gap-2"
                                ><input v-model="confirmedTypeChange" type="checkbox" />{{
                                    t("settings.providerHub.confirmTypeChange")
                                }}</label
                            >
                        </div>
                    </div>

                    <label class="block">
                        <span class="mb-1.5 block text-xs font-semibold">{{
                            t("settings.providerHub.fieldLabel")
                        }}</span>
                        <input
                            v-model="form.label"
                            data-testid="provider-connection-form-label"
                            class="w-full rounded-md border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/30"
                            required
                            maxlength="128"
                        />
                    </label>
                    <label class="mt-4 block">
                        <span class="mb-1.5 block text-xs font-semibold">{{
                            t("settings.providerHub.fieldKey")
                        }}</span>
                        <input
                            v-model="form.connectionKey"
                            data-testid="provider-connection-form-key"
                            class="w-full rounded-md border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/30"
                            :readonly="Boolean(editingConnection)"
                            required
                            maxlength="64"
                            pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                            placeholder="default"
                        />
                        <span class="mt-1.5 block text-[11px] text-muted-foreground">{{
                            t("settings.providerHub.keyHint")
                        }}</span>
                    </label>
                    <label class="mt-4 block">
                        <span class="mb-1.5 block text-xs font-semibold">{{
                            t("settings.providerHub.fieldApiKey")
                        }}</span>
                        <input
                            v-model="form.apiKey"
                            class="w-full rounded-md border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/30"
                            type="password"
                            :placeholder="
                                editingConnection
                                    ? t('settings.providerHub.keyPlaceholderKeep')
                                    : selectedProvider.credential.placeholder ||
                                      t('settings.providerHub.optional')
                            "
                        />
                        <span class="mt-1.5 block text-[11px] text-muted-foreground">{{
                            t("settings.providerHub.keySaveHint")
                        }}</span>
                    </label>
                    <label v-if="selectedProvider.supports.customBaseUrl" class="mt-4 block">
                        <span class="mb-1.5 block text-xs font-semibold"
                            >{{ t("settings.providerHub.fieldBaseUrl") }}
                            <span class="font-normal text-muted-foreground">{{
                                t("settings.providerHub.optional")
                            }}</span></span
                        >
                        <input
                            v-model="form.baseUrl"
                            class="w-full rounded-md border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/30"
                            type="url"
                            :placeholder="selectedProvider.defaultBaseUrl || 'https://...'"
                        />
                    </label>
                    <p class="mt-4 text-xs text-muted-foreground">
                        {{
                            t("settings.providerHub.formScopeHint", {
                                scope:
                                    formScope === "WORKSPACE"
                                        ? t("settings.providerHub.scopeWorkspace")
                                        : t("settings.providerHub.scopeUser"),
                            })
                        }}
                    </p>
                    <label class="mt-4 block">
                        <span class="mb-1.5 block text-xs font-semibold">{{
                            t("settings.providerHub.fieldDiscovery")
                        }}</span>
                        <select
                            v-model="form.modelDiscovery"
                            class="w-full rounded-md border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/30"
                        >
                            <option value="remote-models">Provider /models</option>
                            <option value="litellm-catalog">LiteLLM Catalog</option>
                            <option value="curated">
                                {{ t("settings.providerHub.discoveryCurated") }}
                            </option>
                            <option value="manual">
                                {{ t("settings.providerHub.discoveryManual") }}
                            </option>
                        </select>
                        <span class="mt-1.5 block text-[11px] text-muted-foreground">{{
                            t("settings.providerHub.discoveryHint")
                        }}</span>
                    </label>
                    <label v-if="form.modelDiscovery === 'manual'" class="mt-4 block">
                        <span class="mb-1.5 block text-xs font-semibold">{{
                            t("settings.providerHub.fieldManualModels")
                        }}</span>
                        <textarea
                            v-model="form.manualModels"
                            class="min-h-20 w-full rounded-md border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/30"
                            :placeholder="t('settings.providerHub.manualModelsPlaceholder')"
                        />
                    </label>
                </div>
                <footer class="flex justify-end gap-2 border-t bg-muted/30 px-5 py-3.5">
                    <button
                        type="button"
                        class="rounded-md border px-3.5 py-2 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
                        @click="closeForm"
                    >
                        {{ t("settings.providerHub.cancel") }}
                    </button>
                    <button
                        type="submit"
                        class="rounded-md bg-primary px-3.5 py-2 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                        :disabled="saving"
                    >
                        {{
                            saving
                                ? t("settings.providerHub.saving")
                                : t("settings.providerHub.saveVerify")
                        }}
                    </button>
                </footer>
            </form>
        </div>
    </section>
</template>
