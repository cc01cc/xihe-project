import { beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, ref } from "vue";
import {
    DOCK_MAX_TABS,
    DOCK_WIDTH_DEFAULT,
    DOCK_WIDTH_MAX,
    DOCK_WIDTH_MIN,
    GLOBAL_LAYOUT_STORAGE_KEY,
    MAIN_COMFORT_MIN_WIDTH,
    MAIN_MIN_WIDTH,
    NAV_WIDTH_DEFAULT,
    NAV_WIDTH_MAX,
    NAV_WIDTH_MIN,
    RAIL_WIDTH,
    TREE_COLLAPSED_WIDTH,
    TREE_WIDTH_DEFAULT,
    TREE_WIDTH_MAX,
    TREE_WIDTH_MIN,
    WORKSPACE_LAYOUT_STORAGE_PREFIX,
    clampDockWidth,
    clampNavWidth,
    clampNavWidthForViewport,
    clampTreeWidth,
    clearLayoutStorage,
    computeWorkbenchSqueeze,
    createWorkspaceLayoutWriter,
    defaultGlobalLayout,
    defaultWorkspaceLayout,
    defaultWorkspaceLayoutForViewport,
    deriveDockMode,
    hasWorkspaceLayout,
    readGlobalLayout,
    readWorkspaceLayout,
    useWorkspaceLayout,
    writeGlobalLayout,
    writeWorkspaceLayout,
} from "../useWorkspaceLayout";
import { logger } from "../../lib/logger";

vi.mock("../../lib/logger", () => ({
    logger: {
        warn: vi.fn<(message: string, cause?: unknown) => void>(),
        error: vi.fn<(message: string, cause?: unknown) => void>(),
        info: vi.fn<(message: string, detail?: unknown) => void>(),
        debug: vi.fn<(message: string, detail?: unknown) => void>(),
    },
}));

