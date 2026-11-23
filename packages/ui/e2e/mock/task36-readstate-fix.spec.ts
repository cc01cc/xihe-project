import { expect, test } from "./helpers/mock-test";
import { MOCK_WORKSPACE_ID, setupMockAuth, setupMockSessions } from "./helpers/auth";
import { LONG_TIMEOUT_MS } from "../timeouts";
import { openDockPanel } from "../helpers/dock";

/**
 * task-36 / RSI 缺口1 —— **task-945 按 task-939 的新 IA 重写**。
 *
 * 判据（三层，缺一层就是假绿）：
 *   ① 文件树经过 loading 物化后 treeitems>0；
 *   ② 文件面板里**没有**仓库状态块（`workspace-git-readface*`）—— 旧实现把待提交读数塞在
 *      文件页签顶部，R76 判定「文件树就该是文件树」⇒ 块回潮必须红；
 *   ③ 待提交读数**仍可用**，宿主是 dock「变更」面板的「待提交」tab（同一个
 *      `GET /api/v1/workspaces/:id/git-status`，与 C2 MCP git_status 同源）。
 *
 * 树数据走产品自带的 `xihe-mock-filetree` 播种钩子；不手写登录态 seed、不起真栈、不造第二套状态源。
 */

const SEED_TREE = [
    { name: "README.md", path: "README.md", type: "file", size: 12 },
    { name: "src", path: "src", type: "directory", children: [] },
];
const GIT_STATUS = {
    isRepository: true,
    entries: [
        { status: " M", path: "README.md" },
        { status: "??", path: "notes.md" },
    ],
};

test.describe("task-36 RSI read-state fix (mock lane)", () => {
    test("treeitems materialize; the pending reading lives in Changes → pending, not in the file panel", async ({
        page,
    }) => {
        await setupMockAuth(page);
        await setupMockSessions(page, {
            sessions: [{ id: "session-1", title: "Session 1" }],
            messages: { "session-1": [] },
        });
        await page.addInitScript((tree) => {
            localStorage.setItem("xihe-mock-filetree", JSON.stringify(tree));
        }, SEED_TREE);
        // Registered after `setupMockAuth`: later routes take precedence in Playwright, so this
        // overrides the shared `isRepository:false` stub with the dirty-tree reading under test.
        await page.route("**/api/v1/workspaces/*/git-status", async (route) =>
            route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(GIT_STATUS),
            }),
        );

        await page.goto(`/workspace/${MOCK_WORKSPACE_ID}/workbench`);

        const tree = page.getByTestId("workspace-file-tree");
        await expect(tree).toBeVisible({ timeout: LONG_TIMEOUT_MS });
        // 不用固定 sleep：等产品自己的 loading 态消失，再数 reka 原生 treeitem。
        const loading = tree.getByTestId("workspace-tree-loading");
        await expect(loading).toHaveCount(0, { timeout: LONG_TIMEOUT_MS });
        const treeItems = tree.locator('[role="treeitem"]');
        await expect
            .poll(async () => treeItems.count(), { timeout: LONG_TIMEOUT_MS })
            .toBeGreaterThan(0);
        const treeItemCount = await treeItems.count();

        // ② 文件面板里不得再有仓库状态块（FT1 的浏览器侧同判据）。
        for (const testid of [
            "workspace-git-readface",
            "workspace-git-readface-count",
            "workspace-git-readface-entries",
            "workspace-git-readface-head-hint",
        ]) {
            await expect(tree.getByTestId(testid), `${testid} 不得回到文件面板`).toHaveCount(0);
        }

        // ③ 同一读数仍在「变更」→「待提交」：2 条脏文件 + 两条路径。
        await openDockPanel(page, "changes");
        const changes = page.getByTestId("workspace-changes-panel");
        await changes.getByTestId("workspace-diff-tab-pending").click();
        await expect(changes.getByTestId("workspace-diff-pending-count")).toContainText("2", {
            timeout: LONG_TIMEOUT_MS,
        });
        await expect(changes.getByTestId("workspace-diff-pending-list")).toContainText("README.md");
        await expect(changes.getByTestId("workspace-diff-pending-list")).toContainText("notes.md");

        // 机读探针：一行读数可直接抄进 evidence README。
        const pendingText =
            (await changes.getByTestId("workspace-diff-pending-count").textContent()) ?? "";
        const probe = {
            treeitems: treeItemCount,
            filePanelReadfaceBlocks: await tree.getByTestId("workspace-git-readface").count(),
            changesPendingCount: pendingText.trim(),
            gitDirtyCount: GIT_STATUS.entries.length,
            source:
                "GET /api/v1/workspaces/:id/git-status consumed by the Changes dock panel " +
                "(same data plane as MCP git_status)",
        };
        console.log("[task36 probe]", JSON.stringify(probe));
        expect(probe.treeitems).toBeGreaterThan(0);
        expect(probe.filePanelReadfaceBlocks).toBe(0);
        expect(probe.changesPendingCount).toContain("2");

        // 截图稳定门（task-924）：挂载后导航/右栏有 300ms 布局过渡
        // （`components/sidebar/Sidebar.vue:275` 的 `transition-[flex-grow] duration-300`）。
        // 断言常在过渡结束前完成，直接截图会把中间帧写进证据（实测与稳定帧差 1.68%，
        // 欢迎块横向偏 29px），同代码连续两次跑也可能不同。等所有**有限次**动画结束再截；
        // 无限循环动画（spinner 等）不参与，否则永远等不到。
        await page.evaluate(async () => {
            const finite = document.getAnimations().filter((animation) => {
                const iterations = animation.effect?.getTiming().iterations;
                return iterations !== Infinity;
            });
            await Promise.all(finite.map((animation) => animation.finished.catch(() => null)));
            await new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            );
        });
        await page.screenshot({
            path: test.info().outputPath("task36-readstate-mock.png"),
        });
    });
});
