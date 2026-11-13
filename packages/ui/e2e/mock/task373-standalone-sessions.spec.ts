// timeout-exempt: long E2E step(s) reviewed in task-373 (LONG_TIMEOUT_MS, default 30 s)
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS, LONG_TIMEOUT_MS } from "../timeouts";

/**
 * task-373 / `D-1228` + `D-1236` 的硬判据：**一个无工作区的会话能在界面上被找到并打开**。
 *
 * <p>这里全部用真组件 + mock 数据（夹具 `workspacelessSessions` 走 `GET /sessions?scope=workspaceless`，
 * 与工作区作用域是两份数据）。判据覆盖：分组沉底、为 0 隐藏、行可点开独立会话页、新建入口两项菜单、
 * 零工作区用户不落「还没有工作区」空态，以及代表性移动 viewport。</p>
 */
const WS_ID = "workspace-1";
const WS_SESSION = "11111111-1111-4111-8111-111111111111";
const STANDALONE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STANDALONE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function stubWorkspaces(page: import("@playwright/test").Page, rows: unknown[]) {
    await page.route(
        (url) => url.pathname === "/api/v1/workspaces",
        async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(rows),
            });
        },
    );
}

function workspaceRow() {
    return { id: WS_ID, name: "Workspace 1", workspaceRole: "WS_OWNER" };
}

test.describe("standalone sessions in the sidebar (task-373)", () => {
    test.beforeEach(async ({ page }) => {
        await setupMockAuth(page);
        await stubWorkspaces(page, [workspaceRow()]);
    });

    test("finds a workspace-less session in its own group and opens it", async ({ page }) => {
        await setupMockSessions(page, {
            sessions: [{ id: WS_SESSION, title: "工作区会话" }],
            workspacelessSessions: [
                { id: STANDALONE_A, title: "独立会话甲" },
                { id: STANDALONE_B, title: "独立会话乙" },
            ],
        });
        await page.goto("/workspace/" + WS_ID + "/chat/" + WS_SESSION);

        const group = page.getByTestId("sidebar-standalone-group");
        await expect(group).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await expect(group).toContainText("独立会话");
        // 沉底（D-1221）：它是分组容器里的最后一个 section。
        const sections = page.locator('[data-testid="sidebar-workspace-groups"] section');
        await expect(sections.last()).toHaveAttribute("data-testid", "sidebar-standalone-group", {
            timeout: EXPECT_TIMEOUT_MS,
        });

        await group.getByText("独立会话甲").click({ timeout: ACTION_TIMEOUT_MS });
        await expect(page).toHaveURL(new RegExp("/chat/" + STANDALONE_A), {
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(page.getByTestId("standalone-chat-badge")).toHaveText("独立会话", {
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(page.getByTestId("standalone-chat-title")).toHaveText("独立会话甲", {
            timeout: EXPECT_TIMEOUT_MS,
        });
        // 真能对话：composer 挂上（不是只换了个 URL）。
        await expect(page.locator("textarea")).toBeVisible({ timeout: LONG_TIMEOUT_MS });
    });

    test("hides the group when the account has no workspace-less session", async ({ page }) => {
        await setupMockSessions(page, {
            sessions: [{ id: WS_SESSION, title: "工作区会话" }],
        });
        await page.goto("/workspace/" + WS_ID + "/chat/" + WS_SESSION);
        await expect(page.getByTestId("sidebar-workspace-group-" + WS_ID)).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(page.getByTestId("sidebar-standalone-group")).toHaveCount(0);
    });

    test("creates a standalone session from the two-item new-chat menu", async ({ page }) => {
        // 个人智能体候选：恰好一个 ⇒ 弹窗不打断，直接建（CP 缺 agentPrincipalId 会 400）。
        await page.route(
            (url) => url.pathname === "/api/v1/agent-principals",
            async (route) => {
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({
                        principals: [
                            {
                                principalId: "principal-personal-1",
                                name: "个人智能体",
                                templateId: null,
                                templateName: null,
                                createdAt: "2026-11-14T00:00:00Z",
                                disabled: false,
                            },
                        ],
                    }),
                });
            },
        );
        await setupMockSessions(page, {
            sessions: [{ id: WS_SESSION, title: "工作区会话" }],
            workspacelessSessions: [{ id: STANDALONE_A, title: "独立会话甲" }],
            createSession: true,
        });
        await page.goto("/workspace/" + WS_ID + "/chat/" + WS_SESSION);

        await page.getByTestId("sidebar-new-chat").click({ timeout: ACTION_TIMEOUT_MS });
        await expect(page.getByTestId("sidebar-new-chat-workspace")).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await page.getByTestId("sidebar-new-chat-standalone").click({ timeout: ACTION_TIMEOUT_MS });

        await expect(page).toHaveURL(/\/chat\/mock-session-/, { timeout: LONG_TIMEOUT_MS });
        await expect(page.getByTestId("standalone-chat-badge")).toHaveText("独立会话", {
            timeout: EXPECT_TIMEOUT_MS,
        });
        // 新建的会话立刻出现在独立会话分组里（不必刷新）。
        await expect(page.getByTestId("sidebar-standalone-group")).toContainText("New Chat", {
            timeout: EXPECT_TIMEOUT_MS,
        });
    });

    test("a user with no workspace but with standalone sessions is not told to create one", async ({
        page,
    }) => {
        await stubWorkspaces(page, []);
        await setupMockSessions(page, {
            workspacelessSessions: [{ id: STANDALONE_A, title: "只有独立会话" }],
        });
        await page.goto("/workspace");

        await expect(page.getByTestId("sidebar-standalone-group")).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(page.getByTestId("sidebar-empty-no-workspace")).toHaveCount(0);
        await page.getByTestId("sidebar-standalone-group").getByText("只有独立会话").click({
            timeout: ACTION_TIMEOUT_MS,
        });
        await expect(page).toHaveURL(new RegExp("/chat/" + STANDALONE_A), {
            timeout: EXPECT_TIMEOUT_MS,
        });
    });
});

test.describe("standalone sessions on a small viewport (task-373)", () => {
    test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

    test.beforeEach(async ({ page }) => {
        await setupMockAuth(page);
        await stubWorkspaces(page, [workspaceRow()]);
    });

    test("reaches and opens a standalone session at 390px", async ({ page }) => {
        await setupMockSessions(page, {
            sessions: [{ id: WS_SESSION, title: "工作区会话" }],
            workspacelessSessions: [{ id: STANDALONE_A, title: "独立会话甲" }],
        });
        await page.goto("/workspace/" + WS_ID + "/chat/" + WS_SESSION);
        await page.getByTestId("mobile-sidebar-toggle").click({ timeout: ACTION_TIMEOUT_MS });

        const group = page.getByTestId("sidebar-standalone-group");
        await expect(group).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await group.getByText("独立会话甲").click({ timeout: ACTION_TIMEOUT_MS });
        await expect(page).toHaveURL(new RegExp("/chat/" + STANDALONE_A), {
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(page.getByTestId("standalone-chat")).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(page.locator("textarea")).toBeVisible({ timeout: LONG_TIMEOUT_MS });
    });
});
