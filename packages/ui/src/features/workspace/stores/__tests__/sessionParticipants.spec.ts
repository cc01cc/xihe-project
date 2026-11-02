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
        source: null,
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
