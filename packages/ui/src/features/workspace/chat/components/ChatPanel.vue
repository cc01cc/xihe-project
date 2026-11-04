<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { useChatStore } from "../stores/chat.ts";
import { useAgentStore } from "../../../../stores/agent";
import { useAuthStore } from "../../../../stores/auth";
import { useCheckpointStore } from "../../../../stores/checkpoint";
import { useConfigStore } from "../../../../stores/config";
import { useSessionStore } from "../../../../stores/session";
import {
    ApiError,
    api,
    type ApiFollowUpQueueSnapshot,
    type WorkspaceAgentBinding,
} from "../../../../composables/api";
import { parseRawToParts } from "../composables/useStreamParser.ts";
import { mergeHistoryToolCalls } from "./jobSummaryToolCalls.ts";
import { logger } from "../../../../lib/logger";
import type {
    ApprovalDecisionEnvelope,
    AttachmentFile,
    CheckpointResult,
    Message,
    SessionDerivedStateResponse,
    SessionRunSummary,
    ToolCallWaitingOn,
} from "../../../../types";
import MessageList from "./MessageList.vue";
import InputArea from "./InputArea.vue";
import SSEStream from "./SSEStream.vue";
import ApprovalModal from "./ApprovalModal.vue";
import SessionSettingsPanel from "./SessionSettingsPanel.vue";
import SessionDerivedStatePanel from "./SessionDerivedStatePanel.vue";
import FollowUpQueuePanel from "./FollowUpQueuePanel.vue";
import GuidancePanel from "./GuidancePanel.vue";
import RevertPreviewDialog from "./RevertPreviewDialog.vue";
import RevertResultDialog from "./RevertResultDialog.vue";
import BaseModal from "../../../../components/shared/BaseModal.vue";
import { useSessionBranches } from "../composables/useSessionBranches";
import {
    ensureProviderBinding,
    type ProviderBindingGuideReason,
} from "../composables/ensureProviderBinding";
import ProviderBindingGuideDialog from "./ProviderBindingGuideDialog.vue";
import { chatErrorToastText } from "../../../../lib/errorMessages";
import { isTerminalRunStatus, runStateLabelKey } from "../runStateView";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { Clock, ShieldAlert } from "@lucide/vue";

const props = withDefaults(
    defineProps<{
        sessionId: string;
        toolMode?: "none" | "workspace";
        /** PLAN-0626 M2: mobile keeps the in-place settings expansion (no dock there). */
        isMobile?: boolean;
    }>(),
    {
        toolMode: "none",
        isMobile: false,
    },
);

const emit = defineEmits<{
    /** PLAN-0626 M2: the chat summary row is the entry to the dock's `context` panel. */
    "open-context-panel": [];
}>();

const { t } = useI18n();
const chatStore = useChatStore(),
    agentStore = useAgentStore(),
    authStore = useAuthStore();
const checkpointStore = useCheckpointStore(),
    configStore = useConfigStore(),
    sessionStore = useSessionStore();
const router = useRouter();

/** C1：守卫拦下时暂存这次发送，「自动绑定」成功后原样重发、关闭弹窗时把草稿还给输入框。 */
const pendingProviderBindingSend = ref<
    [string, AttachmentFile[]?, string?, string?, string[]?] | null
>(null);

/** C1（2026-11-04 用户裁定）：发送前的 provider 绑定守卫 —— 裸会话不静默失败。 */
const providerBindingGuide = ref<{
    reason: ProviderBindingGuideReason;
    detail: string | null;
} | null>(null);

async function guardProviderBinding(id: string): Promise<boolean> {
    const session = sessionStore.sessions.find((item) => item.id === id);
    return ensureProviderBinding({
        hasBinding: Boolean(session?.providerConnectionId),
        bindDefaults: () => api.bindSessionDefaults(id),
        onAutoBound: (bound) => {
            sessionStore.applySessionRecord(bound);
            if (bound.modelProvider && bound.modelName) {
                configStore.setSessionModel(
                    id,
                    bound.modelProvider,
                    bound.modelName,
                    bound.providerConnectionId ?? undefined,
                    bound.connectionRevision ?? undefined,
                );
            }
            const label = [bound.modelProvider, bound.modelName].filter(Boolean).join(" · ");
            toast.success(
                label ? `${t("chat.providerAutoBound")} ${label}` : t("chat.providerAutoBound"),
            );
        },
        onGuide: (reason, detail) => {
            providerBindingGuide.value = { reason, detail: detail ?? null };
        },
        onBlocked: (code, detail) => {
            toast.error(chatErrorToastText(code, detail));
        },
    });
}

async function retryProviderBindingGuide(): Promise<void> {
    providerBindingGuide.value = null;
    const bound = await guardProviderBinding(props.sessionId);
    const pending = pendingProviderBindingSend.value;
    pendingProviderBindingSend.value = null;
    // 绑定成功 ⇒ 把刚才被拦下的消息原样发出去（用户点一次「自动绑定」就能继续）。
    if (bound && pending) await handleSend(...pending);
}

function closeProviderBindingGuide(): void {
    providerBindingGuide.value = null;
    const pending = pendingProviderBindingSend.value;
    pendingProviderBindingSend.value = null;
    // 关闭引导 = 放弃本次发送，把草稿还给输入框，不丢用户写的内容。
    if (pending?.[0]) inputComponent.value?.setDraft?.(pending[0]);
}

function openProviderSettings(): void {
    providerBindingGuide.value = null;
    void router.push({ name: "settings-config" });
}

const suggestions = computed(() =>
    props.toolMode === "workspace"
        ? ["列出文件", "打开 README", "解释选中的文件", "查看工作区环境"]
        : ["今天天气怎么样？", "帮我写一封邮件", "解释一下这个概念", "总结一下这段代码"],
);

const messages = computed(() => chatStore.getMessages(props.sessionId));
const isStreaming = computed(() => chatStore.isStreaming(props.sessionId));
const currentSession = computed(() =>
    sessionStore.sessions.find((session) => session.id === props.sessionId),
);
// PLAN-0626 M2: the branch projection is shared with the dock's `context` panel (N10:
// one resolver per semantic), so the depth-indented labels no longer live here.
const { selectedBranchId, branchOptions, branchLabels, mainBranchId } = useSessionBranches(
    () => props.sessionId,
);
const followUpQueue = ref<ApiFollowUpQueueSnapshot | null>(null),
    followUpQueueError = ref<string | null>(null);
const followUpQueueSubmitting = ref(false),
    followUpQueueContinuing = ref(false);
const followUpQueueBusyItemId = ref<string | null>(null),
    pendingFollowUpKeys = new Map<string, Map<string, string>>();
let followUpQueueRequestId = 0,
    followUpQueueSubmitGeneration = 0,
    followUpQueueActionGeneration = 0;
