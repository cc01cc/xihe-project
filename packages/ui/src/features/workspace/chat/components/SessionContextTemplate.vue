<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { request, type ApiSession } from "../../../../composables/api";
import { logger } from "../../../../lib/logger";
import {
    listVisibleTemplates,
    templateKey as optionKey,
    templateLabel,
    type TemplateOption,
} from "../../../../services/apiRequestTemplates";
import { useConfigStore } from "../../../../stores/config";
import { useSessionStore } from "../../../../stores/session";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
const props = defineProps<{
    sessionId: string;
    /**
     * PLAN-0626 M2: the control itself moved to the dock's `context` panel. The chat
     * summary keeps this component mounted with `summary-only`, so its "模板 + 版本 +
     * 风险" projection keeps working without a second resolver.
     */
    summaryOnly?: boolean;
}>();
const emit = defineEmits<{
    "update:summary": [summary: { label: string | null; loading: boolean; failed: boolean }];
}>();
const { t } = useI18n();
const sessionStore = useSessionStore(),
    configStore = useConfigStore();
/**
 * task-253：可选项只来自实例/用户两层（`listVisibleTemplates()`），但**会话记录里已存的绑定**
 * 可能指向历史 workspace 层模板（CP Session 契约只标 deprecated、枚举未删）。UI 不再新增该层
 * 绑定，读回时仍须如实展示 —— 所以展示侧的 layer 放宽为 string，写入侧仍只发两层。
 */
type TemplateDisplay = Omit<TemplateOption, "layer"> & { layer: string };

const options = ref<TemplateOption[]>([]),
    binding = ref<TemplateDisplay | null>(null);
const session = ref<ApiSession | null>(null),
    busy = ref(false),
    error = ref<string | null>(null);
const current = computed(() => binding.value);
const loading = ref(false);
/**
 * DSD-1508 ③：标签、摘要、toast 走同一个纯函数 `templateLabel`（services 侧可单测），
 * 免得三处各拼一遍 "name v{version}" —— 里程碑前就是这种重复拼法在真栈显示成「default v2 v2」。
 */
const currentLabel = computed(() =>
    current.value ? templateLabel(current.value.name, current.value.version) : null,
);
/** 层名沿用设置区既有词条（实例层 / 个人层 / 工作区层），不新增 i18n key。 */
const LAYER_KEYS: Record<string, string> = {
    instance: "settings.contextTemplate.layerInstance",
    user: "settings.contextTemplate.layerUser",
    workspace: "settings.contextTemplate.layerWorkspace",
};
function layerLabel(layer: string): string {
    const key = LAYER_KEYS[layer];
    return key ? t(key) : layer;
}
/** DSD-1508 ③：选项次级文本 = 层 + API 类型/版本，让同名的 v1 / v2 不只靠尾部数字区分。 */
function optionMeta(option: TemplateDisplay): string {
    const apiType = option.apiTypeId ? `${option.apiTypeId} v${option.apiTypeVersion}` : "";
    return [layerLabel(option.layer), apiType].filter(Boolean).join(" · ");
}
let generation = 0;
let loadedSessionId = "";
// The collapsed summary row lives in SessionSettingsPanel; it must show the
// resolved template name without duplicating the whole control row.
watch(
    [currentLabel, loading, error],
    () => {
        emit("update:summary", {
            label: currentLabel.value,
            loading: loading.value,
            failed: Boolean(error.value),
        });
    },
    { immediate: true },
);
onBeforeUnmount(() => {
    generation++;
});
function findOption(layer: string, templateId: string, version: number) {
    return options.value.find(
        (item) =>
            item.layer === layer && item.templateId === templateId && item.version === version,
    );
}
watch(
    () => [
        props.sessionId,
        sessionStore.sessions.find((item) => item.id === props.sessionId)?.updatedAt,
    ],
    () => {
        const currentGeneration = ++generation;
        const sessionId = props.sessionId;
        options.value = [];
        session.value = null;
        loadedSessionId = "";
        busy.value = false;
        binding.value = null;
        error.value = null;
        loading.value = !!sessionId;
        if (!sessionId) return;
        void (async () => {
            try {
                const loaded = await request<ApiSession>(
                    "/sessions/" + encodeURIComponent(sessionId),
                );
                const [all] = await Promise.all([
                    listVisibleTemplates(),
                    configStore.loadProviderConnections(),
                ]);
                if (generation !== currentGeneration || props.sessionId !== sessionId) return;
                session.value = loaded;
                loadedSessionId = sessionId;
                const connection = configStore.providerConnections.find(
                    (item) => item.id === loaded.providerConnectionId,
                );
                if (connection) loaded.connectionRevision = connection.revision;
                options.value = all.filter(
                    (item) =>
                        connection &&
                        item.apiTypeId === connection.apiTypeId &&
                        item.apiTypeVersion === connection.apiTypeVersion,
                );
                binding.value =
                    loaded.contextTemplateLayer &&
                    loaded.contextTemplateId &&
                    loaded.contextTemplateVersion
                        ? (findOption(
                              loaded.contextTemplateLayer,
                              loaded.contextTemplateId,
                              loaded.contextTemplateVersion,
                          ) ?? {
                              layer: loaded.contextTemplateLayer,
                              templateId: loaded.contextTemplateId,
                              version: loaded.contextTemplateVersion,
                              name: loaded.contextTemplateId,
                              apiTypeId: connection?.apiTypeId ?? "",
                              apiTypeVersion: connection?.apiTypeVersion ?? 0,
                          })
                        : null;
            } catch (cause) {
                if (generation !== currentGeneration || props.sessionId !== sessionId) return;
                error.value = t("chat.contextTemplateUnavailable");
                logger.warn("Request template binding load failed", cause);
            } finally {
                if (generation === currentGeneration) loading.value = false;
            }
        })();
    },
    { immediate: true },
);
async function handleChange(selectedKey: string) {
    const option = options.value.find((item) => optionKey(item) === selectedKey);
    const sessionId = props.sessionId;
    const currentGeneration = generation;
    const revision = session.value?.connectionRevision;
    if (
        !option ||
        busy.value ||
        loading.value ||
        loadedSessionId !== sessionId ||
        revision === undefined
    )
        return;
    busy.value = true;
    error.value = null;
    try {
        const updated = await request<ApiSession>(
            "/sessions/" + encodeURIComponent(sessionId) + "/api-request-template",
            {
                method: "PATCH",
                body: JSON.stringify({
                    layer: option.layer,
                    templateId: option.templateId,
                    version: option.version,
                    connectionRevision: revision,
                }),
            },
        );
        if (generation !== currentGeneration || props.sessionId !== sessionId) return;
        binding.value = option;
        // PLAN-0626 M2-3 made the summary row a *second* instance of this resolver
        // (`summary-only`), so the pin must land in the shared Session projection —
        // otherwise the summary keeps rendering the pre-pin value and its risk badge
        // keeps claiming "模板未绑定" after a successful pin. The PATCH response *is* the
        // updated Session (OpenAPI: `updateSessionApiRequestTemplate` → `Session`), so
        // apply it instead of issuing another GET.
        sessionStore.applySessionRecord(updated);
        toast.success(
            t("chat.contextTemplateLabel") + ": " + templateLabel(option.name, option.version),
        );
    } catch (cause) {
        if (generation === currentGeneration && props.sessionId === sessionId)
            error.value = t("chat.contextTemplateUnavailable");
        logger.warn("Request template rebind failed", cause);
    } finally {
        if (generation === currentGeneration) busy.value = false;
    }
}
</script>

