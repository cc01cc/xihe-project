<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { request, type ApiSession } from "../../../../composables/api";
import { logger } from "../../../../lib/logger";
import {
    listVisibleTemplates,
    templateKey as optionKey,
    type TemplateOption,
} from "../../../../services/apiRequestTemplates";
import { useConfigStore } from "../../../../stores/config";
import { useSessionStore } from "../../../../stores/session";
const props = defineProps<{ sessionId: string }>();
const emit = defineEmits<{
    "update:summary": [summary: { label: string | null; loading: boolean; failed: boolean }];
}>();
const { t } = useI18n();
const sessionStore = useSessionStore(),
    configStore = useConfigStore();
const options = ref<TemplateOption[]>([]),
    binding = ref<TemplateOption | null>(null);
const session = ref<ApiSession | null>(null),
    busy = ref(false),
    error = ref<string | null>(null);
const current = computed(() => binding.value);
const loading = ref(false);
const currentLabel = computed(() =>
    current.value ? `${current.value.name} v${current.value.version}` : null,
);
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
                    listVisibleTemplates(loaded.workspaceId),
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
async function handleChange(event: Event) {
    const option = options.value.find(
        (item) => optionKey(item) === (event.target as HTMLSelectElement).value,
    );
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
        await request("/sessions/" + encodeURIComponent(sessionId) + "/api-request-template", {
            method: "PATCH",
            body: JSON.stringify({
                layer: option.layer,
                templateId: option.templateId,
                version: option.version,
                connectionRevision: revision,
            }),
        });
        if (generation !== currentGeneration || props.sessionId !== sessionId) return;
        binding.value = option;
        toast.success(t("chat.contextTemplateLabel") + ": " + option.name + " v" + option.version);
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
    <div class="min-w-0" data-testid="session-context-template">
        <select
            :id="`session-context-template-${sessionId}`"
            data-testid="session-context-template-select"
            class="w-full min-w-40 max-w-44 truncate rounded-md border bg-background px-2 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
            :value="current ? optionKey(current) : ''"
            :disabled="loading || busy || options.length === 0"
            :aria-label="t('chat.contextTemplateLabel')"
            :title="currentLabel ?? t('sessionSettings.templateUnbound')"
            @change="handleChange"
        >
            <option v-if="!current" value="" disabled>
                {{ t("sessionSettings.templateSelectPlaceholder") }}
            </option>
            <option
                v-if="current && !findOption(current.layer, current.templateId, current.version)"
                :value="optionKey(current)"
            >
                {{ current.name }} v{{ current.version }}
            </option>
            <option v-for="option in options" :key="optionKey(option)" :value="optionKey(option)">
                {{ option.name }} v{{ option.version }}
            </option>
        </select>
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
