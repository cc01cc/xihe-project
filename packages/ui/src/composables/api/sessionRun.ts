/* task-1032：自 composables/api.ts 拆出的 sessionRun 段（逐字节搬运）。 */
import type {
    ApprovalRequest,
    RunTransportAttemptsResponse,
    SessionRunsResponse,
    SessionDispatchQueueResponse,
    SessionMonitorResponse,
} from "../../types";
import { request, apiPost } from "./_core";
import { asRecord, normalizeApprovalRequest, isEnumValue, nullableCount } from "./_normalize";
import type { ApiFollowUpQueueSnapshot } from "./_types";
export interface DelegationUsageView {
    rootSessionId: string;
    usedSessions: number;
    maxCount: number;
    currentDepth: number;
    maxDepth: number;
    principalId: string | null;
    principalName: string | null;
    policySource: "subject" | "code-defaults";
    /** `maxCount = 0` — the root's delegation policy disables delegation (ruling A1). */
    disabled: boolean;
}
export interface DelegationSpawnResult {
    childSessionId: string;
    childRunId?: string | null;
    rootSessionId: string;
    chainDepth: number;
    budget: DelegationUsageView;
}
export interface DelegationSpawnAccepted {
    approvalRequestId: string;
    statusUrl: string;
    retryHeader: "X-Xihe-Approval-Request-Id";
}

