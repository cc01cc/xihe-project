import { describe, expect, it } from "vitest";
import { defineComponent, h, nextTick } from "vue";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createPinia, setActivePinia } from "pinia";
import MessageList from "../components/MessageList.vue";
import { DEFAULT_VIRTUAL_OVERSCAN } from "../composables/virtualWindow";
import {
    MessageScroller,
    MessageScrollerContent,
    MessageScrollerItem,
    MessageScrollerProvider,
    MessageScrollerViewport,
} from "@/components/ui/message-scroller";
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

/**
 * BL-316 回归 —— 窗口化渲染**真的生效**（此前在产品里从未生效）。
 *
 * 缺陷链：`MessageList` 用 `inject(MessageScrollerContextKey, null)` 取滚动视口，而提供该 context 的
 * `MessageScrollerProvider` 是它**自己的子节点** ⇒ inject 恒 null ⇒ `attach(null)` ⇒
 * `viewportHeight` 恒 0 ⇒ `active` 恒 false ⇒ 渲染层退回全量。
 *
 * 因此这里的断言全部对准"窗口真的在切"这一事实，而不是"组件能挂载"：
 * 1. 渲染条数与**总条数解耦**（300 条与 1200 条渲染出的行数几乎相同，且都远小于总条数）；
 * 2. 占位 spacer 存在且高度为正（窗口外行用高度撑住 scrollHeight）；
 * 3. 滚动后窗口**平移**（渲染集合换成更靠后的行、顶部占位高度 > 0）。
 * 把窗口切片改回全量（`visibleRows` 直接返回 `rows`）时，1/2/3 会同时红。
 */
