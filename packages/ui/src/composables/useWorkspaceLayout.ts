import { computed, ref, watch, type Ref } from "vue";
import { logger } from "../lib/logger";

/**
 * PLAN-0582 S1: the only writer of the application-level layout geometry
 * (icon rail + navigation panel). Values live in one global localStorage key so
 * every route of this browser tab shares them; per-workspace layout keys are
 * reserved for the later workbench batches (file tree / dock) and share the
 * `xihe-layout-ws:` prefix cleared on logout.
 */
export const GLOBAL_LAYOUT_STORAGE_KEY = "xihe-layout-global";
export const WORKSPACE_LAYOUT_STORAGE_PREFIX = "xihe-layout-ws:";

/** Icon rail: fixed at two presets (icon-only vs icon + label). */
export const RAIL_WIDTH_COLLAPSED = 48;
export const RAIL_WIDTH_EXPANDED = 176;
/** Navigation panel (design L7: default 280, range 220-360). */
export const NAV_WIDTH_DEFAULT = 280;
export const NAV_WIDTH_MIN = 220;
export const NAV_WIDTH_MAX = 360;
export const NAV_WIDTH_KEYBOARD_STEP = 16;

export interface GlobalLayoutState {
    railCollapsed: boolean;
    navOpen: boolean;
    navWidth: number;
}

function storage(): Storage | null {
    try {
        return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
        return null;
    }
}

export function clampNavWidth(width: number): number {
    if (!Number.isFinite(width)) return NAV_WIDTH_DEFAULT;
    return Math.min(NAV_WIDTH_MAX, Math.max(NAV_WIDTH_MIN, Math.round(width)));
}

export function defaultGlobalLayout(): GlobalLayoutState {
    return { railCollapsed: true, navOpen: true, navWidth: NAV_WIDTH_DEFAULT };
}

export function readGlobalLayout(): GlobalLayoutState {
    const defaults = defaultGlobalLayout(),
        store = storage();
    if (!store) return defaults;
    try {
        const raw = store.getItem(GLOBAL_LAYOUT_STORAGE_KEY);
        if (!raw) return defaults;
        const parsed = JSON.parse(raw) as Partial<GlobalLayoutState> | null;
        if (!parsed || typeof parsed !== "object") return defaults;
        return {
            railCollapsed:
                typeof parsed.railCollapsed === "boolean"
                    ? parsed.railCollapsed
                    : defaults.railCollapsed,
            navOpen: typeof parsed.navOpen === "boolean" ? parsed.navOpen : defaults.navOpen,
            navWidth:
                typeof parsed.navWidth === "number"
                    ? clampNavWidth(parsed.navWidth)
                    : defaults.navWidth,
        };
    } catch (cause) {
        // Corrupted or foreign payload: drop it instead of keeping a layout that
        // cannot be rendered, and keep the failure observable.
        logger.warn("Failed to read the global layout, falling back to defaults", cause);
        store.removeItem(GLOBAL_LAYOUT_STORAGE_KEY);
        return defaults;
    }
}

export function writeGlobalLayout(state: GlobalLayoutState): void {
    const store = storage();
    if (!store) return;
    try {
        store.setItem(
            GLOBAL_LAYOUT_STORAGE_KEY,
            JSON.stringify({
                railCollapsed: state.railCollapsed,
                navOpen: state.navOpen,
                navWidth: clampNavWidth(state.navWidth),
            }),
        );
    } catch (cause) {
        logger.warn("Failed to persist the global layout", cause);
    }
}

/**
 * Logout / user switch: the layout is user-scoped state, so the next account in
 * this browser must not inherit the previous account's collapse state or
 * widths (PLAN-0582 V10).
 */
export function clearLayoutStorage(): void {
    const store = storage();
    if (!store) return;
    try {
        store.removeItem(GLOBAL_LAYOUT_STORAGE_KEY);
        const staleKeys: string[] = [];
        for (let index = 0; index < store.length; index += 1) {
            const key = store.key(index);
            if (key?.startsWith(WORKSPACE_LAYOUT_STORAGE_PREFIX)) staleKeys.push(key);
        }
        for (const key of staleKeys) store.removeItem(key);
    } catch (cause) {
        logger.warn("Failed to clear the layout storage", cause);
    }
}

export interface WorkspaceLayoutOptions {
    /** The mobile sheet is a transient overlay and must not persist as desktop layout. */
    isMobile: Ref<boolean>;
}

export function useWorkspaceLayout(options: WorkspaceLayoutOptions) {
    const stored = readGlobalLayout(),
        railCollapsed = ref(stored.railCollapsed),
        navWidth = ref(stored.navWidth),
        navOpen = ref(options.isMobile.value ? false : stored.navOpen);

    const railWidth = computed(() =>
            railCollapsed.value ? RAIL_WIDTH_COLLAPSED : RAIL_WIDTH_EXPANDED,
        ),
        navPanelWidth = computed(() => (navOpen.value ? navWidth.value : 0)),
        mainOffset = computed(() =>
            options.isMobile.value ? 0 : railWidth.value + navPanelWidth.value,
        );

    function persist(): void {
        if (options.isMobile.value) return;
        writeGlobalLayout({
            railCollapsed: railCollapsed.value,
            navOpen: navOpen.value,
            navWidth: navWidth.value,
        });
    }

    watch([railCollapsed, navOpen, navWidth], () => persist());

    function toggleRail(): void {
        railCollapsed.value = !railCollapsed.value;
    }

    function setRailCollapsed(collapsed: boolean): void {
        railCollapsed.value = collapsed;
    }

    function toggleNav(): void {
        navOpen.value = !navOpen.value;
    }

    function setNavOpen(open: boolean): void {
        navOpen.value = open;
    }

    function setNavWidth(width: number): void {
        navWidth.value = clampNavWidth(width);
    }

    function nudgeNavWidth(delta: number): void {
        setNavWidth(navWidth.value + delta);
    }

    function resetNavWidth(): void {
        setNavWidth(NAV_WIDTH_DEFAULT);
    }

    return {
        railCollapsed,
        navOpen,
        navWidth,
        railWidth,
        navPanelWidth,
        mainOffset,
        toggleRail,
        setRailCollapsed,
        toggleNav,
        setNavOpen,
        setNavWidth,
        nudgeNavWidth,
        resetNavWidth,
    };
}
