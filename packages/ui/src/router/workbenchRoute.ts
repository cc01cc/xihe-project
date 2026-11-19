import type { RouteLocationNormalizedLoaded, RouteLocation } from "vue-router";

/**
 * task-110：哪些工作区路由会挂载工作台（Content Workbench）？
 *
 * <p>这一事实的 SSOT 是**路由表**（`src/router/index.ts:126-249`）：`/workspace/:workspaceId`
 * 与 `/workspace/:workspaceId/chat/:sessionId` 两条记录渲染同一个 `WorkspaceView`，只有它们在
 * mount 时给页签行发 claim（`WorkspaceWorkbench.vue:252-260`）。其余五个工作区页（环境/定时任务/
 * 资源/设置/成员）在工作区壳内但**不挂工作台**，所以顶部全局页签行不属于它们。</p>
 *
 * <p>为什么抽成纯函数而不是在组件里内联两个字符串：路由名在本仓已被抄过多处
 * （`WorkspaceTabBar.vue:94`、`lib/lastLocation.ts:172`、`chat/sessionRoute.ts:9`…），
 * 而「哪两条路由有工作台」是新的独立事实 —— 抽出来才能单测，也才能在 task-69 三元组化时
 * 一处替换（见 `one/.tmp/xh/ui-gates/tabbar-leak-fix/prep.md` §1.2.3）。</p>
 */
export const WORKBENCH_ROUTE_NAMES = ["workspace", "workspace-chat"] as const;

export type WorkbenchRouteName = (typeof WORKBENCH_ROUTE_NAMES)[number];

const WORKBENCH_ROUTE_NAME_SET: ReadonlySet<string> = new Set(WORKBENCH_ROUTE_NAMES);

/** 路由名是否属于「会挂载工作台」的两条之一（未知/缺失一律 false）。 */
export function isWorkbenchRouteName(name: unknown): boolean {
    return typeof name === "string" && WORKBENCH_ROUTE_NAME_SET.has(name);
}

/** 当前路由是否属于工作台页（`route` 可为空，只看 `name`）。 */
export function isWorkbenchRoute(
    route:
        | Pick<RouteLocationNormalizedLoaded, "name">
        | Pick<RouteLocation, "name">
        | null
        | undefined,
): boolean {
    return isWorkbenchRouteName(route?.name);
}
