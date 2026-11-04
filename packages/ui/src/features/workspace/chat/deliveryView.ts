import type { MessageDelivery } from "../../../types";
import type { SessionParticipantView } from "../../../types/participant";
import { participantDisplayName } from "../components/participantInitials";

/**
 * PLAN-0659 T1.3：**投递语义展示**（消息头 `发送→(A) · 抄送→(B,C)`，被 @ 者高亮）。
 *
 * 三态数据来源刻意分层（本 PLAN 非目标：不改投递后端、不改 SSE wire）：
 *  - **发送 / 抄送**：只有 composer 发送参数知道（`asParticipantId` / `cc`），由
 *    `ChatPanel` 在乐观消息上写成 `Message.delivery`；历史 DTO 不带 ⇒ 重载后消失。
 *  - **被 @**：从正文 + 会话花名册**重建**（`@显示名` 完整 token 匹配）。这是可以稳的：
 *    @ 属于投递语义（A2 裁定「@ = to-audience」），不是纯文本装饰，重建不需要 wire 改动。
 *
 * 未知 id/名字一律**不渲染**（不拿 UUID 上屏、不猜 PRIMARY，与 D31-08/DEV-032 同口径）。
 */
export interface ResolvedDelivery {
    /** 「发送→」主体显示名。 */
    to?: string;
    /** 被 @ 的主体显示名（消息头高亮）。 */
    mentions: string[];
    /** 抄送主体显示名（已排除 to 与 mentions，避免同一人出现两次）。 */
    cc: string[];
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 从正文解析 `@显示名` 命中的参与者 id，按**正文出现顺序**返回。
 *
 * 重叠按「同起点取更长、已被覆盖的短名跳过」处理：`@Ada Lovelace` 只命中长名，不会被
 * 前缀短名 `Ada` 再吃一口（否则同一处 @ 会显示成两个人）。只认完整 token —
 * 名字后面紧跟名字字符/连字符时不算命中。
 */
export function mentionParticipantIds(
    content: string,
    roster: readonly SessionParticipantView[],
): string[] {
    const text = content ?? "";
    if (!text.includes("@") || roster.length === 0) return [];
    const spans: Array<{ participantId: string; index: number; length: number }> = [];
    for (const row of roster) {
        const name = (row.displayName ?? "").trim();
        if (!name) continue;
        const pattern = new RegExp(`@${escapeRegExp(name)}(?![\\p{L}\\p{N}_-])`, "gu");
        for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
            spans.push({
                participantId: row.participantId,
                index: match.index,
                length: match[0].length,
            });
        }
    }
    spans.sort((a, b) => a.index - b.index || b.length - a.length);
    const hits: string[] = [];
    let consumedUntil = -1;
    for (const span of spans) {
        if (span.index < consumedUntil) continue;
        consumedUntil = span.index + span.length;
        if (!hits.includes(span.participantId)) hits.push(span.participantId);
    }
    return hits;
}

/** 按参与者 id 取显示名；不在（或没有名字的）花名册里 ⇒ undefined（不显示 UUID）。 */
function nameOf(
    roster: readonly SessionParticipantView[],
    participantId: string | null | undefined,
    unknownNameLabel: string,
): string | undefined {
    if (!participantId) return undefined;
    const row = roster.find((item) => item.participantId === participantId);
    if (!row) return undefined;
    return participantDisplayName(row.displayName, unknownNameLabel);
}

export interface ResolveDeliveryInput {
    delivery?: MessageDelivery;
    content: string;
    role: "user" | "assistant" | "system";
    roster: readonly SessionParticipantView[];
    unknownNameLabel: string;
}

/**
 * 一条消息的投递语义投影。没有任何一态时返回 `undefined`（非发送态消息不渲染投递行）。
 *
 * 只有 `role === "user"` 的消息做 @ 重建：agent 正文里出现的 `@xxx` 是对历史的引用/代码，
 * 不是本次投递意图，标成「被 @」会误导。
 */
export function resolveDelivery(input: ResolveDeliveryInput): ResolvedDelivery | undefined {
    const { delivery, content, role, roster, unknownNameLabel } = input;
    const to = nameOf(roster, delivery?.toParticipantId, unknownNameLabel);

    const mentionIds =
        role === "user"
            ? mentionParticipantIds(content, roster).filter(
                  (participantId) => participantId !== delivery?.toParticipantId,
              )
            : [];
    const mentions = mentionIds
        .map((participantId) => nameOf(roster, participantId, unknownNameLabel))
        .filter((name): name is string => Boolean(name));

    const ccIds = (delivery?.ccParticipantIds ?? []).filter(
        (participantId) =>
            participantId !== delivery?.toParticipantId && !mentionIds.includes(participantId),
    );
    const cc = ccIds
        .map((participantId) => nameOf(roster, participantId, unknownNameLabel))
        .filter((name): name is string => Boolean(name));

    if (!to && mentions.length === 0 && cc.length === 0) return undefined;
    return { ...(to ? { to } : {}), mentions, cc };
}
