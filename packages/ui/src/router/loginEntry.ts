/**
 * task-224 档 3：入口页守卫的**纯判定**（抽出来才能单测，不必起真 router）。
 *
 * 旧判据（task-224 前的 `router/index.ts:289-294`）只有一条：「`localStorage` 里有
 * `xihe-token` 且要去的是 login/register/onboarding ⇒ 弹 `/workspace`」。token 只是
 * 「可能过期、可能残留」的弱信号，于是**半个会话**（token 残留但 user 已没了，或 token
 * 早已失效且从未被校验）也被当成已登录弹进 `/workspace` —— 那正是"12 个并发 401"的起点。
 *
 * 新判据要求**会话材料齐备**（token + 缓存 user 同时存在）才让路；不齐备就停在入口页，
 * 用户看到的是登录表单，而不是"进站即被踢出"的一次闪烁。
 *
 * **行为变更（显式记录）**：完整会话下"已登录误访问 /login"体验**不变**（照旧弹走）；
 * 变的是残 token 场景 —— 现在停在登录页。
 */

/** 入口页（登录/注册/引导）。 */
export function isEntryRouteName(name: unknown): boolean {
    return name === "login" || name === "register" || name === "onboarding";
}

/**
 * 入口页是否应该让路给 `/workspace`。
 *
 * @param hasToken localStorage 里是否有 `xihe-token`
 * @param hasCachedUser localStorage 里是否有登录时写入的 `xihe-user`
 */
export function shouldBounceEntryToWorkspace(hasToken: boolean, hasCachedUser: boolean): boolean {
    return hasToken && hasCachedUser;
}
