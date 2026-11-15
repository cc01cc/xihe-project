/**
 * task-174（S2b）：**容器归属**与**容器可见性**是两个问题，本文件把它们分开。
 *
 * 依据链：`D-1525`（用户导航四裁）→ `D-1532`（31A）→ `D-1538`（A2 两组预设）
 * → **`D-1545`**（用户改判：窄屏「两栏仍是两栏，只是同时只显示一栏，可切换」）。
 *
 * 1 **归属是数据**：`containerOf(tabId)` 只由 tab 决定，**与宽度/mode 无关** ——
 *    `tree` / `main` / `right` 是不变式。同一个 tab 在宽窄两种形态下必须落在同一个容器里；
 *    否则宽窄一来回页签就「搬家」了（`D-1545` 明确禁止）。
 * 2 **可见性是视图**：`visibleContainers(mode, activeColumn)` 只决定**渲染哪些容器行**：
 *    桌面全渲染；窄屏恰一个（`main` 或 `right`，由 `activeColumn` 决定）。
 *
 * **不落盘**：布局事实的唯一 writer 是 `useWorkspaceLayout`（`xihe-layout-ws:<id>`）。
 * 容器归属在这里纯派生；`activeColumn` 也由那份布局持有，本文件不引入第二份状态。
 *
 * **单一定义**：模板里不许出现 `containerOf`/`visibleContainers` 之外的映射判断
 * （写 `id.startsWith("tree")`、或判视口宽度决定归属，都是第二套语义）。
 */

import { DOCK_TAB_IDS } from "../../../composables/useWorkspaceLayout";

export const CONTAINER_IDS = ["tree", "main", "right"] as const;

export type ContainerId = (typeof CONTAINER_IDS)[number];

/** 形态：桌面三栏 / 窄屏单栏（宽度只影响**可见性**，不影响归属）。 */
export type ContainerMode = "desktop" | "single";

/** 窄屏下当前显示哪一栏（`D-1545`：两栏仍是两栏，可切换）。 */
export type ActiveColumn = "main" | "right";

export const TREE_CONTAINER_PANEL_ID = "tree";

/**
 * 右栏面板值域 = 布局层那份 `DOCK_TAB_IDS`（`composables/useWorkspaceLayout.ts:92-100`）。
 * **不复制清单**：右栏有哪些面板仍由布局的单一 writer 决定。
 */
const RIGHT_PANEL_IDS: ReadonlySet<string> = new Set(DOCK_TAB_IDS);

/** 面板/页签 → 所属容器。**唯一**映射实现，且与 mode 无关（不变式）。 */
export function containerOf(tabId: string): ContainerId {
    if (tabId === TREE_CONTAINER_PANEL_ID) return "tree";
    return RIGHT_PANEL_IDS.has(tabId) ? "right" : "main";
}

/**
 * 渲染哪些容器行。
 *
 * - `desktop` ⇒ 三个全渲染（树 / 中栏 / 右栏）；
 * - `single` ⇒ **恰一个**：`activeColumn === "right"` 时只渲染右栏，否则只渲染中栏。
 *   窄屏树是 sheet（不是容器行），所以 `tree` 永远不在 `single` 的可见集合里。
 */
export function visibleContainers(
    mode: ContainerMode,
    activeColumn: ActiveColumn = "main",
): readonly ContainerId[] {
    if (mode === "desktop") return CONTAINER_IDS;
    return [activeColumn];
}

/**
 * 按容器分组页签（保持入参顺序 ⇒ 页签顺序仍由布局单一 writer 决定，这里只做归类）。
 * 三个桶恒在（空桶是空数组），与可见性无关 —— 可见性由 `visibleContainers` 决定。
 */
export function groupTabsByContainer<T extends { id: string }>(
    tabs: readonly T[],
): Record<ContainerId, T[]> {
    const grouped: Record<ContainerId, T[]> = { tree: [], main: [], right: [] };
    for (const tab of tabs) grouped[containerOf(tab.id)].push(tab);
    return grouped;
}
