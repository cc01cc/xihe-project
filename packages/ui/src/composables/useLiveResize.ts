import { ref, type Ref } from "vue";

/**
 * PLAN-0626 follow-up (dock resize "one frame behind"): a pointer drag must not go
 * through Vue's reactive graph. Writing the width imperatively keeps the panel glued
 * to the pointer, while the store (and therefore persistence) is only touched once,
 * on pointer release.
 *
 * Rules encoded here:
 * - during the drag: `panel.style.width` + the bubble text are written directly, and
 *   NOTHING reactive changes (no re-render, so Vue cannot patch the width back to the
 *   last committed value);
 * - `resizingWidth` flips only at start/end, purely to toggle the bubble;
 * - on `mouseup`/`pointercancel` the final clamped width is committed exactly once;
 * - the `.is-resizing` class carries `will-change: width` and disables pointer events
 *   on descendants (no hit-testing churn inside the dragging panel).
 */
export interface LiveResizeOptions {
    /** Existing clamp for this panel; the drag must not invent new bounds. */
    clamp: (width: number) => number;
    /** Current committed width (read once, at drag start). */
    currentWidth: () => number;
    /** "right" = dragging right widens the panel (nav, file tree); "left" = the dock. */
    grow: "left" | "right";
    /** Single write back into the store, on release. */
    commit: (width: number) => void;
    /** The element whose width follows the pointer. */
    panel: Ref<HTMLElement | null>;
    /** Optional live width bubble; its text is written imperatively. */
    bubble?: Ref<HTMLElement | null>;
    /** Maps the panel width to the element's CSS width (nav adds its icon rail). */
    elementWidth?: (width: number) => number;
}

export function useLiveResize(options: LiveResizeOptions) {
    /** Only start/end values: it toggles the bubble and never tracks the pointer. */
    const resizingWidth = ref<number | null>(null);
    let liveWidth = 0;

    function applyWidth(width: number): void {
        liveWidth = width;
        const panel = options.panel.value;
        if (panel) {
            const cssWidth = options.elementWidth ? options.elementWidth(width) : width;
            panel.style.width = `${cssWidth}px`;
        }
        const bubble = options.bubble?.value;
        if (bubble) bubble.textContent = `${width}px`;
    }

    function detach(): void {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", finish);
        document.removeEventListener("pointerup", finish);
        document.removeEventListener("pointercancel", finish);
    }

    function onMove(event: MouseEvent): void {
        const delta = options.grow === "right" ? event.clientX - startX : startX - event.clientX;
        applyWidth(options.clamp(startWidth + delta));
    }

    function finish(): void {
        detach();
        // Commit and drop the bubble in the same tick: Vue batches both into one
        // render (new prop width + no bubble), so there is no frame showing the old
        // width, and the imperative width stays correct until that render lands.
        options.commit(liveWidth);
        resizingWidth.value = null;
    }

    let startX = 0;
    let startWidth = 0;

    function start(event: MouseEvent): void {
        event.preventDefault();
        startX = event.clientX;
        startWidth = options.currentWidth();
        applyWidth(startWidth);
        resizingWidth.value = startWidth;
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", finish);
        document.addEventListener("pointerup", finish);
        document.addEventListener("pointercancel", finish);
    }

    return { resizingWidth, start };
}
