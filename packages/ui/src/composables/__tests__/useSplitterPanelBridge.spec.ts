import { describe, expect, it, vi } from "vitest";
import { nextTick, ref, type Ref } from "vue";
import { mount, type VueWrapper } from "@vue/test-utils";
import { useSplitterPanelBridge, type SplitterPanelExposed } from "../useSplitterPanelBridge";

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
