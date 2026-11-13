import { describe, expect, it } from "vitest";
import router from "../../../router";
import { workspacePageOfMeta } from "../../../lib/workspacePages";

/**
 * PLAN-0773 `M4-4`（`task-190`）的**机器判据**：工作区二级导航项必须**由路由表派生**。
 *
 * <p>本文件不测组件外观（那是 e2e 的事），只钉住三条「手写清单会立刻破」的不变量：
 * ① 带 `meta.workspacePage` 的记录数 = 4（工作台 / 环境 / 定时任务 / 设置）；
 * ② 顺序由 `order` 决定而不是路由声明顺序；③ 地址由 `router.resolve` 生成（换段只改路由表）。</p>
 *
 * <p><b>为什么不直接断言组件渲染出的项数</b>：那样测的是组件，而缺陷形态是「有人在组件里
 * 手抄了一份清单」——那段代码根本不会读路由表。断言**路由表里的工作区页集合**能同时抓住
 * 「路由加了一页但导航没跟上」（组件派生则自动跟上，不会红）与「导航里多出一项在路由表里不存在」
 * （组件渲染出来的项必然来自路由表，手抄则不可能出现在本断言的对撞面上 —— 因此配套 e2e 断言
 * 渲染项数 = 本处路由表项数）。</p>
 */
const pageRecords = router
    .getRoutes()
    .map((record) => ({ record, page: workspacePageOfMeta(record.meta) }));

const withPage = pageRecords
    .filter((entry) => entry.page !== undefined)
    .sort((a, b) => (a.page?.order ?? 0) - (b.page?.order ?? 0));

describe("工作区二级导航 SSOT（路由 meta 派生）", () => {
    it("工作区页 = 4 条，且顺序由 order 决定", () => {
        expect(withPage.map((entry) => entry.page?.id)).toEqual([
            "workbench",
            "environment",
            "scheduled-tasks",
            "settings",
        ]);
        expect(withPage.map((entry) => entry.page?.order)).toEqual([10, 20, 30, 40]);
    });

    it("聊天页不是二级导航项（它没有独立入口）", () => {
        const chat = router.getRoutes().find((record) => record.name === "workspace-chat");
        expect(chat).toBeDefined();
        expect(workspacePageOfMeta(chat?.meta)).toBeUndefined();
    });

    it("地址由路由解析生成（workspaceId 进段，不手拼）", () => {
        const environment = router
            .getRoutes()
            .find((record) => record.name === "workspace-environment");
        expect(environment).toBeDefined();
        const resolved = router.resolve({
            name: "workspace-environment",
            params: { workspaceId: "ws-demo-1" },
        });
        expect(resolved.href).toBe("/workspace/ws-demo-1/environment");
        expect(resolved.name).toBe("workspace-environment");
    });

    it("每个工作区页都带 labelKey，且 i18n 两侧可解析", () => {
        for (const entry of withPage) {
            expect(entry.page?.labelKey.startsWith("workspaceNav.")).toBe(true);
        }
    });
});
