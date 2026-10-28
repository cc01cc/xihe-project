import type { JobSummary, ToolCall } from "../../../../types";

/**
 * PLAN-0344 T1.4 / PLAN-0465 T2.2：messages DTO 的 `jobSummary` → tool 卡片。
 *
 * tool_result 不持久化，刷新后 job 卡片只能从 `workspace_jobs` 投影重建
 * （ChatPanel 加载链路；ChatView 曾有同名 inline 版本，现行路由消费方是 ChatPanel）。
 */
export function jobStatusToToolStatus(status: string): ToolCall["status"] {
    if (status === "running") return "running";
    if (status === "succeeded") return "completed";
    return "failed";
}

export interface HistoryToolCall {
    id: string;
    name: string;
    arguments: string;
    status: ToolCall["status"];
    startedAt?: string;
    completedAt?: string;
    result?: string;
    truncated?: boolean;
}

/**
 * PLAN-0572：历史消息的持久化 toolCalls 与 jobSummary 按 toolCallId 合并。
 * 事件快照提供 name/arguments/时间，jobSummary 提供 jobId/workspaceId 与权威 job 状态；
 * 无事件的旧数据仍只走 jobSummary（保持 PLAN-0344/0465 行为）。
 */
export function mergeHistoryToolCalls(
    toolCalls?: HistoryToolCall[] | null,
    summaries?: JobSummary[] | null,
): ToolCall[] | undefined {
    const jobCards = summaries?.length ? jobSummariesToToolCalls(summaries) : [];
    if (!toolCalls?.length) return jobCards.length ? jobCards : undefined;
    const jobsById = new Map(jobCards.map((card) => [card.id, card]));
    const merged: ToolCall[] = [];
    for (const call of toolCalls) {
        const job = jobsById.get(call.id);
        if (!job) {
            merged.push({ ...call });
            continue;
        }
        jobsById.delete(call.id);
        merged.push({
            ...call,
            status: job.status,
            startedAt: call.startedAt ?? job.startedAt,
            completedAt: call.completedAt ?? job.completedAt,
            jobSummary: job.jobSummary,
        });
    }
    merged.push(...jobsById.values());
    return merged;
}

export function jobSummariesToToolCalls(summaries: JobSummary[]): ToolCall[] {
    return summaries.map((job) => ({
        id: job.toolCallId ?? job.jobId,
        name: job.toolName ?? "background_job",
        arguments: "",
        status: jobStatusToToolStatus(job.status),
        startedAt: job.startedAt ?? undefined,
        completedAt: job.endedAt ?? undefined,
        jobSummary: job,
    }));
}
