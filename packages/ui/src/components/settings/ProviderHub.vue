<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { toast } from "vue-sonner";
import { logger } from "../../lib/logger";
import { request } from "../../composables/api";
import type { ProviderCatalog } from "../../types/provider";
import { Search } from "@lucide/vue";
import {
    createProviderConnection,
    deleteProviderConnection,
    listProviderCatalog,
    listProviderConnections,
    updateProviderConnection,
    verifyProviderConnection,
    getConnectionTypeImpact,
    getDeleteImpact,
    type ConnectionTypeImpact,
    type DeleteImpact,
} from "../../services/providerConnectionService";
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

const providers = ref<ProviderDefinition[]>([]),
    connections = ref<ProviderConnection[]>([]),
    search = ref("");
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
        toast.error(cause instanceof Error ? cause.message : "模板绑定失败");
    } finally {
        bindingBusy.value = false;
    }
}

const connectionGroups = computed(() => {
    const query = search.value.trim().toLowerCase();
    const groups = new Map<string, ProviderConnection[]>();
    for (const connection of connections.value) {
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
    const visible = connectionGroups.value.flatMap((group) => group.items);
    return visible.find((connection) => connection.id === selectedConnectionId.value) ?? visible[0];
});
const activeModels = computed(() => {
    const connection = activeConnection.value;
    if (!connection) return [];
    const catalog = modelCatalogs.value[connection.id];
    if (catalog?.connectionId === connection.id) return catalog.models.map((model) => model.name);
    return connection.modelDiscovery === "manual" ? connection.manualModels : [];
});
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
    if (modelsError.value) return "目录加载失败 · 无法判定，绑定保留";
    return activeConnection.value?.operation === "chat"
        ? "不在当前目录 · 绑定保留，可清除"
        : "不在当前目录 · 绑定保留";
});

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
            toast.error("请求模板加载失败");
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

function providerName(providerId: string): string {
    return (
        providers.value.find((provider) => provider.id === providerId)?.displayName ?? providerId
    );
}

function adapterLabel(provider: ProviderDefinition): string {
    return {
        "native-litellm": "原生适配",
        "openai-compatible": "OpenAI 兼容",
        "manual-model": "手动模型",
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
    if (provider.adapter === "openai-compatible") return "OpenAI 兼容";
    if (provider.adapter === "native-litellm") return "原生协议";
    return "本地与自定义";
}

const pickerGroups = computed(() => {
    const groups: Array<{ label: string; items: ProviderDefinition[] }> = [],
        labels = ["原生协议", "OpenAI 兼容", "本地与自定义"];
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
        READY: "已连接",
        VERIFYING: "验证中",
        INVALID_CREDENTIALS: "密钥无效",
        UNREACHABLE: "无法连接",
        DISABLED: "已停用",
        UNVERIFIED: "待验证",
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
    if (!value) return "未验证";
    const time = new Date(value);
    if (Number.isNaN(time.getTime())) return "未验证";
    const diff = Date.now() - time.getTime();
    if (diff < 60_000) return "刚刚验证";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前验证`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前验证`;
    return `${Math.floor(diff / 86_400_000)} 天前验证`;
}

function resetForm(provider: ProviderDefinition, connection?: ProviderConnection) {
    selectedProvider.value = provider;
    editingConnection.value = connection ?? null;
    formScope.value = connection?.scope === "WORKSPACE" ? "WORKSPACE" : props.scope;
    form.label = connection?.label ?? `${provider.displayName} 连接`;
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
        toast.error(cause instanceof Error ? cause.message : "影响预览失败");
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
        const [catalog, connected] = await Promise.all([
            listProviderCatalog(),
            listProviderConnections(),
        ]);
        // Defensive: a malformed/partial response must not leave undefined state
        // (template and computed read `.length`/`.map`).
        providers.value = catalog.providers ?? [];
        connections.value = connected.connections ?? [];
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
        toast.error(cause instanceof Error ? cause.message : "Provider 配置加载失败");
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
        toast.error("请先预览影响、选择兼容默认模板并确认协议变更");
        return;
    }
    if (provider.credential.required && !editingConnection.value && !form.apiKey.trim()) {
        toast.error("请输入 API key");
        return;
    }
    const connectionKey = form.connectionKey.trim();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(connectionKey) || connectionKey.length > 64) {
        toast.error("连接标识只能包含小写字母、数字和连字符");
        return;
    }

    saving.value = true;
    try {
        const input: ProviderConnectionInput = {
            providerId: provider.id,
            label: form.label.trim(),
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
        await load();
        if (verification.connection.status === "READY") toast.success("Provider 已连接并验证");
        else toast.warning(`Provider ${statusLabel(verification.connection.status)}`);
        saving.value = false;
        closeForm();
    } catch (cause: unknown) {
        logger.warn("Provider Hub save failed", cause);
        toast.error(cause instanceof Error ? cause.message : "Provider 保存失败");
    } finally {
        saving.value = false;
    }
}

async function verify(connection: ProviderConnection) {
    verifyingId.value = connection.id;
    try {
        const result = await verifyProviderConnection(connection.id);
        await load();
        if (result.connection.status === "READY") toast.success("Provider 验证成功");
        else toast.error(`Provider ${statusLabel(result.connection.status)}`);
    } catch (cause: unknown) {
        logger.warn("Provider Hub verification failed", cause);
        toast.error(cause instanceof Error ? cause.message : "Provider 验证失败");
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
        parts.push(`模型绑定 ${impact.bindingCount} 项（${impact.bindingUserScopes} 个用户）`);
    }
    if (impact.defaultTemplateRef) parts.push("连接默认模板指向 1 项");
    if (impact.profileCount > 0) parts.push(`默认身份 profile ${impact.profileCount} 项`);
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
        deleteError.value = cause instanceof Error ? cause.message : "删除预览加载失败";
    } finally {
        deleteImpactLoading.value = false;
    }
}

