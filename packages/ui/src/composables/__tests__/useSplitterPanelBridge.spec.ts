import { describe, expect, it, vi } from "vitest";
import { nextTick, ref, type Ref } from "vue";
import { mount, type VueWrapper } from "@vue/test-utils";
import { useSplitterPanelBridge, type SplitterPanelExposed } from "../useSplitterPanelBridge";
import { logger } from "../../lib/logger";

// PLAN-0753 T3：桥接层把不变量（release 恰一次写 / 键盘纪律 / 夹取不写回 /
// collapse 桥接 / imperative bubble）压成可单测的机制。宿主按 AppLayout 的
// 即将形态接线：group 上 @keydown.capture，handle 用 fallthrough id。

type Panel = SplitterPanelExposed & {
    resize: ReturnType<typeof vi.fn>;
    collapse: ReturnType<typeof vi.fn>;
    expand: ReturnType<typeof vi.fn>;
};

function makePanel(): Panel {
    return {
        collapse: vi.fn<() => void>(),
        expand: vi.fn<() => void>(),
        resize: vi.fn<(next: number) => void>(),
        isCollapsed: vi.fn<() => boolean>(() => false),
        isExpanded: vi.fn<() => boolean>(() => true),
    };
}

function mountHost(opts: {
    width?: number;
    viewport?: number;
    displayResize?: (width: number, viewportWidth: number) => number;
    /** task-94 (B)：给了就按百分比组接线（reka 收/发 %，store 仍是 px）。 */
    percentGroup?: Ref<number>;
    /** 关掉 Sidebar 的图标 rail 换算（+56px），让 px/percent 断言保持直观。 */
    identityWidths?: boolean;
    /**
     * 是否模拟「layout 已就绪」。默认 true —— 真实的 reka 面板在 layout 初始化后**必发一次
     * `@resize`**（`utils/callPanelCallbacks.js:14-17`，`lastNotifiedSize == null` 时必调），
     * 所以挂载完成后桥接层本来就该是就绪态。测「未就绪窗口」时传 false。
     */
    ready?: boolean;
}) {
    const commits: number[] = [];
    const viewport = ref(opts.viewport ?? 1440);
    const currentWidth = ref(opts.width ?? 240);
    let panel!: Panel;
    let bridge!: ReturnType<typeof useSplitterPanelBridge>;
    const Host = {
        setup() {
            panel = makePanel();
            bridge = useSplitterPanelBridge({
                clamp: (w) => Math.max(220, Math.min(360, Math.round(w))),
                currentWidth: () => currentWidth.value,
                commit: (w) => {
                    currentWidth.value = w;
                    commits.push(w);
                },
                defaultWidth: 280,
                onKeyResize: (key) => {
                    if (key === "ArrowRight") return currentWidth.value + 16;
                    if (key === "ArrowLeft") return currentWidth.value - 16;
                    if (key === "Home") return 220;
                    if (key === "End") return 360;
                    return null;
                },
                toWidth: opts.identityWidths ? undefined : (px) => px - 56,
                toPx: opts.identityWidths ? undefined : (w) => w + 56,
                displayResize: opts.displayResize,
                viewportWidth: viewport,
                sizeUnit: opts.percentGroup
                    ? {
                          // 组宽为 0（还没量到几何）时按 1000 折算，绝不产生 NaN/Infinity。
                          toPx: (percent) => (percent / 100) * (opts.percentGroup?.value || 1000),
                          fromPx: (px) => (px / (opts.percentGroup?.value || 1000)) * 100,
                      }
                    : undefined,
                handleId: "nav-resize-handle",
            });
            bridge.panelRef.value = panel;
            if (opts.ready !== false) bridge.onResize(0); // 首帧 @resize：只置就绪，不产生副作用
            return { bridge };
        },
        template: `<div data-testid="group" @keydown.capture="bridge.onKeydownCapture">
            <div data-panel-resize-handle-id="nav-resize-handle" data-testid="handle" tabindex="0"></div>
        </div>`,
    };
    return { wrapper: mount(Host), commits, panel, bridge, viewport };
}

