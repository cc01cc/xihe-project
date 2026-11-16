import { describe, expect, it } from "vitest";

import { WORKBENCH_PATH } from "../../lib/globalModules";
import router from "../index";

/**
 * `task-34`（原 `task-228`）：**工作台模块入口 `/workspace` → `/workbench`，容器路由不动**。
 *
 * <p>为什么要有这条（卡面判据 ③「路由可达」）：改常量只证明"跳转目标变量变了"，不证明
 * **路由表里真有这条**。旧 URL 的处置（卡面 ② 选 (a)）同样只有一条断言能证明：redirect 记录存在
 * 且 query/hash 透传 —— 否则书签会静默 404，而"常量改了"这类局部读数一切正常。</p>
 *
 * <p>第三条是**反向判据**（容器层不许跟着改）：`/workspace/:workspaceId/**` 必须仍在，且
 * `/workbench/:workspaceId` 必须**不**存在 —— 那是禁用改法（卡面禁区）。</p>
 */
describe("task-34：工作台模块入口 /workbench（容器路由保持 /workspace/:id/**）", () => {
    it("WORKBENCH_PATH 是 /workbench", () => {
        expect(WORKBENCH_PATH).toBe("/workbench");
    });

    it("路由表里有 /workbench 模块入口（name 仍 workspace-home，改名不动路由名）", () => {
        const record = router.getRoutes().find((candidate) => candidate.path === "/workbench");
        expect(record?.name).toBe("workspace-home");
    });

    it("旧模块入口 /workspace 重定向到 /workbench，且 query/hash 透传", () => {
        const legacy = router.getRoutes().find((candidate) => candidate.path === "/workspace");
        expect(typeof legacy?.redirect).toBe("function");
        const redirect = legacy?.redirect as (to: {
            query: Record<string, string>;
            hash: string;
        }) => unknown;
        expect(redirect({ query: { tab: "config" }, hash: "#mcp" })).toEqual({
            path: "/workbench",
            query: { tab: "config" },
            hash: "#mcp",
        });
    });

    it("容器路由仍在 /workspace/:workspaceId/**，没有被改叫 /workbench/:id", () => {
        const paths = router.getRoutes().map((candidate) => candidate.path);
        expect(paths).toContain("/workspace/:workspaceId");
        expect(paths).toContain("/workspace/:workspaceId/resources");
        expect(paths).toContain("/workspace/:workspaceId/members");
        expect(paths).not.toContain("/workbench/:workspaceId");
    });
});
