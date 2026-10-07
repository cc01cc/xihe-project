<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { useChatStore } from "../../stores/chat";
import { useAgentStore } from "../../stores/agent";
import { useAuthStore } from "../../stores/auth";
import { useCheckpointStore } from "../../stores/checkpoint";
import { useConfigStore } from "../../stores/config";
import { useSessionStore } from "../../stores/session";
import {
    ApiError,
    api,
    type ApiFollowUpQueueSnapshot,
    type WorkspaceAgentBinding,
} from "../../composables/api";
import { parseRawToParts } from "../../composables/useStreamParser";
import { logger } from "../../lib/logger";
import type {
    ApprovalDecisionEnvelope,
    AttachmentFile,
    CheckpointResult,
    Message,
    SessionDerivedStateResponse,
    ToolCallWaitingOn,
} from "../../types";
import MessageList from "./MessageList.vue";
import InputArea from "./InputArea.vue";
import SSEStream from "./SSEStream.vue";
import ApprovalModal from "./ApprovalModal.vue";
import SessionPolicyControls from "./SessionPolicyControls.vue";
import SessionContextTemplate from "./SessionContextTemplate.vue";
import ContextSourcesU1 from "./ContextSourcesU1.vue";
import SessionDerivedStatePanel from "./SessionDerivedStatePanel.vue";
import FollowUpQueuePanel from "./FollowUpQueuePanel.vue";
import RevertPreviewDialog from "./RevertPreviewDialog.vue";
import RevertResultDialog from "./RevertResultDialog.vue";
import BaseModal from "../shared/BaseModal.vue";

const props = withDefaults(
    defineProps<{
        sessionId: string;
        toolMode?: "none" | "workspace";
    }>(),
    {
        toolMode: "none",
    },
);

const { t } = useI18n();
const chatStore = useChatStore();
const agentStore = useAgentStore();
const authStore = useAuthStore();
const checkpointStore = useCheckpointStore();
const configStore = useConfigStore();
const sessionStore = useSessionStore();

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
const sessionBranches = computed(() => chatStore.getSessionBranches(props.sessionId));
const selectedBranchId = computed(() => chatStore.getSelectedBranchId(props.sessionId) ?? "");
const followUpQueue = ref<ApiFollowUpQueueSnapshot | null>(null);
const followUpQueueError = ref<string | null>(null);
const followUpQueueSubmitting = ref(false);
const followUpQueueContinuing = ref(false);
const followUpQueueBusyItemId = ref<string | null>(null);
const pendingFollowUpKeys = new Map<string, Map<string, string>>();
let followUpQueueRequestId = 0;
let followUpQueueSubmitGeneration = 0;
let followUpQueueActionGeneration = 0;
const branchOptions = computed(() => {
    const byId = new Map(sessionBranches.value.map((branch) => [branch.branchId, branch]));
    const depthOf = (branchId: string) => {
        let depth = 0;
        let parentId = byId.get(branchId)?.parentBranchId ?? null;
        while (parentId && byId.has(parentId) && depth < 8) {
            depth += 1;
            parentId = byId.get(parentId)?.parentBranchId ?? null;
        }
        return depth;
    };
    return sessionBranches.value.map((branch) => ({
        branchId: branch.branchId,
        label: `${"- ".repeat(depthOf(branch.branchId))}${
            branch.parentBranchId === null
                ? t("chat.branchMainPath")
                : `${t("chat.branchPathOption")} ${branch.branchId.slice(0, 8)}`
        }`,
    }));
});
const branchLabels = computed(() => Object.fromEntries(
    branchOptions.value.map((branch) => [branch.branchId, branch.label] as const),
));
const followUpQueueMode = computed(() => isStreaming.value
    || (followUpQueue.value?.outstandingCount ?? 0) > 0
    || followUpQueue.value?.queueState === "paused");
const followUpQueueFull = computed(() => Boolean(followUpQueue.value
    && followUpQueue.value.outstandingCount >= followUpQueue.value.capacityLimit));
const derivedState = ref<SessionDerivedStateResponse | null>(null);
const derivedStateLoading = ref(false);
const derivedStateError = ref(false);
const waitingOnByToolCallId = ref<Record<string, ToolCallWaitingOn>>({});
let derivedStateRequestId = 0;
let waitingOnRequestId = 0;

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

