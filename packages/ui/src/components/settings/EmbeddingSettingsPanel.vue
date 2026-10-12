<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { ApiError } from "../../composables/api";
import {
    embeddingConnections,
    fetchEmbeddingEffective,
    saveEmbeddingProfile,
    testEmbedding,
    type EmbeddingEffectiveProfile,
    type EmbeddingTestResult,
} from "../../services/embeddingProfile";
import { listProviderConnections } from "../../services/providerConnectionService";
import type { ProviderConnection } from "../../types/providerConnection";
import { logger } from "../../lib/logger";

const props = defineProps<{
    layer: "user" | "workspace";
    workspaceId?: string;
    saving?: boolean;
}>();

const emit = defineEmits<{
    (e: "saved"): void;
}>();

const { t } = useI18n();
const SUPPORTED_MODEL = "tongyi-embedding-vision-flash-2026-03-06";
const SUPPORTED_DIMENSION = 768;

const connections = ref<ProviderConnection[]>([]);
const effective = ref<EmbeddingEffectiveProfile | null>(null);
const selectedConnectionId = ref<string>("");
const testing = ref(false);
const testResult = ref<EmbeddingTestResult | null>(null);
const loading = ref(true);

const candidateConnections = computed(() => embeddingConnections(connections.value));

const selectedConnection = computed(() =>
    candidateConnections.value.find((item) => item.id === selectedConnectionId.value) ?? null,
);

const currentProfileConnectionId = computed(() => {
    if (!effective.value?.profile) return "";
    return (
        candidateConnections.value.find(
            (item) =>
                item.providerId === effective.value?.profile?.providerId &&
                item.connectionKey === effective.value?.profile?.connectionKey,
        )?.id ?? ""
    );
});

async function load() {
    loading.value = true;
    try {
        const [connectionList, profile] = await Promise.all([
            listProviderConnections(),
            fetchEmbeddingEffective(props.workspaceId),
        ]);
        connections.value = connectionList.connections;
        effective.value = profile;
        selectedConnectionId.value = currentProfileConnectionId.value;
    } catch (cause) {
        logger.warn("Embedding settings load failed", cause);
    } finally {
        loading.value = false;
    }
}

async function handleSave() {
    if (!selectedConnection.value) {
        toast.error(t("settings.embeddingSelectRequired"));
        return;
    }
    try {
        await saveEmbeddingProfile(
            props.layer,
            {
                providerId: selectedConnection.value.providerId,
                connectionKey: selectedConnection.value.connectionKey,
                model: SUPPORTED_MODEL,
            },
            props.workspaceId,
        );
        toast.success(t("settings.embeddingSaved"));
        await load();
        emit("saved");
    } catch (cause) {
        logger.warn("Embedding profile save failed", cause);
        toast.error(t("settings.embeddingSaveFailed"));
    }
}

async function handleClear() {
    try {
        await saveEmbeddingProfile(props.layer, null, props.workspaceId);
        toast.success(t("settings.embeddingCleared"));
        await load();
        emit("saved");
    } catch (cause) {
        logger.warn("Embedding profile clear failed", cause);
        toast.error(t("settings.embeddingSaveFailed"));
    }
}

async function handleTest() {
    testing.value = true;
    testResult.value = null;
    try {
        const result = await testEmbedding(props.workspaceId);
        testResult.value = result;
        if (result.status === "ok") {
            toast.success(t("settings.embeddingTestOk"));
        } else {
            toast.error(result.errorCode ?? t("settings.embeddingTestFailed"));
        }
    } catch (cause) {
        logger.warn("Embedding test failed", cause);
        const code = cause instanceof ApiError
            ? cause.problem.code || "EMBEDDING_PROVIDER_UNREACHABLE"
            : "EMBEDDING_PROVIDER_UNREACHABLE";
        testResult.value = { status: "error", errorCode: code };
        toast.error(code);
    } finally {
        testing.value = false;
    }
}

onMounted(load);
</script>

<template>
    <div class="border rounded-lg mb-2 overflow-hidden" data-testid="embedding-settings">
        <div class="px-4 py-3 text-sm font-medium bg-muted/30">
            {{ t("settings.domainEmbedding") }}
        </div>
        <div class="px-4 pb-4 space-y-3">
            <div v-if="loading" class="text-sm text-muted-foreground">
                {{ t("common.loading") }}
            </div>
            <template v-else>
                <div class="space-y-1">
                    <label class="text-xs text-muted-foreground">
                        {{ t("settings.embeddingConnection") }}
                    </label>
                    <select
                        v-model="selectedConnectionId"
                        data-testid="embedding-connection-select"
                        class="w-full border rounded px-2 py-1.5 text-sm bg-background"
                    >
                        <option value="">
                            {{ t("settings.embeddingConnectionNone") }}
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
                    <p v-if="candidateConnections.length === 0" class="text-xs text-muted-foreground">
                        {{ t("settings.embeddingNoConnections") }}
                    </p>
                </div>

                <dl class="grid grid-cols-2 gap-x-4 gap-y-1 text-sm" data-testid="embedding-contract">
                    <dt class="text-muted-foreground">{{ t("settings.embeddingModel") }}</dt>
                    <dd class="font-mono text-xs break-all">{{ SUPPORTED_MODEL }}</dd>
                    <dt class="text-muted-foreground">{{ t("settings.embeddingDimension") }}</dt>
                    <dd class="font-mono">{{ SUPPORTED_DIMENSION }}</dd>
                    <template v-if="effective?.profile">
                        <dt class="text-muted-foreground">{{ t("settings.embeddingEffectiveScope") }}</dt>
                        <dd>{{ effective.profileScope }}</dd>
                        <dt class="text-muted-foreground">{{ t("settings.embeddingModelSource") }}</dt>
                        <dd>{{ effective.resolved?.modelSource ?? effective.profile.model }}</dd>
                    </template>
                </dl>

                <div class="flex flex-wrap gap-2">
                    <button
                        data-testid="embedding-save"
                        class="px-3 py-1.5 text-sm border rounded hover:bg-muted disabled:opacity-50"
                        :disabled="saving || !selectedConnection"
                        @click="handleSave"
                    >
                        {{ t("common.save") }}
                    </button>
                    <button
                        data-testid="embedding-clear"
                        class="px-3 py-1.5 text-sm border rounded hover:bg-muted"
                        :disabled="!effective?.profile"
                        @click="handleClear"
                    >
                        {{ t("settings.embeddingClearInherit") }}
                    </button>
                    <button
                        data-testid="embedding-test"
                        class="px-3 py-1.5 text-sm border rounded hover:bg-muted disabled:opacity-50"
                        :disabled="testing || !effective?.profile"
                        @click="handleTest"
                    >
                        {{ testing ? t("common.loading") : t("settings.embeddingTest") }}
                    </button>
                </div>

                <div
                    v-if="testResult"
                    class="text-xs space-y-0.5 border rounded p-2"
                    data-testid="embedding-test-result"
                >
                    <div>
                        {{ t("settings.embeddingTestStatus") }}:
                        {{ testResult.status }}
                    </div>
                    <div v-if="testResult.model">
                        {{ t("settings.embeddingModel") }}: {{ testResult.model }}
                    </div>
                    <div v-if="testResult.dimension">
                        {{ t("settings.embeddingDimension") }}: {{ testResult.dimension }}
                    </div>
                    <div v-if="testResult.requestId" class="font-mono break-all">
                        requestId: {{ testResult.requestId }}
                    </div>
                    <div v-if="testResult.errorCode" class="text-red-600">
                        {{ testResult.errorCode }}
                    </div>
                </div>
            </template>
        </div>
    </div>
</template>
