<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import {
    ComboboxAnchor,
    ComboboxRoot,
    ComboboxTrigger,
    ComboboxInput,
    ComboboxContent,
    ComboboxViewport,
    ComboboxItem,
    ComboboxGroup,
    ComboboxLabel,
    ComboboxEmpty,
    ComboboxPortal,
    CollapsibleRoot,
    CollapsibleTrigger,
    CollapsibleContent,
} from "reka-ui";
import { useConfigStore } from "../../../../stores/config";
import { useSessionStore } from "../../../../stores/session";
import { ChevronDown, ChevronRight, ChevronUp, Cpu, Star, StarOff } from "@lucide/vue";
import { ApiError } from "../../../../composables/api";
import { logger } from "../../../../lib/logger";
import { toast } from "vue-sonner";
import { getProviderInfo } from "../../../../types/provider";
import type { ProviderConnection } from "../../../../types/providerConnection";
import { parseLlmProfileValue } from "../../../../services/llmProviderProfile";
import { resolveModelDisplay } from "../modelDisplay";
import {
    listVisibleTemplates,
    templateKey,
    type TemplateOption,
} from "../../../../services/apiRequestTemplates";

const { t } = useI18n();
const router = useRouter(),
    configStore = useConfigStore(),
    sessionStore = useSessionStore();

const open = ref(false),
    searchTerm = ref(""),
    collapsedProviders = ref<Set<string>>(new Set());

watch(open, (isOpen) => {
    if (isOpen) {
        void nextTick(() => {
            searchTerm.value = "";
        });
    }
});

watch(
    () => configStore.modelError,
    (val) => {
        if (val) {
            toast.error(val);
            configStore.modelError = null;
        }
    },
);

const currentBinding = computed(() => {
    const sessionId = sessionStore.currentSessionId;
    if (!sessionId) return undefined;
    return configStore.getEffectiveModel(sessionId);
});

const currentSession = computed(() => {
    const sessionId = sessionStore.currentSessionId;
    if (!sessionId) return undefined;
    return sessionStore.sessions.find((item) => item.id === sessionId);
});

const profileDefault = computed(() =>
    parseLlmProfileValue(configStore.mergedConfig["llm-provider"]?.profile),
);

// PLAN-0555: the server Session is authoritative for a bound run, so the label
// resolves Session -> local binding -> profile without changing dispatch.
const modelDisplay = computed(() =>
    resolveModelDisplay({
        session: currentSession.value,
        binding: currentBinding.value,
        profile: profileDefault.value,
        catalogs: configStore.modelCache.providers,
        connections: connections.value,
        connectionsLoaded: configStore.providerConnectionsLoaded,
        connectionsError: configStore.providerConnectionsError,
        fallbackProviderName: (providerId) => getProviderInfo(providerId)?.name,
    }),
);

const currentValue = computed(() => {
    const binding = currentBinding.value;
    // Scoped bindings key options by connectionId; legacy provider-keyed
    // bindings fall back to the provider id, which is also their catalog key.
    return binding ? `${binding.connectionId ?? binding.provider}/${binding.model}` : undefined;
});

const triggerLabel = computed(() => {
    const display = modelDisplay.value;
    if (!display.hasBinding) return t("chat.modelSelectorPlaceholder");
    return `${display.model} · ${display.providerName} · ${display.connectionDisplay}`;
});

const connectionTooltip = computed(() => {
    const display = modelDisplay.value;
    if (display.state === "loading") return t("chat.connectionLoading");
    if (display.state === "unavailable") return t("chat.connectionUnavailable");
    if (display.state === "not-recorded") return t("chat.connectionNotRecorded");
    return display.connectionDisplay;
});

const hasProviders = computed(() => {
    return Object.keys(configStore.modelCache.providers ?? {}).length > 0;
});

