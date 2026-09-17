import { ref, onUnmounted, getCurrentInstance, toValue, type MaybeRefOrGetter } from "vue";
import { getActivePinia } from "pinia";
import { useAgentStore } from "../stores/agent";
import { useCheckpointStore } from "../stores/checkpoint";
import { logger } from "../lib/logger";
import { chatTransport } from "../services/chatTransport";
import {
    ApiError,
    apiAuthHeaders,
    apiRaw,
    normalizeApprovalRequest,
    normalizeWorkspaceCheckpointEvent,
} from "./api";
import type { EventSourceMessage } from "@microsoft/fetch-event-source";
import type { ChatRunResponse } from "../types";

interface LangChainTextBlock {
    type: string;
    text?: string;
}

function normalizeTokenContent(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .map((block: unknown) => {
                if (typeof block === "string") return block;
                const b = block as LangChainTextBlock;
                if (b.type === "text" && typeof b.text === "string") return b.text;
                return "";
            })
            .join("");
    }
    return "";
}

export interface SSECallbacks {
    onStart?: () => void;
    onToken?: (token: string, hint?: "reasoning" | "text") => void;
    onToolCall?: (name: string, args: Record<string, unknown>) => void;
    onToolResult?: (data: Record<string, unknown>) => void;
    onApprovalRequest?: (data: Record<string, unknown>) => void;
    onStatus?: (status: string) => void;
    onContextSourcesChanged?: (data: { sourceKey?: string; status?: string }) => void;
    onError?: (error: SSEErrorPayload) => void;
    onDone?: (outcome?: string) => void;
}

export interface SSEErrorPayload {
    code: string;
    detail: string;
    requestId?: string;
    runId?: string;
    provider?: string;
    model?: string;
    retryable?: boolean;
    outcome?: string;
}

export interface SendMessageOptions {
    content: string;
    attachments?: string[];
    model?: string;
    sessionId?: string;
    provider?: string;
    toolMode?: "none" | "workspace";
    idempotencyKey?: string;
}

const STREAM_TIMEOUT_MS = 30000;

function getAgentStoreOrNull() {
    const pinia = getActivePinia();
    return pinia ? useAgentStore(pinia) : null;
}

function getCheckpointStoreOrNull() {
    const pinia = getActivePinia();
    return pinia ? useCheckpointStore(pinia) : null;
}

