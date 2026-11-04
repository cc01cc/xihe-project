import { describe, expect, it } from "vitest";
import type { SessionParticipantView } from "../../../../types/participant";
import { mentionParticipantIds, resolveDelivery } from "../deliveryView";

/**
 * PLAN-0659 T1.3：投递语义展示的纯函数面。
 *
 * 钉三件事：① TO/CC 只认本地发送态（`Message.delivery`），花名册里没有的 id 不渲染；
 * ② @ 从正文 + 花名册重建，长名优先、只认完整 token；③ 三态去重（@ 不再重复进抄送）。
 */
const OWNER: SessionParticipantView = {
    participantId: "part-owner",
    principalKind: "HUMAN",
    principalId: "user-1",
    displayName: "Owner One",
    role: "PRIMARY",
    orderIndex: 10,
    wakePolicy: "ALL_MESSAGES",
    respondPolicy: "ALWAYS",
    source: null,
};

const MEMBER: SessionParticipantView = {
    participantId: "part-member",
    principalKind: "HUMAN",
    principalId: "user-2",
    displayName: "Member Two",
    role: "MEMBER",
    orderIndex: 20,
    wakePolicy: "MENTION",
    respondPolicy: "WHEN_MENTIONED",
    source: null,
};

const ALPHA: SessionParticipantView = {
    participantId: "part-alpha",
    principalKind: "AGENT",
    principalId: "agent-alpha",
    displayName: "Agent Alpha",
    role: "MEMBER",
    orderIndex: 40,
    wakePolicy: "ALL_MESSAGES",
    respondPolicy: "ALWAYS",
    source: "workspace",
};

const VIEWER: SessionParticipantView = {
    participantId: "part-viewer",
    principalKind: "HUMAN",
    principalId: "user-3",
    displayName: "Viewer Three",
    role: "GUARD",
    orderIndex: 30,
    wakePolicy: "MENTION",
    respondPolicy: "WHEN_MENTIONED",
    source: null,
};

const ROSTER = [OWNER, MEMBER, ALPHA, VIEWER];

describe("mentionParticipantIds (PLAN-0659 T1.3)", () => {
    it("resolves @display-name tokens against the roster", () => {
        expect(mentionParticipantIds("请 @Member Two 看一下 @Agent Alpha", ROSTER)).toEqual([
            "part-member",
            "part-alpha",
        ]);
    });

    it("prefers the longest name and does not double-count prefixes", () => {
        const roster = [
            { ...ALPHA, participantId: "part-ada", displayName: "Ada" },
            { ...ALPHA, participantId: "part-ada-l", displayName: "Ada Lovelace" },
        ];
        expect(mentionParticipantIds("@Ada Lovelace 帮我看下", roster)).toEqual(["part-ada-l"]);
        // 只写 @Ada 时命中短名，不会顺带命中 Ada Lovelace。
        expect(mentionParticipantIds("@Ada 帮我看下", roster)).toEqual(["part-ada"]);
    });

    it("ignores unknown names and text without @", () => {
        expect(mentionParticipantIds("没有点名", ROSTER)).toEqual([]);
        expect(mentionParticipantIds("@Nobody 你好", ROSTER)).toEqual([]);
        // 名字后面紧跟名字字符不算完整 token（避免 @Owner 命中 @Owner One 之外的场景）
        expect(mentionParticipantIds("@Member TwoX", ROSTER)).toEqual([]);
    });
});

describe("resolveDelivery (PLAN-0659 T1.3)", () => {
    const base = { role: "user" as const, unknownNameLabel: "未知用户", roster: ROSTER };

    it("renders the three states with display names, deduping @ out of the cc list", () => {
        const resolved = resolveDelivery({
            ...base,
            content: "请 @Member Two 一起看",
            delivery: {
                toParticipantId: "part-owner",
                ccParticipantIds: ["part-member", "part-viewer"],
            },
        });
        expect(resolved).toEqual({
            to: ["Owner One"],
            mentions: ["Member Two"],
            cc: ["Viewer Three"],
        });
    });

    it("renders mention-only delivery for history messages (rebuilt from the body)", () => {
        // 历史消息没有 delivery（BL-239）：只重建 @，TO/CC 不猜。
        expect(resolveDelivery({ ...base, content: "@Agent Alpha 继续" })).toEqual({
            to: [],
            mentions: ["Agent Alpha"],
            cc: [],
        });
    });

    it("returns undefined when there is nothing to show", () => {
        expect(resolveDelivery({ ...base, content: "普通提问" })).toBeUndefined();
        expect(
            resolveDelivery({
                ...base,
                content: "普通提问",
                delivery: { toParticipantId: "part-unknown", ccParticipantIds: ["part-ghost"] },
            }),
            "unknown ids never render (no UUID on screen)",
        ).toBeUndefined();
    });

    it("does not interpret @ inside assistant text as delivery intent", () => {
        expect(
            resolveDelivery({
                ...base,
                role: "assistant",
                content: "@Member Two 是历史里被引用的人",
            }),
        ).toBeUndefined();
    });

    it("keeps cc names in roster order-independent, locale separator applied by the view", () => {
        const resolved = resolveDelivery({
            ...base,
            content: "走查一下",
            delivery: { ccParticipantIds: ["part-viewer", "part-member"] },
        });
        expect(resolved).toEqual({ to: [], mentions: [], cc: ["Viewer Three", "Member Two"] });
    });

    describe("durable delivery (PLAN-0665 M2 / V120)", () => {
        it("renders the durable to/cc arrays (multi-target) instead of legacy single values", () => {
            const resolved = resolveDelivery({
                ...base,
                content: "普通提问",
                delivery: {
                    to: ["part-alpha", "part-owner"],
                    cc: ["part-viewer"],
                    toParticipantId: "part-member",
                    ccParticipantIds: ["part-member"],
                },
            });
            // durable 优先：legacy 单值被忽略，TO 是集合。
            expect(resolved).toEqual({
                to: ["Agent Alpha", "Owner One"],
                mentions: [],
                cc: ["Viewer Three"],
            });
        });

        it("treats an explicit durable empty set as authoritative (no legacy fallback)", () => {
            // durable `to: []` 表示"CP 判定没有显式 TO"，不能偷偷用本地旧态补回来。
            const resolved = resolveDelivery({
                ...base,
                content: "普通提问",
                delivery: { to: [], cc: [], toParticipantId: "part-owner" },
            });
            expect(resolved).toBeUndefined();
        });

        it("falls back to the legacy local state when durable delivery is absent", () => {
            // 安全网：V120 之前的历史消息 / 本地乐观消息只有 legacy 形状，仍要显示徽标。
            const resolved = resolveDelivery({
                ...base,
                content: "普通提问",
                delivery: { toParticipantId: "part-owner", ccParticipantIds: ["part-member"] },
            });
            expect(resolved).toEqual({ to: ["Owner One"], mentions: [], cc: ["Member Two"] });
        });

        it("dedupes durable to/cc overlaps and @ mentions", () => {
            const resolved = resolveDelivery({
                ...base,
                content: "@Agent Alpha 帮我看",
                delivery: { to: ["part-owner"], cc: ["part-alpha", "part-viewer"] },
            });
            expect(resolved).toEqual({
                to: ["Owner One"],
                mentions: ["Agent Alpha"],
                cc: ["Viewer Three"],
            });
        });
    });
});
