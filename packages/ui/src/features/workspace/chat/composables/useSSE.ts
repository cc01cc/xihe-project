import { ref, onUnmounted, getCurrentInstance, toValue, type MaybeRefOrGetter } from "vue";
import { getActivePinia } from "pinia";
import { i18n } from "../../../../i18n";
import { useAgentStore } from "../../../../stores/agent";
import { useCheckpointStore } from "../../../../stores/checkpoint";
import { useChatStore } from "../stores/chat.ts";
import { logger } from "../../../../lib/logger";
import { normalizeRefusalCode } from "../../../../lib/errorMessages";
import { chatTransport } from "../../../../services/chatTransport";
import { notifySessionConnection, notifySessionEvent } from "../sessionEvents";
import { applyTransportAttempt, applyTransportProgress } from "../transportLive";
import {
    ApiError,
    apiAuthHeaders,
    apiRaw,
    normalizeApprovalRequest,
    normalizeWorkspaceCheckpointEvent,
} from "../../../../composables/api";
import type { EventSourceMessage } from "@microsoft/fetch-event-source";
import type { ChatRunResponse, Diagnostic, DiagnosticsBundle, ToolCall } from "../../../../types";

interface LangChainTextBlock {
    type: string;
    text?: string;
}

/**
 * PLAN-0631 D31-08: read the responder attribution off the SSE envelope.
 *
 * Three outcomes, deliberately distinct:
 *  - a string ⇒ that session participant produced this event;
 *  - `null` ⇒ the event is explicitly producer-less (CP writes `participantId: null`);
 *  - `undefined` ⇒ the key is absent (older CP / non-object payload) ⇒ **unknown**.
 * Unknown must never be turned into PRIMARY (DEV-032), so callers only stamp on a string.
 *
 * The `includes` fast path keeps this off the hot path: token payloads usually have no
 * attribution key, so the common case costs one scan instead of a second `JSON.parse`
 * per token (D31-12: no new per-token work).
 */
export function parseParticipantEnvelope(raw: string): string | null | undefined {
    if (!raw.includes('"participantId"')) return undefined;
    try {
        const data = JSON.parse(raw) as { participantId?: unknown } | null;
        if (!data || typeof data !== "object") return undefined;
        return typeof data.participantId === "string" ? data.participantId : null;
    } catch {
        return undefined;
    }
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
    /** Connection open/reopen is a recovery signal; callers must refetch durable state. */
    onOpen?: () => void;
    /** Event payload is only a refresh hint; do not use it as durable session state. */
    onDerivedStateChanged?: () => void;
    onStart?: () => void;
    onToken?: (token: string, hint?: "reasoning" | "text") => void;
    onToolCall?: (name: string, args: Record<string, unknown>) => void;
    onToolResult?: (data: Record<string, unknown>) => void;
    onApprovalRequest?: (data: Record<string, unknown>) => void;
    onStatus?: (status: string) => void;
    /** PLAN-0631 D31-08: the session participant CP attributed this event to. */
    onParticipant?: (participantId: string | null) => void;
    onContextSourcesChanged?: (data: { sourceKey?: string; status?: string }) => void;
    /** PLAN-0341 U3: overflow compacted + one retry dispatched. */
    onContextOverflowRetry?: (data: {
        runId?: string;
        requestId?: string;
        message?: string;
    }) => void;
    /** PLAN-0341 U4: auto-compaction circuit open/closed. */
    onContextCompactionCircuit?: (data: { state?: string; reason?: string }) => void;
    /** PLAN-0343: run-terminal usage snapshot (cost-mapped by CP, once per run). */
    onUsage?: (data: Record<string, unknown>) => void;
    onError?: (error: SSEErrorPayload) => void;
    onDone?: (outcome?: string) => void;
}

export interface SSEErrorPayload {
    code: string;
    detail: string;
    /** PLAN-0622：429 `RESOURCE_EXHAUSTED` 的等待秒数与资源种类（用于本地化提示）。 */
    retryAfterSeconds?: number;
    resourceKind?: string;
    requestId?: string;
    runId?: string;
    provider?: string;
    model?: string;
    retryable?: boolean;
    outcome?: string;
}