describe("MessageList windowed rendering actually engages (BL-316)", () => {
    const ROW_HEIGHT = 80;
    const VIEWPORT_HEIGHT = 640;
    /** 小列表阈值是 150（`DEFAULT_VIRTUAL_MIN_ROWS`），两个样本都要过阈值。 */
    const SMALL_TOTAL = 300;
    const LARGE_TOTAL = 1200;

    const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
    const originalScrollTo = (Element.prototype as unknown as { scrollTo?: Element["scrollTo"] })
        .scrollTo;
    let hadOwnClientHeight = true;

    /** jsdom 没有布局：伪造行高 + 视口高度（`clientHeight` 恒 0 会让窗口化永远无法启用）。 */
    function stubLayout() {
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
        hadOwnClientHeight = Object.prototype.hasOwnProperty.call(
            HTMLElement.prototype,
            "clientHeight",
        );
        Object.defineProperty(HTMLElement.prototype, "clientHeight", {
            configurable: true,
            get: () => VIEWPORT_HEIGHT,
        });
        // jsdom 未实现 `Element.scrollTo`，而 provider 的 auto-scroll 会调它（MutationObserver →
        // `reconcileScrollPosition`）。这里给 no-op：**有意**不写 scrollTop —— 让它真滚会与本用例
        // 显式设置的滚动位置互相覆盖，反而测不出"窗口随 scrollTop 平移"。
        Element.prototype.scrollTo = (() => undefined) as Element["scrollTo"];
    }

    function restoreLayout() {
        Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
        if (originalScrollTo) Element.prototype.scrollTo = originalScrollTo;
        else delete (Element.prototype as { scrollTo?: Element["scrollTo"] }).scrollTo;
        if (!hadOwnClientHeight) {
            delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
        }
    }

    /** jsdom 的 `scrollTop` setter 是 no-op（无布局），这里给它一个真实可读写的后备值。 */
    function makeScrollable(element: HTMLElement) {
        let top = 0;
        Object.defineProperty(element, "scrollTop", {
            configurable: true,
            get: () => top,
            set: (value: number) => {
                top = value;
            },
        });
        return {
            scrollTo(next: number) {
                element.scrollTop = next;
                element.dispatchEvent(new Event("scroll"));
            },
            get top() {
                return top;
            },
        };
    }

    function mountLongSession(total: number) {
        return mount(MessageList, {
            props: {
                // 同一个 runId ⇒ 不分组（rows ≈ 消息数 + 1 个日期分隔），行与消息一一对应。
                messages: Array.from({ length: total }, (_, index) => ({
                    ...message(index),
                    runId: "run-1",
                })),
            },
            global: {
                plugins: [i18n, createPinia()],
                stubs: {
                    MessageSearch: true,
                    Marker: { template: "<div><slot /></div>" },
                    RunGroupHeader: true,
                    MessageItem: {
                        props: ["message"],
                        template: `<div data-testid="stub-message">{{ message.id }}</div>`,
                    },
                },
            },
        });
    }

    /** 已渲染消息的下标（`stub-message` 的文本是 `msg-<i>`）。 */
    function renderedIndexes(rendered: readonly { text(): string }[]): number[] {
        return rendered
            .map((node) => Number(/msg-(\d+)/.exec(node.text())?.[1] ?? Number.NaN))
            .filter((index) => Number.isFinite(index));
    }

    function spacerHeight(wrapper: ReturnType<typeof mountLongSession>, testId: string): number {
        const spacer = wrapper.find(`[data-testid="${testId}"]`);
        if (!spacer.exists()) return 0;
        return Number.parseFloat(spacer.attributes("style")?.replace(/[^\d.]/g, "") ?? "0");
    }

    // ⚠️ 固定 4 轮是**经验值**（非推导）：改渲染链路时先确认仍够用，否则会间歇性假红（同类：BL-340 六帧盲补）。
    async function settle() {
        for (let round = 0; round < 4; round += 1) await nextTick();
    }

    it("renders a window instead of the whole transcript, decoupled from total size", async () => {
        stubLayout();
        try {
            const small = mountLongSession(SMALL_TOTAL);
            await settle();
            const smallRendered = small.findAll('[data-testid="stub-message"]');
            expect(smallRendered.length, "300 条必须被窗口截断，而不是全量渲染").toBeLessThan(
                SMALL_TOTAL / 4,
            );

            const large = mountLongSession(LARGE_TOTAL);
            await settle();
            const largeRendered = large.findAll('[data-testid="stub-message"]');
            // 总条数 ×4，渲染条数几乎不变 —— 这就是"窗口化真的在切"的判据。
            expect(largeRendered.length).toBeLessThan(LARGE_TOTAL / 4);
            expect(
                largeRendered.length,
                `300 条渲染 ${smallRendered.length} 行、1200 条渲染 ${largeRendered.length} 行，应基本相等`,
            ).toBeLessThanOrEqual(smallRendered.length + 4);

            // 窗口外行靠占位高度撑住 scrollHeight：贴底状态下底部占位必须为正。
            expect(spacerHeight(large, "virtual-bottom-spacer")).toBeGreaterThan(0);
            // 首屏（scrollTop=0）顶部占位为 0。
            expect(spacerHeight(large, "virtual-top-spacer")).toBe(0);

            small.unmount();
            large.unmount();
        } finally {
            restoreLayout();
        }
    });

    it("shifts the rendered window when the viewport scrolls", async () => {
        stubLayout();
        try {
            const wrapper = mountLongSession(LARGE_TOTAL);
            await settle();

            const viewport = wrapper.get('[data-testid="message-scroller-viewport"]')
                .element as HTMLElement;
            const scroller = makeScrollable(viewport);

            const before = renderedIndexes(wrapper.findAll('[data-testid="stub-message"]'));
            expect(before.length).toBeGreaterThan(0);
            expect(Math.min(...before)).toBe(0);

            // 滚到第 100 行附近：窗口必须换成靠后的行，而不是"全量都渲染所以不动"。
            scroller.scrollTo(ROW_HEIGHT * 100);
            await settle();

            const after = renderedIndexes(wrapper.findAll('[data-testid="stub-message"]'));
            expect(after.length, "滚动后仍只渲染窗口内的行").toBeLessThan(LARGE_TOTAL / 4);
            expect(Math.min(...after), "窗口起点必须随 scrollTop 平移").toBeGreaterThan(50);
            expect(
                spacerHeight(wrapper, "virtual-top-spacer"),
                "顶部占位撑住已滚过的行",
            ).toBeGreaterThan(0);

            wrapper.unmount();
        } finally {
            restoreLayout();
        }
    });
});

