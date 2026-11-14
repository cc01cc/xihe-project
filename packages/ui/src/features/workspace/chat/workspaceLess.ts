import type { RouteLocationNormalizedLoaded } from "vue-router";

/**
 * task-547 F-A：**独立会话**（无工作区上下文）的判定 —— 唯一实现。
 *
 * <p>为什么需要它：CP 对 workspace-less Session 设有硬限制（`ChatController.java:616-629`）——
 * 只要 `toParticipantIds` / `ccParticipantIds` / `asParticipantId` / 附件任一非空，
 * 整轮请求就 400 `WORKSPACE_LESS_FEATURE_FORBIDDEN`（`WorkspaceLessSessionCreationIntegrationTest` 钉着）。
 * 而组合器此前对这些控件**零降级** ⇒ 用户先选主体再发送，第三步才失败。</p>
 *
 * <p>判定口径 = 路由事实，不是 store 推断：独立会话走 `/chat/:sessionId`（无 workspaceId 段），
 * 工作区会话走 `/workspace/:workspaceId/chat/:sessionId`。两者共用 `ChatPanel`，所以只能按路由判。</p>
 */
/**
 * `route` 可以缺席：组件单测常不装 router（`useRoute()` 会直接抛）。缺席 = 不是独立会话，
 * 这与"测试环境里没有路由上下文"的语义一致，且不会把生产判断放宽（生产一定有路由）。
 */
export function isWorkspaceLessRoute(
    route: Pick<RouteLocationNormalizedLoaded, "params" | "path"> | null | undefined,
): boolean {
    if (!route) return false;
    const workspaceId = route.params.workspaceId;
    if (typeof workspaceId === "string" && workspaceId.length > 0) return false;
    return String(route.path ?? "").startsWith("/chat/");
}
