/**
 * PLAN-0623：会话参与者（`SessionParticipantView`，CP M0 契约 `62503e63`）。
 *
 * 严格对齐 `docs/api/openapi.yaml:3637` 的 wire 契约 —— **不要**在前端私自加字段或改名。
 *
 * 已知缺口（已报 Lead，等 M1a 联表补）：agent 的**模型意图**（`defaultModelProvider` /
 * `defaultModelName`）不在参与者 view 里；在那之前行内不显示模型段（不猜、不逐个查
 * `/agent-principals` —— 那会 N+1 且 PERSONAL 可见性会打架）。
 */

export type ParticipantPrincipalKind = "HUMAN" | "AGENT";

/** CP 特意把 workspace 的 OWNER 排除在外（串域），这里只到 GUARD。 */
export type SessionParticipantRole = "PRIMARY" | "MEMBER" | "GUARD";

export type ParticipantWakePolicy = "ALL_MESSAGES" | "MENTION";

export type ParticipantRespondPolicy = "ALWAYS" | "WHEN_MENTIONED" | "JUDGE" | "MUTED";

export type ParticipantSource = "workspace" | "personal" | "instance";

/** R7：只读游标，由服务端在事件流上推进；客户端不得累计、不得伪造。 */
export interface ParticipantReadCursor {
    lastReadEventSeq: number;
    mentionCount: number;
    updatedAt: string;
}

export interface SessionParticipantView {
    participantId: string;
    principalKind: ParticipantPrincipalKind;
    /** R2：多态引用，无外键。AGENT 时是 agent principal id，HUMAN 时是 user id。 */
    principalId: string;
    displayName?: string;
    role: SessionParticipantRole;
    /** R4：10/20/30…，删除留空档且不重排。 */
    orderIndex: number;
    wakePolicy: ParticipantWakePolicy;
    respondPolicy: ParticipantRespondPolicy;
    /** 仅 AGENT 有来源（主张量所属层级）；HUMAN 为 null。 */
    source?: ParticipantSource | null;
    disabledAt?: string | null;
    readCursor?: ParticipantReadCursor | null;
}
