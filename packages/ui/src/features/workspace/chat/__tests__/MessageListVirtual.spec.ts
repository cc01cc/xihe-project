import { describe, expect, it } from "vitest";
import { defineComponent, h, nextTick } from "vue";
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
                loadOlder: "加载更早的消息",
                loadingOlder: "正在加载更早的消息…",
                foldedOlder: "更早的 {count} 条消息已折叠，点击加载",
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

function mountList(messages: Message[], extraProps: Record<string, unknown> = {}) {
    return mount(MessageList, {
        props: { messages, ...extraProps },
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

    it("renders the load-older entry only when the server advertises more (PLAN-0670 M2d.1)", () => {
        const legacy = mountList(Array.from({ length: 5 }, (_, index) => message(index)));
        expect(legacy.find('[data-testid="load-older-messages"]').exists()).toBe(false);

        const paged = mountList(
            Array.from({ length: 5 }, (_, index) => message(index)),
            {
                hasOlder: true,
            },
        );
        expect(paged.find('[data-testid="load-older-messages"]').exists()).toBe(true);
    });

    it("shows the explicit folded banner when the 500-message cap dropped older messages (PLAN-0670 M2d.3)", () => {
        const wrapper = mountList(
            Array.from({ length: 5 }, (_, index) => message(index)),
            {
                hasOlder: false,
                foldedCount: 37,
            },
        );
        const button = wrapper.get('[data-testid="load-older-messages"]');
        expect(button.text()).toContain("37");
        expect(button.text()).toContain("已折叠");
    });

    it("emits loadOlder on click and disables the entry while loading", async () => {
        const wrapper = mountList(
            Array.from({ length: 5 }, (_, index) => message(index)),
            {
                hasOlder: true,
                loadingOlder: true,
            },
        );
        const button = wrapper.get('[data-testid="load-older-messages"]');
        expect(button.attributes("disabled")).toBeDefined();
        await button.trigger("click");
        // disabled 按钮点击不触发（浏览器语义；这里断言事件也未发出）。
        expect(wrapper.emitted("loadOlder")).toBeUndefined();

        const idle = mountList(
            Array.from({ length: 5 }, (_, index) => message(index)),
            {
                hasOlder: true,
            },
        );
        await idle.get('[data-testid="load-older-messages"]').trigger("click");
        expect(idle.emitted("loadOlder")).toHaveLength(1);
    });
});

/**
 * 回归：真实滚动层（不 stub `message-scroller/*`）下的自触发循环。
 *
 * 缺陷现场：真实链路 E2E 的 `expect(pageErrors).toEqual([])` 被 29 条同一 pageError 打红 ——
 * `Maximum recursive updates exceeded in component <MessageScrollerContent>`（开发构建 100 次
 * 迭代后 handleError；生产构建无此护栏，等于每次渲染都自触发、永不收敛）。
 *
 * 因果链：`MessageScrollerContent` 的渲染 effect 负责渲染插槽（`MessageList` 的行都在里面），
 * 行上的行内箭头函数 ref `:ref="(el) => rowElementRef(...)"` 每次渲染都是**新函数身份**，Vue
 * 每次 patch 都会重新 `setRef` → `measureRow` → `useVirtualMessageWindow.measure()`；而
 * `measure()` 在渲染期内**读** `measured.value`（登记成该 effect 的依赖）并**无条件写**
 * `measured.value = new Map(...)`（即使高度没变）→ 触发自己 → 重渲染 → 再 setRef → 再写……
 *
 * 断言口径（两条，互不替代）：
 * 1. 不出现递归更新错误 —— 直接对齐 E2E 的 pageErrors 判据；
 * 2. 渲染次数有界 —— 一次挂载 + 一次流式追加各自的渲染轮数都有上限，即使将来 Vue 挪走
 *    RECURSION_LIMIT 护栏，改动重新引入自触发也会在这里红灯。
 */
describe("MessageList real scroller stack: no self-triggering updates (pageErrors regression)", () => {
    const ROW_HEIGHT = 80;
    const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;

    // jsdom 没有布局：伪造行高，否则 `measure()` 因 height<=0 直接跳过写入，缺陷无法复现。
    function stubRowLayout() {
        Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
            return {
                x: 0,
                y: 0,
                top: 0,
                left: 0,
                right: 100,
                bottom: ROW_HEIGHT,
                width: 100,
                height: ROW_HEIGHT,
                toJSON() {
                    return {};
                },
            } as DOMRect;
        };
    }

    function restoreRowLayout() {
        Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    }

    function mountWithRealScroller(messages: Message[], onRender: () => void) {
        const RowProbe = defineComponent({
            props: { message: { type: Object, required: false } },
            render() {
                onRender();
                return h("div", { "data-testid": "stub-message" }, String(this.message?.id ?? ""));
            },
        });

        return mount(MessageList, {
            props: { messages },
            global: {
                plugins: [i18n, createPinia()],
                stubs: {
                    MessageSearch: true,
                    Marker: { template: "<div><slot /></div>" },
                    RunGroupHeader: true,
                    MessageItem: RowProbe,
                },
            },
        });
    }

    /** 把当前挂起的更新全部冲干净；返回是否冒出递归更新错误。 */
    async function flushUpdates(): Promise<string | undefined> {
        try {
            for (let round = 0; round < 3; round += 1) {
                await nextTick();
            }
            return undefined;
        } catch (error) {
            return String((error as Error)?.message ?? error);
        }
    }

    it("mounting and streaming into the transcript never recurses (bounded render passes)", async () => {
        stubRowLayout();
        const renders = { count: 0 };
        const onRender = () => {
            renders.count += 1;
        };

        try {
            const wrapper = mountWithRealScroller(
                Array.from({ length: 3 }, (_, index) => ({ ...message(index), runId: "run-1" })),
                onRender,
            );
            const mountError = await flushUpdates();
            const mountRenders = renders.count;
            // 3 行 × 每轮 1 次；允许 3 轮（=9），递归时这里是 ~300 并伴随 RECURSION_LIMIT。
            expect(mountError).toBeUndefined();
            expect(mountRenders).toBeLessThanOrEqual(3 * 3);

            // 流式：追加一条（行增删正是 E2E 的触发时机）。
            renders.count = 0;
            await wrapper.setProps({
                messages: [
                    ...Array.from({ length: 3 }, (_, index) => ({
                        ...message(index),
                        runId: "run-1",
                    })),
                    { ...message(3), runId: "run-1", isStreaming: true },
                ],
            });
            const streamError = await flushUpdates();
            const streamRenders = renders.count;
            expect(streamError).toBeUndefined();
            expect(streamRenders).toBeLessThanOrEqual(4 * 3);

            // 真实 DOM 语义不变：所有行仍然渲染出来。
            expect(wrapper.findAll('[data-testid="stub-message"]')).toHaveLength(4);
            wrapper.unmount();
        } finally {
            restoreRowLayout();
        }
    });
});
