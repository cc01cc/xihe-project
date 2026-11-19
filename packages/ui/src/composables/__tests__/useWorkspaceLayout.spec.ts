import { beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, ref } from "vue";
import {
    DOCK_MAX_TABS,
    DOCK_TAB_IDS,
    DOCK_WIDTH_DEFAULT,
    DOCK_WIDTH_MAX,
    DOCK_WIDTH_MIN,
    GLOBAL_LAYOUT_STORAGE_KEY,
    MAIN_COMFORT_MIN_WIDTH,
    MAIN_FLOOR_HINT_STORAGE_KEY,
    MAIN_MIN_WIDTH,
    MOBILE_DRAWER_MIN_WIDTH,
    NAV_WIDTH_DEFAULT,
    NAV_WIDTH_MAX,
    NAV_WIDTH_MIN,
    RAIL_WIDTH,
    TREE_WIDTH_DEFAULT,
    TREE_WIDTH_MAX,
    TREE_WIDTH_MIN,
    WORKSPACE_LAYOUT_STORAGE_PREFIX,
    canOpenDockTab,
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
    hasWorkspaceLayout,
    isDockTabId,
    markMainFloorHintShown,
    mobileDrawerWidth,
    readGlobalLayout,
    readWorkspaceLayout,
    useWorkspaceLayout,
    wasMainFloorHintShown,
    writeGlobalLayout,
    writeWorkspaceLayout,
    writeWorkspaceOpenTabs,
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
            // task-94 S1：floating 退场后的**存储默认**是 pinned（旧键里的 "floating" 仍能读，
            // 但渲染侧已没有产生它的路径）；这里跟着改成 pinned，别把 impl 的默认当 bug 改回去。
            dockMode: "pinned",
            dockFocus: false,
            // C3: pages never enter the tab bar; the default open set is empty.
            openTabs: [],
            // D-1545：窄屏当前显示的栏（旧载荷缺字段 ⇒ 读成 main，行为同改动前）。
            activeColumn: "main",
            // task-65 A 段（D-1777/D-1778）：文件内容投到哪个容器的唯一真源，默认右栏
            // （今天唯一已接线的挂载点）。旧载荷缺字段 ⇒ 读成默认，不新增持久化键。
            openTarget: "right",
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
            dockFocus: true,
            openTabs: ["session:s1", "session:s2"],
            activeColumn: "right",
            // task-65 A 段：新字段走的是**同一条往返**（不是「只补默认值」）—— 写 main 读回 main。
            openTarget: "main",
        });

        expect(readStoredWorkspace("ws-1")).toEqual({
            treeCollapsed: true,
            treeWidth: 300,
            dockCollapsed: false,
            dockWidth: 420,
            dockTabs: ["code", "monitor"],
            activeDockTab: "monitor",
            dockMode: "pinned",
            dockFocus: true,
            openTabs: ["session:s1", "session:s2"],
            activeColumn: "right",
            openTarget: "main",
        });
        expect(readWorkspaceLayout("ws-1")).toEqual({
            treeCollapsed: true,
            treeWidth: 300,
            dockCollapsed: false,
            dockWidth: 420,
            dockTabs: ["code", "monitor"],
            activeDockTab: "monitor",
            dockMode: "pinned",
            dockFocus: true,
            openTabs: ["session:s1", "session:s2"],
            activeColumn: "right",
            openTarget: "main",
        });
        // Workspace-scoped: another workspace is untouched.
        expect(readWorkspaceLayout("ws-2")).toEqual(defaultWorkspaceLayout());
    });

    it("only honours a stored focus while the dock can actually render", () => {
        // PLAN-0626 D26-04: "focused" without a rendered panel would hide the main column
        // and leave an empty workbench, so the reader normalizes it away.
        localStorage.setItem(
            `${WORKSPACE_LAYOUT_STORAGE_PREFIX}ws-collapsed`,
            JSON.stringify({ dockCollapsed: true, dockFocus: true }),
        );
        localStorage.setItem(
            `${WORKSPACE_LAYOUT_STORAGE_PREFIX}ws-tabless`,
            JSON.stringify({ dockCollapsed: false, dockTabs: [], dockFocus: true }),
        );

        expect(readWorkspaceLayout("ws-collapsed").dockFocus).toBe(false);
        expect(readWorkspaceLayout("ws-tabless").dockFocus).toBe(false);
    });

    it("never persists a focus the dock cannot render", () => {
        writeWorkspaceLayout("ws-1", { ...defaultWorkspaceLayout(), dockFocus: true });

        // Default layout is collapsed with no tabs, so the flag is dropped on write.
        expect(readStoredWorkspace("ws-1").dockFocus).toBe(false);
    });

    it("treats a payload without dockFocus (pre-0626) as not focused", () => {
        localStorage.setItem(
            `${WORKSPACE_LAYOUT_STORAGE_PREFIX}ws-legacy-focus`,
            JSON.stringify({ dockCollapsed: false, dockTabs: ["code"], activeDockTab: "code" }),
        );

        expect(readWorkspaceLayout("ws-legacy-focus").dockFocus).toBe(false);
        // Nothing else about the legacy payload is reset.
        expect(readWorkspaceLayout("ws-legacy-focus").dockTabs).toEqual(["code"]);
    });

    it("refuses the next dock tab once DOCK_MAX_TABS is reached (D26-06)", () => {
        // Only known ids are allowed, so the cap is exercised through the pure predicate.
        expect(canOpenDockTab(0)).toBe(true);
        expect(canOpenDockTab(DOCK_MAX_TABS - 1)).toBe(true);
        expect(canOpenDockTab(DOCK_MAX_TABS)).toBe(false);
        expect(canOpenDockTab(DOCK_MAX_TABS + 1)).toBe(false);
        // A corrupt count cannot describe an open set: fail open, like the other readers.
        expect(canOpenDockTab(Number.NaN)).toBe(true);
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

    it("seeds the files+monitor dock default at both breakpoints, opening it only on wide screens", () => {
        /**
         * 为什么宽屏首启带 `files` 是【期望行为】而不是副作用（card task-139/157 的问题）：
         * `task-94 S5 / D4`（Lead 2026-11-17 裁「D4 必须同批修」）明写**两档首启都带 files 页签**，
         * 与 `task-65 A 段`（`D-1777`/`D-1778`，「右侧容器显示目录树组件」）同源。
         * 反面实证就在 D4 里：<1800 首启若不给 files 页签，`renderedDockTabs=0`、树根本不在 DOM ⇒
         * 用户会以为「树不在这个版本里」。少一个页签不是布局差异，是**功能看起来不存在**。
         * ⇒ 两档唯一差异是「dock 是否已展开」：宽屏展开且 files 在前，窄屏收起但页签与激活项就位。
         */
        const wide = defaultWorkspaceLayoutForViewport(1920);
        expect(wide.dockCollapsed).toBe(false);
        expect(wide.dockTabs).toEqual(["files", "monitor"]);
        expect(wide.activeDockTab).toBe("files");

        const narrow = defaultWorkspaceLayoutForViewport(1440);
        expect(narrow.dockCollapsed).toBe(true);
        expect(narrow.dockTabs).toEqual(["files", "monitor"]);
        expect(narrow.activeDockTab).toBe("files");
        // S3a audit P1-1 (S3b fix): an openTabs-only payload is NOT stored geometry,
        // so the first-run policy still applies; any geometry field flips it.
        localStorage.setItem("xihe-layout-ws:ws-1", JSON.stringify({ openTabs: [] }));
        expect(hasWorkspaceLayout("ws-1")).toBe(false);
        expect(hasWorkspaceLayout("ws-2")).toBe(false);
        localStorage.setItem("xihe-layout-ws:ws-3", JSON.stringify({ dockCollapsed: true }));
        expect(hasWorkspaceLayout("ws-3")).toBe(true);
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

    // task-162 ①（原 task-94 S1 那条「deriveDockMode 恒 pinned」的改写）：`deriveDockMode` 已随
    // 类型收窄整体删除 —— 本用例现在钉的是它的**存续义务**：首启布局在**每个宽度**都落 pinned，
    // 且旧键里的 "floating" 被归一到 pinned（收窄的归一语义，不是宽容）。
    it("pins the dock mode at every viewport and normalizes a legacy floating key to pinned", () => {
        for (const viewport of [2560, 1920, 1800, 1799, 1440, 1280, 1024, 768, 0, Number.NaN]) {
            expect(defaultWorkspaceLayoutForViewport(viewport).dockMode).toBe("pinned");
        }
        // 手拼旧形态载荷（不走类型默认）："floating" 是收窄前的合法值，读侧必须归一到 pinned。
        localStorage.setItem(
            `${WORKSPACE_LAYOUT_STORAGE_PREFIX}ws-1`,
            JSON.stringify({
                treeCollapsed: false,
                dockTabs: ["files"],
                activeDockTab: "files",
                dockMode: "floating",
            }),
        );
        expect(readWorkspaceLayout("ws-1").dockMode).toBe("pinned");
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

    // task-162 ①：`dockModeManual` 字段已删（没有两态就没有「手动覆盖」）。本用例现在钉的是
    // **旧键兼容**：带着 `dockModeManual` 的旧载荷仍能读（多出来的键被忽略），dockMode 落 pinned。
    it("reads a legacy payload with the retired manual flag without failing", () => {
        localStorage.setItem(
            `${WORKSPACE_LAYOUT_STORAGE_PREFIX}ws-1`,
            JSON.stringify({ ...defaultWorkspaceLayout(), dockModeManual: true }),
        );
        const layout = readWorkspaceLayout("ws-1");
        expect(layout.dockMode).toBe("pinned");
        expect("dockModeManual" in layout).toBe(false);
    });

    // S3b P1-1 (audit): there is no dismissal latch any more — a stored value is the
    // truth, so an explicit re-open must survive the next load.
    it("keeps an explicitly re-opened dock open on the next load", () => {
        writeWorkspaceLayout("ws-1", { ...defaultWorkspaceLayout(), dockCollapsed: false });
        expect(readWorkspaceLayout("ws-1").dockCollapsed).toBe(false);
    });

    // S3a audit P1-1 (S3b fix): an openTabs-only payload is not "layout chosen yet".
    it("treats an openTabs-only payload as no stored geometry", () => {
        writeWorkspaceOpenTabs("ws-1", ["session:s1"]);
        expect(hasWorkspaceLayout("ws-1")).toBe(false);
        // ...and it still preserves whatever geometry is written later.
        writeWorkspaceLayout("ws-1", { ...defaultWorkspaceLayout(), dockCollapsed: false });
        expect(hasWorkspaceLayout("ws-1")).toBe(true);
        // task-126 / O3（口径翻转，原断言写的是「整份写赢、把分片覆盖成空集」）：整份写**不拥有**
        // openTabs —— 它载荷里的是挂载时的快照，用它覆盖分片正是「关掉的页签刷新后复活」的成因。
        // 现在整份写只加几何，页签分片原样保留。回归用例见
        // `stores/__tests__/containerPersistence.spec.ts`。
        expect(readWorkspaceLayout("ws-1").openTabs).toEqual(["session:s1"]);
        expect(readWorkspaceLayout("ws-1").dockCollapsed).toBe(false);
    });

    it("patches only the openTabs slice instead of clobbering the stored geometry", () => {
        writeWorkspaceLayout("ws-1", {
            ...defaultWorkspaceLayout(),
            dockCollapsed: false,
            dockTabs: ["monitor"],
            activeDockTab: "monitor",
        });
        writeWorkspaceOpenTabs("ws-1", ["session:s1", "session:s2"]);
        const layout = readWorkspaceLayout("ws-1");
        expect(layout.openTabs).toEqual(["session:s1", "session:s2"]);
        expect(layout.dockCollapsed).toBe(false);
        expect(layout.dockTabs).toEqual(["monitor"]);
        expect(layout.activeDockTab).toBe("monitor");
    });

    // C3 (task-217, Lead criterion): legacy page ids are dropped on read and the
    // first write converges the stored payload — only the session work tab survives.
    it("converges legacy page ids out of openTabs (C3 read-side ignore)", () => {
        localStorage.setItem(
            "xihe-layout-ws:ws-1",
            JSON.stringify({ openTabs: ["environment", "settings", "session:s-1"] }),
        );
        const layout = readWorkspaceLayout("ws-1");
        expect(layout.openTabs).toEqual(["session:s-1"]);
        writeWorkspaceOpenTabs("ws-1", layout.openTabs);
        const raw = localStorage.getItem("xihe-layout-ws:ws-1") ?? "";
        expect(raw).not.toContain("environment");
        expect(raw).not.toContain("settings");
        expect(raw).toContain("session:s-1");
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

    // BL-376：合并写入的 timer 不能活过它所属的作用域 —— 否则"已死实例的延迟写"会落到下一个
    // 使用者身上（测试里是下一条用例，真实场景是离开页面后仍在写）。
    it("does not persist a pending coalesced write after its scope is disposed (BL-376)", async () => {
        const scope = effectScope();
        const writer = scope.run(() => createWorkspaceLayoutWriter("ws-376", 20))!;
        writer.schedule({ ...defaultWorkspaceLayout(), treeWidth: 300 });
        const key = `${WORKSPACE_LAYOUT_STORAGE_PREFIX}ws-376`;
        expect(localStorage.getItem(key)).toBeNull();

        scope.stop();
        await new Promise((resolve) => setTimeout(resolve, 60));

        expect(localStorage.getItem(key)).toBeNull();
    });

    // 对照组：作用域还在时同样的 timer 会写 —— 证明上一条测的是"销毁"，不是"timer 根本没排上"。
    it("still persists when the scope stays alive (BL-376 control)", async () => {
        const scope = effectScope();
        const writer = scope.run(() => createWorkspaceLayoutWriter("ws-376b", 20))!;
        writer.schedule({ ...defaultWorkspaceLayout(), treeWidth: 260 });

        await new Promise((resolve) => setTimeout(resolve, 60));

        expect(readWorkspaceLayout("ws-376b").treeWidth).toBe(260);
        scope.stop();
    });

    /**
     * task-94 S2：**行宽里没有树项**。树是右栏的一个面板（`D-1777`/`D-1778`），树宽已经含在
     * `dockWidth` 里；旧实现同时扣 `treeWidth` 与 `dockWidth` 是**重复扣**（实测 1600 档：
     * DOM 主列 1157 / 旧模型算 597）。所以这一组用例的输入里不再有 `treeWidth`/`treeCollapsed`。
     */
    it("computes the two-column main width from the dock alone (no tree term, task-94 S2)", () => {
        expect(
            computeWorkbenchSqueeze({ workbenchWidth: 1804, dockWidth: 360, dockOpen: true }),
        ).toEqual({ mainWidth: 1444, navYielded: false });
        // 右栏收起 ⇒ 整行都是主列。
        expect(
            computeWorkbenchSqueeze({ workbenchWidth: 1804, dockWidth: 360, dockOpen: false }),
        ).toEqual({ mainWidth: 1804, navYielded: false });
    });

    it("yields the navigation panel at the comfort floor", () => {
        const squeezed = computeWorkbenchSqueeze({
            workbenchWidth: 1000,
            navPanelWidth: 240,
            dockWidth: 360,
            dockOpen: true,
        });
        expect(squeezed.navYielded).toBe(true);
        expect(squeezed.mainWidth).toBe(880);
        expect(squeezed.mainWidth).toBeGreaterThanOrEqual(MAIN_COMFORT_MIN_WIDTH);
    });

    it("lets the main column break the 640 floor instead of switching shape (D-1829)", () => {
        // 会话列已让尽（navPanelWidth 0）后只剩 540 ⇒ **主列就破 640**：两栏保持同行，
        // 模型原样返回 <640 的主列宽（首次破线的一次性提示由 UI 层给，不进纯函数）。
        const squeezed = computeWorkbenchSqueeze({
            workbenchWidth: 900,
            navPanelWidth: 0,
            dockWidth: 360,
            dockOpen: true,
        });
        expect(squeezed.mainWidth).toBe(540);
        expect(squeezed.mainWidth).toBeLessThan(MAIN_MIN_WIDTH);
        // 右栏不死也不被关：结果里根本没有「形态切换」这个出口了。
        // 同一宽度但右栏收起 ⇒ 整行归主列，自然不破线。
        expect(
            computeWorkbenchSqueeze({
                workbenchWidth: 900,
                navPanelWidth: 0,
                dockWidth: 360,
                dockOpen: false,
            }).mainWidth,
        ).toBe(900);
    });

    it("uses 640 as the report line only (no second magic number, D-1829)", () => {
        // 1000 - 360 = 640 ⇒ 恰好在线；再少 1px ⇒ 破线。两种情况的返回值只差 mainWidth，
        // 形态永不切换 —— 640 从「硬底线」降级为「提示线」。
        const onTheLine = computeWorkbenchSqueeze({
            workbenchWidth: 1000,
            dockWidth: 360,
            dockOpen: true,
        });
        expect(onTheLine.mainWidth).toBe(MAIN_MIN_WIDTH);
        const below = computeWorkbenchSqueeze({
            workbenchWidth: 999,
            dockWidth: 360,
            dockOpen: true,
        });
        expect(below.mainWidth).toBe(MAIN_MIN_WIDTH - 1);
    });

    it("never yields the dock itself: the row gives way in the order nav to broken floor", () => {
        // 一条纵向检查：无论多窄，结果里都没有「关掉右栏」这种出口，只有 navYielded 与
        // 破不破 640 两种结局。800 档：先让会话列（舒适级），让完 680 ≥ 640 ⇒ 不破线。
        const narrow = computeWorkbenchSqueeze({
            workbenchWidth: 800,
            navPanelWidth: 240,
            dockWidth: 360,
            dockOpen: true,
        });
        expect(narrow.navYielded).toBe(true);
        expect(narrow.mainWidth).toBe(680);
        expect(narrow.mainWidth).toBeGreaterThanOrEqual(MAIN_MIN_WIDTH);
    });

    /**
     * task-94 S2 的**退场清单**（写在用例里，防止有人把旧行为当「还要支持」加回来）：
     *
     * - `treeYielded`（让树先收起）：树不再占行宽 ⇒ 没有可让的项；`#files` 面板的 rail 折叠现在
     *   只跟用户的 `treeCollapsed`（task-144 ③）。
     * - `treeOverflow` / `allowTreeYield`（手工展开后主列破 640 时报一次提示）：破不了 ⇒ 提示退场。
     * - `forceFloating`（让尽就转浮窗）：`D-1754 ④` 判据 3 禁浮窗。
     * - `forceSingleColumn`（让尽就切单栏，task-94 S2 的出口）：`D-1829`（条目 58B）用户裁
     *   「主列允许破 640 + 一次提示」⇒ 桌面恒两栏，单栏出口退场（移动壳 `isMobile` 单栏是
     *   `D-1545` 既有机制，不受影响）。字段从结果类型里**物理删除** —— 想复活先在编译期过红线。
     */
});

describe("PLAN-0582 S5-W2: navigation panel yields (spec 1.5-C rule 2)", () => {
    // Shell arithmetic: rail 56 + clamped panel (240 below 1280, 260 at 1280-1439, 280 above).
    const navPanelWidth = (viewport) => (viewport < 1280 ? 240 : viewport < 1440 ? 260 : 280);
    const workbenchWidth = (viewport) => viewport - RAIL_WIDTH - navPanelWidth(viewport);

    it("yields the navigation panel so the 640 floor becomes reachable", () => {
        const viewport = 1100;
        const result = computeWorkbenchSqueeze({
            workbenchWidth: workbenchWidth(viewport), // 1100 - 56 - 240 = 804
            navPanelWidth: navPanelWidth(viewport),
            dockWidth: 360,
            dockOpen: true,
        });
        expect(result.navYielded).toBe(true);
        expect(result.mainWidth).toBe(804 - 360 + 240); // 684
        expect(result.mainWidth).toBeGreaterThanOrEqual(MAIN_MIN_WIDTH);
    });

    it("yields at the comfort floor and lets the main column break 640 when that is not enough (D-1829)", () => {
        const viewport = 900;
        const result = computeWorkbenchSqueeze({
            workbenchWidth: workbenchWidth(viewport), // 604
            navPanelWidth: navPanelWidth(viewport),
            dockWidth: 360,
            dockOpen: true,
        });
        // 604 - 360 = 244 < 720（舒适线）⇒ 会话列让位 ⇒ 484，仍 < 640 ⇒ **破线**（D-1829：
        // 不再切单栏）。这条钉的是**两级一起发生**：让位不改变「还装不下」的事实，
        // 484 原样返回交给 UI 层做一次性提示。
        expect(result.navYielded).toBe(true);
        expect(result.mainWidth).toBe(484);
        expect(result.mainWidth).toBeLessThan(MAIN_MIN_WIDTH);
    });

    it("restores the navigation panel automatically when the window grows again", () => {
        const demand = { dockWidth: 360, dockOpen: true };
        const narrow = computeWorkbenchSqueeze({
            workbenchWidth: workbenchWidth(900),
            navPanelWidth: navPanelWidth(900),
            ...demand,
        });
        expect(narrow.navYielded).toBe(true);

        // Same runtime state, wider window: the yield is not persisted, so it is gone.
        const wide = computeWorkbenchSqueeze({
            workbenchWidth: workbenchWidth(1920),
            navPanelWidth: navPanelWidth(1920),
            ...demand,
        });
        expect(wide.navYielded).toBe(false);
        expect(wide.mainWidth).toBe(1920 - RAIL_WIDTH - navPanelWidth(1920) - 360);
    });

    it("does not yield the navigation panel when nothing is squeezed", () => {
        const roomy = computeWorkbenchSqueeze({
            workbenchWidth: workbenchWidth(1920),
            navPanelWidth: navPanelWidth(1920),
            dockWidth: 360,
            dockOpen: true,
        });
        expect(roomy.navYielded).toBe(false);
        expect(roomy.mainWidth).toBeGreaterThanOrEqual(MAIN_COMFORT_MIN_WIDTH);

        // A closed nav panel has nothing to yield either (no false positive).
        const closed = computeWorkbenchSqueeze({
            workbenchWidth: 900 - RAIL_WIDTH,
            navPanelWidth: 0,
            dockWidth: 360,
            dockOpen: false,
        });
        expect(closed.navYielded).toBe(false);
        expect(closed.mainWidth).toBe(900 - RAIL_WIDTH);
    });

    it("keeps 1024px two-column with a broken floor now that the tree no longer pads the row (D-1829)", () => {
        const viewport = 1024;
        const result = computeWorkbenchSqueeze({
            workbenchWidth: workbenchWidth(viewport), // 728
            navPanelWidth: navPanelWidth(viewport),
            dockWidth: 360,
            dockOpen: true,
        });
        expect(result.navYielded).toBe(true);
        expect(result.mainWidth).toBe(608); // 728 - 360 + 240，仍差 32px ⇒ 破线，两栏同行
        expect(result.mainWidth).toBeLessThan(MAIN_MIN_WIDTH);
    });
});

// PLAN-0623 U1/U4：新增 dock tab 不得影响既有持久化，也不得默认打开。
describe("PLAN-0623 members dock tab", () => {
    it("knows the members tab id", () => {
        expect(DOCK_TAB_IDS).toContain("members");
        expect(isDockTabId("members")).toBe(true);
        // 旧 id 仍然有效（不能因为加新 id 把旧值判废）。
        expect(isDockTabId("monitor")).toBe(true);
    });

    it("keeps a workspace whose stored tabs predate the members tab", () => {
        localStorage.setItem(
            `${WORKSPACE_LAYOUT_STORAGE_PREFIX}ws-legacy`,
            JSON.stringify({
                dockCollapsed: false,
                dockTabs: ["code", "changes", "monitor"],
                activeDockTab: "changes",
            }),
        );

        const stored = readWorkspaceLayout("ws-legacy");
        // 不注入 members、不重置成默认值、active 保持原样。
        expect(stored.dockTabs).toEqual(["code", "changes", "monitor"]);
        expect(stored.activeDockTab).toBe("changes");
        expect(stored.dockCollapsed).toBe(false);
        // 默认布局里也没有 members（⇒ 不会被动打开）。
        expect(defaultWorkspaceLayout().dockTabs).toEqual([]);
        expect(defaultWorkspaceLayout().activeDockTab).toBeNull();
    });
});

// PLAN-0626 M2：context 是第一个"粘性"面板（切走不卸载，策略在 WorkspaceDock）。
describe("PLAN-0626 context dock tab", () => {
    it("knows the context tab id without treating reserved names as tabs", () => {
        expect(DOCK_TAB_IDS).toContain("context");
        expect(isDockTabId("context")).toBe(true);
        // Reserved name, no panel yet (approvals stay a modal, D26-14).
        expect(isDockTabId("approval")).toBe(false);
    });

    it("knows the delegation tab id (PLAN-0659 T1.4)", () => {
        expect(DOCK_TAB_IDS).toContain("delegation");
        expect(isDockTabId("delegation")).toBe(true);
        // `DOCK_MAX_TABS` 约束的是**同时打开**的 tab 数，不是可选 id 的个数；「加到 7 个 id
        // 之后仍然只有 6 个能同时打开」由上面的 clamp 用例守护。
        expect(new Set(DOCK_TAB_IDS).size).toBe(DOCK_TAB_IDS.length);
        expect(DOCK_MAX_TABS).toBeLessThanOrEqual(DOCK_TAB_IDS.length);
        // 新 tab 不默认打开（既有布局零迁移）。
        expect(defaultWorkspaceLayout().dockTabs).toEqual([]);
    });

    it("keeps a pre-M2 payload (four ids) valid without injecting context", () => {
        localStorage.setItem(
            `${WORKSPACE_LAYOUT_STORAGE_PREFIX}ws-pre-context`,
            JSON.stringify({
                dockCollapsed: false,
                dockTabs: ["code", "changes", "monitor", "members"],
                activeDockTab: "monitor",
            }),
        );

        const stored = readWorkspaceLayout("ws-pre-context");
        expect(stored.dockTabs).toEqual(["code", "changes", "monitor", "members"]);
        expect(stored.activeDockTab).toBe("monitor");
        expect(defaultWorkspaceLayout().dockTabs).toEqual([]);
    });
});

/**
 * D-1828（条目 57B）：移动抽屉开态宽度守卫。
 *
 * <p>背景取证：batch-4 的「移动态会话行 21px 纯图标」读数出自**关态**抽屉探针（宽 0 + overflow
 * hidden 把行压成图标宽），task-58 开态复测 247.6px、标题可见。用户仍裁 B（显示截断标题）⇒ 这道
 * 纯函数守卫的是开态：视口首拍未量到（available ≤ 0）不得给出负宽度；正常开态不得窄于
 * `MOBILE_DRAWER_MIN_WIDTH`（被 available 封顶，永远不出视口）。</p>
 */
describe("D-1828 mobileDrawerWidth（移动抽屉开态宽度守卫）", () => {
    it("keeps the stored width when the viewport comfortably fits it", () => {
        // 390px 手机：min(280, 374) = 280 —— 既有主路径不动。
        expect(mobileDrawerWidth(280, 390)).toBe(280);
        expect(mobileDrawerWidth(NAV_WIDTH_MAX, 390)).toBe(NAV_WIDTH_MAX);
    });

    it("never returns a negative width when the viewport has not been measured yet", () => {
        // useWindowSize 首拍为 0：旧算式 min(280, -16) = -16 ⇒ 抽屉结构性消失。
        // 负例：任何 available ≤ 0 的输入都必须退回存储宽（≥ NAV_WIDTH_MIN，标题列健在）。
        expect(mobileDrawerWidth(280, 0)).toBe(280);
        expect(mobileDrawerWidth(280, 16)).toBe(280);
        expect(mobileDrawerWidth(280, -100)).toBe(280);
    });

    it("floors at MOBILE_DRAWER_MIN_WIDTH but never beyond the viewport", () => {
        // 视口 256：available 240 ⇒ 240（下限与 available 恰好相等）。
        expect(mobileDrawerWidth(280, 256)).toBe(240);
        // 视口 200：available 184 < 下限 ⇒ 取 available（不出视口，也守「不为负」）。
        expect(mobileDrawerWidth(280, 200)).toBe(184);
    });

    it("sanitizes a corrupt stored width like every other width reader", () => {
        expect(mobileDrawerWidth(Number.NaN, 390)).toBe(NAV_WIDTH_DEFAULT);
        expect(mobileDrawerWidth(10_000, 390)).toBe(NAV_WIDTH_MAX);
        expect(mobileDrawerWidth(280, Number.NaN)).toBe(280);
    });

    it("never narrows below the title-bearing floor in any open-drawer scenario", () => {
        // 横扫：存储宽全档 × 视口 240..430，开态结果要么 = min(存储, available)，
        // 要么 = 下限（仍 ≤ available）。不存在「图标栏宽度」的输出。
        for (let viewport = 240; viewport <= 430; viewport += 1) {
            for (const stored of [NAV_WIDTH_MIN, NAV_WIDTH_DEFAULT, NAV_WIDTH_MAX]) {
                const width = mobileDrawerWidth(stored, viewport);
                const available = viewport - 16;
                expect(width).toBeGreaterThan(0);
                expect(width).toBeLessThanOrEqual(Math.max(available, 0) || NAV_WIDTH_MAX);
                expect(width).toBeGreaterThanOrEqual(
                    Math.min(MOBILE_DRAWER_MIN_WIDTH, Math.max(available, 0)),
                );
            }
        }
    });
});

/**
 * D-1829（条目 58B）：主列破 640 的一次性提示标记。
 *
 * <p>「不是每次」的判据落在这里：标记落 `xihe-main-floor-hint-shown`，`clearLayoutStorage`
 * （登出/切账号）必须把它一起清掉 —— 否则下一个账号继承「已提示」状态，永远看不到这条说明。</p>
 */
describe("D-1829 main-floor hint flag（一次性提示标记）", () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it("defaults to not-shown, flips on mark, and reads back idempotently", () => {
        expect(wasMainFloorHintShown()).toBe(false);
        markMainFloorHintShown();
        expect(wasMainFloorHintShown()).toBe(true);
        expect(localStorage.getItem(MAIN_FLOOR_HINT_STORAGE_KEY)).toBe("1");
        // 再记一次不抛、不变。
        markMainFloorHintShown();
        expect(wasMainFloorHintShown()).toBe(true);
    });

    it("is cleared together with the layout keys on logout (clearLayoutStorage)", () => {
        markMainFloorHintShown();
        localStorage.setItem(
            GLOBAL_LAYOUT_STORAGE_KEY,
            JSON.stringify({ navOpen: true, navWidth: 280 }),
        );
        expect(wasMainFloorHintShown()).toBe(true);

        clearLayoutStorage();

        expect(wasMainFloorHintShown()).toBe(false);
        expect(localStorage.getItem(MAIN_FLOOR_HINT_STORAGE_KEY)).toBeNull();
        expect(localStorage.getItem(GLOBAL_LAYOUT_STORAGE_KEY)).toBeNull();
    });

    it("treats a corrupted flag payload as not-shown (fail-open: hint may repeat, never vanish)", () => {
        localStorage.setItem(MAIN_FLOOR_HINT_STORAGE_KEY, "not-a-flag");
        expect(wasMainFloorHintShown()).toBe(false);
    });
});