<template>
    <!-- `summary-only` = a data adapter for the chat summary row: resolve + emit only. -->
    <div v-if="!summaryOnly" class="min-w-0" data-testid="session-context-template">
        <Select
            :model-value="current ? optionKey(current) : ''"
            :disabled="loading || busy || options.length === 0"
            @update:model-value="(value) => handleChange(String(value ?? ''))"
        >
            <SelectTrigger
                :id="`session-context-template-${sessionId}`"
                data-testid="session-context-template-select"
                class="w-full min-w-0 truncate rounded-md border bg-background px-2 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
                :aria-label="t('chat.contextTemplateLabel')"
                :title="currentLabel ?? t('sessionSettings.templateUnbound')"
            >
                <!--
                    触发器自己渲染一行标签，而不是用 SelectValue 镜像选项内容：
                    选项现在多了一行「层 + API 类型」次级文本，镜像会把两行塞进 32px 的触发器里
                    （真栈实测触发器高度仍是 h-8，文字被压成两行）。
                -->
                <span class="truncate" data-testid="session-context-template-current-label">{{
                    currentLabel ?? t("sessionSettings.templateUnbound")
                }}</span>
            </SelectTrigger>
            <SelectContent>
                <SelectItem
                    v-if="
                        current && !findOption(current.layer, current.templateId, current.version)
                    "
                    :value="optionKey(current)"
                >
                    <span class="flex min-w-0 flex-col items-start leading-tight">
                        <span class="max-w-full truncate">{{
                            templateLabel(current.name, current.version)
                        }}</span>
                        <span
                            class="max-w-full truncate text-xs text-muted-foreground"
                            data-testid="session-context-template-option-meta"
                            >{{ optionMeta(current) }}</span
                        >
                    </span>
                </SelectItem>
                <SelectItem
                    v-for="option in options"
                    :key="optionKey(option)"
                    :value="optionKey(option)"
                >
                    <span class="flex min-w-0 flex-col items-start leading-tight">
                        <span class="max-w-full truncate">{{
                            templateLabel(option.name, option.version)
                        }}</span>
                        <span
                            class="max-w-full truncate text-xs text-muted-foreground"
                            data-testid="session-context-template-option-meta"
                            >{{ optionMeta(option) }}</span
                        >
                    </span>
                </SelectItem>
            </SelectContent>
        </Select>
        <p
            v-if="error"
            data-testid="session-context-template-error"
            class="mt-1 line-clamp-2 text-xs text-destructive"
            role="alert"
        >
            {{ error }}
        </p>
    </div>
</template>
