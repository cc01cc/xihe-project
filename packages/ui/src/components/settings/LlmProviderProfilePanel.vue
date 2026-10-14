<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { useConfigStore } from "../../stores/config";
import { listProviderConnections } from "../../services/providerConnectionService";
import type { ProviderConnection } from "../../types/providerConnection";
import { chatProfileConnections, parseLlmProfileValue } from "../../services/llmProviderProfile";
import { logger } from "../../lib/logger";

const props = defineProps<{
    layer: "user" | "workspace" | "instance";
    workspaceId?: string;
    entries: Record<string, string>;
    saving?: boolean;
}>();

const emit = defineEmits<{
    (e: "saved"): void;
}>();

const { t } = useI18n();
const configStore = useConfigStore();

/** Sentinel option value that flips the model select into free-text mode. */
const CUSTOM_OPTION = "__custom__";
/** Sentinel option value shown when the stored profile connection is no longer visible. */
const STORED_CONNECTION = "__stored__";

const connections = ref<ProviderConnection[]>([]);
const loading = ref(true);
const selectedConnectionId = ref("");
const modelValue = ref("");
const customModel = ref(false);

const profile = computed(() => parseLlmProfileValue(props.entries.profile));
const candidateConnections = computed(() => chatProfileConnections(connections.value));
const selectedConnection = computed(
    () => candidateConnections.value.find((item) => item.id === selectedConnectionId.value) ?? null,
);

/** The visible connection the stored profile points at (null when drifted/absent). */
const storedConnection = computed(() => {
    const current = profile.value;
    if (!current) return null;
    return (
        candidateConnections.value.find(
            (item) =>
                item.providerId === current.providerId &&
                item.connectionKey === current.connectionKey,
        ) ?? null
    );
});

/**
 * PLAN-0504 decision #12: a stored profile whose connection is no longer
 * visible stays visible and is never silently rewritten or replaced.
 */
const connectionDrifted = computed(() => !!profile.value && !storedConnection.value);

const modelCandidates = computed(() => {
    const connection = selectedConnection.value;
    if (!connection) return [];
    return configStore.getChatModels(connection.providerId, connection.id);
});

const modelDrifted = computed(() => {
    const value = modelValue.value;
    if (!value || customModel.value) return false;
    if (!selectedConnection.value) {
        // Stored connection drifted: keep the stored model visible and labelled.
        return !!profile.value;
    }
    return !modelCandidates.value.includes(value);
});

function syncFromEntries() {
    const current = profile.value;
    if (!current) {
        selectedConnectionId.value = "";
        modelValue.value = "";
        customModel.value = false;
        return;
    }
    selectedConnectionId.value = storedConnection.value?.id ?? STORED_CONNECTION;
    modelValue.value = current.model;
    customModel.value = false;
}

async function load() {
    loading.value = true;
    try {
        const list = await listProviderConnections();
        connections.value = list.connections;
        syncFromEntries();
    } catch (cause) {
        logger.warn("LLM profile panel load failed", cause);
    } finally {
        loading.value = false;
    }
}

watch(
    () => props.entries.profile,
    () => syncFromEntries(),
);
watch(candidateConnections, () => {
    if (!loading.value) syncFromEntries();
});

function onConnectionChange(value: string) {
    selectedConnectionId.value = value;
    if (!customModel.value) {
        modelValue.value = "";
    }
}

function onModelChange(value: string) {
    if (value === CUSTOM_OPTION) {
        customModel.value = true;
        return;
    }
    modelValue.value = value;
}

async function handleSave() {
    const connection = selectedConnection.value;
    const current = profile.value;
    let payload;
    if (connection) {
        if (!modelValue.value.trim()) {
            toast.error(t("settings.llmProfileModelRequired"));
            return;
        }
        payload = {
            providerId: connection.providerId,
            connectionKey: connection.connectionKey,
            model: modelValue.value.trim(),
        };
    } else if (current) {
        // Drifted stored profile: re-saving keeps it untouched.
        payload = { ...current };
    } else {
        toast.error(t("settings.llmProfileConnectionRequired"));
        return;
    }
    try {
        await configStore.putLayerConfig(
            props.layer,
            "llm-provider",
            { profile: JSON.stringify(payload) },
            props.workspaceId,
        );
        toast.success(t("settings.llmProfileSaved"));
        emit("saved");
    } catch (cause) {
        logger.warn("LLM profile save failed", cause);
        toast.error(t("settings.llmProfileSaveFailed"));
    }
}

async function handleClear() {
    try {
        await configStore.putLayerConfig(
            props.layer,
            "llm-provider",
            { profile: "" },
            props.workspaceId,
        );
        toast.success(t("settings.llmProfileCleared"));
        emit("saved");
    } catch (cause) {
        logger.warn("LLM profile clear failed", cause);
        toast.error(t("settings.llmProfileSaveFailed"));
    }
}

