/**
 * task-185 / F2：mock 工作区建成 git 仓库 —— `GET /git-status` 单一共享 GET 的桩。
 *
 * 为什么是「一个桩点亮两处」：`GET /api/v1/workspaces/{id}/git-status` 是
 * `src/features/workspace/composables/useWorkspaceGitReadState.ts:21` 注释明写的
 * 「单一共享 GET 的薄封装」（git readface 用），`WorkspaceChangesPanel.vue:159` 的
 * 待提交 tab 调**同一个** `api.getWorkspaceGitStatus`（composables/api.ts:5497）⇒
 * 两份消费者同源，只需一个 route 桩。
 *
 * 契约：`WorkspaceGitStatus { isRepository, entries: {status, path}[] }`
 * （`src/types/index.ts:1136-1145`）。
 *
 * 注册纪律：必须在 `setupMockAuth` **之后**注册（Playwright 后注册优先，盖过夹具兜底）。
 *
 * timeline 侧（S5 读 diff 才需要）：`GET .../checkpoints`（api.ts:5427），
 * checkpoint 形状照既有工厂 `e2e/mock/checkpoint-rollback.spec.ts:27-50` 的 `checkpoint()`，不另发明。
 */
import type { Page } from "@playwright/test";
import type { WorkspaceCheckpoint, WorkspaceGitStatus } from "../../../src/types";

/** 桩 git-status：默认 3 条（2 改 1 新增），路径与 RSI_DEMO_TREE 同一套，可交叉核对防漂移。 */
export const RSI_DEMO_GIT_STATUS: WorkspaceGitStatus = {
    isRepository: true,
    entries: [
        { status: "M", path: "src/lib/parse.ts" },
        { status: "M", path: "README.md" },
        { status: "??", path: "docs/new-note.md" },
    ],
};

export async function stubMockGitStatus(
    page: Page,
    status: WorkspaceGitStatus = RSI_DEMO_GIT_STATUS,
): Promise<void> {
    await page.route("**/api/v1/workspaces/*/git-status", async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(status),
        });
    });
}

/** 与 RSI_DEMO_GIT_STATUS 对应的 sealed 切片（timeline 页签内容；工厂形状照 checkpoint-rollback.spec.ts:27）。 */
export const RSI_DEMO_CHECKPOINTS: WorkspaceCheckpoint[] = [
    {
        id: "checkpoint-rsi-demo",
        sliceRef: "rsi-slice-0001",
        capturedAt: "2026-11-17T09:20:00Z",
        sourceRunId: "run-rsi-demo",
        sourceSessionId: "session-rsi-demo",
        predecessorRef: null,
        state: "captured",
        changedCount: 3,
        changedFiles: [
            { status: "M", path: "src/lib/parse.ts" },
            { status: "M", path: "README.md" },
            { status: "A", path: "docs/new-note.md" },
        ],
        opaqueNestedRepos: [],
        unrollableReason: null,
        truncated: false,
        revert: null,
    },
];

export async function stubMockCheckpoints(
    page: Page,
    checkpoints: WorkspaceCheckpoint[] = RSI_DEMO_CHECKPOINTS,
): Promise<void> {
    await page.route("**/api/v1/workspaces/*/checkpoints", async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        // 精确匹配 list 端点（不带 /revert /blob /retention 后缀）。
        const url = new URL(route.request().url());
        if (url.pathname.split("/").filter(Boolean).at(-1) !== "checkpoints")
            return route.fallback();
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(checkpoints),
        });
    });
}
