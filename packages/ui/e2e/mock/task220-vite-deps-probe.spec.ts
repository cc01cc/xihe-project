/**
 * task-220 ①：Vite 依赖预打包陈旧的**探针门**自检（族 A：这个面此前没有任何门在看）。
 *
 * 为什么要有这个文件：`504 (Outdated Optimize Dep)` 会让动态 import 失败、页面半初始化，
 * 于是业务断言红得与产品无关（2026-11-15 `workspace-members:306` 就是这一类，当时算成产品红）。
 * 修法不是把红写进 expected，而是**补门**：① 起跑前预热把竞态吃掉；② reload 后仍 504 时把这类
 * 红**归因成环境失败**，让读数分得清「环境陈旧」与「产品/夹具缺陷」。
 *
 * 本文件钉两件事：分类器咬得住（纯函数，可变异成红）；健康态不误报（staleSeen=0）。
 */
import { expect, test } from "./helpers/mock-test";
import { classifyFailures } from "./helpers/page-failures";
import { formatWarmUp, isStaleDepsFailure, warmUpViteDeps } from "./helpers/vite-deps";
import { LONG_TIMEOUT_MS } from "../timeouts";

test.describe("task-220 ① Vite 依赖预打包探针门", () => {
    test("分类器咬得住三条真实形态，且不误吃普通 404", () => {
        // 三条形态逐字来自 [实测] 2026-11-15 的 e2e 日志（504 deps + 动态导入失败）。
        const realShapes = [
            "504 http://localhost:5199/node_modules/.vite/deps/@codemirror_view.js?v=abc — Outdated Optimize Dep",
            "Failed to fetch dynamically imported module: http://localhost:5199/src/features/settings/views/WorkspaceSettingsView.vue",
            "Failed to load resource: the server responded with a status of 504 (Outdated Optimize Dep) /node_modules/.vite/deps/chunk.js?v=1",
        ];
        for (const entry of realShapes) {
            expect(isStaleDepsFailure(entry), "应判为依赖陈旧: " + entry).toBe(true);
        }
        // 反向控制：普通 404 不能被吃进来，否则这道门会把人导错方向。
        expect(
            isStaleDepsFailure("404 http://localhost:5199/api/v1/workspaces/abc — 夹具未补桩"),
        ).toBe(false);
        expect(isStaleDepsFailure("500 http://localhost:5199/api/v1/mcp")).toBe(false);
    });

    test("报告把环境类红单独归因（仍计入 unexpected，但读数分得清）", () => {
        const report = classifyFailures({
            consoleErrors: [],
            pageErrors: [],
            failedResponses: [
                "504 http://localhost:5199/node_modules/.vite/deps/@codemirror_view.js?v=abc — Outdated Optimize Dep",
                "404 http://localhost:5199/api/v1/workspaces/abc — 夹具未补桩",
            ],
        });
        console.log("[task220] " + report.summary);
        expect(report.staleDeps, "陈旧依赖条目应被单独列出").toHaveLength(1);
        expect(
            report.unexpected.failedResponses,
            "不许把环境类红从 unexpected 里偷偷剔除",
        ).toHaveLength(2);
        expect(report.summary).toContain("env(stale-deps)=1");
        expect(report.summary).toContain("[env] 依赖预打包陈旧 × 1");
    });

    test("健康态预热不误报：staleSeen=0 且不触发 reload", async ({ page }) => {
        const result = await warmUpViteDeps(page, "/workspace");
        console.log(formatWarmUp(result));
        expect(result.staleSeen, "健康 dev server 上预热不应命中依赖陈旧").toBe(0);
        expect(result.reloaded, "没命中就不该 reload（避免把首屏时序改掉）").toBe(false);
        expect(result.staleAfterReload, "未 reload 时该字段恒 0").toBe(0);
        await expect(page.locator("body"), "预热后页面仍然可用").toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
    });
});