const followUpQueueMode = computed(
    () =>
        isStreaming.value ||
        (followUpQueue.value?.outstandingCount ?? 0) > 0 ||
        followUpQueue.value?.queueState === "paused",
);
const followUpQueueFull = computed(() =>
    Boolean(
        followUpQueue.value &&
        followUpQueue.value.outstandingCount >= followUpQueue.value.capacityLimit,
    ),
);
const derivedState = ref<SessionDerivedStateResponse | null>(null),
    derivedStateLoading = ref(false);
/**
 * PLAN-0659 T1.1：run 分组的数据源（`GET /chat/sessions/{id}/runs` 摘要）。
 * 只在会话切换与 **run 终态**（0645 的终态刷新点）各拉一次，不做轮询。
 */
const sessionRuns = ref<SessionRunSummary[]>([]);
const derivedStateError = ref(false),
    waitingOnByToolCallId = ref<Record<string, ToolCallWaitingOn>>({});
let derivedStateRequestId = 0,
    waitingOnRequestId = 0;

const renderedMessages = computed(() =>
    messages.value.map((message) => {
        if (!message.toolCalls?.length) return message;
        return {
            ...message,
            toolCalls: message.toolCalls.map((toolCall) => ({
                ...toolCall,
                waitingOn: waitingOnByToolCallId.value[toolCall.id] ?? null,
            })),
        };
    }),
);

const showPrincipalBinding = ref(false),
    principalChoices = ref<WorkspaceAgentBinding[]>([]);
const selectedPrincipalId = ref("");
const pendingSend = ref<{
    content: string;
    attachments?: AttachmentFile[];
    branchId: string;
    /** PLAN-0630 M5b (D30-14)：旁听名单随挂起的发送一起保留，绑定 principal 后继续透传。 */
    cc?: string[];
} | null>(null);
const loadingPrincipalChoices = ref(false),
    creatingBranchForMessageId = ref<string | null>(null);
const pendingBranchKeys = new Map<string, string>();
let messageLoadRequestId = 0;

const pendingApproval = computed(
    () =>
        agentStore.agentState.pendingApprovals.find(
            (approval) =>
                approval.sessionId === props.sessionId &&
                (approval.state === undefined ||
                    approval.state === "pending" ||
                    approval.state === "dispatch_unknown"),
        ) ?? null,
);
const approvalSubmitting = ref(false),
    approvalError = ref<string | null>(null);
const dismissedRequestIds = ref(new Set<string>());
const showApproval = computed(() => {
    const approval = pendingApproval.value;
    if (!approval) return false;
    if (approval.state === "dispatch_unknown") return true;
    return !dismissedRequestIds.value.has(approval.requestId);
});
/**
 * PLAN-0631 M1-C: a decision that can no longer be taken must not keep asking for one.
 *
 * The reopen pill is a shortcut back into the modal; once the approval's Run has reached a
 * terminal state (cancelled/failed/ambiguous/…, see `isTerminalRunStatus`) the decision is
 * moot, so the pill is retired. The check reads the Run's own assistant message — the same
 * local view the transcript renders — and never guesses: an unknown status is not terminal.
 */
const approvalRunIsTerminal = computed(() => {
    const approval = pendingApproval.value;
    if (!approval) return false;
    return messages.value.some(
        (message) =>
            message.role === "assistant" &&
            message.runId === approval.runId &&
            (isTerminalRunStatus(message.runStatus) ||
                isTerminalRunStatus(message.terminalOutcome)),
    );
});
const showReopenPill = computed(() => {
    const approval = pendingApproval.value;
    return (
        approval !== null &&
        !showApproval.value &&
        dismissedRequestIds.value.has(approval.requestId) &&
        !approvalRunIsTerminal.value
    );
});

function handleApprovalDismiss() {
    const approval = pendingApproval.value;
    if (!approval) return;
    dismissedRequestIds.value.add(approval.requestId);
}

function reopenApproval() {
    const approval = pendingApproval.value;
    if (!approval) return;
    dismissedRequestIds.value.delete(approval.requestId);
}

watch(pendingApproval, (approval, previous) => {
    if (previous && (!approval || approval.requestId !== previous.requestId)) {
        dismissedRequestIds.value.delete(previous.requestId);
    }
    if (approval) {
        void refreshFollowUpQueue(props.sessionId);
    }
});
/** Classification authority hint (server still enforces): workspace OWNER / instance ADMIN. */
const canClassifyApproval = computed(() => authStore.canClassifyTools);

async function loadSessionMessages(sessionId: string, requiredMessageIds?: ReadonlySet<string>) {
    const requestId = ++messageLoadRequestId;
    try {
        let branchId = chatStore.getSelectedBranchId(sessionId);
        if (!branchId) {
            await chatStore.loadSessionBranches(sessionId);
            branchId = chatStore.getSelectedBranchId(sessionId);
        }
        if (!branchId) return;
        const rawMessages = await api.getMessages(sessionId, branchId);
        if (
            props.sessionId !== sessionId ||
            requestId !== messageLoadRequestId ||
            chatStore.getSelectedBranchId(sessionId) !== branchId
        )
            return;
        if (!Array.isArray(rawMessages)) return;
        const loadedMessages = rawMessages.map((message) => ({
            id: message.id,
            sessionId: message.sessionId,
            role: message.role.toLowerCase() as Message["role"],
            content: message.content,
            parts:
                message.role.toLowerCase() === "assistant"
                    ? parseRawToParts(message.content)
                    : undefined,
            timestamp: message.createdAt,
            runId: message.runId,
            runStatus: message.runStatus as Message["runStatus"],
            terminalOutcome: message.terminalOutcome as Message["terminalOutcome"],
            errorCode: message.errorCode,
            // PLAN-0492 T3.1: the messages DTO carries the terminal failure text as
            // `errorDetail` (MessageReadService); map it so a history refresh keeps
            // the exhausted-run reason instead of wiping the local error state.
            error: message.errorDetail ?? message.error,
            retryable: message.retryable,
            // PLAN-0344 T1.4 / PLAN-0465 T2.2：刷新后 job 卡片唯一重建源
            //（messages DTO 的 jobSummary ← workspace_jobs 投影）。
            // PLAN-0572：优先用持久化的 toolCalls 快照，并按 toolCallId 与 jobSummary 合并。
            toolCalls: mergeHistoryToolCalls(message.toolCalls, message.jobSummary),
            attachments: message.attachments?.map((attachment) => ({
                id: attachment.fileId,
                fileId: attachment.fileId,
                name: attachment.name,
                type: attachment.type,
                size: attachment.size,
                url: `/api/v1/files/${encodeURIComponent(attachment.fileId)}`,
                state: "done" as const,
            })),
        }));
        if (requiredMessageIds && chatStore.isStreaming(sessionId)) {
            for (const message of loadedMessages) {
                if (!requiredMessageIds.has(message.id)) continue;
                const existing = messages.value.find((current) => current.id === message.id);
                if (existing) Object.assign(existing, message);
                else chatStore.addMessage(sessionId, message);
            }
        }
        chatStore.loadMessages(sessionId, loadedMessages);
        if (derivedState.value?.sessionId === sessionId) {
            void loadWaitingOnProjection(sessionId, derivedState.value.activeChildren);
        }
    } catch (cause) {
        if (cause instanceof ApiError && cause.problem.code === "MESSAGE_NOT_FOUND") return;
        logger.error("Failed to load session messages", cause);
    }
}

