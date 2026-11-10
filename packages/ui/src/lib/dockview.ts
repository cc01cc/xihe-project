/**
 * PLAN-0756：dock 区 dockview 集成 —— **纯逻辑层**（决策 #18，jsdom 可测）。
 *
 * dockview 是 DOM 布局库，jsdom 下不可用（硬需 ResizeObserver），故把所有可单测的
 * 逻辑抽成**不 import dockview 的纯函数**：序列化桥、布局选项、主题映射。组件层
 * （`WorkspaceDock.vue`）只做薄粘合，集成验证归 Playwright e2e。
 */

/** 序列化后的 dockview 布局（只取本桥需要的字段，结构对齐 dockview `toJSON()` 输出）。 */
export interface DockviewSerializedLayout {
    grid?: {
        root?: {
            data?: Array<{
                data?: { views?: string[]; activeView?: string };
                size?: number;
            }>;
        };
    };
    panels?: Record<string, unknown>;
    floatingGroups?: Array<{ data?: { views?: string[] } }>;
    activeGroup?: string;
}

/**
 * 全局生效的 dockview 选项（决策 #17 的强制落点）。
 *
 * `proportionalLayout: false` —— POC 实测默认 true 会在视口变化时把渲染宽度**写回**
 * 序列化 `grid.root.data[].size`（`[240,640,360,680]→[160,427,240,453]`），违反 PLAN-0582
 * 「clamp 不写回」不变式。XH 持久宽度是用户拖出的绝对值，故必须关比例分配。
 */
export const DOCKVIEW_OPTIONS = { proportionalLayout: false } as const;

/**
 * 序列化桥：`dockview toJSON()` → XH 布局语义（`dockTabs` / `activeDockTab` / `dockWidth`）。
 * 纯函数、不碰 DOM、不 import dockview —— 可在 jsdom 直接单测。
 *
 * 取**首个内嵌 group**（本集成的 dock 区是单组：所有 dock tab 同组）的 `views` / `activeView` /
 * `size`。`size` 是组在根分支里的宽度，对应 XH 的 `dockWidth`。
 */
export function bridgeDockviewLayout(json: DockviewSerializedLayout | null | undefined): {
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
    const group = json.grid?.root?.data?.find((leaf) => Array.isArray(leaf?.data?.views));
    const views = group?.data?.views;
    if (!Array.isArray(views) || views.length === 0) return { ...empty };
    return {
        dockTabs: views.filter((v): v is string => typeof v === "string"),
        activeDockTab: typeof group?.data?.activeView === "string" ? group.data.activeView : null,
        dockWidth: typeof group?.size === "number" ? group.size : null,
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
