<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { RunTraceEvent, RunTraceResponse } from "../../../types";

const props = defineProps<{
    trace: RunTraceResponse | null;
    loading: boolean;
    error: boolean;
    retry: () => void;
    hasMore?: boolean;
    loadingMore?: boolean;
    moreError?: boolean;
    loadMore?: () => void;
}>();

const { t } = useI18n();

// The API orders by full-precision (occurredAt, source, sourceRecordId).
// Preserve that order because Date.parse() would truncate sub-millisecond precision.
const orderedEvents = computed(() => props.trace?.events ?? []);
const safeSources = computed(() => props.trace?.sources ?? []);

function formatTime(value: string): string {
    const timestamp = new Date(value);
    if (Number.isNaN(timestamp.getTime())) return t("monitor.trace.timeUnknown");
    return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "medium",
    }).format(timestamp);
}

function safeIdentifier(value: string | null): string | null {
    return value !== null && value.length <= 128 && /^[A-Za-z0-9_.:-]+$/.test(value) ? value : null;
}

function safeDuration(value: number | null): number | null {
    return value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeReferences(references: RunTraceEvent["references"]): Array<[string, string]> {
    const allowed = new Set([
        "contextEventId",
        "attemptId",
        "toolCallId",
        "mcpInvocationId",
        "runtimeJobId",
    ]);
    return Object.entries(references).filter(
        (entry): entry is [string, string] =>
            allowed.has(entry[0]) &&
            typeof entry[1] === "string" &&
            safeIdentifier(entry[1]) !== null,
    );
}

function tokenCounts(usage: RunTraceEvent["usage"]): Array<[string, number]> {
    if (!usage) return [];
    const counts: Array<[string, number | null]> = [
        ["inputTokens", usage.inputTokens],
        ["outputTokens", usage.outputTokens],
        ["totalTokens", usage.totalTokens],
    ];
    return counts.filter(
        (entry): entry is [string, number] =>
            typeof entry[1] === "number" && Number.isSafeInteger(entry[1]) && entry[1] >= 0,
    );
}

function completenessLabel(value: RunTraceResponse["completeness"]): string {
    return t(`monitor.trace.completeness.${value}`);
}

function sourceStatusLabel(value: RunTraceResponse["sources"][number]["status"]): string {
    return t(`monitor.trace.sourceStatus.${value}`);
}

function eventKindLabel(value: RunTraceEvent["kind"]): string {
    return value === "input.admitted" ? t("monitor.trace.inputAdmitted") : value;
}

function eventStatusLabel(value: RunTraceEvent["status"]): string {
    return value === "admitted"
        ? t("monitor.trace.eventStatus.admitted")
        : (value ?? t("monitor.trace.unknown"));
}

function safeProvenanceIdentifier(value: string | null): string | null {
    return value !== null && safeIdentifier(value) !== null ? value : null;
}
</script>

<template>
    <section
        class="min-w-0 space-y-3 rounded-md border p-3"
        :aria-label="t('monitor.trace.title')"
        data-testid="run-trace-timeline"
    >
        <header class="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <h2 class="text-sm font-medium">{{ t("monitor.trace.title") }}</h2>
            <span
                v-if="trace"
                class="rounded-full border px-2 py-0.5 text-xs"
                :data-completeness="trace.completeness"
                data-testid="run-trace-completeness"
            >
                {{
                    t("monitor.trace.completenessLabel", {
                        value: completenessLabel(trace.completeness),
                    })
                }}
            </span>
        </header>

        <p v-if="loading" class="text-sm text-muted-foreground" role="status" aria-live="polite">
            {{ t("monitor.trace.loading") }}
        </p>

        <div v-else-if="error" class="space-y-2 rounded border border-destructive/40 p-3">
            <p class="text-sm" role="alert">{{ t("monitor.trace.failed") }}</p>
            <button
                type="button"
                class="rounded border px-2 py-1 text-sm hover:bg-accent"
                data-testid="run-trace-retry"
                @click="retry"
            >
                {{ t("monitor.trace.retry") }}
            </button>
        </div>

        <template v-else-if="trace">
            <section
                class="space-y-2 rounded border p-2"
                :aria-label="t('monitor.trace.provenanceTitle')"
                data-testid="run-trace-provenance"
                :data-provenance-status="trace.provenance.status"
            >
                <div class="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <h3 class="font-medium">{{ t("monitor.trace.provenanceTitle") }}</h3>
                    <span class="rounded-full border px-2 py-0.5">
                        {{ t(`monitor.trace.provenanceStatus.${trace.provenance.status}`) }}
                    </span>
                </div>
                <dl class="grid min-w-0 grid-cols-1 gap-x-3 gap-y-1 text-xs sm:grid-cols-2">
                    <div
                        v-if="safeProvenanceIdentifier(trace.provenance.providerConnectionId)"
                        class="min-w-0 break-all"
                    >
                        <dt class="inline text-muted-foreground">
                            {{ t("monitor.trace.providerConnection") }}:
                        </dt>
                        <dd class="inline">
                            <code>{{ trace.provenance.providerConnectionId }}</code>
                        </dd>
                    </div>
                    <div v-else class="min-w-0 break-words">
                        <dt class="inline text-muted-foreground">
                            {{ t("monitor.trace.providerConnection") }}:
                        </dt>
                        <dd class="inline text-muted-foreground">
                            {{ t("monitor.trace.unknown") }}
                        </dd>
                    </div>
                    <div
                        v-if="trace.provenance.connectionRevision !== null"
                        class="min-w-0 break-words"
                    >
                        <dt class="inline text-muted-foreground">
                            {{ t("monitor.trace.connectionRevision") }}:
                        </dt>
                        <dd class="inline">{{ trace.provenance.connectionRevision }}</dd>
                    </div>
                    <div v-else class="min-w-0 break-words">
                        <dt class="inline text-muted-foreground">
                            {{ t("monitor.trace.connectionRevision") }}:
                        </dt>
                        <dd class="inline text-muted-foreground">
                            {{ t("monitor.trace.unknown") }}
                        </dd>
                    </div>
                    <div
                        v-if="safeProvenanceIdentifier(trace.provenance.apiTypeId)"
                        class="min-w-0 break-all"
                    >
                        <dt class="inline text-muted-foreground">
                            {{ t("monitor.trace.apiType") }}:
                        </dt>
                        <dd class="inline">{{ trace.provenance.apiTypeId }}</dd>
                    </div>
                    <div v-else class="min-w-0 break-words">
                        <dt class="inline text-muted-foreground">
                            {{ t("monitor.trace.apiType") }}:
                        </dt>
                        <dd class="inline text-muted-foreground">
                            {{ t("monitor.trace.unknown") }}
                        </dd>
                    </div>
                    <div
                        v-if="trace.provenance.apiTypeVersion !== null"
                        class="min-w-0 break-words"
                    >
                        <dt class="inline text-muted-foreground">
                            {{ t("monitor.trace.apiTypeVersion") }}:
                        </dt>
                        <dd class="inline">{{ trace.provenance.apiTypeVersion }}</dd>
                    </div>
                    <div v-else class="min-w-0 break-words">
                        <dt class="inline text-muted-foreground">
                            {{ t("monitor.trace.apiTypeVersion") }}:
                        </dt>
                        <dd class="inline text-muted-foreground">
                            {{ t("monitor.trace.unknown") }}
                        </dd>
                    </div>
                    <div v-if="trace.provenance.contextTemplateLayer" class="min-w-0 break-words">
                        <dt class="inline text-muted-foreground">
                            {{ t("monitor.trace.contextTemplateLayer") }}:
                        </dt>
                        <dd class="inline">{{ trace.provenance.contextTemplateLayer }}</dd>
                    </div>
                    <div v-else class="min-w-0 break-words">
                        <dt class="inline text-muted-foreground">
                            {{ t("monitor.trace.contextTemplateLayer") }}:
                        </dt>
                        <dd class="inline text-muted-foreground">
                            {{ t("monitor.trace.unknown") }}
                        </dd>
                    </div>
                    <div
                        v-if="safeProvenanceIdentifier(trace.provenance.contextTemplateId)"
                        class="min-w-0 break-all"
                    >
                        <dt class="inline text-muted-foreground">
                            {{ t("monitor.trace.contextTemplateId") }}:
                        </dt>
                        <dd class="inline">
                            <code>{{ trace.provenance.contextTemplateId }}</code>
                        </dd>
                    </div>
                    <div v-else class="min-w-0 break-words">
                        <dt class="inline text-muted-foreground">
                            {{ t("monitor.trace.contextTemplateId") }}:
                        </dt>
                        <dd class="inline text-muted-foreground">
                            {{ t("monitor.trace.unknown") }}
                        </dd>
                    </div>
                    <div
                        v-if="trace.provenance.contextTemplateVersion !== null"
                        class="min-w-0 break-words"
                    >
                        <dt class="inline text-muted-foreground">
                            {{ t("monitor.trace.contextTemplateVersion") }}:
                        </dt>
                        <dd class="inline">{{ trace.provenance.contextTemplateVersion }}</dd>
                    </div>
                    <div v-else class="min-w-0 break-words">
                        <dt class="inline text-muted-foreground">
                            {{ t("monitor.trace.contextTemplateVersion") }}:
                        </dt>
                        <dd class="inline text-muted-foreground">
                            {{ t("monitor.trace.unknown") }}
                        </dd>
                    </div>
                </dl>
            </section>

            <ul
                v-if="orderedEvents.length > 0"
                class="min-w-0 space-y-2"
                :aria-label="t('monitor.trace.eventsAria')"
                data-testid="run-trace-events"
            >
                <li
                    v-for="event in orderedEvents"
                    :key="event.eventId"
                    class="min-w-0 space-y-2 rounded border p-2"
                    data-testid="run-trace-event"
                    :data-event-id="event.eventId"
                >
                    <div class="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1 text-sm">
                        <time
                            class="shrink-0 text-xs text-muted-foreground"
                            :datetime="event.occurredAt"
                        >
                            {{ formatTime(event.occurredAt) }}
                        </time>
                        <code class="max-w-full break-all">{{ eventKindLabel(event.kind) }}</code>
                        <span class="break-words">{{ eventStatusLabel(event.status) }}</span>
                        <span class="text-xs text-muted-foreground">{{ event.source }}</span>
                    </div>

                    <dl class="grid min-w-0 grid-cols-1 gap-x-3 gap-y-1 text-xs sm:grid-cols-2">
                        <div v-if="event.providerId" class="min-w-0 break-words">
                            <dt class="inline text-muted-foreground">
                                {{ t("monitor.trace.provider") }}:
                            </dt>
                            <dd class="inline">{{ event.providerId }}</dd>
                        </div>
                        <div v-if="event.modelId" class="min-w-0 break-words">
                            <dt class="inline text-muted-foreground">
                                {{ t("monitor.trace.model") }}:
                            </dt>
                            <dd class="inline">{{ event.modelId }}</dd>
                        </div>
                        <div v-if="safeIdentifier(event.toolName)" class="min-w-0 break-all">
                            <dt class="inline text-muted-foreground">
                                {{ t("monitor.trace.tool") }}:
                            </dt>
                            <dd class="inline">{{ safeIdentifier(event.toolName) }}</dd>
                        </div>
                        <div class="min-w-0 break-words" data-testid="run-trace-duration">
                            <dt class="inline text-muted-foreground">
                                {{ t("monitor.trace.duration") }}:
                            </dt>
                            <dd class="inline">
                                {{ safeDuration(event.durationMs) ?? t("monitor.trace.unknown") }}
                                <template v-if="safeDuration(event.durationMs) !== null">
                                    {{ t("monitor.trace.milliseconds") }}
                                </template>
                            </dd>
                        </div>
                        <div v-if="safeIdentifier(event.errorCode)" class="min-w-0 break-all">
                            <dt class="inline text-muted-foreground">
                                {{ t("monitor.trace.errorCode") }}:
                            </dt>
                            <dd class="inline">{{ safeIdentifier(event.errorCode) }}</dd>
                        </div>
                        <div
                            v-for="[name, count] in tokenCounts(event.usage)"
                            :key="name"
                            class="min-w-0 break-words"
                            data-testid="run-trace-usage"
                        >
                            <dt class="inline text-muted-foreground">
                                {{ t(`monitor.trace.usage.${name}`) }}:
                            </dt>
                            <dd class="inline">{{ count }}</dd>
                        </div>
                    </dl>

                    <dl
                        v-if="safeReferences(event.references).length > 0"
                        class="flex min-w-0 flex-wrap gap-x-3 gap-y-1 border-t pt-2 text-xs"
                        :aria-label="t('monitor.trace.referencesAria')"
                        data-testid="run-trace-references"
                    >
                        <div
                            v-for="[name, value] in safeReferences(event.references)"
                            :key="name"
                            class="min-w-0 max-w-full break-all"
                        >
                            <dt class="inline text-muted-foreground">{{ name }}:{{ " " }}</dt>
                            <dd class="inline">
                                <code>{{ value }}</code>
                            </dd>
                        </div>
                    </dl>
                </li>
            </ul>
            <p v-else class="rounded border px-3 py-4 text-sm text-muted-foreground" role="status">
                {{ t("monitor.trace.empty") }}
            </p>

            <ul
                v-if="safeSources.length > 0"
                class="flex min-w-0 flex-wrap gap-2 border-t pt-2 text-xs"
                :aria-label="t('monitor.trace.sourcesAria')"
                data-testid="run-trace-sources"
            >
                <li
                    v-for="source in safeSources"
                    :key="source.source"
                    class="max-w-full break-all rounded border px-2 py-1"
                >
                    {{ source.source }}: {{ sourceStatusLabel(source.status) }}
                </li>
            </ul>

            <div v-if="moreError" class="flex flex-wrap items-center gap-2 text-sm">
                <p class="flex-1 text-destructive" role="alert">
                    {{ t("monitor.trace.loadMoreFailed") }}
                </p>
                <button
                    type="button"
                    class="rounded border px-2 py-1 hover:bg-accent"
                    data-testid="run-trace-retry-more"
                    @click="loadMore"
                >
                    {{ t("monitor.trace.retry") }}
                </button>
            </div>
            <button
                v-if="hasMore && !moreError"
                type="button"
                class="rounded border px-3 py-1.5 text-sm hover:bg-accent disabled:cursor-wait disabled:opacity-60"
                data-testid="run-trace-load-more"
                :disabled="loadingMore"
                @click="loadMore"
            >
                {{ loadingMore ? t("monitor.trace.loadingMore") : t("monitor.trace.loadMore") }}
            </button>
        </template>

        <p v-else class="rounded border px-3 py-4 text-sm text-muted-foreground" role="status">
            {{ t("monitor.trace.noRuns") }}
        </p>
    </section>
</template>
