import {
    computed,
    getCurrentScope,
    onScopeDispose,
    ref,
    watch,
    type InjectionKey,
    type Ref,
} from "vue";
import { useWindowSize } from "@vueuse/core";
import { logger } from "../lib/logger";

/**
 * PLAN-0582 layout owner: the single writer for the application-level geometry
 * (icon rail + navigation panel) and for the per-workspace workbench geometry
 * (file tree + right dock).
 *
 * S2 (user rulings 2026-10-31):
 * - the icon rail is a fixed 56px icon-only strip; the 48<->176 dual state is gone;
 *   **注（PLAN-0762 T2.5 / D-924 2026-11-11）：这条只约束"工作区内部"的视觉语义；就全局条
 *   （GlobalRail）而言它已被 PLAN-0762 supersede —— 全局条要双态（56px 图标 ↔ 图标+文字，
 *   Sidebar collapsible="icon" + ⌘/Ctrl+B + SidebarRail hover），那是跨模块的导航条，
 *   与这里拥有的 navOpen / navWidth 不是同一条状态。工作区 NavPanel 的折叠语义不变。**
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

/**
 * GlobalRail 的展开态宽度（`task-189` / `BL-584`；D-896 要求双态 + 可见切换控件）。
 *
 * **本组件的状态与 `GlobalLayoutState`（navOpen / navWidth）不是同一条**：后者是工作区内部
 * NavPanel 的几何（见本文件顶部 S2 注记）；全局条是跨模块导航，联动会让「收起全局条」
 * 顺带收起工作区导航面板 —— 两个不同的 UI 对象共用一颗开关，是回归不是复用。
 * 因此这里只补**宽度常量**，状态键仍是 GlobalRail 自己的 `xihe-global-rail`（`{ open, width }`
 * 一个对象，折叠态与展开态宽度分开存）。
 */
export const GLOBAL_RAIL_OPEN_WIDTH_DEFAULT = 192;
export const GLOBAL_RAIL_OPEN_WIDTH_MIN = 160;
export const GLOBAL_RAIL_OPEN_WIDTH_MAX = 280;
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

/**
 * 内层 splitter 的折算基准宽：默认树宽 : 默认主列宽（240 : 960）。
 * 仅在量不到几何（ResizeObserver 尚未回调、jsdom 恒为 0）时作为 px ↔ % 的 fallback。
 * 组件与测试**必须引用同一个常量**：任一侧另起一份就会各自演化，同源断言退化成假绿
 * （联动检查抓不到「分叉」）。见 BL-576 / task-94。
 */
export const SPLITTER_REFERENCE_WIDTH = TREE_WIDTH_DEFAULT + 960;

/** Right dock (ruling #3: default closed, 320-480, 360 default). */
export const DOCK_WIDTH_DEFAULT = 360;
export const DOCK_WIDTH_MIN = 320;
export const DOCK_WIDTH_MAX = 480;
export const DOCK_WIDTH_KEYBOARD_STEP = 16;
export const DOCK_MAX_TABS = 6;
/** The dock only joins the flex layout from this width up; below it, it overlays. */
export const DOCK_INLINE_MIN_VIEWPORT = 1800;

/**
 * Dock tabs that have a panel implementation today (S3 adds `context`/`approval`).
 *
 * PLAN-0626 M2: `context` (会话设置) landed as the first *sticky* panel — mounted on
 * first activation and kept alive afterwards, because it holds form state the user is
 * editing (the mount policy lives with the dock, `WorkspaceDock.vue`). `approval` stays
 * a reserved name: approvals keep the modal (D26-14).
 *
 * PLAN-0626 M3 (D26-05): `agents` (工作区 Agent 管理) extends the same value domain — no
 * second tab array, no second tab-id type. Its panel is sticky too (it owns a create form);
 * the whole-page routes and `openTabs` are untouched, so existing deep links keep working.
 *
 * PLAN-0659 T1.4: `delegation`（委派 DAG）同样复用这一份值域与 `DOCK_MAX_TABS` 上限。
 *
 * task-65 A 段（`D-1777` / `D-1778`）：`files`（文件树）加入这一份值域 —— 用户 2026-11-17
 * 「右侧容器显示目录树组件」「中栏容器和右栏容器几乎是等价的」。树此前是**容器级特例**
 * （`lib/containers.ts` 的 `tree` 容器，`center` 组的第一道 SplitterPanel），
 * 而「等价」的可判形式是**任意面板都能投进任一容器** ⇒ 树必须先是普通面板。
 * 已知代价（Lead 采纳、非否决理由）：① `DOCK_MAX_TABS` 上限被树占一格；② `dock-tab-*`
 * 消费面与既有 `workspace-file-rail`/`toolbar-toggle-tree` 成两个入口；③ 树宽语义从
 * splitter% 变 dock px。
 */
