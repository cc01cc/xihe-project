<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { FileDiff, LoaderCircle, X } from "@lucide/vue";
import { ApiError, api } from "../../composables/api";
import { logger } from "../../lib/logger";
import { computeLineDiff, type LineDiffRow } from "../../lib/lineDiff";
import type { CheckpointResult, CheckpointResultEntry } from "../../types";
import CheckpointDialogShell from "./CheckpointDialogShell.vue";

/**
 * PLAN-0339: workspace slice restore result. Outcomes stay limited to restored/deleted/failed/
 * suspect; the diff compares the target slice blob with current workspace content.
 */
const props = defineProps<{
    show: boolean;
    workspaceId: string;
    result: CheckpointResult | null;
}>();

const emit = defineEmits<{
    retry: [sliceRef: string];
    close: [];
}>();

const { t } = useI18n();

const groupOrder: Array<{ key: CheckpointResultEntry["outcome"]; labelKey: string; tone: string }> =
    [
        {
            key: "restored",
            labelKey: "chat.checkpointResultRestored",
            tone: "text-emerald-600 dark:text-emerald-400",
        },
        { key: "deleted", labelKey: "chat.checkpointResultDeleted", tone: "text-muted-foreground" },
        { key: "failed", labelKey: "chat.checkpointResultFailed", tone: "text-destructive" },
        {
            key: "suspect",
            labelKey: "chat.checkpointResultSuspect",
            tone: "text-amber-600 dark:text-amber-400",
        },
    ];

const groups = computed(() => {
    const entries = props.result?.entries ?? [];
    return groupOrder
        .map((group) => ({
            ...group,
            entries: entries.filter((entry) => entry.outcome === group.key),
        }))
        .filter((group) => group.entries.length > 0);
});

const counts = computed(() => props.result?.counts ?? null);
const unfinishedCount = computed(() => {
    if (counts.value) return counts.value.failed;
    return (props.result?.entries ?? []).filter((entry) => entry.outcome === "failed").length;
});
const canRetry = computed(() => unfinishedCount.value > 0);
const partialNote = computed(() => unfinishedCount.value > 0);

const durationText = computed(() => {
    const duration = props.result?.durationMs;
    if (duration === undefined || duration <= 0) return "";
    return duration >= 1000 ? `${(duration / 1000).toFixed(1)}s` : `${duration}ms`;
});

function canInspect(entry: CheckpointResultEntry): boolean {
    return entry.outcome === "suspect" || entry.outcome === "failed";
}

const diffEntry = ref<CheckpointResultEntry | null>(null);
const diffLoading = ref(false);
const diffError = ref<string | null>(null);
const diffRows = ref<LineDiffRow[]>([]);
const diffTruncated = ref(false);
const diffRef = ref<"slice" | null>(null);
let diffGeneration = 0;

async function openDiff(entry: CheckpointResultEntry) {
    const result = props.result;
    if (!result) return;
    const generation = ++diffGeneration;
    diffEntry.value = entry;
    diffLoading.value = true;
    diffError.value = null;
    diffRows.value = [];
    diffTruncated.value = false;
    diffRef.value = null;
    try {
        const sliceText = await api.getWorkspaceCheckpointBlob(
            props.workspaceId,
            result.sliceRef,
            entry.path,
        );
        const current = await api.readFile(entry.path, props.workspaceId);
        if (generation !== diffGeneration) return;
        const diff = computeLineDiff(sliceText, current.content);
        diffRows.value = diff.rows;
        diffTruncated.value = diff.truncated;
        diffRef.value = "slice";
    } catch (cause) {
        if (generation !== diffGeneration) return;
        diffError.value =
            cause instanceof ApiError
                ? `${cause.problem.code}: ${cause.problem.detail ?? cause.message}`
                : t("chat.checkpointResultDiffFailed");
        logger.warn("Failed to load checkpoint slice diff", cause);
    } finally {
        if (generation === diffGeneration) diffLoading.value = false;
    }
}

function closeDiff() {
    diffGeneration += 1;
    diffEntry.value = null;
}

function handleClose() {
    closeDiff();
    emit("close");
}

function retry() {
    const sliceRef = props.result?.sliceRef;
    if (!sliceRef) return;
    closeDiff();
    emit("retry", sliceRef);
}

watch(
    () => props.show,
    (show) => {
        if (!show) closeDiff();
    },
);
</script>

