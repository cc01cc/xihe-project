import { describe, expect, it } from "vitest";
import type { SessionParticipantView } from "../../../../types/participant";
import { actorOf, hasMultipleActors } from "../actorView";

/**
 * PLAN-0659 T1.2：actor 徽标派生的纯函数面。
 *
 * 钉三件事：① 只从服务端归因（参与者行）派生，没有归因就是 `undefined`（不猜 PRIMARY）；
 * ② 名字/首字母走既有 `participantInitials` 口径（UUID 永不上屏）；③ 徽标只在
 * 混主体线程挂（`hasMultipleActors`），单主体线程不重复刷身份。
 */
function participant(overrides: Partial<SessionParticipantView> = {}): SessionParticipantView {
    return {
        participantId: "part-agent-alpha",
        principalKind: "AGENT",
        principalId: "agent-alpha",
        displayName: "Agent Alpha",
        role: "MEMBER",
        orderIndex: 40,
        wakePolicy: "ALL_MESSAGES",
        respondPolicy: "ALWAYS",
        ...overrides,
    };
}

describe("actorOf (PLAN-0659 T1.2)", () => {
    it("derives name, initials, kind and the DOM identity from the participant row", () => {
        expect(actorOf(participant(), "未知用户")).toEqual({
            name: "Agent Alpha",
            // D-1142 ①：缩写**恰好 1 个字符**（首个有效词的首字）——不是"少显示一个字"的取舍，
            // 而是 12.25px/14px 的圆装不下两个字符（task-292 实测）。
            initials: "A",
            kind: "AGENT",
            principalId: "part-agent-alpha",
        });
    });

    it("falls back to the localized unknown-name label, never to the UUID", () => {
        const actor = actorOf(
            participant({ displayName: undefined, participantId: "part-nameless" }),
            "未知用户",
        );
        expect(actor?.name).toBe("未知用户");
        expect(actor?.initials).toBe("未");
        // 名字是展示；participantId 只在 data-* 里供断言。
        expect(actor?.principalId).toBe("part-nameless");
    });

    it("returns undefined without server attribution (no PRIMARY guessing)", () => {
        expect(actorOf(undefined, "未知用户")).toBeUndefined();
    });

    it("keeps HUMAN/AGENT distinguishable by kind (no per-principal hues invented)", () => {
        const human = actorOf(
            participant({
                participantId: "part-human",
                principalKind: "HUMAN",
                displayName: "Ada Lovelace",
            }),
            "未知用户",
        );
        const agent = actorOf(participant(), "未知用户");
        expect(human?.kind).toBe("HUMAN");
        expect(agent?.kind).toBe("AGENT");
        // D-1142 ① 之后 "Ada Lovelace" 与 "Agent Alpha" 的首字母**都是 A**。
        expect(human?.initials).toBe("A");
        // 这条断言本身是**证据**，不是补丁：两个主体的 initials 完全相同、而下面的 kind
        // 仍能把它们分开 ⇒ 「可辨」**不可能**来自首字母，只能来自 kind。
        // 换夹具名把首字母分开，等于把这条证据抹掉，换回"反正首字母不同所以能分辨"的弱版本。
        expect(agent?.initials).toBe(human?.initials);
        expect(agent?.kind).not.toBe(human?.kind);
    });
});

describe("hasMultipleActors (PLAN-0659 T1.2)", () => {
    it("is false for zero or one attributed principal", () => {
        expect(hasMultipleActors([])).toBe(false);
        expect(hasMultipleActors([{ participantId: null }, { participantId: null }])).toBe(false);
        expect(hasMultipleActors([{ participantId: "a" }, { participantId: "a" }])).toBe(false);
        expect(hasMultipleActors([{ participantId: undefined }, { participantId: "a" }])).toBe(
            false,
        );
    });

    it("is true as soon as two distinct principals produce messages", () => {
        expect(
            hasMultipleActors([
                { participantId: "a" },
                { participantId: "b" },
                { participantId: "a" },
            ]),
        ).toBe(true);
    });
});
