import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia } from "pinia";
import { i18n } from "../../../../i18n";
import SessionParticipantsPanel from "../SessionParticipantsPanel.vue";
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
            removeSessionParticipant: vi.fn<() => Promise<void>>(),
            updateSessionParticipant: vi.fn<() => Promise<void>>(),
        },
    };
});

import { api } from "../../../../composables/api";

const getParticipants = vi.mocked(api.getSessionParticipants);
const removeParticipant = vi.mocked(api.removeSessionParticipant);
const apiUpdate = vi.mocked(api.updateSessionParticipant);

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
    source: "workspace",
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
    source: null,
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
