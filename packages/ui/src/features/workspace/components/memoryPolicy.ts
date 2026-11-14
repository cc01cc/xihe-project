/**
 * 记忆开关的**判定**与**写入合并**从面板里抽出来，理由和 `shouldOpenAgentsDockFromDeepLink`
 * 同源：内联的 `enabled !== false` 可以被断言，但「缺省到底是开还是关」这条口径**没有名字**，
 * 也没有一处能被变异咬住的判据 —— `task-44` 的 M4 第一版就是这么绿的（改完照样 34/34）。
 *
 * <p><b>契约</b>（两侧都是 `[源码]`）：</p>
 * <ul>
 *   <li>`openapi.yaml:7008` `WorkspaceAgentView.contextPolicy` = `{memory:{enabled,writeMode,types}}`，
 *       且 **`null = no policy (memory off)`**；</li>
 *   <li>`PATCH /api/v1/agent-principals/{principalId}` 的 `contextPolicy.memory.enabled`
 *       **缺省 `false`**（原文："a new subject has no memory until the user switches it on"）；</li>
 *   <li>`types: []` ⇒ "no type, i.e. memory effectively off"。</li>
 * </ul>
 *
 * <p>⇒ 只有 `=== true` 才算开；`null` / `memory` 缺失 / `enabled:false` 一律是关。
 * 旧实现写 `enabled !== false` 并注释「缺省=启用」，于是新主体（`contextPolicy: null`）
 * **CP 判关、UI 画开** —— 用户以为已开、实际从未打开，而点「关」还会把这句话写进库里
 * （`task-58`，来自 `task-44` 只读判定）。</p>
 */

function memoryObject(policy: Record<string, unknown> | null): Record<string, unknown> | null {
    const memory = policy?.memory;
    return memory && typeof memory === "object" ? (memory as Record<string, unknown>) : null;
}

/** 与契约同口径：只有显式 `enabled: true` 才算开。 */
export function readMemoryEnabled(policy: Record<string, unknown> | null): boolean {
    return memoryObject(policy)?.enabled === true;
}

/**
 * 契约的另一条：`types: []` 等价「记忆实际不写入」⇒ 开关开着也**不生效**。
 *
 * <p>这条只用于**提示**，不用于改开关读数：把「开着但无类型」直接画成"关"会让用户点了没反应
 * （开关不翻转 = 静默失败），那是另一种谎。界面照实说两句：开关是开，但没选类型所以不写入。</p>
 */
export function readMemoryTypesMissing(policy: Record<string, unknown> | null): boolean {
    const memory = memoryObject(policy);
    if (!memory || memory.enabled !== true) return false;
    const types = memory.types;
    return Array.isArray(types) && types.length === 0;
}

/**
 * 写入合并：`PATCH` 的 `contextPolicy` 是**整对象替换**（`PATCH_BODY_KEYS` 只认
 * `hooks`/`contextPolicy`/`delegationPolicy`，null 表示清空）⇒ 直接发 `{memory:{enabled}}`
 * 会把 `writeMode`/`passive`/`types` 一起清掉。所以只改 `memory.enabled`，其余原样带上。
 */
export function mergeMemoryEnabled(
    policy: Record<string, unknown> | null,
    next: boolean,
): Record<string, unknown> {
    const base = policy ?? {};
    const currentMemory = memoryObject(base) ?? {};
    return { ...base, memory: { ...currentMemory, enabled: next } };
}
