import { ref, watch, type Ref } from "vue";

/**
 * PLAN-0753 T3: integration layer between reka's Splitter primitives and our
 * hand-rolled resize contracts (PLAN-0626 one-frame-behind fix, PLAN-0582
 * persistence, DEV-011 keyboard discipline). reka owns the flex layout and the
 * pointer drag; this bridge keeps OUR invariants on top of it:
 *
 * - the store/persistence sees exactly one write: on pointer release (from
 *   getSize(), the ground truth), or immediately for keyboard/double-click
 *   (we know the width we requested);
 * - `@resize` events never commit by themselves - during a drag they only feed
 *   the imperative width bubble (no reactive write per pointer move), and
 *   constraint-driven re-inits stay display-only (clamps must not write back);
 * - keyboard keys are routed by the consumer (verbatim parity with the old
 *   handlers) through a capture-phase listener on the SplitterGroup ancestor;
 *   preventDefault stops reka's percent-based internal resize (ruling ①);
 * - collapse()/expand() bridge navOpen/navYielded-style state machines without
 *   touching min constraints (collapse may go below minSize by design);
 * - viewport changes re-issue resize(displayClamp(userWidth)) - ruling ③'s
 *   watcher - so a display clamp crossing never lands in the store.
 */
export interface SplitterPanelBridgeOptions {
    /** Stored-width clamp (rounds + bounds); applied to keyboard/dblclick/release. */
    clamp: (width: number) => number;
    /** Ground-truth committed width read for keyboard Home/End and watchers. */
    currentWidth: () => number;
    /** Store write: pointer release, keyboard and double-click only. */
    commit: (width: number) => void;
    /** Double-click reset target (stored width). */
    defaultWidth: number;
    /** Keyboard map: consumer returns the next stored width or null to ignore. */
    onKeyResize: (key: string) => number | null;
    /** Element px -> stored width (Sidebar adds a fixed icon rail). */
    toWidth?: (px: number) => number;
    /** Stored width -> element px. */
    toPx?: (width: number) => number;
    /** Display-only viewport clamp; its result never reaches commit. */
    displayResize?: (width: number, viewportWidth: number) => number;
    /** Viewport width source for the display-clamp watcher. */
    viewportWidth?: Ref<number>;
    /** Live width bubble; its text is written imperatively during drags. */
    bubble?: Ref<HTMLElement | null>;
    /** The resize handle id whose keys this bridge routes (fallthrough `id`). */
    handleId: string;
    /** Skip keyboard routing when the panel is collapsed (handle is v-if'd away). */
    isCollapsed?: () => boolean;
}

/** Exposed shape of reka's SplitterPanel (subset we drive). */
export interface SplitterPanelExposed {
    collapse: () => void;
    expand: () => void;
    resize: (size: number) => void;
    isCollapsed: () => boolean;
    isExpanded: () => boolean;
}

const RESIZE_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);

export function useSplitterPanelBridge(options: SplitterPanelBridgeOptions) {
    const panelRef = ref<SplitterPanelExposed | null>(null);
    /** Start/end only: toggles the bubble and is-resizing; never tracks the pointer. */
    const resizing = ref(false);
    let draggingActive = false;
    /** 本次拖拽中 reka 最后报出的元素像素宽（release 用它，不回读 getSize，见 onResize 注释）。 */
    let lastDragPx: number | null = null;

    function pxToWidth(px: number): number {
        return options.toWidth ? options.toWidth(px) : px;
    }

    function widthToPx(width: number): number {
        return options.toPx ? options.toPx(width) : width;
    }

    function onResize(px: number): void {
        if (!draggingActive) return;
        // reka 的 @resize 就是它自己对这一帧的最终像素值（size-unit="px" 时已经过约束夹取），
        // 因此 release 沿用它即可 —— 不再回读 getSize()。BL-562 的根因就在这里：
        // getSize() 会 assert(layout[panelIndex] != null)，而 reka 的 "drag 结束" 事件可以在
        // 「group 还没量到几何 / 布局尚未重算」的窗口里到达（实测：在 handle 命中区内按下即抬起、
        // 一次 resize 都没有，也会走 dragging(true) → dragging(false)），此时 layout 里没有该面板，
        // vendor 断言直接抛未捕获错误。用「本帧自己报的值」把这条依赖整段拿掉。
        lastDragPx = px;
        // Pointer path only: bubble imperative, no reactive write, no commit.
        const bubble = options.bubble?.value;
        if (bubble) bubble.textContent = `${pxToWidth(px)}px`;
    }

    function onDragging(active: boolean): void {
        if (active === draggingActive) return;
        draggingActive = active;
        resizing.value = active;
        if (active) {
            lastDragPx = null;
            return;
        }
        const bubble = options.bubble?.value;
        if (bubble) bubble.textContent = "";
        const reported = lastDragPx;
        lastDragPx = null;
        // 一次 resize 事件都没收到 ⇒ 这不是一次真实拖拽（命中区内按下即抬起，或几何还没量到）。
        // 没拖过就没有新宽度可写：既不读面板尺寸，也不写 store（写进去只会是脏值）。
        if (reported === null || options.isCollapsed?.()) return;
        // Release: one store write, same tick as the bubble drop so Vue batches
        // the render (useLiveResize release rule).
        options.commit(options.clamp(pxToWidth(reported)));
    }

    /**
     * Capture-phase listener for the SplitterGroup ancestor: preventDefault stops
     * reka's internal percent-based keyboard resize (its listener checks
     * defaultPrevented first), then we resize imperatively and commit immediately.
     */
    function onKeydownCapture(event: KeyboardEvent): void {
        if (event.defaultPrevented || !RESIZE_KEYS.has(event.key)) return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        const handle = target.closest("[data-panel-resize-handle-id]");
        if (!handle || handle.getAttribute("data-panel-resize-handle-id") !== options.handleId)
            return;
        if (options.isCollapsed?.()) return;
        const next = options.onKeyResize(event.key);
        if (next === null) return;
        event.preventDefault();
        const clamped = options.clamp(next);
        resizeToWidth(clamped);
        options.commit(clamped);
    }

    function resizeToWidth(width: number): void {
        panelRef.value?.resize(widthToPx(width));
    }

    function onDblclick(): void {
        if (options.isCollapsed?.()) return;
        const width = options.clamp(options.defaultWidth);
        resizeToWidth(width);
        options.commit(width);
    }

    function collapse(): void {
        panelRef.value?.collapse();
    }

    function expand(): void {
        panelRef.value?.expand();
    }

    // Destructured consts keep the narrowing valid inside the watcher callback: an
    // optional property of the options object is NOT narrowed for the closure.
    const { viewportWidth, displayResize } = options;
    if (viewportWidth && displayResize) {
        watch(viewportWidth, (vw) => {
            if (draggingActive || options.isCollapsed?.()) return;
            // Ruling ③: constraint/viewport crossings re-initialize defaultSize;
            // re-issue the user's width clamped for display, never committed.
            const display = displayResize(options.currentWidth(), vw);
            panelRef.value?.resize(widthToPx(display));
        });
    }

    return {
        panelRef,
        resizing,
        onResize,
        onDragging,
        onKeydownCapture,
        onDblclick,
        resizeToWidth,
        collapse,
        expand,
    };
}