export const DOCK_TAB_IDS = [
    "files",
    "code",
    "changes",
    "monitor",
    "members",
    "context",
    "agents",
    "delegation",
] as const;
export type DockTabId = (typeof DOCK_TAB_IDS)[number];

/**
 * C3 (task-217, Lead ruling): the middle tab bar no longer expresses workspace
 * pages — page entries live only in the secondary nav (`WorkspaceSecondaryNav`,
 * derived from `meta.workspacePage`). The bar is now an indicator of the user's
 * open sessions / work items only.
 *
 * A persisted work tab is a session id with the `session:` prefix; legacy page
 * ids ("environment" / "scheduled-tasks" / "settings") never match the prefix,
 * so the read side converges without any hand-written page-id list — which the
 * `workspacePages.ts` invariant forbids (no runtime page list).
 */
export const WORK_TAB_ID_PREFIX = "session:";
export type WorkTabId = `${typeof WORK_TAB_ID_PREFIX}${string}`;

export function isWorkTabId(value: unknown): value is WorkTabId {
    return (
        typeof value === "string" &&
        value.startsWith(WORK_TAB_ID_PREFIX) &&
        value.length > WORK_TAB_ID_PREFIX.length
    );
}

export function workTabIdForSession(sessionId: string): WorkTabId {
    return `${WORK_TAB_ID_PREFIX}${sessionId}`;
}

export function sessionIdFromWorkTab(tab: WorkTabId): string {
    return tab.slice(WORK_TAB_ID_PREFIX.length);
}

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
    /**
     * PLAN-0626 D26-04: "expand the panel" — the dock fills the whole workbench row and
     * the main column is hidden (rendering only: the column stays mounted, so its SSE and
     * streaming state survive). Deliberately **orthogonal** to `dockMode`/`dockWidth`, the
     * same way `dockCollapsed` is: leaving focus restores the previous mode and width with
     * no "remember what it was" field, which a third `dockMode` value would have required.
     */
    dockFocus: boolean;
    /** Work tabs (open sessions) the user chose to keep; the chat tab is implicit and not stored. */
    openTabs: WorkTabId[];
    /**
     * task-174 / `D-1545`（用户裁定：窄屏「两栏仍然是两栏，只是同时间只能显示单栏 可以进行切换」）：
     * 窄屏当前显示哪一栏。**只是可见性**，不改变任何页签的归属（归属是不变式，见
     * `features/workspace/lib/containers.ts` 的 `containerOf`）。
     *
     * 与布局**同源落盘**（同一个 `xihe-layout-ws:<id>`、同一个唯一 writer），不另开第二份状态；
     * 桌面形态读它但不用它（三栏全渲染）。
     */
    activeColumn: ActiveColumn;
    /**
     * task-65 A 段（`D-1777`）/ 用户原话：「点击目录树，可以在中间容器打开具体的文件内容，
     * 当然也支持同一容器中打开」。
     *
     * **「在哪开」的唯一真源**：`FileEditor` 是 `openFiles`/`activeFilePath` 的**单例视图**
     * （`stores/workspace.ts`），所以这里存的是「这个单例挂在哪个容器」，不是两份编辑器实例。
     *
     * **落进既有那个键**（`xihe-layout-ws:<id>`），不新增第二个持久化键 —— `D-1222 ⑥`
     * 禁的是「新增第二份盘」，不是「在这份盘里加字段」。此前 dockview 壳的 `placements`
     * （`WorkspaceShellDockview.vue:146`）明确不落盘，刷新即丢，正是本条要修的缺口。
     */
    openTarget: OpenTarget;
}

