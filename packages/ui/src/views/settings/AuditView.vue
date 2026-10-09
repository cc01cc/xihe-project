<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { TriangleAlert, Repeat2 } from "@lucide/vue";
import BackToChatButton from "../../components/settings/BackToChatButton.vue";
import SettingsNav from "../../components/settings/SettingsNav.vue";
import { useAuditStore } from "../../stores/audit";
import type {
    ApprovalPolicyEffect,
    ApprovalPolicyMode,
    ApprovalPolicyShape,
    ApprovalPolicySourceLayer,
    AuditEntry,
    AuditEntryType,
    AuditTimelineEvent,
} from "../../types";

const { t, te } = useI18n();
const auditStore = useAuditStore();
const statusFilter = ref<string>("");
const typeFilter = ref<AuditEntryType | "">("");
const selectedEntryId = ref<string | null>(null);

const detail = computed(() => auditStore.selectedDetail);
const entry = computed(() => detail.value?.entry ?? null);

const typeOptions: { value: AuditEntryType; label: string }[] = [
    { value: "chat_run", label: "settings.auditTypeChatRun" },
    { value: "workspace_job", label: "settings.auditTypeWorkspaceJob" },
    { value: "mcp_invocation", label: "settings.auditTypeMcpInvocation" },
    { value: "approval", label: "settings.auditTypeApproval" },
];

/** Native status vocabularies of the four domains behind v_audit_entries. */
const statusByType: Record<AuditEntryType, string[]> = {
    chat_run: [
        "queued",
        "accepted",
        "running",
        "streaming",
        "awaiting_approval",
        "dispatching",
        "cancelling",
        "succeeded",
        "partial",
        "failed",
        "cancelled",
        "ambiguous",
    ],
    workspace_job: [
        "pending",
        "running",
        "succeeded",
        "cancelled",
        "timeout",
        "orphaned",
        "interrupted",
    ],
    mcp_invocation: ["active", "completed", "failed", "unknown", "cancelled"],
    approval: ["pending", "dispatching", "approved", "rejected", "expired", "dispatch_unknown"],
};

const allStatuses = computed(() => {
    const seen = new Set<string>();
    const values: string[] = [];
    const groups = typeFilter.value
        ? [statusByType[typeFilter.value]]
        : Object.values(statusByType);
    for (const group of groups) {
        for (const status of group) {
            if (!seen.has(status)) {
                seen.add(status);
                values.push(status);
            }
        }
    }
    return values;
});

const sourceLayerLabels: Record<ApprovalPolicySourceLayer, string> = {
    builtin: "chat.approvalLayerBuiltin",
    instance: "chat.approvalLayerInstance",
    user: "chat.approvalLayerUser",
    workspace: "chat.approvalLayerWorkspace",
    session: "chat.approvalLayerSession",
    per_call: "chat.approvalLayerPerCall",
};

const modeLabels: Record<Exclude<ApprovalPolicyMode, null>, string> = {
    manual: "chat.approvalModeManual",
    auto: "chat.approvalModeAuto",
};

const shapeLabels: Record<ApprovalPolicyShape, string> = {
    structured: "chat.approvalShapeStructured",
    interpreter: "chat.approvalShapeInterpreter",
    opaque: "chat.approvalShapeOpaque",
};

const effectLabels: Record<ApprovalPolicyEffect, string> = {
    allow: "settings.policyEffectAllow",
    ask: "settings.policyEffectAsk",
    deny: "settings.policyEffectDeny",
};

function effectClass(effect: ApprovalPolicyEffect): string {
    if (effect === "deny") return "border-destructive/40 bg-destructive/10 text-destructive";
    if (effect === "ask") return "border-amber-500/40 bg-amber-500/10 text-foreground";
    return "border-emerald-500/40 bg-emerald-500/10 text-foreground";
}

function layerLabel(layer: ApprovalPolicySourceLayer): string {
    return t(sourceLayerLabels[layer]);
}

function modeLabel(mode: ApprovalPolicyMode): string {
    return mode === null ? t("chat.approvalModeUnavailable") : t(modeLabels[mode]);
}

function allowedByLabel(allowedBy: string): string {
    if (allowedBy.startsWith("auto")) return t("settings.auditPolicyAllowedByAuto");
    return t("settings.auditPolicyAllowedByOther");
}

function policyTestId(target: AuditEntry): string {
    return `settings-audit-policy-${target.toolCallId || target.id}`;
}

function typeLabel(type: AuditEntryType | string): string {
    const option = typeOptions.find((item) => item.value === type);
    return option ? t(option.label) : type;
}

