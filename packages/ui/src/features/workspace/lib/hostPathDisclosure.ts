/**
 * 宿主目录（`hostPath`）的**唯一披露口径**。
 *
 * <p>为什么要有这个文件：同一个字段在两页上各写一份判断，早晚会漂 —— 环境页
 * （`WorkspaceEnvironmentView`）先有这套规则（管理员或工作区 owner 才给看原始宿主路径，
 * 其余人只看 `storageRef` 这个不透明引用），设置页的「物理目录」行曾经**直接绑 `storageRef`
 * 并且叫它「物理目录」** ⇒ 用户在两页看到的是两个不同的东西，其中一个是工作区 UUID
 * （batch-02 实测截图 `.tmp/xh/b02-tab-设置.png` vs `b02-tab-环境.png`）。把判断收在一处，
 * 两页的读数就不可能再分叉。</p>
 *
 * <p>**安全语义（不得放宽）**：CP 对非 owner / 非管理员把 `hostPath` 投影成 `null`
 * （`WorkspaceController#toMap`）。这里的规则是**第二道闸**：`null` 安全投影绝不能被
 * 本地缓存（`sessionStorage` 的 `xihe-workspace` 只存 id/name/role，本来也没有路径）
 * 补上，也绝不允许前端自己拼路径。</p>
 */

/** 参与判定的三条读数（全部来自 `useAuthStore()`，不读 cookie / 不再请求）。 */
export interface HostPathPrincipal {
    /** `auth.user?.id` —— 没有登录主体时一律不可见。 */
    userId: string | null | undefined;
    /** `auth.isAdmin` —— 实例管理员能力位（**不是**实例管理员才对，是能力原子投影）。 */
    isInstanceAdmin: boolean;
    /** `auth.workspace?.ownerId` —— 工作区 owner 才可见。 */
    ownerId: string | null | undefined;
}

/** 原始宿主路径能否展示给当前主体（实例管理员 或 该工作区 owner）。 */
export function canViewRawHostPath(principal: HostPathPrincipal): boolean {
    if (!principal.userId) return false;
    if (principal.isInstanceAdmin) return true;
    return Boolean(principal.ownerId && principal.ownerId === principal.userId);
}

/**
 * 可展示的宿主路径：判定不通过、或服务端给的是空/null 安全投影时返回 `null`
 * —— 调用方据此**整行隐藏**，不要渲染 `—` 之外的东西，更不要自己拼。
 */
export function discloseHostPath(
    rawPath: string | null | undefined,
    principal: HostPathPrincipal,
): string | null {
    if (!canViewRawHostPath(principal)) return null;
    return typeof rawPath === "string" && rawPath.length > 0 ? rawPath : null;
}
