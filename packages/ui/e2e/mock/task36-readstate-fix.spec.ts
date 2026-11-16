import { expect, test } from "./helpers/mock-test";
import { MOCK_WORKSPACE_ID, setupMockAuth, setupMockSessions } from "./helpers/auth";
import { LONG_TIMEOUT_MS } from "../timeouts";

/**
 * task-36 / RSI 缺口1：mock 车道**可复算**「读现状」探针。
 *
 * 判据：文件树经过 loading 物化后 treeitems>0；git 读面与文件树同一屏，脏文件数
 * 与摘要可见。树数据走产品自带的 `xihe-mock-filetree` 播种钩子；git 数据走已有
 * 公开 HTTP 读面 `GET /api/v1/workspaces/:id/git-status`（与 C2 MCP git_status 同源）。
 * 不手写登录态 seed、不起真栈、不造第二套状态源。
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
    test("treeitems materialize and git read-face shows dirty count and summary", async ({
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

        const readface = page.getByTestId("workspace-git-readface");
        await expect(readface).toBeVisible({ timeout: LONG_TIMEOUT_MS });
        await expect(readface.getByTestId("workspace-git-readface-count")).toContainText("2");
        await expect(readface.getByTestId("workspace-git-readface-entries")).toContainText(
            "README.md",
        );
        await expect(readface.getByTestId("workspace-git-readface-entries")).toContainText(
            "notes.md",
        );
        await expect(readface.getByTestId("workspace-git-readface-head-hint")).toContainText(
            "HEAD",
        );

        // 机读探针：一行读数可直接抄进 evidence README。
        const probe = {
            treeitems: treeItemCount,
            gitReadfaceVisible: await readface.isVisible(),
            gitDirtyCount: GIT_STATUS.entries.length,
            source: "GET /api/v1/workspaces/:id/git-status (same data plane as MCP git_status)",
        };
        console.log("[task36 probe]", JSON.stringify(probe));
        expect(probe.treeitems).toBeGreaterThan(0);
        expect(probe.gitReadfaceVisible).toBe(true);
        await page.screenshot({
            path: "internal/A03-xihe/evidence/2026-11-17-rsi-readstate-fix/task36-readstate-mock.png",
        });
    });
});
