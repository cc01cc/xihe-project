import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { EXPECT_TIMEOUT_MS } from "../timeouts";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

/**
 * task-185：chat 页面包屑为什么没有当前项 —— **读段结构**，不是只读 `aria-current` 计数。
 *
 * 候选（卡面给的三个）与本 spec 的判别方法：
 * 1 单级页面 ⇒ 段数少（2 段）且没有 `breadcrumb-page` 末段；
 * 2 末级用 `span` 非链接 ⇒ 段数**不少**（3 段）但末段标签不是 `a`；
 * 3 走了另一分支 ⇒ 两份面包屑同时存在（`workspace-breadcrumb` 出现 2 次）。
 */
test.describe("task-185 chat 页面包屑段结构", () => {
    test("chat 与 scheduled-tasks 的段数/末段标签/aria-current 一起报", async ({ page }) => {
        await setupMockAuth(page, {});
        await setupMockSessions(page, { sessions: [{ id: "task185-session", title: "T185" }] });
        const reads: Record<string, unknown> = {};

        for (const target of [
            { name: "chat", path: "/workspace/" + WORKSPACE_ID + "/session/task185-session" },
            { name: "scheduled", path: "/workspace/" + WORKSPACE_ID + "/scheduled-tasks" },
        ]) {
            await page.goto(target.path);
            const bar = page.locator('[data-testid="workspace-status-bar"]');
            await bar.waitFor({ state: "visible", timeout: EXPECT_TIMEOUT_MS });
            reads[target.name] = await page.evaluate(() => {
                const root = document.querySelector('[data-testid="workspace-breadcrumb"]');
                const barEl = document.querySelector('[data-testid="workspace-status-bar"]');
                const items = root
                    ? Array.from(root.querySelectorAll('[data-slot="breadcrumb-item"]'))
                    : [];
                const last = items.at(-1) ?? null;
                return {
                    breadcrumbRoots: document.querySelectorAll(
                        '[data-testid="workspace-breadcrumb"]',
                    ).length,
                    segments: items.map((item) => (item.textContent ?? "").trim()),
                    lastSegmentTag: last
                        ? (last.querySelector("a, span")?.tagName.toLowerCase() ?? null)
                        : null,
                    hasPageSegment: root
                        ? root.querySelectorAll('[data-slot="breadcrumb-page"]').length
                        : 0,
                    statusBarAriaCurrent: barEl
                        ? barEl.querySelectorAll("[aria-current]").length
                        : -1,
                };
            });
        }

        console.log("[task185] " + JSON.stringify(reads));

        type Seg = {
            breadcrumbRoots: number;
            segments: string[];
            lastSegmentTag: string | null;
            hasPageSegment: number;
            statusBarAriaCurrent: number;
        };
        const chat = reads.chat as Seg;
        const scheduled = reads.scheduled as Seg;

        // **前提先过**：状态栏与面包屑都渲染了 —— 否则读到的 0 可能是「没渲染」而不是「没当前项」。
        expect(chat.breadcrumbRoots, "前提：chat 页面包屑渲染").toBe(1);
        expect(scheduled.breadcrumbRoots, "前提：scheduled 页面包屑渲染").toBe(1);
        expect(
            chat.statusBarAriaCurrent,
            "前提：chat 页状态栏渲染（-1 = 状态栏不存在）",
        ).toBeGreaterThanOrEqual(0);
        expect(
            scheduled.statusBarAriaCurrent,
            "前提：scheduled 页状态栏渲染",
        ).toBeGreaterThanOrEqual(0);

        // D-1548 判据（与实测对上才算过；**不许改判据迁就读数**）：
        // chat = 2 段 / 无末段 / aria-current 0；scheduled-tasks = 3 段 / 有末段 / aria-current 1。
        expect(chat.segments.length, "D-1548：chat 2 段").toBe(2);
        expect(chat.hasPageSegment, "D-1548：chat 无 breadcrumb-page 末段").toBe(0);
        expect(chat.statusBarAriaCurrent, "D-1548：chat aria-current = 0").toBe(0);
        expect(scheduled.segments.length, "D-1548：scheduled 3 段").toBe(3);
        expect(scheduled.hasPageSegment, "D-1548：scheduled 有 breadcrumb-page 末段").toBe(1);
        expect(scheduled.statusBarAriaCurrent, "D-1548：scheduled aria-current = 1").toBe(1);
    });
});
