/**
 * task-1 / D-1846（契约 A5.1）：进入某会话聊天的**唯一路由形态**。
 *
 * 三处入口共用它（steer 来源深链 / anchor 点击 / DAG 节点点击）—— 之前同一个字面量
 * `{ name: "workspace-session", params: { sessionId } }` 被抄在 ChatPanel 里；anchor 与 DAG 再各自
 * 抄一遍就是「同一事实 N 份实现」。路由名/参数一旦变化，这里改一处即可。
 */
export function chatSessionRoute(sessionId: string): {
    name: "workspace-session";
    params: { sessionId: string };
} {
    return { name: "workspace-session", params: { sessionId } };
}
