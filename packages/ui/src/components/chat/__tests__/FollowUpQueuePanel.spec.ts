import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import FollowUpQueuePanel from "../FollowUpQueuePanel.vue";
import { i18n } from "../../../i18n";
import type { ApiFollowUpItem, ApiFollowUpQueueSnapshot } from "../../../composables/api";
import type { Message } from "../../../types";

const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROOT_BRANCH_ID = "44444444-4444-4444-8444-444444444444";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const CHILD_RUN_ID = "55555555-5555-4555-8555-555555555555";

function queueItem(overrides: Partial<ApiFollowUpItem> = {}): ApiFollowUpItem {
    return {
        queueItemId: "77777777-7777-4777-8777-777777777777",
        queueSequence: 1,
        status: "queued",
        content: "queued follow-up",
        attachments: [],
        branchId: ROOT_BRANCH_ID,
        anchorRunId: RUN_ID,
        pauseReason: null,
        childRunId: null,
        childMessageId: null,
        createdAt: "2026-10-06T00:00:00Z",
        updatedAt: "2026-10-06T00:00:00Z",
        ...overrides,
    };
}

function queueSnapshot(
    overrides: Partial<ApiFollowUpQueueSnapshot> = {},
): ApiFollowUpQueueSnapshot {
    return {
        sessionId: SESSION_ID,
        queueState: "empty",
        outstandingCount: 0,
        capacityLimit: 5,
        pauseReason: null,
        items: [],
        ...overrides,
    };
}

function childMessage(overrides: Partial<Message> = {}): Message {
    return {
        id: "99999999-9999-4999-8999-999999999999",
        sessionId: SESSION_ID,
        role: "assistant",
        content: "child answer",
        timestamp: "2026-10-06T00:00:01Z",
        ...overrides,
    };
}

function mountPanel(props: {
    snapshot: ApiFollowUpQueueSnapshot;
    messages?: Message[];
    branchLabels?: Record<string, string>;
    busyItemId?: string | null;
    continuing?: boolean;
    error?: string | null;
}) {
    const {
        snapshot,
        messages = [],
        branchLabels = {},
        busyItemId = null,
        continuing = false,
        error = null,
    } = props;
    return mount(FollowUpQueuePanel, {
        props: { snapshot, messages, branchLabels, busyItemId, continuing, error },
        global: { plugins: [i18n] },
    });
}

function t(key: string, named?: Record<string, string | number>): string {
    return i18n.global.t(key, named);
}

