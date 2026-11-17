/**
 * task-191：委派预算（`agent_principals.delegation_policy`）的 UI 值模型与纯函数。
 *
 * <p>为什么单独成模块：`AgentPrincipalDetailDrawer` 与（后续）创建表单都要做
 * 「JSON 文档 ↔ 表单值」的双向转换 + dirty 判定 + 校验，内联两份会漂移（与
 * `memoryPolicy.ts` 同一拆分理由：口径要有名字、能被单测咬住）。</p>
 *
 * <p>**契约**（两侧 [源码]）：</p>
 * <ul>
 *   <li>openapi `AgentPrincipalView.delegationPolicy` = `{maxCount,maxDepth}`，
 *       `null` = 代码默认（8/3）；`maxCount = 0` = 禁止委派；`maxDepth >= 1`；</li>
 *   <li>只有委派树根主体的文档在 spawn 时被读（AgentPrincipal.java delegation_policy 注释），
 *       子代理自有预算在作为 subagent 期间惰性 —— 这条写进 UI 提示文案。</li>
 * </ul>
 *
 * <p>**成对规则**：与模型意图（both-or-neither）同款，预算两半也要求同填同清 —
 * 半清一半在 CP 侧没有定义良好的语义，UI 先挡住（校验失败不发请求）。</p>
 */

export interface DelegationPolicyValue {
    /** `null` = 未设置（用平台默认）。 */
    maxCount: number | null;
    /** `null` = 未设置（用平台默认）。 */
    maxDepth: number | null;
}

/** 未设置态：两半都空。 */
export function emptyDelegationPolicy(): DelegationPolicyValue {
    return { maxCount: null, maxDepth: null };
}

function toCount(raw: unknown): number | null {
    return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : null;
}

function toDepth(raw: unknown): number | null {
    return typeof raw === "number" && Number.isInteger(raw) && raw >= 1 ? raw : null;
}

/**
 * fail-closed 的文档 → 表单值转换：非对象/畸形字段一律按未设置处理（与
 * `memoryPolicy.readMemoryEnabled` 同口径 —— 缺省语义只能有一个）。
 */
export function parseDelegationPolicy(doc: Record<string, unknown> | null): DelegationPolicyValue {
    if (!doc) return emptyDelegationPolicy();
    return { maxCount: toCount(doc.maxCount), maxDepth: toDepth(doc.maxDepth) };
}

/**
 * 表单值 → PATCH 文档：两半都空 ⇒ `null`（清空该文档、回代码默认）；
 * 都填 ⇒ 文档对象。半填状态由调用方先用 `delegationPolicyValid` 挡住，不会到这里。
 */
export function buildDelegationPolicy(
    value: DelegationPolicyValue,
): Record<string, unknown> | null {
    if (value.maxCount === null && value.maxDepth === null) return null;
    return { maxCount: value.maxCount, maxDepth: value.maxDepth };
}

/** 校验：两半同填同清；count ≥ 0 整数；depth ≥ 1 整数。 */
export function delegationPolicyValid(value: DelegationPolicyValue): boolean {
    const halfFilled = (value.maxCount === null) !== (value.maxDepth === null);
    if (halfFilled) return false;
    if (value.maxCount !== null && (!Number.isInteger(value.maxCount) || value.maxCount < 0)) {
        return false;
    }
    if (value.maxDepth !== null && (!Number.isInteger(value.maxDepth) || value.maxDepth < 1)) {
        return false;
    }
    return true;
}

/** dirty 判定（基准是打开抽屉时解析出的初值）。 */
export function delegationPolicyDirty(
    baseline: DelegationPolicyValue,
    current: DelegationPolicyValue,
): boolean {
    return baseline.maxCount !== current.maxCount || baseline.maxDepth !== current.maxDepth;
}
