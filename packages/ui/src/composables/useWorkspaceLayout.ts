import { computed, ref, watch, type InjectionKey, type Ref } from "vue";
import { useWindowSize } from "@vueuse/core";
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

/** Workbench file tree column (S3b: draggable, 200-320, 240 default). */
export const TREE_WIDTH_DEFAULT = 240;
export const TREE_WIDTH_MIN = 200;
export const TREE_WIDTH_MAX = 320;
export const TREE_WIDTH_KEYBOARD_STEP = 16;
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

/** S3b: pinned = flex child, floating = overlay (never squeezes the main column). */
export type DockMode = "pinned" | "floating";

export interface WorkspaceLayoutState {
    treeCollapsed: boolean;
    /** S3b: the persisted tree width; collapsing keeps it (collapse != width). */
    treeWidth: number;
    dockCollapsed: boolean;
    dockWidth: number;
    dockTabs: DockTabId[];
    activeDockTab: DockTabId | null;
    /** S3b: breakpoint-derived mode unless the user pinned/unpinned it explicitly. */
    dockMode: DockMode;
    /** S3b: `true` once the user toggled the mode; the derivation then backs off. */
    dockModeManual: boolean;
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

export function clampTreeWidth(width: number): number {
    if (!Number.isFinite(width)) return TREE_WIDTH_DEFAULT;
    return Math.min(TREE_WIDTH_MAX, Math.max(TREE_WIDTH_MIN, Math.round(width)));
}

export function isDockMode(value: unknown): value is DockMode {
    return value === "pinned" || value === "floating";
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

/**
 * P1-1 (S2 audit): a workspace with no stored *geometry* opens the monitor on wide
 * screens. S3a audit P1-1 (S3b fix): "key exists" is not enough — the route tab bar
 * legitimately persists its own `openTabs` slice before any geometry was written,
 * and that must not be mistaken for "the user already chose a dock state".
 */
export function hasWorkspaceLayout(workspaceId: string): boolean {
    const store = storage();
    if (!workspaceId || !store) return false;
    try {
        const raw = store.getItem(workspaceLayoutKey(workspaceId));
        if (!raw) return false;
        const parsed = JSON.parse(raw) as Partial<WorkspaceLayoutState> | null;
        if (!parsed || typeof parsed !== "object") return false;
        return (
            typeof parsed.dockCollapsed === "boolean" ||
            typeof parsed.treeCollapsed === "boolean" ||
            typeof parsed.dockWidth === "number" ||
            typeof parsed.treeWidth === "number"
        );
    } catch (cause) {
        // Storage can throw on access (Safari private mode, quota, policy). This is
        // called from a render-time computed, so never let it escape as a white screen.
        logger.warn("Failed to inspect the workspace layout key", cause);
        return false;
    }
}

/**
 * S3a audit P1-1 (S3b fix): persist **only** the route-tab slice. Writing the whole
 * layout from a default-valued read would clobber the geometry the workbench just
 * stored (e.g. flip "≥1800 opened the monitor" back to "dock closed").
 */
export function writeWorkspaceOpenTabs(workspaceId: string, openTabs: WorkspaceTabId[]): void {
    const store = storage();
    if (!workspaceId || !store) return;
    try {
        const key = workspaceLayoutKey(workspaceId);
        const raw = store.getItem(key);
        let parsed: Record<string, unknown> = {};
        if (raw) {
            const existing = JSON.parse(raw) as unknown;
            if (existing && typeof existing === "object" && !Array.isArray(existing)) {
                parsed = existing as Record<string, unknown>;
            }
        }
        parsed.openTabs = openTabs.filter(isWorkspaceTabId);
        store.setItem(key, JSON.stringify(parsed));
    } catch (cause) {
        logger.warn("Failed to persist the route tab set", cause);
    }
}

/** S3b: single source of truth for the pinned/floating breakpoint. */
export function deriveDockMode(viewportWidth: number): DockMode {
    if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return "floating";
    return viewportWidth >= DOCK_INLINE_MIN_VIEWPORT ? "pinned" : "floating";
}

export function defaultWorkspaceLayoutForViewport(viewportWidth: number): WorkspaceLayoutState {
    const defaults = defaultWorkspaceLayout(),
        dockMode = deriveDockMode(viewportWidth);
    if (Number.isFinite(viewportWidth) && viewportWidth >= DOCK_INLINE_MIN_VIEWPORT) {
        return {
            ...defaults,
            dockCollapsed: false,
            dockTabs: ["monitor"],
            activeDockTab: "monitor",
            dockMode,
        };
    }
    return { ...defaults, dockMode };
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
        treeWidth: TREE_WIDTH_DEFAULT,
        dockCollapsed: true,
        dockWidth: DOCK_WIDTH_DEFAULT,
        dockTabs: [],
        activeDockTab: null,
        dockMode: "floating",
        dockModeManual: false,
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
            treeWidth:
                typeof parsed.treeWidth === "number"
                    ? clampTreeWidth(parsed.treeWidth)
                    : defaults.treeWidth,
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
            dockMode: isDockMode(parsed.dockMode) ? parsed.dockMode : defaults.dockMode,
            dockModeManual:
                typeof parsed.dockModeManual === "boolean"
                    ? parsed.dockModeManual
                    : defaults.dockModeManual,

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
    // P2-7 (S2 audit): the persisted active tab must be exactly the projection of
    // the sliced tab set — otherwise the in-memory `active` (e.g. tab #7) and the
    // stored tabs (6) disagree and a reload silently loses the active tab.
    const tabs = state.dockTabs.filter(isDockTabId).slice(0, DOCK_MAX_TABS);
    const active =
        state.activeDockTab && tabs.includes(state.activeDockTab)
            ? state.activeDockTab
            : (tabs[0] ?? null);
    try {
        store.setItem(
            workspaceLayoutKey(workspaceId),
            JSON.stringify({
                treeCollapsed: state.treeCollapsed,
                treeWidth: clampTreeWidth(state.treeWidth),
                dockCollapsed: state.dockCollapsed,
                dockWidth: clampDockWidth(state.dockWidth),
                dockTabs: tabs,
                activeDockTab: active,
                dockMode: isDockMode(state.dockMode) ? state.dockMode : "floating",
                dockModeManual: state.dockModeManual,
                openTabs: state.openTabs.filter(isWorkspaceTabId),
            }),
        );
    } catch (cause) {
        logger.warn("Failed to persist the workspace layout", cause);
    }
}

/**
 * P2-9 (S2 audit): a drag emits dozens of width updates per second. Persisting on
 * every `mousemove` is a write amplification (localStorage is synchronous and
 * shared with the whole origin). This coalesces writes and exposes `flush()` for
 * unmount/visibility changes so the last value is never lost.
 */
export function createWorkspaceLayoutWriter(
    workspaceId: string,
    delayMs = 250,
): { schedule: (state: WorkspaceLayoutState) => void; flush: () => void } {
    let timer: ReturnType<typeof setTimeout> | null = null,
        pending: WorkspaceLayoutState | null = null;
    function flush() {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
        if (pending) {
            writeWorkspaceLayout(workspaceId, pending);
            pending = null;
        }
    }
    function schedule(state: WorkspaceLayoutState) {
        pending = state;
        if (timer !== null) return;
        timer = setTimeout(() => {
            timer = null;
            flush();
        }, delayMs);
    }
    return { schedule, flush };
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

/** What the workbench publishes so the geometry owner can evaluate the squeeze. */
export type WorkbenchSqueezeDemand = Omit<
    WorkbenchSqueezeInput,
    "workbenchWidth" | "navPanelWidth"
>;

/** Injection key for the single `useWorkspaceLayout` instance created by AppLayout. */
export const WORKSPACE_LAYOUT_KEY: InjectionKey<ReturnType<typeof useWorkspaceLayout>> =
    Symbol("xihe-workspace-layout");

export interface WorkspaceLayoutOptions {
    /** The mobile sheet is a transient overlay and must not persist as desktop layout. */
    isMobile: Ref<boolean>;
}

export function useWorkspaceLayout(options: WorkspaceLayoutOptions) {
    const stored = readGlobalLayout(),
        navWidth = ref(stored.navWidth),
        navOpen = ref(options.isMobile.value ? false : stored.navOpen);

    // S3a audit P1-3: the rendered panel is clamped per breakpoint (Sidebar renders
    // `clampNavWidthForViewport`), so the main-column offset must use the *same*
    // clamped value — otherwise a window narrowed after a wide drag leaves a gap.
    const { width: viewportWidth } = useWindowSize();
    const effectiveNavWidth = computed(() =>
        clampNavWidthForViewport(navWidth.value, viewportWidth.value),
    );
    const railWidth = computed(() => RAIL_WIDTH);

    /**
     * S5-W2: the workbench publishes what it needs (tree/dock geometry) and this
     * composable — the single geometry owner — decides the anti-squeeze outcome,
     * including whether the navigation panel has to yield. The demand is runtime
     * only: nothing about a yield is ever persisted.
     */
    const workbenchDemand = ref<WorkbenchSqueezeDemand | null>(null);
    function setWorkbenchDemand(demand: WorkbenchSqueezeDemand | null): void {
        workbenchDemand.value = demand;
    }

    /** Panel width the user asked for, before any yield. */
    const requestedNavPanelWidth = computed(() => (navOpen.value ? effectiveNavWidth.value : 0));

    const squeeze = computed<WorkbenchSqueezeResult>(() => {
        const demand = workbenchDemand.value;
        const offset = options.isMobile.value ? 0 : RAIL_WIDTH + requestedNavPanelWidth.value;
        const workbenchWidth = Math.max(0, (viewportWidth.value || 0) - offset);
        if (!demand) {
            return {
                mainWidth: workbenchWidth,
                treeYielded: false,
                navYielded: false,
                forceFloating: false,
            };
        }
        return computeWorkbenchSqueeze({
            workbenchWidth,
            ...demand,
            navPanelWidth: requestedNavPanelWidth.value,
        });
    });

    const navYielded = computed(() => squeeze.value.navYielded),
        navPanelWidth = computed(() =>
            navOpen.value && !navYielded.value ? effectiveNavWidth.value : 0,
        ),
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
        effectiveNavWidth,
        navYielded,
        squeeze,
        setWorkbenchDemand,
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

/**
 * PLAN-0582 S3b §4 anti-squeeze (spec §1.5-C). The main column is the protected
 * quantity, so the rules are ordered by that protection:
 *
 * 1. `MAIN_MIN_WIDTH` (640) is a hard floor and outranks everything;
 * 2. a pinned dock first makes the **file tree** yield (never the dock itself);
 * 3. if the main column is still under the floor, the dock drops back to
 *    floating (rendering only — the user's pinned choice is kept and reported);
 * 4. below `MAIN_COMFORT_MIN_WIDTH` (720) the tree yields even when the floor is
 *    met, so the main column keeps a readable width.
 *
 * S5-W2 adds the second yield step of spec §1.5-C: after the tree, the
 * **navigation panel** yields to its rail (`navYielded`) — comfort yield only while
 * a pinned dock squeezes, hard-floor yield always, and never by closing the dock.
 * Pure function so the breakpoint table is unit-testable without a DOM.
 */
export const MAIN_MIN_WIDTH = 640;
export const MAIN_COMFORT_MIN_WIDTH = 720;

export interface WorkbenchSqueezeInput {
    /** Measured width of the workbench row (rail+panel already excluded). */
    workbenchWidth: number;
    treeWidth: number;
    /** Whether the tree is collapsed **as rendered** (manual expansion included). */
    treeCollapsed: boolean;
    dockWidth: number;
    dockOpen: boolean;
    dockMode: DockMode;
    /**
     * S3b P1-2 (audit): `false` when the user expanded the tree by hand. Automatic
     * yielding must then be suppressed (it would contradict the explicit choice),
     * and the 640 floor is protected by forcing the dock to floating instead. The
     * hard floor still wins over the manual preference if floating is not enough.
     */
    allowTreeYield?: boolean;
    /** Rendered width of the navigation panel that could yield (0 when closed). */
    navPanelWidth?: number;
    /**
     * S3b-style runtime override: `false` when the user just re-opened the nav by
     * hand. Suppresses the *comfort* yield only — the 640 hard floor still wins.
     */
    allowNavYield?: boolean;
}

export interface WorkbenchSqueezeResult {
    mainWidth: number;
    /** The tree has to collapse so a pinned dock can keep the main column readable. */
    treeYielded: boolean;
    /** The navigation panel has to collapse to its rail so the floor is reachable. */
    navYielded: boolean;
    /** The dock has to render as floating to protect the hard floor. */
    forceFloating: boolean;
}

/**
 * Pure anti-squeeze evaluation. Inputs are the **rendered** state (that is the S3b
 * P1-2 fix: feeding the persisted state made the toast lie whenever the user had
 * expanded the tree manually) and the output only *adds* collapses/floating on top.
 */
export function computeWorkbenchSqueeze(input: WorkbenchSqueezeInput): WorkbenchSqueezeResult {
    const workbenchWidth = Number.isFinite(input.workbenchWidth) ? input.workbenchWidth : 0;
    const allowTreeYield = input.allowTreeYield !== false;
    const allowNavYield = input.allowNavYield !== false;
    const navPanelWidth = Number.isFinite(input.navPanelWidth)
        ? Math.max(0, input.navPanelWidth ?? 0)
        : 0;
    const treeCollapsed = Boolean(input.treeCollapsed);
    const tree = treeCollapsed ? TREE_COLLAPSED_WIDTH : input.treeWidth;
    const dockTakesSpace = input.dockOpen && input.dockMode === "pinned";
    let mainWidth = workbenchWidth - tree - (dockTakesSpace ? input.dockWidth : 0);
    let treeYielded = false;
    let navYielded = false;

    // ── comfort floor (720), spec §1.5-C rule 2: tree first, then the nav panel ──
    // Only a *pinned* dock squeezes the row, so the comfort yield is scoped to it.
    if (dockTakesSpace && mainWidth < MAIN_COMFORT_MIN_WIDTH) {
        if (!treeCollapsed && allowTreeYield) {
            mainWidth += tree - TREE_COLLAPSED_WIDTH;
            treeYielded = true;
        }
        if (mainWidth < MAIN_COMFORT_MIN_WIDTH && navPanelWidth > 0 && allowNavYield) {
            mainWidth += navPanelWidth;
            navYielded = true;
        }
    }

    // ── hard floor (640), outranks every manual preference ──
    let forceFloating = false;
    if (dockTakesSpace && mainWidth < MAIN_MIN_WIDTH) {
        mainWidth += input.dockWidth;
        forceFloating = true;
    }
    if (mainWidth < MAIN_MIN_WIDTH && !treeCollapsed && !treeYielded) {
        mainWidth += tree - TREE_COLLAPSED_WIDTH;
        treeYielded = true;
    }
    // The nav panel is the last lever: at narrow viewports the rail + panel alone can
    // eat the floor, so it yields even without a pinned dock (and even if the user
    // re-opened it by hand — the floor is the higher-priority invariant).
    if (mainWidth < MAIN_MIN_WIDTH && navPanelWidth > 0 && !navYielded) {
        mainWidth += navPanelWidth;
        navYielded = true;
    }

    return { mainWidth, treeYielded, navYielded, forceFloating };
}