const showPrincipalBinding = ref(false);
const principalChoices = ref<WorkspaceAgentBinding[]>([]);
const selectedPrincipalId = ref("");
const pendingSend = ref<{
    content: string;
    attachments?: AttachmentFile[];
    branchId: string;
} | null>(null);
const loadingPrincipalChoices = ref(false);
const creatingBranchForMessageId = ref<string | null>(null);
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
const approvalSubmitting = ref(false);
const approvalError = ref<string | null>(null);
const dismissedRequestIds = ref(new Set<string>());
const showApproval = computed(() => {
    const approval = pendingApproval.value;
    if (!approval) return false;
    if (approval.state === "dispatch_unknown") return true;
    return !dismissedRequestIds.value.has(approval.requestId);
});
const showReopenPill = computed(() => {
    const approval = pendingApproval.value;
    return (
        approval !== null &&
        !showApproval.value &&
        dismissedRequestIds.value.has(approval.requestId)
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
});
/** Classification authority hint (server still enforces): workspace OWNER / instance ADMIN. */
const canClassifyApproval = computed(() => authStore.canClassifyTools);

async function loadSessionMessages(sessionId: string) {
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
        chatStore.loadMessages(
            sessionId,
            rawMessages.map((message) => ({
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
                error: message.error,
                retryable: message.retryable,
                attachments: message.attachments?.map((attachment) => ({
                    id: attachment.fileId,
                    fileId: attachment.fileId,
                    name: attachment.name,
                    type: attachment.type,
                    size: attachment.size,
                    url: `/api/v1/files/${encodeURIComponent(attachment.fileId)}`,
                    state: "done" as const,
                })),
            })),
        );
        if (derivedState.value?.sessionId === sessionId) {
            void loadWaitingOnProjection(
                sessionId,
                derivedState.value.activeChildren,
                chatStore.getSessionRunId(sessionId),
            );
        }
    } catch (cause) {
        if (cause instanceof ApiError && cause.problem.code === "MESSAGE_NOT_FOUND") return;
        logger.error("Failed to load session messages", cause);
    }
}

async function refreshFollowUpQueue(sessionId: string) {
    const requestId = ++followUpQueueRequestId;
    try {
        const snapshot = await api.getFollowUpQueue(sessionId);
        if (props.sessionId !== sessionId || requestId !== followUpQueueRequestId) return;
        followUpQueue.value = snapshot;
        followUpQueueError.value = null;
    } catch (cause) {
        if (props.sessionId !== sessionId || requestId !== followUpQueueRequestId) return;
        followUpQueueError.value = cause instanceof ApiError
            ? `${cause.problem.code}: ${cause.problem.detail ?? cause.message}`
            : t("chat.followUpQueueLoadFailed");
        logger.error("Failed to load Session Follow-up queue", cause);
    }
}

function isSpawnToolCall(name: string): boolean {
    return (
        name === "spawn_agent" || name.endsWith("__spawn_agent") || name.endsWith("/spawn_agent")
    );
}

async function loadWaitingOnProjection(
    sessionId: string,
    activeChildren: SessionDerivedStateResponse["activeChildren"],
    preferredParentRunId?: string,
) {
    const requestId = ++waitingOnRequestId;
    const activeByRunId = new Map(activeChildren.map((child) => [child.runId, child]));
    if (activeByRunId.size === 0) {
        waitingOnByToolCallId.value = {};
        return;
    }

    const parentRunIds = new Set<string>();
    if (preferredParentRunId) parentRunIds.add(preferredParentRunId);
    for (const message of chatStore.getMessages(sessionId)) {
        if (message.runId) parentRunIds.add(message.runId);
        for (const toolCall of message.toolCalls ?? []) {
            if (!isSpawnToolCall(toolCall.name)) continue;
            if (toolCall.runId) parentRunIds.add(toolCall.runId);
        }
    }
    if (parentRunIds.size === 0) {
        waitingOnByToolCallId.value = {};
        return;
    }

    try {
        const waitingOn: Record<string, ToolCallWaitingOn> = {};
        const resolvedRunIds = new Set<string>();
        const matchedChildRunIds = new Set<string>();
        let page = 0;
        let totalPages = 1;
        while (page < totalPages && matchedChildRunIds.size < activeByRunId.size) {
            const operationPage = await api.listOperations({ sessionId, page, size: 50 });
            totalPages = operationPage.totalPages;
            const candidates = operationPage.operations.filter(
                (operation) =>
                    operation.runId &&
                    parentRunIds.has(operation.runId) &&
                    !resolvedRunIds.has(operation.runId),
            );
            for (
                let offset = 0;
                offset < candidates.length && matchedChildRunIds.size < activeByRunId.size;
                offset += 8
            ) {
                const traces = await Promise.all(
                    candidates.slice(offset, offset + 8).map(async (operation) => ({
                        runId: operation.runId!,
                        trace: await api.getOperationTrace(operation.id),
                    })),
                );
                for (const { runId, trace } of traces) {
                    resolvedRunIds.add(runId);
                    for (const item of trace.items) {
                        if (!item.toolCallId || !item.waitingOnRunId) continue;
                        const child = activeByRunId.get(item.waitingOnRunId);
                        if (!child) continue;
                        waitingOn[item.toolCallId] = {
                            childRunId: child.runId,
                            name: child.name,
                            status: child.status,
                        };
                        matchedChildRunIds.add(child.runId);
                    }
                }
            }
            page += 1;
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
    const parentRunIdAtRefresh = chatStore.getSessionRunId(sessionId);
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
        await loadWaitingOnProjection(sessionId, result.activeChildren, parentRunIdAtRefresh);
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
}

const streamComponent = ref<InstanceType<typeof SSEStream> | null>(null);
const inputComponent = ref<InstanceType<typeof InputArea> | null>(null);
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
            chatStore.detachLiveSession(previousSessionId);
        }
        previousSessionId = sessionId;
        if (sessionId) {
            void loadSessionMessages(sessionId);
            void refreshDerivedState(sessionId);
            void refreshFollowUpQueue(sessionId);
        }
    },
    { immediate: true },
);