// BL-228: 刷新重开（冷启动）时若会话还有在途 run，本页没有它的 SSE —— 终态前历史投影缺
// 在途回复，而 watch(isStreaming) 只管本页发起的 run，列表会永远停在"用户消息"一条
// （goldpath G2-e reload 后 [data-slot=message] 卡 1/2 的根因）。对冷启动做有界追平：
// 只要 listSessionRuns 还有非终态 run，就周期性重拉历史，直到无活动 run 或达到上限。
// loadMessages 在 isStreaming 时早退，不会覆盖本页新发起的 live 流。
async function refreshSessionRuns(sessionId: string): Promise<void> {
    if (!sessionId) return;
    try {
        const response = await api.listSessionRuns(sessionId, { page: 0, size: 100 });
        if (props.sessionId !== sessionId) return;
        sessionRuns.value = response.runs;
    } catch (cause) {
        // 非关键展示数据：失败只记日志，run 头退回 message 自带的 runStatus。
        logger.warn("failed to load session runs", cause);
    }
}

const RUN_CATCHUP_INTERVAL_MS = 1000;
const RUN_CATCHUP_MAX_ATTEMPTS = 30;
const runCatchupTimers = new Map<string, ReturnType<typeof setInterval>>();

function stopRunCatchup(sessionId: string): void {
    const timer = runCatchupTimers.get(sessionId);
    if (timer !== undefined) {
        clearInterval(timer);
        runCatchupTimers.delete(sessionId);
    }
}

function catchUpInFlightRunProjection(sessionId: string): void {
    stopRunCatchup(sessionId);
    let attempts = 0;
    // 首次 tick 只见已终态的会话时不重拉（挂载那次 loadSessionMessages 已是新鲜投影），
    // 避免每次进会话都多打一次 getMessages。
    let sawActiveRun = false;
    const tick = async (): Promise<void> => {
        attempts += 1;
        const exhausted = attempts >= RUN_CATCHUP_MAX_ATTEMPTS;
        try {
            const response = await api.listSessionRuns(sessionId, { page: 0, size: 50 });
            if (props.sessionId !== sessionId) {
                stopRunCatchup(sessionId);
                return;
            }
            const hasActiveRun = response.runs.some((run) => !isTerminalRunStatus(run.status));
            if (hasActiveRun) sawActiveRun = true;
            // PLAN-0659 T1.1：run 摘要（run 头的状态/耗时）由**这个**唯一的会话激活期消费者
            // 落盘；会话切换时不再另发一次 `listSessionRuns`（同一事件两个消费者会让
            // BL-228 的调用次数语义漂移，也是白打一次请求）。
            sessionRuns.value = response.runs;
            if (sawActiveRun) await loadSessionMessages(sessionId);
            if (!hasActiveRun || exhausted) stopRunCatchup(sessionId);
        } catch (cause) {
            logger.warn("run projection catch-up tick failed", cause);
            if (exhausted) stopRunCatchup(sessionId);
        }
    };
    void tick();
    runCatchupTimers.set(
        sessionId,
        setInterval(() => void tick(), RUN_CATCHUP_INTERVAL_MS),
    );
}

/**
 * PLAN-0464 T2.1: the waiting link lives on the child ChatRun row, so the
 * projection reads `GET /chat/sessions/{childSessionId}/runs` once per child
 * session instead of paging Operations and fetching every trace.
 */
async function refreshFollowUpQueue(sessionId: string) {
    const requestId = ++followUpQueueRequestId;
    try {
        const snapshot = await api.getFollowUpQueue(sessionId);
        if (props.sessionId !== sessionId || requestId !== followUpQueueRequestId) return;
        followUpQueue.value = snapshot;
        followUpQueueError.value = null;
        // Admission clears the queue's content copy; reload the owner Message so
        // the queue row can keep showing the prompt after it becomes a ChatRun.
        const missingAdmittedMessages = new Set(
            snapshot.items
                .filter((item) => item.status === "admitted" && item.childMessageId)
                .map((item) => item.childMessageId!)
                .filter((messageId) => {
                    const message = messages.value.find((current) => current.id === messageId);
                    return !message?.content.trim();
                }),
        );
        if (missingAdmittedMessages.size > 0) {
            void loadSessionMessages(sessionId, missingAdmittedMessages);
        }
    } catch (cause) {
        if (props.sessionId !== sessionId || requestId !== followUpQueueRequestId) return;
        followUpQueueError.value =
            cause instanceof ApiError
                ? `${cause.problem.code}: ${cause.problem.detail ?? cause.message}`
                : t("chat.followUpQueueLoadFailed");
        logger.error("Failed to load Session Follow-up queue", cause);
    }
}

async function loadWaitingOnProjection(
    sessionId: string,
    activeChildren: SessionDerivedStateResponse["activeChildren"],
) {
    const requestId = ++waitingOnRequestId;
    const activeByRunId = new Map(activeChildren.map((child) => [child.runId, child]));
    if (activeByRunId.size === 0) {
        waitingOnByToolCallId.value = {};
        return;
    }

    try {
        const waitingOn: Record<string, ToolCallWaitingOn> = {};
        const childSessionIds = [...new Set(activeChildren.map((child) => child.childSessionId))];
        for (const childSessionId of childSessionIds) {
            const runs = await api.listSessionRuns(childSessionId, { page: 0, size: 200 });
            for (const run of runs.runs) {
                const child = activeByRunId.get(run.runId);
                if (!child || !run.waitingToolCallId) continue;
                waitingOn[run.waitingToolCallId] = {
                    childRunId: child.runId,
                    name: child.name,
                    status: child.status,
                };
            }
        }

        if (props.sessionId === sessionId && requestId === waitingOnRequestId) {
            waitingOnByToolCallId.value = waitingOn;
        }
    } catch (cause) {
        if (props.sessionId === sessionId && requestId === waitingOnRequestId) {
            waitingOnByToolCallId.value = {};
        }
        logger.error("Failed to load durable child wait links", cause);
    }
}

