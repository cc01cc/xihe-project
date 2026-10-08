<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { ApiFollowUpItem, ApiFollowUpQueueSnapshot } from "../../composables/api";
import type { Message } from "../../types";

const props = defineProps<{
    snapshot: ApiFollowUpQueueSnapshot;
    messages: Message[];
    branchLabels: Record<string, string>;
    busyItemId?: string | null;
    continuing?: boolean;
    error?: string | null;
}>();

const emit = defineEmits<{
    withdraw: [queueItemId: string];
    continue: [];
}>();

const { t } = useI18n();

const visibleItems = computed(() => {
    const outstanding = props.snapshot.items.filter(
        (item) =>
            item.status === "queued" || item.status === "paused" || item.status === "admitted",
    );
    const childFailurePause =
        props.snapshot.pauseReason === "child_cancelled" ||
        props.snapshot.pauseReason === "child_ambiguous";
    const attempted = childFailurePause
        ? props.snapshot.items.reduce<ApiFollowUpItem | undefined>(
              (latest, item) => (item.status === "completed" && item.childRunId ? item : latest),
              undefined,
          )
        : undefined;
    return attempted ? [attempted, ...outstanding] : outstanding;
});

function messageFor(item: ApiFollowUpItem): Message | undefined {
    return props.messages.find(
        (message) =>
            message.id === item.childMessageId ||
            (item.childRunId !== null && message.runId === item.childRunId),
    );
}

function itemText(item: ApiFollowUpItem): string {
    return item.content ?? messageFor(item)?.content ?? t("chat.followUpContentUnavailable");
}

function itemBranch(item: ApiFollowUpItem): string {
    return (
        props.branchLabels[item.branchId] ??
        `${t("chat.branchPathOption")} ${item.branchId.slice(0, 8)}`
    );
}

function itemStatus(item: ApiFollowUpItem): string {
    if (item.status === "admitted") return t("chat.followUpStatusRunning");
    if (item.status === "paused") return t("chat.followUpStatusPaused");
    if (item.status === "completed") {
        const child = props.messages.find(
            (message) =>
                message.runId === item.childRunId &&
                Boolean(message.runStatus || message.terminalOutcome),
        );
        if (child?.runStatus === "cancelled") return t("chat.followUpStatusCancelled");
        if (child?.terminalOutcome === "ambiguous") return t("chat.followUpStatusAmbiguous");
        if (child?.runStatus === "failed") return t("chat.followUpStatusFailed");
        return t("chat.followUpStatusCompleted");
    }
    if (item.status === "withdrawn") return t("chat.followUpStatusWithdrawn");
    const queued = props.snapshot.items.filter((candidate) => candidate.status === "queued");
    return queued[0]?.queueItemId === item.queueItemId
        ? t("chat.followUpStatusQueued")
        : t("chat.followUpStatusWaiting");
}

function pauseMessage(): string {
    const reason = props.snapshot.pauseReason;
    if (reason === "parent_cancelled" || reason === "child_cancelled") {
        return t("chat.followUpPausedCancelled");
    }
    if (reason === "parent_ambiguous" || reason === "child_ambiguous") {
        return t("chat.followUpPausedAmbiguous");
    }
    if (reason === "attachment_unavailable") return t("chat.followUpPausedAttachment");
    if (reason === "branch_unavailable" || reason === "anchor_unavailable") {
        return t("chat.followUpPausedBranch");
    }
    if (reason === "session_binding_stale" || reason === "child_missing") {
        return t("chat.followUpPausedStale");
    }
    return t("chat.followUpPausedGeneric");
}
</script>