<template>
    <CheckpointDialogShell
        :show="show"
        :title="t('chat.checkpointResultTitle')"
        :description="t('chat.checkpointResultDescription')"
        @update:show="!$event && handleClose()"
    >
        <div v-if="result" class="space-y-4">
            <div v-if="counts" data-testid="revert-result-counts" class="grid grid-cols-3 gap-2">
                <div class="rounded-lg border bg-muted/20 p-2 text-center">
                    <div class="text-xs text-muted-foreground">
                        {{ t("chat.checkpointResultRestored") }}
                    </div>
                    <div class="text-lg font-semibold">{{ counts.restored }}</div>
                </div>
                <div class="rounded-lg border bg-muted/20 p-2 text-center">
                    <div class="text-xs text-muted-foreground">
                        {{ t("chat.checkpointResultDeleted") }}
                    </div>
                    <div class="text-lg font-semibold">{{ counts.deleted }}</div>
                </div>
                <div class="rounded-lg border bg-muted/20 p-2 text-center">
                    <div class="text-xs text-muted-foreground">
                        {{ t("chat.checkpointResultFailed") }}
                    </div>
                    <div class="text-lg font-semibold">{{ counts.failed }}</div>
                </div>
            </div>

            <p
                v-if="partialNote"
                data-testid="revert-result-partial"
                class="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
            >
                {{ t("chat.checkpointResultPartial") }}
            </p>

            <div
                v-for="group in groups"
                :key="group.key"
                :data-testid="`revert-result-group-${group.key}`"
                class="space-y-1"
            >
                <h3 class="text-sm font-semibold" :class="group.tone">{{ t(group.labelKey) }}</h3>
                <ul
                    class="max-h-40 space-y-1 overflow-y-auto rounded-lg border bg-muted/10 p-2 text-xs"
                >
                    <li
                        v-for="entry in group.entries"
                        :key="`${group.key}:${entry.path}`"
                        :data-testid="`revert-result-entry-${group.key}`"
                        class="flex flex-wrap items-baseline justify-between gap-2"
                    >
                        <span class="min-w-0 break-all font-mono">{{ entry.path }}</span>
                        <span class="flex shrink-0 items-center gap-2">
                            <span v-if="entry.reason" class="text-muted-foreground">{{
                                entry.reason
                            }}</span>
                            <button
                                v-if="canInspect(entry)"
                                type="button"
                                :data-testid="`revert-result-diff-${entry.path}`"
                                class="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                @click="openDiff(entry)"
                            >
                                <FileDiff class="size-3" aria-hidden="true" />
                                {{ t("chat.checkpointResultViewDiff") }}
                            </button>
                        </span>
                    </li>
                </ul>
            </div>

            <div
                v-if="diffEntry"
                data-testid="revert-result-diff-panel"
                class="rounded-lg border bg-muted/10"
            >
                <div class="flex items-center justify-between gap-2 border-b px-3 py-2 text-xs">
                    <span class="min-w-0 break-all font-mono">
                        {{ diffEntry.path }}
                        <span v-if="diffRef" class="text-muted-foreground"
                            >· {{ t("chat.checkpointResultDiffSlice") }}</span
                        >
                    </span>
                    <button
                        type="button"
                        data-testid="revert-result-diff-close"
                        class="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        :aria-label="t('common.close')"
                        @click="closeDiff"
                    >
                        <X class="size-3.5" aria-hidden="true" />
                    </button>
                </div>
                <div class="p-2">
                    <p
                        v-if="diffLoading"
                        data-testid="revert-result-diff-loading"
                        class="flex items-center gap-2 text-xs text-muted-foreground"
                    >
                        <LoaderCircle class="size-3.5 animate-spin" aria-hidden="true" />
                        {{ t("chat.checkpointResultDiffLoading") }}
                    </p>
                    <p
                        v-else-if="diffError"
                        data-testid="revert-result-diff-error"
                        class="text-xs text-destructive"
                        role="alert"
                    >
                        {{ diffError }}
                    </p>
                    <div
                        v-else
                        data-testid="revert-result-diff-rows"
                        class="max-h-56 overflow-auto rounded border bg-background font-mono text-xs"
                    >
                        <div
                            v-for="(row, index) in diffRows"
                            :key="index"
                            class="whitespace-pre px-2"
                            :class="
                                row.type === 'add'
                                    ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                                    : row.type === 'remove'
                                      ? 'bg-red-500/10 text-red-700 dark:text-red-300'
                                      : 'text-muted-foreground'
                            "
                        >
                            {{ row.type === "add" ? "+" : row.type === "remove" ? "-" : " " }}
                            {{ row.text }}
                        </div>
                    </div>
                    <p
                        v-if="diffTruncated"
                        data-testid="revert-result-diff-truncated"
                        class="mt-1 text-[10px] text-muted-foreground"
                    >
                        {{ t("chat.checkpointResultDiffTruncated") }}
                    </p>
                </div>
            </div>

            <p data-testid="revert-result-ref" class="break-all text-[10px] text-muted-foreground">
                {{ t("chat.checkpointResultSliceRef") }}:
                <span class="font-mono">{{ result.sliceRef }}</span>
            </p>
            <ul
                v-if="result.suspects.length > 0"
                data-testid="revert-result-suspects"
                class="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs"
            >
                <li v-for="suspect in result.suspects" :key="suspect" class="break-all font-mono">
                    {{ suspect }}
                </li>
            </ul>
            <p
                v-if="durationText"
                data-testid="revert-result-duration"
                class="text-[10px] text-muted-foreground"
            >
                {{ t("chat.checkpointResultDuration") }}: {{ durationText }}
            </p>

            <div class="flex flex-wrap justify-end gap-2 border-t pt-3">
                <button
                    type="button"
                    data-testid="revert-result-dismiss"
                    class="inline-flex min-h-9 items-center justify-center rounded-lg border px-3 py-2 text-sm font-medium transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    @click="handleClose"
                >
                    {{ t("chat.checkpointResultDismiss") }}
                </button>
                <button
                    v-if="canRetry"
                    type="button"
                    data-testid="revert-result-retry"
                    class="inline-flex min-h-9 items-center justify-center rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive transition hover:bg-destructive/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    @click="retry"
                >
                    {{ t("chat.checkpointResultRetry") }} ({{ unfinishedCount }})
                </button>
            </div>
        </div>
    </CheckpointDialogShell>
</template>
