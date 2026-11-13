import type { Component } from "vue";

/**
 * 工作区内部二级页清单（PLAN-0773 `M4-4` / `task-190`）。
 *
 * <p><b>唯一来源是路由表</b>，不是本文件：每页在 `router/index.ts` 的 `/workspace/:workspaceId`
 * 子路由上带 `meta.workspacePage = { id, labelKey, order, icon }`；本文件只提供**类型与纯函数**，
 * 不持有任何页面清单、不持有路径段。判据（可复算）：本文件里除 `/workspace` 根前缀外**不得出现
 * 第 2 个路径字面量**，也不得出现页面名字符串 —— 一旦出现，说明清单被手写回来了（同
 * `lib/globalModules.ts` 立的同一条判据，那边管全局模块，这边管工作区内页，互不 import）。</p>
 *
 * <p><b>为什么不在 `lib/globalModules.ts` 里加</b>（`task-189` / ui-2 已确认）：全局条是**跨模块**的
 * 导航（工作台 / 资源 / 设置），工作区二级页是**容器内部**的导航（工作台 / 环境 / 定时任务 / 设置）——
 * 两层导航不是同一份清单，硬并成一个数组会让「工作台」在两处各出现一次而语义不同。</p>
 */
/**
 * `D-1220` ③（`task-365` C-1）：**哪些工作区页同时注册成全局 rail 的面板项**。
 *
 * <p>这是一份**id 允许清单**，不是第二份页面清单：标签、图标、地址、顺序仍然只由路由
 * `meta.workspacePage` 派生（`useWorkspaceNav`）。所以它不违反本文件顶部那条判据 ——
 * 这里没有页面名字符串、没有第二个路径字面量。</p>
 *
 * <p><b>为什么不并进 `GLOBAL_MODULES`</b>：那份是**跨模块**导航（实例级），本清单里的页是
 * **工作区作用域**（地址带 workspaceId）。两层导航不是同一份清单（本文件顶部已记该裁定），
 * 硬并会让「工作台」在两处各出现一次而语义不同。rail 因此渲染两个分组：全局模块 + 工作区面板。</p>
 *
 * <p><b>为什么先只有定时任务</b>：`D-1220` ③ 点名的四类里，只有「定时任务」与「技能」今天真有页面；
 * 「作业 / 插件」在路由、视图、API 三个面都是 0 命中 ⇒ 注册它们等于新建功能，另立卡。
 * 技能属资源模块（`/resources/skills`，已在 rail 的资源二级菜单里），本轮不重复注册。</p>
 */
export const RAIL_PANEL_PAGE_IDS: readonly WorkspacePageMeta["id"][] = ["scheduled-tasks"];

export const WORKSPACE_PAGE_META_KEY = "workspacePage";

/** 工作区根前缀（唯一的路径字面量，供拼带 id 的地址用；页面段一律由路由生成本身）。 */
export const WORKSPACE_ROOT_PREFIX = "/workspace";

/** 路由 `meta.workspacePage` 的形状（挂在路由记录上，由本文件的守卫函数校验）。 */
export interface WorkspacePageMeta {
    /** 稳定 id：导航锚点、图标映射与测试都用它，不用页面名。 */
    id: "sessions" | "environment" | "scheduled-tasks" | "settings" | "resources" | "members";
    /** i18n 标签 key（两侧 locale 必须都有 —— 缺失由 `lint:i18n` 拦）。 */
    labelKey: string;
    /** 导航顺序（与路由声明顺序解耦：改路由顺序不该改导航顺序）。 */
    order: number;
    /** 图标（`@lucide/vue` 组件）；缺省时导航用 `Circle` 兜底而不是留空。 */
    icon?: Component;
}

export interface WorkspaceNavItem {
    id: WorkspacePageMeta["id"];
    labelKey: string;
    /** 路由记录 name（激活态判定用 name 而不是字符串比路径）。 */
    name: string;
    /** 带当前工作区 id 的地址（由 `router.resolve` 生成，不是手拼）。 */
    path: string;
    icon?: Component;
}

/** 类型守卫：`RouteMeta` 是开放字典，取出来必须先验形再当结构化数据用。 */
export function isWorkspacePageMeta(value: unknown): value is WorkspacePageMeta {
    if (typeof value !== "object" || value === null) return false;
    const candidate = value as Record<string, unknown>;
    return (
        typeof candidate.id === "string" &&
        typeof candidate.labelKey === "string" &&
        typeof candidate.order === "number"
    );
}

/** 从路由 meta 里取工作区页元数据（取不到就是 `undefined`，即「这条路由不是工作区二级页」）。 */
export function workspacePageOfMeta(meta: unknown): WorkspacePageMeta | undefined {
    if (typeof meta !== "object" || meta === null) return undefined;
    const candidate = (meta as Record<string, unknown>)[WORKSPACE_PAGE_META_KEY];
    return isWorkspacePageMeta(candidate) ? candidate : undefined;
}