function press(wrapper: VueWrapper, key: string, target?: Element): KeyboardEvent {
    const el = target ?? wrapper.find('[data-testid="handle"]').element;
    const evt = new KeyboardEvent("keydown", { key: key, bubbles: true, cancelable: true });
    el.dispatchEvent(evt);
    return evt;
}

describe("useSplitterPanelBridge (PLAN-0753 T3)", () => {
    it("commits exactly once on release using the last reka-reported size; drag events never commit", () => {
        const host = mountHost({ width: 280 });
        host.bridge.onDragging(true);
        host.bridge.onResize(300 + 56); // mid-drag: bubble feed only
        host.bridge.onResize(320 + 56);
        expect(host.commits).toEqual([]);
        // BL-562：release 不再回读 panel.getSize() —— reka 的 @resize 就是它自己这一帧的
        // 最终像素值（px 单位下已过约束夹取），沿用即可，且不会踩 vendor 的 layout 断言。
        host.bridge.onDragging(false);
        expect(host.commits).toEqual([320]); // toWidth(376) = 320; clamp no-op
        expect(host.bridge.resizing.value).toBe(false);
    });

    it("commits nothing when the drag ends without a single resize event (BL-562)", () => {
        // 实测形态：在 handle 命中区内 pointerdown 后立刻 pointerup（一次 resize 都没有），
        // 或 group 尚未量到几何 —— reka 照样发 dragging(true) → dragging(false)。
        // 旧实现会在这一下回读 getSize()，reka 抛 "Panel size not found" 未捕获错误，
        // 且会把面板当前宽度当新宽度写回 store。现在既不读也不写。
        const host = mountHost({ width: 280 });
        host.bridge.onDragging(true);
        host.bridge.onDragging(false);
        expect(host.commits).toEqual([]);
        expect(host.panel.resize).not.toHaveBeenCalled();
        expect(host.bridge.resizing.value).toBe(false);
    });

    it("routes handle-scoped capture keys, prevents the library handler, commits immediately", () => {
        const host = mountHost({ width: 280 });
        const evt = press(host.wrapper, "ArrowRight");
        expect(evt.defaultPrevented).toBe(true);
        expect(host.panel.resize).toHaveBeenCalledWith(296 + 56); // toPx(280+16)
        expect(host.commits).toEqual([296]);
    });

    it("ignores keys from foreign targets and non-resize keys", () => {
        const host = mountHost({ width: 280 });
        const stranger = document.createElement("button");
        host.wrapper.find('[data-testid="group"]').element.appendChild(stranger);
        const foreign = press(host.wrapper, "ArrowRight", stranger);
        const other = press(host.wrapper, "PageDown");
        expect(foreign.defaultPrevented).toBe(false);
        expect(other.defaultPrevented).toBe(false);
        expect(host.panel.resize).not.toHaveBeenCalled();
        expect(host.commits).toEqual([]);
    });

    it("resets to the clamped default width on double-click and commits once", () => {
        const host = mountHost({ width: 340 });
        host.bridge.onDblclick();
        expect(host.panel.resize).toHaveBeenCalledWith(280 + 56);
        expect(host.commits).toEqual([280]);
    });

    it("collapse() and expand() never touch commit (open state is a separate store field)", () => {
        const host = mountHost({});
        host.bridge.collapse();
        host.bridge.expand();
        expect(host.panel.collapse).toHaveBeenCalled();
        expect(host.panel.expand).toHaveBeenCalled();
        expect(host.commits).toEqual([]);
    });

    it("viewport crossing re-issues the display-clamped width without writing the store", async () => {
        const host = mountHost({
            width: 330,
            displayResize: (w, vw) => (vw < 1280 ? Math.min(w, 240) : w),
        });
        host.viewport.value = 1200;
        await nextTick();
        expect(host.panel.resize).toHaveBeenCalledWith(240 + 56); // display clamp, element px
        expect(host.commits).toEqual([]); // clamp is display-only
    });
});

/**
 * task-94 (B)：内层 group 从 px 尺寸改成百分比尺寸（让 reka 的 layout 一定能初始化），
 * 但**持久化语义仍是 px** —— 换算压在这一层，下面 4 条把这个契约钉住。
 */
