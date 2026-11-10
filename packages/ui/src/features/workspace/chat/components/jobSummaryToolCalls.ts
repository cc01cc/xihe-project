import type { JobSummary, MessagePart, ToolCall } from "../../../../types";

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

/**
 * PLAN-0761 (BL-555)：历史 reasoning 字段 → 消息 parts 的**唯一**装配点。
 *
 * reasoning 是 assistant Message 上的独立 durable 字段（V150），正文里没有对应文本，
 * 所以刷新后必须由它重建 thinking part；顺序与直播一致（思考在前、正文在后）。
 * 缺失/空白（V150 之前的行）不加 part —— 保持「无 reasoning ⇒ 无思考块」单一路径。
 */
export function mergeHistoryReasoning(
    parts: MessagePart[],
    reasoning?: string | null,
): MessagePart[] {
    if (!reasoning?.trim()) return parts;
    return [{ type: "reasoning", content: reasoning }, ...parts];
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
    /**
     * PLAN-0649: CP refusal code persisted in the V83 snapshot. Refusals are judged
     * by this field, **not** by `status` — the durable status of a non-CP tool error
     * can still be `completed`.
     */
    refusalCode?: string;
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
