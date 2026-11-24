/* task-1032：自 composables/api.ts 拆出的 sessionMessage 段（逐字节搬运）。 */
import { readTabWorkspaceId } from "../../lib/workspaceContext";
import { request, apiRaw, apiDelete } from "./_core";
import { asRecord, normalizeSession } from "./_normalize";
import type { SessionResponse, ApiFollowUpQueueSnapshot } from "./_types";
export interface ApiFollowUpCreateRequest {
    content: string;
    attachments?: string[];
    branchId: string;
    toolMode?: "none" | "workspace";
    toolTimeouts?: Record<string, number>;
    provider?: string;
    model?: string;
}
export interface ChatRunGuidanceCreateResult {
    id: string;
    runId: string;
    sessionId: string;
    sequence: number;
    status: string;
    createdAt: string;
}
export interface ChatRunGuidanceItem {
    id: string;
    sequence: number;
    sourceKind: string;
    status: string;
    createdAt: string;
    consumedAt: string | null;
    terminalExpiredAt: string | null;
    authorPrincipalId: string;
    content: string;
}
export interface ChatRunGuidanceSnapshot {
    items: ChatRunGuidanceItem[];
    latestSequence: number;
}
export function normalizeGuidanceItem(payload: unknown): ChatRunGuidanceItem | null {
    const record = asRecord(payload);
    if (!record || typeof record.id !== "string" || typeof record.sequence !== "number") {
        return null;
    }
    return {
        id: record.id,
        sequence: record.sequence,
        sourceKind: typeof record.sourceKind === "string" ? record.sourceKind : "user",
        status: typeof record.status === "string" ? record.status : "pending",
        createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
        consumedAt: typeof record.consumedAt === "string" ? record.consumedAt : null,
        terminalExpiredAt:
            typeof record.terminalExpiredAt === "string" ? record.terminalExpiredAt : null,
        authorPrincipalId:
            typeof record.authorPrincipalId === "string" ? record.authorPrincipalId : "",
        content: typeof record.content === "string" ? record.content : "",
    };
}
export function normalizeGuidanceSnapshot(payload: unknown): ChatRunGuidanceSnapshot {
    const record = asRecord(payload);
    const rawItems = record && Array.isArray(record.items) ? record.items : [];
    const items = rawItems
        .map((item) => normalizeGuidanceItem(item))
        .filter((item): item is ChatRunGuidanceItem => item !== null);
    items.sort((a, b) => a.sequence - b.sequence);
    return {
        items,
        latestSequence:
            record && typeof record.latestSequence === "number" ? record.latestSequence : 0,
    };
}
export function normalizeGuidanceCreateResult(
    payload: unknown,
    runId: string,
): ChatRunGuidanceCreateResult {
    const record = asRecord(payload);
    if (!record || typeof record.id !== "string") {
        throw new Error("Invalid guidance create response: missing id");
    }
    return {
        id: record.id,
        runId: typeof record.runId === "string" ? record.runId : runId,
        sessionId: typeof record.sessionId === "string" ? record.sessionId : "",
        sequence: typeof record.sequence === "number" ? record.sequence : 0,
        status: typeof record.status === "string" ? record.status : "pending",
        createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
    };
}
export type ApiSessionMessage = {
    id: string;
    sessionId: string;
    role: string;
    content: string;
    createdAt: string;
    /** PLAN-0669 M1：历史消息的主体归属（可选；缺失 = 未知，不渲染徽标）。 */
    participantId?: string | null;
    runId?: string;
    runStatus?: string;
    terminalOutcome?: string;
    errorCode?: string;
    /** CP `MessageReadService` field name for the terminal error text. */
    errorDetail?: string;
    error?: string;
    retryable?: boolean;
    /**
     * PLAN-0665 M2 / V120: durable delivery audience written on the user Message.
     * `{to:[participantId],cc:[participantId]}`; `null` when the message had neither
     * (never an empty object), so the read side falls back to local composer state.
     */
    delivery?: { to?: string[]; cc?: string[] } | null;
    attachments?: Array<{ fileId: string; name: string; type: string; size: number }>;
    /**
     * PLAN-0761 (BL-555): reasoning text persisted on the assistant Message (V150) —
     * the same text the live Run rendered as a thinking block. Absent (not empty)
     * for Messages written before V150, so the history mapping keeps its single
     * "no reasoning ⇒ no thinking block" path.
     */
    reasoning?: string | null;
    /** PLAN-0572: persisted per-Run tool cards (V83 snapshot). */
    toolCalls?: Array<{
        id: string;
        name: string;
        arguments: string;
        status: "running" | "completed" | "failed" | "pending" | "cancelled";
        startedAt: string;
        completedAt?: string;
        result?: string;
        /** task-988: bounded projection was truncated; see ToolCall.resultTruncated. */
        resultTruncated?: boolean;
        /** task-988: full UTF-8 byte size before truncation. */
        resultBytes?: number;
        truncated?: boolean;
        /** PLAN-0649: CP refusal code; the durable body stays a placeholder. */
        refusalCode?: string;
    }>;
    toolCallsTruncated?: boolean;
    toolCallsTotal?: number;
    jobSummary?: Array<{
        jobId: string;
        workspaceId: string;
        toolCallId?: string;
        toolName?: string;
        status: string;
        scope?: string;
        startedAt?: string | null;
        endedAt?: string | null;
    }>;
};

