import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { computed, defineComponent, h, nextTick, ref } from "vue";
import type { useVirtualizer } from "@tanstack/vue-virtual";
import { useVirtualMessageWindow } from "../composables/useVirtualMessageWindow";

/**
 * task-255 / D-1635 —— 不变量守卫：交给库的 initialOffset 必须读当前 DOM 偏移，不是 0。
 *
 * 为什么需要这条守卫（机制读数见
 * internal/A03-xihe/evidence/2026-11-15-task255-initial-anchor-fix/README.md §1/§5）：
 * @tanstack/virtual-core 在首次 attach 时执行 _scrollToOffset(getScrollOffset())
 * （dist/esm/index.js:582），而 getScrollOffset() 在 observer 尚未回调时取 initialOffset
 * （默认 0，:326 / :688）⇒ 它把 scrollTop 写成 0，覆盖产品刚刚完成的贴底
 * （实测：产品 scrollTo({top:44743.69}) 后 ~30ms 被写回 {top:0}）。
 *
 * 判别力由变异提供，不是 red-first：去掉 initialOffset 那一行 ⇒ 本文件红；恢复 ⇒ 绿。
 * 注意「落底」这个端到端判据不能用来判这一行的必要性 —— 布局定型后产品自己的
 * ResizeObserver.handleResize → scrollToEnd 会救场（干净腿实测 8/8 仍落底），
 * 所以本守卫钉的是契约本身（写回偏移 = 当前偏移），而不是那个会被救场掩盖的结果。
 *
 * 这里只包一层 useVirtualizer 捕获 options，库本体仍是真实实现（不替身库行为）；
 * 断言的对象是「我们交给库的选项」，即 A 这一行建立的契约。
 */
const captured = vi.hoisted(() => ({
    options: null as { value: Record<string, unknown> } | null,
}));

vi.mock("@tanstack/vue-virtual", async (importOriginal) => {
    const actual = await importOriginal<{ useVirtualizer: typeof useVirtualizer }>();
    return {
        ...actual,
        useVirtualizer: ((options: unknown) => {
            captured.options = options as { value: Record<string, unknown> };
            return actual.useVirtualizer(options as Parameters<typeof actual.useVirtualizer>[0]);
        }) as typeof actual.useVirtualizer,
    };
});

const OFFSET = 44_744;

describe("useVirtualMessageWindow · initialOffset 契约（task-255）", () => {
    const mounted: Array<ReturnType<typeof mount>> = [];

    afterEach(() => {
        for (const wrapper of mounted.splice(0)) wrapper.unmount();
        document.body.innerHTML = "";
        captured.options = null;
    });

    function setup() {
        let api: ReturnType<typeof useVirtualMessageWindow> | undefined;
        const keys = ref(Array.from({ length: 240 }, (_, index) => "k" + index));
        const Harness = defineComponent({
            setup() {
                api = useVirtualMessageWindow({
                    rowKeys: computed(() => keys.value),
                    enabled: computed(() => true),
                    fallbackHeight: 100,
                    overscan: 2,
                });
                return () => h("div");
            },
        });
        const wrapper = mount(Harness);
        mounted.push(wrapper);
        expect(api).toBeTruthy();
        return api!;
    }

    /** 视口：clientHeight 固定、scrollTop 可写，scrollTo 记录库的每一次写入。 */
    function fakeViewport(scrollTop: number) {
        const element = document.createElement("div");
        const writes: number[] = [];
        let current = scrollTop;
        Object.defineProperty(element, "clientHeight", { value: 766, configurable: true });
        Object.defineProperty(element, "scrollTop", {
            configurable: true,
            get: () => current,
            set: (value: number) => {
                current = value;
                writes.push(value);
            },
        });
        element.scrollTo = ((arg: ScrollToOptions | number) => {
            const top = typeof arg === "number" ? arg : arg.top;
            if (typeof top === "number") {
                current = top;
                writes.push(top);
            }
        }) as typeof element.scrollTo;
        document.body.appendChild(element);
        return { element, writes };
    }

    function initialOffsetOf(): (() => number) | undefined {
        return captured.options?.value.initialOffset as (() => number) | undefined;
    }

    it("attach 到已滚动的视口后，initialOffset 返回当前 scrollTop 而不是 0", async () => {
        const api = setup();
        const { element } = fakeViewport(OFFSET);
        api.attach(element);
        await nextTick();

        const initialOffset = initialOffsetOf();
        expect(typeof initialOffset).toBe("function");
        expect(initialOffset!()).toBe(OFFSET);
    });

    it("没有滚动元素时返回 0（不是抛错，也不是沿用旧值）", async () => {
        const api = setup();
        await nextTick();
        expect(initialOffsetOf()!()).toBe(0);

        const { element } = fakeViewport(OFFSET);
        api.attach(element);
        await nextTick();
        expect(initialOffsetOf()!()).toBe(OFFSET);

        api.attach(null);
        await nextTick();
        expect(initialOffsetOf()!()).toBe(0);
    });

    it("是活读而不是快照：attach 之后偏移变了，initialOffset 跟着变", async () => {
        const api = setup();
        const { element } = fakeViewport(OFFSET);
        api.attach(element);
        await nextTick();
        expect(initialOffsetOf()!()).toBe(OFFSET);

        element.scrollTop = 12_000;
        expect(initialOffsetOf()!()).toBe(12_000);
    });

    it("首次 attach 的写回不得把已贴底的 scrollTop 打成 0", async () => {
        const api = setup();
        const { element, writes } = fakeViewport(OFFSET);
        api.attach(element);
        await nextTick();
        await nextTick();

        // 先证明「库真的写了」——否则 every() 对空数组恒真，就是断言平凡成立（D-1634）。
        expect(writes.length).toBeGreaterThan(0);
        expect(writes.every((value) => value === OFFSET)).toBe(true);
        expect(element.scrollTop).toBe(OFFSET);
    });
});
