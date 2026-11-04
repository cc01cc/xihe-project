import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createPinia, setActivePinia } from "pinia";
import MessageList from "../components/MessageList.vue";
import type { Message } from "../../../../types";

/**
 * PLAN-0670 M2d.2 —— 窗口化渲染的**组件层兜底语义**：
 * 虚拟化只在「行数过阈值 + viewport 已挂载」时启用；测试/无 scroller 场景必须退回全量渲染，
 * 保证既有 154 例（RunGrouping / ChatPanel / MessageItem）行为不变。
 *
 * 真正的窗口计算与滚动锚定在 `virtualWindow.spec.ts`（纯函数 + DOM 适配层）覆盖。
 */
const i18n = createI18n({
    legacy: false,
    locale: "zh",
    messages: {
        zh: {
            workspace: { participantUnknownName: "未知用户" },
            chat: {
                runHeader: { toggle: "展开或折叠 run {run}" },
                followUpStatusCompleted: "已完成",
                followUpStatusFailed: "失败",
            },
        },
    },
});

function message(index: number): Message {
    return {
        id: `msg-${index}`,
        sessionId: "s-1",
        role: index % 2 === 0 ? "user" : "assistant",
        content: `content-${index}`,
        timestamp: "2026-11-04T10:00:00.000Z",
        runId: `run-${Math.floor(index / 2)}`,
    } as unknown as Message;
}

function mountList(messages: Message[]) {
    return mount(MessageList, {
        props: { messages },
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

describe("MessageList virtual window fallback (PLAN-0670 M2d.2)", () => {
    it("renders the full list when no scroller viewport is mounted (tests / SSR-safe fallback)", () => {
        const wrapper = mountList(Array.from({ length: 300 }, (_, index) => message(index)));
        expect(wrapper.findAll('[data-testid="stub-message"]')).toHaveLength(300);
        // 未启用虚拟化时不得出现占位 spacer（DOM 与改造前一致）。
        expect(wrapper.find('[data-testid="virtual-top-spacer"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="virtual-bottom-spacer"]').exists()).toBe(false);
    });

    it("keeps small lists unchanged (below the virtualization threshold)", () => {
        const wrapper = mountList(Array.from({ length: 20 }, (_, index) => message(index)));
        expect(wrapper.findAll('[data-testid="stub-message"]')).toHaveLength(20);
        expect(wrapper.find('[data-testid="virtual-top-spacer"]').exists()).toBe(false);
    });
});