export interface SendMessageOptions {
    content: string;
    branchId: string;
    attachments?: string[];
    model?: string;
    sessionId?: string;
    agentPrincipalId?: string;
    /** D23-27：以某个参与者身份发言。仅 `capabilities.speakAs` 为真时才应由 UI 传入。 */
    asParticipantId?: string;
    /** PLAN-0630 M5b (D30-14)：composer 的 cc 旁听名单（participantId UUID 数组）。 */
    cc?: string[];
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

function getChatStoreOrNull() {
    const pinia = getActivePinia();
    return pinia ? useChatStore(pinia) : null;
}

/**
 * PLAN-0342 T1.5: defensive normalization of the optional `diagnostics` bundle
 * on `tool_result`. Unknown/malformed entries are dropped; an empty item list
 * counts as "no diagnostics" so the card keeps its legacy collapsed shape.
 */
function normalizeDiagnostics(value: unknown): DiagnosticsBundle | undefined {
    if (!value || typeof value !== "object") return undefined;
    const raw = value as { items?: unknown; total?: unknown; confidence?: unknown };
    if (!Array.isArray(raw.items)) return undefined;

    const items: Diagnostic[] = [];
    for (const entry of raw.items) {
        if (!entry || typeof entry !== "object") continue;
        const item = entry as Record<string, unknown>;
        if (typeof item.message !== "string" || item.message.length === 0) continue;
        items.push({
            file: typeof item.file === "string" && item.file.length > 0 ? item.file : null,
            line: typeof item.line === "number" ? item.line : null,
            column: typeof item.column === "number" ? item.column : null,
            severity:
                item.severity === "warning" || item.severity === "note" ? item.severity : "error",
            kind: typeof item.kind === "string" ? item.kind : null,
            message: item.message,
            confidence: item.confidence === "low" ? "low" : "high",
        });
    }
    if (items.length === 0) return undefined;

    const total = typeof raw.total === "number" ? Math.max(raw.total, items.length) : items.length;
    return {
        items,
        total,
        confidence: raw.confidence === "low" ? "low" : "high",
    };
}

const UNTRUSTED_ENVELOPE_RE = /^<untrusted-tool-output>\n[^\n]*\n/;

/**
 * PLAN-0342 review fix: the MCP client prefixes failures with `Tool error:`
 * *inside* the untrusted envelope, so match after stripping the wrapper.
 */
function stripUntrustedEnvelope(result: string): string {
    return result.startsWith("<untrusted-tool-output>")
        ? result.replace(UNTRUSTED_ENVELOPE_RE, "").replace(/\n?<\/untrusted-tool-output>\s*$/, "")
        : result;
}

const TOOL_CALL_STATUSES: ReadonlySet<ToolCall["status"]> = new Set([
    "running",
    "completed",
    "failed",
    "pending",
    "cancelled",
]);

/**
 * PLAN-0649 M3: the Agent now publishes an authoritative `status` on `tool_result`
 * (spec §1), so the event wins over any text inference.
 *
 * The legacy text sniff stays as the fallback for an older Agent — and it is
 * exactly why it must not be the primary source any more: the tool result body is
 * withheld on every surface, so a placeholder could only ever read as "completed".
 */
function toolResultStatus(result: unknown, status?: unknown): ToolCall["status"] {
    if (typeof status === "string" && TOOL_CALL_STATUSES.has(status as ToolCall["status"])) {
        return status as ToolCall["status"];
    }
    if (typeof result !== "string") return "completed";
    return stripUntrustedEnvelope(result).startsWith("Tool error:") ? "failed" : "completed";
}

export function useSSE(sessionId: MaybeRefOrGetter<string>) {
    const agentStore = getAgentStoreOrNull(),
        isConnected = ref(false),
        isStreaming = ref(false),
        error = ref<string | null>(null);
    let currentCallbacks: SSECallbacks = {},
        streamTimeout: ReturnType<typeof setTimeout> | null = null,
        connectionErrorReported = false,
        activeSessionId: string | null = null,
        contentStarted = false,
        /** `runId` of the run whose assistant bubble this connection is currently feeding. */
        scopeRunId: string | undefined,
        connectionGeneration = 0,
        activeApprovalEpoch: string | null = null;

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
                retryAfterSeconds:
                    error.problem.retryAfterSeconds ?? error.retryAfterSeconds ?? undefined,
                resourceKind: error.problem.resourceKind,
            };
        }
        return {
            code: fallbackCode,
            detail: error instanceof Error ? error.message : String(error),
            retryable: true,
            outcome: "error",
        };
    }

    /**
     * D23-27：代发被拒的两个业务码必须给**本地化**提示（不直显 CP 英文 detail），
     * 且因为发送已失败，不会留下乐观消息（`sendMessage` 返回 null，调用方不写 user 消息）。
     */
    function sendErrorMessage(payload: SSEErrorPayload): string {
        if (payload.code === "PARTICIPANT_CAP_DENIED") {
            return i18n.global.t("workspace.speakAsCapDenied");
        }
        if (payload.code === "PARTICIPANT_DISABLED") {
            return i18n.global.t("workspace.speakAsDisabled");
        }
        return errorText(payload);
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
                endRunScope();
            }
        }, STREAM_TIMEOUT_MS);
    }

    function clearStreamTimeout() {
        if (streamTimeout) {
            clearTimeout(streamTimeout);
            streamTimeout = null;
        }
    }

    /**
     * Run scope: which run's assistant bubble this *connection* is currently feeding.
     *
     * The session SSE is persistent — `done` terminates a **run**, not the stream, and the
     * same connection carries several `POST /api/v1/chat` turns (`openapi.yaml:1466-1467`,
     * the `token` examples carry `runId`). `contentStarted` therefore must not be a
     * connection-lifetime latch: when it stayed `true` after a run ended, the next turn's
     * first `token` never called `onStart`, so no live bubble was created and every token of
     * that turn was dropped by `appendToParts` (no streaming message id). The retry after
     * `context_overflow_retry` is exactly that shape — the CP retries the run in place, no
     * new POST is made, so the recovered reply never rendered.
     */
    function openRunScope(runId: string | undefined) {
        contentStarted = true;
        if (runId !== undefined) scopeRunId = runId;
        isStreaming.value = true;
        currentCallbacks.onStart?.();
    }

    /**
     * Close the current run scope. A terminal event that belongs to a **different** run
     * (a stale `done`/`error` racing a newer turn) must not clear the live scope.
     */
    function endRunScope(runId?: string) {
        if (runId !== undefined && scopeRunId !== undefined && runId !== scopeRunId) return;
        contentStarted = false;
        scopeRunId = undefined;
    }

    function handleMessage(msg: EventSourceMessage) {
        if (
            activeSessionId !== null &&
            activeApprovalEpoch !== null &&
            !agentStore?.isApprovalEpochCurrent(activeSessionId, activeApprovalEpoch)
        )
            return;
        // PLAN-0631 D31-08: CP stamps **every** event envelope with the producing
        // participant (`openapi.yaml:1374`; a producer-less event carries an explicit
        // null). Parse it once here — before the switch — so consumers get the run's
        // responder without each case re-deriving it. Absent key ⇒ unknown, untouched.
        const envelope = parseParticipantEnvelope(msg.data);
        if (envelope !== undefined) currentCallbacks.onParticipant?.(envelope);
        switch (msg.event) {
            case "token":
                try {
                    const data = JSON.parse(msg.data) as {
                            content?: unknown;
                            hint?: string;
                            runId?: string;
                        },
                        content = normalizeTokenContent(data.content),
                        hint =
                            data.hint === "reasoning" || data.hint === "text"
                                ? data.hint
                                : undefined,
                        tokenRunId =
                            typeof data.runId === "string" && data.runId !== ""
                                ? data.runId
                                : undefined;
                    // A token for a **different** run than the one this connection is feeding
                    // is the start of a new turn's bubble (persistent SSE, see `openRunScope`).
                    const newRun =
                        tokenRunId !== undefined &&
                        scopeRunId !== undefined &&
                        tokenRunId !== scopeRunId;
                    if (content) {
                        if (!contentStarted || newRun) openRunScope(tokenRunId);
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

            case "derived_state_changed":
                // PLAN-0408: the Inbox/API is durable; this event only asks the view to refresh.
                currentCallbacks.onDerivedStateChanged?.();
                notifySessionEvent(activeSessionId ?? toValue(sessionId));
                break;

            case "tool_call":
                resetStreamTimeout();
                try {
                    const data = JSON.parse(msg.data) as Record<string, unknown>;
                    // Agent payload uses `tool`/`toolCallId`; `name`/`id` remain as fallback.
                    const name =
                            typeof data.tool === "string"
                                ? data.tool
                                : typeof data.name === "string"
                                  ? data.name
                                  : null,
                        rawId = data.toolCallId ?? data.id,
                        runId = typeof data.run_id === "string" ? data.run_id : undefined;
                    if (name) {
                        const id =
                                rawId !== undefined && rawId !== null && rawId !== ""
                                    ? String(rawId)
                                    : crypto.randomUUID(),
                            args =
                                typeof data.arguments === "string"
                                    ? data.arguments
                                    : JSON.stringify(data.arguments ?? {});
                        agentStore?.addToolCall({
                            id,
                            name,
                            arguments: args,
                            status: "running",
                        });
                        getChatStoreOrNull()?.upsertToolCall(
                            activeSessionId ?? toValue(sessionId),
                            {
                                id,
                                name,
                                arguments: args,
                                status: "running",
                                startedAt: new Date().toISOString(),
                                ...(runId ? { runId } : {}),
                            },
                        );
                    }
                    currentCallbacks.onToolCall?.(
                        name ?? "",
                        (data.arguments ?? {}) as Record<string, unknown>,
                    );
                } catch {
                    logger.warn("Failed to parse SSE tool_call event");
                }
                break;

            case "tool_result":
                resetStreamTimeout();
                try {
                    const data = JSON.parse(msg.data) as Record<string, unknown>,
                        rawId = data.toolCallId ?? data.id;
                    if (rawId !== undefined && rawId !== null && rawId !== "") {
                        const id = String(rawId),
                            result =
                                typeof data.result === "string"
                                    ? data.result
                                    : JSON.stringify(data.result),
                            status = toolResultStatus(data.result, data.status),
                            // PLAN-0649 M3: a refusal is carried as a bare enum token
                            // (spec §1); re-validate here so a malformed value can
                            // never render as "the reason".
                            refusalCode = normalizeRefusalCode(data.refusalCode),
                            diagnostics = normalizeDiagnostics(data.diagnostics),
                            updates: Partial<ToolCall> = {
                                status,
                                completedAt: new Date().toISOString(),
                                ...(typeof result === "string" ? { result } : {}),
                                ...(diagnostics ? { diagnostics } : {}),
                                ...(refusalCode ? { refusalCode } : {}),
                                ...(typeof data.tool === "string" ? { name: data.tool } : {}),
                                ...(typeof data.run_id === "string" ? { runId: data.run_id } : {}),
                            };
                        agentStore?.updateToolCall(id, { result, status });
                        getChatStoreOrNull()?.upsertToolCall(
                            activeSessionId ?? toValue(sessionId),
                            { id, ...updates },
                        );
                    }
                    currentCallbacks.onToolResult?.(data);
                } catch {
                    logger.warn("Failed to parse SSE tool_result event");
                }
                break;

            case "approval_request":
                resetStreamTimeout();
                try {
                    const data = JSON.parse(msg.data) as Record<string, unknown>,
                        approval = normalizeApprovalRequest(data, activeSessionId ?? "");
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
                notifySessionEvent(activeSessionId ?? toValue(sessionId));
                break;

            // The workspace checkpoint list is durable; this event only refreshes the local slice marker.
            case "run_checkpoint":
                resetStreamTimeout();
                try {
                    const data = JSON.parse(msg.data) as Record<string, unknown>,
                        event = normalizeWorkspaceCheckpointEvent(data, activeSessionId ?? "");
                    if (event) getCheckpointStoreOrNull()?.mergeEvent(event);
                } catch {
                    logger.warn("Failed to parse SSE run_checkpoint event");
                }
                break;

            // PLAN-0508: bounded provider-attempt telemetry. The live mirror is
            // diagnostic side-channel state; only attempt boundaries invalidate
            // the Monitor aggregate (no second SSE connection, no stream-timeout
            // reset — a slow provider must still trip the watchdog).
            case "transport_progress":
                try {
                    const data = JSON.parse(msg.data) as Record<string, unknown>;
                    applyTransportProgress(activeSessionId ?? toValue(sessionId), data);
                    if (data.stage === "attempt_started") {
                        notifySessionEvent(activeSessionId ?? toValue(sessionId));
                    }
                } catch {
                    logger.warn("Failed to parse SSE transport_progress event");
                }
                break;

            case "transport_attempt":
                try {
                    const data = JSON.parse(msg.data) as Record<string, unknown>;
                    applyTransportAttempt(activeSessionId ?? toValue(sessionId), data);
                    notifySessionEvent(activeSessionId ?? toValue(sessionId));
                } catch {
                    logger.warn("Failed to parse SSE transport_attempt event");
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
                        },
                        payload: SSEErrorPayload = {
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
                    endRunScope(payload.runId);
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
                    endRunScope();
                    currentCallbacks.onError?.(payload);
                }
                notifySessionEvent(activeSessionId ?? toValue(sessionId));
                break;

            case "done":
                isStreaming.value = false;
                clearStreamTimeout();
                try {
                    const data = msg.data
                        ? (JSON.parse(msg.data) as { outcome?: string; runId?: string })
                        : {};
                    currentCallbacks.onDone?.(data.outcome);
                    endRunScope(data.runId);
                } catch {
                    logger.warn("Failed to parse SSE done event payload");
                    currentCallbacks.onDone?.();
                    endRunScope();
                }
                notifySessionEvent(activeSessionId ?? toValue(sessionId));
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

            case "usage":
                // PLAN-0343: CP relays the cost-mapped usage snapshot once per
                // run, before done; the chat store keeps the latest per session.
                try {
                    const data = JSON.parse(msg.data) as { usage?: Record<string, unknown> },
                        usage = data.usage ?? data;
                    currentCallbacks.onUsage?.(usage);
                } catch {
                    logger.warn("Failed to parse usage event payload");
                }
                notifySessionEvent(activeSessionId ?? toValue(sessionId));
                break;

            case "context_overflow_retry":
                // PLAN-0341 U3: context overflow → compact → one retry.
                try {
                    const data = JSON.parse(msg.data) as {
                        runId?: string;
                        requestId?: string;
                        message?: string;
                    };
                    // The retry is a **new attempt** of the same run: the folded attempt's
                    // bubble is finalized by the callback below, so the retry's first token
                    // must open a fresh bubble instead of appending to the folded one.
                    endRunScope();
                    currentCallbacks.onContextOverflowRetry?.(data);
                } catch {
                    logger.warn("Failed to parse context_overflow_retry payload");
                }
                break;

            case "context_compaction_circuit":
                // PLAN-0341 U4: recovery-band circuit open/close.
                try {
                    const data = JSON.parse(msg.data) as {
                        state?: string;
                        reason?: string;
                    };
                    currentCallbacks.onContextCompactionCircuit?.(data);
                } catch {
                    logger.warn("Failed to parse context_compaction_circuit payload");
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
        scopeRunId = undefined;

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
                    currentCallbacks.onOpen?.();
                    notifySessionConnection(currentSessionId, "live");
                },
                onmessage: (message) => {
                    if (generation === connectionGeneration) handleMessage(message);
                },
                onerror: (err) => {
                    if (generation !== connectionGeneration) return;
                    const msg = err.message || "SSE connection error";
                    logger.warn("useSSE connection error", err);
                    error.value = msg;
                    notifySessionConnection(currentSessionId, "offline");
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
                notifySessionConnection(currentSessionId, "offline");
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
        scopeRunId = undefined;
        clearStreamTimeout();
    }

    async function sendMessage({
        content,
        branchId,
        attachments,
        model,
        provider,
        toolMode,
        idempotencyKey,
        sessionId: overrideSid,
        agentPrincipalId,
        asParticipantId,
        cc,
    }: SendMessageOptions): Promise<ChatRunResponse | null> {
        const generation = connectionGeneration;
        error.value = null;
        contentStarted = false;
        scopeRunId = undefined;
        const sid = overrideSid ?? toValue(sessionId),
            approvalEpoch = agentStore?.getApprovalEpoch(sid) ?? null;

        try {
            const body: Record<string, unknown> = {
                content,
                sessionId: sid,
                branchId,
                stream: true,
            };
            if (agentPrincipalId) body.agentPrincipalId = agentPrincipalId;
            // D23-27：代发。服务端再校验（owner + 自己/自己拥有的 AGENT + 未停用），UI 只做入口门禁。
            if (asParticipantId) body.asParticipantId = asParticipantId;
            // PLAN-0630 M5b (D30-14)：cc 旁听名单；服务端对非 UUID 条目 400，非本会话参与者 fail-closed 忽略。
            if (cc && cc.length > 0) body.cc = cc;
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
                }),
                result = (await response.json()) as ChatRunResponse;
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
            error.value = sendErrorMessage(payload);
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