export const sessionRunApi = {
    steerSession(
        childSessionId: string,
        body: { text: string; expectedRevision?: number },
        idempotencyKey: string,
    ): Promise<ApiFollowUpQueueSnapshot> {
        return request<ApiFollowUpQueueSnapshot>(
            "/sessions/" + encodeURIComponent(childSessionId) + "/steers",
            {
                method: "POST",
                headers: { "Idempotency-Key": idempotencyKey },
                body: JSON.stringify(body),
            },
        );
    },
    listSessionRuns(
        sessionId: string,
        options: { page?: number; size?: number } = {},
    ): Promise<SessionRunsResponse> {
        const params = new URLSearchParams();
        params.set("page", String(options.page ?? 0));
        params.set("size", String(options.size ?? 100));
        return request<SessionRunsResponse>(
            `/chat/sessions/${encodeURIComponent(sessionId)}/runs?${params.toString()}`,
        );
    },
    getSessionDispatchQueue(sessionId: string): Promise<SessionDispatchQueueResponse> {
        return request<SessionDispatchQueueResponse>(
            `/chat/sessions/${encodeURIComponent(sessionId)}/dispatch-queue`,
        );
    },
    getSessionMonitor(sessionId: string): Promise<SessionMonitorResponse> {
        return request<SessionMonitorResponse>(
            `/chat/sessions/${encodeURIComponent(sessionId)}/monitor`,
        );
    },
    getRunAttempts(runId: string): Promise<RunTransportAttemptsResponse> {
        return request<RunTransportAttemptsResponse>(
            `/chat/runs/${encodeURIComponent(runId)}/attempts`,
        );
    },
    getContextSources(sessionId: string) {
        return request<{
            sourceKey: string;
            status: string;
            hashPrefix: string;
            envBranch?: string;
            envHead?: string;
        }>(`/context/${encodeURIComponent(sessionId)}/sources`);
    },
    async delegationUsage(sessionId: string): Promise<DelegationUsageView> {
        return request<DelegationUsageView>(
            `/sessions/${encodeURIComponent(sessionId)}/delegation-usage`,
        );
    },
    async delegationSpawn(
        sessionId: string,
        input: { agentPrincipalId: string; task: string },
        idempotencyKey: string,
        approvalRequestId?: string,
    ): Promise<DelegationSpawnResult | DelegationSpawnAccepted> {
        const headers: Record<string, string> = { "Idempotency-Key": idempotencyKey };
        if (approvalRequestId) {
            headers["X-Xihe-Approval-Request-Id"] = approvalRequestId;
        }
        return request<DelegationSpawnResult | DelegationSpawnAccepted>(
            `/sessions/${encodeURIComponent(sessionId)}/delegation-spawn`,
            { method: "POST", headers, body: JSON.stringify(input) },
        );
    },
    getJobOutput(
        workspaceId: string,
        jobId: string,
        options?: { stream?: "stdout" | "stderr"; offset?: number; limit?: number },
    ): Promise<{
        jobId: string;
        runtimeJobId?: string;
        stream: string;
        offset: number;
        nextOffset: number;
        sizeBytes: number;
        truncated: boolean;
        data: string;
        jobStatus: string;
    }> {
        const params = new URLSearchParams();
        if (options?.stream) params.set("stream", options.stream);
        if (options?.offset !== undefined) params.set("offset", String(options.offset));
        if (options?.limit !== undefined) params.set("limit", String(options.limit));
        const query = params.toString();
        return request(
            `/workspaces/${encodeURIComponent(workspaceId)}/jobs/${encodeURIComponent(jobId)}/output${query ? `?${query}` : ""}`,
        );
    },
    cancelChatRun(
        runId: string,
        reason = "user_requested",
    ): Promise<{ status: string; runId: string }> {
        return apiPost(
            `/chat/runs/${encodeURIComponent(runId)}/cancel`,
            JSON.stringify({ reason }),
        );
    },
    async getChatRunStatus(runId: string): Promise<{
        runId: string;
        sessionId: string;
        origin: "user_submission" | "spawn";
        status: string;
        terminalOutcome?: string | null;
        // PLAN-0493 T3.1: terminal cause fact (e.g. RUN_NO_PROGRESS).
        errorCode?: string | null;
        leaseExpired: boolean;
        pendingApprovals: ApprovalRequest[];
        /**
         * task-105 (D-1869 ①) budget face, projected by CP `ChatRunReadService.putBudgetFace`.
         * Both numbers ride together on purpose, and `null` always means **not recorded**
         * (a historical Run predating V174) — it is never coerced to 0.
         */
        tokenCount: number | null;
        budgetConsumed: number | null;
        /** Read-time effective limits; `0` is a real value here (dimension disabled ⇒ no limit). */
        runMaxTokens: number | null;
        runMaxTokensCeiling: number | null;
        /** Which accounting mode charged `budgetConsumed`; CP defaults to `growth`. */
        budgetAccounting: "growth" | "cumulative" | null;
    }> {
        const payload = await request<unknown>(`/chat/runs/${encodeURIComponent(runId)}`, {
                method: "GET",
            }),
            record = asRecord(payload);
        if (!record || typeof record.sessionId !== "string") {
            throw new Error("Invalid chat run response: missing sessionId");
        }
        if (record.origin !== "user_submission" && record.origin !== "spawn") {
            throw new Error("Invalid chat run response: missing origin");
        }
        const rawApprovals = Array.isArray(record.pendingApprovals) ? record.pendingApprovals : [],
            pendingApprovals = rawApprovals
                .map((approval) => normalizeApprovalRequest(approval, record.sessionId as string))
                .map((approval) =>
                    approval ? { ...approval, runId: approval.runId || runId } : null,
                )
                .filter((approval): approval is ApprovalRequest => approval !== null);
        // task-105 (D-1869 ①): the budget face is a read-only projection — an absent or
        // unrecognised accounting mode stays null instead of defaulting to "growth" here;
        // CP already resolved its Agent default, so UI never invents one.
        const budgetAccounting = isEnumValue(record.budgetAccounting, [
                "growth",
                "cumulative",
            ] as const)
                ? record.budgetAccounting
                : null,
            budgetConsumed = nullableCount(record.budgetConsumed),
            runMaxTokens = nullableCount(record.runMaxTokens),
            runMaxTokensCeiling = nullableCount(record.runMaxTokensCeiling);
        return {
            runId: typeof record.runId === "string" ? record.runId : runId,
            sessionId: record.sessionId,
            origin: record.origin,
            status: typeof record.status === "string" ? record.status : "unknown",
            terminalOutcome:
                typeof record.terminalOutcome === "string" || record.terminalOutcome === null
                    ? record.terminalOutcome
                    : undefined,
            errorCode:
                typeof record.errorCode === "string" || record.errorCode === null
                    ? record.errorCode
                    : undefined,
            leaseExpired: record.leaseExpired === true,
            pendingApprovals,
            tokenCount: nullableCount(record.tokenCount),
            budgetConsumed,
            runMaxTokens,
            runMaxTokensCeiling,
            budgetAccounting,
        };
    },
};