describe("FollowUpQueuePanel", () => {
    it("renders queued FIFO list with capacity count and per-item withdraw", async () => {
        const first = queueItem({
            queueItemId: "aaaaaaaa-0000-4000-8000-000000000001",
            queueSequence: 1,
            content: "first queued",
        });
        const second = queueItem({
            queueItemId: "aaaaaaaa-0000-4000-8000-000000000002",
            queueSequence: 2,
            content: "second queued",
        });
        const wrapper = mountPanel({
            snapshot: queueSnapshot({
                queueState: "queued",
                outstandingCount: 2,
                items: [first, second],
            }),
        });

        const count = wrapper.get('[data-testid="follow-up-queue-count"]').text();
        expect(count).toContain("2");
        expect(count).toContain("5");
        expect(wrapper.findAll('[data-testid="follow-up-queue-item"]')).toHaveLength(2);
        expect(wrapper.find('[data-testid="follow-up-continue-button"]').exists()).toBe(false);
        expect(wrapper.text()).toContain(t("chat.followUpStatusQueued"));
        expect(wrapper.text()).toContain(t("chat.followUpStatusWaiting"));
        expect(wrapper.text()).toContain(t("chat.followUpCapacityNote", { capacity: 5 }));

        await wrapper.get('[data-testid="follow-up-withdraw-0"]').trigger("click");
        expect(wrapper.emitted("withdraw")).toHaveLength(1);
        expect(wrapper.emitted("withdraw")![0]).toEqual([first.queueItemId]);
    });

    it("shows paused reason and emits continue from the continue control", async () => {
        const wrapper = mountPanel({
            snapshot: queueSnapshot({
                queueState: "paused",
                outstandingCount: 1,
                pauseReason: "parent_cancelled",
                items: [
                    queueItem({
                        status: "paused",
                        pauseReason: "parent_cancelled",
                        content: "paused follow-up",
                    }),
                ],
            }),
        });

        expect(wrapper.get('[data-testid="follow-up-pause-reason"]').text()).toBe(
            t("chat.followUpPausedCancelled"),
        );
        expect(wrapper.text()).toContain(t("chat.followUpStatusPaused"));

        const continueButton = wrapper.get('[data-testid="follow-up-continue-button"]');
        expect(continueButton.attributes("disabled")).toBeUndefined();
        await continueButton.trigger("click");
        expect(wrapper.emitted("continue")).toHaveLength(1);
    });

    it("disables continue while continuing and disables withdraw while an item is busy", async () => {
        const busyItem = queueItem({
            queueItemId: "aaaaaaaa-0000-4000-8000-000000000003",
            status: "paused",
            pauseReason: "child_ambiguous",
        });
        const idleItem = queueItem({
            queueItemId: "aaaaaaaa-0000-4000-8000-000000000004",
            queueSequence: 2,
            status: "queued",
            content: "idle queued",
        });
        const wrapper = mountPanel({
            snapshot: queueSnapshot({
                queueState: "paused",
                outstandingCount: 2,
                pauseReason: "child_ambiguous",
                items: [busyItem, idleItem],
            }),
            busyItemId: busyItem.queueItemId,
            continuing: true,
        });

        const continueButton = wrapper.get('[data-testid="follow-up-continue-button"]');
        expect(continueButton.attributes("disabled")).toBeDefined();
        expect(continueButton.text()).toBe(t("chat.followUpContinuing"));

        expect(wrapper.findAll('button[data-testid^="follow-up-withdraw-"]')).toHaveLength(2);
        for (const button of wrapper.findAll('button[data-testid^="follow-up-withdraw-"]')) {
            expect(button.attributes("disabled")).toBeDefined();
        }
        expect(wrapper.text()).toContain(t("chat.followUpWithdrawing"));
    });

    it("renders admitted child as running without a withdraw control", () => {
        const wrapper = mountPanel({
            snapshot: queueSnapshot({
                queueState: "queued",
                outstandingCount: 1,
                items: [
                    queueItem({
                        status: "admitted",
                        content: null as unknown as string,
                        childRunId: CHILD_RUN_ID,
                        childMessageId: "99999999-9999-4999-8999-999999999999",
                    }),
                ],
            }),
            messages: [childMessage({ runId: CHILD_RUN_ID })],
        });

        expect(wrapper.text()).toContain(t("chat.followUpStatusRunning"));
        expect(wrapper.text()).toContain("child answer");
        expect(wrapper.find('[data-testid="follow-up-withdraw-0"]').exists()).toBe(false);
    });

    it("surfaces the attempted completed child when the queue is paused on child ambiguity", () => {
        const attempted = queueItem({
            queueItemId: "aaaaaaaa-0000-4000-8000-000000000005",
            queueSequence: 1,
            status: "completed",
            content: null as unknown as string,
            childRunId: CHILD_RUN_ID,
            childMessageId: "99999999-9999-4999-8999-999999999999",
        });
        const paused = queueItem({
            queueItemId: "aaaaaaaa-0000-4000-8000-000000000006",
            queueSequence: 2,
            status: "paused",
            pauseReason: "child_ambiguous",
            content: "still paused",
        });
        const wrapper = mountPanel({
            snapshot: queueSnapshot({
                queueState: "paused",
                outstandingCount: 1,
                pauseReason: "child_ambiguous",
                items: [attempted, paused],
            }),
            messages: [childMessage({ runId: CHILD_RUN_ID, terminalOutcome: "ambiguous" })],
        });

        expect(wrapper.findAll('[data-testid="follow-up-queue-item"]')).toHaveLength(2);
        expect(wrapper.text()).toContain(t("chat.followUpStatusAmbiguous"));
        expect(wrapper.get('[data-testid="follow-up-pause-reason"]').text()).toBe(
            t("chat.followUpPausedAmbiguous"),
        );
        expect(wrapper.find('[data-testid="follow-up-withdraw-0"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="follow-up-withdraw-1"]').exists()).toBe(true);
    });

    it("renders error alert and falls back to unavailable content without messages", () => {
        const wrapper = mountPanel({
            snapshot: queueSnapshot({
                queueState: "queued",
                outstandingCount: 1,
                items: [queueItem({ content: null as unknown as string })],
            }),
            error: "follow-up failed",
        });

        const alert = wrapper.get('[role="alert"]');
        expect(alert.text()).toBe("follow-up failed");
        expect(wrapper.text()).toContain(t("chat.followUpContentUnavailable"));
    });

    it("maps branch labels and falls back to the short branch id", () => {
        const wrapper = mountPanel({
            snapshot: queueSnapshot({
                queueState: "queued",
                outstandingCount: 2,
                items: [
                    queueItem({ queueItemId: "aaaaaaaa-0000-4000-8000-000000000007" }),
                    queueItem({
                        queueItemId: "aaaaaaaa-0000-4000-8000-000000000008",
                        queueSequence: 2,
                        branchId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                    }),
                ],
            }),
            branchLabels: { [ROOT_BRANCH_ID]: "main" },
        });

        expect(wrapper.text()).toContain("main");
        expect(wrapper.text()).toContain(`${t("chat.branchPathOption")} bbbbbbbb`);
    });
});
