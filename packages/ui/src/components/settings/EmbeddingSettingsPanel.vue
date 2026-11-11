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
import { useConfigStore, type ConfigLayer } from "../../stores/config";
import type { ProviderConnection } from "../../types/providerConnection";
import { logger } from "../../lib/logger";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";

const props = defineProps<{
    // task-253：工作区层已从 UI 移除。PLAN-0764 T1.5：实例层也渲染本面板（写 profile 单元），
    // 连接仍按消费用户 scope 解析（CP strictResolveConnection），实例层只负责默认身份。
    layer: ConfigLayer;
    saving?: boolean;
    readonly?: boolean;
}>();

const emit = defineEmits<{
    (e: "saved"): void;
}>();

const { t } = useI18n(),
    configStore = useConfigStore();
// Pre-load fallback only; the server-served contract wins once loaded.
const FALLBACK_MODEL = "tongyi-embedding-vision-flash-2026-03-06";
const FALLBACK_DIMENSION = 768;

/** PLAN-0523 T3.5: subscribe to the store's single-source connection list. */
const connections = computed<ProviderConnection[]>(() => configStore.providerConnections);
const effective = ref<EmbeddingEffectiveProfile | null>(null);
const selectedConnectionId = ref<string>("");
const testing = ref(false);
const testResult = ref<EmbeddingTestResult | null>(null);
const loading = ref(true);

const candidateConnections = computed(() => embeddingConnections(connections.value));

const contractModel = computed(() => effective.value?.contract?.modelId ?? FALLBACK_MODEL);
const contractDimension = computed(
    () => effective.value?.contract?.dimension ?? FALLBACK_DIMENSION,
);

const selectedConnection = computed(
    () => candidateConnections.value.find((item) => item.id === selectedConnectionId.value) ?? null,
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

/** F-07：`pinned-contract` 是 CP 内部来源值，正文必须给能读的说法；未知值原样显示。 */
function modelSourceText(source: string | null | undefined): string {
    if (!source) return "";
    if (source === "pinned-contract") return t("settings.embeddingModelSourcePinned");
    return source;
}

/** F-07：`profileScope` 是 meta 机器值（instance/user），正文用「实例层/用户层」。 */
function profileScopeText(scope: string | null | undefined): string {
    const KEY: Record<string, string> = {
        instance: "settings.ia.layerInstanceShort",
        user: "settings.ia.layerUserShort",
        workspace: "settings.ia.layerWorkspaceShort",
    };
    const key = scope ? KEY[scope] : undefined;
    return key ? t(key) : (scope ?? "");
}

async function load() {
    loading.value = true;
    try {
        // task-253：全局设置没有工作区上下文，effective 按实例/用户层求值即可。
        const profile = await fetchEmbeddingEffective();
        await configStore.loadProviderConnections();
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
        await saveEmbeddingProfile(props.layer, {
            providerId: selectedConnection.value.providerId,
            connectionKey: selectedConnection.value.connectionKey,
            model: contractModel.value,
        });
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
        await saveEmbeddingProfile(props.layer, null);
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
        const result = await testEmbedding();
        testResult.value = result;
        if (result.status === "ok") {
            toast.success(t("settings.embeddingTestOk"));
        } else {
            toast.error(result.errorCode ?? t("settings.embeddingTestFailed"));
        }
    } catch (cause) {
        logger.warn("Embedding test failed", cause);
        const code =
            cause instanceof ApiError
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
        <p
            v-if="layer === 'instance'"
            class="px-4 pb-1 text-xs text-muted-foreground"
            data-testid="embedding-instance-note"
        >
            {{ t("settings.embeddingInstanceNote") }}
        </p>
        <div class="px-4 pb-4 space-y-3">
            <div v-if="loading" class="text-sm text-muted-foreground">
                {{ t("common.loading") }}
            </div>
            <template v-else>
                <div class="space-y-1">
                    <label class="text-xs text-muted-foreground">
                        {{ t("settings.embeddingConnection") }}
                    </label>
                    <Select
                        :model-value="selectedConnectionId || '__none__'"
                        :disabled="readonly"
                        @update:model-value="
                            (value) =>
                                (selectedConnectionId =
                                    value === '__none__' ? '' : String(value ?? ''))
                        "
                    >
                        <SelectTrigger
                            data-testid="embedding-connection-select"
                            class="w-full border rounded px-2 py-1.5 text-sm bg-background disabled:opacity-60"
                        >
                            <SelectValue :placeholder="t('settings.embeddingConnectionNone')" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="__none__">{{
                                t("settings.embeddingConnectionNone")
                            }}</SelectItem>
                            <SelectItem
                                v-for="connection in candidateConnections"
                                :key="connection.id"
                                :value="connection.id"
                            >
                                {{ connection.label || connection.connectionKey }}
                                ({{
                                    connection.scope === "USER"
                                        ? t("settings.embeddingScopeUser")
                                        : t("settings.embeddingScopeWorkspace")
                                }})
                            </SelectItem>
                        </SelectContent>
                    </Select>
                    <p
                        v-if="candidateConnections.length === 0"
                        class="text-xs text-muted-foreground"
                    >
                        {{ t("settings.embeddingNoConnections") }}
                    </p>
                </div>

                <dl
                    class="grid grid-cols-2 gap-x-4 gap-y-1 text-sm"
                    data-testid="embedding-contract"
                >
                    <dt class="text-muted-foreground">{{ t("settings.embeddingModel") }}</dt>
                    <dd class="font-mono text-xs break-all">{{ contractModel }}</dd>
                    <dt class="text-muted-foreground">{{ t("settings.embeddingDimension") }}</dt>
                    <dd class="font-mono">{{ contractDimension }}</dd>
                    <template v-if="effective?.profile">
                        <dt class="text-muted-foreground">
                            {{ t("settings.embeddingEffectiveScope") }}
                        </dt>
                        <dd>{{ profileScopeText(effective.profileScope) }}</dd>
                        <dt class="text-muted-foreground">
                            {{ t("settings.embeddingModelSource") }}
                        </dt>
                        <dd>
                            {{
                                modelSourceText(effective.resolved?.modelSource) ||
                                effective.profile.model
                            }}
                        </dd>
                    </template>
                </dl>

                <div class="flex flex-wrap gap-2">
                    <button
                        v-if="!readonly"
                        data-testid="embedding-save"
                        class="px-3 py-1.5 text-sm border rounded hover:bg-muted disabled:opacity-50"
                        :disabled="saving || !selectedConnection"
                        @click="handleSave"
                    >
                        {{ t("common.save") }}
                    </button>
                    <button
                        v-if="!readonly"
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