// PLAN-0307 T2.22/T2.17: readiness hint is grounded in provider_connections,
// not the removed config-table `*ApiKey` keys (decision #21).
// PLAN-0523 T3.5: subscribe to the store's single-source connection list.
const configuredConnectionCount = computed(() => configStore.providerConnections.length);
const connections = computed<ProviderConnection[]>(() => configStore.providerConnections);
const pendingSwitch = ref<{
    provider: string;
    model: string;
    connection: ProviderConnection;
    sessionId: string;
} | null>(null);
const switchTemplates = ref<TemplateOption[]>([]);
const selectedTemplate = ref("");
const switching = ref(false);
const effectiveConnections = computed(() => {
    const slots = new Map<string, ProviderConnection>();
    for (const item of connections.value.filter(
        (item) => item.enabled && item.status === "READY" && item.operation === "chat",
    )) {
        const key = item.providerId + ":" + item.connectionKey;
        if (!slots.has(key) || item.scope === "WORKSPACE") slots.set(key, item);
    }
    return new Set([...slots.values()].map((item) => item.id));
});

const hasConfiguredProvider = computed(() => configuredConnectionCount.value > 0);

const searchQuery = computed(() => searchTerm.value.toLowerCase().trim());

const providerGroups = computed(() => {
    const q = searchQuery.value;
    return Object.entries(configStore.modelCache.providers ?? {})
        .filter(([key]) => effectiveConnections.value.has(key))
        .map(([catalogKey, catalog]) => {
            const provider = catalog.providerId ?? catalogKey,
                info = getProviderInfo(provider),
                modelIds = configStore.getChatModels(provider, catalogKey);
            const filtered = q
                ? modelIds.filter((model) => matchModel(provider, model, q))
                : modelIds;
            const connection = connections.value.find((item) => item.id === catalogKey),
                providerName = catalog.displayName ?? info?.name ?? provider,
                // PLAN-0555: the group header follows the trigger's label-first rule;
                // the connection key stays visible as a chip for disambiguation.
                connectionLabel = (connection?.label ?? "").trim(),
                connectionDisplay =
                    connectionLabel || connection?.connectionKey || catalogKey || null;
            return {
                provider,
                catalogKey,
                providerName,
                connectionDisplay,
                connectionKey: connection?.connectionKey ?? null,
                name: [providerName, connectionDisplay].filter(Boolean).join(" · "),
                connectionId: catalogKey,
                connectionRevision: catalog.connectionRevision,
                models: filtered,
            };
        })
        .filter((g) => g.models.length > 0);
});

const filteredFavorites = computed(() => {
    const favs = configStore.modelFavorites;
    if (favs.length === 0) return [];
    return favs.flatMap((favorite) =>
        providerGroups.value
            .filter(
                (group) =>
                    group.provider === favorite.provider && group.models.includes(favorite.model),
            )
            .map((group) => ({
                ...favorite,
                connectionId: group.connectionId,
                providerName: group.providerName,
                connectionDisplay: group.connectionDisplay,
            })),
    );
});

const hasAnyModels = computed(
    () => providerGroups.value.length > 0 || filteredFavorites.value.length > 0,
);

const hasAnyUnfilteredModels = computed(() => {
    return Object.entries(configStore.modelCache.providers ?? {}).some(
        ([catalogKey, catalog]) =>
            configStore.getChatModels(catalog.providerId ?? catalogKey, catalogKey).length > 0,
    );
});

function matchModel(provider: string, model: string, q: string): boolean {
    const info = getProviderInfo(provider),
        text = `${model} ${info?.name ?? provider}`.toLowerCase();
    return text.includes(q);
}

function isGroupCollapsed(catalogKey: string): boolean {
    if (searchQuery.value) return false;
    return collapsedProviders.value.has(catalogKey);
}

function setGroupCollapsed(catalogKey: string, collapsed: boolean) {
    if (searchQuery.value) return;
    if (collapsed) {
        collapsedProviders.value.add(catalogKey);
    } else {
        collapsedProviders.value.delete(catalogKey);
    }
}

