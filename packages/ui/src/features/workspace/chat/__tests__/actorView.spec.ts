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
            initials: "AA",
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
        expect(human?.kind).toBe("HUMAN");
        expect(human?.initials).toBe("AL");
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