function statusLabel(status: string): string {
    const key = `settings.auditStatusLabels.${status}`;
    return te(key) ? t(key) : status;
}

/** Only tool-bearing domains carry a policy verdict block (mcp/approval snapshots). */
function isPolicyCapable(target: AuditEntry | null): boolean {
    return target?.type === "mcp_invocation" || target?.type === "approval";
}

function entryToolName(target: AuditEntry | null): string | null {
    if (!target) return null;
    if (target.type === "mcp_invocation" || target.type === "approval") {
        return target.summary || null;
    }
    return null;
}

function eventTransition(event: AuditTimelineEvent): string {
    return [event.fromStatus, event.toStatus].filter(Boolean).join(" → ");
}

function eventExtra(event: AuditTimelineEvent): string {
    return [
        event.actorType,
        event.errorCode,
        event.cancelReason,
        event.terminalOutcome,
        event.decisionKind,
    ]
        .filter(Boolean)
        .join(" · ");
}

async function loadEntries(page = 0) {
    await auditStore.load({
        type: typeFilter.value || undefined,
        status: statusFilter.value || undefined,
        page,
        size: 20,
    });
}

async function selectEntry(target: AuditEntry) {
    selectedEntryId.value = target.id;
    await auditStore.loadDetail(target.type, target.id);
}

function statusClass(status: string): string {
    if (["completed", "succeeded", "approved"].includes(status))
        return "text-emerald-600 dark:text-emerald-400";
    if (
        [
            "failed",
            "ambiguous",
            "timeout",
            "orphaned",
            "rejected",
            "expired",
            "dispatch_unknown",
        ].includes(status)
    )
        return "text-destructive";
    if (
        [
            "waiting_for_approval",
            "awaiting_approval",
            "pending",
            "running",
            "streaming",
            "dispatching",
            "cancelling",
            "partial",
            "interrupted",
            "unknown",
            "queued",
            "accepted",
            "active",
            "cancelled",
        ].includes(status)
    )
        return "text-amber-600 dark:text-amber-400";
    return "text-muted-foreground";
}

function formatTime(value?: string | null): string {
    if (!value) return t("settings.auditNotAvailable");
    return new Date(value).toLocaleString();
}

function formatDuration(value?: number | null): string {
    return value === null || value === undefined ? t("settings.auditNotAvailable") : `${value}ms`;
}

async function applyFilter() {
    selectedEntryId.value = null;
    auditStore.clearDetail();
    await loadEntries();
}

async function changeType() {
    if (statusFilter.value && !allStatuses.value.includes(statusFilter.value)) {
        statusFilter.value = "";
    }
    await applyFilter();
}

async function changePage(delta: number) {
    const next = auditStore.page + delta;
    if (next < 0 || next >= auditStore.totalPages) return;
    await loadEntries(next);
}

onMounted(() => {
    void loadEntries();
});
</script>

