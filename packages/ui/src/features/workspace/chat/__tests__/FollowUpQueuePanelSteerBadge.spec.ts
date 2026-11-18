import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import FollowUpQueuePanel from "../components/FollowUpQueuePanel.vue";
import { i18n } from "../../../../i18n";
import type { ApiFollowUpItem, ApiFollowUpQueueSnapshot } from "../../../../composables/api";

/**
 * task-188 S3：steer 徽标在既有 follow-up 队列项上的集成（cp-1 W0 对齐 ②）。
 */

const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LEAD_SESSION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BRANCH_ID = "44444444-4444-4444-8444-444444444444";

function queueItem(overrides: Partial<ApiFollowUpItem> = {}): ApiFollowUpItem {
    return {
        queueItemId: "77777777-7777-4777-8777-777777777777",
        queueSequence: 1,
        status: "queued",
        content: "queued follow-up",
        attachments: [],
        branchId: BRANCH_ID,
        anchorRunId: null,
        pauseReason: null,
        childRunId: null,
        childMessageId: null,
        sourceKind: null,
        fromSessionId: null,
        createdAt: "2026-10-06T00:00:00Z",
        updatedAt: "2026-10-06T00:00:00Z",
        ...overrides,
    };
}

function queueSnapshot(items: ApiFollowUpItem[]): ApiFollowUpQueueSnapshot {
    return {
        sessionId: SESSION_ID,
        queueState: "queued",
        outstandingCount: items.length,
        capacityLimit: 5,
        pauseReason: null,
        items,
    };
}

function mountPanel(snapshot: ApiFollowUpQueueSnapshot) {
    return mount(FollowUpQueuePanel, {
        props: { snapshot, messages: [], branchLabels: {} },
        global: { plugins: [i18n] },
    });
}

describe("FollowUpQueuePanel · steer source badge", () => {
    it("renders the badge only on agent_steer items and re-emits the jump", async () => {
        const steerItem = queueItem({
            queueItemId: "aaaaaaaa-0000-4000-8000-000000000001",
            queueSequence: 1,
            content: "先别合并，等我看完",
            sourceKind: "agent_steer",
            fromSessionId: LEAD_SESSION,
        });
        const humanItem = queueItem({
            queueItemId: "aaaaaaaa-0000-4000-8000-000000000002",
            queueSequence: 2,
            content: "human queued item",
        });
        const wrapper = mountPanel(queueSnapshot([steerItem, humanItem]));

        const items = wrapper.findAll('[data-testid="follow-up-queue-item"]');
        expect(items).toHaveLength(2);
        expect(items[0].find('[data-testid="steer-source-badge"]').exists()).toBe(true);
        expect(items[1].find('[data-testid="steer-source-badge"]').exists()).toBe(false);

        await items[0].get('[data-testid="steer-source-jump"]').trigger("click");
        expect(wrapper.emitted("navigate")).toEqual([[LEAD_SESSION]]);
    });
});
