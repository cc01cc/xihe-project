import { onBeforeUnmount, onMounted } from "vue";

/** The keyboard counts as open once the visual viewport loses this many CSS pixels. */
const KEYBOARD_HEIGHT_THRESHOLD = 150;
const BOTTOM_INSET_VAR = "--mobile-safe-area-inset-bottom";

/**
 * PLAN-0702 / BL-327: keep the mobile composer above the on-screen keyboard.
 *
 * iOS Safari / Android Chrome shrink `window.visualViewport` when the keyboard opens while
 * `env(safe-area-inset-bottom)` still reports the home-indicator inset. In that state the bottom
 * inset would double-count, so the bottom var is overridden to 0px and restored from the
 * stylesheet value when the keyboard closes. No `interactive-widget` viewport flag is used
 * (it is a known iOS PWA anti-pattern and would fight the app's own layout).
 */
export function useMobileSafeArea(): void {
    let frame = 0;

    const apply = (): void => {
        frame = 0;
        const viewport = window.visualViewport;
        if (!viewport) return;
        const root = document.documentElement;
        const keyboardOpen = viewport.height < window.innerHeight - KEYBOARD_HEIGHT_THRESHOLD;
        if (keyboardOpen) {
            root.style.setProperty(BOTTOM_INSET_VAR, "0px");
        } else {
            root.style.removeProperty(BOTTOM_INSET_VAR);
        }
    };

    const schedule = (): void => {
        if (frame !== 0) return;
        frame = window.requestAnimationFrame(apply);
    };

    onMounted(() => {
        const viewport = window.visualViewport;
        if (!viewport) return;
        viewport.addEventListener("resize", schedule);
        viewport.addEventListener("scroll", schedule);
        apply();
    });

    onBeforeUnmount(() => {
        const viewport = window.visualViewport;
        if (frame !== 0) window.cancelAnimationFrame(frame);
        if (!viewport) return;
        viewport.removeEventListener("resize", schedule);
        viewport.removeEventListener("scroll", schedule);
    });
}
