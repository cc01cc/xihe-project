import { describe, it, expect, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { computed, defineComponent, h, nextTick, ref } from "vue";
import {
    buildPrefixHeights,
    buildRowHeights,
    computeVirtualWindow,
    indexAtOffset,
    scrollCompensation,
} from "../composables/virtualWindow";
import { useVirtualMessageWindow } from "../composables/useVirtualMessageWindow";

/**
 * PLAN-0670 M2d.2 —— 虚拟滚动的**可单测**部分：
 * 1. 窗口计算（start/end/topPadding/bottomPadding/totalHeight）；
 * 2. 前缀和 / 二分定位；
 * 3. 行高合成（实测优先、fallback 兜底）；
 * 4. 滚动锚定补偿（prepend 后同一行保持视觉位置）；
 * 5. composable 的 DOM 适配：scrollTop/clientHeight ⇒ 窗口；锚点 capture/restore。
 *
 * 交互语义（向上加载不跳、新消息贴底、搜索不虚拟化）在 MessageList 组件层，另有组件测试覆盖。
 */
describe("virtualWindow pure logic", () => {
    it("builds prefix heights and finds the first row crossing an offset", () => {
        const prefix = buildPrefixHeights([100, 50, 200, 25]);
        expect(prefix).toEqual([0, 100, 150, 350, 375]);
        expect(indexAtOffset(prefix, 0)).toBe(0);
        expect(indexAtOffset(prefix, 99)).toBe(0);
        expect(indexAtOffset(prefix, 100)).toBe(1);
        expect(indexAtOffset(prefix, 149)).toBe(1);
        expect(indexAtOffset(prefix, 150)).toBe(2);
        expect(indexAtOffset(prefix, 375)).toBe(3);
        expect(indexAtOffset(prefix, 9999)).toBe(3);
    });

    it("returns an empty window for no rows", () => {
        expect(computeVirtualWindow({ heights: [], scrollTop: 0, viewportHeight: 600 })).toEqual({
            start: 0,
            end: 0,
            topPadding: 0,
            bottomPadding: 0,
            totalHeight: 0,
        });
    });

    it("renders all rows when the list is shorter than the viewport", () => {
        const heights = [100, 100, 100];
        const window = computeVirtualWindow({ heights, scrollTop: 0, viewportHeight: 600 });
        expect(window.start).toBe(0);
        expect(window.end).toBe(3);
        expect(window.topPadding).toBe(0);
        expect(window.bottomPadding).toBe(0);
        expect(window.totalHeight).toBe(300);
    });

    it("windows a long list around the scroll position with overscan and spacer heights", () => {
        const heights = Array.from({ length: 100 }, () => 100);
        const window = computeVirtualWindow({
            heights,
            scrollTop: 5000,
            viewportHeight: 300,
            overscan: 2,
        });
        // 首可见行 = 50（5000/100），末可见行 = 53（5300/100），上下各 overscan 2。
        expect(window.start).toBe(48);
        expect(window.end).toBe(56);
        expect(window.topPadding).toBe(4800);
        expect(window.bottomPadding).toBe(10000 - 5600);
        expect(window.totalHeight).toBe(10000);
    });

    it("keeps the window inside the list at the bottom edge", () => {
        const heights = Array.from({ length: 50 }, () => 100);
        const window = computeVirtualWindow({
            heights,
            scrollTop: 4700,
            viewportHeight: 300,
            overscan: 2,
        });
        expect(window.start).toBe(45);
        expect(window.end).toBe(50);
        expect(window.bottomPadding).toBe(0);
        expect(window.topPadding).toBe(4500);
    });

    it("clamps negative/oversized scrollTop instead of producing a negative window", () => {
        const heights = [100, 100, 100, 100];
        expect(computeVirtualWindow({ heights, scrollTop: -50, viewportHeight: 200 }).start).toBe(
            0,
        );
        const atEnd = computeVirtualWindow({ heights, scrollTop: 9999, viewportHeight: 200 });
        expect(atEnd.end).toBe(4);
        expect(atEnd.bottomPadding).toBe(0);
    });

    it("prefers measured heights and falls back for unknown rows", () => {
        const measured = new Map<string, number>([
            ["a", 180],
            ["c", 40],
        ]);
        expect(buildRowHeights(["a", "b", "c"], measured, 120)).toEqual([180, 120, 40]);
        // fallback 必须为正，0/负数按 1 处理（避免除零/负高度）。
        expect(buildRowHeights(["x"], new Map(), 0)).toEqual([1]);
    });

    it("computes the scroll compensation for a prepend/height change", () => {
        expect(scrollCompensation(0, 4800)).toBe(4800);
        expect(scrollCompensation(4800, 4800)).toBeNull();
        expect(scrollCompensation(4800, 0)).toBe(-4800);
    });
});

describe("useVirtualMessageWindow DOM adapter", () => {
    const mounted: Array<ReturnType<typeof mount>> = [];

    afterEach(() => {
        for (const wrapper of mounted.splice(0)) wrapper.unmount();
        document.body.innerHTML = "";
    });

    function setup(initialKeys: string[], enabledRef = ref(true)) {
        let api: ReturnType<typeof useVirtualMessageWindow> | undefined;
        const keys = ref(initialKeys);
        const Harness = defineComponent({
            setup() {
                api = useVirtualMessageWindow({
                    rowKeys: computed(() => keys.value),
                    enabled: computed(() => enabledRef.value),
                    fallbackHeight: 100,
                    overscan: 2,
                });
                return () => h("div");
            },
        });
        const wrapper = mount(Harness);
        mounted.push(wrapper);
        expect(api).toBeTruthy();
        return { api: api!, keys, enabled: enabledRef };
    }

    function fakeViewport(height: number, scrollTop = 0): HTMLElement {
        const element = document.createElement("div");
        Object.defineProperty(element, "clientHeight", { value: height, configurable: true });
        element.scrollTop = scrollTop;
        element.getBoundingClientRect = () =>
            ({
                top: 0,
                bottom: height,
                left: 0,
                right: 0,
                width: 0,
                height,
                x: 0,
                y: 0,
            }) as DOMRect;
        document.body.appendChild(element);
        return element;
    }

    function fakeRow(top: number, height: number): HTMLElement {
        const element = document.createElement("div");
        element.getBoundingClientRect = () =>
            ({
                top,
                bottom: top + height,
                left: 0,
                right: 0,
                width: 0,
                height,
                x: 0,
                y: top,
            }) as DOMRect;
        document.body.appendChild(element);
        return element;
    }

    it("derives the render window from scrollTop/clientHeight and stays full-render when disabled", async () => {
        const keys = Array.from({ length: 100 }, (_, index) => `k${index}`);
        const { api } = setup(keys);
        const viewport = fakeViewport(300);
        api.attach(viewport);
        expect(api.active.value).toBe(true);
        expect(api.window.value.start).toBe(0);
        expect(api.window.value.end).toBe(6);

        viewport.scrollTop = 5000;
        viewport.dispatchEvent(new Event("scroll"));
        await nextTick();
        expect(api.window.value.start).toBe(48);
        expect(api.window.value.end).toBe(56);
        expect(api.window.value.topPadding).toBe(4800);
    });

    it("keeps scrollTop when virtualization is disabled (search mode must not jump to top)", async () => {
        const keys = Array.from({ length: 100 }, (_, index) => `k${index}`);
        const { api, enabled } = setup(keys);
        const viewport = fakeViewport(300, 5000);
        api.attach(viewport);
        viewport.dispatchEvent(new Event("scroll"));
        await nextTick();
        expect(api.window.value.start).toBe(48);

        // 搜索态切换：窗口化关闭 ⇒ 全量渲染；scrollTop 不得被重置（切回时用户位置还在）。
        enabled.value = false;
        await nextTick();
        expect(api.active.value).toBe(false);
        expect(api.window.value.start).toBe(0);
        expect(api.window.value.end).toBe(100);
        expect(viewport.scrollTop).toBe(5000);
    });

    it("keeps the visible row in place when the oldest rows are dropped (cap 500 scrollHeight shrink)", async () => {
        // PLAN-0670 M2d.3：丢最旧会缩短 scrollHeight；必须与 prepend 走同一套锚点补偿，
        // 否则用户正在读中间时会突然跳位（Lead 2026-11-05 点名的坑）。
        const keys = Array.from({ length: 100 }, (_, index) => `k${index}`);
        const { api, keys: keysRef } = setup(keys);
        const viewport = fakeViewport(300, 5000);
        api.attach(viewport);
        viewport.dispatchEvent(new Event("scroll"));
        await nextTick();

        const anchorRow = fakeRow(0, 100);
        api.measure("k50", anchorRow);
        expect(api.captureAnchor()).toEqual({ key: "k50", offset: 0 });

        // 丢弃最旧 10 行（1000px）：内容整体上移 1000px，滚动位置不变的话 k50 会跳到视口上方。
        keysRef.value = keysRef.value.slice(10);
        await nextTick();
        const shifted = fakeRow(-1000, 100);
        api.measure("k50", shifted);
        await api.restoreAnchor({ key: "k50", offset: 0 });
        expect(viewport.scrollTop).toBe(4000);
    });

    it("captures the first visible row as the anchor and restores it after a prepend", async () => {
        const keys = Array.from({ length: 100 }, (_, index) => `k${index}`);
        const { api } = setup(keys);
        const viewport = fakeViewport(300, 5000);
        api.attach(viewport);
        viewport.dispatchEvent(new Event("scroll"));
        await nextTick();

        // 窗口 48..56；第 50 行顶部正好在视口顶（5000 - 5000 = 0），是首个可见行。
        const row50 = fakeRow(0, 100);
        api.measure("k50", row50);
        expect(api.captureAnchor()).toEqual({ key: "k50", offset: 0 });

        // 模拟 prepend：同一行被推到视口顶下方 300px（内容整体下移），恢复锚点应把 scrollTop +300。
        const shifted = fakeRow(300, 100);
        api.measure("k50", shifted);
        await api.restoreAnchor({ key: "k50", offset: 0 });
        expect(viewport.scrollTop).toBe(5300);
    });

    it("reports an empty anchor when nothing is mounted", () => {
        const { api } = setup(["a", "b"]);
        expect(api.captureAnchor()).toBeNull();
    });
});