watch(selectedBranchId, (branchId, previousBranchId) => {
    if (branchId && branchId !== previousBranchId && props.sessionId) {
        void loadSessionMessages(props.sessionId);
    }
});

watch(isStreaming, (streaming, previous) => {
    if (streaming !== previous && props.sessionId) {
        if (previous && !streaming) void loadSessionMessages(props.sessionId);
        void refreshFollowUpQueue(props.sessionId);
    }
});

async function handleSend(
    content: string,
    attachments?: AttachmentFile[],
    branchIdOverride?: string,
) {
    const id = props.sessionId;
    if (!id) return;
    if (isStreaming.value) return;
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
        pendingSend.value = { content, attachments, branchId };
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
    if (!sessionId || followUpQueueSubmitting.value || followUpQueueFull.value
        || followUpQueueBusyItemId.value || followUpQueueContinuing.value) return;
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
        branchId, content, fileIds, props.toolMode, binding?.provider ?? null, binding?.model ?? null,
    ]);
    const sessionKeys = pendingFollowUpKeys.get(sessionId) ?? new Map<string, string>();
    const idempotencyKey = sessionKeys.get(signature) ?? crypto.randomUUID();
    sessionKeys.set(signature, idempotencyKey);
    pendingFollowUpKeys.set(sessionId, sessionKeys);
    const requestGeneration = ++followUpQueueSubmitGeneration;

    followUpQueueSubmitting.value = true;
    followUpQueueError.value = null;
    try {
        const snapshot = await api.enqueueFollowUp(sessionId, {
            content,
            ...(fileIds.length > 0 ? { attachments: fileIds } : {}),
            branchId,
            toolMode: props.toolMode,
            ...(binding?.provider ? { provider: binding.provider } : {}),
            ...(binding?.model ? { model: binding.model } : {}),
        }, idempotencyKey);
        if (props.sessionId !== sessionId || requestGeneration !== followUpQueueSubmitGeneration) return;
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
        if (props.sessionId !== sessionId || requestGeneration !== followUpQueueSubmitGeneration) return;
        const message = cause instanceof ApiError
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
        if (props.sessionId !== sessionId || requestGeneration !== followUpQueueActionGeneration) return;
        followUpQueue.value = snapshot;
        toast.success(t("chat.followUpWithdrawn"));
    } catch (cause) {
        if (props.sessionId !== sessionId || requestGeneration !== followUpQueueActionGeneration) return;
        const message = cause instanceof ApiError
            ? `${cause.problem.code}: ${cause.problem.detail ?? cause.message}`
            : t("chat.followUpQueueFailed");
        followUpQueueError.value = message;
        logger.error("Failed to withdraw Session Follow-up", cause);
        toast.error(message);
    } finally {
        if (requestGeneration === followUpQueueActionGeneration) followUpQueueBusyItemId.value = null;
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
        if (props.sessionId !== sessionId || requestGeneration !== followUpQueueActionGeneration) return;
        followUpQueue.value = snapshot;
        toast.success(t("chat.followUpContinued"));
        void refreshFollowUpQueue(sessionId);
    } catch (cause) {
        if (props.sessionId !== sessionId || requestGeneration !== followUpQueueActionGeneration) return;
        const message = cause instanceof ApiError
            ? `${cause.problem.code}: ${cause.problem.detail ?? cause.message}`
            : t("chat.followUpQueueFailed");
        followUpQueueError.value = message;
        logger.error("Failed to continue Session Follow-up queue", cause);
        toast.error(message);
    } finally {
        if (requestGeneration === followUpQueueActionGeneration) followUpQueueContinuing.value = false;
    }
}

