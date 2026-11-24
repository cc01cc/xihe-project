/* task-1032：自 composables/api.ts 拆出的 sessionApproval 段（逐字节搬运）。 */
import type {
    ApprovalDecision,
    ApprovalDecisionKind,
    ApprovalPolicyMode,
    PendingApprovalSummary,
} from "../../types";
import { request } from "./_core";
import { asRecord } from "./_normalize";
export interface ChatApprovalDecisionResponse {
    /** task-161: `queued` = the decision is durable but waits for an execution slot. */
    status: "accepted" | "already_decided" | "queued";
    requestId: string;
    approved: boolean;
    decision?: ApprovalDecisionKind;
    propagated?: number;
    modeAtGrant?: ApprovalPolicyMode;
    rule?: {
        layer: "session" | "workspace" | "user";
        actionClass: string;
        resource: string;
        effect: "allow" | "deny";
    };
}
export function normalizePendingApprovalSummary(value: unknown): PendingApprovalSummary | null {
    const record = asRecord(value),
        count = record?.count;
    if (
        !record ||
        typeof record.sessionId !== "string" ||
        typeof record.workspaceId !== "string" ||
        !Number.isInteger(count) ||
        (count as number) < 0 ||
        (typeof record.oldestRequestedAt !== "string" && count !== 0)
    ) {
        return null;
    }
    return {
        sessionId: record.sessionId,
        workspaceId: record.workspaceId,
        count: count as number,
        oldestRequestedAt:
            typeof record.oldestRequestedAt === "string" ? record.oldestRequestedAt : "",
    };
}

export const sessionApprovalApi = {
    decideChatApproval(
        requestId: string,
        decision: ApprovalDecision | boolean,
    ): Promise<ChatApprovalDecisionResponse> {
        return request<ChatApprovalDecisionResponse>(
            `/chat/approvals/${encodeURIComponent(requestId)}/decision`,
            {
                method: "POST",
                body: JSON.stringify(
                    typeof decision === "boolean" ? { approved: decision } : decision,
                ),
            },
        );
    },
    async getPendingApprovals(signal?: AbortSignal): Promise<PendingApprovalSummary[]> {
        const controller = new AbortController(),
            timeout = setTimeout(() => controller.abort(), 5000),
            abortFromCaller = () => controller.abort();
        if (signal) {
            if (signal.aborted) controller.abort();
            else signal.addEventListener("abort", abortFromCaller, { once: true });
        }
        try {
            const payload = await request<unknown>("/approvals/pending", {
                signal: controller.signal,
            });
            if (!Array.isArray(payload))
                throw new Error("Invalid pending approvals response: expected an array");
            const summaries = payload.map(normalizePendingApprovalSummary);
            if (summaries.some((summary): summary is null => summary === null)) {
                throw new Error("Invalid pending approvals response: malformed summary");
            }
            return summaries.filter(
                (summary): summary is PendingApprovalSummary => summary !== null,
            );
        } finally {
            clearTimeout(timeout);
            signal?.removeEventListener("abort", abortFromCaller);
        }
    },
};