onMounted(load);
</script>

<template>
    <div class="border rounded-lg mb-2 overflow-hidden" data-testid="llm-provider-profile">
        <div class="px-4 py-3 text-sm font-medium bg-muted/30">
            {{ t("settings.llmProfileTitle") }}
        </div>
        <div class="px-4 pb-4 space-y-3">
            <div v-if="loading" class="text-sm text-muted-foreground">
                {{ t("common.loading") }}
            </div>
            <template v-else>
                <div class="space-y-1">
                    <label class="text-xs text-muted-foreground">
                        {{ t("settings.llmProfileConnection") }}
                    </label>
                    <select
                        :value="selectedConnectionId"
                        data-testid="llm-profile-connection-select"
                        class="w-full border rounded px-2 py-1.5 text-sm bg-background"
                        @change="onConnectionChange(($event.target as HTMLSelectElement).value)"
                    >
                        <option value="">
                            {{ t("settings.llmProfileConnectionNone") }}
                        </option>
                        <option
                            v-if="connectionDrifted && profile"
                            :value="STORED_CONNECTION"
                            data-testid="llm-profile-connection-drift-option"
                        >
                            {{
                                t("settings.driftedOption", {
                                    value: `${profile.providerId}/${profile.connectionKey}`,
                                })
                            }}
                        </option>
                        <option
                            v-for="connection in candidateConnections"
                            :key="connection.id"
                            :value="connection.id"
                        >
                            {{ connection.label || connection.connectionKey }}
                            ({{ connection.scope === "USER" ? "个人" : "工作区" }})
                        </option>
                    </select>
                    <p
                        v-if="candidateConnections.length === 0 && !connectionDrifted"
                        class="text-xs text-muted-foreground"
                    >
                        {{ t("settings.llmProfileNoConnections") }}
                    </p>
                    <span
                        v-if="connectionDrifted"
                        data-testid="llm-profile-connection-drift"
                        class="inline-block text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-amber-500/60 text-amber-600"
                        :title="t('settings.driftedHint')"
                        >{{ t("settings.driftedBadge") }}</span
                    >
                </div>

                <div class="space-y-1">
                    <label class="text-xs text-muted-foreground">
                        {{ t("settings.llmProfileModel") }}
                    </label>
                    <input
                        v-if="customModel"
                        v-model="modelValue"
                        data-testid="llm-profile-model-custom"
                        class="w-full border rounded px-2 py-1.5 text-sm bg-background"
                        :placeholder="t('settings.customPlaceholder')"
                    />
                    <select
                        v-else
                        :value="modelValue"
                        data-testid="llm-profile-model-select"
                        class="w-full border rounded px-2 py-1.5 text-sm bg-background"
                        @change="onModelChange(($event.target as HTMLSelectElement).value)"
                    >
                        <option value="">{{ t("settings.notSet") }}</option>
                        <option v-if="modelDrifted" :value="modelValue">
                            {{ t("settings.driftedOption", { value: modelValue }) }}
                        </option>
                        <option v-for="model in modelCandidates" :key="model" :value="model">
                            {{ model }}
                        </option>
                        <option :value="CUSTOM_OPTION">
                            {{ t("settings.customOption") }}
                        </option>
                    </select>
                    <p
                        v-if="selectedConnection && modelCandidates.length === 0"
                        class="text-xs text-muted-foreground"
                    >
                        {{ t("settings.llmProfileNoModels") }}
                    </p>
                    <button
                        v-if="customModel"
                        data-testid="llm-profile-model-custom-exit"
                        class="text-xs text-muted-foreground hover:text-foreground px-1"
                        @click="customModel = false"
                    >
                        {{ t("settings.customBack") }}
                    </button>
                </div>

                <p
                    v-if="!profile"
                    data-testid="llm-profile-empty-hint"
                    class="text-xs text-muted-foreground"
                >
                    {{ t("settings.llmProfileEmptyHint") }}
                </p>

                <div class="flex flex-wrap gap-2">
                    <button
                        data-testid="llm-profile-save"
                        class="px-3 py-1.5 text-sm border rounded hover:bg-muted disabled:opacity-50"
                        :disabled="
                            saving ||
                            loading ||
                            (!connectionDrifted && (!selectedConnection || !modelValue.trim()))
                        "
                        @click="handleSave"
                    >
                        {{ t("common.save") }}
                    </button>
                    <button
                        data-testid="llm-profile-clear"
                        class="px-3 py-1.5 text-sm border rounded hover:bg-muted"
                        :disabled="!profile"
                        @click="handleClear"
                    >
                        {{ t("settings.llmProfileClearInherit") }}
                    </button>
                </div>
            </template>
        </div>
    </div>
</template>
