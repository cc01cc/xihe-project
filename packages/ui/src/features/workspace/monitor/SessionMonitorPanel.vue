<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RefreshCw } from "@lucide/vue";
import { api } from "../../../composables/api";
import { logger } from "../../../lib/logger";
import type {
    ChatTransportAttempt,
    RunTransportAttemptsResponse,
    SessionMonitorResponse,
} from "../../../types";
import { onSessionSignals } from "../chat/sessionEvents";
import {
    TRANSPORT_STAGES,
    liveRunAttempts,
    type LiveTransportAttempt,
} from "../chat/transportLive";

/**
 * PLAN-0507: right-panel Session monitor (activity / history / readiness).
 * Read-only aggregate of `GET /api/v1/chat/sessions/{id}/monitor`; refresh is
 * initial load + debounced invalidation from the shared chat SSE signals +
 * manual retry. It never opens a second SSE connection.
 */
const props = defineProps<{ sessionId: string }>();
const { t, te } = useI18n();

const DEBOUNCE_MS = 500;
type Connection = "snapshot" | "live" | "stale";

const data = ref<SessionMonitorResponse | null>(null);
const loading = ref(true);
const loadFailed = ref(false);
const connection = ref<Connection>("snapshot");
const attempts = ref<RunTransportAttemptsResponse | null>(null);
const attemptsRunId = ref<string | null>(null);
const attemptsLoadFailed = ref(false);
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;
let attemptsInFlight = false;
let rerunQueued = false;
let unsubscribe: (() => void) | null = null;

async function fetchMonitor(): Promise<void> {
    if (inFlight) {
        rerunQueued = true;
        return;
    }
    inFlight = true;
    try {
        data.value = await api.getSessionMonitor(props.sessionId);
        loadFailed.value = false;
        void fetchAttempts(diagnoseRunId.value);
    } catch (fetchError) {
        // Keep the last snapshot visible; the banner offers a retry.
        logger.warn("session monitor fetch failed", fetchError);
        loadFailed.value = true;
    } finally {
        loading.value = false;
        inFlight = false;
        if (rerunQueued) {
            rerunQueued = false;
            scheduleRefresh();
        }
    }
}

function scheduleRefresh(): void {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void fetchMonitor();
    }, DEBOUNCE_MS);
}

function subscribe(sessionId: string): void {
    unsubscribe?.();
    unsubscribe = onSessionSignals(sessionId, {
        onData: () => scheduleRefresh(),
        onConnection: (status) => {
            if (status === "live") {
                connection.value = "live";
                scheduleRefresh();
            } else {
                // Connection state tracks the SSE channel itself: an offline
                // signal can arrive before the first fetch resolves (the
                // transport latches errors, so it must not be dropped).
                connection.value = "stale";
            }
        },
    });
}

onMounted(() => {
    subscribe(props.sessionId);
    void fetchMonitor();
});

onBeforeUnmount(() => {
    unsubscribe?.();
    if (debounceTimer !== null) clearTimeout(debounceTimer);
});

watch(
    () => props.sessionId,
    (id) => {
        data.value = null;
        loading.value = true;
        loadFailed.value = false;
        connection.value = "snapshot";
        subscribe(id);
        void fetchMonitor();
    },
);

function retry(): void {
    loading.value = data.value === null;
    void fetchMonitor();
}

/*
 * PLAN-0508: transport diagnostics for the most recent Run. Durable attempt
 * rows come from `GET /chat/runs/{runId}/attempts`; the live SSE mirror
 * (`transportLive`) overrides rows that are still running so the stage
 * timeline stays fresh between refetches. The durable `lastProgressStage`
 * sample is displayed statically after a refresh — never extrapolated.
 */
const diagnoseRunId = computed<string | null>(
    () => data.value?.activity[0]?.runId ?? data.value?.history.recent[0]?.runId ?? null,
);

const transportAggregate = computed(() => data.value?.transport);