async function selectModel(value: string) {
    const slash = value.indexOf("/");
    if (slash < 0) return;
    // Option values are the catalog map key: a concrete connectionId for scoped
    // catalogs, or the provider id for legacy provider-keyed catalogs.
    const catalogKey = value.slice(0, slash),
        model = value.slice(slash + 1);
    const catalog = configStore.modelCache.providers?.[catalogKey],
        sessionId = sessionStore.currentSessionId;
    if (!catalog) {
        toast.error("Selected model is not currently available for chat");
        return;
    }
    const provider = catalog.providerId ?? catalogKey,
        // Legacy catalogs have no concrete ProviderConnection to bind; omit the
        // field entirely so PATCH keeps provider/model only (pre-0438 behavior).
        connectionId = catalog.connectionId;
    const target = connections.value.find((item) => item.id === connectionId);
    if (!target || !effectiveConnections.value.has(target.id)) return;
    if (!configStore.isChatModelAvailable(provider, model, connectionId)) {
        toast.error("Selected model is not currently available for chat");
        return;
    }
    if (sessionId) {
        const session = sessionStore.sessions.find((item) => item.id === sessionId);
        const previous = connections.value.find(
            (item) => item.id === session?.providerConnectionId,
        );
        if (
            previous &&
            (previous.apiTypeId !== target.apiTypeId ||
                previous.apiTypeVersion !== target.apiTypeVersion)
        ) {
            try {
                const choices = await listVisibleTemplates(session?.workspaceId);
                if (sessionStore.currentSessionId !== sessionId) return;
                switchTemplates.value = choices.filter(
                    (item) =>
                        item.apiTypeId === target.apiTypeId &&
                        item.apiTypeVersion === target.apiTypeVersion,
                );
                selectedTemplate.value = "";
                pendingSwitch.value = { provider, model, connection: target, sessionId };
                open.value = false;
            } catch (cause) {
                logger.warn("Compatible template load failed", cause);
                toast.error(t("settings.apiRequest.loadFailed"));
            }
            return;
        }
        try {
            const updated = await sessionStore.updateSession(sessionId, {
                modelProvider: provider,
                modelName: model,
                providerConnectionId: connectionId,
                connectionRevision: target.revision,
            });
            configStore.setSessionModel(
                sessionId,
                updated.modelProvider ?? provider,
                updated.modelName ?? model,
                updated.providerConnectionId ?? connectionId,
                updated.connectionRevision ?? catalog.connectionRevision,
            );
        } catch (cause: unknown) {
            const message =
                cause instanceof ApiError ? cause.message : "Failed to persist model binding";
            logger.warn("Persist model binding failed", cause);
            toast.error(message);
            return;
        }
    }
    open.value = false;
    searchTerm.value = "";
}

async function confirmSwitch() {
    const pending = pendingSwitch.value;
    const template = switchTemplates.value.find(
        (item) => templateKey(item) === selectedTemplate.value,
    );
    if (!pending || !template || switching.value) return;
    switching.value = true;
    try {
        const updated = await sessionStore.updateSession(pending.sessionId, {
            modelProvider: pending.provider,
            modelName: pending.model,
            providerConnectionId: pending.connection.id,
            connectionRevision: pending.connection.revision,
            contextTemplateLayer: template.layer,
            contextTemplateId: template.templateId,
            contextTemplateVersion: template.version,
            confirmedTypeChange: true,
        });
        configStore.setSessionModel(
            pending.sessionId,
            updated.modelProvider ?? pending.provider,
            updated.modelName ?? pending.model,
            updated.providerConnectionId ?? pending.connection.id,
            updated.connectionRevision ?? pending.connection.revision,
        );
        if (pendingSwitch.value === pending) pendingSwitch.value = null;
    } catch (cause) {
        logger.warn("Session protocol switch failed", cause);
        toast.error(
            cause instanceof Error ? cause.message : t("settings.apiRequest.validationFailed"),
        );
    } finally {
        switching.value = false;
    }
}

function toggleFav(provider: string, model: string) {
    configStore.toggleFavorite(provider, model);
}

function goToSettings() {
    open.value = false;
    router.push("/settings/config");
}

function handleSelect(event: { detail: { value?: string } }) {
    const value = event.detail.value;
    if (value) void selectModel(value);
}

onMounted(() => {
    configStore.fetchModels();
    configStore.loadProviderConnections().catch((e) => {
        logger.warn("Failed to load provider connections for readiness hint", e);
    });
});
</script>