async function refreshDerivedState(sessionId: string) {
    if (!sessionId) return;
    const requestId = ++derivedStateRequestId;
    derivedStateLoading.value = true;
    derivedStateError.value = false;
    try {
        const result = await api.getSessionDerivedState(sessionId);
        if (props.sessionId !== sessionId || requestId !== derivedStateRequestId) return;
        derivedState.value = result;
        const activeRunIds = new Set(result.activeChildren.map((child) => child.runId));
        waitingOnByToolCallId.value = Object.fromEntries(
            Object.entries(waitingOnByToolCallId.value).filter(([, child]) =>
                activeRunIds.has(child.childRunId),
            ),
        );
        await loadWaitingOnProjection(sessionId, result.activeChildren);
    } catch (cause) {
        if (props.sessionId === sessionId && requestId === derivedStateRequestId) {
            derivedStateError.value = true;
            logger.error("Failed to load Session derived state", cause);
        }
    } finally {
        if (props.sessionId === sessionId && requestId === derivedStateRequestId) {
            derivedStateLoading.value = false;
        }
    }
}

function handleDerivedStateRefresh() {
    void refreshDerivedState(props.sessionId);
    guidancePanelRef.value?.refetch();
}

const guidancePanelRef = ref<InstanceType<typeof GuidancePanel> | null>(null);
const currentRunId = computed(() => chatStore.getSessionRunId(props.sessionId));
const currentRunStatus = computed(() => chatStore.getSessionRunState(props.sessionId).status);

/**
 * PLAN-0631 D31-04: CP parks a Run (`status:"queued"`) instead of dispatching it when
 * the Agent is down but the LLM is ready. Nothing executes until recovery, so the
 * view must say so — the previous behaviour was an unexplained stop/queue mode.
 * The copy is a *consequence* of the wire fact; the state itself is never inferred.
 */
const runQueued = computed(() => chatStore.getRunQueued(props.sessionId));
/** Only `agent_down` exists on the wire today; an unknown reason gets the generic hint. */
const QUEUED_REASON_KEYS: Record<string, string> = {
    agent_down: "chat.runState.reasonAgentDown",
};
const runQueuedHint = computed(() => {
    const reason = runQueued.value?.reason;
    return t((reason ? QUEUED_REASON_KEYS[reason] : undefined) ?? "chat.runState.queuedHint");
});

/**
 * PLAN-0631 D31-03/D31-01: the waiting-for-approval wording comes from the single
 * `runStateView` resolver, so the in-stream status row and the composer pill can never
 * drift into two different sentences ("等待审批" vs "等待确认"). Both surfaces read the
 * same `pendingApproval` computed; only the wording source is shared with the resolver.
 */
const approvalWaitingLabel = computed(() => {
    const key = runStateLabelKey("awaiting_approval");
    return key ? t(key) : t("chat.runState.awaitingApproval");
});
/** A failed/uncertain recovery needs alert semantics; a plain "resumed" is a status. */
const recoveryBannerRole = computed(() =>
    runRecovery.value?.state === "failed" ? "alert" : "status",
);

// Keep the last run so its Guidance list remains readable after the run goes terminal;
// only the input is gated by the active status.
const lastRunId = ref<string | undefined>(undefined);
watch(
    [currentRunId, () => props.sessionId],
    ([runId]) => {
        if (runId) lastRunId.value = runId;
    },
    { immediate: true },
);

const streamComponent = ref<InstanceType<typeof SSEStream> | null>(null);
const inputComponent = ref<InstanceType<typeof InputArea> | null>(null);

/**
 * PLAN-0623：把「提及」转交给输入框（`@displayName` 插入草稿，不发送）。
 * 由 WorkspaceView 通过 ref 调用，dock 里的参与者面板不直接持有 composer。
 */
function insertMention(name: string): void {
    inputComponent.value?.insertMention?.(name);
}

defineExpose({ insertMention });
let previousSessionId: string | null = null;

watch(
    () => props.sessionId,
    (sessionId) => {
        messageLoadRequestId += 1;
        derivedStateRequestId += 1;
        waitingOnRequestId += 1;
        creatingBranchForMessageId.value = null;
        derivedState.value = null;
        derivedStateError.value = false;
        derivedStateLoading.value = Boolean(sessionId);
        waitingOnByToolCallId.value = {};
        followUpQueueRequestId += 1;
        followUpQueueSubmitGeneration += 1;
        followUpQueueActionGeneration += 1;
        followUpQueue.value = null;
        followUpQueueError.value = null;
        followUpQueueSubmitting.value = false;
        followUpQueueContinuing.value = false;
        followUpQueueBusyItemId.value = null;
        if (previousSessionId && previousSessionId !== sessionId) {
            stopRunCatchup(previousSessionId);
            sessionRuns.value = [];
            chatStore.detachLiveSession(previousSessionId);
            lastRunId.value = undefined;
        }
        previousSessionId = sessionId;
        if (sessionId) {
            void loadSessionMessages(sessionId);
            void refreshDerivedState(sessionId);
            void refreshFollowUpQueue(sessionId);
            // run 摘要不在这里单独拉：`catchUpInFlightRunProjection` 的首个 tick 就是一次
            // `listSessionRuns`，并在拿到结果时写 `sessionRuns`（同一会话激活期只打一次）。
            catchUpInFlightRunProjection(sessionId);
        }
    },
    { immediate: true },
);

onBeforeUnmount(() => {
    // 删除当前项对 Map 迭代安全（与 chatStore 的 Set 迭代注释同理）。
    for (const id of runCatchupTimers.keys()) stopRunCatchup(id);
});

watch(selectedBranchId, (branchId, previousBranchId) => {
    if (branchId && branchId !== previousBranchId && props.sessionId) {
        void loadSessionMessages(props.sessionId);
    }
});

watch(isStreaming, (streaming, previous) => {
    if (streaming !== previous && props.sessionId) {
        if (previous && !streaming) {
            void loadSessionMessages(props.sessionId);
            // 追平循环在跑时它每个 tick 都会写 `sessionRuns`，终态点不再重复拉一次
            // （同一 run 的终态只留一个消费者）；没有循环时才由这里刷新。
            if (!runCatchupTimers.has(props.sessionId)) void refreshSessionRuns(props.sessionId);
            guidancePanelRef.value?.refetch();
        }
        void refreshFollowUpQueue(props.sessionId);
    }
});

