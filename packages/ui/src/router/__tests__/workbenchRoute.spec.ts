import { describe, expect, it } from "vitest";
import router from "../index";
import { isWorkbenchRoute, isWorkbenchRouteName, WORKBENCH_ROUTE_NAMES } from "../workbenchRoute";

/**
 * task-110 的机器判据：顶部全局页签行只属于「会挂载工作台」的两条工作区路由。
 *
 * <p>本文件钉两件事：① 判定函数对七个工作区路由名的取值（只有两条 true）；② 路由表里
 * 命中该判定的记录**恰好 2 条**，且路径/名对得上 —— 有人改名或加页时当场红，而不是等到
 * 五个非工作台页又冒出 32px 全局行（task-104 的缺陷形态）。</p>
 */
describe("workbenchRoute（task-110：全局页签行只属于工作台页）", () => {
    it("判定函数只认 workspace 与 workspace-session", () => {
        expect(WORKBENCH_ROUTE_NAMES).toEqual(["workspace", "workspace-session"]);
        expect(isWorkbenchRouteName("workspace")).toBe(true);
        expect(isWorkbenchRouteName("workspace-session")).toBe(true);
        // 工作区壳内但**不挂工作台**的五页
        expect(isWorkbenchRouteName("workspace-environment")).toBe(false);
        expect(isWorkbenchRouteName("workspace-scheduled-tasks")).toBe(false);
        expect(isWorkbenchRouteName("workspace-resources")).toBe(false);
        expect(isWorkbenchRouteName("workspace-settings")).toBe(false);
        expect(isWorkbenchRouteName("workspace-members")).toBe(false);
        // 未知/缺失
        expect(isWorkbenchRouteName("settings-user")).toBe(false);
        expect(isWorkbenchRouteName(undefined)).toBe(false);
        expect(isWorkbenchRouteName(null)).toBe(false);
        expect(isWorkbenchRoute(undefined)).toBe(false);
        expect(isWorkbenchRoute({ name: "workspace-session" })).toBe(true);
    });

    it("路由表里命中该判定的记录恰好两条，且就是工作台两页", () => {
        const records = router.getRoutes().filter((record) => isWorkbenchRouteName(record.name));
        expect(records).toHaveLength(2);
        expect(records.map((record) => record.name).sort()).toEqual([
            "workspace",
            "workspace-session",
        ]);
        expect(records.map((record) => record.path).sort()).toEqual([
            "/workspace/:workspaceId",
            "/workspace/:workspaceId/session/:sessionId",
        ]);
    });
});
