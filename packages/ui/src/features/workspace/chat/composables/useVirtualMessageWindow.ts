/**
 * PLAN-0670 M2d.2 —— 窗口化渲染的 DOM 适配层（chat 本地，不引重型依赖）。
 *
 * 与 `virtualWindow.ts` 分工：纯计算在那边（可单测），这里只负责
 * ① 把 viewport 的 scrollTop / clientHeight 变成响应式；
 * ② 用 ResizeObserver 记录每行真实高度（未测量的行用 fallback）；
 * ③ 窗口位移时做滚动锚定补偿（`scrollTop += topPaddingDelta`，否则滚动会跳）；
 * ④ 暴露 `captureAnchor` / `restoreAnchor` 给"向上加载历史"用 —— prepend 后把同一行钉回原
 *    视觉位置，交互语义（用户正在读的那条不跳走）与 `preserve-scroll-on-prepend` 同源。
 *
 * 注意：`enabled=false` 时（搜索过滤、行数未过阈值、viewport 未挂载）调用方必须退回全量渲染，
 * 本 composable 不改变任何渲染决策。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch, type ComputedRef, type Ref } from "vue";
import {
    DEFAULT_VIRTUAL_OVERSCAN,
    buildRowHeights,
    computeVirtualWindow,
    type VirtualWindow,
} from "./virtualWindow";

export interface UseVirtualMessageWindowOptions {
    /** 行 key 列表（与渲染顺序一致；MessageList 的 `row.key`）。 */
    rowKeys: ComputedRef<readonly string[]>;
    /** 是否启用窗口化（调用方决定：搜索态/小列表/未挂载时 false）。 */
    enabled: ComputedRef<boolean>;
    /** 未测量行的高度估计（px）。 */
    fallbackHeight?: number;
    overscan?: number;
}

export interface ScrollAnchor {
    key: string;
    /** 该行顶部相对 viewport 顶部的偏移（px）。 */
    offset: number;
}

export interface UseVirtualMessageWindowReturn {
    /** 应渲染的窗口；`enabled=false` 时为全量 [0, count)。 */
    window: ComputedRef<VirtualWindow>;
    viewportHeight: Ref<number>;
    scrollTop: Ref<number>;
    /** 挂载 viewport（幂等；重复调用会换元素）。 */
    attach: (element: HTMLElement | null) => void;
    /** 登记一行的真实高度（null 表示卸载，停止观察）。 */
    measure: (key: string, element: HTMLElement | null) => void;
    /** 供"向上加载历史"使用：在数据 prepend 前抓锚点。 */
    captureAnchor: () => ScrollAnchor | null;
    /** prepend + DOM 更新后恢复锚点（nextTick 后调用或自行 await）。 */
    restoreAnchor: (anchor: ScrollAnchor | null) => Promise<void>;
    /** 测试/调试用：当前是否真正启用窗口化。 */
    active: ComputedRef<boolean>;
}

const ELEMENT_HEIGHT_EPSILON = 0.5;

