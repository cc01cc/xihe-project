<script setup lang="ts">
import { computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useSSE, type SSEErrorPayload } from "../composables/useSSE.ts";
import { useStreamParser } from "../composables/useStreamParser.ts";
import { useChatStore } from "../stores/chat.ts";
import { useAgentStore } from "../../../../stores/agent";
import { useConfigStore } from "../../../../stores/config";
import { useWorkspaceAgentSync } from "../../composables/useWorkspaceAgentSync";
import { toast } from "vue-sonner";
import { logger } from "../../../../lib/logger";
import { chatErrorToastText } from "../../../../lib/errorMessages";
import { api } from "../../../../composables/api";
import type { ChatRunResponse, ChatRunUsage } from "../../../../types";

const props = withDefaults(
    defineProps<{
        sessionId: string;
        active: boolean;
        toolMode?: "none" | "workspace";
    }>(),
    {
        toolMode: "none",
    },
);
const emit = defineEmits<{
    derivedStateRefresh: [];
}>();

const chatStore = useChatStore(),
    agentStore = useAgentStore(),
    configStore = useConfigStore();
const { t } = useI18n();
const { handleToolCall, handleToolResult } = useWorkspaceAgentSync();

const { isConnected, isStreaming, connect, sendMessage, disconnect } = useSSE(
    computed(() => props.sessionId),
);
let activeRunId: string | undefined, activeBranchId: string | undefined;
/**
 * PLAN-0631 D31-08: the run's responder as CP attributed it (SSE envelope `participantId`).
 * Constant for a run, so it is remembered once and stamped onto the live message — the
 * citation is never derived from `role` or the session's PRIMARY participant.
 */
let activeResponderId: string | null = null;

watch(
    () => props.sessionId,
    (id) => {
        activeRunId = undefined;
        activeBranchId = undefined;
        activeResponderId = null;
        if (id) {
            connectSession(id);
        }
    },
    { immediate: true },
);

function connectSession(id: string) {
    const parser = useStreamParser();
    let terminalError: SSEErrorPayload | null = null;
    const isCurrentSession = () => props.sessionId === id;
    connect({
        onOpen: () => {
            if (isCurrentSession()) emit("derivedStateRefresh");
        },
        onDerivedStateChanged: () => {
            if (isCurrentSession()) emit("derivedStateRefresh");
        },
        onParticipant: (participantId: string | null) => {
            if (!isCurrentSession() || participantId === null) return;
            activeResponderId = participantId;
            chatStore.setStreamingMessageResponder(id, participantId);
        },
        onStart: () => {
            if (!isCurrentSession()) return;
            parser.reset();
            chatStore.createStreamingMessage(id, activeRunId, activeBranchId);
            // The attribution usually arrives on the very first event of the run, i.e.
            // before this callback — stamp it now that the live message exists.
            if (activeResponderId !== null) {
                chatStore.setStreamingMessageResponder(id, activeResponderId);
            }
        },
        onToken: (token: string, hint?) => {
            if (!isCurrentSession()) return;
            if (hint === "reasoning") {
                chatStore.appendToParts(id, { type: "reasoning", content: token });
                return;
            }
            if (hint === "text") {
                chatStore.appendToParts(id, { type: "text", content: token });
                return;
            }
            parser.handleToken(token, hint);
            chatStore.replaceStreamingParts(id, parser.parts.value);
        },
        onStatus: (status: string) => {
            if (!isCurrentSession()) return;
            const nextStatus =
                status === "thinking" ||
                status === "executing" ||
                status === "awaiting_approval" ||
                status === "error"
                    ? status
                    : "idle";
            chatStore.setSessionRunState(id, nextStatus, activeRunId);
            agentStore.setStatus(nextStatus);
            if (status === "thinking" || status === "executing") {
                // PLAN-0631 D31-07: one live status line per run, updated in place —
                // a status event per transition used to append a permanent marker each
                // time (a long run left a dozen "Thinking/Executing" rows behind).
                chatStore.upsertRunStatusMarker(id, status, activeRunId);
            }
        },
        onDone: (outcome?: string) => {
            if (!isCurrentSession()) return;
            parser.finalize();
            if (parser.parts.value.length > 0) {
                chatStore.replaceStreamingParts(id, parser.parts.value);
            }
            if (outcome === "error" || outcome === "partial" || outcome === "ambiguous") {
                chatStore.markStreamingError(
                    id,
                    terminalError ?? {
                        code:
                            outcome === "ambiguous"
                                ? "AGENT_STREAM_AMBIGUOUS"
                                : "AGENT_STREAM_FAILED",
                        detail:
                            outcome === "ambiguous"
                                ? "The provider result is uncertain; retry requires confirmation"
                                : "Agent stream failed",
                        runId: activeRunId,
                        retryable: outcome !== "ambiguous",
                        outcome,
                    },
                );
            } else {
                chatStore.finalizeStreaming(id);
            }
            agentStore.setStatus("idle");
            chatStore.setSessionRunState(id, "idle");
            activeRunId = undefined;
            activeBranchId = undefined;
            activeResponderId = null;
        },
        onError: (payload: SSEErrorPayload) => {
            if (!isCurrentSession()) return;
            terminalError = payload;
            chatStore.markStreamingError(id, payload);
            agentStore.setStatus("error");
            chatStore.setSessionRunState(id, "error", activeRunId);
            activeRunId = undefined;
            activeResponderId = null;
            toast.error(chatErrorToastText(payload.code, payload.detail));
        },
        onApprovalRequest: (data) => {
            if (!isCurrentSession()) return;
            if (data.state !== undefined && data.state !== "pending") return;
            chatStore.setSessionRunState(id, "awaiting_approval", activeRunId);
            agentStore.setStatus("awaiting_approval");
        },
        onToolResult: (data) => {
            if (!isCurrentSession()) return;
            const toolName = typeof data.tool === "string" ? data.tool : data.name;
            if (toolName === "spawn_agent") emit("derivedStateRefresh");
            if (typeof toolName === "string") handleToolResult(toolName);
        },
        onContextSourcesChanged: (data) => {
            if (!isCurrentSession()) return;
            // PLAN-0340 U2: low-disturbance toast; env date/HEAD changes never land here.
            toast.info(`${t("chat.contextSourcesTitle")}: ${t("chat.contextSourcesUpdated")}`, {
                description: data.sourceKey ?? "AGENTS.md",
            });
        },
        onContextOverflowRetry: (data) => {
            if (!isCurrentSession()) return;
            // PLAN-0341 U3 case B: fold prior visible content as interrupted so the
            // retry reply is the official answer (decision #2 ③).
            chatStore.interruptForOverflowRetry(id);
            toast.info(t("chat.contextOverflowRetry"), {
                description: data.runId ? `run ${data.runId.slice(0, 8)}` : undefined,
            });
        },
        onContextCompactionCircuit: (data) => {
            if (!isCurrentSession()) return;
            // PLAN-0341 U4: circuit open pauses auto-compaction; close restores it.
            if (data.state === "open") {
                toast.warning(t("chat.contextCompactionCircuitOpen"));
            } else if (data.state === "closed") {
                toast.info(t("chat.contextCompactionCircuitClosed"));
            }
        },
        onUsage: (data) => {
            if (!isCurrentSession()) return;
            // PLAN-0343: keep the latest run-terminal usage snapshot for the
            // session-header usage line.
            chatStore.setSessionLastUsage(id, data as ChatRunUsage);
        },
        onToolCall: (name: string, args: Record<string, unknown>) => {
            if (!isCurrentSession()) return;
            chatStore.setSessionRunState(id, "executing", activeRunId);
            handleToolCall(name, args);
        },
    });
}

