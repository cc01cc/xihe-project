/**
 * PLAN-0670 M2d.2 —— 窗口化渲染的 DOM 适配层。
 * PLAN-0753 M4（task-185）—— 窗口引擎迁到 @tanstack/vue-virtual（POC 283e975b 四风险全过）。
 *
 * 与 virtualWindow.ts 分工：纯计算在那边（可单测），这里只负责
 * ① 把 viewport 元素交给 useVirtualizer（measurement + 滑窗都由库负责）；
 * ② 把行元素喂给 virtualizer.measureElement（动态高度由库的 ResizeObserver 跟踪）；
 * ③ 暴露 captureAnchor / restoreAnchor 给“向上加载历史”用 —— prepend 后把同一行钉回原
 *    视觉位置（BL-382 A/B 机制不动：锚点仍是 DOM 事实，不依赖窗口引擎）；
 * ④ 对外 window 形状不变（start/end/topPadding/bottomPadding/totalHeight），渲染层
 *    （MessageList 的占位 spacer 模型）不感知引擎切换。
 *
 * 首帧/降级路径：库的 getVirtualItems() 在滚动元素尚未被观测（attach 同帧、jsdom 单测、
 * 库不可用）时为空 —— 此时用 virtualWindow.ts 的纯计算按 fallback 高度给出窗口，
 * 行为与迁移前逐字节一致；库一接管就切到实测值（同一帧内用户不可见）。
 *
 * 注意：enabled=false 时（搜索过滤、行数未过阈值、viewport 未挂载）调用方必须退回全量渲染，
 * 本 composable 不改变任何渲染决策。
 */
import { computed, onBeforeUnmount, ref, watch, type ComputedRef, type Ref } from "vue";
import { useVirtualizer } from "@tanstack/vue-virtual";
import {
    DEFAULT_VIRTUAL_OVERSCAN,
    buildRowHeights,
    computeVirtualWindow,
    windowFromMeasurements,
    type VirtualWindow,
} from "./virtualWindow";

export interface UseVirtualMessageWindowOptions {
    /** 行 key 列表（与渲染顺序一致；MessageList 的 row.key）。 */
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
    /** 应渲染的窗口；enabled=false 时为全量 [0, count)。 */
    window: ComputedRef<VirtualWindow>;
    viewportHeight: Ref<number>;
    scrollTop: Ref<number>;
    /** 挂载 viewport（幂等；重复调用会换元素）。 */
    attach: (element: HTMLElement | null) => void;
    /** 登记一行的真实高度（null 表示卸载，停止观察）。 */
    measure: (key: string, element: HTMLElement | null) => void;
    /** 供“向上加载历史”使用：在数据 prepend 前抓锚点。 */
    captureAnchor: () => ScrollAnchor | null;
    /** prepend + DOM 更新后恢复锚点（nextTick 后调用或自行 await）。 */
    restoreAnchor: (anchor: ScrollAnchor | null) => Promise<void>;
    /** 测试/调试用：当前是否真正启用窗口化。 */
    active: ComputedRef<boolean>;
}

/** measureElement 读取的下标属性（与 useVirtualizer 的 indexAttribute 一致）。 */
const VIRTUAL_INDEX_ATTRIBUTE = "data-virtual-index";

/** 纯计算降级路径没有实测高度，统一按 fallback（渲染语义与迁移前一致）。 */
const EMPTY_HEIGHTS: ReadonlyMap<string, number> = new Map();

