<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronDown, ChevronUp, LoaderCircle } from "@lucide/vue";
import { ApiError, api } from "../../composables/api";
import { logger } from "../../lib/logger";
import type { CheckpointPreview, CheckpointPreviewEntry } from "../../types";
import CheckpointDialogShell from "./CheckpointDialogShell.vue";

/**
 * PLAN-0339: required dry-run preview of a workspace slice restore. Type changes are the only
 * explicit acknowledgement gate; the preview never fabricates a conflict or fingerprint state.
 */
const props = withDefaults(
    defineProps<{
        show: boolean;
        workspaceId: string;
        sliceRef: string;
        busy?: boolean;
        error?: string | null;
    }>(),
    {
        busy: false,
        error: null,
    },
);

const emit = defineEmits<{
    confirm: [acknowledgeTypeChanges: string[]];
    close: [];
}>();

const { t } = useI18n();

const loading = ref(false);
const loadError = ref<string | null>(null);
const preview = ref<CheckpointPreview | null>(null);
const typeConflictAck = ref(false);
const expanded = ref(false);
const cancelButton = ref<HTMLButtonElement | null>(null);
const retryButton = ref<HTMLButtonElement | null>(null);
let loadGeneration = 0;

const counts = computed(() => preview.value?.counts ?? null);
const entries = computed(() => preview.value?.entries ?? []);
const visibleEntries = computed(() =>
    expanded.value ? entries.value : entries.value.slice(0, 20),
);
const hiddenEntryCount = computed(() => Math.max(0, entries.value.length - 20));
const typeConflictPaths = computed(() =>
    entries.value.filter((entry) => entry.state === "type_conflict").map((entry) => entry.path),
);
const typeConflictRequired = computed(() => (counts.value?.typeConflict ?? 0) > 0);
const typeConflictIncomplete = computed(
    () =>
        typeConflictRequired.value &&
        typeConflictPaths.value.length < (counts.value?.typeConflict ?? 0),
);

const canSubmit = computed(
    () =>
        Boolean(preview.value) &&
        !loading.value &&
        !loadError.value &&
        !typeConflictIncomplete.value &&
        (!typeConflictRequired.value || typeConflictAck.value) &&
        !props.busy,
);

function entryActionLabel(entry: CheckpointPreviewEntry): string {
    if (entry.action === "restore") return t("chat.checkpointEntryRestore");
    return t("chat.checkpointEntryDelete");
}

function entryStateLabel(entry: CheckpointPreviewEntry): string {
    if (entry.state === "noop") return t("chat.checkpointEntryNoop");
    if (entry.state === "type_conflict") return t("chat.checkpointEntryTypeConflict");
    return "";
}

function focusCancel() {
    void nextTick(() => cancelButton.value?.focus());
}

async function loadPreview() {
    const workspaceId = props.workspaceId;
    const sliceRef = props.sliceRef;
    if (!workspaceId || !sliceRef) return;
    const generation = ++loadGeneration;
    loading.value = true;
    loadError.value = null;
    preview.value = null;
    typeConflictAck.value = false;
    expanded.value = false;
    try {
        const result = await api.previewWorkspaceCheckpointRevert(workspaceId, sliceRef);
        if (
            generation !== loadGeneration ||
            props.workspaceId !== workspaceId ||
            props.sliceRef !== sliceRef
        )
            return;
        preview.value = result;
    } catch (cause) {
        if (
            generation !== loadGeneration ||
            props.workspaceId !== workspaceId ||
            props.sliceRef !== sliceRef
        )
            return;
        loadError.value =
            cause instanceof ApiError
                ? `${cause.problem.code}: ${cause.problem.detail ?? cause.message}`
                : t("chat.checkpointPreviewFailed");
        logger.warn("Failed to load workspace slice restore preview", cause);
    } finally {
        if (generation === loadGeneration) {
            loading.value = false;
            // The preview replaces the loading state: (re)anchor the conservative default.
            if (loadError.value) {
                void nextTick(() => retryButton.value?.focus());
            } else {
                focusCancel();
            }
        }
    }
}

watch(
    () => [props.show, props.workspaceId, props.sliceRef] as const,
    ([show]) => {
        if (show) {
            void loadPreview();
        } else {
            loadGeneration += 1;
        }
    },
    { immediate: true },
);

function handleShowChange(value: boolean) {
    if (!value) handleClose();
}

function handleClose() {
    if (props.busy) return;
    emit("close");
}

function submit() {
    if (!preview.value || !canSubmit.value) return;
    emit("confirm", typeConflictRequired.value ? typeConflictPaths.value : []);
}
</script>

