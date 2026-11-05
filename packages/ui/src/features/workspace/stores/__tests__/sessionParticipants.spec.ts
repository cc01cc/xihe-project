import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type {
    SessionParticipantCapabilities,
    SessionParticipantListResponse,
    SessionParticipantView,
} from "../../../../types/participant";

vi.mock("../../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../../composables/api")>();
    return {
        ...actual,
        api: {
            ...actual.api,
            getSessionParticipants: vi.fn<() => Promise<SessionParticipantListResponse>>(),
        },
    };
});

import { api } from "../../../../composables/api";
import { useSessionParticipantsStore } from "../sessionParticipants";

const getParticipants = vi.mocked(api.getSessionParticipants);

const CAPS: SessionParticipantCapabilities = {
    view: true,
    manage: true,
    mention: true,
    speakAs: true,
};

function participant(overrides: Partial<SessionParticipantView>): SessionParticipantView {
    return {
        participantId: "p",
        principalKind: "HUMAN",
        principalId: "5a2b7c9d-2222-4222-8222-bbbbbbbbbbbb",
        displayName: "Ada",
        role: "MEMBER",
        orderIndex: 20,
        wakePolicy: "MENTION",
        respondPolicy: "WHEN_MENTIONED",
        disabledAt: null,
        readCursor: null,
        selfOwned: false,
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    setActivePinia(createPinia());
});

describe("useSessionParticipantsStore (PLAN-0623)", () => {
    it("loads participants and capabilities for the session", async () => {
        getParticipants.mockResolvedValueOnce({
            participants: [participant({ participantId: "p-1" })],
            capabilities: CAPS,
        });
        const store = useSessionParticipantsStore();

        await store.load("session-1");

        expect(store.participants).toHaveLength(1);
        expect(store.capabilities).toEqual(CAPS);
        expect(store.error).toBe("");
    });

    it("keeps the participants a caller may not view out of the store", async () => {
        const { ApiError } = await import("../../../../composables/api");
        getParticipants.mockRejectedValueOnce(
            new ApiError({
                status: 403,
                code: "PARTICIPANT_CAP_DENIED",
                detail: "denied",
                requestId: "req-1",
            }),
        );
        const store = useSessionParticipantsStore();

        await store.load("session-1");

        expect(store.forbidden).toBe(true);
        expect(store.error).toBe("");
        expect(store.participants).toBeNull();
    });

    // D23-27：候选 = 我拥有的、且未停用。selfOwned 在 CP 已排除停用，这里再判 disabledAt 是双保险。
    it("only offers self-owned, enabled participants as speak-as candidates", async () => {
        getParticipants.mockResolvedValueOnce({
            participants: [
                participant({ participantId: "self", selfOwned: true }),
                participant({ participantId: "other", selfOwned: false }),
                participant({
                    participantId: "self-disabled",
                    selfOwned: true,
                    disabledAt: "2026-11-02T02:00:00Z",
                }),
            ],
            capabilities: CAPS,
        });
        const store = useSessionParticipantsStore();

        await store.load("session-1");

        expect(store.speakAsCandidates.map((item) => item.participantId)).toEqual(["self"]);
    });

    // 单一真相不变式：speakAs 与"存在 selfOwned=true 的行"必须一致。
    it("never exposes speak-as when the capability is off or no candidate exists", async () => {
        getParticipants.mockResolvedValueOnce({
            participants: [participant({ participantId: "self", selfOwned: true })],
            capabilities: { ...CAPS, speakAs: false },
        });
        const store = useSessionParticipantsStore();
        await store.load("session-1");
        expect(store.canSpeakAs).toBe(false);

        getParticipants.mockResolvedValueOnce({
            participants: [participant({ participantId: "other", selfOwned: false })],
            capabilities: CAPS,
        });
        await store.load("session-2");
        // 能力是 true 但没有候选 ⇒ 不暴露（这属于 CP 数据自相矛盾，UI 侧 fail-closed）。
        expect(store.canSpeakAs).toBe(false);
    });

    it("reuses one response for the same session (panel and composer share it)", async () => {
        getParticipants.mockResolvedValueOnce({
            participants: [participant({ participantId: "self", selfOwned: true })],
            capabilities: CAPS,
        });
        const store = useSessionParticipantsStore();

        await store.ensureLoaded("session-1");
        await store.ensureLoaded("session-1");
        await store.ensureLoaded("session-1");

        expect(getParticipants).toHaveBeenCalledTimes(1);
    });

    it("clears everything when the session goes away", async () => {
        getParticipants.mockResolvedValueOnce({
            participants: [participant({ participantId: "self", selfOwned: true })],
            capabilities: CAPS,
        });
        const store = useSessionParticipantsStore();
        await store.load("session-1");

        await store.load(null);

        expect(store.participants).toBeNull();
        expect(store.canSpeakAs).toBe(false);
    });
});