<template>
    <BackToChatButton />
    <SettingsNav />
    <main class="mx-auto max-w-5xl px-4 py-6">
        <header class="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div>
                <p class="mb-1 text-xs uppercase tracking-[0.18em] text-muted-foreground">
                    XH / Audit
                </p>
                <h1
                    data-testid="settings-audit-heading"
                    class="text-xl font-semibold tracking-tight"
                >
                    {{ t("settings.auditTitle") }}
                </h1>
                <p class="mt-1 text-sm text-muted-foreground">{{ t("settings.auditDesc") }}</p>
            </div>
            <div class="flex flex-wrap items-center gap-3 text-sm">
                <label class="flex items-center gap-2">
                    <span class="text-muted-foreground">{{ t("settings.auditKind") }}</span>
                    <select
                        v-model="typeFilter"
                        data-testid="settings-audit-type"
                        class="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                        @change="changeType"
                    >
                        <option value="">{{ t("settings.auditAllTypes") }}</option>
                        <option
                            v-for="option in typeOptions"
                            :key="option.value"
                            :value="option.value"
                        >
                            {{ t(option.label) }}
                        </option>
                    </select>
                </label>
                <label class="flex items-center gap-2">
                    <span class="text-muted-foreground">{{ t("settings.auditStatus") }}</span>
                    <select
                        v-model="statusFilter"
                        data-testid="settings-audit-status"
                        class="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                        @change="applyFilter"
                    >
                        <option value="">{{ t("settings.auditAllStatuses") }}</option>
                        <option v-for="status in allStatuses" :key="status" :value="status">
                            {{ statusLabel(status) }}
                        </option>
                    </select>
                </label>
            </div>
        </header>

        <div
            v-if="auditStore.error"
            class="mb-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
        >
            {{ auditStore.error }}
        </div>

        <div class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
            <section class="min-w-0 rounded-lg border border-border bg-card">
                <div class="flex items-center justify-between border-b border-border px-4 py-3">
                    <h2 class="text-sm font-medium">{{ t("settings.auditOperations") }}</h2>
                    <span class="text-xs text-muted-foreground">{{
                        auditStore.totalElements
                    }}</span>
                </div>
                <div v-if="auditStore.loading" class="p-4 text-sm text-muted-foreground">
                    {{ t("common.loading") }}
                </div>
                <div
                    v-else-if="auditStore.entries.length === 0"
                    data-testid="settings-audit-empty"
                    class="p-8 text-center text-sm text-muted-foreground"
                >
                    {{ t("settings.auditEmpty") }}
                </div>
                <ul v-else class="divide-y divide-border">
                    <li v-for="auditEntry in auditStore.entries" :key="auditEntry.id">
                        <button
                            type="button"
                            class="w-full px-4 py-3 text-left transition-colors hover:bg-muted/50"
                            :class="selectedEntryId === auditEntry.id ? 'bg-muted/60' : ''"
                            :data-testid="`settings-audit-entry-${auditEntry.id}`"
                            @click="selectEntry(auditEntry)"
                        >
                            <div class="flex items-start justify-between gap-3">
                                <span class="min-w-0 truncate text-sm font-medium">{{
                                    auditEntry.summary || auditEntry.type
                                }}</span>
                                <span
                                    class="shrink-0 text-xs font-medium"
                                    :class="statusClass(auditEntry.status)"
                                >
                                    {{ auditEntry.status }}
                                </span>
                            </div>
                            <div
                                class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground"
                            >
                                <span>{{ typeLabel(auditEntry.type) }}</span>
                                <span>{{ auditEntry.source }}</span>
                                <span>{{ formatTime(auditEntry.createdAt) }}</span>
                            </div>
                        </button>
                    </li>
                </ul>
                <footer
                    class="flex items-center justify-between border-t border-border px-4 py-2 text-xs text-muted-foreground"
                >
                    <button
                        type="button"
                        :disabled="auditStore.page === 0"
                        class="rounded px-2 py-1 hover:bg-muted disabled:opacity-40"
                        @click="changePage(-1)"
                    >
                        {{ t("settings.auditPrevious") }}
                    </button>
                    <span
                        >{{ auditStore.page + 1 }} / {{ Math.max(auditStore.totalPages, 1) }}</span
                    >
                    <button
                        type="button"
                        :disabled="auditStore.page + 1 >= auditStore.totalPages"
                        class="rounded px-2 py-1 hover:bg-muted disabled:opacity-40"
                        @click="changePage(1)"
                    >
                        {{ t("settings.auditNext") }}
                    </button>
                </footer>
            </section>

            <section class="min-w-0 rounded-lg border border-border bg-card">
                <div class="border-b border-border px-4 py-3">
                    <h2 class="text-sm font-medium">{{ t("settings.auditTrace") }}</h2>
                </div>
                <div v-if="auditStore.detailLoading" class="p-4 text-sm text-muted-foreground">
                    {{ t("common.loading") }}
                </div>
                <div
                    v-else-if="!detail || !entry"
                    data-testid="settings-audit-no-selection"
                    class="p-8 text-center text-sm text-muted-foreground"
                >
                    {{ t("settings.auditSelectOperation") }}
                </div>
                <div v-else class="space-y-5 p-4">
                    <div class="grid grid-cols-2 gap-3 text-sm">
                        <div>
                            <dt class="text-xs text-muted-foreground">
                                {{ t("settings.auditStatus") }}
                            </dt>
                            <dd class="mt-1 font-medium" :class="statusClass(entry.status)">
                                {{ entry.status }}
                                <span
                                    v-if="entry.errorCode"
                                    data-testid="settings-audit-error-code"
                                    class="ml-1 font-mono text-xs"
                                    >{{ entry.errorCode }}</span
                                >
                            </dd>
                        </div>
                        <div v-if="entry.createdAt">
                            <dt class="text-xs text-muted-foreground">
                                {{ t("settings.auditCreated") }}
                            </dt>
                            <dd class="mt-1">{{ formatTime(entry.createdAt) }}</dd>
                        </div>
                        <div v-if="entry.startedAt">
                            <dt class="text-xs text-muted-foreground">
                                {{ t("settings.auditStarted") }}
                            </dt>
                            <dd class="mt-1">{{ formatTime(entry.startedAt) }}</dd>
                        </div>
                        <div>
                            <dt class="text-xs text-muted-foreground">
                                {{ t("settings.auditFinished") }}
                            </dt>
                            <dd class="mt-1">{{ formatTime(entry.finishedAt) }}</dd>
                        </div>
                        <div>
                            <dt class="text-xs text-muted-foreground">
                                {{ t("settings.auditKind") }}
                            </dt>
                            <dd class="mt-1">{{ typeLabel(entry.type) }}</dd>
                        </div>
                        <div class="col-span-2">
                            <dt class="text-xs text-muted-foreground">
                                {{ t("settings.auditRun") }}
                            </dt>
                            <dd class="mt-1 break-all font-mono text-xs" :title="entry.runId || ''">
                                {{ entry.runId || t("settings.auditNotAvailable") }}
                            </dd>
                        </div>
                    </div>

                    <div>
                        <h3
                            class="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground"
                        >
                            {{ t("settings.auditItems") }}
                        </h3>
                        <div
                            v-if="!entryToolName(entry) && !isPolicyCapable(entry)"
                            class="text-sm text-muted-foreground"
                        >
                            {{ t("settings.auditNoItems") }}
                        </div>
                        <ul v-else data-testid="settings-audit-items" class="space-y-2">
                            <li
                                :data-testid="`settings-audit-item-${entry.id}`"
                                class="rounded-md border border-border/70 px-3 py-2"
                            >
                                <div class="flex items-center justify-between gap-3 text-sm">
                                    <span>{{ entryToolName(entry) || typeLabel(entry.type) }}</span>
                                    <span :class="statusClass(entry.status)">{{
                                        entry.status
                                    }}</span>
                                </div>
                                <div
                                    class="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground"
                                >
                                    <span>{{ entry.source }}</span>
                                    <span v-if="entry.approvalRequestId">{{
                                        t("settings.auditApprovalLinked")
                                    }}</span>
                                    <span v-if="entry.cancelReason">{{ entry.cancelReason }}</span>
                                </div>

                                <div
                                    v-if="entry.policy"
                                    :data-testid="policyTestId(entry)"
                                    class="mt-2 rounded-md border border-border/70 bg-muted/30 px-2.5 py-2 text-xs"
                                >
                                    <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                                        <span class="font-medium">{{
                                            t("settings.auditPolicy")
                                        }}</span>
                                        <span
                                            :data-testid="`${policyTestId(entry)}-effect`"
                                            class="rounded-full border px-2 py-0.5 font-medium"
                                            :class="effectClass(entry.policy.effect)"
                                        >
                                            {{ t(effectLabels[entry.policy.effect]) }}
                                        </span>
                                        <span
                                            v-if="entry.policy.reused === true"
                                            :data-testid="`${policyTestId(entry)}-reused`"
                                            class="inline-flex items-center gap-1 rounded-full border border-sky-600/50 bg-sky-500/15 px-2 py-0.5 font-medium"
                                        >
                                            <Repeat2
                                                class="h-3.5 w-3.5 shrink-0"
                                                aria-hidden="true"
                                            />
                                            {{ t("settings.auditPolicyReused") }}
                                        </span>
                                        <span
                                            v-if="entry.toolCallId"
                                            class="font-mono text-muted-foreground"
                                            :title="entry.toolCallId"
                                        >
                                            {{ t("settings.auditPolicyToolCallId") }}:
                                            {{ entry.toolCallId }}
                                        </span>
                                    </div>
                                    <dl class="mt-1.5 grid gap-x-4 gap-y-1 sm:grid-cols-2">
                                        <div class="flex min-w-0 gap-1.5">
                                            <dt class="shrink-0 text-muted-foreground">
                                                {{ t("chat.approvalEvidenceMatchedRule") }}
                                            </dt>
                                            <dd
                                                :data-testid="`${policyTestId(entry)}-matched-rule`"
                                                class="min-w-0 break-all font-mono"
                                            >
                                                {{
                                                    entry.policy.matchedRule ??
                                                    t("chat.approvalNoMatchedRule")
                                                }}
                                            </dd>
                                        </div>
                                        <div class="flex min-w-0 gap-1.5">
                                            <dt class="shrink-0 text-muted-foreground">
                                                {{ t("chat.approvalEvidenceSourceLayer") }}
                                            </dt>
                                            <dd
                                                :data-testid="`${policyTestId(entry)}-source-layer`"
                                            >
                                                {{ layerLabel(entry.policy.sourceLayer) }}
                                            </dd>
                                        </div>
                                        <div class="flex min-w-0 gap-1.5">
                                            <dt class="shrink-0 text-muted-foreground">
                                                {{ t("chat.approvalEvidenceMode") }}
                                            </dt>
                                            <dd :data-testid="`${policyTestId(entry)}-mode`">
                                                {{ modeLabel(entry.policy.mode) }}
                                            </dd>
                                        </div>
                                    </dl>
                                    <p
                                        v-if="entry.policy.allowedBy"
                                        :data-testid="`${policyTestId(entry)}-allowed-by`"
                                        class="mt-1.5 flex flex-wrap items-center gap-x-1.5 rounded border border-amber-600/50 bg-amber-500/15 px-2 py-1 font-medium"
                                    >
                                        <TriangleAlert
                                            class="h-3.5 w-3.5 shrink-0"
                                            aria-hidden="true"
                                        />
                                        <span>{{ allowedByLabel(entry.policy.allowedBy) }}</span>
                                        <code class="font-mono">{{ entry.policy.allowedBy }}</code>
                                    </p>
                                    <details class="mt-1.5">
                                        <summary
                                            class="cursor-pointer text-muted-foreground hover:text-foreground"
                                        >
                                            {{ t("settings.auditPolicyDetail") }}
                                        </summary>
                                        <dl class="mt-1 space-y-1">
                                            <div class="flex min-w-0 gap-1.5">
                                                <dt class="shrink-0 text-muted-foreground">
                                                    {{ t("chat.approvalEvidenceReason") }}
                                                </dt>
                                                <dd
                                                    :data-testid="`${policyTestId(entry)}-reason`"
                                                    class="min-w-0 whitespace-pre-wrap break-words"
                                                >
                                                    {{ entry.policy.reason }}
                                                </dd>
                                            </div>
                                            <div class="flex min-w-0 gap-1.5">
                                                <dt class="shrink-0 text-muted-foreground">
                                                    {{ t("chat.approvalEvidenceActionClass") }}
                                                </dt>
                                                <dd
                                                    :data-testid="`${policyTestId(entry)}-action-class`"
                                                    class="min-w-0 break-all font-mono"
                                                >
                                                    {{ entry.policy.actionClass }}
                                                </dd>
                                            </div>
                                            <div class="flex min-w-0 gap-1.5">
                                                <dt class="shrink-0 text-muted-foreground">
                                                    {{ t("chat.approvalEvidenceShape") }}
                                                </dt>
                                                <dd :data-testid="`${policyTestId(entry)}-shape`">
                                                    {{ t(shapeLabels[entry.policy.shape]) }}
                                                </dd>
                                            </div>
                                        </dl>
                                    </details>
                                </div>
                                <p
                                    v-else-if="isPolicyCapable(entry)"
                                    :data-testid="`settings-audit-policy-absent-${entry.id}`"
                                    class="mt-2 text-xs text-muted-foreground"
                                >
                                    {{ t("settings.auditPolicyAbsent") }}
                                </p>
                            </li>
                        </ul>
                    </div>

                    <div v-if="detail.attempts.length > 0">
                        <h3
                            class="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground"
                        >
                            {{ t("settings.auditAttempts") }}
                        </h3>
                        <ul class="space-y-2">
                            <li
                                v-for="attempt in detail.attempts"
                                :key="attempt.id"
                                class="flex items-center justify-between gap-3 border-l-2 border-border pl-3 text-sm"
                            >
                                <span
                                    ><span class="font-medium">{{ attempt.stage }}</span>
                                    <span class="text-xs text-muted-foreground"
                                        >{{ attempt.module }} #{{ attempt.retryNo }}</span
                                    ></span
                                >
                                <span class="shrink-0 text-xs" :class="statusClass(attempt.status)"
                                    >{{ attempt.status }} ·
                                    {{ formatDuration(attempt.durationMs) }}</span
                                >
                            </li>
                        </ul>
                    </div>

                    <div data-testid="settings-audit-events">
                        <h3
                            class="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground"
                        >
                            {{ t("settings.auditEvents") }}
                        </h3>
                        <div
                            v-if="detail.timeline.length === 0"
                            class="text-sm text-muted-foreground"
                        >
                            {{ t("settings.auditNoEvents") }}
                        </div>
                        <ul v-else class="space-y-2">
                            <li
                                v-for="event in detail.timeline"
                                :key="event.sequence"
                                class="flex items-center justify-between gap-3 border-l-2 border-border pl-3 text-sm"
                            >
                                <span class="font-mono text-xs">{{ event.eventType }}</span>
                                <span class="shrink-0 text-xs text-muted-foreground"
                                    >{{ eventTransition(event)
                                    }}<template v-if="eventExtra(event)">
                                        · {{ eventExtra(event) }}</template
                                    ></span
                                >
                            </li>
                        </ul>
                    </div>
                </div>
            </section>
        </div>
    </main>
</template>