export function useVirtualMessageWindow({
    rowKeys,
    enabled,
    fallbackHeight = 120,
    overscan = DEFAULT_VIRTUAL_OVERSCAN,
}: UseVirtualMessageWindowOptions): UseVirtualMessageWindowReturn {
    const viewport = ref<HTMLElement | null>(null),
        viewportHeight = ref(0),
        scrollTop = ref(0),
        rowElements = new Map<string, HTMLElement>(),
        keyToIndex = computed(() => {
            const map = new Map<string, number>();
            const keys = rowKeys.value;
            for (let index = 0; index < keys.length; index += 1) map.set(keys[index], index);
            return map;
        });

    /**
     * 库实例：getScrollElement 读响应式 viewport（attach 变化时 vue-virtual 重新订阅）。
     * getItemKey 用行 key（与 rowKeys 一一对应）—— 窗口换页/丢最旧时同一消息保持同一 key，
     * 库的测量缓存才能跨窗口复用（POC 实测：按 index 做 key 会在 prepend 后整表测量漂移）。
     */
    const virtualizer = useVirtualizer<HTMLElement, HTMLElement>(
        computed(() => ({
            count: rowKeys.value.length,
            getScrollElement: () => viewport.value,
            estimateSize: () => Math.max(1, fallbackHeight),
            overscan,
            getItemKey: (index: number) => rowKeys.value[index] ?? index,
            indexAttribute: VIRTUAL_INDEX_ATTRIBUTE,
        })),
    );

    /**
     * 读库的测量结果算窗口；库尚未接管（无滚动元素 / 未测量任何行）→ null，调用方走纯计算。
     *
     * 只用 measurementsCache（测量事实）+ 我们的 scrollTop/viewportHeight，不用库的 getVirtualItems():
     * 后者的窗口依赖库内部 scrollOffset，而 scrollOffset 由 observer 异步写入（attach 后才注册、
     * 注册时不读初始偏移）—— jsdom 单测与「attach 同帧写 scrollTop」两条路径都会读到旧偏移。
     */
    function measurementsWindow(): VirtualWindow | null {
        if (!viewport.value) return null;
        const instance = virtualizer.value;
        const measurements = instance.measurementsCache;
        if (!measurements || measurements.length === 0) return null;
        return windowFromMeasurements(
            measurements,
            instance.getTotalSize(),
            scrollTop.value,
            viewportHeight.value,
            overscan,
            rowKeys.value.length,
        );
    }

    /** 纯计算降级窗口（按 fallback 高度；渲染语义与迁移前一致）。 */
    function fallbackWindow(): VirtualWindow {
        const heights = buildRowHeights(rowKeys.value, EMPTY_HEIGHTS, Math.max(1, fallbackHeight));
        return computeVirtualWindow({
            heights,
            scrollTop: scrollTop.value,
            viewportHeight: viewportHeight.value,
            overscan,
        });
    }

    const active = computed(() => enabled.value && viewportHeight.value > 0);

    const virtualWindow = computed<VirtualWindow>(() => {
        // 关闭窗口化：调用方全量渲染（visibleRows = rows），窗口对象只守 disabled 契约。
        if (!active.value) {
            const count = rowKeys.value.length;
            return {
                start: 0,
                end: count,
                topPadding: 0,
                bottomPadding: 0,
                totalHeight: count * Math.max(1, fallbackHeight),
            };
        }
        return measurementsWindow() ?? fallbackWindow();
    });

    /* ---------------------------------------------------------------- */
    /* viewport attach / scroll 同步                                      */
    /* ---------------------------------------------------------------- */

    function syncViewportMetrics(): void {
        const element = viewport.value;
        if (!element) {
            viewportHeight.value = 0;
            scrollTop.value = 0;
            return;
        }
        viewportHeight.value = element.clientHeight;
        scrollTop.value = element.scrollTop;
    }

    function handleScroll(): void {
        syncViewportMetrics();
    }

    function attach(element: HTMLElement | null): void {
        if (viewport.value === element) {
            syncViewportMetrics();
            return;
        }
        viewport.value?.removeEventListener("scroll", handleScroll);
        viewport.value = element;
        if (element) {
            element.addEventListener("scroll", handleScroll, { passive: true });
        }
        syncViewportMetrics();
        // attach 前挂载的行是在窗口化未生效时渲染的（measure 被跳过），这里补测一次。
        measureMountedRows();
    }

    /* ---------------------------------------------------------------- */
    /* 行测量：写 dataset 后交给库                                         */
    /* ---------------------------------------------------------------- */

    /** 把一行交给库：写 index 属性 → 库观察 + 高度缓存 + 内建滚动补偿。 */
    function applyRowMeasurement(key: string, element: HTMLElement): void {
        const index = keyToIndex.value.get(key);
        if (index === undefined) return;
        // 0 高度行不登记：库的 measureElement 在无 ResizeObserverEntry 时退化为 offsetHeight，
        // jsdom/隐藏行会读到 0 并把 0 写进 measurementsCache（把整窗口算坏）。旧实现同样跳过 h<=0。
        if (element.offsetHeight <= 0) return;
        element.dataset.virtualRowKey = key;
        element.setAttribute(VIRTUAL_INDEX_ATTRIBUTE, String(index));
        virtualizer.value.measureElement(element);
    }

    /**
     * 已挂载行全部重测。窗口化从关到开（attach 完成 / 搜索态退出）时行元素不会重新触发 ref，
     * 不重测的话库里没有测量结果，窗口会一直停在 fallback 估算路径。
     */
    function measureMountedRows(): void {
        if (!active.value) return;
        for (const [key, element] of rowElements) applyRowMeasurement(key, element);
    }

    /**
     * 登记一行的高度。**窗口化关闭时（搜索态/小表）不把行交给库** —— 那种模式下渲染是全量的，
     * 库的「行尺寸变化 → 补偿 scrollTop」会与 MessageScrollerProvider 的跟随/平滑滚动打架
     * （实测：60 行搜索面 + 120 行上滚面两条 e2e 因此变红）。
     */
    function measure(key: string, element: HTMLElement | null): void {
        if (!element) {
            rowElements.delete(key);
            // 库对已卸载元素做一次清扫（unobserve + 清 elementsCache），避免拿 0 高度回写。
            virtualizer.value.measureElement(null);
            return;
        }
        rowElements.set(key, element);
        if (!active.value) return;
        applyRowMeasurement(key, element);
    }

    /* ---------------------------------------------------------------- */
    /* prepend 锚点（BL-382 A/B 机制，保持不变）                            */
    /* ---------------------------------------------------------------- */

    function captureAnchor(): ScrollAnchor | null {
        const element = viewport.value;
        if (!element || rowElements.size === 0) return null;
        const viewportTop = element.getBoundingClientRect().top;
        let best: ScrollAnchor | null = null;
        for (const [key, rowElement] of rowElements) {
            const rect = rowElement.getBoundingClientRect();
            // 首个「底边越过视口顶」的行 = 用户正在读的那行（可为负偏移）。
            if (rect.bottom <= viewportTop) continue;
            const offset = rect.top - viewportTop;
            if (best === null || offset < best.offset) best = { key, offset };
        }
        return best;
    }

    async function restoreAnchor(anchor: ScrollAnchor | null): Promise<void> {
        const element = viewport.value;
        if (!element || !anchor) return;
        const rowElement = rowElements.get(anchor.key);
        if (!rowElement) return;
        const viewportTop = element.getBoundingClientRect().top;
        const currentOffset = rowElement.getBoundingClientRect().top - viewportTop;
        const delta = currentOffset - anchor.offset;
        if (delta === 0) return;
        element.scrollTop += delta;
        scrollTop.value = element.scrollTop;
    }

    /* ---------------------------------------------------------------- */
    /* 生命周期                                                           */
    /* ---------------------------------------------------------------- */

    // 外部对 scrollTop 的写入（MessageList 的 prepend 同帧补偿）→ 只补 DOM。
    //
    // 不要在这里调 virtualizer.scrollToOffset()：它内部走 scrollToFn → element.scrollTo({top})（非 smooth），
    // 会**打断 MessageScrollerProvider 正在进行的平滑滚动**——实测表现为"点回到最新后停在半路、按钮不隐藏"
    // （e2e/mock/chat-scroll.spec.ts）。窗口已经改用 measurementsCache 计算，库内部的 scrollOffset
    // 不参与渲染，无需同步。
    watch(scrollTop, (value) => {
        const element = viewport.value;
        if (!element) return;
        if (Math.abs(element.scrollTop - value) > 0.5) {
            element.scrollTop = value;
        }
    });

    // 窗口化刚生效：把已挂载但被跳过的行补测一遍（搜索态退出 / attach 完成）。
    watch(active, (isActive) => {
        if (isActive) measureMountedRows();
    });

    // 行集合变化：清掉已卸载行的元素引用（锚点不能用已不在 DOM 的行）。
    watch(
        rowKeys,
        (keys) => {
            const allowed = new Set(keys);
            for (const key of Array.from(rowElements.keys())) {
                if (!allowed.has(key)) rowElements.delete(key);
            }
        },
        { flush: "post" },
    );

    onBeforeUnmount(() => {
        attach(null);
        rowElements.clear();
    });

    return {
        // 对外字段名保持 window（调用方不改；BL-353 只改本地标识符）。
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
