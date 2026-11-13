<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { Diagnostic, ToolCall } from "../../../../types";
import { ApiError, api } from "../../../../composables/api";
import { toolRefusalCopyKey } from "../../../../lib/errorMessages";
import { ChevronDown } from "@lucide/vue";
import ProcessRow from "./ProcessRow.vue";
import type { ProcessRowActor } from "./ProcessRow.vue";
import ToolApprovalActions from "./ToolApprovalActions.vue";
import { formatToolDuration, toolStatusIcon, toolStatusTone } from "./toolCallStatus";

const props = defineProps<{
    toolCall: ToolCall;
    /** PLAN-0659 T1.2：产出主体徽标；由消息按「线程是否混主体」决定传不传。 */
    actor?: ProcessRowActor;
}>();

const emit = defineEmits<{
    approve: [id: string];
    reject: [id: string];
}>();

const { t } = useI18n();

const VISIBLE_DIAGNOSTICS = 3;

const diagnostics = computed<Diagnostic[]>(() => props.toolCall.diagnostics?.items ?? []);
const hasDiagnostics = computed(() => diagnostics.value.length > 0);
const diagnosticsTotal = computed(() =>
    Math.max(props.toolCall.diagnostics?.total ?? 0, diagnostics.value.length),
);
const hiddenDiagnosticsCount = computed(() =>
    Math.max(diagnostics.value.length - VISIBLE_DIAGNOSTICS, 0),
);

// Card body: collapsed by default; a tool result carrying diagnostics opens
// the card so failures are visible without a click (PLAN-0342 decision #7).
const expanded = ref(false);
// Raw Arguments/Result fallback has its own toggle and stays collapsed when
// the structured diagnostics block is present.
const rawExpanded = ref(false),
    diagnosticsExpanded = ref(false);

watch(
    hasDiagnostics,
    (present) => {
        if (present) expanded.value = true;
    },
    { immediate: true },
);

const visibleDiagnostics = computed(() =>
    diagnosticsExpanded.value ? diagnostics.value : diagnostics.value.slice(0, VISIBLE_DIAGNOSTICS),
);

function formatLocation(item: Diagnostic): string {
    if (!item.file) return "";
    if (item.line === null) return item.file;
    if (item.column === null) return `${item.file}:${item.line}`;
    return `${item.file}:${item.line}:${item.column}`;
}

function severityClass(severity: Diagnostic["severity"]): string {
    return severity === "error" ? "text-destructive" : "text-muted-foreground";
}

function diagnosticKey(item: Diagnostic, index: number): string {
    return `${item.file ?? ""}:${item.line ?? ""}:${item.column ?? ""}:${index}`;
}

/**
 * 折叠行摘要：参数里最能说明"这次调用在干什么"的字段（命令/路径/提示词…），否则退回原文。
 * 只做展示，不改请求体。
 */
const argumentsSummary = computed(() => {
    const raw = typeof props.toolCall.arguments === "string" ? props.toolCall.arguments : "";
    if (!raw) return "";
    try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const keys = ["command", "path", "prompt", "query", "url", "pattern", "file", "model"];
        for (const key of keys) {
            const value = parsed[key];
            if (typeof value === "string" && value.trim()) {
                return value.trim().split("\n")[0]!.slice(0, 60);
            }
        }
        const firstString = Object.values(parsed).find(
            (value): value is string => typeof value === "string" && Boolean(value.trim()),
        );
        if (firstString) return firstString.trim().split("\n")[0]!.slice(0, 60);
    } catch {
        // 参数不是 JSON（旧快照/截断）：退回原文首行。
    }
    return raw.trim().split("\n")[0]!.slice(0, 60);
});

const duration = computed(() =>
    formatToolDuration(props.toolCall.startedAt, props.toolCall.completedAt),
);

/**
 * PLAN-0649: refusal presentation.
 *
 * A refused call keeps its withheld body on every surface, so the refusal code is
 * the only reason the user can ever see — the card must therefore stop presenting
 * it as a completed call. Refusals are judged by `refusalCode`, **not** by `status`
 * (`spec/tool-refusal-observability.md` §1): the durable status of a non-CP tool
 * error can still be `completed`.
 */
