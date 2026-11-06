/**
 * PLAN-0660 T5.19（M5-D）：用户问答投影（`UserQuestionView`，CP M5-B `T5.10`）。
 *
 * 严格对齐 `docs/api/openapi.yaml:6377` 的 wire 契约 —— **不要**在前端私自加字段或改名。
 * 语义来源 `spec/session/user-channel.md` §5/§6：
 * - `prompt` / `answer` 是**不可信文本**：只用于渲染，不进日志、审计或 problem detail；
 * - `answer` 仅在 `state === "answered"` 时非空（`pending → answered` 单一路径保证）；
 * - `state` 是**唯一状态真相**，四态封闭为 `pending/answered/expired/cancelled`；
 * - addressee 与会话可见者拿**同一形状**（D-197），差异只在作答权，不在字段集。
 */

export type UserQuestionState = "pending" | "answered" | "expired" | "cancelled";

export interface UserQuestionView {
    id: string;
    sessionId: string;
    runId: string;
    state: UserQuestionState;
    /** 问题正文（不可信文本）。 */
    prompt: string;
    /** 仅 `answered` 非空；其余终态恒 null。 */
    answer?: string | null;
    /** `null` = 阻塞式 `ask`（deadline 归 Agent）；非空 = `askTimed` 的截止时刻。 */
    expiresAt?: string | null;
    createdAt: string;
    /** hint 首次交给用户通道的时间；`null` = 尚未投递。 */
    firstDeliveredAt?: string | null;
    /** 终态时间戳；`answered` 时即「作答时刻」。 */
    settledAt?: string | null;
}

export interface UserQuestionListResponse {
    items: UserQuestionView[];
    /** 与 `items` **同过滤条件**的计数（派生值，从不落库，因此不可能与列表不一致）。 */
    pendingCount: number;
}
