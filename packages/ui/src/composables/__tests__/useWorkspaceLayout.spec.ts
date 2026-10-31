import { beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, ref } from "vue";
import {
    GLOBAL_LAYOUT_STORAGE_KEY,
    NAV_WIDTH_DEFAULT,
    NAV_WIDTH_MAX,
    NAV_WIDTH_MIN,
    RAIL_WIDTH_COLLAPSED,
    RAIL_WIDTH_EXPANDED,
    WORKSPACE_LAYOUT_STORAGE_PREFIX,
    clampNavWidth,
    clearLayoutStorage,
    defaultGlobalLayout,
    readGlobalLayout,
    useWorkspaceLayout,
    writeGlobalLayout,
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

beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
});

describe("global layout storage", () => {
    it("defaults to the icon-only rail with an open default-width panel", () => {
        expect(defaultGlobalLayout()).toEqual({
            railCollapsed: true,
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

    it("round-trips a persisted layout and clamps foreign widths", () => {
        writeGlobalLayout({ railCollapsed: false, navOpen: false, navWidth: 900 });

        expect(readStored()).toEqual({ railCollapsed: false, navOpen: false, navWidth: 360 });
        expect(readGlobalLayout()).toEqual({
            railCollapsed: false,
            navOpen: false,
            navWidth: 360,
        });
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
        writeGlobalLayout({ railCollapsed: false, navOpen: true, navWidth: 300 });
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

describe("useWorkspaceLayout", () => {
    it("derives the main offset from rail + open panel and persists toggles", async () => {
        const scope = effectScope();
        const layout = scope.run(() => useWorkspaceLayout({ isMobile: ref(false) }))!;

        expect(layout.railWidth.value).toBe(RAIL_WIDTH_COLLAPSED);
        expect(layout.mainOffset.value).toBe(RAIL_WIDTH_COLLAPSED + NAV_WIDTH_DEFAULT);

        layout.toggleRail();
        layout.setNavWidth(320);
        await nextTick();

        expect(layout.railWidth.value).toBe(RAIL_WIDTH_EXPANDED);
        expect(layout.mainOffset.value).toBe(RAIL_WIDTH_EXPANDED + 320);
        expect(readStored()).toEqual({
            railCollapsed: false,
            navOpen: true,
            navWidth: 320,
        });

        layout.toggleNav();
        await nextTick();

        expect(layout.mainOffset.value).toBe(RAIL_WIDTH_EXPANDED);

        layout.nudgeNavWidth(1000);
        expect(layout.navWidth.value).toBe(NAV_WIDTH_MAX);
        layout.resetNavWidth();
        expect(layout.navWidth.value).toBe(NAV_WIDTH_DEFAULT);

        scope.stop();
    });

    it("restores a persisted layout and starts collapsed on mobile without persisting", async () => {
        const isMobile = ref(true);
        const scope = effectScope();
        writeGlobalLayout({ railCollapsed: false, navOpen: true, navWidth: 300 });
        const layout = scope.run(() => useWorkspaceLayout({ isMobile }))!;

        // The mobile sheet starts closed and owns no desktop layout preference.
        expect(layout.navOpen.value).toBe(false);
        expect(layout.railWidth.value).toBe(RAIL_WIDTH_EXPANDED);
        expect(layout.mainOffset.value).toBe(0);

        localStorage.removeItem(GLOBAL_LAYOUT_STORAGE_KEY);
        layout.toggleNav();
        layout.toggleRail();
        await nextTick();

        expect(localStorage.getItem(GLOBAL_LAYOUT_STORAGE_KEY)).toBeNull();

        isMobile.value = false;
        layout.setNavWidth(340);
        await nextTick();

        expect(readStored()).toEqual({
            railCollapsed: true,
            navOpen: true,
            navWidth: 340,
        });

        scope.stop();
    });
});