<template>
    <div
        v-if="pendingSwitch"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
        role="dialog"
        aria-modal="true"
        :aria-label="t('settings.apiRequest.chooseTemplate')"
    >
        <div class="w-full max-w-md space-y-4 rounded-lg border bg-background p-5 shadow-xl">
            <p class="text-sm">{{ t("settings.apiRequest.switchConfirm") }}</p>
            <p class="text-xs text-muted-foreground">
                {{ pendingSwitch.model }} ·
                {{
                    configStore.modelCache.providers?.[pendingSwitch.connection.id]?.displayName ??
                    getProviderInfo(pendingSwitch.provider)?.name ??
                    pendingSwitch.provider
                }}
                ·
                {{
                    pendingSwitch.connection.label.trim() || pendingSwitch.connection.connectionKey
                }}
                · {{ pendingSwitch.connection.apiTypeId }}@{{
                    pendingSwitch.connection.apiTypeVersion
                }}
            </p>
            <select
                v-model="selectedTemplate"
                class="w-full rounded border bg-background p-2 text-sm"
                :aria-label="t('settings.apiRequest.chooseTemplate')"
            >
                <option value="" disabled>{{ t("settings.apiRequest.chooseTemplate") }}</option>
                <option
                    v-for="item in switchTemplates"
                    :key="templateKey(item)"
                    :value="templateKey(item)"
                >
                    {{ item.name }} v{{ item.version }}
                </option>
            </select>
            <div class="flex justify-end gap-2">
                <button
                    type="button"
                    class="rounded border px-3 py-2 text-sm"
                    :disabled="switching"
                    @click="pendingSwitch = null"
                >
                    {{ t("common.cancel") }}
                </button>
                <button
                    type="button"
                    class="rounded bg-primary px-3 py-2 text-sm text-primary-foreground"
                    :disabled="switching || !selectedTemplate"
                    @click="confirmSwitch"
                >
                    {{ t("common.confirm") }}
                </button>
            </div>
        </div>
    </div>
    <ComboboxRoot
        :model-value="currentValue"
        v-model:open="open"
        ignore-filter
        class="relative inline-block min-w-0 max-w-full"
    >
        <ComboboxAnchor as-child>
            <ComboboxTrigger as-child>
                <button
                    data-testid="model-popover-trigger"
                    class="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border border-dashed bg-muted/30 px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:max-w-[420px]"
                    :aria-label="triggerLabel"
                >
                    <Cpu class="size-3 shrink-0" aria-hidden="true" />
                    <template v-if="modelDisplay.hasBinding">
                        <span
                            data-testid="model-trigger-segment-model"
                            class="model-seg relative min-w-[44px] max-w-[160px] flex-[1.4]"
                            :data-tooltip="modelDisplay.model ?? ''"
                        >
                            <span class="block truncate">{{ modelDisplay.model }}</span>
                        </span>
                        <span class="shrink-0 opacity-60" aria-hidden="true"> · </span>
                        <span
                            data-testid="model-trigger-segment-provider"
                            class="model-seg relative min-w-[34px] max-w-[80px] flex-[0.8]"
                            :data-tooltip="modelDisplay.providerName ?? ''"
                        >
                            <span class="block truncate">{{ modelDisplay.providerName }}</span>
                        </span>
                        <span class="shrink-0 opacity-60" aria-hidden="true"> · </span>
                        <span
                            data-testid="model-trigger-segment-connection"
                            class="model-seg model-seg-end relative min-w-[44px] max-w-[128px] flex-[1.2]"
                            :data-tooltip="connectionTooltip"
                        >
                            <span class="block truncate">{{ modelDisplay.connectionDisplay }}</span>
                        </span>
                    </template>

                    <span v-else class="truncate">{{ triggerLabel }}</span>
                    <ChevronUp class="size-3 shrink-0 opacity-50" aria-hidden="true" />
                </button>
            </ComboboxTrigger>
        </ComboboxAnchor>

        <ComboboxPortal>
            <ComboboxContent
                position="popper"
                side="top"
                align="start"
                :side-offset="4"
                class="z-50 min-w-[260px] max-w-[420px] max-h-[420px] overflow-hidden rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
            >
                <ComboboxViewport class="max-h-[400px] overflow-y-auto">
                    <div
                        v-if="!hasProviders && !hasConfiguredProvider"
                        class="px-3 py-4 text-center"
                    >
                        <button
                            class="text-xs text-muted-foreground underline hover:text-foreground"
                            @click="goToSettings"
                        >
                            {{ t("chat.noProvidersConfigured") }}
                        </button>
                    </div>

                    <div
                        v-else-if="!hasProviders && hasConfiguredProvider"
                        class="px-3 py-4 text-center space-y-2"
                    >
                        <div class="text-xs text-muted-foreground">
                            {{ t("chat.providersNoModels") }}
                        </div>
                        <button
                            class="text-xs text-primary underline hover:text-primary/80"
                            @click="configStore.fetchModels()"
                        >
                            {{ t("chat.retryFetchModels") }}
                        </button>
                    </div>

                    <div
                        v-else-if="!hasAnyUnfilteredModels"
                        class="px-3 py-4 text-center text-xs text-muted-foreground"
                    >
                        {{ t("chat.providersNoModels") }}
                    </div>

                    <template v-else>
                        <div class="px-2 pb-1 sticky top-0 bg-popover z-10">
                            <ComboboxInput
                                v-model="searchTerm"
                                data-testid="model-popover-search"
                                class="w-full px-2 py-1 text-xs rounded border bg-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                                :placeholder="t('chat.searchModels')"
                                @focus="searchTerm = ''"
                            />
                        </div>

                        <ComboboxEmpty
                            v-if="!hasAnyModels"
                            class="px-3 py-4 text-center text-xs text-muted-foreground"
                        >
                            {{ t("chat.noSearchResults") }}
                        </ComboboxEmpty>

                        <ComboboxGroup v-if="filteredFavorites.length > 0" class="py-1">
                            <ComboboxLabel
                                class="px-2 py-1 text-xs font-medium text-muted-foreground flex items-center gap-1"
                            >
                                <Star class="size-3" aria-hidden="true" />
                                {{ t("chat.favorites") }}
                            </ComboboxLabel>
                            <ComboboxItem
                                v-for="fav in filteredFavorites"
                                :key="`fav-${fav.connectionId}-${fav.model}`"
                                :value="`${fav.connectionId}/${fav.model}`"
                                :text-value="`${fav.model} ${fav.providerName} ${fav.connectionDisplay ?? ''}`"
                                :data-testid="`model-item-${fav.provider}/${fav.model}`"
                                :data-model-key="`${fav.connectionId}/${fav.model}`"
                                class="w-full flex items-center justify-between px-2 py-1 text-xs rounded hover:bg-accent data-[highlighted]:bg-accent data-[state=checked]:bg-accent outline-none cursor-pointer"
                                @select="handleSelect"
                            >
                                <span class="truncate"
                                    >{{ fav.model }} · {{ fav.providerName
                                    }}<template v-if="fav.connectionDisplay">
                                        · {{ fav.connectionDisplay }}</template
                                    ></span
                                >
                                <button
                                    class="size-5 flex items-center justify-center shrink-0 rounded hover:bg-background"
                                    :data-testid="`model-favorite-${fav.provider}/${fav.model}`"
                                    :aria-label="
                                        configStore.isFavorite(fav.provider, fav.model)
                                            ? 'Unfavorite'
                                            : 'Favorite'
                                    "
                                    @click.stop.prevent="toggleFav(fav.provider, fav.model)"
                                    @pointerdown.stop
                                >
                                    <Star
                                        v-if="configStore.isFavorite(fav.provider, fav.model)"
                                        class="size-3 text-yellow-500"
                                        aria-hidden="true"
                                    />
                                    <StarOff v-else class="size-3 opacity-30" aria-hidden="true" />
                                </button>
                            </ComboboxItem>
                        </ComboboxGroup>

                        <template v-for="group in providerGroups" :key="group.catalogKey">
                            <CollapsibleRoot
                                :open="!isGroupCollapsed(group.catalogKey)"
                                :unmount-on-hide="false"
                                :data-testid="`model-group-${group.provider}`"
                                :data-connection-id="group.connectionId"
                                @update:open="setGroupCollapsed(group.catalogKey, !$event)"
                            >
                                <ComboboxGroup class="py-1">
                                    <ComboboxLabel
                                        class="px-2 py-1 text-xs font-medium text-muted-foreground"
                                    >
                                        <CollapsibleTrigger as-child>
                                            <button
                                                class="w-full flex items-center gap-1 hover:text-foreground transition-colors"
                                            >
                                                <ChevronRight
                                                    v-if="isGroupCollapsed(group.catalogKey)"
                                                    class="size-3"
                                                    aria-hidden="true"
                                                />
                                                <ChevronDown
                                                    v-else
                                                    class="size-3"
                                                    aria-hidden="true"
                                                />
                                                <span class="truncate">{{ group.name }}</span>
                                                <code
                                                    v-if="group.connectionKey"
                                                    class="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] font-normal opacity-80"
                                                    >{{ group.connectionKey }}</code
                                                >
                                                <span class="text-[10px] opacity-60 ml-auto">{{
                                                    group.models.length
                                                }}</span>
                                            </button>
                                        </CollapsibleTrigger>
                                    </ComboboxLabel>

                                    <CollapsibleContent>
                                        <ComboboxItem
                                            v-for="model in group.models"
                                            :key="`${group.connectionId}-${model}`"
                                            :value="`${group.connectionId}/${model}`"
                                            :text-value="`${model} ${group.name}`"
                                            :data-testid="`model-item-${group.provider}/${model}`"
                                            :data-model-key="`${group.connectionId}/${model}`"
                                            class="w-full flex items-center justify-between px-2 py-1 pl-6 text-xs rounded hover:bg-accent data-[highlighted]:bg-accent data-[state=checked]:bg-accent outline-none cursor-pointer"
                                            @select="handleSelect"
                                        >
                                            <div class="min-w-0 flex items-center gap-2">
                                                <span class="truncate">{{ model }}</span>
                                            </div>
                                            <button
                                                class="size-5 flex items-center justify-center shrink-0 rounded hover:bg-background"
                                                :data-testid="`model-favorite-${group.provider}/${model}`"
                                                :aria-label="
                                                    configStore.isFavorite(group.provider, model)
                                                        ? 'Unfavorite'
                                                        : 'Favorite'
                                                "
                                                @click.stop.prevent="
                                                    toggleFav(group.provider, model)
                                                "
                                                @pointerdown.stop
                                            >
                                                <Star
                                                    v-if="
                                                        configStore.isFavorite(
                                                            group.provider,
                                                            model,
                                                        )
                                                    "
                                                    class="size-3 text-yellow-500"
                                                    aria-hidden="true"
                                                />
                                                <StarOff
                                                    v-else
                                                    class="size-3 opacity-30"
                                                    aria-hidden="true"
                                                />
                                            </button>
                                        </ComboboxItem>
                                    </CollapsibleContent>
                                </ComboboxGroup>
                            </CollapsibleRoot>
                        </template>
                    </template>
                </ComboboxViewport>
            </ComboboxContent>
        </ComboboxPortal>
    </ComboboxRoot>
</template>

<style scoped>
.model-seg::after {
    content: attr(data-tooltip);
    position: absolute;
    bottom: calc(100% + 6px);
    left: 0;
    z-index: 50;
    display: none;
    width: max-content;
    max-width: 280px;
    border-radius: 6px;
    background: var(--foreground);
    color: var(--background);
    padding: 4px 8px;
    font-size: 11px;
    font-weight: 400;
    line-height: 1.4;
    overflow-wrap: anywhere;
    box-shadow: 0 10px 30px rgb(0 0 0 / 0.12);
    pointer-events: none;
}
.model-seg-end::after {
    left: auto;
    right: 0;
}
.model-seg:hover::after,
.model-seg:focus-within::after {
    display: block;
}
/* Touch devices have no hover; the expanded picker carries the full text. */
@media (hover: none) {
    .model-seg::after {
        display: none !important;
    }
}
</style>
