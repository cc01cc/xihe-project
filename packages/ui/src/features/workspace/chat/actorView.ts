import type { SessionParticipantView } from "../../../types/participant";
import { participantDisplayName, participantInitials } from "../components/participantInitials";
import type { ProcessRowActor } from "./components/ProcessRow.vue";

/**
 * PLAN-0659 T1.2：**actor 徽标**的派生（过程行 + 消息身份行共用一份）。
 *
 * 规则（与 PLAN-0631 D31-08/09 同源，不另立口径）：
 *  - 只从**服务端归因**派生：`message.participantId` → 会话参与者花名册那一行；
 *    没有归因就返回 `undefined`（不猜 PRIMARY、不从 role 反推）。
 *  - **颜色中立**：不引入新色值/新设计 token（本 PLAN 非目标 + D31-10「per-participant hues
 *    是新颜色值」裁定）。多主体可辨靠：首字母 + 名称 + `kind`（HUMAN/AGENT 图标语义）。
 *  - `principalId` 留在模型里只供 **DOM 断言/排障**（`data-actor-principal-id`）；名字是展示，
 *    UUID 不上屏（DEV-032）。
 */
export function actorOf(
    participant: SessionParticipantView | undefined,
    unknownNameLabel: string,
): ProcessRowActor | undefined {
    if (!participant) return undefined;
    return {
        name: participantDisplayName(participant.displayName, unknownNameLabel),
        initials: participantInitials(participant.displayName, unknownNameLabel),
        kind: participant.principalKind,
        principalId: participant.participantId,
    };
}

/**
 * 线程是否**混主体**（出现 ≥2 个不同产出者）。
 *
 * 只在混主体线程挂过程行 actor 徽标：单主体线程里每个过程行都重复同一个人是纯噪音
 * （design 反证：单 run 不分组 / 单主体不刷身份同一口径）。
 */
export function hasMultipleActors(messages: readonly { participantId?: string | null }[]): boolean {
    const seen = new Set<string>();
    for (const message of messages) {
        if (!message.participantId) continue;
        seen.add(message.participantId);
        if (seen.size > 1) return true;
    }
    return false;
}
