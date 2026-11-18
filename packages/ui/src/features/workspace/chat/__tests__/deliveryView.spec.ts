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
            unresolved: [],
        });
    });

    it("renders mention-only delivery for history messages (rebuilt from the body)", () => {
        // 历史消息没有 delivery（BL-239）：只重建 @，TO/CC 不猜。
        expect(resolveDelivery({ ...base, content: "@Agent Alpha 继续" })).toEqual({
            to: [],
            mentions: ["Agent Alpha"],
            cc: [],
            unresolved: [],
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
        expect(resolved).toEqual({
            to: [],
            mentions: [],
            cc: ["Viewer Three", "Member Two"],
            unresolved: [],
        });
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
                unresolved: [],
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
            expect(resolved).toEqual({
                to: ["Owner One"],
                mentions: [],
                cc: ["Member Two"],
                unresolved: [],
            });
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
                unresolved: [],
            });
        });
    });
});

/**
 * PLAN-0684（D-183 / B3 历史口径）：HUMAN echo 切 username 后，历史正文里的
 * `@旧显示名` 按**当前**名册重建时自然失配 —— 不崩、不命中、不把 id/UUID 上屏。
 * 「不重写历史正文」由读侧重建保证：这里断言重建结果为空，而不是去改消息文本。
 */
describe("legacy @old-display-name after D-183 (PLAN-0684)", () => {
    // 切换后的 echo = username：名册里没有旧的显示名（如 "陆星"）。
    const USERNAME_ROSTER: SessionParticipantView[] = [
        { ...OWNER, displayName: "owner_one" },
        { ...MEMBER, displayName: "member_two" },
    ];
    const LEGACY_BODY = "@陆星 帮我看下这个告警";
    const base = { role: "user" as const, unknownNameLabel: "未知用户", roster: USERNAME_ROSTER };

    it("does not hit the mention badge for an old display name", () => {
        expect(mentionParticipantIds(LEGACY_BODY, USERNAME_ROSTER)).toEqual([]);
        // 历史消息没有 delivery ⇒ 没有任何可渲染的投递态：徽标不命中也不崩。
        expect(resolveDelivery({ ...base, content: LEGACY_BODY })).toBeUndefined();
    });

    it("never renders a UUID when the old name no longer matches the roster", () => {
        const resolved = resolveDelivery({
            ...base,
            content: LEGACY_BODY,
            delivery: { toParticipantId: "part-member", ccParticipantIds: [] },
        });
        // 只渲染名册里查得到的 username；失配的旧 @ 不进 mentions。
        expect(resolved).toEqual({ to: ["member_two"], mentions: [], cc: [], unresolved: [] });
        expect(JSON.stringify(resolved), "no participant id / UUID on screen").not.toContain(
            "part-member",
        );
        expect(JSON.stringify(resolved)).not.toContain("user-2");
    });

    it("keeps matching when the body already carries the new username", () => {
        // 对照：正文写 @member_two 时仍按当前名册命中（失配只针对旧名，不是禁用 @）。
        expect(mentionParticipantIds("@member_two 帮我看下", USERNAME_ROSTER)).toEqual([
            "part-member",
        ]);
    });
});

// ── task-66①（D-1884-B）：未解析的 @token 走既有投递投影 ─────────────────────
/**
 * 钉四件事：① 只有 unresolved 也必须出投影（agent 正文就是这形状：没有 TO/CC，却点了个空名字）；
 * ② 原文 token **不参与**花名册解析——它是不可信文本，不是 id，也不是显示名；
 * ③ 空/非字符串的载荷不进名单（CP 不造空标记，坏载荷不崩）；④ 上限 20 与契约 maxItems 同口径。
 */
describe("unresolved mention projection (task-66①)", () => {
    const base2 = {
        content: "请把下一步交给 @ewLeadXYZ",
        role: "assistant" as const,
        roster: ROSTER,
        unknownNameLabel: "未知用户",
    };

    it("produces a projection from unresolved tokens alone", () => {
        const resolved = resolveDelivery({
            ...base2,
            delivery: { unresolved: ["@ewLeadXYZ"] },
        });
        expect(resolved).toEqual({ to: [], mentions: [], cc: [], unresolved: ["@ewLeadXYZ"] });
    });

    it("keeps the raw token verbatim and never id-matches it", () => {
        // 名字与花名册只差一个后缀：必须仍然算「没解析出来」，原样带上屏。
        const resolved = resolveDelivery({
            ...base2,
            content: "交给 @Owner OneXX 处理",
            role: "user",
            delivery: { to: ["part-owner"], unresolved: ["@Owner OneXX"] },
        });
        expect(resolved?.unresolved).toEqual(["@Owner OneXX"]);
        expect(resolved?.to).toEqual(["Owner One"]);
        expect(JSON.stringify(resolved)).not.toContain("part-", "no id ever reaches the screen");
    });

    it("drops blank and non-string payloads instead of rendering an empty marker", () => {
        const resolved = resolveDelivery({
            ...base2,
            delivery: { unresolved: ["  ", "", 42 as unknown as string, "@ghost"] },
        });
        expect(resolved?.unresolved).toEqual(["@ghost"]);
        expect(
            resolveDelivery({ ...base2, delivery: { unresolved: ["", "   "] } }),
            "nothing real to show ⇒ no delivery row at all",
        ).toBeUndefined();
    });

    it("caps the list at the contract limit (maxItems: 20)", () => {
        const many = Array.from({ length: 25 }, (unused, index) => "@tok" + index);
        const resolved = resolveDelivery({ ...base2, delivery: { unresolved: many } });
        expect(resolved?.unresolved).toHaveLength(20);
    });
});