/**
 * BL-316 第二步 —— **窗口换页** 与 **新消息到达** 必须被区分开。
 *
 * 缺陷（启用窗口化后立刻暴露）：窗口换页会同时移除尾部行、新增头部行，`MessageScrollerProvider`
 * 的 `handleContentChange()` 只看 DOM 子节点集合 ⇒ 把换页当成"新消息到达"⇒
 * `getNewScrollAnchor` → `scrollToElement(align:"start")` ⇒ 用户上滚被一次一次拽回底部
 * （真实浏览器实测 scrollTop 25 → 5219 → … → 71967，40×2000px 上滚只到 ~35.6k / 总高 ~72k）。
 *
 * 修复：`MessageList` 用 `source-item-count` 把"数据层行数"显式告诉 scroller；行数没变而 DOM 变了
 * ⇒ 纯投影换页 ⇒ 不做任何"新消息"锚定（贴底跟随时仍贴底）。
 *
 * 本 describe 的两条判据互不替代：
 * 1. 换页**不得**改滚动意图（scrollTo 不被调用、scrollTop 不被改写）；
 * 2. 贴底跟随时**新消息到达仍要跟随**（换页分支不得把数据变化一起吞掉）。
 */
describe("MessageList window swap vs new message (BL-316 step 2)", () => {
    const ROW_HEIGHT = 80;
    const VIEWPORT_HEIGHT = 640;
    const STUB_SCROLL_HEIGHT = 12_000;

    const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
    const originalScrollTo = (Element.prototype as unknown as { scrollTo?: Element["scrollTo"] })
        .scrollTo;
    const hadOwnClientHeight = Object.prototype.hasOwnProperty.call(
        HTMLElement.prototype,
        "clientHeight",
    );
    const hadOwnScrollHeight = Object.prototype.hasOwnProperty.call(
        HTMLElement.prototype,
        "scrollHeight",
    );

    /** `scrollTo` 的调用记录（只关心 top）。 */
    let scrollToCalls: number[] = [];

    function stubLayout() {
        scrollToCalls = [];
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
        Object.defineProperty(HTMLElement.prototype, "clientHeight", {
            configurable: true,
            get: () => VIEWPORT_HEIGHT,
        });
        Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
            configurable: true,
            get: () => STUB_SCROLL_HEIGHT,
        });
        Element.prototype.scrollTo = function scrollTo(
            this: Element,
            options?: ScrollToOptions | number,
            y?: number,
        ) {
            const top = typeof options === "number" ? (y ?? 0) : (options?.top ?? 0);
            scrollToCalls.push(top);
            (this as HTMLElement).scrollTop = top;
        } as Element["scrollTo"];
    }

    function restoreLayout() {
        Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
        if (originalScrollTo) Element.prototype.scrollTo = originalScrollTo;
        else delete (Element.prototype as { scrollTo?: Element["scrollTo"] }).scrollTo;
        if (!hadOwnClientHeight) {
            delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
        }
        if (!hadOwnScrollHeight) {
            delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
        }
    }

    /** jsdom 的 `scrollTop` setter 是 no-op；给这个元素一个可读写的后备值。 */
    function makeScrollTopWritable(element: HTMLElement, initial = 0) {
        let top = initial;
        Object.defineProperty(element, "scrollTop", {
            configurable: true,
            get: () => top,
            set: (value: number) => {
                top = value;
            },
        });
        return {
            get value() {
                return top;
            },
            /**
             * 用户上滚：**先派发 wheel**（scroller 据此把模式切成 `free-scrolling`），再改位置 ——
             * 这是真实滚轮/触控板的顺序；只改 `scrollTop` 不派 wheel 等于"程序化滚动"，
             * 模式仍是 `following-bottom`，贴底跟随本来就应该生效。
             */
            scrollUpTo(next: number) {
                element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
                element.scrollTop = next;
                element.dispatchEvent(new Event("scroll"));
            },
            set(next: number) {
                element.scrollTop = next;
                element.dispatchEvent(new Event("scroll"));
            },
        };
    }

    /**
     * 被测对象是**滚动层自己的契约**，所以这里直接挂 `MessageScrollerProvider` + 视口 + 内容，
     * 而不是 `MessageList`（后者写死 `auto-scroll`，没法构造"用户已离开底部"的自由滚动模式）。
     * `sourceItemCount` 模拟 `MessageList` 的声明；`startIndex` 变化 = 窗口换页（首行末行都变）。
     */
    const ScrollerHarness = defineComponent({
        props: {
            startIndex: { type: Number, required: true },
            windowSize: { type: Number, required: true },
            sourceItemCount: { type: Number, default: undefined },
        },
        components: {
            MessageScrollerProvider,
            MessageScroller,
            MessageScrollerViewport,
            MessageScrollerContent,
            MessageScrollerItem,
        },
        template: `
            <MessageScrollerProvider
                :source-item-count="sourceItemCount"
                default-scroll-position="last-anchor"
            >
                <MessageScroller>
                    <MessageScrollerViewport>
                        <MessageScrollerContent>
                            <MessageScrollerItem
                                v-for="offset in windowSize"
                                :key="startIndex + offset"
                                :message-id="'m' + (startIndex + offset - 1)"
                                :scroll-anchor="true"
                            >
                                <div class="row">row</div>
                            </MessageScrollerItem>
                        </MessageScrollerContent>
                    </MessageScrollerViewport>
                </MessageScroller>
            </MessageScrollerProvider>
        `,
    });

    function mountHarness(props: {
        startIndex: number;
        windowSize: number;
        sourceItemCount?: number;
    }) {
        return mount(ScrollerHarness, { props, global: { plugins: [i18n] } });
    }

    // ⚠️ 固定 4 轮是**经验值**（非推导）：改渲染链路时先确认仍够用，否则会间歇性假红（同类：BL-340 六帧盲补）。
    async function settle() {
        for (let round = 0; round < 4; round += 1) await nextTick();
    }

    it("a window swap must not move the scroll position (no 'new message' anchoring)", async () => {
        stubLayout();
        try {
            const wrapper = mountHarness({ startIndex: 0, windowSize: 8, sourceItemCount: 300 });
            await settle();
            const viewport = wrapper.get('[data-testid="message-scroller-viewport"]')
                .element as HTMLElement;
            const scroll = makeScrollTopWritable(viewport, ROW_HEIGHT * 100);
            await settle();

            // 窗口换页：首行从 m0 变 m50、末行从 m7 变 m57，**数据层行数不变**。
            scrollToCalls = [];
            await wrapper.setProps({ startIndex: 50 });
            await settle();

            expect(
                scrollToCalls,
                "窗口换页不得走'新消息'锚定路径（scrollTo 一次都不该被调）",
            ).toHaveLength(0);
            expect(scroll.value, "窗口换页不得改写 scrollTop").toBe(ROW_HEIGHT * 100);

            wrapper.unmount();
        } finally {
            restoreLayout();
        }
    });

    it("a real new message still runs the anchoring path (data change is not swallowed)", async () => {
        stubLayout();
        try {
            const wrapper = mountHarness({ startIndex: 0, windowSize: 8, sourceItemCount: 300 });
            await settle();
            const viewport = wrapper.get('[data-testid="message-scroller-viewport"]')
                .element as HTMLElement;
            const scroll = makeScrollTopWritable(viewport, ROW_HEIGHT * 100);
            await settle();

            // 同样的 DOM 变化形状（末行变），但**数据层行数 +1** ⇒ 这是"新消息到达"，必须仍走锚定。
            scrollToCalls = [];
            const before = scroll.value;
            await wrapper.setProps({ startIndex: 0, windowSize: 9, sourceItemCount: 301 });
            await settle();

            const moved = scrollToCalls.length > 0 || scroll.value !== before;
            expect(moved, "数据变化必须仍然进入跟随/锚定路径（不得被'投影换页'分支一起吞掉）").toBe(
                true,
            );

            wrapper.unmount();
        } finally {
            restoreLayout();
        }
    });
});

