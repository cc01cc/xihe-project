import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { computed, defineComponent, h, nextTick, ref } from "vue";
import type { useVirtualizer } from "@tanstack/vue-virtual";
import { useVirtualMessageWindow } from "../composables/useVirtualMessageWindow";

/**
 * task-259 / BL-340 —— 不变量守卫：**用户上滚时，首次测量的估算误差不得补进 scrollTop**。
 *
 * 机制（逐腿读数见
 * internal/A03-xihe/evidence/2026-11-15-task259-upscroll-compensation/README.md）：
 * 库默认判据对**首次测量**不看滚动方向（`@tanstack/virtual-core` dist/esm/index.js:1017-1032），
 * 于是上滚时新挂载行的 160 → 675/314 估算差（+515/+154）被补进 scrollTop，抵消用户上滚。
 * 本守卫钉的是我们交给库的钩子契约（`shouldAdjustScrollPositionOnItemSizeChange`，
 * 实例级公开字段 index.d.ts:135），不是端到端结果 —— 端到端另有 bl316/bl340 与探针。
 *
 * 判别力由**双向隔离变异**提供（D-1635）：去掉钩子 ⇒ 本文件红；恢复 ⇒ 绿；
 * 只去掉 250ms 意图窗 ⇒ 第 5/6 例红（小步长下库 scrollDirection 会退回 null）。
 *
 * 只包一层 useVirtualizer 捕获实例，库本体仍是真实实现（不替身库行为）。
 */
type HookItem = {
    index: number;
    key: string;
    start: number;
    size: number;
    end: number;
    lane: number;
};

type HookHost = {
    scrollDirection: "forward" | "backward" | null;
    scrollOffset: number | null;
    itemSizeCache: Map<string, number>;
    shouldAdjustScrollPositionOnItemSizeChange?: (
        item: HookItem,
        delta: number,
        instance: HookHost,
    ) => boolean;
};

const captured = vi.hoisted(() => ({
    instance: null as { value: unknown } | null,
}));

vi.mock("@tanstack/vue-virtual", async (importOriginal) => {
    const actual = await importOriginal<{ useVirtualizer: typeof useVirtualizer }>();
    return {
        ...actual,
        useVirtualizer: ((options: unknown) => {
            const instance = actual.useVirtualizer(
                options as Parameters<typeof actual.useVirtualizer>[0],
            );
            captured.instance = instance as unknown as { value: unknown };
            return instance;
        }) as typeof actual.useVirtualizer,
    };
});

const OFFSET = 40_000;

describe("useVirtualMessageWindow · 上滚补偿契约（task-259）", () => {
    const mounted: Array<ReturnType<typeof mount>> = [];

    afterEach(() => {
        for (const wrapper of mounted.splice(0)) wrapper.unmount();
        document.body.innerHTML = "";
        captured.instance = null;
        vi.restoreAllMocks();
    });

    function setup() {
        let api: ReturnType<typeof useVirtualMessageWindow> | undefined;
        const keys = ref(Array.from({ length: 240 }, (_, index) => "k" + index));
        const Harness = defineComponent({
            setup() {
                api = useVirtualMessageWindow({
                    rowKeys: computed(() => keys.value),
                    enabled: computed(() => true),
                    fallbackHeight: 160,
                    overscan: 2,
                });
                return () => h("div");
            },
        });
        mounted.push(mount(Harness));
        expect(api).toBeTruthy();
        return api!;
    }

    /** 视口：clientHeight 固定、scrollTop 可写（scroll 事件由用例显式派发）。 */
    function fakeViewport(scrollTop: number) {
        const element = document.createElement("div");
        let current = scrollTop;
        Object.defineProperty(element, "clientHeight", { value: 766, configurable: true });
        Object.defineProperty(element, "scrollTop", {
            configurable: true,
            get: () => current,
            set: (value: number) => {
                current = value;
            },
        });
        document.body.appendChild(element);
        return element;
    }

    function host(): HookHost {
        const value = captured.instance?.value as HookHost | undefined;
        expect(value).toBeTruthy();
        return value!;
    }

    function hook(): (item: HookItem, delta: number, instance: HookHost) => boolean {
        const fn = host().shouldAdjustScrollPositionOnItemSizeChange;
        expect(typeof fn).toBe("function");
        return fn!;
    }

    /** 折线上方、尚未测量过的行（上滚时新挂载的就是这种）。 */
    const aboveFold: HookItem = {
        index: 3,
        key: "k3",
        start: 1_000,
        size: 675,
        end: 1_675,
        lane: 0,
    };

    it("把补偿判据钩子交给库（不是留 undefined 走库默认）", async () => {
        setup();
        await nextTick();
        expect(typeof host().shouldAdjustScrollPositionOnItemSizeChange).toBe("function");
    });

    it("上滚 + 首次测量：即使行在折线上方、delta 为正，也不补偿", async () => {
        const api = setup();
        api.attach(fakeViewport(OFFSET));
        await nextTick();
        const instance = host();
        instance.scrollDirection = "backward";
        instance.scrollOffset = OFFSET;
        expect(hook()(aboveFold, 515, instance)).toBe(false);
    });

    it("非上滚 + 首次测量 + 行在折线上方：保持库默认（补偿）", async () => {
        const api = setup();
        api.attach(fakeViewport(OFFSET));
        await nextTick();
        const instance = host();
        instance.scrollDirection = "forward";
        instance.scrollOffset = OFFSET;
        expect(hook()(aboveFold, 515, instance)).toBe(true);
    });

    it("非上滚 + 再次测量 + 行跨折线：不补偿（流式增长 #1218 不回归）", async () => {
        const api = setup();
        api.attach(fakeViewport(OFFSET));
        await nextTick();
        const instance = host();
        instance.scrollDirection = "forward";
        instance.scrollOffset = OFFSET;
        instance.itemSizeCache.set(aboveFold.key, 600);
        const spanning: HookItem = {
            ...aboveFold,
            start: OFFSET - 100,
            size: 675,
            end: OFFSET + 575,
        };
        expect(hook()(spanning, 75, instance)).toBe(false);
    });

    it("小步长形态：scrollDirection 退回 null，但刚发生上滚 ⇒ 意图窗内仍不补偿", async () => {
        const api = setup();
        const element = fakeViewport(OFFSET);
        api.attach(element);
        await nextTick();
        const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
        element.scrollTop = OFFSET - 500;
        element.dispatchEvent(new Event("scroll"));
        const instance = host();
        instance.scrollDirection = null;
        instance.scrollOffset = OFFSET - 500;
        now.mockReturnValue(1_100);
        expect(hook()(aboveFold, 515, instance)).toBe(false);
    });

    it("意图窗过期后回到库默认（窗口不是永久关闭补偿）", async () => {
        const api = setup();
        const element = fakeViewport(OFFSET);
        api.attach(element);
        await nextTick();
        const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
        element.scrollTop = OFFSET - 500;
        element.dispatchEvent(new Event("scroll"));
        const instance = host();
        instance.scrollDirection = null;
        instance.scrollOffset = OFFSET;
        now.mockReturnValue(1_400);
        expect(hook()(aboveFold, 515, instance)).toBe(true);
    });
});