/**
 * PLAN-0660 T5.6 —— user-channel hint 与已读游标。
 *
 * 两条不变式（也是"接线没接上就会红"的地方）：
 * 1. hint **不是数据**，它只能触发一次名单重读；未读数永远由 CP 的 `readCursor.mentionCount` 派生。
 *    所以这里不 mock 任何"计数"，只验证 "hint 到达 ⇒ 重读 ⇒ 派生值跟着服务端走"。
 * 2. `applyCursor` 只采用服务端返回的游标（advance-only + clamp 都在 CP），本地不做加减。
 */
describe("user-channel hints and read cursor (PLAN-0660 T5.6)", () => {
    function cursor(mentionCount: number, lastReadEventSeq = 4) {
        return { lastReadEventSeq, mentionCount, updatedAt: "2026-11-05T00:00:00Z" };
    }

    /** 每个用例一份新对象：`applyCursor` 是**就地**更新行，共享 fixture 会串用例。 */
    function selfRow(mentionCount = 3): SessionParticipantView {
        return participant({
            participantId: "p-self",
            selfOwned: true,
            readCursor: cursor(mentionCount),
        });
    }

    it("re-reads the roster for a hint on the rendered session and derives unread from CP", async () => {
        vi.useFakeTimers();
        try {
            getParticipants.mockResolvedValueOnce({
                participants: [selfRow()],
                capabilities: CAPS,
            });
            const store = useSessionParticipantsStore();
            await store.load("session-1");
            expect(store.participants?.[0].readCursor?.mentionCount).toBe(3);

            // Z：别人 @ 了我 ⇒ CP 的派生未读数变了。客户端只会重读，不会自己 +1。
            getParticipants.mockResolvedValueOnce({
                participants: [{ ...selfRow(), readCursor: cursor(0, 12) }],
                capabilities: CAPS,
            });

            expect(store.onUserChannelHint("session-1", "p-self")).toBe(true);
            await vi.advanceTimersByTimeAsync(300); // 既有合并窗口，不是本测试新设的常量

            expect(getParticipants).toHaveBeenCalledTimes(2);
            expect(store.participants?.[0].readCursor).toEqual(cursor(0, 12));
        } finally {
            vi.useRealTimers();
        }
    });

    it("coalesces a burst of hints into one reload", async () => {
        vi.useFakeTimers();
        try {
            getParticipants.mockResolvedValue({ participants: [selfRow()], capabilities: CAPS });
            const store = useSessionParticipantsStore();
            await store.load("session-1");

            store.onUserChannelHint("session-1", "p-self");
            store.onUserChannelHint("session-1", "p-self");
            store.onUserChannelHint("session-1", "p-other");
            await vi.advanceTimersByTimeAsync(300);

            // 首读 1 次 + 合并后 1 次；三帧 hint 不该变成三次 GET。
            expect(getParticipants).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it("ignores a hint for a session that is not on screen", async () => {
        vi.useFakeTimers();
        try {
            getParticipants.mockResolvedValue({ participants: [selfRow()], capabilities: CAPS });
            const store = useSessionParticipantsStore();
            await store.load("session-1");

            expect(store.onUserChannelHint("session-2", "p-self")).toBe(false);
            await vi.advanceTimersByTimeAsync(300);

            expect(getParticipants).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("adopts the server-clamped cursor in place and leaves other rows alone", async () => {
        getParticipants.mockResolvedValueOnce({
            participants: [selfRow(), participant({ participantId: "p-other", selfOwned: false })],
            capabilities: CAPS,
        });
        const store = useSessionParticipantsStore();
        await store.load("session-1");

        store.applyCursor("p-self", cursor(0, 99));
        expect(store.participants?.[0].readCursor).toEqual(cursor(0, 99));

        // 行不在名单里（会话已切换）：不凭空造行，也不抛。
        store.applyCursor("p-not-loaded", cursor(5, 1));
        expect(store.participants).toHaveLength(2);
        expect(store.participants?.[1].readCursor).toBeNull();
    });
});
