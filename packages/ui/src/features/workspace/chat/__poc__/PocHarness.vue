<script setup lang="ts">
/**
 * BL-382 A′ 探针：`@tanstack/vue-virtual` 挂在**现有** `MessageScroller` 引擎上（不替换它）。
 *
 * 为什么必须真浏览器：四项风险全部是**布局事实**（动态高度测量、prepend 保位 ±2px、流式贴底抖动），
 * jsdom 无布局，只能给出合成数字 —— BL-382 的教训就是"合成数字当证据"。所以本文件只负责渲染与暴露
 * `window.__poc` 探针，量测全部在 `run-poc.mjs` 里用 Playwright 真 Chromium 做。
 *
 * URL 参数（driver 用它们做对照实验）：
 * - `rows=500`    初始行数
 * - `anchor=end|start`  `anchorTo`（end = 目标方案；start = 对照组，等同"没有库的保位"）
 * - `follow=1|0`  `followOnAppend`
 * - `auto=1|0`    `MessageScrollerProvider` 自己的 auto-scroll（默认关，用于隔离库行为）
 * - `grow=1|0`    是否让"图片行"在 400ms 后长高（验证动态测量）
 */
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useVirtualizer } from "@tanstack/vue-virtual";
import {
    MessageScroller,
    MessageScrollerContent,
    MessageScrollerItem,
    MessageScrollerProvider,
    MessageScrollerViewport,
} from "@/components/ui/message-scroller";

const params = new URLSearchParams(window.location.search);
const initialRows = Number(params.get("rows") ?? "500");
const anchorTo = (params.get("anchor") === "start" ? "start" : "end") as "start" | "end";
const followOnAppend = params.get("follow") === "1";
const autoScroll = params.get("auto") === "1";
const growImages = params.get("grow") !== "0";

interface PocRow {
    id: string;
    /** 渲染高度（px）。确定性伪随机，保证同一 index 每次都一样。 */
    height: number;
    kind: "text" | "code" | "image";
    /** 图片行：先 60px，400ms 后长到 240px（模拟图片加载完成）。 */
    grown: boolean;
}

function makeRow(id: string, index: number): PocRow {
    const kind: PocRow["kind"] = index % 31 === 0 ? "code" : index % 17 === 0 ? "image" : "text";
    const height = kind === "code" ? 220 : kind === "image" ? 60 : 44 + ((index * 37) % 120);
    return { id, height, kind, grown: false };
}

const rows = ref<PocRow[]>(
    Array.from({ length: initialRows }, (_, index) => makeRow(`m-${index}`, index)),
);

/**
 * 坑（= BL-316 修过的同一个坑，值得记进结论）：`<MessageScrollerViewport ref="...">` 上的模板 ref 拿到的是
 * **组件实例**，不是那个滚动 div；直接把它交给 `getScrollElement` 会在 `scrollElement.scrollTop` /
 * `getAttribute` 上炸。必须 `$el` + `data-slot` 双校验取真元素（等价 `MessageList.resolveViewportElement()`）。
 */
const viewportComponent = ref<InstanceType<typeof MessageScrollerViewport> | null>(null);
const viewportEl = ref<HTMLDivElement | null>(null);
function resolveViewportElement(): HTMLDivElement | null {
    const el = (viewportComponent.value as unknown as { $el?: unknown })?.$el;
    if (
        el instanceof HTMLDivElement &&
        el.getAttribute("data-slot") === "message-scroller-viewport"
    ) {
        return el;
    }
    return null;
}
watch(
    viewportComponent,
    () => {
        viewportEl.value = resolveViewportElement();
    },
    { flush: "post" },
);

const virtualizer = useVirtualizer<HTMLDivElement, HTMLElement>(
    computed(() => ({
        count: rows.value.length,
        getScrollElement: () => viewportEl.value,
        estimateSize: () => 80,
        overscan: 6,
        anchorTo: anchorTo,
        followOnAppend: followOnAppend,
        getItemKey: (index: number) => rows.value[index]?.id ?? index,
    })),
);

const virtualItems = computed(() => virtualizer.value.getVirtualItems());
const totalSize = computed(() => virtualizer.value.getTotalSize());

/** 图片行长高：只改**已挂载或将要挂载**的行，用来验证 `measureElement` 是否跟随。 */
async function growImageRows(): Promise<void> {
    if (!growImages) return;
    await new Promise((resolve) => setTimeout(resolve, 400));
    rows.value = rows.value.map((row) =>
        row.kind === "image" && !row.grown ? { ...row, height: 240, grown: true } : row,
    );
    await frames(3);
}