const refusalCode = computed(() => props.toolCall.refusalCode ?? null);
const refusalReason = computed(() => {
    const code = refusalCode.value;
    if (!code) return "";
    const key = toolRefusalCopyKey(code);
    // B5 ruling: an unmapped code still renders the generic line plus the raw code.
    return key ? t(key) : t("chat.toolRefusedGeneric");
});
const statusLabel = computed(() =>
    refusalCode.value
        ? t("chat.toolStatus.refused")
        : t(`chat.toolStatus.${props.toolCall.status}`),
);
// A refusal reads as a failure even when the wire status is still `completed`
// (older Agent, or a durable snapshot written before M2 lands).
const statusIcon = computed(() =>
    refusalCode.value ? toolStatusIcon("failed") : toolStatusIcon(props.toolCall.status),
);
const statusTone = computed(() =>
    refusalCode.value ? toolStatusTone("failed") : toolStatusTone(props.toolCall.status),
);

// PLAN-0344：durable job 卡片——档案（jobSummary）给状态与 jobId，
// 输出按字节游标从 CP 续看端点分页拉取（真源仍是容器文件）。
const JOB_TOOL_NAMES = [
    "start_background_process",
    "get_background_process",
    "cancel_background_process",
];
const isJobCard = computed(
    () => JOB_TOOL_NAMES.includes(props.toolCall.name) || !!props.toolCall.jobSummary,
);
const jobSummary = computed(() => props.toolCall.jobSummary),
    jobOutput = ref(""),
    jobNextOffset = ref(0);
const jobSizeBytes = ref(0),
    jobTruncated = ref(false),
    jobLoaded = ref(false),
    jobLoading = ref(false);
const jobError = ref<string | null>(null);
const jobHasMore = computed(() => jobLoaded.value && jobNextOffset.value < jobSizeBytes.value);

// PLAN-0366 T2.2：单 job 取消（**Workspace access**——按控制器实际行为，
// 非 owner-only；二次确认；pending 防重复提交；失败不改卡片状态、可重试）。
// PLAN-0465 T2.1：canonical 路径 /workspaces/{workspaceId}/jobs/{jobId}/cancel。
const cancelConfirming = ref(false),
    cancelPending = ref(false),
    cancelError = ref<string | null>(null);
const cancelOutcome = ref<"cancelled" | "orphaned" | null>(null);
const displayJobStatus = computed(() => cancelOutcome.value ?? jobSummary.value?.status);
const canCancelJob = computed(
    () =>
        isJobCard.value &&
        jobSummary.value?.status === "running" &&
        !!jobSummary.value?.jobId &&
        !!jobSummary.value?.workspaceId &&
        !cancelOutcome.value,
);

async function submitJobCancel() {
    const workspaceId = jobSummary.value?.workspaceId,
        jobId = jobSummary.value?.jobId;
    if (!workspaceId || !jobId || cancelPending.value) return;
    cancelPending.value = true;
    cancelError.value = null;
    try {
        const result = await api.cancelJob(workspaceId, jobId);
        cancelOutcome.value = result.status === "orphaned" ? "orphaned" : "cancelled";
        cancelConfirming.value = false;
    } catch (err) {
        // 失败不改卡片状态；回到可重试入口（与预览稿一致）
        cancelConfirming.value = false;
        if (err instanceof ApiError) {
            cancelError.value =
                err.problem.code === "JOB_CANCEL_UNCONFIRMED"
                    ? t("chat.jobCancelUnconfirmed")
                    : err.problem.code === "RUNTIME_UNAVAILABLE"
                      ? t("chat.jobCancelUnavailable")
                      : (err.problem.title ?? err.message);
        } else {
            cancelError.value = String(err);
        }
    } finally {
        cancelPending.value = false;
    }
}

