<script setup lang="ts">
import { computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ArchiveRestore, CircleAlert, Clock, RotateCcw } from "@lucide/vue";
import { useAuthStore } from "../../stores/auth";
import { useCheckpointStore } from "../../stores/checkpoint";
import type { WorkspaceCheckpointRevertCounts } from "../../types";

/**
 * PLAN-0339: workspace slice marker rendered beside a message. The marker is a compact
 * conversation entry; the full history lives in the workspace changes panel.
 */
const props = defineProps<{
    runId: string;
    sessionId?: string;
}>();

const emit = defineEmits<{
    revert: [sliceRef: string];
}>();

const { t } = useI18n();
const authStore = useAuthStore();
const checkpointStore = useCheckpointStore();

const record = computed(() => {
    const workspaceId = authStore.currentWorkspaceId;
    const current = workspaceId ? checkpointStore.getForRun(workspaceId, props.runId) : undefined;
    return current ?? checkpointStore.getEvent(props.runId);
});
const waitingForDurableRecord = computed(
    () => !record.value?.sliceRef && checkpointStore.getEvent(props.runId)?.state === "captured",
);

type MarkerKind = "captured" | "abnormal-captured" | "degraded" | "expired" | "none";

const kind = computed<MarkerKind>(() => {
    const current = record.value;
    if (!current) return "none";
    return current.state;
});

/** Frozen reason vocabulary of degraded rows / extended reasons, falling back to the raw code. */
const unrollableLabel = computed(() => {
    const current = record.value;
    if (!current) return "";
    const reason = current.unrollableReason;
    const keys: Record<string, string> = {
        UNAVAILABLE: "chat.checkpointReasonUnavailable",
        GIT_UNAVAILABLE: "chat.checkpointReasonGitUnavailable",
        GIT_TOO_OLD: "chat.checkpointReasonGitTooOld",
        GIT_FAILED: "chat.checkpointReasonGitFailed",
        WORKSPACE_UNKNOWN: "chat.checkpointReasonWorkspaceUnknown",
        EXPIRED: "chat.checkpointReasonExpired",
    };
    if (current.state === "expired") return t("chat.checkpointReasonExpired");
    const key = reason ? keys[reason] : undefined;
    return key ? t(key) : (reason ?? t("chat.checkpointReasonUnavailable"));
});

const revertedAt = computed(() => {
    const at = record.value?.revert?.at;
    if (!at) return "";
    const parsed = new Date(at);
    return Number.isNaN(parsed.getTime()) ? "" : parsed.toLocaleString();
});

const revertSummary = computed(() => {
    const counts = record.value?.revert?.counts;
    if (!counts) return [] as string[];
    const labels: Array<{ key: keyof WorkspaceCheckpointRevertCounts; labelKey: string }> = [
        { key: "restored", labelKey: "chat.checkpointCountRestored" },
        { key: "deleted", labelKey: "chat.checkpointCountDeleted" },
        { key: "failed", labelKey: "chat.checkpointCountFailed" },
    ];
    const parts: string[] = [];
    for (const { key, labelKey } of labels) {
        const value = counts[key];
        if (value !== undefined) parts.push(`${t(labelKey)} ${value}`);
    }
    return parts;
});

const isPartialRevert = computed(() => {
    const revert = record.value?.revert;
    if (!revert) return false;
    return (
        revert.state === "partial" || revert.state === "failed" || (revert.counts?.failed ?? 0) > 0
    );
});

const changedFilesTitle = computed(() => {
    const files =
        record.value && "changedFiles" in record.value
            ? (record.value as { changedFiles: Array<{ status: string; path: string }> })
                  .changedFiles
            : [];
    return files.map((file) => `${file.status} ${file.path}`.trim()).join("\n");
});

function loadCheckpoint() {
    const workspaceId = authStore.currentWorkspaceId;
    if (workspaceId) void checkpointStore.fetchWorkspaceCheckpoints(workspaceId, { force: true });
}

watch(
    [
        () => props.runId,
        () => authStore.currentWorkspaceId,
        () => checkpointStore.getEvent(props.runId)?.state,
    ],
    loadCheckpoint,
    { immediate: true },
);
</script>