export function useSSE(sessionId: MaybeRefOrGetter<string>) {
    const agentStore = getAgentStoreOrNull();
    const isConnected = ref(false);
    const isStreaming = ref(false);
    const error = ref<string | null>(null);
    let currentCallbacks: SSECallbacks = {};
    let streamTimeout: ReturnType<typeof setTimeout> | null = null;
    let connectionErrorReported = false;
    let activeSessionId: string | null = null;
    let contentStarted = false;
    let connectionGeneration = 0;
    let activeApprovalEpoch: string | null = null;

    function asErrorPayload(error: unknown, fallbackCode = "AGENT_STREAM_FAILED"): SSEErrorPayload {
        if (error instanceof ApiError) {
            return {
                code: error.problem.code,
                detail: error.problem.detail ?? error.message,
                requestId: error.problem.requestId,
                runId: error.problem.runId,
                provider: error.problem.provider,
                model: error.problem.model,
                retryable: error.problem.retryable,
                outcome: error.problem.outcome,
            };
        }
        return {
            code: fallbackCode,
            detail: error instanceof Error ? error.message : String(error),
            retryable: true,
            outcome: "error",
        };
    }

    function errorText(error: SSEErrorPayload): string {
        return error.detail ? `${error.code}: ${error.detail}` : error.code;
    }

    function resetStreamTimeout() {
        if (!isStreaming.value) return;
        if (streamTimeout) clearTimeout(streamTimeout);
        const approvalEpoch = activeApprovalEpoch;
        streamTimeout = setTimeout(() => {
            if (
                isStreaming.value &&
                approvalEpoch !== null &&
                activeSessionId !== null &&
                agentStore?.isApprovalEpochCurrent(activeSessionId, approvalEpoch)
            ) {
                isStreaming.value = false;
                const timeoutError: SSEErrorPayload = {
                    code: "AGENT_TIMEOUT",
                    detail: "Agent stream timed out",
                    retryable: true,
                    outcome: contentStarted ? "ambiguous" : "error",
                };
                error.value = errorText(timeoutError);
                currentCallbacks.onError?.(timeoutError);
                currentCallbacks.onDone?.(timeoutError.outcome);
            }
        }, STREAM_TIMEOUT_MS);
    }

    function clearStreamTimeout() {
        if (streamTimeout) {
            clearTimeout(streamTimeout);
            streamTimeout = null;
        }
    }

    function handleMessage(msg: EventSourceMessage) {
        if (
            activeSessionId !== null &&
            activeApprovalEpoch !== null &&
            !agentStore?.isApprovalEpochCurrent(activeSessionId, activeApprovalEpoch)
        )
            return;
        switch (msg.event) {
            case "token":
                try {
                    const data = JSON.parse(msg.data) as { content?: unknown; hint?: string };
                    const content = normalizeTokenContent(data.content);
                    const hint =
                        data.hint === "reasoning" || data.hint === "text" ? data.hint : undefined;
                    if (content) {
                        if (!contentStarted) {
                            contentStarted = true;
                            isStreaming.value = true;
                            currentCallbacks.onStart?.();
                        }
                        resetStreamTimeout();
                        currentCallbacks.onToken?.(content, hint);
                    }
                } catch {
                    logger.warn("Failed to parse SSE token event");
                }
                break;

            case "heartbeat":
                resetStreamTimeout();
                break;

            case "tool_call":
                resetStreamTimeout();
                try {
                    const data = JSON.parse(msg.data) as Record<string, unknown>;
                    if (data.name) {
                        agentStore?.addToolCall({
                            id: String(data.id ?? crypto.randomUUID()),
                            name: String(data.name),
                            arguments:
                                typeof data.arguments === "string"
                                    ? data.arguments
                                    : JSON.stringify(data.arguments),
                            status: "running",
                        });
                    }
                    currentCallbacks.onToolCall?.(
                        String(data.name),
                        (data.arguments ?? {}) as Record<string, unknown>,
                    );
                } catch {
                    logger.warn("Failed to parse SSE tool_call event");
                }
                break;

            case "tool_result":
                resetStreamTimeout();
                try {
                    const data = JSON.parse(msg.data) as Record<string, unknown>;
                    if (data.id) {
                        agentStore?.updateToolCall(String(data.id), {
                            result:
                                typeof data.result === "string"
                                    ? data.result
                                    : JSON.stringify(data.result),
                            status: "completed",
                        });
                    }
                    currentCallbacks.onToolResult?.(data);
                } catch {
                    logger.warn("Failed to parse SSE tool_result event");
                }
                break;

            case "approval_request":
                resetStreamTimeout();
                try {
                    const data = JSON.parse(msg.data) as Record<string, unknown>;
                    const approval = normalizeApprovalRequest(data, activeSessionId ?? "");
                    if (approval) {
                        agentStore?.addApprovalRequest(approval);
                        if (agentStore) void agentStore.refreshPendingApprovals();
                    }
                    currentCallbacks.onApprovalRequest?.(data);
                } catch {
                    logger.warn("Failed to parse SSE approval_request event");
                }
                break;

            case "status":
                resetStreamTimeout();
                try {
                    const data = JSON.parse(msg.data) as { status?: string };
                    if (data.status) {
                        currentCallbacks.onStatus?.(data.status);
                    }
                } catch {
                    logger.warn("Failed to parse SSE status event");
                }
                break;

            // The workspace checkpoint list is durable; this event only refreshes the local slice marker.
            case "run_checkpoint":
                resetStreamTimeout();
                try {
                    const data = JSON.parse(msg.data) as Record<string, unknown>;
                    const event = normalizeWorkspaceCheckpointEvent(data, activeSessionId ?? "");
                    if (event) getCheckpointStoreOrNull()?.mergeEvent(event);
                } catch {
                    logger.warn("Failed to parse SSE run_checkpoint event");
                }
                break;

            case "error":
                isStreaming.value = false;
                clearStreamTimeout();
                try {
                    const data = JSON.parse(msg.data) as {
                        error?: string;
                        details?: string;
                        detail?: string;
                        code?: string;
                        requestId?: string;
                        runId?: string;
                        provider?: string;
                        model?: string;
                        retryable?: boolean;
                        outcome?: string;
                    };
                    const payload: SSEErrorPayload = {
                        code: data.code ?? "AGENT_STREAM_FAILED",
                        detail: data.detail ?? data.error ?? data.details ?? "Unknown error",
                        requestId: data.requestId,
                        runId: data.runId,
                        provider: data.provider,
                        model: data.model,
                        retryable: data.retryable,
                        outcome: data.outcome ?? (contentStarted ? "partial" : "error"),
                    };
                    error.value = errorText(payload);
                    currentCallbacks.onError?.(payload);
                } catch {
                    logger.warn("Failed to parse SSE error event payload");
                    const payload: SSEErrorPayload = {
                        code: "AGENT_STREAM_FAILED",
                        detail: "Unknown error",
                        retryable: true,
                        outcome: contentStarted ? "partial" : "error",
                    };
                    error.value = errorText(payload);
                    currentCallbacks.onError?.(payload);
                }
                break;

            case "done":
                isStreaming.value = false;
                clearStreamTimeout();
                try {
                    const data = msg.data ? (JSON.parse(msg.data) as { outcome?: string }) : {};
                    currentCallbacks.onDone?.(data.outcome);
                } catch {
                    logger.warn("Failed to parse SSE done event payload");
                    currentCallbacks.onDone?.();
                }
                break;

            case "context_sources_changed":
                // PLAN-0340 U2: AGENTS.md chain updated (env changes are silent).
                try {
                    const data = JSON.parse(msg.data) as {
                        sourceKey?: string;
                        status?: string;
                    };
                    currentCallbacks.onContextSourcesChanged?.(data);
                } catch {
                    logger.warn("Failed to parse context_sources_changed payload");
                }
                break;

            default:
                break;
        }
    }

    function connect(callbacks: SSECallbacks = {}) {
        disconnect();
        const generation = ++connectionGeneration;
        currentCallbacks = callbacks;
        contentStarted = false;

        const currentSessionId = toValue(sessionId);
        activeSessionId = currentSessionId;
        activeApprovalEpoch = agentStore?.getApprovalEpoch(currentSessionId) ?? null;

        const url = `/api/v1/events?sessionId=${encodeURIComponent(currentSessionId)}`;

        chatTransport
            .sendMessages(currentSessionId, {
                url,
                headers: apiAuthHeaders(undefined, false),
                onopen: () => {
                    if (generation !== connectionGeneration) return;
                    isConnected.value = true;
                    error.value = null;
                    connectionErrorReported = false;
                },
                onmessage: (message) => {
                    if (generation === connectionGeneration) handleMessage(message);
                },
                onerror: (err) => {
                    if (generation !== connectionGeneration) return;
                    const msg = err.message || "SSE connection error";
                    logger.warn("useSSE connection error", err);
                    error.value = msg;
                },
                onclose: () => {
                    if (generation !== connectionGeneration) return;
                    isConnected.value = false;
                },
            })
            .catch((err: Error) => {
                if (generation !== connectionGeneration) return;
                if (err.name === "AbortError") return;
                logger.warn("useSSE connect failed", err);
                const payload = asErrorPayload(err, "SSE_CONNECTION_FAILED");
                error.value = errorText(payload);
                if (!connectionErrorReported) {
                    connectionErrorReported = true;
                    currentCallbacks.onError?.(payload);
                }
            });
    }

    function disconnect() {
        connectionGeneration += 1;
        const sessionToStop = activeSessionId ?? toValue(sessionId);
        chatTransport.stop(sessionToStop);
        activeSessionId = null;
        activeApprovalEpoch = null;
        isConnected.value = false;
        isStreaming.value = false;
        contentStarted = false;
        clearStreamTimeout();
    }

    async function sendMessage({
        content,
        attachments,
        model,
        provider,
        toolMode,
        idempotencyKey,
        sessionId: overrideSid,
    }: SendMessageOptions): Promise<ChatRunResponse | null> {
        const generation = connectionGeneration;
        error.value = null;
        contentStarted = false;
        const sid = overrideSid ?? toValue(sessionId);
        const approvalEpoch = agentStore?.getApprovalEpoch(sid) ?? null;

        try {
            const body: Record<string, unknown> = {
                content,
                sessionId: sid,
                stream: true,
            };
            if (model) {
                body.model = model;
            }
            if (provider) {
                body.provider = provider;
            }
            body.toolMode = toolMode ?? "none";
            if (attachments && attachments.length > 0) {
                body.attachments = attachments;
            }

            const response = await apiRaw("/chat", {
                method: "POST",
                headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
                body: JSON.stringify(body),
            });
            const result = (await response.json()) as ChatRunResponse;
            if (
                generation !== connectionGeneration ||
                (approvalEpoch !== null && !agentStore?.isApprovalEpochCurrent(sid, approvalEpoch))
            )
                return null;
            isStreaming.value = true;
            resetStreamTimeout();
            return result;
        } catch (err) {
            if (
                generation !== connectionGeneration ||
                (approvalEpoch !== null && !agentStore?.isApprovalEpochCurrent(sid, approvalEpoch))
            )
                return null;
            const payload = asErrorPayload(err);
            logger.error("Failed to send message via SSE: " + errorText(payload));
            error.value = errorText(payload);
            isStreaming.value = false;
            currentCallbacks.onError?.(payload);
            return null;
        }
    }

    if (getCurrentInstance()) {
        onUnmounted(() => {
            disconnect();
        });
    }

    return {
        isConnected,
        isStreaming,
        error,
        connect,
        disconnect,
        sendMessage,
    };
}
