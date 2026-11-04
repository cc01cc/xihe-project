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
