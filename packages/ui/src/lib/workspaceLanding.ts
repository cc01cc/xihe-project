import type { ApiWorkspace } from "../composables/api";
import type { TabWorkspace } from "./workspaceContext";

/**
 * PLAN-0614 决策 #5 / BL-173：免密自动登录（localMode）时该落到哪个工作区。
 *
 * 规则（顺序即优先级）：
 * 1. **已有 tab 上下文** → 用它。这是"记住用户上次选择"：守卫以前会用登录响应里的
 *    fallback 覆盖用户在本页签里选过的工作区（BL-173）。
 * 2. 否则用登录响应里的第一个活跃工作区（`workspace` 对象优先，退回 `workspaceId` + 默认名）。
 * 3. 两者都没有 → `null`，调用方停在选择面（PLAN-0614 起"空白起步"：注册不再建工作区）。
 *
 * 只做纯决策、不写存储也不发请求 —— 守卫负责写入，这里负责可单测的三态判定。
 */
export function resolveLocalModeLanding(input: {
    tabWorkspace: TabWorkspace | null;
    loginWorkspace?: ApiWorkspace | null;
    loginWorkspaceId?: string | null;
    fallbackName?: string;
}): TabWorkspace | null {
    const { tabWorkspace, loginWorkspace, loginWorkspaceId } = input;
    if (tabWorkspace?.id) return tabWorkspace;

    if (loginWorkspace?.id) return loginWorkspace;

    if (loginWorkspaceId) {
        const name = input.fallbackName?.trim();
        return name ? { id: loginWorkspaceId, name } : { id: loginWorkspaceId };
    }

    return null;
}