async function handleSend(
    content: string,
    options: {
        branchId: string;
        attachments?: string[];
        toolMode?: "none" | "workspace";
        agentPrincipalId?: string;
        /** D23-27："代发" —— 以该参与者身份发言（`speakAs` 能力 + 契约字段 `asParticipantId`）。 */
        asParticipantId?: string;
    },
): Promise<ChatRunResponse | null> {
    const sessionId = props.sessionId;
    if (!sessionId) return null;
    activeBranchId = options.branchId;

    if (!isConnected.value) {
        connectSession(sessionId);
        const ready = await waitForConnection(5000);
        if (!ready) {
            const msg = "SSE connection not established";
            logger.warn(msg);
            agentStore.setStatus("idle");
            chatStore.setSessionRunState(sessionId, "idle");
            toast.error(msg);
            return null;
        }
    }

    const binding = configStore.getEffectiveModel(sessionId),
        model = binding?.model ?? "";
    const result = await sendMessage({
        content,
        branchId: options.branchId,
        model,
        provider: binding?.provider,
        toolMode: options?.toolMode ?? props.toolMode,
        idempotencyKey: crypto.randomUUID(),
        sessionId,
        attachments: options?.attachments,
        agentPrincipalId: options?.agentPrincipalId,
        asParticipantId: options?.asParticipantId,
    });
    if (props.sessionId !== sessionId) return null;
    if (result) {
        activeRunId = result.runId;
        // The run exists and keeps the composer in stop/queue mode — that part is true.
        chatStore.setSessionRunState(sessionId, "thinking", result.runId);
        agentStore.setStatus("thinking");
        // PLAN-0631 D31-04 (P0): CP parks the Run instead of dispatching it when the
        // Agent is down but the LLM is ready — `202 {status:"queued", reason:"agent_down"}`
        // (ChatController persistRunStatus("queued")). Nothing executes and no SSE will
        // arrive until recovery, so the user used to sit in "stop/queue mode" forever
        // with no explanation. Record the parked view so the chat explains itself;
        // `createStreamingMessage` clears it the moment real work starts.
        if (result.status === "queued") {
            chatStore.setRunQueued(sessionId, { runId: result.runId, reason: result.reason });
        } else {
            chatStore.clearRunQueued(sessionId);
        }
    } else {
        activeBranchId = undefined;
    }
    return result;
}

function waitForConnection(timeoutMs: number): Promise<boolean> {
    if (isConnected.value) return Promise.resolve(true);
    return new Promise((resolve) => {
        const start = Date.now();
        const check = () => {
            if (isConnected.value) return resolve(true);
            if (Date.now() - start > timeoutMs) return resolve(false);
            setTimeout(check, 100);
        };
        check();
    });
}

function stopStreaming() {
    const sessionId = props.sessionId,
        runId = activeRunId ?? chatStore.getSessionRunId(sessionId);
    activeRunId = undefined;
    if (runId && sessionId === props.sessionId) {
        void api
            .cancelChatRun(runId)
            .catch((error) => logger.warn("Failed to cancel chat run:", error))
            .then(() => chatStore.refreshRunRecovery(sessionId, runId))
            .catch((error) => logger.warn("Failed to reconcile cancelled chat run:", error));
    }
    disconnect();
    chatStore.setSessionRunState(sessionId, "idle");
    agentStore.setStatus("idle");
}

defineExpose({ sendMessage: handleSend, stopStreaming, isConnected, isStreaming });
</script>

<template></template>
