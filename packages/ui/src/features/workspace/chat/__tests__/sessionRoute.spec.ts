import { describe, expect, it } from "vitest";
import { chatSessionRoute } from "../sessionRoute";

/**
 * task-1 / D-1846（契约 A5.1）：anchor / DAG 节点 / steer 深链共用同一个路由形态。
 * 这条断言防的不是「函数能返回对象」，而是**改路由名/参数名时只有一个地方要改**：
 * 三处入口如果又各自写字面量，这里仍然是绿的，但契约已经被绕过 —— 所以实现侧统一 import。
 */
describe("chatSessionRoute (task-1 A5.1)", () => {
    it("names the workspace chat route and carries the target session id", () => {
        expect(chatSessionRoute("child-a")).toEqual({
            name: "workspace-session",
            params: { sessionId: "child-a" },
        });
    });
});