function jobStatusClass(status?: string): string {
    if (status === "running") {
        return "bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300";
    }
    if (status === "failed") {
        return "bg-destructive/10 text-destructive";
    }
    return "bg-muted text-muted-foreground";
}

async function loadJobOutput(reset: boolean) {
    const workspaceId = jobSummary.value?.workspaceId,
        jobId = jobSummary.value?.jobId;
    if (!workspaceId || !jobId || jobLoading.value) return;
    jobLoading.value = true;
    jobError.value = null;
    try {
        const chunk = await api.getJobOutput(workspaceId, jobId, {
            stream: "stdout",
            offset: reset ? 0 : jobNextOffset.value,
            limit: 64 * 1024,
        });
        jobOutput.value = reset ? chunk.data : jobOutput.value + chunk.data;
        jobNextOffset.value = chunk.nextOffset;
        jobSizeBytes.value = chunk.sizeBytes;
        jobTruncated.value = chunk.truncated;
        jobLoaded.value = true;
    } catch (err) {
        if (err instanceof ApiError) {
            jobError.value =
                err.problem.code === "JOB_OUTPUT_LOST"
                    ? t("chat.jobOutputLost")
                    : err.problem.code === "JOB_OUTPUT_EXPIRED"
                      ? t("chat.jobOutputExpired")
                      : err.problem.code === "RUNTIME_UNAVAILABLE"
                        ? t("chat.jobOutputUnavailable")
                        : (err.problem.title ?? err.message);
        } else {
            jobError.value = String(err);
        }
    } finally {
        jobLoading.value = false;
    }
}
</script>

