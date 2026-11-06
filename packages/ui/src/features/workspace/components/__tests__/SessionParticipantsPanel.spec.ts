import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { i18n } from "../../../../i18n";
import SessionParticipantsPanel from "../SessionParticipantsPanel.vue";
import { useUserQuestionsStore } from "../../stores/userQuestions";
import type {
    ParticipantReadCursor,
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
            removeSessionParticipant: vi.fn<() => Promise<void>>(),
            updateSessionParticipant: vi.fn<() => Promise<void>>(),
            advanceParticipantCursor: vi.fn<() => Promise<ParticipantReadCursor>>(),
        },
    };
});

import { api, PARTICIPANT_CURSOR_ADVANCE_TO_LATEST } from "../../../../composables/api";

const getParticipants = vi.mocked(api.getSessionParticipants);
const removeParticipant = vi.mocked(api.removeSessionParticipant);
const apiUpdate = vi.mocked(api.updateSessionParticipant);
const apiAdvanceCursor = vi.mocked(api.advanceParticipantCursor);

const ALL_CAPS: SessionParticipantCapabilities = { view: true, manage: true, mention: true };

const AGENT: SessionParticipantView = {
    participantId: "p-agent",
    principalKind: "AGENT",
    principalId: "9f1d0c1e-1111-4111-8111-aaaaaaaaaaaa",
    displayName: "Research Agent",
    role: "PRIMARY",
    orderIndex: 10,
    wakePolicy: "ALL_MESSAGES",
    respondPolicy: "ALWAYS",
    disabledAt: null,
    readCursor: { lastReadEventSeq: 12, mentionCount: 3, updatedAt: "2026-11-02T00:00:00Z" },
    defaultModelProvider: "openai",
    defaultModelName: "gpt-5",
};

const HUMAN: SessionParticipantView = {
    participantId: "p-human",
    principalKind: "HUMAN",
    principalId: "5a2b7c9d-2222-4222-8222-bbbbbbbbbbbb",
    displayName: "Ada Lovelace",
    role: "MEMBER",
    orderIndex: 20,
    wakePolicy: "MENTION",
    respondPolicy: "WHEN_MENTIONED",
    disabledAt: null,
    readCursor: null,
    defaultModelProvider: null,
    defaultModelName: null,
};

