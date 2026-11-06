import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createPinia, setActivePinia } from "pinia";
import MessageList from "../components/MessageList.vue";
import type { Message, SessionRunSummary } from "../../../../types";

/**
 * PLAN-0659 T1.1：run 分组渲染（两 run 各自分组 + 行归属 + 失败 run 默认折叠 + 单 run 不分）。
 * 只钉分组结构（DOM/testid），消息内部渲染用 stub；身份断言只认 `data-run-id` 全文。
 */
const i18n = createI18n({
    legacy: false,
    locale: "zh",
    messages: {
        zh: {
            // T1.3 接上后 MessageList 会为每条消息解析投递语义（显示名 fallback 走这个 key）；
            // 本 spec 只钉分组结构，但保留该 key 以免 intlify 缺键告警淹没输出。
            workspace: { participantUnknownName: "未知用户" },
            chat: {
                runHeader: { toggle: "展开或折叠 run {run}" },
                followUpStatusCompleted: "已完成",
                followUpStatusFailed: "失败",
                // BL-406：折叠 run 的摘要行也要渲染终态芯片，文案走同一 resolver。
                followUpStatusCancelled: "已取消",
                derivedStateOutcome: { partial: "部分完成" },
            },
        },
    },
});

const RUN_A = "aaaaaaaa-1111-2222-3333-444444444444";
const RUN_B = "bbbbbbbb-1111-2222-3333-444444444444";

function message(id: string, runId: string, role: "user" | "assistant"): Message {
    return {
        id,
        sessionId: "s-1",
        role,
        content: `content-${id}`,
        timestamp: "2026-11-04T10:00:00.000Z",
        runId,
    } as unknown as Message;
}

function runSummary(runId: string, status: string, terminalOutcome: string | null) {
    return {
        runId,
        sessionId: "s-1",
        origin: "user_submission",
        status,
        terminalOutcome,
        errorCode: null,
        createdAt: "2026-11-04T10:00:00.000Z",
        terminalAt: "2026-11-04T10:00:03.400Z",
        waitingOnRunId: null,
        waitingToolCallId: null,
    } as unknown as SessionRunSummary;
}