describe("useSplitterPanelBridge — 百分比组（task-94 / B）", () => {
    it("reka 报出的百分比按组宽折成 px 再提交（release 仍只写一次）", () => {
        const groupWidth = ref(1200);
        const host = mountHost({ width: 240, percentGroup: groupWidth, identityWidths: true });
        host.bridge.onDragging(true);
        host.bridge.onResize(20); // 20% of 1200 = 240px
        host.bridge.onResize(25); // 25% of 1200 = 300px
        expect(host.commits).toEqual([]);
        host.bridge.onDragging(false);
        expect(host.commits).toEqual([300]); // store 收到 px，不是 25
    });

    it("键盘/双击写回 reka 的是百分比，写进 store 的是 px", () => {
        const groupWidth = ref(1200);
        const host = mountHost({ width: 240, percentGroup: groupWidth, identityWidths: true });
        press(host.wrapper, "End"); // 360px -> 30%
        expect(host.panel.resize).toHaveBeenCalledWith(30);
        expect(host.commits).toEqual([360]);
    });

    it("一次 resize 都没收到就不提交（BL-562 的负例在百分比组同样成立）", () => {
        const groupWidth = ref(1200);
        const host = mountHost({ width: 240, percentGroup: groupWidth, identityWidths: true });
        host.bridge.onDragging(true);
        host.bridge.onDragging(false);
        expect(host.commits).toEqual([]);
        expect(host.panel.resize).not.toHaveBeenCalled();
    });

    it("组还没量到几何（宽 0）时不产生 NaN/Infinity，也照常提交有限值", () => {
        const groupWidth = ref(0);
        const host = mountHost({ width: 240, percentGroup: groupWidth, identityWidths: true });
        host.bridge.onDragging(true);
        host.bridge.onResize(20); // 20% of fallback 1000 = 200px
        host.bridge.onDragging(false);
        expect(host.commits).toEqual([220]); // clamp(200) -> 220（min 220）
        host.bridge.onDblclick();
        const written = host.panel.resize.mock.calls.at(-1)?.[0] ?? Number.NaN;
        expect(Number.isFinite(written)).toBe(true);
    });
});

/**
 * task-51（D-1442 / 方案 A）：**layout 就绪前的命令式 resize 必须排队**。
 *
 * 背景：`SplitterPanel.resize()` 在 layout 未初始化时走 `SplitterGroup.js:315-316` 的
 * `assert(panelSize != null)` 硬抛；Workbench 在 `:ref` 投递后的 nextTick 里调它 ⇒ 3 条
 * 未处理的 Promise rejection（spec 全绿但 vitest exit 1）。
 *
 * 这两条计数是**不同语义**，不许合并：
 * - `coalesced` = 排队值被新值取代（**正常**：viewport 连续变化就会发生）；
 * - `dropped` = 意图消失（异常：卸载时仍有排队 / 面板引用已释放），**正常路径恒 0**。
 */