function readStored(): Record<string, unknown> | null {
    const raw = localStorage.getItem(GLOBAL_LAYOUT_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

function readStoredWorkspace(workspaceId: string): Record<string, unknown> | null {
    const raw = localStorage.getItem(`${WORKSPACE_LAYOUT_STORAGE_PREFIX}${workspaceId}`);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
});

describe("global layout storage", () => {
    it("defaults to an open default-width panel next to the fixed icon rail", () => {
        // S2 ruling #1: the rail is a constant 56px strip, so it carries no state.
        expect(RAIL_WIDTH).toBe(56);
        expect(defaultGlobalLayout()).toEqual({
            navOpen: true,
            navWidth: NAV_WIDTH_DEFAULT,
        });
        expect(readGlobalLayout()).toEqual(defaultGlobalLayout());
    });

    it("clamps the panel width into the 220-360 range", () => {
        expect(clampNavWidth(100)).toBe(NAV_WIDTH_MIN);
        expect(clampNavWidth(900)).toBe(NAV_WIDTH_MAX);
        expect(clampNavWidth(Number.NaN)).toBe(NAV_WIDTH_DEFAULT);
        expect(clampNavWidth(281.6)).toBe(282);
    });

    it("round-trips a persisted layout, clamps foreign widths and drops the S1 rail key", () => {
        writeGlobalLayout({ navOpen: false, navWidth: 900 });

        expect(readStored()).toEqual({ navOpen: false, navWidth: 360 });
        expect(readGlobalLayout()).toEqual({ navOpen: false, navWidth: 360 });

        // A payload written by S1 still carried `railCollapsed`; it is ignored now.
        localStorage.setItem(
            GLOBAL_LAYOUT_STORAGE_KEY,
            JSON.stringify({ railCollapsed: false, navOpen: true, navWidth: 300 }),
        );
        expect(readGlobalLayout()).toEqual({ navOpen: true, navWidth: 300 });
    });

    it("falls back to defaults for corrupted payloads and makes the failure observable", () => {
        localStorage.setItem(GLOBAL_LAYOUT_STORAGE_KEY, "{not json");

        expect(readGlobalLayout()).toEqual(defaultGlobalLayout());
        expect(localStorage.getItem(GLOBAL_LAYOUT_STORAGE_KEY)).toBeNull();
        expect(logger.warn).toHaveBeenCalledWith(
            "Failed to read the global layout, falling back to defaults",
            expect.anything(),
        );
    });

    it("clears the global key and every per-workspace layout key on logout", () => {
        writeGlobalLayout({ navOpen: true, navWidth: 300 });
        localStorage.setItem(`${WORKSPACE_LAYOUT_STORAGE_PREFIX}ws-1`, "{}");
        localStorage.setItem(`${WORKSPACE_LAYOUT_STORAGE_PREFIX}ws-2`, "{}");
        localStorage.setItem("xihe-token", "keep-me");

        clearLayoutStorage();

        expect(localStorage.getItem(GLOBAL_LAYOUT_STORAGE_KEY)).toBeNull();
        expect(localStorage.getItem(`${WORKSPACE_LAYOUT_STORAGE_PREFIX}ws-1`)).toBeNull();
        expect(localStorage.getItem(`${WORKSPACE_LAYOUT_STORAGE_PREFIX}ws-2`)).toBeNull();
        expect(localStorage.getItem("xihe-token")).toBe("keep-me");
    });
});

describe("per-workspace dock layout storage (PLAN-0582 S2)", () => {
    it("defaults to a collapsed dock with no tabs and the 360px default width", () => {
        expect(defaultWorkspaceLayout()).toEqual({
            treeCollapsed: false,
            treeWidth: TREE_WIDTH_DEFAULT,
            dockCollapsed: true,
            dockWidth: DOCK_WIDTH_DEFAULT,
            dockTabs: [],
            activeDockTab: null,
            dockMode: "floating",
            dockModeManual: false,
            dockPolicyDismissed: false,
            openTabs: ["environment", "scheduled-tasks", "settings"],
        });
        expect(readWorkspaceLayout("ws-1")).toEqual(defaultWorkspaceLayout());
    });

    it("clamps the dock width into the 320-480 range", () => {
        expect(clampDockWidth(100)).toBe(DOCK_WIDTH_MIN);
        expect(clampDockWidth(9999)).toBe(DOCK_WIDTH_MAX);
        expect(clampDockWidth(Number.NaN)).toBe(DOCK_WIDTH_DEFAULT);
        expect(clampDockWidth(359.4)).toBe(359);
    });

    it("round-trips tabs, active tab, width and collapse state", () => {
        writeWorkspaceLayout("ws-1", {
            treeCollapsed: true,
            treeWidth: 300,
            dockCollapsed: false,
            dockWidth: 420,
            dockTabs: ["code", "monitor"],
            activeDockTab: "monitor",
            dockMode: "pinned",
            dockModeManual: true,
            dockPolicyDismissed: true,
            openTabs: ["environment", "settings"],
        });

        expect(readStoredWorkspace("ws-1")).toEqual({
            treeCollapsed: true,
            treeWidth: 300,
            dockCollapsed: false,
            dockWidth: 420,
            dockTabs: ["code", "monitor"],
            activeDockTab: "monitor",
            dockMode: "pinned",
            dockModeManual: true,
            dockPolicyDismissed: true,
            openTabs: ["environment", "settings"],
        });
        expect(readWorkspaceLayout("ws-1")).toEqual({
            treeCollapsed: true,
            treeWidth: 300,
            dockCollapsed: false,
            dockWidth: 420,
            dockTabs: ["code", "monitor"],
            activeDockTab: "monitor",
            dockMode: "pinned",
            dockModeManual: true,
            dockPolicyDismissed: true,
            openTabs: ["environment", "settings"],
        });
        // Workspace-scoped: another workspace is untouched.
        expect(readWorkspaceLayout("ws-2")).toEqual(defaultWorkspaceLayout());
    });

    it("sanitizes unknown, duplicate, over-limit tabs and a foreign active tab", () => {
        localStorage.setItem(
            `${WORKSPACE_LAYOUT_STORAGE_PREFIX}ws-1`,
            JSON.stringify({
                treeCollapsed: false,
                dockCollapsed: false,
                dockWidth: 9999,
                dockTabs: ["code", "code", "bogus", "changes", "monitor", "code", "monitor"],
                activeDockTab: "bogus",
            }),
        );

        const stored = readWorkspaceLayout("ws-1");
        expect(stored.dockWidth).toBe(DOCK_WIDTH_MAX);
        expect(stored.dockTabs).toEqual(["code", "changes", "monitor"]);
        expect(stored.dockTabs.length).toBeLessThanOrEqual(DOCK_MAX_TABS);
        // A foreign active tab falls back to the first open tab.
        expect(stored.activeDockTab).toBe("code");
    });

    it("drops a corrupted per-workspace payload and keeps the failure observable", () => {
        localStorage.setItem(`${WORKSPACE_LAYOUT_STORAGE_PREFIX}ws-1`, "{not json");

        expect(readWorkspaceLayout("ws-1")).toEqual(defaultWorkspaceLayout());
        expect(localStorage.getItem(`${WORKSPACE_LAYOUT_STORAGE_PREFIX}ws-1`)).toBeNull();
        expect(logger.warn).toHaveBeenCalledWith(
            "Failed to read the workspace layout, falling back to defaults",
            expect.anything(),
        );
    });
});

describe("useWorkspaceLayout", () => {
    it("derives the main offset from the fixed rail plus the open panel and persists toggles", async () => {
        const scope = effectScope();
        const layout = scope.run(() => useWorkspaceLayout({ isMobile: ref(false) }))!;

        expect(layout.railWidth.value).toBe(RAIL_WIDTH);
        // S3a audit P1-3: the offset must use the *rendered* (breakpoint-clamped)
        // width, otherwise a window narrowed after a wide drag leaves a gap.
        expect(layout.effectiveNavWidth.value).toBe(
            clampNavWidthForViewport(NAV_WIDTH_DEFAULT, window.innerWidth),
        );
        expect(layout.mainOffset.value).toBe(
            RAIL_WIDTH + clampNavWidthForViewport(NAV_WIDTH_DEFAULT, window.innerWidth),
        );

        layout.setNavWidth(320);
        await nextTick();

        expect(layout.mainOffset.value).toBe(
            RAIL_WIDTH + clampNavWidthForViewport(320, window.innerWidth),
        );
        // The stored value stays the user's choice (the clamp is render-only).
        expect(readStored()).toEqual({ navOpen: true, navWidth: 320 });

        layout.toggleNav();
        await nextTick();

        // R-D: the rail offset survives a collapsed panel (it no longer becomes 0).
        expect(layout.mainOffset.value).toBe(RAIL_WIDTH);

        layout.nudgeNavWidth(1000);
        expect(layout.navWidth.value).toBe(NAV_WIDTH_MAX);
        layout.resetNavWidth();
        expect(layout.navWidth.value).toBe(NAV_WIDTH_DEFAULT);

        scope.stop();
    });

    it("restores a persisted layout and starts collapsed on mobile without persisting", async () => {
        const isMobile = ref(true);
        const scope = effectScope();
        writeGlobalLayout({ navOpen: true, navWidth: 300 });
        const layout = scope.run(() => useWorkspaceLayout({ isMobile }))!;

        // The mobile sheet starts closed and owns no desktop layout preference.
        expect(layout.navOpen.value).toBe(false);
        expect(layout.railWidth.value).toBe(RAIL_WIDTH);
        expect(layout.mainOffset.value).toBe(0);

        localStorage.removeItem(GLOBAL_LAYOUT_STORAGE_KEY);
        layout.toggleNav();
        await nextTick();

        expect(localStorage.getItem(GLOBAL_LAYOUT_STORAGE_KEY)).toBeNull();

        isMobile.value = false;
        layout.setNavWidth(340);
        await nextTick();

        expect(readStored()).toEqual({ navOpen: true, navWidth: 340 });

        scope.stop();
    });
});

describe("PLAN-0582 S3a: breakpoint helpers (S2 audit P1-1/P1-4)", () => {
    it("clamps the navigation panel per breakpoint without rewriting the stored value", () => {
        expect(clampNavWidthForViewport(280, 1920)).toBe(280);
        expect(clampNavWidthForViewport(280, 1440)).toBe(280);
        expect(clampNavWidthForViewport(280, 1439)).toBe(260);
        expect(clampNavWidthForViewport(360, 1280)).toBe(260);
        expect(clampNavWidthForViewport(360, 1024)).toBe(240);
        // The user value survives: the clamp is render-only.
        expect(clampNavWidthForViewport(220, 1024)).toBe(220);
    });

    it("derives a monitor dock default only for wide screens with no stored layout", () => {
        const wide = defaultWorkspaceLayoutForViewport(1920);
        expect(wide.dockCollapsed).toBe(false);
        expect(wide.dockTabs).toEqual(["monitor"]);
        expect(wide.activeDockTab).toBe("monitor");

        const narrow = defaultWorkspaceLayoutForViewport(1440);
        expect(narrow.dockCollapsed).toBe(true);
        expect(narrow.dockTabs).toEqual([]);

        localStorage.setItem("xihe-layout-ws:ws-1", JSON.stringify({ openTabs: [] }));
        expect(hasWorkspaceLayout("ws-1")).toBe(true);
        expect(hasWorkspaceLayout("ws-2")).toBe(false);
    });
});

describe("PLAN-0582 S3b: draggable columns, dock mode and anti-squeeze", () => {
    it("clamps the file tree width to 200-320", () => {
        expect(clampTreeWidth(TREE_WIDTH_DEFAULT)).toBe(240);
        expect(clampTreeWidth(120)).toBe(TREE_WIDTH_MIN);
        expect(clampTreeWidth(999)).toBe(TREE_WIDTH_MAX);
        expect(clampTreeWidth(Number.NaN)).toBe(TREE_WIDTH_DEFAULT);
        expect(clampTreeWidth(287.4)).toBe(287);
    });

    it("derives the dock mode from the single breakpoint constant", () => {
        expect(deriveDockMode(1920)).toBe("pinned");
        expect(deriveDockMode(1800)).toBe("pinned");
        expect(deriveDockMode(1799)).toBe("floating");
        expect(deriveDockMode(1024)).toBe("floating");
        // A fresh wide profile derives the pinned mode in its first-run layout.
        expect(defaultWorkspaceLayoutForViewport(1920).dockMode).toBe("pinned");
        expect(defaultWorkspaceLayoutForViewport(1440).dockMode).toBe("floating");
    });

    it("keeps the persisted active dock tab aligned with the capped tab list (P2-7)", () => {
        const tabs = ["code", "changes", "monitor", "code", "changes", "monitor", "code"] as const;
        writeWorkspaceLayout("ws-1", {
            ...defaultWorkspaceLayout(),
            dockTabs: [...tabs],
            activeDockTab: "monitor",
        });
        const stored = JSON.parse(
            localStorage.getItem(`${WORKSPACE_LAYOUT_STORAGE_PREFIX}ws-1`) ?? "{}",
        ) as { dockTabs: string[]; activeDockTab: string | null };
        expect(stored.dockTabs).toHaveLength(DOCK_MAX_TABS);
        // The active tab is always a member of the persisted set.
        expect(stored.dockTabs).toContain(stored.activeDockTab ?? "");
    });

    it("drops an active tab that is not part of the capped set instead of storing it", () => {
        writeWorkspaceLayout("ws-1", {
            ...defaultWorkspaceLayout(),
            dockTabs: ["code"],
            activeDockTab: "monitor",
        });
        const stored = JSON.parse(
            localStorage.getItem(`${WORKSPACE_LAYOUT_STORAGE_PREFIX}ws-1`) ?? "{}",
        ) as { activeDockTab: string | null };
        expect(stored.activeDockTab).toBe("code");
    });

    it("persists dock mode, manual flag and the dismissal marker across a reload", () => {
        writeWorkspaceLayout("ws-1", {
            ...defaultWorkspaceLayout(),
            dockMode: "pinned",
            dockModeManual: true,
            dockPolicyDismissed: true,
        });
        const layout = readWorkspaceLayout("ws-1");
        expect(layout.dockMode).toBe("pinned");
        expect(layout.dockModeManual).toBe(true);
        expect(layout.dockPolicyDismissed).toBe(true);
    });

    it("coalesces drag writes and flushes the pending value (P2-9)", async () => {
        const writer = createWorkspaceLayoutWriter("ws-1", 20);
        writer.schedule({ ...defaultWorkspaceLayout(), treeWidth: 260 });
        writer.schedule({ ...defaultWorkspaceLayout(), treeWidth: 280 });
        writer.schedule({ ...defaultWorkspaceLayout(), treeWidth: 300 });
        // Nothing is written synchronously.
        expect(localStorage.getItem(`${WORKSPACE_LAYOUT_STORAGE_PREFIX}ws-1`)).toBeNull();

        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(readWorkspaceLayout("ws-1").treeWidth).toBe(300);

        // flush() persists immediately (unmount / workspace switch).
        writer.schedule({ ...defaultWorkspaceLayout(), treeWidth: 210 });
        writer.flush();
        expect(readWorkspaceLayout("ws-1").treeWidth).toBe(210);
    });

    it("yields the tree first and only then floats the dock (spec §1.5-C)", () => {
        // Plenty of room: nothing yields.
        expect(
            computeWorkbenchSqueeze({
                workbenchWidth: 1444,
                treeWidth: 240,
                treeCollapsed: false,
                dockWidth: 360,
                dockOpen: true,
                dockMode: "pinned",
            }),
        ).toEqual({ mainWidth: 844, treeYielded: false, forceFloating: false });

        // 720 comfort floor: the pinned dock makes the tree yield (240 -> 40).
        expect(
            computeWorkbenchSqueeze({
                workbenchWidth: 1280,
                treeWidth: 240,
                treeCollapsed: false,
                dockWidth: 360,
                dockOpen: true,
                dockMode: "pinned",
            }),
        ).toEqual({ mainWidth: 880, treeYielded: true, forceFloating: false });

        // 640 hard floor: even after the tree yields the main column is too narrow,
        // so the dock renders floating and the user value is left untouched.
        const squeezed = computeWorkbenchSqueeze({
            workbenchWidth: 1000,
            treeWidth: 240,
            treeCollapsed: true,
            dockWidth: 360,
            dockOpen: true,
            dockMode: "pinned",
        });
        expect(squeezed.forceFloating).toBe(true);
        expect(squeezed.mainWidth).toBeGreaterThanOrEqual(MAIN_MIN_WIDTH);

        // Floating never takes space, so nothing has to yield.
        expect(
            computeWorkbenchSqueeze({
                workbenchWidth: 900,
                treeWidth: 240,
                treeCollapsed: false,
                dockWidth: 360,
                dockOpen: true,
                dockMode: "floating",
            }),
        ).toEqual({ mainWidth: 660, treeYielded: false, forceFloating: false });

        // A collapsed tree already contributes only the 40px rail.
        expect(
            computeWorkbenchSqueeze({
                workbenchWidth: 1200,
                treeWidth: 300,
                treeCollapsed: true,
                dockWidth: 360,
                dockOpen: true,
                dockMode: "pinned",
            }).mainWidth,
        ).toBe(1200 - TREE_COLLAPSED_WIDTH - 360);
    });

    it("treats the comfort floor as a tree-yield trigger above the hard floor", () => {
        const result = computeWorkbenchSqueeze({
            workbenchWidth: 1200,
            treeWidth: 240,
            treeCollapsed: false,
            dockWidth: 360,
            dockOpen: true,
            dockMode: "pinned",
        });
        expect(result.treeYielded).toBe(true);
        expect(result.mainWidth).toBeGreaterThanOrEqual(MAIN_COMFORT_MIN_WIDTH);
    });
});
