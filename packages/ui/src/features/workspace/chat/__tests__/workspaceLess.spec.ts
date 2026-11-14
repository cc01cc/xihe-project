import { describe, expect, it } from "vitest";
import { isWorkspaceLessRoute } from "../workspaceLess";

/**
 * task-547 F-A：独立会话判定。
 *
 * <p>判据不是"路由长什么样"，而是**这个判定会不会让工作区会话被误降级** ——
 * 所以两条负向用例（工作区会话、无路由上下文）与一条正向用例同等重要：
 * 判错方向会砍掉工作区里的发送/抄送入口（判据②的负向对照就是防这个）。</p>
 */
const route = (path: string, params: Record<string, string> = {}) =>
    ({ path, params }) as unknown as Parameters<typeof isWorkspaceLessRoute>[0];

describe("isWorkspaceLessRoute", () => {
    it("独立会话 /chat/:sessionId（无 workspaceId 段）⇒ true", () => {
        expect(isWorkspaceLessRoute(route("/chat/4d5c013b", { sessionId: "4d5c013b" }))).toBe(true);
    });

    it("工作区会话 /workspace/:workspaceId/chat/:sessionId ⇒ false（不能被误降级）", () => {
        expect(
            isWorkspaceLessRoute(
                route("/workspace/ws-1/chat/s-1", { workspaceId: "ws-1", sessionId: "s-1" }),
            ),
        ).toBe(false);
    });

    it("没有路由上下文（组件单测）⇒ false：不因缺少证据就收紧产品行为", () => {
        expect(isWorkspaceLessRoute(null)).toBe(false);
        expect(isWorkspaceLessRoute(undefined)).toBe(false);
    });

    it("路径是 /chat 前缀但没有 sessionId ⇒ 仍按前缀判定 true（避免半初始化时漏降级）", () => {
        expect(isWorkspaceLessRoute(route("/chat/", {}))).toBe(true);
    });
});
