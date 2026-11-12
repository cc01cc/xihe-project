/**
 * task-224 档 4：登录后回跳目标的**唯一**入口。
 *
 * 背景（`task-223` 实测）：`auth.ts` 的登出跳转把
 * `window.location.pathname + window.search` 原样塞进 `?redirect=`，而它自己又会把
 * 已经带上 `?redirect=` 的登录页 URL 再套一层 ⇒ `/login?redirect=/login?redirect=…` 自增。
 * 只要链上任何一环不再"谁都往里塞"，自增就断。
 *
 * 因此这里把两条输入（当前 URL / `?redirect=` 查询参数）统一过一遍白名单：
 *  - 只接受**站内绝对路径**（`/` 开头；`//evil.com` 是协议相对 URL，必须拒）；
 *  - 拒 `redirect` 已经嵌套的串（解一次就够了：真正的目标不该再携带回跳参数）；
 *  - 拒 `/login` / `/register` / `/onboarding` 本身（否则登录成功后又回到入口页，等于白跳）；
 *  - 长度上限（防超长 URL 撑爆服务端/日志，也给"别再套了"一个硬闸）。
 *
 * 不合格一律回落 `/workspace` —— **不抛错**：回跳是体验优化，不是契约校验，
 * 让一个坏参数把用户挡在登录页外面才是更糟的结果。
 */

/** 允许的最长回跳目标（字符数）。正常站内路径远小于此数。 */
const MAX_REDIRECT_LENGTH = 2048;

/** 入口页自己：登录成功后再跳这些页面没有意义（会立刻被守卫再弹一次）。 */
const ENTRY_PATH_PREFIXES = ["/login", "/register", "/onboarding"] as const;

/**
 * 规范化登录后的回跳目标。
 *
 * @param raw 未受信任的输入（U 盘：来自 URL 查询参数或 `window.location`）
 * @param fallback 不合格时的落点，默认 `/workspace`
 */
export function safeRedirect(raw: unknown, fallback = "/workspace"): string {
    if (typeof raw !== "string") return fallback;
    const candidate = raw.trim();
    if (!candidate) return fallback;
    if (candidate.length > MAX_REDIRECT_LENGTH) return fallback;
    // 只认站内绝对路径：`//host` / `http(s)://…` / `javascript:` 都不是路径
    if (!candidate.startsWith("/") || candidate.startsWith("//")) return fallback;
    // 已嵌套的回跳参数：再套一层就是 task-224 的自增；直接丢掉整串
    if (candidate.includes("redirect=")) return fallback;
    // 入口页自己（`/login`、`/login?…`、`/login/…` 都算，避免 `/loginx` 这种误伤用前缀+边界判断）
    const pathname = candidate.split(/[?#]/)[0] ?? "";
    for (const entry of ENTRY_PATH_PREFIXES) {
        if (pathname === entry || pathname.startsWith(`${entry}/`)) return fallback;
    }
    return candidate;
}
