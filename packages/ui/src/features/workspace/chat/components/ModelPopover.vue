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
import { listProviderConnections } from "../../../../services/providerConnectionService";

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

const currentValue = computed(() => {
    const binding = currentBinding.value;
    // Scoped bindings key options by connectionId; legacy provider-keyed
    // bindings fall back to the provider id, which is also their catalog key.
    return binding ? `${binding.connectionId ?? binding.provider}/${binding.model}` : undefined;
});

const triggerLabel = computed(() => {
    const binding = currentBinding.value;
    if (!binding) return t("chat.modelSelectorPlaceholder");
    const info = getProviderInfo(binding.provider),
        providerName = info?.name ?? binding.provider;
    return `${binding.model} · ${providerName}`;
});

const hasProviders = computed(() => {
    return Object.keys(configStore.modelCache.providers ?? {}).length > 0;
});

// PLAN-0307 T2.22/T2.17: readiness hint is grounded in provider_connections,
// not the removed config-table `*ApiKey` keys (decision #21).
const configuredConnectionCount = ref(0);

const hasConfiguredProvider = computed(() => configuredConnectionCount.value > 0);

const searchQuery = computed(() => searchTerm.value.toLowerCase().trim());

const providerGroups = computed(() => {
    const q = searchQuery.value;
    return Object.entries(configStore.modelCache.providers ?? {})
        .map(([catalogKey, catalog]) => {
            const provider = catalog.providerId ?? catalogKey,
                info = getProviderInfo(provider),
                modelIds = configStore.getChatModels(provider, catalogKey);
            const filtered = q
                ? modelIds.filter((model) => matchModel(provider, model, q))
                : modelIds;
            return {
                provider,
                catalogKey,
                name: catalog.displayName ?? info?.name ?? provider,
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
            .map((group) => ({ ...favorite, connectionId: group.connectionId })),
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
    if (!configStore.isChatModelAvailable(provider, model, connectionId)) {
        toast.error("Selected model is not currently available for chat");
        return;
    }
    if (sessionId) {
        try {
            const updated = await sessionStore.updateSession(sessionId, {
                modelProvider: provider,
                modelName: model,
                providerConnectionId: connectionId,
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
    listProviderConnections()
        .then((response) => {
            configuredConnectionCount.value = response.connections?.length ?? 0;
        })
        .catch((e) => {
            logger.warn("Failed to load provider connections for readiness hint", e);
        });
});
</script>

<template>
    <ComboboxRoot
        :model-value="currentValue"
        v-model:open="open"
        ignore-filter
        class="relative inline-block"
    >
        <ComboboxAnchor as-child>
            <ComboboxTrigger as-child>
                <button
                    data-testid="model-popover-trigger"
                    class="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md border border-dashed bg-muted/30 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors max-w-[240px] truncate"
                >
                    <Cpu class="size-3 shrink-0" aria-hidden="true" />
                    <span class="truncate">{{ triggerLabel }}</span>
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
                                :text-value="`${fav.model} ${getProviderInfo(fav.provider)?.name ?? fav.provider}`"
                                :data-testid="`model-item-${fav.provider}/${fav.model}`"
                                :data-model-key="`${fav.connectionId}/${fav.model}`"
                                class="w-full flex items-center justify-between px-2 py-1 text-xs rounded hover:bg-accent data-[highlighted]:bg-accent data-[state=checked]:bg-accent outline-none cursor-pointer"
                                @select="handleSelect"
                            >
                                <span class="truncate"
                                    >{{ fav.model }} ·
                                    {{ getProviderInfo(fav.provider)?.name ?? fav.provider }}</span
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
                                                <span>{{ group.name }}</span>
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