async function fetchAttempts(runId: string | null): Promise<void> {
    if (attemptsInFlight) return;
    if (runId === null) {
        attempts.value = null;
        attemptsRunId.value = null;
        attemptsLoadFailed.value = false;
        return;
    }
    attemptsInFlight = true;
    try {
        attempts.value = await api.getRunAttempts(runId);
        attemptsRunId.value = runId;
        attemptsLoadFailed.value = false;
    } catch (fetchError) {
        logger.warn("run transport attempts fetch failed", fetchError);
        attemptsLoadFailed.value = true;
    } finally {
        attemptsInFlight = false;
    }
}

interface TransportAttemptView {
    attemptId: string;
    seq: number;
    status: "running" | "terminal";
    outcome: string | null;
    errorCode: string | number | null;
    durationMs: number | null;
    firstChunkMs: number | null;
    chunkCount: number | null;
    uploadBytes: number | null;
    downloadBytes: number | null;
    startedAt: string;
    endedAt: string | null;
    stage: string | null;
    stageElapsedMs: number | null;
}

function durableView(row: ChatTransportAttempt): TransportAttemptView {
    return {
        attemptId: row.attemptId,
        seq: row.seq,
        status: row.status,
        outcome: row.outcome,
        errorCode: row.errorCode,
        durationMs: row.durationMs,
        firstChunkMs: row.firstChunkMs,
        chunkCount: row.chunkCount,
        uploadBytes: row.uploadBytes,
        downloadBytes: row.downloadBytes,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        stage: row.lastProgressStage,
        stageElapsedMs: row.lastProgressElapsedMs,
    };
}

function liveView(row: LiveTransportAttempt): TransportAttemptView {
    return {
        attemptId: row.attemptId,
        seq: row.seq,
        status: row.status,
        outcome: row.outcome,
        errorCode: row.errorCode,
        durationMs: row.durationMs,
        firstChunkMs: row.firstChunkMs,
        chunkCount: row.chunkCount,
        uploadBytes: row.uploadBytes,
        downloadBytes: row.downloadBytes,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        stage: row.stage,
        stageElapsedMs: row.stageElapsedMs,
    };
}

const mergedAttempts = computed<TransportAttemptView[]>(() => {
    const runId = attemptsRunId.value ?? diagnoseRunId.value;
    if (!runId) return [];
    const durableRows = attemptsRunId.value === runId ? (attempts.value?.attempts ?? []) : [];
    const liveById = new Map(
        liveRunAttempts(props.sessionId, runId).map((row) => [row.attemptId, row]),
    );
    const rows: TransportAttemptView[] = [];
    const seen = new Set<string>();
    for (const row of durableRows) {
        const live = liveById.get(row.attemptId);
        // A fetched running row lags the live mirror; a fetched terminal row is
        // the authoritative projection (exact metrics, CP partial reconcile).
        rows.push(live && row.status === "running" ? liveView(live) : durableView(row));
        seen.add(row.attemptId);
    }
    for (const live of liveById.values()) {
        if (!seen.has(live.attemptId)) rows.push(liveView(live));
    }
    rows.sort((left, right) => left.seq - right.seq);
    return rows;
});

const latestAttempt = computed<TransportAttemptView | null>(
    () => mergedAttempts.value[mergedAttempts.value.length - 1] ?? null,
);

const stageCells = computed(() => {
    const attempt = latestAttempt.value;
    return TRANSPORT_STAGES.map((stage) => {
        let value = "—";
        if (attempt) {
            if (stage === "attempt_started") value = formatTime(attempt.startedAt);
            else if (stage === "first_chunk")
                value =
                    attempt.firstChunkMs !== null
                        ? formatMs(attempt.firstChunkMs)
                        : attempt.stage === "first_chunk"
                          ? formatMs(attempt.stageElapsedMs)
                          : "—";
            else if (stage === "streaming")
                value = attempt.stage === "streaming" ? formatMs(attempt.stageElapsedMs) : "—";
            else if (stage === "attempt_finished")
                value = attempt.status === "terminal" ? formatMs(attempt.durationMs) : "—";
        }
        return {
            stage,
            value,
            active: attempt?.status === "running" && attempt.stage === stage,
        };
    });
});