describe("useSplitterPanelBridge — layout 就绪前排队（task-51 / A）", () => {
    it("未就绪时 resizeToWidth 不碰 reka，也不记任何丢弃", () => {
        const host = mountHost({ width: 240, identityWidths: true, ready: false });
        host.bridge.resizeToWidth(300);
        expect(host.panel.resize).not.toHaveBeenCalled();
        expect(host.bridge.dropped.value).toBe(0);
        expect(host.bridge.coalesced.value).toBe(0);
    });

    it("首帧 @resize 到达后补发恰好一次，且用的是排队那笔宽度", () => {
        const host = mountHost({ width: 240, identityWidths: true, ready: false });
        host.bridge.resizeToWidth(300);
        host.bridge.onResize(20); // reka 的 layout 初始化信号
        expect(host.panel.resize).toHaveBeenCalledTimes(1);
        expect(host.panel.resize).toHaveBeenCalledWith(300);
        // 就绪之后恢复直通，不再排队
        host.bridge.resizeToWidth(320);
        expect(host.panel.resize).toHaveBeenCalledTimes(2);
        expect(host.panel.resize).toHaveBeenLastCalledWith(320);
    });

    it("未就绪期间连续两次 ⇒ 合并计 1、丢弃仍 0，补发只发最后一次", () => {
        const host = mountHost({ width: 240, identityWidths: true, ready: false });
        host.bridge.resizeToWidth(300);
        host.bridge.resizeToWidth(320);
        expect(host.bridge.coalesced.value).toBe(1);
        expect(host.bridge.dropped.value).toBe(0);
        expect(host.panel.resize).not.toHaveBeenCalled();
        host.bridge.onResize(20);
        expect(host.panel.resize).toHaveBeenCalledTimes(1);
        expect(host.panel.resize).toHaveBeenCalledWith(320);
    });

    it("layout 始终没就绪 ⇒ 卸载时记 1 次丢弃并 warn 一次（不静默）", () => {
        const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
        try {
            const host = mountHost({ width: 240, identityWidths: true, ready: false });
            host.bridge.resizeToWidth(300);
            expect(host.panel.resize).not.toHaveBeenCalled();
            host.wrapper.unmount();
            expect(host.bridge.dropped.value).toBe(1);
            expect(warn).toHaveBeenCalledTimes(1);
            expect(String(warn.mock.calls[0]?.[0])).toContain("layout 始终未就绪");
        } finally {
            warn.mockRestore();
        }
    });
});
/**
 * task-147（P0）：**collapse()/expand() 与 resizeToWidth() 同口径 gate `layoutReady`**。
 *
 * 崩栈（实测 1280/1440/1455 崩、1460 不崩）：
 * ```
 * assert(panelSize != null) ← SplitterGroup.js:383 collapsePanel
 *                          ← UseSplitterPanelBridge collapse()
 *                          ← AppLayout.vue watch(navPanelCollapsed) (flush: "post")
 * ```
 * 下面把三件事钉住：①就绪前三条入口一律只排队、不碰 reka；②就绪后**按调用顺序**重放
 * （宽度可合并、状态转移不可合并）；③排队不是吞掉 —— 返回值 / pendingCount 让调用方
 * 分得清「已生效」与「已排队」，卸载仍有排队时按笔数记 dropped。
 */
