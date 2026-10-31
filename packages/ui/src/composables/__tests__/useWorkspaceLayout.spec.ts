import { beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, ref } from "vue";
import {
    DOCK_MAX_TABS,
    DOCK_WIDTH_DEFAULT,
    DOCK_WIDTH_MAX,
    DOCK_WIDTH_MIN,
    GLOBAL_LAYOUT_STORAGE_KEY,
    NAV_WIDTH_DEFAULT,
    NAV_WIDTH_MAX,
    NAV_WIDTH_MIN,
    RAIL_WIDTH,
    WORKSPACE_LAYOUT_STORAGE_PREFIX,
    clampDockWidth,
    clampNavWidth,
    clearLayoutStorage,
    defaultGlobalLayout,
    defaultWorkspaceLayout,
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
            dockCollapsed: true,
            dockWidth: DOCK_WIDTH_DEFAULT,
            dockTabs: [],
            activeDockTab: null,
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
            dockCollapsed: false,
            dockWidth: 420,
            dockTabs: ["code", "monitor"],
            activeDockTab: "monitor",
        });

        expect(readStoredWorkspace("ws-1")).toEqual({
            treeCollapsed: true,
            dockCollapsed: false,
            dockWidth: 420,
            dockTabs: ["code", "monitor"],
            activeDockTab: "monitor",
        });
        expect(readWorkspaceLayout("ws-1")).toEqual({
            treeCollapsed: true,
            dockCollapsed: false,
            dockWidth: 420,
            dockTabs: ["code", "monitor"],
            activeDockTab: "monitor",
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
        expect(layout.mainOffset.value).toBe(RAIL_WIDTH + NAV_WIDTH_DEFAULT);

        layout.setNavWidth(320);
        await nextTick();

        expect(layout.mainOffset.value).toBe(RAIL_WIDTH + 320);
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