<template>
    <section
        class="mx-auto mb-3 w-[calc(100%_-_2rem)] max-w-4xl rounded-xl border bg-card px-3 py-2.5 max-sm:max-h-56 max-sm:overflow-y-auto"
        :aria-label="t('chat.followUpQueueTitle')"
        data-testid="follow-up-queue"
    >
        <header class="mb-2 flex items-center justify-between gap-3">
            <div class="flex min-w-0 items-baseline gap-2">
                <h2 class="shrink-0 text-xs font-semibold">
                    {{ t("chat.followUpQueueTitle") }}
                </h2>
                <span
                    class="truncate text-[11px] text-muted-foreground"
                    data-testid="follow-up-queue-count"
                >
                    {{
                        t("chat.followUpCount", {
                            count: snapshot.outstandingCount,
                            capacity: snapshot.capacityLimit,
                        })
                    }}
                </span>
            </div>
            <button
                v-if="snapshot.queueState === 'paused'"
                type="button"
                data-testid="follow-up-continue-button"
                class="min-h-11 shrink-0 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                :disabled="continuing || busyItemId !== null"
                @click="emit('continue')"
            >
                {{ continuing ? t("chat.followUpContinuing") : t("chat.followUpContinue") }}
            </button>
            <span v-else class="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span class="size-1.5 rounded-full bg-primary" />
                FIFO
            </span>
        </header>

        <p
            v-if="snapshot.queueState === 'paused'"
            class="mb-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-800 dark:text-amber-200"
            role="status"
            data-testid="follow-up-pause-reason"
        >
            {{ pauseMessage() }}
        </p>
        <p
            v-if="error"
            class="mb-2 rounded-lg border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-xs text-destructive"
            role="alert"
        >
            {{ error }}
        </p>

        <ol class="grid gap-px" data-testid="follow-up-queue-list">
            <li
                v-for="(item, index) in visibleItems"
                :key="item.queueItemId"
                class="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-start gap-2 border-t py-2 first:border-t-0 max-sm:grid-cols-[1.5rem_minmax(0,1fr)]"
                data-testid="follow-up-queue-item"
            >
                <span
                    class="inline-flex size-5 items-center justify-center rounded-md border text-[10px] tabular-nums text-muted-foreground"
                >
                    {{ String(item.queueSequence).padStart(2, "0") }}
                </span>
                <div class="min-w-0">
                    <p class="truncate text-xs text-foreground" :title="itemText(item)">
                        {{ itemText(item) }}
                    </p>
                    <div
                        class="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground"
                    >
                        <span>{{ itemBranch(item) }}</span>
                        <span
                            v-for="attachment in item.attachments"
                            :key="attachment.id"
                            class="truncate"
                        >
                            {{ attachment.name }}
                        </span>
                        <span
                            v-if="!item.attachments.length && messageFor(item)?.attachments?.length"
                        >
                            {{
                                messageFor(item)
                                    ?.attachments?.map((file) => file.name)
                                    .join(", ")
                            }}
                        </span>
                    </div>
                </div>
                <div
                    class="flex items-center gap-2 self-center whitespace-nowrap text-[10px] text-muted-foreground max-sm:col-start-2 max-sm:justify-self-start"
                >
                    <span
                        class="inline-flex items-center gap-1.5"
                        data-testid="follow-up-item-status"
                        :data-status="item.status"
                        :class="
                            item.status === 'paused' ? 'text-amber-700 dark:text-amber-200' : ''
                        "
                    >
                        <span
                            class="size-1.5 rounded-full"
                            :class="
                                item.status === 'admitted'
                                    ? 'bg-primary'
                                    : item.status === 'paused'
                                      ? 'bg-amber-600'
                                      : 'bg-muted-foreground'
                            "
                        />
                        {{ itemStatus(item) }}
                    </span>
                    <button
                        v-if="item.status === 'queued' || item.status === 'paused'"
                        type="button"
                        class="min-h-11 rounded-md border px-2.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                        :aria-label="
                            t('chat.followUpWithdrawItem', { sequence: item.queueSequence })
                        "
                        :disabled="busyItemId !== null || continuing"
                        :data-testid="`follow-up-withdraw-${index}`"
                        @click="emit('withdraw', item.queueItemId)"
                    >
                        {{
                            busyItemId === item.queueItemId
                                ? t("chat.followUpWithdrawing")
                                : t("chat.followUpWithdraw")
                        }}
                    </button>
                </div>
            </li>
        </ol>

        <footer class="mt-1 flex flex-wrap justify-between gap-2 text-[10px] text-muted-foreground">
            <span>{{ t("chat.followUpExecutionNote") }}</span>
            <span>{{ t("chat.followUpCapacityNote", { capacity: snapshot.capacityLimit }) }}</span>
        </footer>
    </section>
</template>