async function handleSend(
    content: string,
    attachments?: AttachmentFile[],
    branchIdOverride?: string,
    speakAsParticipantId?: string,
    /** PLAN-0630 M5b (D30-14)：composer 的 cc 旁听名单（participantId 数组）。 */
    cc?: string[],
) {
    const id = props.sessionId;
    if (!id) return;
    if (isStreaming.value) return;
    // C1：未绑定的会话先补绑/引导，绝不把消息发出去撞 409 PROVIDER_REQUIRED。
    if (!(await guardProviderBinding(id))) {
        pendingProviderBindingSend.value = [
            content,
            attachments,
            branchIdOverride,
            speakAsParticipantId,
            cc,
        ];
        return;
    }
    let branchId: string | undefined = branchIdOverride ?? selectedBranchId.value;
    if (!branchId) {
        try {
            await chatStore.loadSessionBranches(id);
            branchId = branchIdOverride ?? chatStore.getSelectedBranchId(id);
        } catch (cause) {
            logger.error("Failed to load branch selector before Chat submission", cause);
            toast.error(t("chat.branchLoadFailed"));
            return;
        }
    }
    if (!branchId) {
        toast.error(t("chat.branchLoadFailed"));
        return;
    }

    const selectedPrincipal = currentSession.value?.agentPrincipalId;
    if (selectedPrincipal) {
        await submitMessage({
            content,
            attachments,
            agentPrincipalId: selectedPrincipal,
            branchId,
            asParticipantId: speakAsParticipantId,
            cc,
        });
        return;
    }

    const workspaceId = currentSession.value?.workspaceId ?? authStore.currentWorkspaceId;
    if (!workspaceId || loadingPrincipalChoices.value) return;
    loadingPrincipalChoices.value = true;
    try {
        principalChoices.value = await api.getWorkspaceAgents(workspaceId);
        if (principalChoices.value.length === 0) {
            toast.error(t("workspace.noBoundAgent"));
            return;
        }
        pendingSend.value = { content, attachments, branchId, cc };
        selectedPrincipalId.value = "";
        showPrincipalBinding.value = true;
    } catch (cause) {
        const message = cause instanceof ApiError ? cause.message : t("workspace.agentLoadFailed");
        logger.error("Failed to load Workspace Agents for Session binding", cause);
        toast.error(message);
    } finally {
        loadingPrincipalChoices.value = false;
    }
}

async function handleFollowUpQueue(content: string, attachments?: AttachmentFile[]) {
    const sessionId = props.sessionId;
    if (
        !sessionId ||
        followUpQueueSubmitting.value ||
        followUpQueueFull.value ||
        followUpQueueBusyItemId.value ||
        followUpQueueContinuing.value
    )
        return;
    // C1：入队同样先补绑 —— 否则只是把 409 推迟到 run 派发时。
    if (!(await guardProviderBinding(sessionId))) return;
    let branchId = selectedBranchId.value;
    if (!branchId) {
        try {
            await chatStore.loadSessionBranches(sessionId);
            branchId = chatStore.getSelectedBranchId(sessionId) ?? "";
        } catch (cause) {
            logger.error("Failed to load branch selector before Follow-up enqueue", cause);
            toast.error(t("chat.branchLoadFailed"));
            return;
        }
    }
    if (props.sessionId !== sessionId) return;
    if (!branchId) {
        toast.error(t("chat.branchLoadFailed"));
        return;
    }

    const fileIds = (attachments ?? [])
        .map((attachment) => attachment.fileId)
        .filter((fileId): fileId is string => Boolean(fileId));
    const binding = configStore.getEffectiveModel(sessionId);
    const signature = JSON.stringify([
        branchId,
        content,
        fileIds,
        props.toolMode,
        binding?.provider ?? null,
        binding?.model ?? null,
    ]);
    const sessionKeys = pendingFollowUpKeys.get(sessionId) ?? new Map<string, string>();
    const idempotencyKey = sessionKeys.get(signature) ?? crypto.randomUUID();
    sessionKeys.set(signature, idempotencyKey);
    pendingFollowUpKeys.set(sessionId, sessionKeys);
    const requestGeneration = ++followUpQueueSubmitGeneration;

    followUpQueueSubmitting.value = true;
    followUpQueueError.value = null;
    try {
        const snapshot = await api.enqueueFollowUp(
            sessionId,
            {
                content,
                ...(fileIds.length > 0 ? { attachments: fileIds } : {}),
                branchId,
                toolMode: props.toolMode,
                ...(binding?.provider ? { provider: binding.provider } : {}),
                ...(binding?.model ? { model: binding.model } : {}),
            },
            idempotencyKey,
        );
        if (props.sessionId !== sessionId || requestGeneration !== followUpQueueSubmitGeneration)
            return;
        followUpQueue.value = snapshot;
        followUpQueueError.value = null;
        if (sessionKeys.get(signature) === idempotencyKey) {
            sessionKeys.delete(signature);
            if (sessionKeys.size === 0) pendingFollowUpKeys.delete(sessionId);
        }
        inputComponent.value?.clearDraft?.();
        toast.success(t("chat.followUpQueued"));
        void refreshFollowUpQueue(sessionId);
    } catch (cause) {
        if (props.sessionId !== sessionId || requestGeneration !== followUpQueueSubmitGeneration)
            return;
        const message =
            cause instanceof ApiError
                ? `${cause.problem.code}: ${cause.problem.detail ?? cause.message}`
                : t("chat.followUpQueueFailed");
        followUpQueueError.value = message;
        logger.error("Failed to enqueue Session Follow-up", cause);
        toast.error(message);
        void refreshFollowUpQueue(sessionId);
    } finally {
        if (requestGeneration === followUpQueueSubmitGeneration) {
            followUpQueueSubmitting.value = false;
        }
    }
}

async function withdrawFollowUp(queueItemId: string) {
    const sessionId = props.sessionId;
    if (!sessionId || followUpQueueBusyItemId.value || followUpQueueContinuing.value) return;
    const requestGeneration = ++followUpQueueActionGeneration;
    followUpQueueBusyItemId.value = queueItemId;
    followUpQueueError.value = null;
    try {
        const snapshot = await api.withdrawFollowUp(sessionId, queueItemId);
        if (props.sessionId !== sessionId || requestGeneration !== followUpQueueActionGeneration)
            return;
        followUpQueue.value = snapshot;
        toast.success(t("chat.followUpWithdrawn"));
    } catch (cause) {
        if (props.sessionId !== sessionId || requestGeneration !== followUpQueueActionGeneration)
            return;
        const message =
            cause instanceof ApiError
                ? `${cause.problem.code}: ${cause.problem.detail ?? cause.message}`
                : t("chat.followUpQueueFailed");
        followUpQueueError.value = message;
        logger.error("Failed to withdraw Session Follow-up", cause);
        toast.error(message);
    } finally {
        if (requestGeneration === followUpQueueActionGeneration)
            followUpQueueBusyItemId.value = null;
    }
}

async function continueFollowUpQueue() {
    const sessionId = props.sessionId;
    if (!sessionId || followUpQueueContinuing.value || followUpQueueBusyItemId.value) return;
    const requestGeneration = ++followUpQueueActionGeneration;
    followUpQueueContinuing.value = true;
    followUpQueueError.value = null;
    try {
        const snapshot = await api.continueFollowUpQueue(sessionId);
        if (props.sessionId !== sessionId || requestGeneration !== followUpQueueActionGeneration)
            return;
        followUpQueue.value = snapshot;
        toast.success(t("chat.followUpContinued"));
        void refreshFollowUpQueue(sessionId);
    } catch (cause) {
        if (props.sessionId !== sessionId || requestGeneration !== followUpQueueActionGeneration)
            return;
        const message =
            cause instanceof ApiError
                ? `${cause.problem.code}: ${cause.problem.detail ?? cause.message}`
                : t("chat.followUpQueueFailed");
        followUpQueueError.value = message;
        logger.error("Failed to continue Session Follow-up queue", cause);
        toast.error(message);
    } finally {
        if (requestGeneration === followUpQueueActionGeneration)
            followUpQueueContinuing.value = false;
    }
}

