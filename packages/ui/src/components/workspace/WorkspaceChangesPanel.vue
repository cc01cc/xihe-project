<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { CircleAlert, FileDiff, LoaderCircle, RefreshCw, X } from "@lucide/vue";
import { ApiError, api } from "../../composables/api";
import { logger } from "../../lib/logger";
import { useCheckpointStore } from "../../stores/checkpoint";
import type { CheckpointResult, WorkspaceGitStatus } from "../../types";
import RevertPreviewDialog from "../chat/RevertPreviewDialog.vue";
import RevertResultDialog from "../chat/RevertResultDialog.vue";

/**
 * PLAN-0339: the workspace timeline is the source of truth for captured slices. The pending
 * repository view remains a separate tab; the two lists are never merged.
 */
const props = withDefaults(
    defineProps<{
        sessionId?: string | null;
        workspaceId: string;
    }>(),
    {
        sessionId: null,
    },
);

const emit = defineEmits<{
    close: [];
}>();

const { t } = useI18n();
const checkpointStore = useCheckpointStore();

type DiffTab = "timeline" | "pending";
const activeTab = ref<DiffTab>("timeline");
const timelineLoading = ref(false);
const timelineError = ref<string | null>(null);
const selectedCheckpointId = ref<string | null>(null);
const timeline = computed(() => checkpointStore.getForWorkspace(props.workspaceId));
let timelineGeneration = 0;

async function loadTimeline(force = false) {
    const workspaceId = props.workspaceId;
    if (!workspaceId) return;
    const generation = ++timelineGeneration;
    timelineLoading.value = true;
    timelineError.value = null;
    try {
        await checkpointStore.fetchWorkspaceCheckpoints(workspaceId, { force });
        if (generation !== timelineGeneration || props.workspaceId !== workspaceId) return;
        timelineError.value = checkpointStore.workspaceErrors[workspaceId] ?? null;
        if (
            selectedCheckpointId.value &&
            !timeline.value.some((item) => item.id === selectedCheckpointId.value)
        ) {
            selectedCheckpointId.value = null;
        }
    } catch (cause) {
        if (generation !== timelineGeneration || props.workspaceId !== workspaceId) return;
        timelineError.value =
            cause instanceof ApiError
                ? `${cause.problem.code}: ${cause.problem.detail ?? cause.message}`
                : "Failed to load workspace checkpoint timeline";
        logger.warn("Failed to load workspace checkpoint timeline", cause);
    } finally {
        if (generation === timelineGeneration) timelineLoading.value = false;
    }
}

function selectCheckpoint(id: string) {
    selectedCheckpointId.value = selectedCheckpointId.value === id ? null : id;
}

const restorePreviewSliceRef = ref<string | null>(null);
const restoreBusy = ref(false);
const restoreError = ref<string | null>(null);
const restoreResult = ref<CheckpointResult | null>(null);

function openRestore(sliceRef: string) {
    restoreResult.value = null;
    restoreError.value = null;
    restorePreviewSliceRef.value = sliceRef;
}

function closeRestorePreview() {
    if (restoreBusy.value) return;
    restorePreviewSliceRef.value = null;
    restoreError.value = null;
}

async function confirmRestore(acknowledgeTypeChanges: string[]) {
    const sliceRef = restorePreviewSliceRef.value;
    const workspaceId = props.workspaceId;
    if (!sliceRef || !workspaceId || restoreBusy.value) return;
    restoreBusy.value = true;
    restoreError.value = null;
    try {
        const result = await api.executeWorkspaceCheckpointRevert(
            workspaceId,
            sliceRef,
            acknowledgeTypeChanges,
        );
        if (props.workspaceId !== workspaceId) return;
        void checkpointStore.fetchWorkspaceCheckpoints(workspaceId, { force: true });
        restorePreviewSliceRef.value = null;
        restoreResult.value = result;
        if (result.counts.failed > 0) toast.warning(t("chat.checkpointRevertPartial"));
        else toast.success(t("chat.checkpointRevertDone"));
    } catch (cause) {
        if (props.workspaceId !== workspaceId) return;
        restoreError.value =
            cause instanceof ApiError
                ? `${cause.problem.code}: ${cause.problem.detail ?? cause.message}`
                : t("chat.checkpointRevertFailed");
        logger.warn("Failed to execute workspace checkpoint restore", cause);
    } finally {
        restoreBusy.value = false;
    }
}

