/**
 * task-174（S2b）：**容器 → 页签集合**的唯一派生点。
 *
 * 背景（`D-1525` 用户导航四裁 + `D-1532` 31A + `D-1538` A2）：
 * 页签不再是顶部一条全局浮条，而是**容器的子件**。预设两组容器 —— 左「文件树容器」、
 * 中「内容容器」；每个容器渲染自己的页签行（判据①：容器数 == 页签行数）。
 *
 * **不落盘**（Lead 裁定）：布局事实的唯一 writer 是 dockview 序列化
 * （`useWorkspaceLayout` 的 `dockTabs`/`activeDockTab`/`openTabs`）。容器归属在这里
 * **纯派生**，不新增持久化字段 —— 否则同一个「页签在哪」会有两个 writer，就是本仓反复
 * 翻车的「同一问题两个口径」。
 *
 * **单一定义**：组件模板里不许出现 `placementOf`/`containerOf` 之外的映射判断
 * （写 `id.startsWith("tree")` 这类就是第二套语义）。
 */

/** 容器 id：左树 / 中内容。顺序即渲染顺序，别在模板里另排。 */
export const CONTAINER_IDS = ["tree", "main"] as const;

export type ContainerId = (typeof CONTAINER_IDS)[number];

/** 文件树容器的面板 id；其余一律归内容容器。 */
export const TREE_CONTAINER_PANEL_ID = "tree";

/** 面板/页签 → 所属容器。这是**唯一**映射实现。 */
export function containerOf(tabId: string): ContainerId {
    return tabId === TREE_CONTAINER_PANEL_ID ? "tree" : "main";
}

/**
 * 按容器分组页签（保持入参顺序 ⇒ 页签顺序仍由布局单一 writer 决定，这里只做归类）。
 *
 * 空容器返回空数组而不是缺键：调用方要能不判空就遍历 `CONTAINER_IDS`。
 */
export function groupTabsByContainer<T extends { id: string }>(
    tabs: readonly T[],
): Record<ContainerId, T[]> {
    const grouped: Record<ContainerId, T[]> = { tree: [], main: [] };
    for (const tab of tabs) grouped[containerOf(tab.id)].push(tab);
    return grouped;
}
