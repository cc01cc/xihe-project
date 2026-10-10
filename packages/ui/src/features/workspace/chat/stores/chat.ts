import { defineStore } from "pinia";
import { ref } from "vue";
import type {
    ChatRunUsage,
    ChatSessionRunState,
    Message,
    MessagePart,
    ToolCall,
} from "../../../../types";
import { ApiError, api, type ApiSessionBranch } from "../../../../composables/api";
import { logger } from "../../../../lib/logger";
import { useAgentStore } from "../../../../stores/agent";

export const XIHE_STORAGE_KEYS = ["xihe-token", "xihe-user", "xihe-workspace"] as const;

// PLAN-292 M3 (C3): recovery banner tri-state — resumed (run still alive
// server-side, approvals replayable) / cancelled (terminal, nothing running)
// / retry (lease expired or status unknown). 'succeeded' runs set no banner.
export type RunRecoveryState = "resumed" | "cancelled" | "retry";

export interface RunRecovery {
    state: RunRecoveryState;
    runId: string;
    message: string;
}

export const useChatStore = defineStore("chat", () => {
    // Messages are not business data we should resurrect from localStorage.
    // The server is the canonical source via /api/v1/sessions/{id}/messages,
    // and the session store + chat store are cleared on user switch / logout.
    const messages = ref<Record<string, Message[]>>({}),
        streamingMessageId = ref<Record<string, string | null>>({}),
        sessionRunStates = ref<Record<string, ChatSessionRunState>>({});
    // PLAN-0343: last run-terminal usage snapshot per session (CP relays the
    // mapped usage event once per run). Not persisted across reloads — the
    // llm.usage ContextEvent is durable; the header line is live-run visibility.
    const sessionLastUsage = ref<Record<string, ChatRunUsage>>({}),
        sessionBranches = ref<Record<string, ApiSessionBranch[]>>({}),
        selectedBranchIds = ref<Record<string, string>>({}),
        branchVersions = new Map<string, number>(),
        branchLoadPromises = new Map<string, Promise<ApiSessionBranch[]>>();

    function getMessages(sessionId: string): Message[] {
        return messages.value[sessionId] ?? [];
    }

    function getSessionBranches(sessionId: string): ApiSessionBranch[] {
        return sessionBranches.value[sessionId] ?? [];
    }

    function getSelectedBranchId(sessionId: string): string | undefined {
        return selectedBranchIds.value[sessionId];
    }

    function setSessionBranches(sessionId: string, branches: ApiSessionBranch[]) {
        sessionBranches.value[sessionId] = branches;
        const selected = selectedBranchIds.value[sessionId];
        if (selected && branches.some((branch) => branch.branchId === selected)) return;
        const root = branches.find((branch) => branch.parentBranchId === null),
            fallback = root ?? branches[0];
        if (fallback) selectedBranchIds.value[sessionId] = fallback.branchId;
        else delete selectedBranchIds.value[sessionId];
    }

    function selectBranch(sessionId: string, branchId: string): boolean {
        if (!sessionBranches.value[sessionId]?.some((branch) => branch.branchId === branchId))
            return false;
        selectedBranchIds.value[sessionId] = branchId;
        return true;
    }

    async function loadSessionBranches(sessionId: string): Promise<ApiSessionBranch[]> {
        const pending = branchLoadPromises.get(sessionId);
        if (pending) return pending;
        const version = branchVersions.get(sessionId) ?? 0;
        const promise = api
            .getSessionBranches(sessionId)
            .then(({ items }) => {
                if ((branchVersions.get(sessionId) ?? 0) === version)
                    setSessionBranches(sessionId, items);
                return items;
            })
            .finally(() => {
                if (branchLoadPromises.get(sessionId) === promise)
                    branchLoadPromises.delete(sessionId);
            });
        branchLoadPromises.set(sessionId, promise);
        return promise;
    }

    function clearSessionBranches(sessionId: string) {
        branchVersions.set(sessionId, (branchVersions.get(sessionId) ?? 0) + 1);
        branchLoadPromises.delete(sessionId);
        delete sessionBranches.value[sessionId];
        delete selectedBranchIds.value[sessionId];
    }

    function getStreamingMessageId(sessionId: string): string | null {
        return streamingMessageId.value[sessionId] ?? null;
    }

    function getSessionRunState(sessionId: string): ChatSessionRunState {
        return sessionRunStates.value[sessionId] ?? { status: "idle" };
    }

    function getSessionLastUsage(sessionId: string): ChatRunUsage | null {
        return sessionLastUsage.value[sessionId] ?? null;
    }

    function setSessionLastUsage(sessionId: string, usage: ChatRunUsage) {
        sessionLastUsage.value[sessionId] = usage;
    }

    function getSessionRunId(sessionId: string): string | undefined {
        return sessionRunStates.value[sessionId]?.runId;
    }

    function setSessionRunState(
        sessionId: string,
        status: ChatSessionRunState["status"],
        runId?: string,
    ) {
        if (status === "idle" && runId === undefined) {
            delete sessionRunStates.value[sessionId];
            return;
        }
        sessionRunStates.value[sessionId] = {
            status,
            ...(runId !== undefined ? { runId } : {}),
        };
    }

    function isStreaming(sessionId: string): boolean {
        const status = sessionRunStates.value[sessionId]?.status;
        return (
            (streamingMessageId.value[sessionId] !== undefined &&
                streamingMessageId.value[sessionId] !== null) ||
            status === "thinking" ||
            status === "executing" ||
            status === "awaiting_approval"
        );
    }

    function addMessage(sessionId: string, message: Message) {
        if (!messages.value[sessionId]) {
            messages.value[sessionId] = [];
        }
        messages.value[sessionId].push(message);
    }

    function loadMessages(sessionId: string, sessionMessages: Message[]) {
        // An in-flight response is owned by the live SSE stream. Do not let a
        // slower history request replace its optimistic user/assistant messages.
        if (isStreaming(sessionId)) return;
        messages.value[sessionId] = sessionMessages;
    }

    function detachLiveSession(sessionId: string) {
        const messageId = streamingMessageId.value[sessionId];
        if (messageId) {
            messages.value[sessionId] = (messages.value[sessionId] ?? []).filter(
                (message) => message.id !== messageId,
            );
        }
        streamingMessageId.value[sessionId] = null;
        delete sessionRunStates.value[sessionId];
    }

    function deleteMessage(sessionId: string, messageId: string) {
        const sessionMessages = messages.value[sessionId];
        if (!sessionMessages) return;
        messages.value[sessionId] = sessionMessages.filter((msg) => msg.id !== messageId);
    }

    function addMarker(sessionId: string, marker: Omit<Message, "id" | "sessionId">) {
        addMessage(sessionId, {
            id: crypto.randomUUID(),
            sessionId,
            ...marker,
        });
    }

    function findStreamingMessage(sessionId: string): Message | undefined {
        const messageId = streamingMessageId.value[sessionId];
        if (!messageId) return undefined;
        return messages.value[sessionId]?.find((msg) => msg.id === messageId);
    }

    function messageHasRenderableContent(message: Message): boolean {
        return Boolean(
            message.content ||
            message.toolCalls?.length ||
            message.parts?.some((part) => part.type !== "citation" && Boolean(part.content)),
        );
    }

    function createStreamingMessage(sessionId: string, runId?: string, branchId?: string): string {
        // Tool-first runs create the live assistant message from `upsertToolCall`
        // before any token arrives; reuse it instead of spawning a second bubble.
        const existing = findStreamingMessage(sessionId);
        if (existing) {
            if (runId !== undefined) existing.runId = runId;
            if (branchId !== undefined) existing.branchId = branchId;
            return existing.id;
        }
        const id = crypto.randomUUID(),
            message: Message = {
                id,
                sessionId,
                role: "assistant",
                content: "",
                timestamp: new Date().toISOString(),
                isStreaming: true,
                runId,
                branchId,
                runStatus: "streaming",
            };
        addMessage(sessionId, message);
        streamingMessageId.value[sessionId] = id;
        setSessionRunState(sessionId, "thinking", runId);
        return id;
    }

    type ToolCallUpsert = Partial<ToolCall> & Pick<ToolCall, "id">;

    /**
     * PLAN-0342 T1.5: merge SSE tool events into the live assistant message so
     * MessageItem/ToolCallCard render the real path. `tool_call` inserts
     * `running`, `tool_result` moves it to `completed`/`failed` with
     * result/diagnostics. Tool-first runs have no token yet, so the live
     * message is created on demand.
     */
    function upsertToolCall(sessionId: string, call: ToolCallUpsert) {
        const messageId = streamingMessageId.value[sessionId] ?? createStreamingMessage(sessionId),
            message = messages.value[sessionId]?.find((msg) => msg.id === messageId);
        if (!message) return;

        if (!message.toolCalls) {
            message.toolCalls = [];
        }
        const incomingIds = [call.id, call.runId].filter(
            (value): value is string => typeof value === "string" && value !== "",
        );
        // PLAN-0342 review fix: `tool_call` carries the tool-run id while
        // `tool_result` carries the model's tool_call_id; both share `run_id`,
        // so merge on either key to avoid a ghost "running" card.
        const existing = message.toolCalls.find(
            (tc) =>
                incomingIds.includes(tc.id) ||
                (typeof tc.runId === "string" && incomingIds.includes(tc.runId)),
        );
        if (existing) {
            // Keep the first-seen id stable so both wire ids keep merging into the
            // same card; only enrich with the result payload.
            const { id: _ignoredId, runId: _ignoredRunId, ...rest } = call;
            Object.assign(existing, rest);
            if (!existing.runId && call.runId) {
                existing.runId = call.runId;
            }
            return;
        }
        message.toolCalls.push({ name: "", arguments: "", status: "running", ...call });
    }

    function appendToParts(sessionId: string, part: MessagePart) {
        const messageId = streamingMessageId.value[sessionId];
        if (!messageId) return;

        const msgs = messages.value[sessionId],
            message = msgs?.find((msg) => msg.id === messageId);
        if (!message) return;

        if (!message.parts) {
            message.parts = [];
        }

        if (part.type === "text") {
            const lastText =
                message.parts.length > 0 ? message.parts[message.parts.length - 1] : null;
            if (lastText?.type === "text") {
                lastText.content += part.content;
                return;
            }
        }

        if (part.type === "reasoning") {
            const lastReasoning =
                message.parts.length > 0 ? message.parts[message.parts.length - 1] : null;
            if (lastReasoning?.type === "reasoning") {
                lastReasoning.content += part.content;
                return;
            }
        }

        if (part.type === "artifact") {
            const lastArtifact =
                message.parts.length > 0 ? message.parts[message.parts.length - 1] : null;
            if (lastArtifact?.type === "artifact" && lastArtifact.identifier === part.identifier) {
                lastArtifact.content += part.content;
                return;
            }
        }

        message.parts.push(part);
    }

    function replaceStreamingParts(sessionId: string, nextParts: MessagePart[]) {
        const messageId = streamingMessageId.value[sessionId];
        if (!messageId) return;

        const message = messages.value[sessionId]?.find((msg) => msg.id === messageId);
        if (!message) return;

        message.parts = [...nextParts];
    }

    function finalizeStreaming(sessionId: string) {
        const messageId = streamingMessageId.value[sessionId];
        if (!messageId) {
            setSessionRunState(sessionId, "idle");
            return;
        }

        const message = messages.value[sessionId]?.find((msg) => msg.id === messageId);
        if (message) {
            message.isStreaming = false;
            message.runStatus = "succeeded";
            message.terminalOutcome = "success";
            if (message.parts) {
                message.content = message.parts
                    .filter((p) => p.type === "text")
                    .map((p) => p.content)
                    .join("");
            }
        }

        streamingMessageId.value[sessionId] = null;
        setSessionRunState(sessionId, "idle");
    }

    function cancelStreaming(sessionId: string, runId: string) {
        const messageId = streamingMessageId.value[sessionId];
        const message = messages.value[sessionId]?.find((msg) => msg.id === messageId);
        if (message && message.runId && message.runId !== runId) return;
        if (message) {
            if (!messageHasRenderableContent(message)) {
                messages.value[sessionId] = messages.value[sessionId].filter(
                    (msg) => msg.id !== messageId,
                );
            } else {
                message.isStreaming = false;
                message.runStatus = "cancelled";
                message.terminalOutcome = "cancelled";
                message.toolCalls = message.toolCalls?.map((toolCall) =>
                    toolCall.status === "running" || toolCall.status === "pending"
                        ? { ...toolCall, status: "cancelled" }
                        : toolCall,
                );
                if (message.parts) {
                    message.content = message.parts
                        .filter((part) => part.type === "text")
                        .map((part) => part.content)
                        .join("");
                }
            }
        }
        streamingMessageId.value[sessionId] = null;
        setSessionRunState(sessionId, "idle");
    }

    /**
     * PLAN-0341 U3 case B: overflow retry keeps prior visible content but marks
     * it interrupted so the retry's new reply is the official answer.
     * Case A (no visible content): drop the empty streaming bubble.
     */
    function interruptForOverflowRetry(sessionId: string) {
        const messageId = streamingMessageId.value[sessionId];
        if (!messageId) return;

        const message = messages.value[sessionId]?.find((msg) => msg.id === messageId);
        if (message) {
            const hasContent = messageHasRenderableContent(message);
            if (!hasContent) {
                messages.value[sessionId] = messages.value[sessionId].filter(
                    (msg) => msg.id !== messageId,
                );
            } else {
                message.isStreaming = false;
                message.runStatus = "interrupted";
                message.interrupted = true;
                message.terminalOutcome = "partial";
                if (message.parts) {
                    message.content = message.parts
                        .filter((p) => p.type === "text")
                        .map((p) => p.content)
                        .join("");
                }
                addMarker(sessionId, {
                    role: "system",
                    content: "interrupted",
                    timestamp: new Date().toISOString(),
                    marker: "status",
                    status: "interrupted",
                });
            }
        }
        streamingMessageId.value[sessionId] = null;
        setSessionRunState(sessionId, "idle");
    }

    function markStreamingError(
        sessionId: string,
        error: {
            code: string;
            detail: string;
            runId?: string;
            retryable?: boolean;
            outcome?: string;
        },
    ) {
        const messageId = streamingMessageId.value[sessionId];
        if (!messageId) return;

        const message = messages.value[sessionId]?.find((msg) => msg.id === messageId);
        if (message) {
            // Tool cards are renderable content: keep a tool-only bubble (with its
            // diagnostics) alive, but only assistant text counts as "partial".
            const hasTextContent = Boolean(
                    message.content ||
                    message.parts?.some(
                        (part) => part.type !== "citation" && Boolean(part.content),
                    ),
                ),
                hasRenderableContent = hasTextContent || Boolean(message.toolCalls?.length);
            if (!hasRenderableContent) {
                messages.value[sessionId] = messages.value[sessionId].filter(
                    (msg) => msg.id !== messageId,
                );
                streamingMessageId.value[sessionId] = null;
                setSessionRunState(sessionId, "idle");
                if (error.runId) void refreshRunRecovery(sessionId, error.runId);
                return;
            }
            message.isStreaming = false;
            message.errorCode = error.code;
            message.error = error.detail;
            message.retryable = error.retryable ?? true;
            message.runId = error.runId ?? message.runId;
            const ambiguous = error.outcome === "ambiguous",
                partial = !ambiguous && (hasTextContent || error.outcome === "partial");
            message.runStatus = ambiguous ? "ambiguous" : partial ? "partial" : "failed";
            message.terminalOutcome = ambiguous ? "ambiguous" : partial ? "partial" : "error";
            if (message.parts) {
                message.content = message.parts
                    .filter((part) => part.type === "text")
                    .map((part) => part.content)
                    .join("");
            }
        }

        streamingMessageId.value[sessionId] = null;
        setSessionRunState(sessionId, "idle");
        if (error.runId) void refreshRunRecovery(sessionId, error.runId);
    }

    const runRecovery = ref<Record<string, RunRecovery | undefined>>({}),
        recoveryGenerations = new Map<string, number>(),
        recoveryRunIds = new Map<string, string>();
    let recoveryGeneration = 0;

    // PLAN-292 M3 (C2): ask the CP what actually happened to the run behind a
    // dead SSE stream. Server truth decides the banner; never fabricate a state.
    async function refreshRunRecovery(sessionId: string, runId: string): Promise<void> {
        const requestGeneration = ++recoveryGeneration;
        recoveryGenerations.set(sessionId, requestGeneration);
        recoveryRunIds.set(sessionId, runId);
        const isCurrent = () => recoveryGenerations.get(sessionId) === requestGeneration;
        try {
            const res = await api.getChatRunStatus(runId);
            if (!isCurrent() || res.sessionId !== sessionId || res.runId !== runId) return;
            const agentStore = useAgentStore();
            if (
                res.status === "awaiting_approval" ||
                (res.status === "running" && !res.leaseExpired)
            ) {
                setSessionRunState(
                    sessionId,
                    res.status === "awaiting_approval" ? "awaiting_approval" : "thinking",
                    runId,
                );
                runRecovery.value[sessionId] = {
                    state: "resumed",
                    runId,
                    message: "会话已恢复，任务仍在执行，待审批操作可继续处理",
                };
                for (const approval of res.pendingApprovals ?? []) {
                    agentStore.addApprovalRequest(approval);
                }
                void agentStore.refreshPendingApprovals();
            } else if (res.status === "failed" && res.terminalOutcome === "ambiguous") {
                // PLAN-292 C1: the relay stream broke while an approval was in
                // flight — the run is failed/ambiguous but the pending decision is
                // still replayable from the server.
                setSessionRunState(sessionId, "awaiting_approval", runId);
                runRecovery.value[sessionId] = {
                    state: "resumed",
                    runId,
                    message: "连接中断，待审批操作仍可继续处理",
                };
                for (const approval of res.pendingApprovals ?? []) {
                    agentStore.addApprovalRequest(approval);
                }
                void agentStore.refreshPendingApprovals();
            } else if (
                ["cancelling", "cancelled", "failed", "ambiguous", "completed"].includes(res.status)
            ) {
                if (res.status === "cancelling" || res.status === "cancelled") {
                    cancelStreaming(sessionId, runId);
                }
                agentStore.resolveApprovalsForRun(
                    sessionId,
                    runId,
                    res.status === "cancelling" || res.status === "cancelled"
                        ? "expired"
                        : "dispatch_unknown",
                );
                if (res.status === "cancelling" || res.status === "cancelled") {
                    await agentStore.refreshPendingApprovals();
                }
                setSessionRunState(sessionId, "idle");
                runRecovery.value[sessionId] = {
                    state: "cancelled",
                    runId,
                    message: "任务已取消或结束，未完成的执行不会继续",
                };
            } else if (res.status === "running" && res.leaseExpired) {
                agentStore.resolveApprovalsForRun(sessionId, runId);
                setSessionRunState(sessionId, "idle");
                runRecovery.value[sessionId] = {
                    state: "retry",
                    runId,
                    message: "任务执行租约已过期，请重试",
                };
            } else {
                // succeeded — history already shows the final message, no banner.
                agentStore.resolveApprovalsForRun(sessionId, runId);
                setSessionRunState(sessionId, "idle");
                delete runRecovery.value[sessionId];
            }
        } catch (cause) {
            if (!isCurrent()) return;
            if (
                cause instanceof ApiError &&
                (cause.problem.status === 401 || cause.problem.status === 403)
            ) {
                logger.warn("Chat run recovery authorization failed", cause);
                useAgentStore().reset();
                delete runRecovery.value[sessionId];
                return;
            }
            logger.warn("Failed to refresh chat run recovery", cause);
            runRecovery.value[sessionId] = {
                state: "retry",
                runId,
                message: "无法确认任务状态，请重试",
            };
        }
    }

    function dismissRunRecovery(sessionId: string) {
        if (recoveryRunIds.has(sessionId) || runRecovery.value[sessionId]) {
            recoveryGeneration += 1;
            recoveryGenerations.set(sessionId, recoveryGeneration);
            recoveryRunIds.delete(sessionId);
        }
        delete runRecovery.value[sessionId];
    }

    function invalidateRunRecovery(sessionId: string, runId: string) {
        const activeRunId = recoveryRunIds.get(sessionId) ?? runRecovery.value[sessionId]?.runId;
        if (activeRunId !== runId) return;
        recoveryGeneration += 1;
        recoveryGenerations.set(sessionId, recoveryGeneration);
        recoveryRunIds.delete(sessionId);
        delete runRecovery.value[sessionId];
        setSessionRunState(sessionId, "idle");
    }

    function clearSession(sessionId: string) {
        delete messages.value[sessionId];
        clearSessionBranches(sessionId);
        delete streamingMessageId.value[sessionId];
        delete sessionRunStates.value[sessionId];
        delete runRecovery.value[sessionId];
        recoveryGenerations.delete(sessionId);
        recoveryRunIds.delete(sessionId);
    }

    function deleteSession(sessionId: string) {
        clearSession(sessionId);
    }

    function clearAllData() {
        for (const key of XIHE_STORAGE_KEYS) {
            try {
                localStorage.removeItem(key);
            } catch {
                // ignore
            }
        }
        messages.value = {};
        sessionBranches.value = {};
        selectedBranchIds.value = {};
        for (const sessionId of new Set([...branchVersions.keys(), ...branchLoadPromises.keys()])) {
            branchVersions.set(sessionId, (branchVersions.get(sessionId) ?? 0) + 1);
        }
        branchLoadPromises.clear();
        streamingMessageId.value = {};
        sessionRunStates.value = {};
        sessionLastUsage.value = {};
        runRecovery.value = {};
        recoveryGeneration += 1;
        recoveryGenerations.clear();
        recoveryRunIds.clear();
    }

    function clearForUserSwitch() {
        messages.value = {};
        sessionBranches.value = {};
        selectedBranchIds.value = {};
        for (const sessionId of new Set([...branchVersions.keys(), ...branchLoadPromises.keys()])) {
            branchVersions.set(sessionId, (branchVersions.get(sessionId) ?? 0) + 1);
        }
        branchLoadPromises.clear();
        streamingMessageId.value = {};
        sessionRunStates.value = {};
        sessionLastUsage.value = {};
        runRecovery.value = {};
        recoveryGeneration += 1;
        recoveryGenerations.clear();
        recoveryRunIds.clear();
    }

    return {
        messages,
        streamingMessageId,
        sessionRunStates,
        runRecovery,
        getMessages,
        getSessionBranches,
        getSelectedBranchId,
        setSessionBranches,
        selectBranch,
        loadSessionBranches,
        clearSessionBranches,
        getStreamingMessageId,
        getSessionRunState,
        getSessionRunId,
        setSessionRunState,
        getSessionLastUsage,
        setSessionLastUsage,
        isStreaming,
        addMessage,
        loadMessages,
        detachLiveSession,
        deleteMessage,
        addMarker,
        createStreamingMessage,
        upsertToolCall,
        appendToParts,
        replaceStreamingParts,
        finalizeStreaming,
        interruptForOverflowRetry,
        markStreamingError,
        refreshRunRecovery,
        dismissRunRecovery,
        invalidateRunRecovery,
        clearSession,
        deleteSession,
        clearAllData,
        clearForUserSwitch,
    };
});