function mountPanel(props: Record<string, unknown> = {}) {
    return mount(SessionParticipantsPanel, {
        props: { sessionId: "session-1", ...props },
        global: { plugins: [i18n, createPinia()] },
    });
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe("SessionParticipantsPanel states (PLAN-0623 N3)", () => {
    it("shows the empty state and does not fetch without a session", async () => {
        const wrapper = mountPanel({ sessionId: null });
        await flushPromises();

        expect(wrapper.find('[data-testid="participants-empty"]').exists()).toBe(true);
        expect(getParticipants).not.toHaveBeenCalled();
    });

    it("shows a loading state instead of an empty list while the request is in flight", async () => {
        let resolve: (value: SessionParticipantListResponse) => void = () => {};
        getParticipants.mockReturnValueOnce(
            new Promise<SessionParticipantListResponse>((done) => {
                resolve = done;
            }),
        );

        const wrapper = mountPanel();
        await flushPromises();
        expect(wrapper.find('[data-testid="participants-loading"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="participants-empty"]').exists()).toBe(false);

        resolve({ participants: [], capabilities: ALL_CAPS });
        await flushPromises();
        expect(wrapper.find('[data-testid="participants-empty"]').exists()).toBe(true);
    });

    it("shows an error with the diagnostic detail and retries on demand", async () => {
        getParticipants.mockRejectedValueOnce(
            new Error('getSessionParticipants: unexpected payload (received keys: ["items"])'),
        );
        const wrapper = mountPanel();
        await flushPromises();

        expect(wrapper.find('[data-testid="participants-error"]').exists()).toBe(true);
        expect(wrapper.get('[data-testid="participants-error-detail"]').text()).toContain("items");
        expect(wrapper.find('[data-testid="participants-empty"]').exists()).toBe(false);

        getParticipants.mockResolvedValueOnce({ participants: [HUMAN], capabilities: ALL_CAPS });
        await wrapper.get('[data-testid="participants-retry"]').trigger("click");
        await flushPromises();

        expect(getParticipants).toHaveBeenCalledTimes(2);
        expect(wrapper.find('[data-testid="participants-error"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="participants-list"]').exists()).toBe(true);
    });

    it("hides the rows when the caller may not view participants", async () => {
        getParticipants.mockResolvedValueOnce({
            participants: [HUMAN],
            capabilities: { view: false, manage: false, mention: false },
        });
        const wrapper = mountPanel();
        await flushPromises();

        expect(wrapper.find('[data-testid="participants-forbidden"]').exists()).toBe(true);
        expect(wrapper.findAll('[data-testid^="participant-row-"]')).toHaveLength(0);
    });
});

/**
 * PLAN-0660 T5.21（审计 P1-2 / 用户 2026-11-07 裁定 ③）：面板级「N 条待答」汇总徽标。
 *
 * 判据三条：
 * 1. **同源** —— 数值就是 `useUserQuestionsStore.pendingCount`（侧边栏问题卡入口用的同一个
 *    store、同一个服务端派生值）。这里靠「改 store ⇒ 徽标跟着变」来钉，本地累加会红。
 * 2. **0 不渲染** —— 与行内未读徽标「缺失即不渲染」同一纪律，零态不占位。
 * 3. **行内 @未读不动** —— 那是 per-participant 的 CP 派生游标，与用户级待答是两个维度；
 *    把 `pendingCount` 塞进每行会让所有行显示同一个全局数字（语义 bug，已否决）。
 */
describe("SessionParticipantsPanel pending-question summary (PLAN-0660 T5.21 裁定 ③)", () => {
    function mountWithPending(pendingCount: number, props: Record<string, unknown> = {}) {
        const pinia = createPinia();
        setActivePinia(pinia);
        const wrapper = mount(SessionParticipantsPanel, {
            props: { sessionId: "session-1", ...props },
            global: { plugins: [i18n, pinia] },
        });
        const questions = useUserQuestionsStore();
        questions.pendingCount = pendingCount;
        return { wrapper, questions };
    }

    it("renders the store's pendingCount and disappears at zero", async () => {
        getParticipants.mockResolvedValueOnce({
            participants: [AGENT],
            capabilities: ALL_CAPS,
        });
        const { wrapper, questions } = mountWithPending(2);
        await flushPromises();

        expect(
            wrapper.get('[data-testid="participants-pending-questions-badge"]').text(),
        ).toContain("2");

        // 同源：store 是唯一来源 —— 改成 5 徽标必须跟到 5。
        questions.pendingCount = 5;
        await flushPromises();
        expect(
            wrapper.get('[data-testid="participants-pending-questions-badge"]').text(),
        ).toContain("5");

        // 零态不渲染：整块消失，不留空壳。
        questions.pendingCount = 0;
        await flushPromises();
        expect(wrapper.find('[data-testid="participants-pending-questions"]').exists()).toBe(false);
    });

    it("keeps the per-row mention badge independent of the user-level pending count", async () => {
        getParticipants.mockResolvedValueOnce({
            participants: [AGENT, HUMAN],
            capabilities: ALL_CAPS,
        });
        const { wrapper } = mountWithPending(4);
        await flushPromises();

        // 用户级待答 4，行内 @未读仍各自是 CP 游标派生的 3 / 无 —— 两个维度互不串味。
        expect(
            wrapper.get('[data-testid="participants-pending-questions-badge"]').text(),
        ).toContain("4");
        expect(wrapper.get('[data-testid="participant-mention-badge-p-agent"]').text()).toContain(
            "3",
        );
        expect(wrapper.find('[data-testid="participant-mention-badge-p-human"]').exists()).toBe(
            false,
        );
    });

    it("does not render without an open session", async () => {
        const { wrapper } = mountWithPending(3, { sessionId: null });
        await flushPromises();

        expect(wrapper.find('[data-testid="participants-pending-questions"]').exists()).toBe(false);
        expect(getParticipants).not.toHaveBeenCalled();
    });
});

describe("SessionParticipantsPanel rows and gating (PLAN-0623 U2/F-01)", () => {
    it("renders rows, shows the model intent only for agents, and keeps the mention badge", async () => {
        getParticipants.mockResolvedValueOnce({
            participants: [AGENT, HUMAN],
            capabilities: ALL_CAPS,
        });
        const wrapper = mountPanel();
        await flushPromises();

        expect(wrapper.findAll('[data-testid^="participant-row-"]')).toHaveLength(2);
        expect(wrapper.get('[data-testid="participant-model-p-agent"]').text()).toBe(
            "openai / gpt-5",
        );
        expect(wrapper.find('[data-testid="participant-model-p-human"]').exists()).toBe(false);
        expect(wrapper.get('[data-testid="participant-mention-badge-p-agent"]').text()).toContain(
            "3",
        );
        expect(wrapper.find('[data-testid="participant-mention-badge-p-human"]').exists()).toBe(
            false,
        );
    });

    it("disables mention and remove before the click when capabilities deny them", async () => {
        getParticipants.mockResolvedValueOnce({
            participants: [HUMAN],
            capabilities: { view: true, manage: false, mention: false },
        });
        const wrapper = mountPanel();
        await flushPromises();

        expect(
            wrapper.get('[data-testid="participant-mention-p-human"]').attributes("disabled"),
        ).toBeDefined();
        expect(
            wrapper.get('[data-testid="participant-remove-p-human"]').attributes("disabled"),
        ).toBeDefined();
    });

    it("enables the actions when capabilities allow them", async () => {
        getParticipants.mockResolvedValueOnce({ participants: [HUMAN], capabilities: ALL_CAPS });
        const wrapper = mountPanel();
        await flushPromises();

        expect(
            wrapper.get('[data-testid="participant-mention-p-human"]').attributes("disabled"),
        ).toBeUndefined();
        expect(
            wrapper.get('[data-testid="participant-remove-p-human"]').attributes("disabled"),
        ).toBeUndefined();
    });

    it("never offers removal of the PRIMARY participant", async () => {
        getParticipants.mockResolvedValueOnce({ participants: [AGENT], capabilities: ALL_CAPS });
        const wrapper = mountPanel();
        await flushPromises();

        expect(
            wrapper.get('[data-testid="participant-remove-p-agent"]').attributes("disabled"),
        ).toBeDefined();
    });

    it("soft-disables a member: two clicks, DELETE, then refetch keeps the row with its badge", async () => {
        getParticipants.mockResolvedValueOnce({ participants: [HUMAN], capabilities: ALL_CAPS });
        removeParticipant.mockResolvedValueOnce(undefined);
        // D23-26：删除后 GET 仍返回该行，只是 disabledAt 非空。
        getParticipants.mockResolvedValueOnce({
            participants: [{ ...HUMAN, disabledAt: "2026-11-02T02:00:00Z" }],
            capabilities: ALL_CAPS,
        });

        const wrapper = mountPanel();
        await flushPromises();

        const remove = wrapper.get('[data-testid="participant-remove-p-human"]');
        const idleLabel = remove.text();
        await remove.trigger("click");
        expect(remove.text()).not.toBe(idleLabel);
        expect(remove.text()).toMatch(/确认|confirm/i);
        expect(removeParticipant).not.toHaveBeenCalled();

        await remove.trigger("click");
        await flushPromises();

        expect(removeParticipant).toHaveBeenCalledWith("session-1", "p-human");
        expect(getParticipants).toHaveBeenCalledTimes(2);
        expect(wrapper.findAll('[data-testid^="participant-row-"]')).toHaveLength(1);
        expect(wrapper.find('[data-testid="participant-disabled-badge-p-human"]').exists()).toBe(
            true,
        );
    });
});

describe("SessionParticipantsPanel T3.6/T3.7 and policy editing (PLAN-0623)", () => {
    it("uses a different empty wording when a session is selected", async () => {
        getParticipants.mockResolvedValueOnce({ participants: [], capabilities: ALL_CAPS });
        const wrapper = mountPanel();
        await flushPromises();

        const empty = wrapper.get('[data-testid="participants-empty"]');
        expect(empty.text()).toMatch(/还没有|no participants/i);
        expect(empty.text()).not.toMatch(/选择一个会话|Select a session/i);
    });

    it("keeps the select-a-session wording when there is no session", async () => {
        const wrapper = mountPanel({ sessionId: null });
        await flushPromises();

        const empty = wrapper.get('[data-testid="participants-empty"]');
        expect(empty.text()).toMatch(/选择一个会话|Select a session/i);
    });

    it("treats an HTTP 403 as forbidden, not as an empty list and not as a load error", async () => {
        const { ApiError } = await import("../../../../composables/api");
        getParticipants.mockRejectedValueOnce(
            new ApiError({
                status: 403,
                code: "PARTICIPANT_CAP_DENIED",
                detail: "denied",
                requestId: "req-1",
            }),
        );
        const wrapper = mountPanel();
        await flushPromises();

        expect(wrapper.find('[data-testid="participants-forbidden"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="participants-error"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="participants-empty"]').exists()).toBe(false);
    });

    it("sends only the changed policy field and refetches on success", async () => {
        getParticipants.mockResolvedValueOnce({ participants: [HUMAN], capabilities: ALL_CAPS });
        apiUpdate.mockResolvedValueOnce(undefined);
        getParticipants.mockResolvedValueOnce({
            participants: [{ ...HUMAN, wakePolicy: "ALL_MESSAGES" }],
            capabilities: ALL_CAPS,
        });

        const wrapper = mountPanel();
        await flushPromises();

        const select = wrapper.get('[data-testid="participant-wake-select-p-human"]');
        expect(select.attributes("data-pending")).toBeUndefined();
        await select.setValue("ALL_MESSAGES");
        await flushPromises();

        expect(apiUpdate).toHaveBeenCalledWith("session-1", "p-human", {
            wakePolicy: "ALL_MESSAGES",
        });
        expect(getParticipants).toHaveBeenCalledTimes(2);
    });

    it("shows the localized PRIMARY message and keeps the old value when PATCH is refused", async () => {
        const { ApiError } = await import("../../../../composables/api");
        getParticipants.mockResolvedValueOnce({ participants: [HUMAN], capabilities: ALL_CAPS });
        apiUpdate.mockRejectedValueOnce(
            new ApiError({
                status: 409,
                code: "PARTICIPANT_PRIMARY_IMMUTABLE",
                detail: "PRIMARY is immutable",
                requestId: "req-2",
            }),
        );

        const wrapper = mountPanel();
        await flushPromises();

        await wrapper
            .get('[data-testid="participant-wake-select-p-human"]')
            .setValue("ALL_MESSAGES");
        await flushPromises();

        expect(wrapper.get('[data-testid="participants-error-detail"]').text()).toBe(
            i18n.global.t("workspace.participantPrimaryImmutable"),
        );
        // 旧值保留：props 没变，下拉仍回到原值。
        expect(
            (
                wrapper.get('[data-testid="participant-wake-select-p-human"]')
                    .element as HTMLSelectElement
            ).value,
        ).toBe("MENTION");
    });

    it("never offers policy selects for the PRIMARY participant", async () => {
        getParticipants.mockResolvedValueOnce({ participants: [AGENT], capabilities: ALL_CAPS });
        const wrapper = mountPanel();
        await flushPromises();

        expect(wrapper.find('[data-testid="participant-wake-select-p-agent"]').exists()).toBe(
            false,
        );
        expect(wrapper.find('[data-testid="participant-mention-p-agent"]').exists()).toBe(true);
    });

    it("emits the display name when the mention action is allowed", async () => {
        getParticipants.mockResolvedValueOnce({ participants: [HUMAN], capabilities: ALL_CAPS });
        const wrapper = mountPanel();
        await flushPromises();

        await wrapper.get('[data-testid="participant-mention-p-human"]').trigger("click");
        expect(wrapper.emitted("mention")).toEqual([["Ada Lovelace"]]);
    });

    it("does not emit a mention when the capability denies it", async () => {
        getParticipants.mockResolvedValueOnce({
            participants: [HUMAN],
            capabilities: { view: true, manage: true, mention: false },
        });
        const wrapper = mountPanel();
        await flushPromises();

        await wrapper.get('[data-testid="participant-mention-p-human"]').trigger("click");
        expect(wrapper.emitted("mention")).toBeUndefined();
    });
});

describe("ParticipantRow without a display name (PLAN-0623 human-display fix)", () => {
    const NAMELESS: SessionParticipantView = { ...HUMAN, displayName: null };

    it("shows a localized placeholder instead of leaking a UUID", async () => {
        getParticipants.mockResolvedValueOnce({ participants: [NAMELESS], capabilities: ALL_CAPS });
        const wrapper = mountPanel();
        await flushPromises();

        const row = wrapper.get('[data-testid="participant-row-p-human"]');
        // 行内**任何**位置都不得出现 UUID 片段（UUID 不是名字）。
        expect(row.text()).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
        expect(row.text()).toContain(i18n.global.t("workspace.participantUnknownName"));
    });

    it("derives the initials from the placeholder, not from the principal id", async () => {
        getParticipants.mockResolvedValueOnce({ participants: [NAMELESS], capabilities: ALL_CAPS });
        const wrapper = mountPanel();
        await flushPromises();

        const initials = wrapper.get('[data-testid="participant-initials-p-human"]').text();
        // 旧兜底会得到 principalId 前两位（fixture 是 `5a2b…` ⇒ "5A"）。
        expect(initials).not.toBe("5A");
        expect(initials.length).toBeGreaterThan(0);
        expect(initials).not.toMatch(/\d/);
    });

    it("disables mention when there is no real name to insert", async () => {
        getParticipants.mockResolvedValueOnce({ participants: [NAMELESS], capabilities: ALL_CAPS });
        const wrapper = mountPanel();
        await flushPromises();

        expect(
            wrapper.get('[data-testid="participant-mention-p-human"]').attributes("disabled"),
        ).toBeDefined();
        await wrapper.get('[data-testid="participant-mention-p-human"]').trigger("click");
        expect(wrapper.emitted("mention")).toBeUndefined();
    });
});

describe("soft-disabled row affordances (PLAN-0623, Lead screenshot review)", () => {
    const DISABLED: SessionParticipantView = { ...HUMAN, disabledAt: "2026-11-02T02:00:00Z" };

    it("disables mention and remove on a disabled participant, even with every capability", async () => {
        getParticipants.mockResolvedValueOnce({ participants: [DISABLED], capabilities: ALL_CAPS });
        const wrapper = mountPanel();
        await flushPromises();

        expect(
            wrapper.get('[data-testid="participant-mention-p-human"]').attributes("disabled"),
        ).toBeDefined();
        expect(
            wrapper.get('[data-testid="participant-remove-p-human"]').attributes("disabled"),
        ).toBeDefined();
    });

    it("keeps the disabled row visible and emits nothing when its actions are clicked", async () => {
        getParticipants.mockResolvedValueOnce({ participants: [DISABLED], capabilities: ALL_CAPS });
        const wrapper = mountPanel();
        await flushPromises();

        await wrapper.get('[data-testid="participant-mention-p-human"]').trigger("click");
        await wrapper.get('[data-testid="participant-remove-p-human"]').trigger("click");

        expect(wrapper.emitted("mention")).toBeUndefined();
        expect(removeParticipant).not.toHaveBeenCalled();
        expect(wrapper.get('[data-testid="participant-row-p-human"]').exists()).toBe(true);
    });
});

describe("GUARD role badge (PLAN-0625 M3, icon not color)", () => {
    it("marks the GUARD row with a shield icon inside the existing badge (no new color)", async () => {
        getParticipants.mockResolvedValueOnce({
            participants: [
                { ...HUMAN, participantId: "p-guard", role: "GUARD", displayName: "Guardian" },
            ],
            capabilities: ALL_CAPS,
        });
        const wrapper = mountPanel();
        await flushPromises();

        const badge = wrapper.get('[data-testid="participant-role-badge-p-guard"]');
        expect(badge.attributes("data-session-role")).toBe("GUARD");
        // 区分度 = icon（Shield），不是新色：徽标仍是同一个中性边框底色。
        expect(badge.find("svg").exists()).toBe(true);
        expect(badge.classes().join(" ")).not.toMatch(/destructive|amber|red/);
        // 非 GUARD 行不该有 icon。
        getParticipants.mockResolvedValueOnce({ participants: [HUMAN], capabilities: ALL_CAPS });
        const plain = mountPanel();
        await flushPromises();
        expect(
            plain.get('[data-testid="participant-role-badge-p-human"]').find("svg").exists(),
        ).toBe(false);
    });
});

/**
 * PLAN-0660 T5.6 —— 参数行上的"标记已读"。产品路径是**控件 → 新增 api client → PATCH**；
 * 这些用例同时也是"控件没接线就会红"的门：不点控件不会调 `advanceParticipantCursor`，
 * 点了之后徽标必须真的按**服务端**返回的 `mentionCount` 归零（不是本地减一、也不是再拉一次名单）。
 */
describe("participant read cursor advance (PLAN-0660 T5.6)", () => {
    const CURSOR = (mentionCount: number, lastReadEventSeq = 12): ParticipantReadCursor => ({
        lastReadEventSeq,
        mentionCount,
        updatedAt: "2026-11-05T00:00:00Z",
    });

    /** 我自己的那一行（CP 归约 `selfOwned` + HUMAN）—— 唯一该出现控件的地方。 */
    function myRow(mentionCount = 3): SessionParticipantView {
        return {
            ...HUMAN,
            participantId: "p-me",
            displayName: "Me Myself",
            selfOwned: true,
            readCursor: CURSOR(mentionCount),
        };
    }

    it("renders the advance control only on the caller's own human row", async () => {
        getParticipants.mockResolvedValueOnce({
            participants: [
                // 我拥有的 AGENT 主体同样是 selfOwned，但游标是人的，不该出现控件。
                { ...AGENT, participantId: "p-my-agent", selfOwned: true },
                myRow(),
                HUMAN,
            ],
            capabilities: ALL_CAPS,
        });
        const wrapper = mountPanel();
        await flushPromises();

        const controls = wrapper.findAll('[data-testid="participant-cursor-advance"]');
        expect(controls).toHaveLength(1);
        expect(
            wrapper
                .find(
                    '[data-testid="participant-row-p-me"] [data-testid="participant-cursor-advance"]',
                )
                .exists(),
        ).toBe(true);
        expect(
            wrapper
                .find(
                    '[data-testid="participant-row-p-my-agent"] [data-testid="participant-cursor-advance"]',
                )
                .exists(),
        ).toBe(false);
        expect(
            wrapper
                .find(
                    '[data-testid="participant-row-p-human"] [data-testid="participant-cursor-advance"]',
                )
                .exists(),
        ).toBe(false);
    });

    it("PATCHes the sentinel ceiling and zeroes the badge from the response (no refetch)", async () => {
        getParticipants.mockResolvedValueOnce({ participants: [myRow(3)], capabilities: ALL_CAPS });
        apiAdvanceCursor.mockResolvedValueOnce(CURSOR(0, 42));

        const wrapper = mountPanel();
        await flushPromises();
        expect(wrapper.find('[data-testid="participant-mention-badge-p-me"]').exists()).toBe(true);

        await wrapper.get('[data-testid="participant-cursor-advance"]').trigger("click");
        await flushPromises();

        // 上限由 CP 夹取：前端只传哨兵值，不自己算会话最大 sequence。
        expect(apiAdvanceCursor).toHaveBeenCalledWith(
            "session-1",
            "p-me",
            PARTICIPANT_CURSOR_ADVANCE_TO_LATEST,
        );
        // 徽标来自服务端返回的 mentionCount=0 ⇒ 立即消失，且**没有**重拉整份名单。
        expect(wrapper.find('[data-testid="participant-mention-badge-p-me"]').exists()).toBe(false);
        expect(getParticipants).toHaveBeenCalledTimes(1);
        expect(wrapper.find('[data-testid="participants-error-detail"]').exists()).toBe(false);
    });

    it("maps 403 CURSOR_SELF_ONLY to readable copy and keeps the badge untouched", async () => {
        const { ApiError } = await import("../../../../composables/api");
        getParticipants.mockResolvedValueOnce({ participants: [myRow(3)], capabilities: ALL_CAPS });
        apiAdvanceCursor.mockRejectedValueOnce(
            new ApiError({
                status: 403,
                code: "CURSOR_SELF_ONLY",
                detail: "The read cursor can only be advanced by its own human participant",
                requestId: "req-cursor",
            }),
        );

        const wrapper = mountPanel();
        await flushPromises();

        await wrapper.get('[data-testid="participant-cursor-advance"]').trigger("click");
        await flushPromises();

        // 本地化文案（不是 CP 的英文 detail）。
        expect(wrapper.get('[data-testid="participants-error-detail"]').text()).toBe(
            i18n.global.t("workspace.participantCursorSelfOnly"),
        );
        // 失败不改本地状态：徽标仍是服务端的 3。
        expect(wrapper.get('[data-testid="participant-mention-badge-p-me"]').text()).toContain("3");
        expect(getParticipants).toHaveBeenCalledTimes(1);
    });
});
