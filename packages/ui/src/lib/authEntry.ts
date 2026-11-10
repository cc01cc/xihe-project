/**
 * PLAN-0612 T6.3：**未登录**访问受保护路由时该走哪条入口。
 *
 * 守卫原本把分支写在 `router.beforeEach` 里（模块作用域 + 真 router 实例），无法单测；
 * 抽成纯函数后，"仍跳 /login" 这类回归能被直接断言。**行为与抽取前逐字一致**，
 * 只是把决策从守卫里搬出来。
 *
 * PLAN-0758（D-787）：本地模式移除后只剩两态 —— `onboarding`（实例还没有任何账号）
 * 与 `login`（普通部署）。
 *
 * - `onboarding`：实例还没有任何账号 ⇒ 去建号页；
 * - `login`：普通部署 ⇒ 登录页。
 */
export type UnauthenticatedEntry = "onboarding" | "login";

export function resolveUnauthenticatedEntry(bootstrap: {
    initialized: boolean;
}): UnauthenticatedEntry {
    if (!bootstrap.initialized) return "onboarding";
    return "login";
}