/**
 * 输入框的 `send` 事件现在带第三个参数（`asParticipantId`，D23-27 代发 / M5b to）与第四个参数
 * （`cc`，M5b 旁听名单）。`handleSend` 的第三个位置是 `branchIdOverride`（队列流程在用），
 * 所以这里显式转接，避免"代发 id 被当成 branchId"这种静默错位。
 */
function onInputSend(
    content: string,
    attachments?: AttachmentFile[],
    asParticipantId?: string,
    cc?: string[],
): Promise<void> {
    return handleSend(content, attachments, undefined, asParticipantId, cc);
}

async function submitMessage(input: {
    content: string;
    attachments?: AttachmentFile[];
    agentPrincipalId: string;
    branchId: string;
    /** D23-27：以某个参与者身份发言（"代发"）。仅当 `capabilities.speakAs` 为真时才会有值。 */
    asParticipantId?: string;
    /** PLAN-0630 M5b (D30-14)：composer 的 cc 旁听名单（participantId 数组，随消息发送）。 */
    cc?: string[];
}) {
    const { content, attachments, agentPrincipalId, branchId, asParticipantId, cc } = input;
    if (!authStore.canWriteWorkspace) {
        toast.error(t("workspace.viewerReadOnly"));
        return;
    }
    const id = props.sessionId;

    const fileIds = attachments
        ?.map((a) => a.fileId)
        .filter((fileId): fileId is string => fileId !== undefined);
    const result = await streamComponent.value?.sendMessage(content, {
        branchId,
        attachments: fileIds,
        toolMode: props.toolMode,
        agentPrincipalId,
        asParticipantId,
        cc,
    });
    if (!result) return;

    sessionStore.setSessionAgentPrincipal(id, agentPrincipalId);

    // Keep this run's client-side transcript through the post-terminal history refresh: the
    // durable message projection can lag the terminal SSE event (see chat store
    // `unprojectedRuns`), and replacing the transcript in that window silently dropped the
    // user's prompt, the streamed tokens, and the error box. `adoptRunId` also binds the run
    // id to a live reply whose first token beat this `202` body.
    chatStore.adoptRunId(id, result.runId);

    const userMessageId = result.messageId ?? crypto.randomUUID();
    chatStore.markClientOwned(id, userMessageId);
    chatStore.addMessage(id, {
        id: userMessageId,
        sessionId: id,
        role: "user",
        content,
        timestamp: new Date().toISOString(),
        branchId,
        attachments,
        runId: result.runId,
        runStatus: result.status,
        // PLAN-0631 D31-08: a `speakAs` message is attributed to the participant whose
        // identity the caller chose (CP validates it). Absent = the caller's own words.
        ...(asParticipantId ? { participantId: asParticipantId } : {}),
        // PLAN-0659 T1.3：投递语义（发送/抄送）只有 composer 这一层知道，**UI 本地视图**，
        // 与 `participantId` 同一口径：history DTO 不携带该字段 ⇒ 刷新后消失（BL-239：
        // 投递语义暂无持久载体，P3）。不落 localStorage、不进 wire（本 PLAN 非目标）。
        ...(asParticipantId || (cc?.length ?? 0) > 0
            ? { delivery: { toParticipantId: asParticipantId ?? null, ccParticipantIds: cc ?? [] } }
            : {}),
    });
    inputComponent.value?.clearDraft();
}

async function confirmPrincipalBinding() {
    if (!pendingSend.value || !selectedPrincipalId.value) return;
    const pending = pendingSend.value,
        principalId = selectedPrincipalId.value;
    pendingSend.value = null;
    showPrincipalBinding.value = false;
    await submitMessage({
        content: pending.content,
        attachments: pending.attachments,
        agentPrincipalId: principalId,
        branchId: pending.branchId,
        cc: pending.cc,
    });
}

async function handleRetry(messageId: string) {
    const index = messages.value.findIndex((message) => message.id === messageId);
    if (index < 0) return;
    let userMessage: Message | undefined;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        if (messages.value[cursor]?.role === "user") {
            userMessage = messages.value[cursor];
            break;
        }
    }
    if (!userMessage) return;
    await handleSend(userMessage.content, userMessage.attachments, userMessage.branchId);
}

async function handleCreateBranch(anchorMessageId: string) {
    const sessionId = props.sessionId,
        sourceBranchId = selectedBranchId.value;
    if (!sessionId || !sourceBranchId || isStreaming.value || creatingBranchForMessageId.value)
        return;

    const keyScope = `${sessionId}:${sourceBranchId}:${anchorMessageId}`;
    const idempotencyKey = pendingBranchKeys.get(keyScope) ?? crypto.randomUUID();
    pendingBranchKeys.set(keyScope, idempotencyKey);
    creatingBranchForMessageId.value = anchorMessageId;
    try {
        const created = await api.createSessionBranch(
            sessionId,
            { sourceBranchId, anchorMessageId },
            idempotencyKey,
        );
        if (props.sessionId !== sessionId) return;
        await chatStore.loadSessionBranches(sessionId);
        chatStore.selectBranch(sessionId, created.branchId);
        pendingBranchKeys.delete(keyScope);
        toast.success(t("chat.branchCreated"));
    } catch (cause) {
        const message =
            cause instanceof ApiError
                ? `${cause.problem.code}: ${cause.problem.detail ?? cause.message}`
                : t("chat.branchCreateFailed");
        logger.error("Failed to create Session branch", cause);
        toast.error(message);
    } finally {
        if (props.sessionId === sessionId) creatingBranchForMessageId.value = null;
    }
}

async function handleDeleteMessage(messageId: string) {
    try {
        await api.deleteMessage(props.sessionId, messageId);
        chatStore.deleteMessage(props.sessionId, messageId);
    } catch (err) {
        logger.error("Failed to delete message", err);
    }
}

function approveTool(toolId: string) {
    agentStore.approveTool(toolId);
}

function rejectTool(toolId: string) {
    agentStore.rejectTool(toolId);
}

