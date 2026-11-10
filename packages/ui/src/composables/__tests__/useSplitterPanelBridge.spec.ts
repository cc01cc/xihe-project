import { describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import { mount, type VueWrapper } from "@vue/test-utils";
import { useSplitterPanelBridge, type SplitterPanelExposed } from "../useSplitterPanelBridge";

// PLAN-0753 T3：桥接层把不变量（release 恰一次写 / 键盘纪律 / 夹取不写回 /
// collapse 桥接 / imperative bubble）压成可单测的机制。宿主按 AppLayout 的
// 即将形态接线：group 上 @keydown.capture，handle 用 fallthrough id。

type Panel = SplitterPanelExposed & {
    resize: ReturnType<typeof vi.fn>;
    collapse: ReturnType<typeof vi.fn>;
    expand: ReturnType<typeof vi.fn>;
    getSize: ReturnType<typeof vi.fn>;
};

function makePanel(size: number): Panel {
    let current = size;
    return {
        collapse: vi.fn<() => void>(),
        expand: vi.fn<() => void>(),
        getSize: vi.fn<() => number>(() => current),
        resize: vi.fn<(next: number) => void>((next: number) => {
            current = next;
        }),
        isCollapsed: vi.fn<() => boolean>(() => false),
        isExpanded: vi.fn<() => boolean>(() => true),
    };
}

function mountHost(opts: {
    width?: number;
    displayResize?: (width: number, viewportWidth: number) => number;
}) {
    const commits: number[] = [];
    const viewport = ref(opts.viewport ?? 1440);
    const currentWidth = ref(opts.width ?? 240);
    let panel!: Panel;
    let bridge!: ReturnType<typeof useSplitterPanelBridge>;
    const Host = {
        setup() {
            panel = makePanel(currentWidth.value + 56);
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
                toWidth: (px) => px - 56,
                toPx: (w) => w + 56,
                displayResize: opts.displayResize,
                viewportWidth: viewport,
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
    it("commits exactly once on pointer release from getSize; drag resize events never commit", () => {
        const host = mountHost({ width: 280 });
        host.bridge.onDragging(true);
        host.bridge.onResize(300 + 56); // mid-drag: bubble feed only
        host.bridge.onResize(320 + 56);
        expect(host.commits).toEqual([]);
        // reka applied the drag to its own layout: getSize() is the ground truth.
        host.panel.getSize.mockReturnValue(320 + 56);
        host.bridge.onDragging(false);
        expect(host.commits).toEqual([320]); // toWidth(376) = 320; clamp no-op
        expect(host.panel.getSize).toHaveBeenCalled();
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
