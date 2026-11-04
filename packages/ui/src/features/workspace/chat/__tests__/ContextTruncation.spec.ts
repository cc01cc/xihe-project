import { describe, expect, it, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createPinia, setActivePinia } from "pinia";
import MessageList from "../components/MessageList.vue";
import { useChatStore } from "../stores/chat.ts";
import { parseAgentContextTruncation } from "../composables/useSSE";
import type { Message } from "../../../../types";

/**
 * PLAN-0670 M2c / BL-292：入站上下文截断对用户可见。
 * - 解析：`done.agentContextTruncation` 真实 wire 形状（Agent `Truncation.to_wire()`）；
 * - store：按 `sessionId:runId` 存取/关闭，多 run 同屏不串；
 * - 组件：有截断 ⇒ 轻提示（数字正确、可关闭）；无截断 ⇒ 不渲染。
 */
const SESSION_ID = "s-292";
const RUN_A = "aaaaaaaa-1111-2222-3333-444444444444";
const RUN_B = "bbbbbbbb-1111-2222-3333-444444444444";

const marker = {
    droppedMessages: 500,
    droppedBytes: 123456,
    keptMessages: 2000,
    keptBytes: 987654,
    limitMessages: 2000,
    limitBytes: 8 * 1024 * 1024,
    strategy: "newestKeep",
};

const i18n = createI18n({
    legacy: false,
    locale: "zh",
    messages: {
        zh: {
            workspace: { participantUnknownName: "未知用户" },
            chat: {
                contextTruncationNotice:
                    "本次回答基于被截断的历史（丢弃 {dropped} 条 / 保留 {kept} 条）",
                contextTruncationDismiss: "关闭截断提示",
                runHeader: { toggle: "展开或折叠 run {run}" },
                followUpStatusCompleted: "已完成",
                followUpStatusFailed: "失败",
                loadOlder: "加载更早的消息",
                loadingOlder: "正在加载更早的消息…",
                foldedOlder: "更早的 {count} 条消息已折叠，点击加载",
            },
        },
    },
});

function message(id: string, runId: string, role: "user" | "assistant"): Message {
    return {
        id,
        sessionId: SESSION_ID,
        role,
        content: `content-${id}`,
        timestamp: "2026-11-05T00:00:00.000Z",
        runId,
    } as unknown as Message;
}

let pinia: ReturnType<typeof createPinia>;

function mountList(messages: Message[]) {
    return mount(MessageList, {
        props: { messages },
        global: {
            plugins: [i18n, pinia],
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

describe("parseAgentContextTruncation (BL-292)", () => {
    it("parses the real wire shape from the Agent done payload", () => {
        expect(parseAgentContextTruncation(marker)).toEqual(marker);
    });

    it("treats an absent key as no truncation (not an all-zero marker)", () => {
        expect(parseAgentContextTruncation(undefined)).toBeUndefined();
        expect(parseAgentContextTruncation(null)).toBeUndefined();
    });

    it("ignores malformed or all-zero markers", () => {
        expect(
            parseAgentContextTruncation({ droppedMessages: 0, keptMessages: 2000 }),
        ).toBeUndefined();
        expect(parseAgentContextTruncation({ droppedMessages: 5 })).toBeUndefined();
        expect(
            parseAgentContextTruncation({ droppedMessages: "5", keptMessages: 1 }),
        ).toBeUndefined();
    });

    it("keeps optional byte fields when present and drops non-numeric ones", () => {
        const parsed = parseAgentContextTruncation({
            droppedMessages: 3,
            keptMessages: 10,
            droppedBytes: "oops",
            strategy: "newestKeep",
        });
        expect(parsed).toEqual({
            droppedMessages: 3,
            droppedBytes: undefined,
            keptMessages: 10,
            keptBytes: undefined,
            limitMessages: undefined,
            limitBytes: undefined,
            strategy: "newestKeep",
        });
    });
});

describe("chat store run-level truncation (BL-292)", () => {
    beforeEach(() => {
        pinia = createPinia();
        setActivePinia(pinia);
    });

    it("stores markers per runId instead of one global value", () => {
        const store = useChatStore();
        const other = { droppedMessages: 7, keptMessages: 20 };
        store.setRunContextTruncation(SESSION_ID, RUN_A, marker);
        store.setRunContextTruncation(SESSION_ID, RUN_B, other);

        expect(store.getRunContextTruncation(SESSION_ID, RUN_A)).toEqual(marker);
        expect(store.getRunContextTruncation(SESSION_ID, RUN_B)).toEqual(other);
        expect(store.getRunContextTruncation(SESSION_ID, "unknown-run")).toBeUndefined();
        expect(store.getRunContextTruncation("other-session", RUN_A)).toBeUndefined();
    });

    it("dismisses one run without hiding another", () => {
        const store = useChatStore();
        store.setRunContextTruncation(SESSION_ID, RUN_A, marker);
        store.setRunContextTruncation(SESSION_ID, RUN_B, marker);
        store.dismissRunContextTruncation(SESSION_ID, RUN_A);

        expect(store.isRunContextTruncationDismissed(SESSION_ID, RUN_A)).toBe(true);
        expect(store.isRunContextTruncationDismissed(SESSION_ID, RUN_B)).toBe(false);
    });
});

describe("MessageList truncation notice (BL-292)", () => {
    beforeEach(() => {
        pinia = createPinia();
        setActivePinia(pinia);
    });

    it("renders the light notice on the matching run only (multi-run same screen)", () => {
        const store = useChatStore();
        store.setRunContextTruncation(SESSION_ID, RUN_A, marker);
        const wrapper = mountList([
            message("a-user", RUN_A, "user"),
            message("a-assistant", RUN_A, "assistant"),
            message("b-user", RUN_B, "user"),
            message("b-assistant", RUN_B, "assistant"),
        ]);

        const notices = wrapper.findAll('[data-testid="context-truncation-notice"]');
        expect(notices).toHaveLength(1);
        expect(notices[0]!.text()).toContain("500");
        expect(notices[0]!.text()).toContain("2000");
        const block = notices[0]!.element.closest("[data-run-block]");
        expect(block?.getAttribute("data-run-block")).toBe(RUN_A);
    });

    it("renders no notice when the done payload had no truncation", () => {
        const wrapper = mountList([
            message("a-user", RUN_A, "user"),
            message("a-assistant", RUN_A, "assistant"),
        ]);
        expect(wrapper.find('[data-testid="context-truncation-notice"]').exists()).toBe(false);
    });

    it("keeps the notice visible for a single ungrouped run", () => {
        const store = useChatStore();
        store.setRunContextTruncation(SESSION_ID, RUN_A, marker);
        const wrapper = mountList([
            message("a-user", RUN_A, "user"),
            message("a-assistant", RUN_A, "assistant"),
        ]);
        expect(wrapper.find('[data-testid="context-truncation-notice"]').text()).toContain("500");
    });

    it("dismisses the notice and does not show it again for that run", async () => {
        const store = useChatStore();
        store.setRunContextTruncation(SESSION_ID, RUN_A, marker);
        const wrapper = mountList([
            message("a-user", RUN_A, "user"),
            message("a-assistant", RUN_A, "assistant"),
        ]);
        await wrapper.get('[data-testid="context-truncation-dismiss"]').trigger("click");
        expect(wrapper.find('[data-testid="context-truncation-notice"]').exists()).toBe(false);
        expect(store.isRunContextTruncationDismissed(SESSION_ID, RUN_A)).toBe(true);
    });
});