async function decideApproval(submission: ApprovalDecisionEnvelope) {
    const approval = pendingApproval.value;
    if (!approval || approvalSubmitting.value) return;
    // Drop a stale continuation: a classification write can resolve after the pending request
    // changed, and only the currently actionable request may be decided.
    if (submission.requestId !== approval.requestId) return;

    approvalSubmitting.value = true;
    approvalError.value = null;
    try {
        const { decision, feedback, layer, rule } = submission;
        const response = await agentStore.decideApproval(approval.requestId, {
            decision,
            ...(feedback === undefined ? {} : { feedback }),
            ...(layer === undefined ? {} : { layer }),
            ...(rule === undefined ? {} : { rule }),
        });
        if (response.status === "accepted" || response.status === "already_decided") {
            chatStore.invalidateRunRecovery(approval.sessionId, approval.runId);
        }
    } catch (err) {
        const message =
            err instanceof ApiError
                ? `${err.problem.code}: ${err.problem.detail ?? err.message}`
                : "Approval decision failed";
        approvalError.value = message;
        logger.error("Failed to submit chat approval decision", err);
    } finally {
        approvalSubmitting.value = false;
    }
}

function stopStreaming() {
    streamComponent.value?.stopStreaming?.();
}

// ── PLAN-292 M3 (C3): run recovery banner ────────────────────────────────
// A dead SSE or a page refresh hides what the run is doing. On mount, ask
// the CP for the last run's status and surface one of three honest states.
const runRecovery = computed(() => chatStore.runRecovery[props.sessionId] ?? null);

watch(
    runRecovery,
    (recovery) => {
        if (recovery && guidancePanelRef.value) {
            void guidancePanelRef.value.refetch();
        }
    },
    { immediate: true },
);

function recoverableRunId(): string | null {
    const msgs = chatStore.getMessages(props.sessionId);
    for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i];
        if (msg.role === "assistant" && msg.runId && msg.runStatus !== "succeeded") {
            return msg.runId;
        }
    }
    return null;
}

onMounted(() => {
    const runId = recoverableRunId();
    if (runId) void chatStore.refreshRunRecovery(props.sessionId, runId);
});

const recoveryBannerClass = computed(() => {
    switch (runRecovery.value?.state) {
        case "resumed":
            return "border-primary/40 bg-primary/10 text-foreground";
        case "cancelled":
            return "border-border bg-muted/40 text-muted-foreground";
        default:
            return "border-destructive/40 bg-destructive/10 text-foreground";
    }
});

// ── PLAN-0339: workspace slice restore flow (preview → execute → result) ────
// The entry lives beside the message; the dialogs are hosted here so
// every chat surface (chat view, workspace chat, mobile sheet) gets the same flow.
const revertPreviewSliceRef = ref<string | null>(null),
    revertBusy = ref(false),
    revertError = ref<string | null>(null);
const revertResult = ref<CheckpointResult | null>(null);

function openRevertPreview(sliceRef: string) {
    revertResult.value = null;
    revertError.value = null;
    revertPreviewSliceRef.value = sliceRef;
}

function closeRevertPreview() {
    if (revertBusy.value) return;
    revertPreviewSliceRef.value = null;
    revertError.value = null;
}

async function confirmRevert(
    acknowledgeTypeChanges: string[],
    acknowledgeNestedRepos: string[] = [],
    force = false,
) {
    const sliceRef = revertPreviewSliceRef.value,
        sessionId = props.sessionId;
    const workspaceId = authStore.currentWorkspaceId;
    if (!sliceRef || !workspaceId || revertBusy.value) return;
    revertBusy.value = true;
    revertError.value = null;
    try {
        const result = await api.executeWorkspaceCheckpointRevert(
            workspaceId,
            sliceRef,
            acknowledgeTypeChanges,
            acknowledgeNestedRepos,
            force,
        );
        // A session switch while the request was in flight drops the continuation: the result
        // dialog must not open over a different session.
        if (props.sessionId !== sessionId || authStore.currentWorkspaceId !== workspaceId) return;
        // Refresh the durable workspace projection after the result is shown.
        void checkpointStore.fetchWorkspaceCheckpoints(workspaceId, { force: true });
        revertPreviewSliceRef.value = null;
        revertResult.value = result;
        const counts = result.counts;
        if (counts && counts.failed > 0) {
            toast.warning(t("chat.checkpointRevertPartial"));
        } else {
            toast.success(t("chat.checkpointRevertDone"));
        }
    } catch (cause) {
        if (props.sessionId !== sessionId || authStore.currentWorkspaceId !== workspaceId) return;
        revertError.value =
            cause instanceof ApiError
                ? `${cause.problem.code}: ${cause.problem.detail ?? cause.message}`
                : t("chat.checkpointRevertFailed");
        logger.warn("Failed to execute workspace checkpoint restore", cause);
    } finally {
        revertBusy.value = false;
    }
}

function retryRevert(sliceRef: string) {
    revertResult.value = null;
    revertError.value = null;
    revertPreviewSliceRef.value = sliceRef;
}

function closeRevertResult() {
    revertResult.value = null;
}

watch(
    () => props.sessionId,
    () => {
        revertPreviewSliceRef.value = null;
        revertResult.value = null;
        revertError.value = null;
        revertBusy.value = false;
    },
);
</script>