<template>
    <CheckpointDialogShell
        :show="show"
        :title="t('chat.checkpointPreviewTitle')"
        :description="t('chat.checkpointPreviewDescription')"
        @update:show="handleShowChange"
        @initial-focus="focusCancel"
    >
        <div class="space-y-4">
            <p
                v-if="loading"
                data-testid="revert-preview-loading"
                class="flex items-center gap-2 text-sm text-muted-foreground"
            >
                <LoaderCircle class="size-4 animate-spin" aria-hidden="true" />
                {{ t("chat.checkpointPreviewLoading") }}
            </p>

            <div v-else-if="loadError" data-testid="revert-preview-error" class="space-y-3">
                <p class="text-sm text-destructive" role="alert">{{ loadError }}</p>
                <button
                    type="button"
                    ref="retryButton"
                    data-testid="revert-preview-retry"
                    class="inline-flex min-h-8 items-center rounded-lg border px-3 py-1.5 text-sm font-medium transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    @click="loadPreview"
                >
                    {{ t("chat.checkpointPreviewRetry") }}
                </button>
            </div>

            <template v-else-if="preview">
                <div
                    v-if="counts"
                    data-testid="revert-preview-counts"
                    class="grid grid-cols-3 gap-2"
                >
                    <div class="rounded-lg border bg-muted/20 p-2 text-center">
                        <div class="text-xs text-muted-foreground">
                            {{ t("chat.checkpointPreviewRestore") }}
                        </div>
                        <div
                            data-testid="revert-preview-restore-count"
                            class="text-lg font-semibold"
                        >
                            {{ counts.restore }}
                        </div>
                    </div>
                    <div class="rounded-lg border bg-muted/20 p-2 text-center">
                        <div class="text-xs text-muted-foreground">
                            {{ t("chat.checkpointPreviewDelete") }}
                        </div>
                        <div
                            data-testid="revert-preview-delete-count"
                            class="text-lg font-semibold"
                        >
                            {{ counts.delete }}
                        </div>
                    </div>
                    <div class="rounded-lg border bg-muted/20 p-2 text-center">
                        <div class="text-xs text-muted-foreground">
                            {{ t("chat.checkpointPreviewTypeConflict") }}
                        </div>
                        <div
                            data-testid="revert-preview-type-conflict-count"
                            class="text-lg font-semibold"
                        >
                            {{ counts.typeConflict }}
                        </div>
                    </div>
                </div>

                <div data-testid="revert-preview-paths">
                    <p
                        class="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground"
                    >
                        {{ t("chat.checkpointPreviewPathsTitle") }}
                    </p>
                    <ul
                        v-if="visibleEntries.length > 0"
                        class="max-h-48 space-y-1 overflow-y-auto rounded-lg border bg-muted/10 p-2 text-xs"
                    >
                        <li
                            v-for="entry in visibleEntries"
                            :key="`${entry.action}:${entry.path}`"
                            class="flex flex-wrap items-baseline gap-1.5"
                        >
                            <span
                                class="rounded border px-1 py-0.5 text-[10px] text-muted-foreground"
                                >{{ entryActionLabel(entry) }}</span
                            >
                            <span class="break-all font-mono">{{ entry.path }}</span>
                            <span
                                v-if="entry.state !== 'execute'"
                                data-testid="revert-preview-entry-state"
                                class="rounded border border-amber-500/40 bg-amber-500/10 px-1 py-0.5 text-[10px]"
                            >
                                {{ entryStateLabel(entry)
                                }}<template v-if="entry.reason">: {{ entry.reason }}</template>
                            </span>
                        </li>
                    </ul>
                    <p
                        v-else
                        data-testid="revert-preview-no-entries"
                        class="text-sm text-muted-foreground"
                    >
                        {{ t("chat.checkpointPreviewNoEntries") }}
                    </p>
                    <button
                        v-if="hiddenEntryCount > 0"
                        type="button"
                        data-testid="revert-preview-expand"
                        class="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                        @click="expanded = !expanded"
                    >
                        <component
                            :is="expanded ? ChevronUp : ChevronDown"
                            class="size-3.5"
                            aria-hidden="true"
                        />
                        {{
                            expanded
                                ? t("chat.checkpointPreviewCollapse")
                                : t("chat.checkpointPreviewExpand")
                        }}
                    </button>
                    <p
                        v-if="preview.truncated"
                        data-testid="revert-preview-truncated"
                        class="mt-1 text-xs text-muted-foreground"
                    >
                        {{ t("chat.checkpointPreviewTruncated") }}
                    </p>
                </div>

                <div class="space-y-2">
                    <label v-if="typeConflictRequired" class="flex items-start gap-2 text-sm">
                        <input
                            v-model="typeConflictAck"
                            data-testid="revert-preview-type-conflict-ack"
                            type="checkbox"
                            class="mt-0.5 size-4 rounded border"
                        />
                        <span>{{ t("chat.checkpointTypeConflictAck") }}</span>
                    </label>
                    <p
                        v-if="typeConflictIncomplete"
                        data-testid="revert-preview-type-conflict-incomplete"
                        class="text-xs text-destructive"
                        role="alert"
                    >
                        {{ t("chat.checkpointPreviewTypeConflictIncomplete") }}
                    </p>
                </div>

                <p
                    v-if="error"
                    data-testid="revert-preview-submit-error"
                    class="text-sm text-destructive"
                    role="alert"
                >
                    {{ error }}
                </p>

                <div class="flex flex-wrap justify-end gap-2 border-t pt-3">
                    <button
                        ref="cancelButton"
                        type="button"
                        data-testid="revert-preview-cancel"
                        class="inline-flex min-h-9 items-center justify-center rounded-lg border px-3 py-2 text-sm font-medium transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                        :disabled="busy"
                        @click="handleClose"
                    >
                        {{ t("common.cancel") }}
                    </button>
                    <button
                        type="button"
                        data-testid="revert-preview-confirm"
                        class="inline-flex min-h-9 items-center justify-center rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive transition hover:bg-destructive/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                        :disabled="!canSubmit"
                        @click="submit"
                    >
                        <LoaderCircle
                            v-if="busy"
                            class="mr-1.5 size-4 animate-spin"
                            aria-hidden="true"
                        />
                        {{ t("chat.checkpointPreviewConfirm") }}
                    </button>
                </div>
            </template>
        </div>
    </CheckpointDialogShell>
</template>