<template>
    <div
        v-if="record"
        data-testid="run-checkpoint-marker"
        :data-checkpoint-kind="kind"
        class="mt-1.5 flex flex-wrap items-center gap-2 text-xs"
    >
        <template
            v-if="
                (kind === 'captured' || kind === 'abnormal-captured') &&
                record.sliceRef &&
                (!record.revert || record.revert.state === 'none')
            "
        >
            <span
                data-testid="run-checkpoint-summary"
                class="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-muted-foreground"
                :title="changedFilesTitle || undefined"
            >
                <RotateCcw class="size-3.5 shrink-0" aria-hidden="true" />
                {{ t("chat.checkpointMarkerChangedPrefix") }} {{ record.changedCount }}
                {{ t("chat.checkpointMarkerChangedUnit") }} ·
                {{ t("chat.checkpointMarkerRollbackable") }}
            </span>
            <span
                data-testid="run-checkpoint-slice-ref"
                class="max-w-48 truncate font-mono text-[10px] text-muted-foreground"
                :title="record.sliceRef"
                >{{ record.sliceRef }}</span
            >
            <time
                v-if="record.capturedAt"
                data-testid="run-checkpoint-captured-at"
                class="text-[10px] text-muted-foreground"
                :datetime="record.capturedAt"
                >{{ new Date(record.capturedAt).toLocaleString() }}</time
            >
            <button
                type="button"
                data-testid="run-checkpoint-revert-entry"
                class="inline-flex min-h-7 items-center rounded-md border px-2 py-1 font-medium transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
                @click="emit('revert', record.sliceRef)"
            >
                {{ t("chat.checkpointMarkerRevertEntry") }}
            </button>
            <details
                v-if="'changedFiles' in record && record.changedFiles.length > 0"
                data-testid="run-checkpoint-details"
                class="basis-full rounded border bg-muted/10 px-2 py-1 text-[11px]"
            >
                <summary class="cursor-pointer text-muted-foreground">
                    {{ t("chat.checkpointPreviewPathsTitle") }}
                </summary>
                <ul class="mt-1 space-y-0.5">
                    <li
                        v-for="entry in record.changedFiles"
                        :key="`${entry.status}:${entry.path}`"
                        class="break-all font-mono"
                    >
                        {{ entry.status }} {{ entry.path }}
                    </li>
                </ul>
            </details>
        </template>

        <template
            v-else-if="
                (kind === 'captured' || kind === 'abnormal-captured') &&
                record.revert &&
                record.revert.state !== 'none'
            "
        >
            <span
                data-testid="run-checkpoint-reverted"
                class="inline-flex flex-wrap items-center gap-1.5 rounded-md border px-2 py-1"
                :class="
                    isPartialRevert
                        ? 'border-amber-500/40 bg-amber-500/10 text-foreground'
                        : 'bg-muted/40 text-muted-foreground'
                "
            >
                <ArchiveRestore class="size-3.5 shrink-0" aria-hidden="true" />
                {{ t("chat.checkpointMarkerReverted") }}
                <template v-if="revertedAt">· {{ revertedAt }}</template>
                <span
                    v-for="part in revertSummary"
                    :key="part"
                    data-testid="run-checkpoint-revert-summary"
                    class="text-muted-foreground"
                    >· {{ part }}</span
                >
            </span>
        </template>

        <template v-else-if="kind === 'degraded' || kind === 'expired'">
            <span
                data-testid="run-checkpoint-unavailable"
                class="inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-foreground"
            >
                <CircleAlert class="size-3.5 shrink-0" aria-hidden="true" />
                {{
                    kind === "expired"
                        ? t("chat.checkpointReasonExpired")
                        : t("chat.checkpointMarkerUnrollable")
                }}
                <span class="text-muted-foreground">（{{ unrollableLabel }}）</span>
            </span>
        </template>

        <template v-else>
            <span
                data-testid="run-checkpoint-none"
                class="inline-flex items-center gap-1.5 rounded-md border bg-muted/20 px-2 py-1 text-muted-foreground"
            >
                <Clock class="size-3.5 shrink-0" aria-hidden="true" />
                {{
                    waitingForDurableRecord
                        ? t("chat.checkpointPreviewLoading")
                        : t("chat.checkpointMarkerNoSnapshot")
                }}
            </span>
        </template>
    </div>
</template>