export const sessionMessageApi = {
    async forkSession(
        sessionId: string,
        body: { sourceBranchId: string; anchorMessageId: string },
        idempotencyKey: string,
    ): Promise<SessionResponse> {
        return normalizeSession(
            await request<unknown>(`/sessions/${encodeURIComponent(sessionId)}/fork`, {
                method: "POST",
                headers: { "Idempotency-Key": idempotencyKey },
                body: JSON.stringify(body),
            }),
        );
    },
    async createSession(agentPrincipalId: string, title?: string): Promise<SessionResponse> {
        const body = title === undefined ? { agentPrincipalId } : { title, agentPrincipalId };
        // PLAN-0608 (C′): address the workspace in the PATH. The tab header alone is
        // not enough — after login the tab may hold the *fallback* workspace, which
        // silently created sessions in the wrong tenant (review P0-1). With no
        // selection yet, keep the legacy route so CP answers WORKSPACE_CONTEXT_REQUIRED
        // and the UI can offer the picker.
        const workspaceId = readTabWorkspaceId();
        const path = workspaceId
            ? `/workspaces/${encodeURIComponent(workspaceId)}/sessions`
            : "/sessions";
        return normalizeSession(
            await request<unknown>(path, {
                method: "POST",
                body: JSON.stringify(body),
            }),
        );
    },
    async createStandaloneSession(
        agentPrincipalId: string,
        title?: string,
    ): Promise<SessionResponse> {
        const body = title === undefined ? { agentPrincipalId } : { title, agentPrincipalId };
        return normalizeSession(
            await request<unknown>("/sessions", {
                method: "POST",
                headers: { "X-Workspace-Id": "" },
                body: JSON.stringify(body),
            }),
        );
    },
    getChatRunGuidance(runId: string): Promise<ChatRunGuidanceSnapshot> {
        return request<unknown>(`/chat/runs/${encodeURIComponent(runId)}/guidance`).then(
            normalizeGuidanceSnapshot,
        );
    },
    async submitChatRunGuidance(
        runId: string,
        content: string,
        idempotencyKey: string,
    ): Promise<ChatRunGuidanceCreateResult> {
        const payload = await request<unknown>(`/chat/runs/${encodeURIComponent(runId)}/guidance`, {
            method: "POST",
            headers: { "Idempotency-Key": idempotencyKey },
            body: JSON.stringify({ content }),
        });
        return normalizeGuidanceCreateResult(payload, runId);
    },
    getFollowUpQueue(sessionId: string): Promise<ApiFollowUpQueueSnapshot> {
        return request<ApiFollowUpQueueSnapshot>(
            `/sessions/${encodeURIComponent(sessionId)}/follow-ups`,
        );
    },
    enqueueFollowUp(
        sessionId: string,
        body: ApiFollowUpCreateRequest,
        idempotencyKey: string,
    ): Promise<ApiFollowUpQueueSnapshot> {
        return request<ApiFollowUpQueueSnapshot>(
            `/sessions/${encodeURIComponent(sessionId)}/follow-ups`,
            {
                method: "POST",
                headers: { "Idempotency-Key": idempotencyKey },
                body: JSON.stringify(body),
            },
        );
    },
    async enqueueFollowUpDetailed(
        sessionId: string,
        body: ApiFollowUpCreateRequest,
        idempotencyKey: string,
    ): Promise<{ snapshot: ApiFollowUpQueueSnapshot; replayed: boolean }> {
        const response = await apiRaw(`/sessions/${encodeURIComponent(sessionId)}/follow-ups`, {
            method: "POST",
            headers: { "Idempotency-Key": idempotencyKey },
            body: JSON.stringify(body),
        });
        if (response.status === 204)
            return { snapshot: undefined as unknown as ApiFollowUpQueueSnapshot, replayed: false };
        return {
            snapshot: (await response.json()) as ApiFollowUpQueueSnapshot,
            replayed: response.status === 200,
        };
    },
    withdrawFollowUp(sessionId: string, itemId: string): Promise<ApiFollowUpQueueSnapshot> {
        return request<ApiFollowUpQueueSnapshot>(
            `/sessions/${encodeURIComponent(sessionId)}/follow-ups/${encodeURIComponent(itemId)}`,
            { method: "DELETE" },
        );
    },
    continueFollowUpQueue(sessionId: string): Promise<ApiFollowUpQueueSnapshot> {
        return request<ApiFollowUpQueueSnapshot>(
            `/sessions/${encodeURIComponent(sessionId)}/follow-ups/continue`,
            { method: "POST" },
        );
    },
    getMessages(
        sessionId: string,
        branchId: string,
        options: { limit?: number; before?: string } = {},
    ) {
        // PLAN-0670 M2d.1（Lead 2026-11-05 裁定 a）：分页参数**可选**；CP 未支持时忽略未知
        // query（继续返回全量数组），调用方据此自动退化 —— 行为与改造前逐字节一致。
        // 只有响应带 `nextCursor`/`truncated` 时 UI 才显示「加载更早」入口（不硬编码假设）。
        const query = new URLSearchParams({ branchId });
        if (options.limit !== undefined) query.set("limit", String(options.limit));
        if (options.before) query.set("before", options.before);
        return request<
            | ApiSessionMessage[]
            | {
                  messages?: ApiSessionMessage[];
                  items?: ApiSessionMessage[];
                  nextCursor?: string | null;
                  truncated?: boolean;
              }
        >(`/sessions/${encodeURIComponent(sessionId)}/messages?${query.toString()}`);
    },
    deleteMessage(sessionId: string, messageId: string) {
        return apiDelete(
            `/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`,
        );
    },
};
