/**
 * PLAN-0756：dock 区 dockview 集成 —— **纯逻辑层**（决策 #18，jsdom 可测）。
 *
 * dockview 是 DOM 布局库，jsdom 下不可用（硬需 ResizeObserver），故把所有可单测的
 * 逻辑抽成**不 import dockview 的纯函数**：序列化桥、布局选项、主题映射。组件层
 * （`WorkspaceDock.vue`）只做薄粘合，集成验证归 Playwright e2e。
 */

/** dockview 序列化里一个组（leaf）的 data 形状：`id` = 组 id，views = 打开的面板。 */
export interface DockviewSerializedLeafData {
    id?: string;
    views?: string[];
    activeView?: string;
}

/** dockview 序列化里的一个组节点（grid 内嵌组或 floating 组，两者 data 同形）。 */
export interface DockviewSerializedGroup {
    data?: DockviewSerializedLeafData;
    size?: number;
}

/** 序列化后的 dockview 布局（只取本桥需要的字段，结构对齐 dockview `toJSON()` 输出）。 */
export interface DockviewSerializedLayout {
    grid?: {
        root?: {
            data?: DockviewSerializedGroup[];
        };
    };
    panels?: Record<string, unknown>;
    floatingGroups?: DockviewSerializedGroup[];
    activeGroup?: string;
}

/** 选组判据：见 `bridgeDockviewLayout` 的选组顺序。 */
export interface BridgeDockviewOptions {
    /**
     * 目标组 id（dockview 序列化里的 `leaf.data.id`）。
     * **双 group 之后必须给**：首个 leaf 是中栏组，不给就会把 `tree+main` 读成 `dockTabs`。
     */
    groupId?: string;
    /**
     * 备选判据：组内 views **全部**属于这份面板 id 名单的组。组 id 尚未稳定时用
     * （例如首次 `addPanel` 还没落盘），比 id 判据弱但比「首个 leaf」强得多。
     */
    panelIds?: readonly string[];
    /**
     * 找不到匹配组时是否退回「首个含 views 的 leaf」（单 group 时代的兼容行为）。
     * 默认 `true` 保持旧调用方不变；**双 group 调用方应显式传 `false`**，
     * 让读错组这件事变成「空结果」而不是「读到中栏组」。
     */
    fallbackToFirstLeaf?: boolean;
}

/**
 * 全局生效的 dockview 选项（决策 #17 的强制落点）。
 *
 * `proportionalLayout: false` —— POC 实测默认 true 会在视口变化时把渲染宽度**写回**
 * 序列化 `grid.root.data[].size`（`[240,640,360,680]→[160,427,240,453]`），违反 PLAN-0582
 * 「clamp 不写回」不变式。XH 持久宽度是用户拖出的绝对值，故必须关比例分配。
 */
export const DOCKVIEW_OPTIONS = { proportionalLayout: false } as const;

/** 取一个组的 views（非数组 / 空数组 / 非字符串一律视为「这个组没打开面板」）。 */
function viewsOf(group: DockviewSerializedGroup | undefined): string[] | null {
    const views = group?.data?.views;
    if (!Array.isArray(views) || views.length === 0) return null;
    return views.filter((v): v is string => typeof v === "string");
}

/**
 * 序列化桥：`dockview toJSON()` → XH 布局语义（`dockTabs` / `activeDockTab` / `dockWidth`）。
 * 纯函数、不碰 DOM、不 import dockview —— 可在 jsdom 直接单测。
 *
 * **选组顺序**（task-369 S1 正确性前提）：
 *   1. `options.groupId` 命中的组；
 *   2. `options.panelIds` 判据命中的组（组内 views 全部在名单里）；
 *   3. `fallbackToFirstLeaf !== false` 时退回首个含 views 的组（单 group 兼容）。
 *
 * 候选同时覆盖 `grid.root.data` 与 `floatingGroups`：dock 转 floating 后**不在 grid 里**
 * （POC ② 实测 `toJSON()` 的 `floatingGroups` 独立序列化），只看 grid 会把 floating 的 dock
 * 读成「没打开任何 tab」。
 *
 * `size` 是组在其所在分支里的宽度，对应 XH 的 `dockWidth`。
 */
export function bridgeDockviewLayout(
    json: DockviewSerializedLayout | null | undefined,
    options: BridgeDockviewOptions = {},
): {
    dockTabs: string[];
    activeDockTab: string | null;
    dockWidth: number | null;
} {
    const empty: { dockTabs: string[]; activeDockTab: string | null; dockWidth: number | null } = {
        dockTabs: [],
        activeDockTab: null,
        dockWidth: null,
    };
    if (!json || typeof json !== "object") return { ...empty };

    const groups: DockviewSerializedGroup[] = [
        ...(json.grid?.root?.data ?? []),
        ...(json.floatingGroups ?? []),
    ];

    let chosen: DockviewSerializedGroup | undefined;
    if (options.groupId) {
        chosen = groups.find((g) => g?.data?.id === options.groupId && viewsOf(g) !== null);
    }
    if (!chosen && options.panelIds && options.panelIds.length > 0) {
        const allowed = new Set(options.panelIds);
        chosen = groups.find((g) => {
            const views = viewsOf(g);
            return views !== null && views.every((id) => allowed.has(id));
        });
    }
    if (!chosen && options.fallbackToFirstLeaf !== false) {
        chosen = groups.find((g) => viewsOf(g) !== null);
    }

    const views = chosen ? viewsOf(chosen) : null;
    if (!chosen || !views || views.length === 0) return { ...empty };
    return {
        dockTabs: views,
        activeDockTab: typeof chosen.data?.activeView === "string" ? chosen.data.activeView : null,
        dockWidth: typeof chosen.size === "number" ? chosen.size : null,
    };
}

/**
 * 由 XH 布局语义构造 dockview `fromJSON` 输入（恢复用）。dock 区是单组，`views` = 打开的 tab，
 * `activeView` = 活动 tab，`size` = `dockWidth`。
 */
export function buildDockviewLayout(opts: {
    dockTabs: string[];
    activeDockTab: string | null;
    dockWidth: number;
}): DockviewSerializedLayout {
    const { dockTabs, activeDockTab, dockWidth } = opts;
    if (dockTabs.length === 0) {
        return { grid: { root: { data: [] } }, panels: {} };
    }
    return {
        grid: {
            root: {
                data: [
                    {
                        data: { views: [...dockTabs], activeView: activeDockTab ?? dockTabs[0] },
                        size: dockWidth,
                    },
                ],
            },
        },
        panels: Object.fromEntries(dockTabs.map((id) => [id, { id }])),
        activeGroup: "1",
    };
}

export default DOCKVIEW_OPTIONS;
