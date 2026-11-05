/**
 * PLAN-0623：会话参与者（`SessionParticipantView`，CP M0 契约 `62503e63`）。
 *
 * 严格对齐 `docs/api/openapi.yaml:3637` 的 wire 契约 —— **不要**在前端私自加字段或改名。
 *
 * 模型意图由参与者 view 提供；UI 不按主体 ID 额外推断授权或可见性。
 */

export type ParticipantPrincipalKind = "HUMAN" | "AGENT";

/** CP 特意把 workspace 的 OWNER 排除在外（串域），这里只到 GUARD。 */
export type SessionParticipantRole = "PRIMARY" | "MEMBER" | "GUARD";

export type ParticipantWakePolicy = "ALL_MESSAGES" | "MENTION";

export type ParticipantRespondPolicy = "ALWAYS" | "WHEN_MENTIONED" | "JUDGE" | "MUTED";

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
    disabledAt?: string | null;
    readCursor?: ParticipantReadCursor | null;
    /**
     * 调用者是否**拥有**这个参与者（D23-27 / M1c，required）：
     * CP 根据当前会话和主体关系计算；UI 不按主体档位推断。
     */
    selfOwned?: boolean;
    /** PLAN-0623 M1a：仅 AGENT 非空；HUMAN 为 null（CP 联表 agent_principals 提供）。 */
    defaultModelProvider?: string | null;
    defaultModelName?: string | null;
}

/**
 * PLAN-0623 U2：GET 响应里的 capability 三键（`view`/`manage`/`mention`）。
 *
 * ⚠️ 契约缺口（已报 Lead）：`openapi.yaml` 的 `SessionParticipantListResponse` 目前**只声明
 * `participants`**，`capabilities` 是 M1a 实现额外返回的块 —— 需要 CP 把它补进 openapi/inventory。
 * 在补齐前，UI 侧按**失败关闭**处理：缺 capabilities 时 `manage`/`mention` 一律 false。
 */
export interface SessionParticipantCapabilities {
    view: boolean;
    manage: boolean;
    mention: boolean;
    /**
     * D23-27：能否以某个参与者身份发言（"代发"）。**与 `manage` 无关** —— 写参与者表要 manage，
     * 代发要 owner + 自己/自己拥有的 AGENT。`false` 时 UI **不渲染**入口（不是禁用）。
     */
    speakAs: boolean;
}

export interface SessionParticipantListResponse {
    participants: SessionParticipantView[];
    capabilities: SessionParticipantCapabilities;
}
