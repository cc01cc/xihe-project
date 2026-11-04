/**
 * Composer 的**会话内**偏好（2026-11-04 用户裁定的 composer 打磨）。
 *
 * 记忆活在该 composer 实例的生命周期里（实例内 Map，**不落 localStorage**）—— 与 chat store
 * "消息 / run 状态不持久化"同源：折叠偏好是会话视图的瞬时选择，刷新后回到默认收起；写进
 * localStorage 只会堆一份按 sessionId 增长、又没有清理入口的偏好表。
 *
 * 实例内（而不是模块级）也保证了：测试各自隔离，且组件重建 = 用户换页面 ⇒ 偏好归零。
 * ChatPanel 只挂一个 InputArea 实例，切换会话时记忆自然跟着实例走。
 */
export function useComposerPreferences() {
    const ccExpandedBySession = new Map<string, boolean>();
    return {
        /** 该会话是否被用户手动展开过抄送栏（默认收起）。 */
        isCcExpanded(sessionId: string): boolean {
            return ccExpandedBySession.get(sessionId) ?? false;
        },
        /** 只记**手动**选择；@ 点名 / chips 出现的自动展开不写记忆。 */
        setCcExpanded(sessionId: string, expanded: boolean): void {
            ccExpandedBySession.set(sessionId, expanded);
        },
    };
}