describe("useSplitterPanelBridge — collapse/expand 也要 gate layoutReady（task-147）", () => {
    it("就绪前 collapse/expand 一律不碰 reka：返回 false、排队计数、零丢弃", () => {
        const host = mountHost({ width: 240, identityWidths: true, ready: false });
        expect(host.bridge.collapse()).toBe(false);
        expect(host.bridge.expand()).toBe(false);
        expect(host.bridge.collapse()).toBe(false);
        expect(host.panel.collapse).not.toHaveBeenCalled();
        expect(host.panel.expand).not.toHaveBeenCalled();
        // 排队不是吞掉：意图都在队列里，且没有被记成丢弃。
        expect(host.bridge.pendingCount.value).toBe(3);
        expect(host.bridge.dropped.value).toBe(0);
        expect(host.bridge.layoutReady.value).toBe(false);
    });

    it("首帧 @resize 到达后按调用顺序重放（expand 在 resize 之前，宽度用排队值）", () => {
        const host = mountHost({ width: 240, identityWidths: true, ready: false });
        // AppLayout.vue:171-185 的真实顺序：展开后同拍再夹一次显示宽度。
        host.bridge.expand();
        host.bridge.resizeToWidth(260);
        expect(host.bridge.pendingCount.value).toBe(2);

        host.bridge.onResize(20); // reka 的 layout 初始化信号

        expect(host.panel.expand).toHaveBeenCalledTimes(1);
        expect(host.panel.resize).toHaveBeenCalledTimes(1);
        expect(host.panel.resize).toHaveBeenCalledWith(260);
        // 顺序是语义：expand 会用 panelSizeBeforeCollapse 覆盖布局，排在 resize 之后就会
        // 把那笔宽度冲掉（见 useSplitterPanelBridge 的 enqueue 注释）。
        expect(host.panel.expand.mock.invocationCallOrder[0]).toBeLessThan(
            host.panel.resize.mock.invocationCallOrder[0] as number,
        );
        expect(host.bridge.pendingCount.value).toBe(0);
        expect(host.bridge.layoutReady.value).toBe(true);
        expect(host.bridge.dropped.value).toBe(0);
    });

    it("状态转移不合并：collapse→expand→collapse 三笔 1:1 重放，最终态不翻转", () => {
        const host = mountHost({ width: 240, identityWidths: true, ready: false });
        host.bridge.collapse();
        host.bridge.expand();
        host.bridge.collapse();
        // 宽度那套「后写覆盖」不能套到状态上：合并成「最后一笔」会把中间那次 expand 抹掉，
        // 而它决定了 panelSizeBeforeCollapse 的记账与后续宽度的生效顺序。
        expect(host.bridge.coalesced.value).toBe(0);
        expect(host.bridge.pendingCount.value).toBe(3);

        host.bridge.onResize(20);

        expect(host.panel.collapse).toHaveBeenCalledTimes(2);
        expect(host.panel.expand).toHaveBeenCalledTimes(1);
        const order = [
            ...host.panel.collapse.mock.invocationCallOrder.map(
                (n, i) => ["collapse", n, i] as const,
            ),
            ...host.panel.expand.mock.invocationCallOrder.map((n, i) => ["expand", n, i] as const),
        ]
            .sort((a, b) => a[1] - b[1])
            .map(([kind]) => kind);
        expect(order).toEqual(["collapse", "expand", "collapse"]);
        expect(host.bridge.pendingCount.value).toBe(0);
    });

    it("宽度只在**相邻同类型**时合并；被状态转移隔开的两笔都保留", () => {
        const host = mountHost({ width: 240, identityWidths: true, ready: false });
        host.bridge.resizeToWidth(300);
        host.bridge.collapse();
        host.bridge.resizeToWidth(320);
        expect(host.bridge.coalesced.value).toBe(0); // 隔着一次转移 ⇒ 不合并
        expect(host.bridge.pendingCount.value).toBe(3);

        host.bridge.onResize(20);

        expect(host.panel.resize.mock.calls.map((call) => call[0])).toEqual([300, 320]);
        expect(host.panel.collapse).toHaveBeenCalledTimes(1);
        // 相对位置也保住了：300 在 collapse 之前、320 在之后。
        const order = [
            ["resize300", host.panel.resize.mock.invocationCallOrder[0] as number],
            ["collapse", host.panel.collapse.mock.invocationCallOrder[0] as number],
            ["resize320", host.panel.resize.mock.invocationCallOrder[1] as number],
        ]
            .sort((left, right) => left[1] - right[1])
            .map(([label]) => label);
        expect(order).toEqual(["resize300", "collapse", "resize320"]);
    });

    it("就绪后三条入口直通 reka 并返回 true（不是排队）", () => {
        const host = mountHost({ width: 240, identityWidths: true });
        expect(host.bridge.collapse()).toBe(true);
        expect(host.bridge.expand()).toBe(true);
        expect(host.bridge.resizeToWidth(300)).toBe(true);
        expect(host.panel.collapse).toHaveBeenCalledTimes(1);
        expect(host.panel.expand).toHaveBeenCalledTimes(1);
        expect(host.panel.resize).toHaveBeenCalledWith(300);
        expect(host.bridge.pendingCount.value).toBe(0);
    });

    it("layout 始终没就绪 ⇒ 卸载时按**笔数**记丢弃，warn 只出一条（不静默）", () => {
        const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
        try {
            const host = mountHost({ width: 240, identityWidths: true, ready: false });
            host.bridge.collapse();
            host.bridge.expand();
            host.bridge.resizeToWidth(300);
            expect(host.panel.collapse).not.toHaveBeenCalled();
            host.wrapper.unmount();
            expect(host.bridge.dropped.value).toBe(3);
            expect(host.bridge.pendingCount.value).toBe(0);
            expect(warn).toHaveBeenCalledTimes(1);
            expect(String(warn.mock.calls[0]?.[0])).toContain("layout 始终未就绪");
        } finally {
            warn.mockRestore();
        }
    });
});