<template>
    <!--
        2026-11-04 用户裁定（DSH 式过程渲染）：工具调用与思考/推理/refusal 同一条单行可折叠
        chip。外壳替换、**展开体原样搬运**（refusal/diagnostics/job/raw 一律不动）；既有 testid
        全部保留（`tool-card-toggle` 仍挂可点折叠行，waiting-on 两枚在常驻 extra 行）。
    -->
    <ProcessRow
        kind="tool"
        :icon="statusIcon"
        :tone="statusTone"
        :label="toolCall.name"
        :summary="argumentsSummary"
        :meta="duration ?? undefined"
        :status="statusLabel"
        :failed="Boolean(refusalCode) || toolCall.status === 'failed'"
        :actor="actor"
        expandable
        testid="tool-card"
        toggle-testid="tool-card-toggle"
        v-model:expanded="expanded"
    >
        <template #extra>
            <div
                v-if="toolCall.waitingOn"
                class="flex min-w-0 items-center justify-between gap-3 border-t border-border/60 px-2 py-1 text-xs text-muted-foreground"
                role="status"
                data-testid="tool-call-waiting-on"
            >
                <span class="truncate">
                    {{ t("chat.waitingOnChild") }}:
                    {{ toolCall.waitingOn.name ?? t("chat.derivedStateUnnamedChild") }}
                </span>
                <span class="shrink-0" data-testid="tool-call-waiting-status">
                    {{ t(`chat.derivedStateStatus.${toolCall.waitingOn.status}`) }}
                </span>
            </div>
        </template>

        <div class="space-y-2">
            <!--
                PLAN-0649: the refused call never ran, and its body stays withheld,
                so this block is the only place the reason can appear. It sits
                above diagnostics/raw output on purpose (reason before payload).
            -->
            <div
                v-if="refusalCode"
                class="rounded border border-destructive/40 bg-destructive/5 p-2"
                data-testid="tool-refusal"
            >
                <div class="font-medium text-destructive">{{ t("chat.toolRefusedTitle") }}</div>
                <p class="mt-0.5 text-foreground">{{ refusalReason }}</p>
                <p class="mt-0.5 text-muted-foreground">{{ t("chat.toolRefusedHint") }}</p>
                <p class="mt-0.5 text-muted-foreground">
                    {{ t("chat.toolRefusedCodeLabel") }}
                    <span class="font-mono" data-testid="tool-refusal-code">{{ refusalCode }}</span>
                </p>
            </div>
            <div v-if="hasDiagnostics" class="space-y-1.5" data-testid="tool-diagnostics">
                <div class="flex items-baseline justify-between gap-2">
                    <span class="font-medium text-foreground">{{
                        t("chat.toolDiagnosticsTitle")
                    }}</span>
                    <span class="text-muted-foreground">
                        {{
                            t("chat.toolDiagnosticsSummary", {
                                total: diagnosticsTotal,
                                shown: diagnostics.length,
                            })
                        }}
                    </span>
                </div>
                <ul class="space-y-1">
                    <li
                        v-for="(item, index) in visibleDiagnostics"
                        :key="diagnosticKey(item, index)"
                        class="flex items-baseline gap-1 font-mono"
                        :data-testid="`diagnostic-item-${index}`"
                    >
                        <span class="shrink-0 font-medium" :class="severityClass(item.severity)">{{
                            item.severity
                        }}</span>
                        <span v-if="formatLocation(item)" class="shrink-0 text-muted-foreground">{{
                            formatLocation(item)
                        }}</span>
                        <span
                            class="min-w-0 flex-1 truncate text-foreground"
                            :title="item.message"
                            >{{ item.message }}</span
                        >
                    </li>
                </ul>
                <button
                    v-if="hiddenDiagnosticsCount > 0 && !diagnosticsExpanded"
                    type="button"
                    class="rounded border px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
                    :aria-expanded="diagnosticsExpanded"
                    data-testid="diagnostics-more"
                    @click="diagnosticsExpanded = true"
                >
                    {{ t("chat.toolDiagnosticsMore", { count: hiddenDiagnosticsCount }) }}
                </button>
            </div>

            <div v-if="isJobCard" class="space-y-1.5" data-testid="job-output-panel">
                <div class="flex items-center gap-2">
                    <span class="font-medium text-foreground">{{ t("chat.jobOutputTitle") }}</span>
                    <span
                        v-if="displayJobStatus"
                        class="rounded px-1.5 py-0.5 text-xs"
                        :class="jobStatusClass(displayJobStatus)"
                        data-testid="job-status"
                        >{{ t(`chat.jobStatus.${displayJobStatus}`) }}</span
                    >
                    <button
                        type="button"
                        class="ml-auto rounded border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                        :disabled="jobLoading"
                        data-testid="job-output-load"
                        @click="loadJobOutput(true)"
                    >
                        {{ jobLoaded ? t("chat.jobOutputReload") : t("chat.jobOutputLoad") }}
                    </button>
                </div>
                <p
                    v-if="jobSummary?.jobId"
                    class="truncate font-mono text-muted-foreground"
                    :title="jobSummary.jobId"
                >
                    {{ jobSummary.jobId }}
                </p>
                <pre
                    v-if="jobLoaded"
                    data-testid="job-output-data"
                    class="max-h-64 overflow-auto rounded bg-muted/30 p-2 font-mono whitespace-pre-wrap break-all"
                    >{{ jobOutput || t("chat.jobOutputEmpty") }}</pre>
                <p v-if="jobTruncated" class="text-muted-foreground">
                    {{ t("chat.jobOutputTruncated") }}
                </p>
                <button
                    v-if="jobHasMore"
                    type="button"
                    class="rounded border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                    :disabled="jobLoading"
                    data-testid="job-output-more"
                    @click="loadJobOutput(false)"
                >
                    {{ t("chat.jobOutputMore") }}
                </button>
                <p v-if="jobError" class="text-destructive" data-testid="job-output-error">
                    {{ jobError }}
                </p>

                <div
                    class="flex flex-wrap items-center gap-2 border-t pt-2"
                    data-testid="job-cancel-row"
                >
                    <template v-if="cancelOutcome">
                        <span
                            class="text-green-600 dark:text-green-400"
                            data-testid="job-cancel-success"
                        >
                            {{
                                cancelOutcome === "orphaned"
                                    ? t("chat.jobCancelOrphaned")
                                    : t("chat.jobCancelDone")
                            }}
                        </span>
                    </template>
                    <template v-else-if="cancelPending">
                        <span class="text-muted-foreground" data-testid="job-cancel-pending">{{
                            t("chat.jobCancelPending")
                        }}</span>
                        <button
                            type="button"
                            class="ml-auto rounded border px-2 py-1 text-xs disabled:opacity-50"
                            disabled
                            data-testid="job-cancel-button"
                        >
                            {{ t("chat.jobCancelButton") }}
                        </button>
                    </template>
                    <template v-else-if="cancelConfirming">
                        <span class="text-muted-foreground" data-testid="job-cancel-confirm-hint">
                            {{ t("chat.jobCancelConfirmHint", { jobId: jobSummary?.jobId ?? "" }) }}
                        </span>
                        <span class="ml-auto flex gap-2">
                            <button
                                type="button"
                                class="rounded border border-destructive/50 px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
                                data-testid="job-cancel-confirm"
                                @click="submitJobCancel"
                            >
                                {{ t("chat.jobCancelConfirm") }}
                            </button>
                            <button
                                type="button"
                                class="rounded border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                                data-testid="job-cancel-back"
                                @click="cancelConfirming = false"
                            >
                                {{ t("chat.jobCancelBack") }}
                            </button>
                        </span>
                    </template>
                    <template v-else>
                        <span class="text-muted-foreground">{{ t("chat.jobCancelHint") }}</span>
                        <button
                            type="button"
                            class="ml-auto rounded border border-destructive/50 px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
                            :disabled="!canCancelJob"
                            data-testid="job-cancel-button"
                            @click="cancelConfirming = true"
                        >
                            {{ t("chat.jobCancelButton") }}
                        </button>
                    </template>
                    <p
                        v-if="cancelError"
                        class="w-full text-destructive"
                        data-testid="job-cancel-error"
                    >
                        {{ cancelError }}
                    </p>
                </div>
            </div>

            <div v-if="hasDiagnostics">
                <button
                    type="button"
                    class="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    :aria-expanded="rawExpanded"
                    data-testid="raw-output-toggle"
                    @click="rawExpanded = !rawExpanded"
                >
                    <ChevronDown
                        class="size-3 transition-transform"
                        :class="rawExpanded ? 'rotate-180' : ''"
                        aria-hidden="true"
                    />
                    {{ t("chat.toolRawOutput") }}
                </button>
            </div>

            <div v-if="!hasDiagnostics || rawExpanded" class="space-y-2">
                <div class="font-mono text-muted-foreground">
                    <div class="mb-1 font-medium text-foreground">Arguments</div>
                    <pre
                        data-testid="raw-arguments"
                        class="rounded bg-muted/30 p-2 whitespace-pre-wrap break-all"
                        >{{
                            typeof toolCall.arguments === "string"
                                ? toolCall.arguments
                                : JSON.stringify(toolCall.arguments, null, 2)
                        }}</pre>
                </div>
                <div v-if="toolCall.result" class="font-mono">
                    <div class="mb-1 font-medium text-foreground">Result</div>
                    <pre
                        data-testid="raw-result"
                        class="rounded bg-muted/30 p-2 whitespace-pre-wrap break-all"
                        >{{
                            typeof toolCall.result === "string"
                                ? toolCall.result.substring(0, 2000)
                                : JSON.stringify(toolCall.result, null, 2)
                        }}</pre>
                    <p v-if="toolCall.result.length > 2000" class="mt-1 text-muted-foreground">
                        Output truncated ({{ toolCall.result.length }} chars total)
                    </p>
                </div>
                <div v-if="toolCall.error" class="font-mono">
                    <div class="mb-1 font-medium text-destructive">Error</div>
                    <pre
                        class="rounded bg-destructive/10 p-2 whitespace-pre-wrap break-all text-destructive"
                        >{{ toolCall.error }}</pre>
                </div>
            </div>

            <ToolApprovalActions
                v-if="toolCall.status === 'pending'"
                :tool-call-id="toolCall.id"
                @approve="emit('approve', $event)"
                @reject="emit('reject', $event)"
            />
        </div>
    </ProcessRow>
</template>
