import { computed, ref, watch, type Ref } from "vue";
import { logger } from "../lib/logger";

/**
 * PLAN-0582 layout owner: the single writer for the application-level geometry
 * (icon rail + navigation panel) and for the per-workspace workbench geometry
 * (file tree + right dock).
 *
 * S2 (user rulings 2026-10-31):
 * - the icon rail is a fixed 56px icon-only strip; the 48<->176 dual state is gone;
 * - the workspace entry lives only in the navigation panel head, not in the rail;
 * - the right dock defaults to collapsed and is 320-480 wide (360 default);
 * - below 1800px the dock is an absolutely positioned overlay instead of a flex
 *   child (56 rail + 280 panel + 240 tree + 360 dock + 864 main = 1800), so it can
 *   never squeeze the main column below its 640px floor.
 */
export const GLOBAL_LAYOUT_STORAGE_KEY = "xihe-layout-global";
export const WORKSPACE_LAYOUT_STORAGE_PREFIX = "xihe-layout-ws:";

/** Icon rail: fixed width, icon-only (ruling #1). */
export const RAIL_WIDTH = 56;
/** Navigation panel (default 280, range 220-360). */
export const NAV_WIDTH_DEFAULT = 280;
export const NAV_WIDTH_MIN = 220;
export const NAV_WIDTH_MAX = 360;
export const NAV_WIDTH_KEYBOARD_STEP = 16;

/** Workbench file tree column (S3 owns its drag range; S2 keeps it fixed). */
export const TREE_WIDTH_DEFAULT = 240;
export const TREE_COLLAPSED_WIDTH = 40;

/** Right dock (ruling #3: default closed, 320-480, 360 default). */
export const DOCK_WIDTH_DEFAULT = 360;
export const DOCK_WIDTH_MIN = 320;
export const DOCK_WIDTH_MAX = 480;
export const DOCK_WIDTH_KEYBOARD_STEP = 16;
export const DOCK_MAX_TABS = 6;
/** The dock only joins the flex layout from this width up; below it, it overlays. */
export const DOCK_INLINE_MIN_VIEWPORT = 1800;

/** Dock tabs that have a panel implementation today (S3 adds `context`/`approval`). */
export const DOCK_TAB_IDS = ["code", "changes", "monitor"] as const;
export type DockTabId = (typeof DOCK_TAB_IDS)[number];

/**
 * PLAN-0582 S3a: the middle route tab bar is a pure projection of the existing
 * routes (`/workspace/:ws`, `/chat/:sid`, `/environment`, `/scheduled-tasks`,
 * `/settings`) — no new routes. `chat` is always open (it is the fallback), the
 * other three are an "open set" persisted per workspace.
 */
export const WORKSPACE_TAB_IDS = ["environment", "scheduled-tasks", "settings"] as const;
export type WorkspaceTabId = (typeof WORKSPACE_TAB_IDS)[number];

export interface GlobalLayoutState {
    navOpen: boolean;
    navWidth: number;
}

export interface WorkspaceLayoutState {
    treeCollapsed: boolean;
    dockCollapsed: boolean;
    dockWidth: number;
    dockTabs: DockTabId[];
    activeDockTab: DockTabId | null;
    /** Route tabs opened by the user (the chat tab is implicit and not stored). */
    openTabs: WorkspaceTabId[];
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

export function clampDockWidth(width: number): number {
    if (!Number.isFinite(width)) return DOCK_WIDTH_DEFAULT;
    return Math.min(DOCK_WIDTH_MAX, Math.max(DOCK_WIDTH_MIN, Math.round(width)));
}

export function isDockTabId(value: unknown): value is DockTabId {
    return typeof value === "string" && (DOCK_TAB_IDS as readonly string[]).includes(value);
}

/**
 * P1-4 (S2 audit): the navigation panel width is clamped per breakpoint for
 * rendering only — the user's stored value is never rewritten, so going back to a
 * wide window restores it (spec §1.5 A).
 */
export function clampNavWidthForViewport(width: number, viewportWidth: number): number {
    if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return clampNavWidth(width);
    const breakpointMax = viewportWidth < 1280 ? 240 : viewportWidth < 1440 ? 260 : NAV_WIDTH_MAX;
    return Math.min(clampNavWidth(width), breakpointMax);
}

/** P1-1 (S2 audit): a workspace with no stored layout opens the monitor on wide screens. */
export function hasWorkspaceLayout(workspaceId: string): boolean {
    const store = storage();
    if (!workspaceId || !store) return false;
    return store.getItem(workspaceLayoutKey(workspaceId)) !== null;
}

export function defaultWorkspaceLayoutForViewport(viewportWidth: number): WorkspaceLayoutState {
    const defaults = defaultWorkspaceLayout();
    if (Number.isFinite(viewportWidth) && viewportWidth >= DOCK_INLINE_MIN_VIEWPORT) {
        return {
            ...defaults,
            dockCollapsed: false,
            dockTabs: ["monitor"],
            activeDockTab: "monitor",
        };
    }
    return defaults;
}

export function isWorkspaceTabId(value: unknown): value is WorkspaceTabId {
    return typeof value === "string" && (WORKSPACE_TAB_IDS as readonly string[]).includes(value);
}

export function defaultGlobalLayout(): GlobalLayoutState {
    return { navOpen: true, navWidth: NAV_WIDTH_DEFAULT };
}

/**
 * Every route tab starts open so the three workspace pages always have an entry
 * point from the chat view; closing one only hides it until the route is visited
 * again (a closed tab must never strand the user).
 */
export function defaultOpenTabs(): WorkspaceTabId[] {
    return [...WORKSPACE_TAB_IDS];
}

export function defaultWorkspaceLayout(): WorkspaceLayoutState {
    return {
        treeCollapsed: false,
        dockCollapsed: true,
        dockWidth: DOCK_WIDTH_DEFAULT,
        dockTabs: [],
        activeDockTab: null,
        openTabs: defaultOpenTabs(),
    };
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
        // S1 keys carried `railCollapsed`; it is intentionally ignored now (rail is fixed).
        return {
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
            JSON.stringify({ navOpen: state.navOpen, navWidth: clampNavWidth(state.navWidth) }),
        );
    } catch (cause) {
        logger.warn("Failed to persist the global layout", cause);
    }
}