function frames(count: number): Promise<void> {
    return new Promise((resolve) => {
        let left = count;
        const tick = (): void => {
            left -= 1;
            if (left <= 0) resolve();
            else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    });
}

function viewportState() {
    const vp = viewportEl.value;
    const instance = virtualizer.value;
    return {
        rows: rows.value.length,
        totalSize: Math.round(instance.getTotalSize()),
        scrollTop: vp ? Math.round(vp.scrollTop) : -1,
        scrollHeight: vp ? Math.round(vp.scrollHeight) : -1,
        clientHeight: vp ? Math.round(vp.clientHeight) : -1,
        distanceToEnd: vp ? Math.round(vp.scrollHeight - vp.scrollTop - vp.clientHeight) : -1,
        renderedIndexes: instance.getVirtualItems().map((item) => item.index),
        firstRenderedRowId: rows.value[instance.getVirtualItems()[0]?.index ?? -1]?.id ?? null,
        scrollElementIsViewport: instance.scrollElement === vp && vp !== null,
        scrollElementSlot: instance.scrollElement?.getAttribute("data-slot") ?? null,
        viewportCount: document.querySelectorAll('[data-slot="message-scroller-viewport"]').length,
        itemStarts: instance
            .getVirtualItems()
            .slice(0, 3)
            .map((item) => ({
                index: item.index,
                start: Math.round(item.start),
                size: Math.round(item.size),
            })),
    };
}

function targetTop(id: string): number | null {
    const node = document.querySelector<HTMLElement>(`[data-poc-row="${id}"]`);
    return node ? node.getBoundingClientRect().top : null;
}

async function scrollToOffset(offset: number): Promise<void> {
    const vp = viewportEl.value;
    if (!vp) return;
    vp.scrollTop = offset;
    // 库通过 observeElementOffset 的 scroll 监听感知；派发一次保证同步。
    vp.dispatchEvent(new Event("scroll"));
    await frames(2);
}

async function scrollToIndex(index: number): Promise<void> {
    virtualizer.value.scrollToIndex(index, { align: "center" });
    await frames(3);
}

async function scrollToBottom(): Promise<void> {
    const vp = viewportEl.value;
    if (!vp) return;
    // 只写一次 scrollTop = scrollHeight 不够：库按**实测**总高算 max，估算→实测会让底部继续下移
    // （本轮实测差 558px），于是 isAtEnd() 又变假。这里按库自己的判据反复对齐，最多 8 次。
    for (let attempt = 0; attempt < 8; attempt += 1) {
        vp.scrollTop = vp.scrollHeight;
        vp.dispatchEvent(new Event("scroll"));
        await frames(2);
        virtualizer.value.measure();
        await frames(2);
        if (virtualizer.value.isAtEnd()) return;
    }
}

/** 库内部坐标：某 index 的布局起点（不要求该行已渲染）。 */
function itemOffset(index: number): number | null {
    const measurement = virtualizer.value.measurementsCache[index];
    return measurement ? Math.round(measurement.start) : null;
}

/**
 * 按**稳定 key** 取布局坐标。prepend 之后 index 会整体漂移（第 250 行变成第 220 行），
 * 用 index 当锚点会把"保位成功"算成失败（首版就踩了这个：算出 -2400px 的假偏差）。
 */
function itemOffsetOfId(id: string): number | null {
    const index = rows.value.findIndex((row) => row.id === id);
    return index < 0 ? null : itemOffset(index);
}

/** 调试读数：库自己认为的偏移/距底/是否贴底（判据要能对上库的口径，而不是我自己算的 DOM 数）。 */
function debug(): Record<string, unknown> {
    const instance = virtualizer.value;
    return {
        scrollOffset: Math.round(instance.scrollOffset ?? 0),
        distanceFromEnd: Math.round(instance.getDistanceFromEnd()),
        isAtEnd: instance.isAtEnd(),
        scrollEndThreshold: instance.options.scrollEndThreshold,
        anchorTo: instance.options.anchorTo,
        followOnAppend: instance.options.followOnAppend,
        totalSize: Math.round(instance.getTotalSize()),
    };
}

let prependSeq = 0,
    appendSeq = 0;

async function prepend(count: number): Promise<Record<string, number>> {
    const head = Array.from({ length: count }, () => makeRow(`pre-${prependSeq++}`, prependSeq));
    const before = viewportState();
    rows.value = [...head, ...rows.value];
    await nextTick();
    await frames(4);
    const after = viewportState();
    return {
        added: count,
        scrollTopBefore: before.scrollTop,
        scrollTopAfter: after.scrollTop,
        scrollHeightBefore: before.scrollHeight,
        scrollHeightAfter: after.scrollHeight,
        totalSizeBefore: before.totalSize,
        totalSizeAfter: after.totalSize,
    };
}

/** 流式追加：一条一条加，每次记录贴底距离（模拟 SSE 逐条到达）。 */
async function appendStream(count: number): Promise<Array<Record<string, number>>> {
    const snaps: Array<Record<string, number>> = [];
    for (let i = 0; i < count; i += 1) {
        rows.value = [...rows.value, makeRow(`app-${appendSeq++}`, appendSeq)];
        await nextTick();
        // 2 帧只够渲染；实测总高要在 measureElement/ResizeObserver 回来后才稳定 ⇒ 多等 2 帧。
        await frames(4);
        const state = viewportState();
        const library = debug();
        snaps.push({
            distanceToEnd: state.distanceToEnd,
            scrollTop: state.scrollTop,
            scrollHeight: state.scrollHeight,
            libraryDistanceFromEnd: Number(library.distanceFromEnd),
            libraryIsAtEnd: library.isAtEnd === true ? 1 : 0,
        });
    }
    return snaps;
}

const longTasks: Array<{ start: number; duration: number }> = [];
function observeLongTasks(): void {
    if (typeof PerformanceObserver === "undefined") return;
    try {
        new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                longTasks.push({
                    start: Math.round(entry.startTime),
                    duration: Math.round(entry.duration),
                });
            }
        }).observe({ type: "longtask", buffered: true });
    } catch {
        // 无 longtask 支持：其余指标照采（报告里 longTasks 恒 0）
    }
}

