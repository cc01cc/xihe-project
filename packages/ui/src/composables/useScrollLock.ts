/**
 * BL-477: counted body scroll lock for overlays that own their own DOM.
 *
 * `BaseModal` renders a plain `Teleport`ed card, so it has to lock the page itself.
 * Overlays built on reka's `Dialog` do **not** need it: reka-ui 2.11.0 ships
 * `dist/shared/useBodyScrollLock.js` (a shared per-layer stack) and `DialogOverlayImpl`
 * calls it, so any `<DialogContent>` that renders `<DialogOverlay>` already writes
 * `document.body.style.overflow = "hidden"` on open and restores it on close.
 *
 * Do **not** stack this lock on top of such a dialog: reka captures the current inline
 * value when it locks and re-applies it when the last reka layer resets, so a second,
 * earlier-restored lock leaves `overflow: hidden` behind after the dialog closes
 * (measured while wiring `AttachmentPreviewDialog`).
 *
 * The counter lives at **module scope**, not in the calling component: base modals can be
 * stacked, and the inner one closing must not unlock the page while the outer one is still
 * open. Only the outermost release restores the previous inline value verbatim (an empty
 * string is a real value here — writing `hidden` back over it would be a silent change).
 */

let lockCount = 0;
let restoreOverflow = "";

export interface ScrollLockHandle {
    /** Registers one open overlay and hides body overflow on the outer-most transition. */
    lock(): void;
    /** Releases one overlay; the original inline value comes back on the outermost release. */
    unlock(): void;
}

/**
 * Returns the shared lock handle. The state is module-wide on purpose (see file header), so
 * every caller gets the same counter regardless of component tree position.
 */
export function useScrollLock(): ScrollLockHandle {
    return {
        lock: lockBodyScroll,
        unlock: unlockBodyScroll,
    };
}

function lockBodyScroll(): void {
    if (lockCount === 0) {
        restoreOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
    }
    lockCount += 1;
}

function unlockBodyScroll(): void {
    if (lockCount === 0) return;
    lockCount -= 1;
    if (lockCount === 0) {
        document.body.style.overflow = restoreOverflow;
        restoreOverflow = "";
    }
}
