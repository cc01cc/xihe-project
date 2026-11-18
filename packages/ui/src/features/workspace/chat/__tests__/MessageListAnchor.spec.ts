import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { i18n } from "../../../../i18n";
import MessageList from "../components/MessageList.vue";
import type { DerivedRunAnchor } from "../derivedAnchors";
import type { Message, SessionRunSummary } from "../../../../types";

/**
 * task-1 / D-1846：anchor 在**对话流里**的落位（契约 A2/A4）。
 *
 * 钉死三件用户可见的事：
 *  1. 位置只由 `startedAt` 决定 —— 在两条消息之间插进去，不是追加在末尾；
 *  2. 状态更新不产生第二条 anchor，位置也不动（N2）；
 *  3. 不切开 run 组（anchor 落在组头之前，而不是组头与它的消息之间）。
 */
const RUN_A = "aaaaaaaa-1111-2222-3333-444444444444";
const RUN_B = "bbbbbbbb-1111-2222-3333-444444444444";

function message(
    id: string,
    runId: string,
    role: "user" | "assistant",
    timestamp: string,
): Message {
    return { id, sessionId: "s-1", role, content: `content-${id}`, timestamp, runId } as Message;
}

function runSummary(
    runId: string,
    status: string,
    createdAt: string,
    terminalAt: string | null,
): SessionRunSummary {
    return {
        runId,
        sessionId: "s-1",
        origin: "user_submission",
        status,
        terminalOutcome: status === "succeeded" ? "success" : null,
        errorCode: null,
        createdAt,
        terminalAt,
        waitingOnRunId: null,
        waitingToolCallId: null,
    } as SessionRunSummary;
}

function anchor(overrides: Partial<DerivedRunAnchor> = {}): DerivedRunAnchor {
    return {
        key: "run-child",
        runId: "cccccccc-1111-2222-3333-444444444444",
        sessionId: "child-a",
        spawnedFromSessionId: "s-1",
        startedAt: "2026-11-18T10:05:00.000Z",
        agentPrincipalId: "principal-xh",
        agentPrincipalName: "xh lead",
        subject: null,
        status: "running",
        terminalAt: null,
        ...overrides,
    };
}

const MESSAGES: Message[] = [
    message("a-user", RUN_A, "user", "2026-11-18T10:00:00.000Z"),
    message("a-assistant", RUN_A, "assistant", "2026-11-18T10:00:05.000Z"),
    message("b-user", RUN_B, "user", "2026-11-18T10:10:00.000Z"),
    message("b-assistant", RUN_B, "assistant", "2026-11-18T10:10:05.000Z"),
];

const RUNS: SessionRunSummary[] = [
    runSummary(RUN_A, "succeeded", "2026-11-18T10:00:00.000Z", "2026-11-18T10:00:05.000Z"),
    runSummary(RUN_B, "succeeded", "2026-11-18T10:10:00.000Z", "2026-11-18T10:10:05.000Z"),
];

function mountList(anchors: DerivedRunAnchor[], extra: Record<string, unknown> = {}) {
    return mount(MessageList, {
        props: { messages: MESSAGES, runs: RUNS, anchors, ...extra },
        global: {
            plugins: [i18n, createPinia()],
            stubs: {
                MessageScrollerProvider: { template: "<div><slot /></div>" },
                MessageScroller: { template: "<div><slot /></div>" },
                MessageScrollerViewport: { template: "<div><slot /></div>" },
                MessageScrollerContent: { template: "<div><slot /></div>" },
                MessageScrollerItem: { template: "<div><slot /></div>" },
                MessageScrollerButton: true,
                MessageSearch: true,
                Marker: { template: "<div><slot /></div>" },
                MessageItem: {
                    props: ["message"],
                    template: `<div data-testid="stub-message">{{ message.id }}</div>`,
                },
            },
        },
    });
}

/** 对话流里的可见顺序（消息 + anchor 混排）。 */
function visibleOrder(wrapper: ReturnType<typeof mountList>): string[] {
    return wrapper
        .findAll('[data-testid="stub-message"], [data-testid="run-anchor"]')
        .map((node) =>
            node.attributes("data-testid") === "run-anchor"
                ? `anchor:${node.attributes("data-anchor-session-id")}`
                : node.text(),
        );
}

describe("MessageList derived anchors (task-1)", () => {
    it("inserts the anchor at its startedAt position instead of appending it to the end (N1)", () => {
        const wrapper = mountList([anchor()]);
        expect(visibleOrder(wrapper)).toEqual([
            "a-user",
            "a-assistant",
            // 10:05 落在两个 run 之间；anchor 必须在第二个 run 之前，而不是最后。
            "anchor:child-a",
            "b-user",
            "b-assistant",
        ]);
        expect(wrapper.get('[data-testid="run-anchor"]').attributes("data-anchor-started-at")).toBe(
            "2026-11-18T10:05:00.000Z",
        );
    });

    it("does not split a run group: a mid-group time lands at that group's end", () => {
        // 10:00:03 落在 run A 内部（10:00:00 起、10:00:05 终）。
        const wrapper = mountList([anchor({ startedAt: "2026-11-18T10:00:03.000Z" })]);
        const order = visibleOrder(wrapper);
        // 不切开 run A：anchor 在它最后一条消息之后，下一个 run 之前。
        expect(order.indexOf("anchor:child-a")).toBeGreaterThan(order.indexOf("a-assistant"));
        expect(order.indexOf("anchor:child-a")).toBeLessThan(order.indexOf("b-user"));
        expect(wrapper.findAll('[data-testid="run-header"]')).toHaveLength(2);
    });

    it("keeps one anchor in place when the run turns terminal (N2: in-place update)", async () => {
        const wrapper = mountList([anchor({ status: "running" })]);
        expect(wrapper.findAll('[data-testid="run-anchor"]')).toHaveLength(1);
        const before = visibleOrder(wrapper);

        const done = anchor({ status: "succeeded", terminalAt: "2026-11-18T10:05:30.000Z" });
        await wrapper.setProps({ anchors: [done] });

        expect(wrapper.findAll('[data-testid="run-anchor"]')).toHaveLength(1);
        expect(visibleOrder(wrapper)).toEqual(before);
        expect(wrapper.get('[data-testid="run-anchor"]').attributes("data-anchor-status")).toBe(
            "succeeded",
        );
        expect(wrapper.get('[data-testid="run-anchor-duration"]').text()).toBe("30s");
    });

    it("does not move an existing anchor when later messages arrive", async () => {
        const wrapper = mountList([anchor()]);
        const before = visibleOrder(wrapper);
        await wrapper.setProps({
            messages: [
                ...MESSAGES,
                message("a-follow-up", RUN_A, "assistant", "2026-11-18T10:20:00.000Z"),
            ],
        });
        const after = visibleOrder(wrapper);
        expect(after.slice(0, before.length)).toEqual(before);
        expect(after[after.length - 1]).toBe("a-follow-up");
    });

    it("emits openSession with the child session id when the anchor is clicked (N3)", async () => {
        const wrapper = mountList([anchor()]);
        await wrapper.get('[data-testid="run-anchor-open"]').trigger("click");
        expect(wrapper.emitted("openSession")).toEqual([["child-a"]]);
    });

    it("tells the user when anchors were folded by the cap (never silent)", () => {
        const wrapper = mountList([anchor()], { anchorsHiddenCount: 3 });
        expect(wrapper.get('[data-testid="run-anchor-truncated"]').text()).toContain("3");
    });
});
