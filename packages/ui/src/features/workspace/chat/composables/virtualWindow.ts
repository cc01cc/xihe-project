/**
 * PLAN-0670 M2d.2 —— 消息列表窗口化渲染的纯计算层（不碰 DOM、不碰 store）。
 *
 * 背景（PLAN-0670 实测）：`MessageList.vue` 全量渲染 `filteredMessages`，5k 条 ⇒ 102,940 DOM
 * 节点 / 16.8 FPS，20k 条直接渲染不出来。虚拟滚动把 DOM 压到常数级，但**不能改变交互语义**：
 * 向上滚动仍要能看到历史、新消息到达仍要贴底、搜索/跳转仍要能定位 —— 所以窗口计算必须可单测、
 * 锚定补偿必须显式（不靠肉眼）。
 *
 * 这里只做两件事：
 * 1. 给定每行高度（已测量）与滚动位置，算出应渲染的 `[start, end)` 与上下占位高度；
 * 2. 提供「滚动后窗口位移」的锚定补偿量：`scrollTop += topPaddingDelta` 后同一内容仍停在原位。
 *
 * 行高未知时用 `fallbackHeight`（消息行典型高度），渲染后再用真实测量值修正；测量值进
 * `heights` map 后窗口计算自动收敛。
 */

export interface VirtualWindow {
    /** 第一个应渲染的行下标（含）。 */
    start: number;
    /** 最后一个应渲染的行下标（不含）。 */
    end: number;
    /** 窗口上方占位高度（px）。 */
    topPadding: number;
    /** 窗口下方占位高度（px）。 */
    bottomPadding: number;
    /** 全部行的总高度（已测量 + 未测量 fallback）。 */
    totalHeight: number;
}

export interface ComputeVirtualWindowOptions {
    /** 每行高度（px）。调用方用 `buildRowHeights` 把已测量值 + fallback 合成数组。 */
    heights: readonly number[];
    /** 视口 scrollTop（px）。 */
    scrollTop: number;
    /** 视口可视高度（px）。 */
    viewportHeight: number;
    /** 上下各多渲染几行，避免快速滚动出现空白。 */
    overscan?: number;
}

export const DEFAULT_VIRTUAL_OVERSCAN = 6;
export const DEFAULT_VIRTUAL_MIN_ROWS = 150;

/** 前缀高度数组：`prefix[i]` = 前 i 行总高；长度 = heights.length + 1。 */
export function buildPrefixHeights(heights: readonly number[]): number[] {
    const prefix = [0];
    for (let index = 0; index < heights.length; index += 1) {
        prefix.push(prefix[index] + heights[index]);
    }
    return prefix;
}

/** 第一个「底部越过 offset」的行下标（二分；offset ≤ 0 返回 0）。 */
export function indexAtOffset(prefix: readonly number[], offset: number): number {
    const total = prefix[prefix.length - 1] ?? 0;
    if (offset <= 0) return 0;
    if (offset >= total) return Math.max(0, prefix.length - 2);

    let low = 0,
        high = prefix.length - 1;
    while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (prefix[mid + 1] <= offset) low = mid + 1;
        else high = mid;
    }
    return low;
}

export function computeVirtualWindow({
    heights,
    scrollTop,
    viewportHeight,
    overscan = DEFAULT_VIRTUAL_OVERSCAN,
}: ComputeVirtualWindowOptions): VirtualWindow {
    const count = heights.length;
    if (count === 0) {
        return { start: 0, end: 0, topPadding: 0, bottomPadding: 0, totalHeight: 0 };
    }

    const prefix = buildPrefixHeights(heights);
    const totalHeight = prefix[count];
    const safeTop = Math.max(0, Math.min(scrollTop, Math.max(0, totalHeight - 1)));
    const safeHeight = Math.max(0, viewportHeight);
    const firstVisible = indexAtOffset(prefix, safeTop);
    const lastVisible = indexAtOffset(prefix, safeTop + safeHeight);

    const start = Math.max(0, firstVisible - Math.max(0, overscan));
    const end = Math.min(count, lastVisible + 1 + Math.max(0, overscan));
    return {
        start,
        end,
        topPadding: prefix[start],
        bottomPadding: Math.max(0, totalHeight - prefix[end]),
        totalHeight,
    };
}

/**
 * 行高数组：已测量值优先，缺省用 fallback；保证返回长度与 keys 一致。
 * `measured` 的 key 是行 key（MessageList 的 `row.key`）。
 */
export function buildRowHeights(
    keys: readonly string[],
    measured: ReadonlyMap<string, number>,
    fallbackHeight: number,
): number[] {
    const fallback = Math.max(1, fallbackHeight);
    return keys.map((key) => {
        const height = measured.get(key);
        return height && height > 0 ? height : fallback;
    });
}

/**
 * 窗口位移后的滚动锚定补偿：当 `topPadding` 从 prev 变为 next 时，
 * 把 `scrollTop` 加上同一 delta，可让视口内的内容视觉位置不变。
 * 返回 null 表示无需调整。
 */
export function scrollCompensation(prevTopPadding: number, nextTopPadding: number): number | null {
    const delta = nextTopPadding - prevTopPadding;
    return delta === 0 ? null : delta;
}