function retryRestore(sliceRef: string) {
    restoreResult.value = null;
    restoreError.value = null;
    restorePreviewSliceRef.value = sliceRef;
}

function closeRestoreResult() {
    restoreResult.value = null;
}

onMounted(() => {
    void loadTimeline();
});
watch(
    () => props.workspaceId,
    () => {
        timelineGeneration += 1;
        selectedCheckpointId.value = null;
        void loadTimeline(true);
    },
);

const pendingStatus = ref<WorkspaceGitStatus | null>(null);
const pendingLoading = ref(false);
const pendingError = ref<string | null>(null);
let pendingGeneration = 0;

async function loadGitStatus() {
    const workspaceId = props.workspaceId;
    if (!workspaceId) return;
    const generation = ++pendingGeneration;
    pendingLoading.value = true;
    pendingError.value = null;
    try {
        const status = await api.getWorkspaceGitStatus(workspaceId);
        if (generation !== pendingGeneration || props.workspaceId !== workspaceId) return;
        pendingStatus.value = status;
    } catch (cause) {
        if (generation !== pendingGeneration || props.workspaceId !== workspaceId) return;
        pendingError.value =
            cause instanceof ApiError
                ? `${cause.problem.code}: ${cause.problem.detail ?? cause.message}`
                : t("workspace.diffPendingLoadFailed");
        logger.warn("Failed to load workspace git status", cause);
    } finally {
        if (generation === pendingGeneration) pendingLoading.value = false;
    }
}

onMounted(loadGitStatus);
watch(
    () => props.workspaceId,
    () => {
        pendingGeneration += 1;
        pendingStatus.value = null;
        void loadGitStatus();
    },
);
</script>

