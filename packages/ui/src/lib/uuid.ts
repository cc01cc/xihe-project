/**
 * task-537：工作区 id 形状判定。
 *
 * 为什么要有这一层：工作区 id 在 URL 里，旧书签/手改地址/复制粘贴都能塞进任意字符串。
 * CP 对非 UUID 的 `X-Workspace-Id` 直接 400（`X-Workspace-Id must be a UUID`），
 * 而 UI 之前会**先**把它写进 tab 上下文再发请求 —— 结果是「两条 400 + 左栏空态」，
 * 用户看到的是「空」而不是「错」。入口处判定一次，可以既不发明知会失败的请求，
 * 也能给出明确错误态。
 */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 是否形如 UUID（大小写不敏感，不做 v4 版本位校验 —— CP 只要求形状）。 */
export function isUuid(value: unknown): value is string {
    return typeof value === "string" && UUID_PATTERN.test(value.trim());
}