function workspaceLayoutKey(workspaceId: string): string {
    return `${WORKSPACE_LAYOUT_STORAGE_PREFIX}${workspaceId}`;
}

/** Route tabs are sanitized the same way as dock tabs: known ids, no duplicates. */
function readOpenTabs(parsed: Partial<WorkspaceLayoutState>): WorkspaceTabId[] {
    // A missing field means "legacy / never closed anything" -> all tabs open.
    if (!Array.isArray(parsed.openTabs)) return defaultOpenTabs();
    const openTabs: WorkspaceTabId[] = [];
    for (const tab of parsed.openTabs) {
        if (isWorkspaceTabId(tab) && !openTabs.includes(tab)) openTabs.push(tab);
    }
    return openTabs;
}

/**
 * Per-workspace workbench layout. Tabs are de-duplicated, capped at
 * `DOCK_MAX_TABS`, and `activeDockTab` must belong to the open set — a corrupt
 * payload degrades to the defaults instead of rendering an impossible state.
 */
export function readWorkspaceLayout(workspaceId: string): WorkspaceLayoutState {
    const defaults = defaultWorkspaceLayout(),
        store = storage();
    if (!workspaceId || !store) return defaults;
    try {
        const raw = store.getItem(workspaceLayoutKey(workspaceId));
        if (!raw) return defaults;
        const parsed = JSON.parse(raw) as Partial<WorkspaceLayoutState> | null;
        if (!parsed || typeof parsed !== "object") return defaults;
        const tabs: DockTabId[] = [];
        for (const tab of Array.isArray(parsed.dockTabs) ? parsed.dockTabs : []) {
            if (isDockTabId(tab) && !tabs.includes(tab) && tabs.length < DOCK_MAX_TABS) {
                tabs.push(tab);
            }
        }
        const active =
            isDockTabId(parsed.activeDockTab) && tabs.includes(parsed.activeDockTab)
                ? parsed.activeDockTab
                : (tabs[0] ?? null);
        return {
            treeCollapsed:
                typeof parsed.treeCollapsed === "boolean"
                    ? parsed.treeCollapsed
                    : defaults.treeCollapsed,
            dockCollapsed:
                typeof parsed.dockCollapsed === "boolean"
                    ? parsed.dockCollapsed
                    : defaults.dockCollapsed,
            dockWidth:
                typeof parsed.dockWidth === "number"
                    ? clampDockWidth(parsed.dockWidth)
                    : defaults.dockWidth,
            dockTabs: tabs,
            activeDockTab: tabs.length === 0 ? null : active,
            openTabs: readOpenTabs(parsed),
        };
    } catch (cause) {
        logger.warn("Failed to read the workspace layout, falling back to defaults", cause);
        store.removeItem(workspaceLayoutKey(workspaceId));
        return defaults;
    }
}

export function writeWorkspaceLayout(workspaceId: string, state: WorkspaceLayoutState): void {
    const store = storage();
    if (!workspaceId || !store) return;
    try {
        store.setItem(
            workspaceLayoutKey(workspaceId),
            JSON.stringify({
                treeCollapsed: state.treeCollapsed,
                dockCollapsed: state.dockCollapsed,
                dockWidth: clampDockWidth(state.dockWidth),
                dockTabs: state.dockTabs.slice(0, DOCK_MAX_TABS),
                activeDockTab: state.activeDockTab,
                openTabs: state.openTabs.filter(isWorkspaceTabId),
            }),
        );
    } catch (cause) {
        logger.warn("Failed to persist the workspace layout", cause);
    }
}

/**
 * Logout / user switch: the layout is user-scoped state, so the next account in
 * this browser must not inherit the previous account's collapse state, widths or
 * dock tabs (PLAN-0582 V10). Clears the global key and every per-workspace key.
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
        navWidth = ref(stored.navWidth),
        navOpen = ref(options.isMobile.value ? false : stored.navOpen);

    const railWidth = computed(() => RAIL_WIDTH),
        navPanelWidth = computed(() => (navOpen.value ? navWidth.value : 0)),
        mainOffset = computed(() =>
            options.isMobile.value ? 0 : railWidth.value + navPanelWidth.value,
        );

    function persist(): void {
        if (options.isMobile.value) return;
        writeGlobalLayout({ navOpen: navOpen.value, navWidth: navWidth.value });
    }

    watch([navOpen, navWidth], () => persist());

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
        navOpen,
        navWidth,
        railWidth,
        navPanelWidth,
        mainOffset,
        toggleNav,
        setNavOpen,
        setNavWidth,
        nudgeNavWidth,
        resetNavWidth,
    };
}