/**
 * BL-382 A/B 回归 —— prepend 的锚定代价必须与**表长无关**。
 *
 * 缺陷（`docs/evidence/bl382-attribution/proof.md` §3.1）：每补一页历史都会把 `historyMutationPause`
 * 置真 ⇒ 窗口化关闭 ⇒ **整表挂载一次**、等一帧再拆回窗口。99 轮 = 99 次全表挂载/卸载，实测 192 个长任务
 * （1.94/轮）、第 99 轮 5698ms，代价随「表长 × 轮次」增长。
 *
 * 修复分两半，各自有独立判据：
 * - **B**（上界）：只有 `rows.length ≤ HISTORY_PAUSE_MAX_ROWS(200)` 才允许走全表渲染；超过就保持窗口化。
 * - **A**（补偿）：大表 prepend 时在 prepend 前记录视口几何、DOM 更新后**同一帧**把 `scrollTop` 加上
 *   `scrollHeight` 增量 ⇒ 视口里那几行视觉位置不变（渲染集合不变、只是顶部占位长高）。
 *
 * 判据对应 proof §8.1：AC-1（窗口在且不等于全量）、AC-2（单次 prepend 渲染行数峰值 ≤ 窗口 + 2×overscan）、
 * AC-3（大表 `virtualEnabled` 与 `historyMutationPause` 无关）。
 */