/**
 * task-65 A 段：文件内容投到哪个容器。`main` = 中栏容器（`D-1777` 默认），
 * `right` = 右栏容器（用户原话「也支持同一容器中打开」那一半）。
 */
export type OpenTarget = "main" | "right";

export function isOpenTarget(value: unknown): value is OpenTarget {
    return value === "main" || value === "right";
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

export type ActiveColumn = "main" | "right";

export function isActiveColumn(value: unknown): value is ActiveColumn {
    return value === "main" || value === "right";
}

export function isDockTabId(value: unknown): value is DockTabId {
    return typeof value === "string" && (DOCK_TAB_IDS as readonly string[]).includes(value);
}

/**
 * PLAN-0626 D26-06: the dock has a hard tab cap (`DOCK_MAX_TABS`). Opening one more
 * must be a **visible refusal** instead of the previous silent `return` (a click that
 * does nothing reads like a broken button — the N12 "silent failure" pattern). Kept as
 * a pure predicate so the threshold is unit-testable without a DOM.
 */
export function canOpenDockTab(openTabCount: number): boolean {
    // NaN/Infinity cannot describe an open set, so treat them as "room left" (fail-open
    // on a corrupt count, matching the reader's degrade-to-defaults stance).

    return !Number.isFinite(openTabCount) || openTabCount < DOCK_MAX_TABS;
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
/**
 * Raw key existence: true even for an openTabs-only slice (unlike
 * `hasWorkspaceLayout`, which asks about stored *geometry*). The tab bar uses
 * this to decide whether an emptied default set must still be persisted: once
 * any payload exists, skipping the write would resurrect closed tabs on reload.
 */
export function hasWorkspaceLayoutKey(workspaceId: string): boolean {
    const store = storage();
    if (!workspaceId || !store) return false;
    try {
        return store.getItem(workspaceLayoutKey(workspaceId)) !== null;
    } catch {
        return false;
    }
}

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
export function writeWorkspaceOpenTabs(workspaceId: string, openTabs: WorkTabId[]): void {
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
        parsed.openTabs = openTabs.filter(isWorkTabId);
        store.setItem(key, JSON.stringify(parsed));
    } catch (cause) {
        logger.warn("Failed to persist the route tab set", cause);
    }
}

/**
 * task-94 S1（`D-1754 ④` 判据 3「右栏 = 正常列，不得是浮窗/overlay」）：**视口不再决定 dock 形态**。
 *
 * <p>派生值恒为 `pinned` —— <1800 不再是浮窗断点（原实现按 `DOCK_INLINE_MIN_VIEWPORT` 派生 floating，
 * 1600 档实测 `position:absolute` + `z-index:20` + 与主列水平重叠 360px，正是用户要消灭的形态）。
 * 视口过窄时不再「换成浮窗」而是由 `computeWorkbenchSqueeze` 的 `forceSingleColumn` 走单栏（D-1545 既有机制）。</p>
 *
 * <p>**参数保留但不参与判定**：签名与调用点一起改会把规格与消费侧拖进同一批，而本步只需要「派生值恒 pinned」。
 * `_viewportWidth` 保留 `_` 前缀（`noUnusedParameters` 对下划线参数豁免）。</p>
 *
 * <p>退场过程：本步只改派生值；`dockModeManual`、`floating` 渲染分支与 `forceFloating` 的消费侧
 * 在 S2/S4 批次收口（那时 `DockMode` 收窄为单值，本函数整体退役）。</p>
 */
export function deriveDockMode(_viewportWidth: number): DockMode {
    return "pinned";
}

export function defaultWorkspaceLayoutForViewport(viewportWidth: number): WorkspaceLayoutState {
    const defaults = defaultWorkspaceLayout(),
        dockMode = deriveDockMode(viewportWidth);
    /**
     * task-94 S5 / D4（Lead 2026-11-17 裁「D4 必须同批修」）：**两档首启都带 `files` 页签**。
     *
     * <p>为什么不是「后补」：<1800 首启若不给 files 页签，用户看到的是一个没有树的右栏（或干脆没有
     * 右栏），会以为「树不在这个版本里」—— 实测 1600/1440/1280 首启 `renderedDockTabs=0`、
     * 树元素根本不在 DOM。少一个页签不是布局差异，是**功能看起来不存在**。</p>
     *
     * <p>两档的差异只剩「dock 是否已展开」：宽屏展开并把 files 置前（今天的产品形态），窄屏保持收起
     * 但页签与激活项就位 —— 用户点工具栏 files 或展开右栏，看到的就是树。宽度仍取 `dockWidth` 默认。</p>
     */
    const tabs: WorkspaceLayoutState["dockTabs"] = ["files", "monitor"];
    if (Number.isFinite(viewportWidth) && viewportWidth >= DOCK_INLINE_MIN_VIEWPORT) {
        return {
            ...defaults,
            dockCollapsed: false,
            // D-1777/D-1778（task-65 A 段）：宽屏首启右栏默认开 files（目录树）面板，
            // 用户 2026-11-17「右侧容器显示目录树组件」。树是右栏的一个 dock 页签（不占独立容器行）。
            dockTabs: tabs,
            activeDockTab: "files",
            dockMode,
        };
    }
    return {
        ...defaults,
        dockCollapsed: true,
        dockTabs: tabs,
        activeDockTab: "files",
        dockMode,
    };
}

// isWorkTabId: see the C3 block above — the prefix check replaces the old
// closed page-id list, so legacy page ids silently stop validating.

export function defaultGlobalLayout(): GlobalLayoutState {
    return { navOpen: true, navWidth: NAV_WIDTH_DEFAULT };
}

/**
 * C3: pages never enter the tab bar, so the default open set is empty — the
 * chat tab is implicit (it is the fallback) and visiting a session adds its tab.
 */
export function defaultOpenTabs(): WorkTabId[] {
    return [];
}

export function defaultWorkspaceLayout(): WorkspaceLayoutState {
    return {
        treeCollapsed: false,
        treeWidth: TREE_WIDTH_DEFAULT,
        dockCollapsed: true,
        dockWidth: DOCK_WIDTH_DEFAULT,
        dockTabs: [],
        activeDockTab: null,
        // task-94 S1：floating 退场后的**存储默认**。旧键里的 `"floating"` 仍能读（`DockMode` 保留两值），
        // 但渲染侧不再有产生它的路径；读到未知值也按 pinned 落。
        dockMode: "pinned",
        dockModeManual: false,
        dockFocus: false,
        activeColumn: "main",
        openTabs: defaultOpenTabs(),
        // D-1777/D-1778（task-65 A 段，第 12 行 T2）：「同一文件中栏/右栏打开」的投递真源。
        // 默认 "right" = 今天唯一已接线的挂载点（右栏 code 面板）；中栏挂载点与入口 UI 属 C3 后续卡，
        // 字段先落读写净化，刷新后不再丢。
        openTarget: "right",
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
        // task-152：同一把键还有 `standaloneSessionOrder` 一个面 ⇒ 写 nav 时必须**保留**它，
        // 否则每次折叠导航/拖栏宽都会把用户的会话排序清掉。
        const order = readStandaloneSessionOrder();
        store.setItem(
            GLOBAL_LAYOUT_STORAGE_KEY,
            JSON.stringify({
                navOpen: state.navOpen,
                navWidth: clampNavWidth(state.navWidth),
                ...(order.length > 0 ? { standaloneSessionOrder: order } : {}),
            }),
        );
    } catch (cause) {
        logger.warn("Failed to persist the global layout", cause);
    }
}

/* ------------------------------------------------------------------------- *
 * task-152 / `D-1221` ④：独立会话（L3）的用户顺序
 *
 * 落在**既有的** `xihe-layout-global` 里（不建第二把键，`D-1222` ⑥）。本块与
 * `openTarget` / `DOCK_TAB_IDS` / `deriveDockMode` 那几段**物理分离**，便于按 hunk 判归属。
 *
 * 与 `writeGlobalLayout` 的关系：两处写同一把键，各自**保留对方的字段**
 * （nav 写盘时带上 order，order 写盘时带上 nav）⇒ 谁后写都不会抹掉另一方。
 * 已知边界（不是遗漏）：**跨 tab 不做同步** —— 布局状态今天没有 storage/BroadcastChannel
 * 通道（`services/authChannel.ts` 是登出专用先例，不掺入），切 tab / 刷新重读即可。
 * ------------------------------------------------------------------------- */

/** 顺序载荷净化：非数组 ⇒ `[]`；非字符串 / 空串 / 重复项丢弃（与 `openTabs` 同口径）。 */
export function sanitizeSessionOrder(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const order: string[] = [];
    for (const item of value) {
        if (typeof item !== "string" || item.length === 0 || seen.has(item)) continue;
        seen.add(item);
        order.push(item);
    }
    return order;
}

function readGlobalLayoutRaw(store: Storage): Record<string, unknown> | null {
    try {
        const raw = store.getItem(GLOBAL_LAYOUT_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as unknown;
        return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch (cause) {
        // 脏载荷：读方不删键（`readGlobalLayout` 那条路径才删），这里只回落默认。
        logger.warn("Failed to read the global layout payload as JSON", cause);
        return null;
    }
}

/** 读独立会话顺序；缺字段 / 脏载荷 ⇒ `[]`（= 没有自定义顺序，渲染回默认 `updatedAt desc`）。 */
export function readStandaloneSessionOrder(): string[] {
    const store = storage();
    if (!store) return [];
    return sanitizeSessionOrder(readGlobalLayoutRaw(store)?.standaloneSessionOrder);
}

/** 写独立会话顺序；**保留** nav 两个字段（同一把键的两个面，互相不覆盖）。 */
export function writeStandaloneSessionOrder(order: readonly string[]): void {
    const store = storage();
    if (!store) return;
    try {
        const nav = readGlobalLayout();
        store.setItem(
            GLOBAL_LAYOUT_STORAGE_KEY,
            JSON.stringify({
                navOpen: nav.navOpen,
                navWidth: clampNavWidth(nav.navWidth),
                standaloneSessionOrder: sanitizeSessionOrder(order),
            }),
        );
    } catch (cause) {
        logger.warn("Failed to persist the standalone session order", cause);
    }
}

function workspaceLayoutKey(workspaceId: string): string {
    return `${WORKSPACE_LAYOUT_STORAGE_PREFIX}${workspaceId}`;
}

/** Open work tabs are sanitized like dock tabs: prefix-valid ids, no duplicates. */
function readOpenTabs(parsed: Partial<WorkspaceLayoutState>): WorkTabId[] {
    // A missing field means "legacy / never opened a session tab" -> the default
    // (empty) set. Legacy page ids are dropped by the prefix check (C3).
    if (!Array.isArray(parsed.openTabs)) return defaultOpenTabs();
    const openTabs: WorkTabId[] = [];
    for (const tab of parsed.openTabs) {
        if (isWorkTabId(tab) && !openTabs.includes(tab)) openTabs.push(tab);
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
                    : (tabs[0] ?? null),
            dockCollapsed =
                typeof parsed.dockCollapsed === "boolean"
                    ? parsed.dockCollapsed
                    : defaults.dockCollapsed;
        return {
            treeCollapsed:
                typeof parsed.treeCollapsed === "boolean"
                    ? parsed.treeCollapsed
                    : defaults.treeCollapsed,
            treeWidth:
                typeof parsed.treeWidth === "number"
                    ? clampTreeWidth(parsed.treeWidth)
                    : defaults.treeWidth,
            dockCollapsed,
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
            // D26-04: focus is meaningless without a rendered panel, so a payload that says
            // "focused" while the dock is collapsed (or has no tabs) degrades to false
            // instead of storing a state the UI cannot honour.
            dockFocus: parsed.dockFocus === true && !dockCollapsed && tabs.length > 0,
            openTabs: readOpenTabs(parsed),
            // D-1545：缺字段（旧载荷）⇒ 默认中栏，行为与改动前一致。
            activeColumn: isActiveColumn(parsed.activeColumn)
                ? parsed.activeColumn
                : defaults.activeColumn,
            // task-65 A 段：同一条「缺字段 ⇒ 默认」纪律（旧载荷没有这个键 ⇒ 文件开在中栏，
            // 与改动前的行为一致）。**必须在这里净化**，否则刷新后读到越界的字符串会直接把
            // 编辑器挂到不存在的容器上。
            openTarget: isOpenTarget(parsed.openTarget) ? parsed.openTarget : defaults.openTarget,
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
                dockMode: isDockMode(state.dockMode) ? state.dockMode : "pinned",
                dockModeManual: state.dockModeManual,
                // Mirrors the read-side normalization: never persist "focused" for a dock
                // that cannot render (collapsed or tabless).
                dockFocus: state.dockFocus === true && !state.dockCollapsed && tabs.length > 0,
                openTabs: state.openTabs.filter(isWorkTabId),
                activeColumn: isActiveColumn(state.activeColumn) ? state.activeColumn : "main",
                // 与读侧镜像：写侧也过滤，避免把越界值落盘（读写两处必须同口径）。
                openTarget: isOpenTarget(state.openTarget) ? state.openTarget : "main",
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
    /**
     * BL-376：合并写入的 timer 属于**这一次挂载**。卸载时 `onBeforeUnmount` 已 `flush()` 把最后一个值
     * 落盘，之后仍挂着的 timer 不该再写 —— 否则"已死实例的延迟写"会落到下一个使用者身上（测试里是
     * 下一条用例，真实场景是离开页面后仍在写）。因此作用域销毁时**取消**未完成的 timer。
     * 只在 effect scope 内注册：纯函数用法/单测没有 scope，直接 `onScopeDispose` 会告警。
     */
    function cancelPending(): void {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
        pending = null;
    }
    if (getCurrentScope()) onScopeDispose(cancelPending);
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
        // task-504 A：用**实测外壳开销**校正派生行宽（实测优先；没有 DOM 证据时开销记 0 ⇒ 退回旧口径）。
        const overhead = demand?.chromeOverheadMeasured;
        const overheadPx =
            Number.isFinite(overhead) && (overhead ?? 0) > 0 ? Math.round(overhead as number) : 0;
        const workbenchWidth = Math.max(0, (viewportWidth.value || 0) - offset - overheadPx);
        if (!demand) {
            return { mainWidth: workbenchWidth, navYielded: false, forceSingleColumn: false };
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
 * PLAN-0582 S3b §4 anti-squeeze (spec §1.5-C) —— **task-94 S2 后的形态**。
 *
 * <p>有序规则（保护量仍是主列）：① `MAIN_MIN_WIDTH`(640) 是硬底线、优先于一切；
 * ② pinned 右栏让**会话列**先让位（舒适级 720 / 硬底线 640 两级）；③ 会话列让尽仍 <640 ⇒
 * **走单栏**（`forceSingleColumn`，`D-1545` 既有机制）；④ 右栏永不被关（② 不关 dock）。</p>
 *
 * <p>退场的两条旧规则，写在此处防复活：**「右栏先让文件树让位」不成立了** —— 树已是右栏的一个
 * 面板（`D-1777`/`D-1778`），它不再占行宽，把 `treeWidth` 再扣一次就是把右栏宽里已经含着的
 * 那份树宽扣第二遍（实测 1600 档：DOM 主列 1157 / 旧模型算 597）。**「让尽就转 floating」也不成立了**
 * —— `D-1754 ④` 判据 3 禁浮窗，出口改成单栏。</p>
 *
 * <p>纯函数，断点表可无 DOM 单测。</p>
 */
export const MAIN_MIN_WIDTH = 640;
export const MAIN_COMFORT_MIN_WIDTH = 720;

export interface WorkbenchSqueezeInput {
    /** Measured width of the workbench row (rail+panel already excluded). */
    workbenchWidth: number;
    dockWidth: number;
    dockOpen: boolean;
    /** Rendered width of the navigation panel that could yield (0 when closed). */
    navPanelWidth?: number;
    /**
     * task-504（A 步，D-1413 同族）：**实测**工作台行宽。
     *
     * 省掉它就是本卡修的那个缺陷：`squeeze` 原来用 `viewportWidth − (rail + navPanel)` 当行宽，
     * 而真实行宽还要再减 body 而非 viewport 的差值、以及工作台外壳的 gutter（1024 档实测差 ~67px）
     * ⇒ 模型认为 main 688（≥640，不让位），DOM 里只有 621（<640，本该让位）。
     * 提供时一律以实测为准；未提供（无 DOM 的测试环境）才回落派生值。
     */
    workbenchWidthMeasured?: number;
    /**
     * task-504 A 步（**防反馈环**）：实测「外壳开销」= body 内容宽 − 导航渲染宽 − 工作台渲染宽。
     *
     * 为什么不直接喂工作台宽：工作台宽 **依赖导航宽**，而导航宽又是本模型的输出 ⇒ 直接喂会振荡
     * （实测：`waitForFunction` 等稳定 20s 超时）。开销只含滚动条 + 外壳 gutter，与导航宽无关。
     */
    chromeOverheadMeasured?: number;
    /**
     * S3b-style runtime override: `false` when the user just re-opened the nav by
     * hand. Suppresses the *comfort* yield only — the 640 hard floor still wins.
     */
    allowNavYield?: boolean;
}

export interface WorkbenchSqueezeResult {
    /**
     * 两栏形态下的主列宽（会话列让尽之后）。**单栏形态下不适用** —— 那时主列占满整行
     * （`workbenchWidth`），由调用方按 `forceSingleColumn` 自行决定用哪个数。
     */
    mainWidth: number;
    /** The navigation panel has to collapse to its rail so the floor is reachable. */
    navYielded: boolean;
    /**
     * task-94 S2：**这一行装不下「主列 ≥640 + 右栏」，右栏改由单栏切换承载**（`D-1545`）。
     *
     * <p>这是「让尽之后仍破 640」的**唯一出口**：右栏不死（② 不关 dock）、不叠（③ 判据 3 禁浮窗）、
     * 主列不破 640（①），改由两栏轮流占满整行（与移动壳同一语义）。取代旧的 `forceFloating`。</p>
     *
     * <p>右栏折叠（`dockOpen=false`）时恒 false：没有第二栏要分流。</p>
     */
    forceSingleColumn: boolean;
}

/**
 * Pure anti-squeeze evaluation. Inputs are the **rendered** state (that is the S3b
 * P1-2 fix: feeding the persisted state made the toast lie whenever the user had
 * expanded the tree manually) and the output only *adds* collapses/floating on top.
 */
export function computeWorkbenchSqueeze(input: WorkbenchSqueezeInput): WorkbenchSqueezeResult {
    const workbenchWidth = Number.isFinite(input.workbenchWidth) ? input.workbenchWidth : 0;
    const allowNavYield = input.allowNavYield !== false;
    const navPanelWidth = Number.isFinite(input.navPanelWidth)
        ? Math.max(0, input.navPanelWidth ?? 0)
        : 0;
    // task-94 S2：右栏恒为行内列（floating 退场）⇒ 开着就占行宽；**树不再是行内列**
    // （它已是右栏的一个页签，树宽含在 dockWidth 里）⇒ 行宽里不再有树项。
    const dockTakesSpace = input.dockOpen;
    let mainWidth = workbenchWidth - (dockTakesSpace ? input.dockWidth : 0);
    let navYielded = false;

    // ── comfort floor (720), spec §1.5-C rule 2：树让位退场后只剩会话列这一个舒适级杠杆 ──
    if (
        dockTakesSpace &&
        mainWidth < MAIN_COMFORT_MIN_WIDTH &&
        navPanelWidth > 0 &&
        allowNavYield
    ) {
        mainWidth += navPanelWidth;
        navYielded = true;
    }

    // ── hard floor (640)：会话列是最后一个杠杆（连手动重开也要让 —— 底线优先于偏好）──
    if (mainWidth < MAIN_MIN_WIDTH && navPanelWidth > 0 && !navYielded) {
        mainWidth += navPanelWidth;
        navYielded = true;
    }

    /**
     * task-94 S2 / S4：**单栏判定**。会话列让尽之后这一行仍装不下 640 的主列 ⇒「主列 + 右栏同行」
     * 在该视口不成立 ⇒ 两栏轮流占满整行。判据与 ① 640 硬底线是同一个数，没有第二个魔数。
     */
    const forceSingleColumn = dockTakesSpace && mainWidth < MAIN_MIN_WIDTH;

    return { mainWidth, navYielded, forceSingleColumn };
}