<template>
    <!-- `flex-1` takes the height left by the session head / banners instead of a hard
         `h-full` of the column: the panel sits in a flex column with a 36px title row above
         it, so 100% would overflow the column by exactly that row and push the composer (and
         the dock's bottom edge) below the fold. `h-full` stays for hosts where the panel is
         the only child and the parent is not a flex container. -->
    <div class="flex flex-col h-full min-h-0 flex-1 overflow-hidden">
        <SessionSettingsPanel
            :session-id="sessionId"
            :is-mobile="isMobile"
            :branch-options="branchOptions"
            :selected-branch-id="selectedBranchId"
            :main-branch-id="mainBranchId"
            @open-context-panel="emit('open-context-panel')"
        />

        <div
            v-if="runRecovery"
            data-testid="run-recovery-banner"
            class="flex items-center justify-between gap-3 mx-4 mt-3 px-3 py-2 rounded-lg border text-sm"
            :class="recoveryBannerClass"
            :role="recoveryBannerRole"
        >
            <span>{{ runRecovery.message }}</span>
            <button
                class="px-2 py-0.5 text-xs rounded border border-border hover:bg-accent shrink-0"
                data-testid="run-recovery-dismiss"
                @click="chatStore.dismissRunRecovery(props.sessionId)"
            >
                知道了
            </button>
        </div>

        <SessionDerivedStatePanel
            :active-children="derivedState?.activeChildren ?? []"
            :terminal-notices="derivedState?.terminalNotices ?? []"
            :loading="derivedStateLoading"
            :error="derivedStateError"
            @retry="handleDerivedStateRefresh"
        />

        <!-- PLAN-0631 D31-04: parked Run — say what is happening instead of a silent spinner. -->
        <Marker
            v-if="runQueued"
            data-testid="chat-run-queued"
            role="status"
            aria-live="polite"
            class="mx-4 mt-2 rounded-lg border border-border bg-surface-content px-3 py-2"
        >
            <MarkerIcon>
                <Clock class="size-3.5" aria-hidden="true" />
            </MarkerIcon>
            <MarkerContent>
                <span class="font-medium text-foreground">{{ t("chat.runState.queued") }}</span>
                <span class="ml-2">{{ runQueuedHint }}</span>
            </MarkerContent>
        </Marker>

        <!-- PLAN-0631 D31-03: approval pending must be a readable status region even when
             the decision modal is dismissed; it is not dismissible and not clickable. -->
        <Marker
            v-if="pendingApproval"
            data-testid="chat-approval-waiting"
            role="status"
            aria-live="polite"
            class="mx-4 mt-2 rounded-lg border border-border bg-surface-content px-3 py-2"
        >
            <MarkerIcon>
                <ShieldAlert class="size-3.5" aria-hidden="true" />
            </MarkerIcon>
            <MarkerContent>
                <span class="font-medium text-foreground">{{ approvalWaitingLabel }}</span>
                <span class="ml-2">{{ pendingApproval.tool }}</span>
            </MarkerContent>
        </Marker>

        <MessageList
            v-if="messages.length > 0"
            :messages="renderedMessages"
            :runs="sessionRuns"
            :branch-busy="creatingBranchForMessageId !== null"
            @approve="approveTool"
            @reject="rejectTool"
            @delete="handleDeleteMessage"
            @retry="handleRetry"
            @branch="handleCreateBranch"
            @revert="openRevertPreview"
        />

        <div v-else class="flex-1 flex flex-col items-center justify-center gap-4 px-4">
            <div class="text-2xl font-semibold text-muted-foreground">xihe</div>
            <p class="text-sm text-muted-foreground text-center max-w-md">
                你好，我是 xihe Agent。有什么我可以帮你的？
            </p>
            <div class="flex flex-wrap gap-2 justify-center max-w-md">
                <button
                    v-for="suggestion in suggestions"
                    :key="suggestion"
                    class="px-3 py-1.5 text-xs rounded-full border border-border bg-muted/30 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                    @click="handleSend(suggestion)"
                >
                    {{ suggestion }}
                </button>
            </div>
        </div>

        <GuidancePanel
            v-if="lastRunId"
            ref="guidancePanelRef"
            :run-id="lastRunId"
            :run-status="currentRunStatus"
        />

        <FollowUpQueuePanel
            v-if="followUpQueue && followUpQueue.outstandingCount > 0"
            :snapshot="followUpQueue"
            :messages="messages"
            :branch-labels="branchLabels"
            :busy-item-id="followUpQueueBusyItemId"
            :continuing="followUpQueueContinuing"
            :error="followUpQueueError"
            @withdraw="withdrawFollowUp"
            @continue="continueFollowUpQueue"
        />

        <button
            v-if="showReopenPill"
            type="button"
            data-testid="pending-approval-reopen-pill"
            class="mx-4 mb-2 flex items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm transition hover:bg-amber-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            @click="reopenApproval"
        >
            <span class="flex min-w-0 items-center gap-2">
                <span class="shrink-0 font-medium">{{ approvalWaitingLabel }}</span>
                <span class="truncate text-muted-foreground">{{ pendingApproval?.tool }}</span>
            </span>
            <span class="shrink-0 font-medium text-primary">{{
                t("chat.pendingApprovalReopenAction")
            }}</span>
        </button>

        <InputArea
            ref="inputComponent"
            :session-id="sessionId"
            :is-streaming="isStreaming"
            :queue-mode="followUpQueueMode"
            :queue-full="followUpQueueFull"
            :queue-paused="followUpQueue?.queueState === 'paused'"
            :queue-submitting="followUpQueueSubmitting"
            :queue-action-busy="followUpQueueBusyItemId !== null || followUpQueueContinuing"
            @send="onInputSend"
            @queue="handleFollowUpQueue"
            @stop="stopStreaming"
        />

        <ApprovalModal
            :approval="pendingApproval"
            :show="showApproval"
            :busy="approvalSubmitting"
            :error="approvalError"
            :can-classify="canClassifyApproval"
            @approve="decideApproval"
            @reject="decideApproval"
            @dismiss="handleApprovalDismiss"
        />

        <RevertPreviewDialog
            :show="revertPreviewSliceRef !== null"
            :workspace-id="authStore.currentWorkspaceId ?? ''"
            :slice-ref="revertPreviewSliceRef ?? ''"
            :busy="revertBusy"
            :error="revertError"
            @confirm="confirmRevert"
            @close="closeRevertPreview"
        />

        <RevertResultDialog
            :show="revertResult !== null"
            :workspace-id="authStore.currentWorkspaceId ?? ''"
            :result="revertResult"
            @retry="retryRevert"
            @close="closeRevertResult"
        />

        <ProviderBindingGuideDialog
            :show="providerBindingGuide !== null"
            :reason="providerBindingGuide?.reason ?? 'provider_required'"
            :detail="providerBindingGuide?.detail ?? null"
            @close="closeProviderBindingGuide"
            @retry="retryProviderBindingGuide"
            @settings="openProviderSettings"
        />
        <BaseModal
            :show="showPrincipalBinding"
            :title="t('workspace.chooseAgentTitle')"
            @close="
                showPrincipalBinding = false;
                pendingSend = null;
            "
        >
            <div class="space-y-4">
                <label for="chat-agent-principal" class="block text-sm text-foreground">
                    {{ t("workspace.chooseAgentLabel") }}
                </label>
                <select
                    id="chat-agent-principal"
                    v-model="selectedPrincipalId"
                    data-testid="chat-agent-principal-select"
                    class="w-full rounded-md border bg-background px-3 py-2 text-sm"
                >
                    <option value="" disabled>{{ t("workspace.chooseAgentPlaceholder") }}</option>
                    <option
                        v-for="agent in principalChoices"
                        :key="agent.principalId"
                        :value="agent.principalId"
                    >
                        {{ agent.name
                        }}<template v-if="agent.templateName"> · {{ agent.templateName }}</template>
                    </option>
                </select>
                <div class="flex justify-end gap-2">
                    <button
                        type="button"
                        class="rounded-md border px-3 py-2 text-sm"
                        @click="
                            showPrincipalBinding = false;
                            pendingSend = null;
                        "
                    >
                        {{ t("workspace.cancel") }}
                    </button>
                    <button
                        type="button"
                        data-testid="chat-bind-agent-and-send"
                        class="rounded-md bg-action px-3 py-2 text-sm text-action-foreground disabled:opacity-50"
                        :disabled="!selectedPrincipalId"
                        @click="confirmPrincipalBinding"
                    >
                        {{ t("workspace.bindAgentAndSend") }}
                    </button>
                </div>
            </div>
        </BaseModal>

        <SSEStream
            :session-id="sessionId"
            :tool-mode="toolMode"
            :active="true"
            ref="streamComponent"
            @derived-state-refresh="handleDerivedStateRefresh"
        />
    </div>
</template>