describe("MessageList prepend anchoring is bounded by table length (BL-382 A/B)", () => {
    const ROW_HEIGHT = 80;
    const VIEWPORT_HEIGHT = 640;
    /** 窗口 + 2×overscan（overscan=6）+ 取整余量：超过它就意味着"又整表渲染了"。 */
    const OVERSHOOT_GUARD = 2 * DEFAULT_VIRTUAL_OVERSCAN + 2;
    /** 让 6 帧校正循环（jsdom 的 rAF ≈ 16ms/帧）跑完，避免测试结束仍在写 scrollTop。 */
    const RAF_DRAIN_MS = 160;

    const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
    const originalScrollTo = (Element.prototype as unknown as { scrollTo?: Element["scrollTo"] })
        .scrollTo;
    const hadOwnClientHeight = Object.prototype.hasOwnProperty.call(
        HTMLElement.prototype,
        "clientHeight",
    );

    function stubLayout() {
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
        Object.defineProperty(HTMLElement.prototype, "clientHeight", {
            configurable: true,
            get: () => VIEWPORT_HEIGHT,
        });
        // provider 的 auto-scroll 会调 `scrollTo`；jsdom 未实现，且真滚会覆盖本用例显式设的位置。
        Element.prototype.scrollTo = (() => undefined) as Element["scrollTo"];
    }

    function restoreLayout() {
        Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
        if (originalScrollTo) Element.prototype.scrollTo = originalScrollTo;
        else delete (Element.prototype as { scrollTo?: Element["scrollTo"] }).scrollTo;
        if (!hadOwnClientHeight) {
            delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
        }
    }

    /** jsdom 的 `scrollTop` setter 是 no-op；给这个元素一个可读写的后备值。 */
    function makeScrollable(element: HTMLElement) {
        let top = 0;
        Object.defineProperty(element, "scrollTop", {
            configurable: true,
            get: () => top,
            set: (value: number) => {
                top = value;
            },
        });
        return {
            set(next: number) {
                element.scrollTop = next;
                element.dispatchEvent(new Event("scroll"));
            },
            get top() {
                return top;
            },
        };
    }

    /**
     * jsdom 没有布局（`scrollHeight` 恒 0）⇒ 按**真实 DOM 同构**还原：
     * `顶部占位 + 已渲染行 × 行高 + 底部占位`。这样「prepend 后顶部占位长高」才会真的体现在 scrollHeight 上，
     * 同帧补偿（A）才有可验证的输入 —— 用固定假值会让补偿恒为 0，等于测不到。
     */
    function attachFaithfulScrollHeight(element: HTMLElement) {
        Object.defineProperty(element, "scrollHeight", {
            configurable: true,
            get(this: HTMLElement) {
                const spacer = (testId: string): number => {
                    const node = this.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
                    return node ? Number.parseFloat(node.style.height || "0") || 0 : 0;
                };
                const rendered = this.querySelectorAll('[data-testid="stub-message"]').length;
                return (
                    spacer("virtual-top-spacer") +
                    rendered * ROW_HEIGHT +
                    spacer("virtual-bottom-spacer")
                );
            },
        });
    }

    /** 同一 runId ⇒ 不分组：rows ≈ 消息数 + 1 个日期分隔。 */
    function buildMessages(from: number, count: number): Message[] {
        return Array.from({ length: count }, (_, offset) => ({
            ...message(from + offset),
            runId: "run-1",
        }));
    }

    function mountLongSession(messages: Message[]) {
        return mount(MessageList, {
            props: { messages },
            global: {
                plugins: [i18n, createPinia()],
                stubs: {
                    MessageSearch: true,
                    Marker: { template: "<div><slot /></div>" },
                    RunGroupHeader: true,
                    MessageItem: {
                        props: ["message"],
                        template: `<div data-testid="stub-message">{{ message.id }}</div>`,
                    },
                },
            },
        });
    }

    function renderedIndexes(rendered: readonly { text(): string }[]): number[] {
        return rendered
            .map((node) => Number(/msg-(\d+)/.exec(node.text())?.[1] ?? Number.NaN))
            .filter((index) => Number.isFinite(index));
    }

    // ⚠️ 固定 4 轮是**经验值**（非推导，与上文 BL-316 用例同源）：改渲染链路时先确认仍够用。
    async function settle() {
        for (let round = 0; round < 4; round += 1) await nextTick();
    }

    it("large table: prepend keeps the window (AC-1/2/3) and compensates scrollTop in the same frame (A)", async () => {
        stubLayout();
        try {
            const wrapper = mountLongSession(buildMessages(30, 500));
            await settle();
            const viewport = wrapper.get('[data-testid="message-scroller-viewport"]')
                .element as HTMLElement;
            const scroller = makeScrollable(viewport);
            attachFaithfulScrollHeight(viewport);
            scroller.set(ROW_HEIGHT * 120);
            await settle();

            const rendered = () => wrapper.findAll('[data-testid="stub-message"]');
            const before = renderedIndexes(rendered());
            expect(before.length, "前置：窗口化必须在切").toBeGreaterThan(0);
            expect(before.length).toBeLessThan(60);
            expect(Math.min(...before), "前置：视口在中部而不是贴顶").toBeGreaterThan(50);

            const scrollTopBefore = scroller.top;
            const scrollHeightBefore = viewport.scrollHeight;

            // 30 条更旧消息 prepend：rows 531 → 561，超过 HISTORY_PAUSE_MAX_ROWS=200。
            const pending = wrapper.setProps({
                messages: [...buildMessages(0, 30), ...buildMessages(30, 500)],
            });
            let peak = 0;
            for (let round = 0; round < 10; round += 1) {
                await nextTick();
                peak = Math.max(peak, rendered().length);
            }
            await pending;
            for (let round = 0; round < 6; round += 1) {
                await nextTick();
                peak = Math.max(peak, rendered().length);
            }
            await new Promise((resolve) => setTimeout(resolve, RAF_DRAIN_MS));

            const after = renderedIndexes(rendered());
            // AC-2：单次 prepend 期间渲染行数峰值不得越过「窗口 + 2×overscan」。
            expect(
                peak,
                `AC-2：回填期间渲染行数峰值 ${peak} 越过「窗口+2×overscan」=${before.length + OVERSHOOT_GUARD}`,
            ).toBeLessThanOrEqual(before.length + OVERSHOOT_GUARD);
            // AC-1 / AC-3：大表任何时刻都不得出现整表渲染（与 historyMutationPause 无关）。
            expect(peak, "AC-1/AC-3：大表不得整表渲染").toBeLessThan(500 / 2);
            expect(after.length, "回填后仍只渲染窗口").toBeLessThan(
                before.length + OVERSHOOT_GUARD,
            );

            // A：同帧补偿 —— scrollTop 恰好加上 scrollHeight 增量，因此渲染集合**不变**。
            const grown = viewport.scrollHeight - scrollHeightBefore;
            expect(grown, "顶部占位必须随 prepend 长高，否则补偿无从谈起").toBeGreaterThan(0);
            expect(
                scroller.top,
                `scrollTop 必须按 scrollHeight 增量补偿（前 ${scrollTopBefore}，增量 ${grown}）`,
            ).toBeCloseTo(scrollTopBefore + grown, 0);
            expect(after, "补偿成立 ⇒ 渲染集合不变（用户正在读的还是那几条）").toEqual(before);

            wrapper.unmount();
        } finally {
            restoreLayout();
        }
    });

    it("small table (≤200 rows) keeps the legacy full-render pause (B: 小表行为不变)", async () => {
        stubLayout();
        try {
            // rows ≈ 181：过窗口化阈值（150）但没到上界（200）⇒ 仍走旧的「关窗口化」路径。
            const wrapper = mountLongSession(buildMessages(200, 180));
            await settle();
            const viewport = wrapper.get('[data-testid="message-scroller-viewport"]')
                .element as HTMLElement;
            const scroller = makeScrollable(viewport);
            attachFaithfulScrollHeight(viewport);
            scroller.set(ROW_HEIGHT * 100);
            await settle();

            const rendered = () => wrapper.findAll('[data-testid="stub-message"]');
            const before = renderedIndexes(rendered());
            expect(before.length, "前置：窗口化必须在切").toBeLessThan(60);

            const scrollTopBefore = scroller.top;
            const pending = wrapper.setProps({
                messages: [...buildMessages(190, 10), ...buildMessages(200, 180)],
            });
            let peak = 0;
            for (let round = 0; round < 10; round += 1) {
                await nextTick();
                peak = Math.max(peak, rendered().length);
            }
            await pending;
            for (let round = 0; round < 6; round += 1) {
                await nextTick();
                peak = Math.max(peak, rendered().length);
            }
            await new Promise((resolve) => setTimeout(resolve, RAF_DRAIN_MS));

            // 小表仍必须出现「整表渲染一帧」（这正是大表被 B 禁止、小表被保留的那条路径）。
            expect(peak, "小表必须仍走「关窗口化 → 全量渲染一帧」").toBeGreaterThanOrEqual(180);
            // 小表不参与 A 的补偿（A 只在大表生效），位置交给 provider + restoreAnchor。
            expect(scroller.top, "小表路径不得被 A 改动").toBe(scrollTopBefore);
            // 恢复窗口化后仍只渲染窗口。
            expect(rendered().length).toBeLessThan(before.length + OVERSHOOT_GUARD);

            wrapper.unmount();
        } finally {
            restoreLayout();
        }
    });
});