export function useVirtualMessageWindow({
    rowKeys,
    enabled,
    fallbackHeight = 120,
    overscan = DEFAULT_VIRTUAL_OVERSCAN,
}: UseVirtualMessageWindowOptions): UseVirtualMessageWindowReturn {
    const viewport = ref<HTMLElement | null>(null),
        viewportHeight = ref(0),
        scrollTop = ref(0),
        measured = ref(new Map<string, number>()),
        // 非响应式镜像：`measure()` 由行上的函数 ref 在**渲染期**调用（见 MessageList 的
        // `rowElementRef`），渲染期的响应式读会被登记成该组件的渲染依赖、随后的响应式写又会
        // 让同一个渲染 effect 重跑，形成自触发循环（真实链路 E2E 的
        // `Maximum recursive updates exceeded in component <MessageScrollerContent>`）。
        // 因此比较基准放在普通 Map 里，只有高度**真的变了**才写一次 `measured` 通知窗口重算。
        measuredHeights = new Map<string, number>(),
        rowElements = new Map<string, HTMLElement>(),
        resizeObserver =
            typeof ResizeObserver === "undefined"
                ? null
                : new ResizeObserver((entries) => {
                      const heights: Array<readonly [string, number]> = [];
                      for (const entry of entries) {
                          const key = (entry.target as HTMLElement).dataset.virtualRowKey;
                          if (!key) continue;
                          heights.push([key, entry.contentRect.height] as const);
                      }
                      recordHeights(heights);
                  });

    /**
     * 记录行高：幂等，只有变化超过 `ELEMENT_HEIGHT_EPSILON` 才写响应式 `measured`。
     * 渲染期调用也不得触发本组件的渲染 effect 重跑（见上方 `measuredHeights` 的说明）。
     */
    function recordHeights(entries: Iterable<readonly [string, number]>): void {
        let changed = false;

        for (const [key, height] of entries) {
            if (height <= 0) continue;
            const previous = measuredHeights.get(key);
            if (previous !== undefined && Math.abs(previous - height) <= ELEMENT_HEIGHT_EPSILON) {
                continue;
            }
            measuredHeights.set(key, height);
            changed = true;
        }

        if (changed) measured.value = new Map(measuredHeights);
    }

    const active = computed(() => enabled.value && viewportHeight.value > 0);

    // 不要命名为 window：会遮蔽全局 window，使同作用域的 window.setTimeout 运行时报
    // TypeError（BL-353）。`vue-tsc` 拦不住（VirtualWindow 上没有 setTimeout），只有运行时炸。
    const virtualWindow = computed<VirtualWindow>(() => {
        const keys = rowKeys.value;
        if (!active.value) {
            const heights = buildRowHeights(keys, measured.value, fallbackHeight);
            return computeVirtualWindow({
                heights,
                scrollTop: 0,
                viewportHeight: Math.max(
                    0,
                    heights.reduce((sum, height) => sum + height, 0),
                ),
                overscan: 0,
            });
        }
        const heights = buildRowHeights(keys, measured.value, fallbackHeight);
        return computeVirtualWindow({
            heights,
            scrollTop: scrollTop.value,
            viewportHeight: viewportHeight.value,
            overscan,
        });
    });

    let adjusting = false;

    function syncViewportMetrics(element: HTMLElement): void {
        viewportHeight.value = element.clientHeight;
        scrollTop.value = element.scrollTop;
    }

    function handleScroll(event: Event): void {
        const element = event.currentTarget as HTMLElement;
        if (!element || adjusting) return;
        // 滚动驱动的窗口位移**不需要**补偿：窗口计算保证 [scrollTop, scrollTop+height) 的行
        // 一定被渲染，这些行在内容坐标里的位置不变，视觉位置自然不变。补偿只用于
        // 「上方行高度从 fallback 修正为实测值」这类**非滚动**引起的 topPadding 变化（见 measure）。
        syncViewportMetrics(element);
    }

    function attach(element: HTMLElement | null): void {
        if (viewport.value === element) return;
        detach();
        viewport.value = element;
        if (!element) return;
        element.addEventListener("scroll", handleScroll, { passive: true });
        syncViewportMetrics(element);
    }

    function detach(): void {
        const element = viewport.value;
        if (element) element.removeEventListener("scroll", handleScroll);
        viewport.value = null;
        viewportHeight.value = 0;
        scrollTop.value = 0;
    }

    function measure(key: string, element: HTMLElement | null): void {
        const previous = rowElements.get(key);
        if (previous && previous !== element) {
            resizeObserver?.unobserve(previous);
            rowElements.delete(key);
        }
        if (!element) {
            if (previous) resizeObserver?.unobserve(previous);
            rowElements.delete(key);
            return;
        }
        element.dataset.virtualRowKey = key;
        rowElements.set(key, element);
        resizeObserver?.observe(element);
        recordHeights([[key, element.getBoundingClientRect().height]]);
    }

    function captureAnchor(): ScrollAnchor | null {
        const element = viewport.value;
        if (!element) return null;
        const viewportTop = element.getBoundingClientRect().top;
        for (const key of rowKeys.value) {
            const row = rowElements.get(key);
            if (!row) continue;
            const rect = row.getBoundingClientRect();
            if (rect.bottom > viewportTop + ELEMENT_HEIGHT_EPSILON) {
                return { key, offset: rect.top - viewportTop };
            }
        }
        return null;
    }

    async function restoreAnchor(anchor: ScrollAnchor | null): Promise<void> {
        const element = viewport.value;
        if (!anchor || !element) return;
        await nextTick();
        const row = rowElements.get(anchor.key);
        if (!row) return;
        const delta =
            row.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.offset;
        if (Math.abs(delta) > ELEMENT_HEIGHT_EPSILON) {
            adjusting = true;
            element.scrollTop = Math.max(0, element.scrollTop + delta);
            adjusting = false;
        }
    }

    // 行集合变化（切换会话 / 搜索 / 历史 prepend）时，丢弃不属于当前 key 的测量值，
    // 避免旧会话的高度污染新会话的窗口计算。
    watch(
        rowKeys,
        (keys) => {
            const allowed = new Set(keys);
            let changed = false;
            for (const key of Array.from(measuredHeights.keys())) {
                if (!allowed.has(key)) {
                    measuredHeights.delete(key);
                    changed = true;
                }
            }
            for (const key of Array.from(rowElements.keys())) {
                if (!allowed.has(key)) {
                    const element = rowElements.get(key);
                    if (element) resizeObserver?.unobserve(element);
                    rowElements.delete(key);
                }
            }
            if (changed) measured.value = new Map(measuredHeights);
        },
        { flush: "post" },
    );

    onBeforeUnmount(() => {
        detach();
        resizeObserver?.disconnect();
        rowElements.clear();
        measuredHeights.clear();
    });

    return {
        // 对外字段名保持 `window`（调用方不改；BL-353 只改本地标识符）。
        window: virtualWindow,
        viewportHeight,
        scrollTop,
        attach,
        measure,
        captureAnchor,
        restoreAnchor,
        active,
    };
}