function cancelDelete() {
    deleteTarget.value = null;
    deleteImpact.value = null;
    deleteError.value = "";
}

async function confirmDelete() {
    const target = deleteTarget.value;
    if (!target || deleting.value) return;
    deleting.value = true;
    deleteError.value = "";
    try {
        await deleteProviderConnection(target.id);
        await load();
        toast.success("Provider 已删除");
        cancelDelete();
    } catch (cause: unknown) {
        logger.warn("Provider Hub delete failed", cause);
        deleteError.value = cause instanceof Error ? cause.message : "Provider 删除失败";
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
            <div class="text-xs font-semibold uppercase tracking-widest text-primary">连接层</div>
            <h3 class="mt-1 text-xl font-semibold tracking-tight sm:text-2xl">Provider 连接</h3>
            <p class="mt-1.5 text-sm text-muted-foreground">
                连接模型服务。密钥由 Control Plane 加密保存，不写入浏览器存储。
            </p>
        </header>

        <div v-if="loading" class="py-10 text-center text-sm text-muted-foreground">
            加载 Provider Catalog...
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
                        placeholder="搜索已连接的 Provider"
                    />
                </label>
                <button
                    v-if="!props.readonly"
                    data-testid="provider-hub-connect"
                    class="shrink-0 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                    :disabled="providers.length === 0"
                    @click="openPicker"
                >
                    ＋ 连接 Provider
                </button>
            </div>

            <section
                data-testid="provider-master-detail"
                class="grid min-w-0 gap-4 lg:grid-cols-[minmax(240px,0.31fr)_minmax(0,0.69fr)]"
            >
                <nav aria-label="Provider 连接导航" class="min-w-0">
                    <div class="mb-2.5 flex items-center justify-between">
                        <h4 class="text-sm font-semibold">已连接</h4>
                        <span class="text-xs text-muted-foreground"
                            >{{ connections.length }} 个连接</span
                        >
                    </div>
                    <div
                        v-if="connections.length === 0"
                        class="rounded-lg border border-dashed px-4 py-7 text-center text-sm text-muted-foreground"
                    >
                        尚未连接 Provider，点击右上角「连接 Provider」开始。
                    </div>
                    <div v-else class="space-y-4">
                        <p
                            v-if="connectionGroups.length === 0"
                            class="text-sm text-muted-foreground"
                        >
                            没有匹配的连接
                        </p>
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
                                            connection.scope === "WORKSPACE" ? "Workspace" : "User"
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
                                        {{ verifyingId === connection.id ? "验证中" : "验证" }}
                                    </button>
                                    <button
                                        class="rounded-md border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground disabled:opacity-50"
                                        :disabled="props.readonly"
                                        @click="openManage(connection)"
                                    >
                                        管理
                                    </button>
                                    <button
                                        class="rounded-md border px-2.5 py-1.5 text-xs text-destructive transition-colors hover:border-destructive disabled:opacity-50"
                                        :disabled="props.readonly"
                                        :data-testid="`provider-connection-delete-${connection.id}`"
                                        @click="remove(connection)"
                                    >
                                        删除
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
                            {{ activeConnection.scope === "WORKSPACE" ? "Workspace" : "User" }} ·
                            {{ activeConnection.label }}
                        </p>
                    </header>
                    <dl class="space-y-3 text-sm">
                        <div>
                            <dt class="text-xs text-muted-foreground">API Type · 只读</dt>
                            <dd data-testid="provider-connection-readonly-type" class="break-all">
                                {{ activeConnection.apiTypeId }}@{{
                                    activeConnection.apiTypeVersion
                                }}
                                · {{ activeConnection.operation }}
                            </dd>
                        </div>
                        <div>
                            <dt class="text-xs text-muted-foreground">Endpoint</dt>
                            <dd class="break-all">
                                {{ activeConnection.baseUrl || "Provider 默认地址" }}
                            </dd>
                        </div>
                        <div>
                            <dt class="text-xs text-muted-foreground">Credential</dt>
                            <dd>
                                {{
                                    providers.find(
                                        (provider) => provider.id === activeConnection?.providerId,
                                    )?.credential.required === false
                                        ? "Not required"
                                        : activeConnection.hasKey
                                          ? "Configured · hidden"
                                          : "未配置"
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
                                {{ activeConnection.hasKey ? "替换 API key" : "添加 API key" }}
                            </button>
                        </div>
                        <div>
                            <dt class="text-xs text-muted-foreground">连接状态</dt>
                            <dd :class="statusClass(activeConnection.status)">
                                {{ statusLabel(activeConnection.status) }} ·
                                {{ formatVerifiedAt(activeConnection.lastVerifiedAt) }}
                            </dd>
                            <dd
                                v-if="activeConnection.lastErrorCode"
                                class="mt-1 break-all text-xs text-destructive"
                            >
                                验证错误：{{ activeConnection.lastErrorCode }}
                            </dd>
                        </div>
                    </dl>
                    <section v-if="activeConnection.operation === 'chat'" class="border-t pt-4">
                        <label class="block text-xs"
                            >连接默认请求模板
                            <select
                                :value="currentDefaultKey()"
                                :disabled="readonly || bindingBusy"
                                class="mt-1 w-full rounded border bg-background p-2"
                                aria-label="连接默认请求模板"
                                @change="
                                    saveBinding(null, ($event.target as HTMLSelectElement).value)
                                "
                            >
                                <option value="">API Type 内置默认模板</option>
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
                        <h5 class="text-sm font-semibold">Models</h5>
                        <p class="mt-1 text-xs text-muted-foreground">
                            模型发现：{{ activeConnection.modelDiscovery }}
                        </p>
                        <p v-if="modelsError" class="mt-2 text-xs text-destructive">
                            模型目录加载失败；下列手动配置不代表验证通过。
                        </p>
                        <ul v-if="activeModels.length" class="mt-2 divide-y">
                            <li
                                v-for="model in activeModels"
                                :key="model"
                                class="flex flex-wrap justify-between gap-2 py-2 text-xs"
                            >
                                <span class="break-all">{{ model }}</span>
                                <select
                                    v-if="activeConnection.operation === 'chat'"
                                    :value="currentModelKey(model)"
                                    :disabled="readonly || bindingBusy"
                                    class="max-w-full rounded border bg-background p-1"
                                    :aria-label="model + ' 请求模板'"
                                    @change="
                                        saveBinding(
                                            model,
                                            ($event.target as HTMLSelectElement).value,
                                        )
                                    "
                                >
                                    <option value="">继承连接默认模板</option>
                                    <option
                                        v-for="item in activeTemplates"
                                        :key="templateKey(item)"
                                        :value="templateKey(item)"
                                    >
                                        {{ item.name }} v{{ item.version }}
                                    </option>
                                </select>
                                <span class="break-all text-muted-foreground"
                                    >{{ activeConnection.apiTypeId }}@{{
                                        activeConnection.apiTypeVersion
                                    }}
                                    · 继承连接</span
                                >
                            </li>
                        </ul>
                        <p
                            v-else-if="!orphanModels.length"
                            class="mt-2 text-sm text-muted-foreground"
                        >
                            此连接暂无可显示的模型。请验证连接或管理手动模型。
                        </p>
                        <section
                            v-if="orphanModels.length"
                            data-testid="provider-orphan-bindings"
                            class="mt-3"
                        >
                            <h6 class="text-xs font-semibold text-amber-600">
                                {{
                                    modelsError
                                        ? "已绑定（目录不可达，无法判定）"
                                        : "已绑定但当前不可用"
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
                                        :disabled="readonly || bindingBusy"
                                        class="max-w-full rounded border bg-background p-1"
                                        :aria-label="model + ' 请求模板'"
                                        @change="
                                            saveBinding(
                                                model,
                                                ($event.target as HTMLSelectElement).value,
                                            )
                                        "
                                    >
                                        <option value="">继承连接默认模板</option>
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
                    选择或创建连接以查看详情与 Models。
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
                    <strong class="font-semibold text-foreground">连接作用域</strong><br />
                    按连接 key 选择具体的 User 或 Workspace 作用域记录；Workspace/User overlay 按同
                    key 的完整记录执行 Workspace 优先与 User 回退。API key 由 Control Plane
                    加密存储，不会出现在浏览器存储或日志中。
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
            <div
                class="flex w-full max-w-md flex-col rounded-xl border bg-card shadow-2xl"
                role="alertdialog"
                aria-modal="true"
            >
                <header class="border-b px-5 py-4">
                    <h3 class="text-lg font-semibold text-destructive">删除 Provider 连接</h3>
                    <p class="mt-1 text-sm text-muted-foreground">
                        确认删除「{{ deleteTarget.label }}」？此操作不可撤销。
                    </p>
                </header>
                <div class="px-5 py-4 text-sm">
                    <p v-if="deleteImpactLoading" class="text-muted-foreground">
                        正在加载删除影响预览...
                    </p>
                    <template v-else-if="deleteImpact">
                        <div
                            v-if="deleteImpact.blocked"
                            class="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2.5"
                            data-testid="provider-delete-blocked"
                        >
                            <p class="font-semibold text-destructive">
                                无法删除：仍有 {{ deleteImpact.sessionCount }} 个会话引用此连接
                            </p>
                            <p class="mt-1 text-xs text-muted-foreground">
                                请先删除或迁移这些会话，再删除连接。
                            </p>
                        </div>
                        <div
                            v-else-if="impactSummary(deleteImpact).length > 0"
                            data-testid="provider-delete-impact-summary"
                        >
                            <p class="mb-1.5 font-semibold">删除时将级联清理以下引用：</p>
                            <ul class="list-inside list-disc space-y-0.5 text-muted-foreground">
                                <li v-for="part in impactSummary(deleteImpact)" :key="part">
                                    {{ part }}
                                </li>
                            </ul>
                            <p class="mt-2 text-xs text-muted-foreground">
                                请求模板本体不受影响；其他连接与其引用保持不变。
                            </p>
                        </div>
                        <p v-else class="text-muted-foreground">
                            该连接没有引用它的模型绑定、默认模板指向或默认身份 profile。
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
                        class="rounded-md border px-3.5 py-2 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
                        data-testid="provider-delete-cancel"
                        @click="cancelDelete"
                    >
                        取消
                    </button>
                    <button
                        type="button"
                        class="rounded-md bg-destructive px-3.5 py-2 text-xs font-semibold text-destructive-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                        :disabled="deleteImpactLoading || deleting || !!deleteImpact?.blocked"
                        data-testid="provider-delete-confirm"
                        @click="confirmDelete"
                    >
                        {{ deleting ? "删除中..." : "确认删除" }}
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
                    <h3 class="text-lg font-semibold">选择 Provider</h3>
                    <label
                        class="mt-3 flex items-center gap-2.5 rounded-lg border bg-background px-3 py-2"
                    >
                        <Search class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <input
                            v-model="pickerSearch"
                            data-testid="provider-picker-search"
                            class="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                            placeholder="搜索名称、描述或 ID"
                        />
                    </label>
                </header>
                <div class="flex-1 overflow-y-auto px-2 py-2">
                    <p
                        v-if="selectableProviders.length === 0"
                        class="px-3 py-8 text-center text-sm text-muted-foreground"
                    >
                        没有匹配的 Provider
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
                                        >流式</span
                                    >
                                    <span
                                        v-if="provider.supports.tools"
                                        class="rounded bg-muted px-1 text-[10px] text-muted-foreground"
                                        >工具</span
                                    >
                                    <span
                                        v-if="provider.supports.vision"
                                        class="rounded bg-muted px-1 text-[10px] text-muted-foreground"
                                        >视觉</span
                                    >
                                    <span
                                        v-if="provider.supports.customBaseUrl"
                                        class="rounded bg-muted px-1 text-[10px] text-muted-foreground"
                                        >可自定义地址</span
                                    >
                                </span>
                            </span>
                            <span
                                v-if="connectedProviderIds.has(provider.id)"
                                class="shrink-0 text-[11px] text-muted-foreground"
                                >已连接</span
                            >
                        </button>
                    </template>
                </div>
                <footer
                    class="flex items-center justify-between border-t px-5 py-3 text-xs text-muted-foreground"
                >
                    <span>{{ selectableProviders.length }} 个可连接</span>
                    <button
                        class="rounded-md border px-3 py-1.5 transition-colors hover:border-primary hover:text-foreground"
                        @click="modalOpen = false"
                    >
                        取消
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
                        {{ editingConnection ? "管理 Provider" : "连接 Provider" }}
                    </h3>
                    <button
                        type="button"
                        class="text-2xl leading-none text-muted-foreground transition-colors hover:text-foreground"
                        aria-label="关闭"
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
                                将移除不兼容的模型模板覆盖：{{
                                    typeImpact.incompatibleOverrides.reduce(
                                        (sum, item) => sum + item.count,
                                        0,
                                    )
                                }}；{{ typeImpact.sessionRebindCount }}
                                个会话需显式重新绑定。共享模板与历史记录保留。
                            </p>
                            <label v-if="formOperation === 'chat'" class="block"
                                >新连接默认模板
                                <select
                                    v-model="targetDefaultKey"
                                    class="mt-1 w-full rounded border bg-background p-2"
                                    aria-label="新连接默认模板"
                                >
                                    <option value="" disabled>选择兼容模板</option>
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
                                ><input
                                    v-model="confirmedTypeChange"
                                    type="checkbox"
                                />确认协议变更及覆盖清理</label
                            >
                        </div>
                    </div>

                    <label class="block">
                        <span class="mb-1.5 block text-xs font-semibold">连接名称</span>
                        <input
                            v-model="form.label"
                            class="w-full rounded-md border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/30"
                            required
                            maxlength="128"
                        />
                    </label>
                    <label class="mt-4 block">
                        <span class="mb-1.5 block text-xs font-semibold">连接标识</span>
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
                        <span class="mt-1.5 block text-[11px] text-muted-foreground"
                            >小写字母、数字和连字符；同一
                            Provider/作用域内不可重复。保存后不可修改。</span
                        >
                    </label>
                    <label class="mt-4 block">
                        <span class="mb-1.5 block text-xs font-semibold">API key</span>
                        <input
                            v-model="form.apiKey"
                            class="w-full rounded-md border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/30"
                            type="password"
                            :placeholder="
                                editingConnection
                                    ? '留空表示不替换'
                                    : selectedProvider.credential.placeholder || '可选'
                            "
                        />
                        <span class="mt-1.5 block text-[11px] text-muted-foreground"
                            >密钥只提交一次，保存后不会回显。</span
                        >
                    </label>
                    <label v-if="selectedProvider.supports.customBaseUrl" class="mt-4 block">
                        <span class="mb-1.5 block text-xs font-semibold"
                            >Base URL
                            <span class="font-normal text-muted-foreground">可选</span></span
                        >
                        <input
                            v-model="form.baseUrl"
                            class="w-full rounded-md border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/30"
                            type="url"
                            :placeholder="selectedProvider.defaultBaseUrl || 'https://...'"
                        />
                    </label>
                    <div class="mt-4">
                        <span class="mb-1.5 block text-xs font-semibold">连接作用域</span>
                        <div class="grid grid-cols-2 gap-2">
                            <label
                                v-for="option in [
                                    { value: 'USER', title: '个人', desc: '仅自己可使用。' },
                                    {
                                        value: 'WORKSPACE',
                                        title: '工作区共享',
                                        desc: '工作区内授权用户可用。',
                                    },
                                ] as const"
                                :key="option.value"
                                class="cursor-pointer"
                            >
                                <input
                                    v-model="formScope"
                                    type="radio"
                                    name="provider-scope"
                                    :value="option.value"
                                    class="peer sr-only"
                                />
                                <span
                                    class="block h-full rounded-md border p-3 transition-colors peer-checked:border-primary peer-checked:bg-primary/5"
                                >
                                    <strong class="block text-xs font-semibold">{{
                                        option.title
                                    }}</strong>
                                    <span class="text-[11px] text-muted-foreground">{{
                                        option.desc
                                    }}</span>
                                </span>
                            </label>
                        </div>
                    </div>
                    <label class="mt-4 block">
                        <span class="mb-1.5 block text-xs font-semibold">模型发现</span>
                        <select
                            v-model="form.modelDiscovery"
                            class="w-full rounded-md border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/30"
                        >
                            <option value="remote-models">Provider /models</option>
                            <option value="litellm-catalog">LiteLLM Catalog</option>
                            <option value="curated">Provider 预置模型</option>
                            <option value="manual">手动输入模型</option>
                        </select>
                        <span class="mt-1.5 block text-[11px] text-muted-foreground"
                            >XH 会先验证连接可用，再让模型进入选择器。</span
                        >
                    </label>
                    <label v-if="form.modelDiscovery === 'manual'" class="mt-4 block">
                        <span class="mb-1.5 block text-xs font-semibold">模型列表</span>
                        <textarea
                            v-model="form.manualModels"
                            class="min-h-20 w-full rounded-md border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/30"
                            placeholder="每行一个模型 ID"
                        />
                    </label>
                </div>
                <footer class="flex justify-end gap-2 border-t bg-muted/30 px-5 py-3.5">
                    <button
                        type="button"
                        class="rounded-md border px-3.5 py-2 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
                        @click="closeForm"
                    >
                        取消
                    </button>
                    <button
                        type="submit"
                        class="rounded-md bg-primary px-3.5 py-2 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                        :disabled="saving"
                    >
                        {{ saving ? "保存中..." : "验证并保存" }}
                    </button>
                </footer>
            </form>
        </div>
    </section>
</template>
