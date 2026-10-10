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