const runIdentity = computed<string | null>(() => {
    const run = attempts.value;
    if (!run || attemptsRunId.value === null || attemptsRunId.value !== diagnoseRunId.value)
        return null;
    const first = run.attempts[0];
    if (!first) return null;
    const modelPart = [first.provider, first.model]
        .filter((part): part is string => Boolean(part))
        .join(" · ");
    const connectionPart = first.connectionId
        ? `${first.connectionId.slice(0, 8)}@${first.connectionRevision ?? "?"}`
        : "";
    return [modelPart, connectionPart].filter(Boolean).join(" · ") || null;
});

const counts = computed(() => Object.entries(data.value?.history.counts ?? {}));

function formatTime(value: string | null): string {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function runIdShort(runId: string): string {
    return runId.length > 8 ? runId.slice(0, 8) : runId;
}

function formatMs(value: number | null): string {
    return value === null ? "—" : `${value} ms`;
}

function bytesLabel(value: number | null): string {
    // v1 wire bytes are fixed null/unknown; never fabricate a size.
    return value === null ? t("monitor.transport.unknown") : `${value} B`;
}

function statusChipClass(status: string): string {
    if (status === "awaiting_approval") return "bg-amber-500/10 text-amber-600 dark:text-amber-400";
    if (status === "cancelling") return "bg-orange-500/10 text-orange-600 dark:text-orange-400";
    return "bg-primary/10 text-primary";
}

function statusLabel(status: string): string {
    const key = `monitor.status.${status}`;
    return te(key) ? t(key) : status;
}

function outcomeChipClass(outcome: string | null): string {
    if (outcome === "success") return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
    if (outcome === "error" || outcome === "failed" || outcome === "partial")
        return "bg-red-500/10 text-red-600 dark:text-red-400";
    return "bg-muted text-muted-foreground";
}

const connectionChipClass = computed(() => {
    if (connection.value === "live") return "text-emerald-600 dark:text-emerald-400";
    if (connection.value === "stale") return "text-amber-600 dark:text-amber-400";
    return "text-muted-foreground";
});
</script>

<template>
    <div class="flex min-h-0 flex-1 flex-col" data-testid="session-monitor-panel">
        <div class="flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-xs">
            <span
                class="inline-flex items-center gap-1"
                :class="connectionChipClass"
                data-testid="monitor-connection-chip"
            >
                <span class="size-1.5 rounded-full bg-current" aria-hidden="true" />
                {{ t(`monitor.connection.${connection}`) }}
            </span>
            <span class="flex-1" />
            <button
                type="button"
                class="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                data-testid="monitor-refresh"
                :title="t('monitor.refresh')"
                :aria-label="t('monitor.refresh')"
                @click="retry"
            >
                <RefreshCw class="size-3.5" aria-hidden="true" />
            </button>
        </div>

        <div class="min-h-0 flex-1 space-y-3 overflow-auto p-3">
            <div
                v-if="connection === 'stale'"
                class="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-400"
                data-testid="monitor-stale-banner"
            >
                {{ t("monitor.staleNote") }}
            </div>
            <div
                v-if="loadFailed && data"
                class="flex items-center gap-2 rounded border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-xs text-red-700 dark:text-red-400"
                data-testid="monitor-fetch-failed-banner"
            >
                <span class="flex-1">{{ t("monitor.loadFailed") }}</span>
                <button
                    type="button"
                    class="rounded border border-current px-1.5 py-0.5"
                    @click="retry"
                >
                    {{ t("monitor.retry") }}
                </button>
            </div>

            <p v-if="loading" class="text-xs text-muted-foreground" data-testid="monitor-loading">
                {{ t("monitor.loading") }}
            </p>

            <div
                v-else-if="!data"
                class="flex flex-col items-center gap-2 rounded border px-3 py-6 text-xs text-muted-foreground"
                data-testid="monitor-error"
            >
                <span>{{ t("monitor.loadFailed") }}</span>
                <button
                    type="button"
                    class="rounded border px-2 py-1 hover:bg-accent"
                    @click="retry"
                >
                    {{ t("monitor.retry") }}
                </button>
            </div>

            <template v-else>
                <!-- Activity -->
                <section class="rounded border">
                    <header
                        class="flex items-center justify-between border-b px-2 py-1 text-xs text-muted-foreground"
                    >
                        <span class="font-medium">{{ t("monitor.activityTitle") }}</span>
                        <span class="text-[10px]">{{ t("monitor.activityTag") }}</span>
                    </header>
                    <div class="divide-y">
                        <div
                            v-for="item in data.activity"
                            :key="item.runId"
                            class="px-2 py-1.5 text-xs"
                            data-testid="monitor-activity-item"
                        >
                            <div class="flex items-center gap-2">
                                <span
                                    class="rounded-full px-1.5 py-0.5 text-[10px]"
                                    :class="statusChipClass(item.status)"
                                >
                                    {{ statusLabel(item.status) }}
                                </span>
                                <span class="font-mono text-[10px] text-muted-foreground">
                                    {{ runIdShort(item.runId) }}
                                </span>
                                <span class="flex-1" />
                                <span class="text-[10px] text-muted-foreground">
                                    {{ formatTime(item.createdAt) }}
                                </span>
                            </div>
                            <div
                                v-if="item.leaseExpired"
                                class="mt-1 text-[10px] text-amber-600 dark:text-amber-400"
                                data-testid="monitor-lease-expired"
                            >
                                {{ t("monitor.leaseExpired") }}
                            </div>
                        </div>
                        <p
                            v-if="data.activity.length === 0"
                            class="px-2 py-3 text-center text-xs text-muted-foreground"
                            data-testid="monitor-activity-empty"
                        >
                            {{ t("monitor.activityEmpty") }}
                        </p>
                    </div>
                </section>

                <!-- Transport (PLAN-0508) -->
                <section class="rounded border" data-testid="monitor-transport">
                    <header
                        class="flex items-center justify-between border-b px-2 py-1 text-xs text-muted-foreground"
                    >
                        <span class="font-medium">{{ t("monitor.transport.title") }}</span>
                        <span
                            v-if="transportAggregate"
                            class="text-[10px]"
                            data-testid="monitor-transport-aggregate"
                        >
                            {{
                                t("monitor.transport.aggregate", {
                                    attempts: transportAggregate.attemptCount,
                                    failed: transportAggregate.failedCount,
                                    partial: transportAggregate.partialCount,
                                })
                            }}
                        </span>
                    </header>
                    <div class="space-y-2 px-2 py-1.5 text-xs">
                        <template v-if="diagnoseRunId">
                            <div class="flex items-center gap-2">
                                <span
                                    class="font-mono text-[10px] text-muted-foreground"
                                    data-testid="monitor-transport-run"
                                >
                                    {{ runIdShort(diagnoseRunId) }}
                                </span>
                                <span
                                    v-if="runIdentity"
                                    class="truncate text-[10px] text-muted-foreground"
                                >
                                    {{ runIdentity }}
                                </span>
                            </div>
                            <div
                                class="grid grid-cols-4 gap-1.5"
                                data-testid="monitor-transport-stages"
                            >
                                <div
                                    v-for="cell in stageCells"
                                    :key="cell.stage"
                                    class="min-w-0 rounded bg-muted px-1.5 py-1"
                                    :class="cell.active ? 'ring-1 ring-primary/50' : ''"
                                    data-testid="monitor-transport-stage"
                                >
                                    <span class="block truncate text-[9px] text-muted-foreground">
                                        {{ t(`monitor.transport.stage.${cell.stage}`) }}
                                    </span>
                                    <span class="mt-0.5 block truncate font-mono text-[10px]">
                                        {{ cell.value }}
                                    </span>
                                </div>
                            </div>
                            <div
                                class="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground"
                                data-testid="monitor-transport-metrics"
                            >
                                <span>
                                    {{ t("monitor.transport.metrics.duration") }}
                                    <b class="font-mono">{{
                                        formatMs(latestAttempt?.durationMs ?? null)
                                    }}</b>
                                </span>
                                <span>
                                    {{ t("monitor.transport.metrics.firstChunk") }}
                                    <b class="font-mono">{{
                                        formatMs(latestAttempt?.firstChunkMs ?? null)
                                    }}</b>
                                </span>
                                <span>
                                    {{ t("monitor.transport.metrics.chunks") }}
                                    <b class="font-mono">{{ latestAttempt?.chunkCount ?? "—" }}</b>
                                </span>
                                <span>
                                    {{ t("monitor.transport.metrics.upload") }}
                                    <b class="font-mono">{{
                                        bytesLabel(latestAttempt?.uploadBytes ?? null)
                                    }}</b>
                                </span>
                                <span>
                                    {{ t("monitor.transport.metrics.download") }}
                                    <b class="font-mono">{{
                                        bytesLabel(latestAttempt?.downloadBytes ?? null)
                                    }}</b>
                                </span>
                            </div>
                            <div class="divide-y rounded border">
                                <div
                                    v-for="row in mergedAttempts"
                                    :key="row.attemptId"
                                    class="flex items-center gap-2 px-2 py-1"
                                    data-testid="monitor-transport-attempt"
                                >
                                    <span class="font-mono text-[10px] text-muted-foreground">
                                        #{{ row.seq }}
                                    </span>
                                    <span
                                        class="rounded-full px-1.5 py-0.5 text-[10px]"
                                        :class="
                                            outcomeChipClass(
                                                row.status === 'running' ? null : row.outcome,
                                            )
                                        "
                                    >
                                        {{
                                            row.status === "running"
                                                ? t("monitor.transport.running")
                                                : (row.outcome ?? "—")
                                        }}
                                    </span>
                                    <span
                                        class="flex-1 truncate font-mono text-[10px] text-muted-foreground"
                                    >
                                        {{ row.errorCode ?? formatMs(row.durationMs) }}
                                    </span>
                                    <span class="text-[10px] text-muted-foreground">
                                        {{ formatTime(row.endedAt ?? row.startedAt) }}
                                    </span>
                                </div>
                                <p
                                    v-if="mergedAttempts.length === 0"
                                    class="px-2 py-2 text-center text-[10px] text-muted-foreground"
                                    data-testid="monitor-transport-empty"
                                >
                                    {{ t("monitor.transport.empty") }}
                                </p>
                            </div>
                            <p
                                v-if="attemptsLoadFailed"
                                class="text-[10px] text-muted-foreground"
                                data-testid="monitor-transport-history-unavailable"
                            >
                                {{ t("monitor.transport.historyUnavailable") }}
                            </p>
                        </template>
                        <p
                            v-else
                            class="py-1 text-center text-[10px] text-muted-foreground"
                            data-testid="monitor-transport-empty"
                        >
                            {{ t("monitor.transport.empty") }}
                        </p>
                    </div>
                </section>

                <!-- History -->
                <section class="rounded border">
                    <header
                        class="flex items-center justify-between border-b px-2 py-1 text-xs text-muted-foreground"
                    >
                        <span class="font-medium">{{ t("monitor.historyTitle") }}</span>
                        <span class="text-[10px]">
                            {{ t("monitor.historyWindowTag", { size: data.history.windowSize }) }}
                        </span>
                    </header>
                    <div class="px-2 py-1.5">
                        <div v-if="counts.length > 0" class="flex flex-wrap gap-1">
                            <span
                                v-for="[outcome, count] in counts"
                                :key="outcome"
                                class="rounded-full px-1.5 py-0.5 text-[10px]"
                                :class="outcomeChipClass(outcome === 'unknown' ? null : outcome)"
                                data-testid="monitor-history-count"
                            >
                                {{ outcome }} · {{ count }}
                            </span>
                        </div>
                    </div>
                    <div class="divide-y border-t">
                        <div
                            v-for="item in data.history.recent"
                            :key="item.runId"
                            class="flex items-center gap-2 px-2 py-1 text-xs"
                            data-testid="monitor-history-item"
                        >
                            <span
                                class="rounded-full px-1.5 py-0.5 text-[10px]"
                                :class="outcomeChipClass(item.terminalOutcome)"
                            >
                                {{ item.terminalOutcome ?? "—" }}
                            </span>
                            <span
                                class="flex-1 truncate font-mono text-[10px] text-muted-foreground"
                            >
                                {{ item.errorCode ?? runIdShort(item.runId) }}
                            </span>
                            <span class="text-[10px] text-muted-foreground">
                                {{ formatTime(item.terminalAt) }}
                            </span>
                        </div>
                        <p
                            v-if="data.history.recent.length === 0"
                            class="px-2 py-3 text-center text-xs text-muted-foreground"
                            data-testid="monitor-history-empty"
                        >
                            {{ t("monitor.historyEmpty") }}
                        </p>
                    </div>
                </section>

                <!-- Readiness -->
                <section class="rounded border">
                    <header class="border-b px-2 py-1 text-xs font-medium text-muted-foreground">
                        {{ t("monitor.readinessTitle") }}
                    </header>
                    <div class="divide-y text-xs">
                        <div class="flex items-center gap-2 px-2 py-1.5">
                            <span class="flex-1 text-muted-foreground">
                                {{ t("monitor.readinessConnection") }}
                            </span>
                            <template v-if="data.readiness.connection">
                                <span class="rounded-full bg-muted px-1.5 py-0.5 text-[10px]">
                                    {{ data.readiness.connection.status }}
                                </span>
                                <span class="text-[10px] text-muted-foreground">
                                    {{ formatTime(data.readiness.connection.lastVerifiedAt) }}
                                </span>
                            </template>
                            <span
                                v-else
                                class="text-[10px] text-muted-foreground"
                                data-testid="monitor-connection-missing"
                            >
                                {{ t("monitor.notProvided") }}
                            </span>
                        </div>
                        <div class="flex items-center gap-2 px-2 py-1.5">
                            <span class="flex-1 text-muted-foreground">
                                {{ t("monitor.readinessAgent") }}
                            </span>
                            <span
                                class="rounded-full border border-dashed px-1.5 py-0.5 text-[10px] text-muted-foreground"
                                data-testid="monitor-agent-global-tag"
                            >
                                {{ t("monitor.agentGlobalTag") }}
                            </span>
                            <span class="rounded-full bg-muted px-1.5 py-0.5 text-[10px]">
                                {{ data.readiness.agent.llmReady }}
                            </span>
                            <span class="text-[10px] text-muted-foreground">
                                {{ formatTime(data.readiness.agent.verifiedAt) }}
                            </span>
                        </div>
                        <div class="flex items-center gap-2 px-2 py-1.5">
                            <span class="flex-1 text-muted-foreground">
                                {{ t("monitor.readinessLastRun") }}
                            </span>
                            <template v-if="data.readiness.lastObservedRun">
                                <span
                                    class="rounded-full px-1.5 py-0.5 text-[10px]"
                                    :class="
                                        outcomeChipClass(
                                            data.readiness.lastObservedRun.terminalOutcome,
                                        )
                                    "
                                >
                                    {{ data.readiness.lastObservedRun.terminalOutcome ?? "—" }}
                                </span>
                                <span class="text-[10px] text-muted-foreground">
                                    {{ formatTime(data.readiness.lastObservedRun.terminalAt) }}
                                </span>
                            </template>
                            <span v-else class="text-[10px] text-muted-foreground">
                                {{ t("monitor.notProvided") }}
                            </span>
                        </div>
                    </div>
                </section>

                <p class="text-right text-[10px] text-muted-foreground">
                    {{ t("monitor.generatedAt", { time: formatTime(data.generatedAt) }) }}
                </p>
            </template>
        </div>
    </div>
</template>