onMounted(() => {
    observeLongTasks();
    viewportEl.value = resolveViewportElement();
});

/** 动态高度证据：图片行 60px→240px 前后，库自己算出的总高。 */
const growth: { beforeGrow: number; afterGrow: number; grownRows: number } = {
    beforeGrow: 0,
    afterGrow: 0,
    grownRows: 0,
};

const readyPromise = (async () => {
    await nextTick();
    await frames(3);
    growth.beforeGrow = Math.round(virtualizer.value.getTotalSize());
    growth.grownRows = rows.value.filter((row) => row.kind === "image").length;
    // 长高由 driver 在"图片行确实在窗口里"时调用 growNow()，见 run-poc.mjs 风险②。
    return viewportState();
})();

declare global {
    interface Window {
        __poc?: Record<string, unknown>;
    }
}

window.__poc = {
    config: { initialRows, anchorTo, followOnAppend, autoScroll, growImages },
    ready: readyPromise,
    state: viewportState,
    targetTop,
    scrollToOffset,
    scrollToIndex,
    scrollToBottom,
    prepend,
    appendStream,
    growImageRows,
    frames,
    itemOffset,
    itemOffsetOfId,
    growNow: growImageRows,
    debug,
    growth: () => ({ ...growth }),
    longTasks: () => longTasks.slice(),
    rowsInfo: () => rows.value.map((row) => ({ id: row.id, height: row.height, kind: row.kind })),
    virtualItems: () =>
        virtualizer.value.getVirtualItems().map((item) => ({
            index: item.index,
            key: String(item.key),
            start: Math.round(item.start),
            size: Math.round(item.size),
        })),
};
</script>

<template>
    <MessageScrollerProvider
        :auto-scroll="autoScroll"
        default-scroll-position="end"
        :source-item-count="rows.length"
    >
        <MessageScroller class="h-full">
            <MessageScrollerViewport
                ref="viewportComponent"
                data-testid="poc-viewport"
                preserve-scroll-on-prepend
            >
                <MessageScrollerContent>
                    <!-- 与 MessageList 同构：一个固定高度容器 + 绝对定位行 -->
                    <div :style="{ height: `${totalSize}px`, position: 'relative', width: '100%' }">
                        <div
                            v-for="item in virtualItems"
                            :key="String(item.key)"
                            :data-index="item.index"
                            :data-poc-row="rows[item.index]?.id"
                            :ref="(el) => el && virtualizer.measureElement(el as HTMLElement)"
                            :style="{
                                position: 'absolute',
                                top: '0',
                                left: '0',
                                width: '100%',
                                transform: `translateY(${item.start}px)`,
                            }"
                        >
                            <MessageScrollerItem
                                :message-id="rows[item.index]?.id"
                                :style="{ height: `${rows[item.index]?.height ?? 0}px` }"
                            >
                                <div
                                    class="flex h-full items-start gap-2 overflow-hidden rounded-md border border-border bg-card px-3 py-2 text-xs"
                                >
                                    <span class="font-mono text-muted-foreground">
                                        #{{ item.index }} · {{ rows[item.index]?.id }}
                                    </span>
                                    <span class="text-muted-foreground">
                                        {{ rows[item.index]?.kind }} ·
                                        {{ rows[item.index]?.height }}px
                                    </span>
                                </div>
                            </MessageScrollerItem>
                        </div>
                    </div>
                </MessageScrollerContent>
            </MessageScrollerViewport>
        </MessageScroller>
    </MessageScrollerProvider>
</template>