async function submitMessage(input: {
    content: string;
    attachments?: AttachmentFile[];
    agentPrincipalId: string;
    branchId: string;
}) {
    const { content, attachments, agentPrincipalId, branchId } = input;
    const id = props.sessionId;

    const fileIds = attachments
        ?.map((a) => a.fileId)
        .filter((fileId): fileId is string => fileId !== undefined);
    const result = await streamComponent.value?.sendMessage(content, {
        branchId,
        attachments: fileIds,
        toolMode: props.toolMode,
        agentPrincipalId,
    });
    if (!result) return;

    sessionStore.setSessionAgentPrincipal(id, agentPrincipalId);

    chatStore.addMessage(id, {
        id: result.messageId ?? crypto.randomUUID(),
        sessionId: id,
        role: "user",
        content,
        timestamp: new Date().toISOString(),
        branchId,
        attachments,
        runId: result.runId,
        runStatus: result.status,
    });
    inputComponent.value?.clearDraft();
}

async function confirmPrincipalBinding() {
    if (!pendingSend.value || !selectedPrincipalId.value) return;
    const pending = pendingSend.value;
    const principalId = selectedPrincipalId.value;
    pendingSend.value = null;
    showPrincipalBinding.value = false;
    await submitMessage({
        content: pending.content,
        attachments: pending.attachments,
        agentPrincipalId: principalId,
        branchId: pending.branchId,
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

function handleBranchSelection(event: Event) {
    if (isStreaming.value) return;
    const branchId = (event.target as HTMLSelectElement).value;
    chatStore.selectBranch(props.sessionId, branchId);
}

async function handleCreateBranch(anchorMessageId: string) {
    const sessionId = props.sessionId;
    const sourceBranchId = selectedBranchId.value;
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
const revertPreviewSliceRef = ref<string | null>(null);
const revertBusy = ref(false);
const revertError = ref<string | null>(null);
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

async function confirmRevert(acknowledgeTypeChanges: string[]) {
    const sliceRef = revertPreviewSliceRef.value;
    const sessionId = props.sessionId;
    const workspaceId = authStore.currentWorkspaceId;
    if (!sliceRef || !workspaceId || revertBusy.value) return;
    revertBusy.value = true;
    revertError.value = null;
    try {
        const result = await api.executeWorkspaceCheckpointRevert(
            workspaceId,
            sliceRef,
            acknowledgeTypeChanges,
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
    <div class="flex flex-col h-full min-h-0 overflow-hidden">
        <SessionPolicyControls :session-id="sessionId" />
        <SessionContextTemplate :session-id="sessionId" />
        <ContextSourcesU1 :session-id="sessionId" />
        <div
            class="flex items-center gap-3 border-b px-4 py-2"
            data-testid="session-branch-selector"
        >
            <label
                :for="`session-branch-${sessionId}`"
                class="text-xs font-medium text-muted-foreground"
            >
                {{ t("chat.branchSelectorLabel") }}
            </label>
            <select
                :id="`session-branch-${sessionId}`"
                :value="selectedBranchId"
                :disabled="
                    isStreaming ||
                    branchOptions.length === 0 ||
                    creatingBranchForMessageId !== null ||
                    pendingSend !== null
                "
                data-testid="session-branch-select"
                class="min-w-0 rounded-md border bg-background px-2 py-1 text-xs disabled:opacity-50"
                @change="handleBranchSelection"
            >
                <option
                    v-for="branch in branchOptions"
                    :key="branch.branchId"
                    :value="branch.branchId"
                >
                    {{ branch.label }}
                </option>
            </select>
        </div>

        <div
            v-if="runRecovery"
            data-testid="run-recovery-banner"
            class="flex items-center justify-between gap-3 mx-4 mt-3 px-3 py-2 rounded-lg border text-sm"
            :class="recoveryBannerClass"
            role="status"
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
        />

        <MessageList
            v-if="messages.length > 0"
            :messages="renderedMessages"
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
                <span class="shrink-0 font-medium">{{ t("chat.pendingApprovalReopenLabel") }}</span>
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
            @send="handleSend"
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
                        class="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
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