<template>
    <div class="flex h-full min-h-0 flex-col" data-testid="workspace-changes-panel">
        <div class="flex h-9 shrink-0 items-center gap-1 border-b px-2" role="tablist">
            <button
                type="button"
                role="tab"
                data-testid="workspace-diff-tab-timeline"
                :aria-selected="activeTab === 'timeline'"
                class="rounded px-2 py-1 text-xs font-medium transition-colors"
                :class="
                    activeTab === 'timeline'
                        ? 'bg-accent text-foreground'
                        : 'text-muted-foreground hover:bg-accent/60'
                "
                @click="activeTab = 'timeline'"
            >
                {{ t("workspace.diffTabTimeline") }}
            </button>
            <button
                type="button"
                role="tab"
                data-testid="workspace-diff-tab-pending"
                :aria-selected="activeTab === 'pending'"
                class="rounded px-2 py-1 text-xs font-medium transition-colors"
                :class="
                    activeTab === 'pending'
                        ? 'bg-accent text-foreground'
                        : 'text-muted-foreground hover:bg-accent/60'
                "
                @click="activeTab = 'pending'"
            >
                {{ t("workspace.diffTabPending") }}
            </button>
            <span class="flex-1" />
            <button
                v-if="activeTab === 'pending'"
                type="button"
                data-testid="workspace-diff-refresh"
                class="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                :title="t('workspace.diffRefresh')"
                :aria-label="t('workspace.diffRefresh')"
                :disabled="pendingLoading"
                @click="loadGitStatus"
            >
                <RefreshCw
                    class="size-3.5"
                    :class="pendingLoading ? 'animate-spin' : ''"
                    aria-hidden="true"
                />
            </button>
            <button
                type="button"
                data-testid="workspace-changes-close"
                class="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                :title="t('workspace.closePanel')"
                :aria-label="t('workspace.closePanel')"
                @click="emit('close')"
            >
                <X class="size-3.5" aria-hidden="true" />
            </button>
        </div>

        <div class="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
            <template v-if="activeTab === 'timeline'">
                <p
                    v-if="timelineLoading"
                    data-testid="workspace-checkpoint-timeline-loading"
                    class="flex items-center gap-2 text-xs text-muted-foreground"
                >
                    <LoaderCircle class="size-3.5 animate-spin" aria-hidden="true" />
                    {{ t("workspace.checkpointTimelineLoading") }}
                </p>
                <div
                    v-else-if="timelineError"
                    data-testid="workspace-checkpoint-timeline-error"
                    class="space-y-1"
                >
                    <p class="text-xs text-destructive" role="alert">{{ timelineError }}</p>
                    <button
                        type="button"
                        data-testid="workspace-checkpoint-timeline-retry"
                        class="rounded border px-2 py-0.5 text-xs transition-colors hover:bg-accent"
                        @click="loadTimeline(true)"
                    >
                        {{ t("workspace.diffPendingRetry") }}
                    </button>
                </div>
                <p
                    v-else-if="timeline.length === 0"
                    data-testid="workspace-checkpoint-timeline-empty"
                    class="text-xs text-muted-foreground"
                >
                    {{ t("workspace.checkpointTimelineEmpty") }}
                </p>
                <ol
                    v-else
                    data-testid="workspace-checkpoint-timeline"
                    class="relative space-y-2 border-l pl-3"
                >
                    <li
                        v-for="checkpoint in timeline"
                        :key="checkpoint.id"
                        data-testid="workspace-checkpoint-card"
                        class="relative rounded-lg border bg-muted/10 p-2.5"
                    >
                        <span
                            class="absolute -left-[1.05rem] top-3 size-2 rounded-full border-2 border-background bg-primary"
                            aria-hidden="true"
                        />
                        <div class="flex flex-wrap items-start justify-between gap-2">
                            <button
                                type="button"
                                class="min-w-0 text-left"
                                :aria-expanded="selectedCheckpointId === checkpoint.id"
                                :data-testid="`workspace-checkpoint-select-${checkpoint.id}`"
                                @click="selectCheckpoint(checkpoint.id)"
                            >
                                <span class="block text-xs font-semibold">{{
                                    checkpoint.capturedAt
                                        ? new Date(checkpoint.capturedAt).toLocaleString()
                                        : t("workspace.checkpointTimeUnknown")
                                }}</span>
                                <span class="mt-0.5 block text-[11px] text-muted-foreground"
                                    >{{
                                        checkpoint.sourceRunId ??
                                        t("workspace.checkpointSourceUnknown")
                                    }}
                                    ·
                                    {{
                                        checkpoint.sourceSessionId ??
                                        t("workspace.checkpointSourceUnknown")
                                    }}</span
                                >
                            </button>
                            <span
                                :data-checkpoint-state="checkpoint.state"
                                class="shrink-0 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground"
                                >{{ t(`workspace.checkpointState.${checkpoint.state}`) }}</span
                            >
                        </div>
                        <div
                            class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground"
                        >
                            <span
                                >{{ checkpoint.changedCount }}
                                {{ t("workspace.diffRunChangedUnit") }}</span
                            >
                            <span v-if="checkpoint.opaqueNestedRepos.length > 0"
                                >{{ t("workspace.checkpointOpaqueRepos") }}:
                                {{ checkpoint.opaqueNestedRepos.length }}</span
                            >
                            <span v-if="checkpoint.truncated">{{
                                t("workspace.checkpointTruncated")
                            }}</span>
                        </div>
                        <div
                            v-if="selectedCheckpointId === checkpoint.id"
                            data-testid="workspace-checkpoint-slice-details"
                            class="mt-2 space-y-2 border-t pt-2"
                        >
                            <ul
                                v-if="checkpoint.changedFiles.length > 0"
                                data-testid="workspace-checkpoint-files"
                                class="space-y-1 rounded border bg-background/40 p-2 text-xs"
                            >
                                <li
                                    v-for="entry in checkpoint.changedFiles"
                                    :key="`${entry.status}:${entry.path}`"
                                    class="flex items-baseline gap-1.5"
                                >
                                    <span
                                        class="rounded border px-1 py-0.5 text-[10px] text-muted-foreground"
                                        >{{ entry.status }}</span
                                    ><span class="break-all font-mono">{{ entry.path }}</span>
                                </li>
                            </ul>
                            <p
                                v-else-if="checkpoint.changedCount > 0"
                                class="text-[11px] text-muted-foreground"
                            >
                                {{ t("workspace.checkpointFilesTruncated") }}
                            </p>
                            <p
                                v-if="checkpoint.opaqueNestedRepos.length > 0"
                                class="text-[11px] text-muted-foreground"
                            >
                                {{ t("workspace.checkpointOpaqueRepos") }}:
                                {{ checkpoint.opaqueNestedRepos.join(", ") }}
                            </p>
                            <p
                                v-if="checkpoint.unrollableReason"
                                class="text-[11px] text-destructive"
                            >
                                {{ checkpoint.unrollableReason }}
                            </p>
                            <button
                                v-if="
                                    checkpoint.sliceRef &&
                                    (checkpoint.state === 'captured' ||
                                        checkpoint.state === 'abnormal-captured')
                                "
                                type="button"
                                data-testid="workspace-checkpoint-restore"
                                class="inline-flex min-h-8 items-center rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/20"
                                @click="openRestore(checkpoint.sliceRef)"
                            >
                                {{ t("workspace.checkpointRestore") }}
                            </button>
                        </div>
                    </li>
                </ol>
            </template>

            <template v-else>
                <p
                    v-if="pendingLoading"
                    data-testid="workspace-diff-pending-loading"
                    class="flex items-center gap-2 text-xs text-muted-foreground"
                >
                    <LoaderCircle class="size-3.5 animate-spin" aria-hidden="true" />
                    {{ t("workspace.diffPendingLoading") }}
                </p>
                <div
                    v-else-if="pendingError"
                    data-testid="workspace-diff-pending-error"
                    class="space-y-1"
                >
                    <p class="flex items-start gap-1.5 text-xs text-destructive" role="alert">
                        <CircleAlert class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                        <span>{{ pendingError }}</span>
                    </p>
                    <button
                        type="button"
                        data-testid="workspace-diff-pending-retry"
                        class="rounded border px-2 py-0.5 text-xs transition-colors hover:bg-accent"
                        @click="loadGitStatus"
                    >
                        {{ t("workspace.diffPendingRetry") }}
                    </button>
                </div>
                <p
                    v-else-if="pendingStatus && !pendingStatus.isRepository"
                    data-testid="workspace-diff-pending-no-repo"
                    class="text-xs text-muted-foreground"
                >
                    {{ t("workspace.diffPendingNoRepo") }}
                </p>
                <template v-else-if="pendingStatus">
                    <p data-testid="workspace-diff-pending-count" class="text-xs font-medium">
                        {{ pendingStatus.entries.length }} {{ t("workspace.diffPendingCountUnit") }}
                    </p>
                    <ul
                        v-if="pendingStatus.entries.length > 0"
                        data-testid="workspace-diff-pending-list"
                        class="space-y-1 rounded-lg border bg-muted/10 p-2 text-xs"
                    >
                        <li
                            v-for="entry in pendingStatus.entries"
                            :key="`pending:${entry.status}:${entry.path}`"
                            data-testid="workspace-diff-pending-entry"
                            class="flex items-baseline gap-1.5"
                        >
                            <span
                                class="rounded border px-1 py-0.5 text-[10px] text-muted-foreground"
                                >{{ entry.status }}</span
                            >
                            <span class="break-all font-mono">{{ entry.path }}</span>
                        </li>
                    </ul>
                    <p
                        v-else
                        data-testid="workspace-diff-pending-empty"
                        class="text-xs text-muted-foreground"
                    >
                        {{ t("workspace.diffPendingEmpty") }}
                    </p>
                </template>
            </template>

            <p
                data-testid="workspace-diff-difference-note"
                class="border-t pt-2 text-[11px] leading-relaxed text-muted-foreground"
            >
                <FileDiff class="mr-1 inline size-3 align-[-2px]" aria-hidden="true" />
                {{ t("workspace.diffDifferenceNote") }}
            </p>
        </div>

        <RevertPreviewDialog
            :show="restorePreviewSliceRef !== null"
            :workspace-id="workspaceId"
            :slice-ref="restorePreviewSliceRef ?? ''"
            :busy="restoreBusy"
            :error="restoreError"
            @confirm="confirmRestore"
            @close="closeRestorePreview"
        />

        <RevertResultDialog
            :show="restoreResult !== null"
            :workspace-id="workspaceId"
            :result="restoreResult"
            @retry="retryRestore"
            @close="closeRestoreResult"
        />
    </div>
</template>
