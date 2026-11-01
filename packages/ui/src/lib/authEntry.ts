/**
 * PLAN-0612 T6.3：**未登录**访问受保护路由时该走哪条入口。
 *
 * 守卫原本把这三个分支写在 `router.beforeEach` 里（模块作用域 + 真 router 实例），无法单测；
 * 抽成纯函数后，非 localMode 回归（"仍跳 /login"）与 localMode 免密入口（"走 /local-login"）
 * 都能被直接断言。**行为与抽取前逐字一致**，只是把决策从守卫里搬出来。
 *
 * - `onboarding`：实例还没有任何账号 ⇒ 去建号页；
 * - `local-login`：localMode（回环单用户）⇒ 免密自动登录（BL-150 A/PLAN-0526）；
 * - `login`：普通部署 ⇒ 登录页。
 */
export type UnauthenticatedEntry = "onboarding" | "local-login" | "login";

export function resolveUnauthenticatedEntry(bootstrap: {
    initialized: boolean;
    localMode: boolean;
}): UnauthenticatedEntry {
    if (!bootstrap.initialized) return "onboarding";
    if (bootstrap.localMode) return "local-login";
    return "login";
}