function mountList(messages: Message[], runs: SessionRunSummary[]) {
    return mount(MessageList, {
        props: { messages, runs },
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

setActivePinia(createPinia());

describe("MessageList run grouping (PLAN-0659 T1.1)", () => {
    it("groups two runs under their own headers, keeping run-id identity", () => {
        const wrapper = mountList(
            [
                message("a-user", RUN_A, "user"),
                message("a-assistant", RUN_A, "assistant"),
                message("b-user", RUN_B, "user"),
                message("b-assistant", RUN_B, "assistant"),
            ],
            [runSummary(RUN_A, "succeeded", "success"), runSummary(RUN_B, "succeeded", "success")],
        );

        const headers = wrapper.findAll('[data-testid="run-header"]');
        expect(headers).toHaveLength(2);
        expect(headers.map((header) => header.attributes("data-run-id"))).toEqual([RUN_A, RUN_B]);
        // 行归属：每个 run 的 head 后跟它自己的两条消息（顺序保持）。
        expect(wrapper.findAll('[data-testid="stub-message"]').map((node) => node.text())).toEqual([
            "a-user",
            "a-assistant",
            "b-user",
            "b-assistant",
        ]);
        // 分组态下消息带缩进容器。
        expect(wrapper.findAll('[data-testid="run-group-body"]')).toHaveLength(4);
    });

    it("collapses failed runs to a single header line by default, expands on click", async () => {
        const wrapper = mountList(
            [
                message("a-user", RUN_A, "user"),
                message("a-assistant", RUN_A, "assistant"),
                message("b-user", RUN_B, "user"),
                message("b-assistant", RUN_B, "assistant"),
            ],
            [runSummary(RUN_A, "succeeded", "success"), runSummary(RUN_B, "failed", "error")],
        );

        // 失败 run 默认折叠：只有成功 run 的两条消息被渲染。
        expect(wrapper.findAll('[data-testid="stub-message"]').map((node) => node.text())).toEqual([
            "a-user",
            "a-assistant",
        ]);
        const failedHeader = wrapper
            .findAll('[data-testid="run-header"]')
            .find((header) => header.attributes("data-run-id") === RUN_B)!;
        expect(failedHeader.attributes("data-failed")).toBe("true");

        await failedHeader.get('[data-testid="run-header-toggle"]').trigger("click");
        expect(
            wrapper.findAll('[data-testid="stub-message"]').map((node) => node.text()),
        ).toContain("b-assistant");
    });

    it("keeps two fan-out runs apart even though their origin values differ (scheduled wake)", () => {
        // PLAN-0665 M1 真栈实测（2026-11-05）：TO 双目标消息派生出两条 run ——
        //   首条（用户提交）：origin = user_submission
        //   派生（wake 载体）：origin = scheduled（wake 的既有分类，不是 user_submission）
        // 两者 trigger_source 都是 user、parent_run_id 都是 NULL。所以"按 origin 分组"会拆错/并错：
        // 分组只认 runId / durable delivery；origin 不同也不能合并，相同也不能合并。
        const groupA = runSummary(RUN_A, "succeeded", "success");
        const groupB = { ...runSummary(RUN_B, "succeeded", "success"), origin: "scheduled" };
        expect(groupA.origin).toBe("user_submission");
        expect(groupB.origin).toBe("scheduled");
        expect(groupA.origin).not.toBe(groupB.origin);

        const runs = [groupA, groupB];
        const wrapper = mountList(
            [
                {
                    ...message("a-user", RUN_A, "user"),
                    delivery: { to: ["part-alpha", "part-helper"] },
                } as Message,
                message("a-assistant", RUN_A, "assistant"),
                message("b-assistant", RUN_B, "assistant"),
            ],
            runs,
        );

        const headers = wrapper.findAll('[data-testid="run-header"]');
        expect(headers.map((header) => header.attributes("data-run-id"))).toEqual([RUN_A, RUN_B]);
        expect(wrapper.findAll('[data-testid="run-group-body"]')).toHaveLength(3);
    });

    it("does not group (no header, no indent) when the session has a single run", () => {
        const wrapper = mountList(
            [message("a-user", RUN_A, "user"), message("a-assistant", RUN_A, "assistant")],
            [runSummary(RUN_A, "succeeded", "success")],
        );

        expect(wrapper.find('[data-testid="run-header"]').exists()).toBe(false);
        expect(
            wrapper.find('[data-testid="run-group-body"]').attributes("class") ?? "",
        ).not.toContain("border-l");
        expect(wrapper.findAll('[data-testid="stub-message"]')).toHaveLength(2);
    });
});

/**
 * BL-406（PLAN-0631 W11 判据「终态芯片常显」）：`defaultCollapsed` 让失败/取消 run 只剩 run 头，
 * 消息行（含行尾芯片）整体不渲染 ⇒ 修复前"常显"不成立。修复后折叠摘要行补渲染同一枚芯片，
 * 且不在折叠体/隐藏容器内；`succeeded`/`failed` 仍然没有该芯片（D31-02）。
 */
describe("MessageList terminal chip under default collapse (BL-406)", () => {
    function twoRuns(bStatus: string, bOutcome: string) {
        return mountList(
            [
                message("a-user", RUN_A, "user"),
                message("a-assistant", RUN_A, "assistant"),
                message("b-user", RUN_B, "user"),
                message("b-assistant", RUN_B, "assistant"),
            ],
            [runSummary(RUN_A, "succeeded", "success"), runSummary(RUN_B, bStatus, bOutcome)],
        );
    }

    it("keeps the cancelled chip queryable while the run is collapsed by default", async () => {
        const wrapper = twoRuns("cancelled", "cancelled");

        // 前置：RUN_B 确实默认折叠（消息体未渲染、toggle 声明 aria-expanded=false）。
        const cancelledHeader = wrapper
            .findAll('[data-testid="run-header"]')
            .find((header) => header.attributes("data-run-id") === RUN_B)!;
        expect(
            cancelledHeader.get('[data-testid="run-header-toggle"]').attributes("aria-expanded"),
        ).toBe("false");
        expect(wrapper.findAll('[data-testid="stub-message"]').map((node) => node.text())).toEqual([
            "a-user",
            "a-assistant",
        ]);

        // 判据：不展开也能查到芯片，文案 / title / aria-label 一字不差。
        const chip = wrapper.get('[data-testid="message-terminated"]');
        expect(chip.attributes("data-run-outcome")).toBe("cancelled");
        expect(chip.text()).toBe("已取消");
        expect(chip.attributes("title")).toBe("已取消");
        expect(chip.attributes("aria-label")).toBe("已取消");

        // 芯片必须在折叠体之外：不是 run-group-body 的子节点，也不在任何 hidden/关闭 details 里。
        expect(chip.element.closest('[data-testid="run-group-body"]')).toBeNull();
        expect(chip.element.closest("[hidden], details:not([open])")).toBeNull();
        expect(chip.element.closest('[aria-expanded="false"]')).toBeNull();
        expect(
            chip.element.closest(`[data-run-block="${RUN_B}"]`),
            "折叠摘要行属于该 run 的 block",
        ).not.toBeNull();

        // 展开后由消息行尾的芯片接手（MessageItem.spec 覆盖行尾语义），摘要行不再重复渲染。
        await cancelledHeader.get('[data-testid="run-header-toggle"]').trigger("click");
        expect(
            wrapper.find(`[data-run-block="${RUN_B}"] [data-testid="message-terminated"]`).exists(),
        ).toBe(false);
        wrapper.unmount();
    });

    it("does not add the chip for a collapsed failed run or a succeeded one", () => {
        const wrapper = twoRuns("failed", "error");

        expect(
            wrapper.find(`[data-run-block="${RUN_A}"] [data-testid="message-terminated"]`).exists(),
        ).toBe(false);
        expect(
            wrapper.find(`[data-run-block="${RUN_B}"] [data-testid="message-terminated"]`).exists(),
        ).toBe(false);
        expect(wrapper.find('[data-testid="message-terminated"]').exists()).toBe(false);
        wrapper.unmount();
    });
});
