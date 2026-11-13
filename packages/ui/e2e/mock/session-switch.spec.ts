import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { workspaceWire } from "./helpers/workspace-fixture";
import { EXPECT_TIMEOUT_MS } from "../timeouts";

test.describe("Session switch between chat and workspace", () => {
    const sessionId = "switch-session",
        sessionTitle = "Switch Test",
        userMessage = "Hello from chat";
    const workspaceId = "workspace-1";

    test.beforeEach(async ({ page }) => {
        // task-100：下面要断言「两个 workspace 的事件流都被请求过」（`page.on("request")`），
        // 而默认的 in-page 长连接桩不走网络层 ⇒ 显式退回网络层桩形态。
        await setupMockAuth(page, { workspaceEvents: "off" });
        // task-352（`D-1206`）后左栏是「工作区分组 + 会话项」：会话行只在分组里渲染，
        // 分组清单来自 `GET /api/v1/workspaces`。本 spec 原先只桩 sessions ⇒ 分组落到
        // 「加载失败」态、`session-item` 整块不渲染（实测红在「navigation panel session tree
        // switches session」）。这里补两个工作区的列表桩（数组形态）。
        await page.route(
            (url) => url.pathname === "/api/v1/workspaces",
            async (route) => {
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify([
                        { id: "workspace-1", name: "Workspace One", workspaceRole: "WS_OWNER" },
                        { id: "workspace-2", name: "Workspace Two", workspaceRole: "WS_OWNER" },
                    ]),
                });
            },
        );
        await setupMockSessions(page, {
            sessions: [{ id: sessionId, title: sessionTitle, workspaceId }],
            messages: {
                [sessionId]: [
                    {
                        id: "msg-1",
                        sessionId,
                        role: "USER",
                        content: userMessage,
                        createdAt: new Date().toISOString(),
                    },
                ],
            },
        });
    });

    test("chat and workspace share the same session messages", async ({ page }) => {
        await page.goto(`/workspace/${workspaceId}/chat/${sessionId}`);
        await expect(page.locator(`text=${userMessage}`)).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });

        // D-1229：左栏头改成区头（不再显示工作区名、也不再是导航按钮）⇒
        // 「回到工作区页」的入口是全局 rail 的「工作台」模块。
        await page.getByTestId("global-rail-module-workbench").click();
        await page.waitForURL(`**/workspace/${workspaceId}`);
        await expect(page.locator(`text=${userMessage}`)).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        // PLAN-0582 S3a: the "switch to chat" toolbar button became the chat tab
        // of the middle route tab bar (pure route projection).
        await expect(page.getByTestId("workspace-tab-chat")).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });

        await page.getByTestId("workspace-tab-chat").click();
        await page.waitForURL(`**/workspace/${workspaceId}/chat/${sessionId}`);
        await expect(page.locator(`text=${userMessage}`)).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
    });

    test("navigation panel session tree switches session", async ({ page }) => {
        await setupMockSessions(page, {
            sessions: [
                { id: sessionId, title: sessionTitle, workspaceId },
                { id: "other-session", title: "Other Session", workspaceId },
            ],
        });

        await page.goto(`/workspace/${workspaceId}`);
        await expect(page.getByTestId("workspace-tab-chat")).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });

        // PLAN-0582 S1: the toolbar <select> is gone; the navigation panel is the
        // single session switcher.
        await expect(page.locator('[data-testid="sidebar"] select')).toHaveCount(0);
        await page
            .getByTestId("sidebar-panel")
            .getByTestId("session-item")
            .filter({ hasText: "Other Session" })
            .click();
        await page.waitForURL(`**/workspace/${workspaceId}/chat/other-session`);
        await expect(page.locator('[data-testid="chat-input"]')).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
    });

    test("workspace routes keep sessions isolated and resubscribe workspace events", async ({
        page,
    }) => {
        const firstWorkspace = "workspace-1",
            secondWorkspace = "workspace-2",
            firstSession = "workspace-one-session";
        const secondSession = "workspace-two-session",
            firstMessage = "Message from workspace one";
        const secondMessage = "Message from workspace two",
            workspaceEvents: string[] = [];
        page.on("request", (request) => {
            if (
                request.url().includes("/api/v1/workspaces/") &&
                request.url().includes("/events")
            ) {
                workspaceEvents.push(request.url());
            }
        });
        await setupMockSessions(page, {
            sessions: [
                { id: firstSession, title: "Workspace One", workspaceId: firstWorkspace },
                { id: secondSession, title: "Workspace Two", workspaceId: secondWorkspace },
            ],
            messages: {
                [firstSession]: [
                    {
                        id: "workspace-one-message",
                        sessionId: firstSession,
                        role: "USER",
                        content: firstMessage,
                        createdAt: new Date().toISOString(),
                    },
                ],
                [secondSession]: [
                    {
                        id: "workspace-two-message",
                        sessionId: secondSession,
                        role: "USER",
                        content: secondMessage,
                        createdAt: new Date().toISOString(),
                    },
                ],
            },
        });

        // 本用例需要**两个真实工作区**，而共享夹具的 `KNOWN_WORKSPACE_IDS`（`D-1178`）刻意
        // 不含 `workspace-2` —— 那份名单是为了让「访问不存在的工作区应当 404」可验，不能为
        // 本用例放宽（放宽等于把别处的负例洗掉）。所以这里在 spec 内单独回 workspace-2 的详情。
        // 不补这条的实测后果：`GET /api/v1/workspaces/workspace-2` 404 ⇒ WorkspaceView 判定
        // 上下文冲突并退回「选择工作区」页 ⇒ 第二个会话的正文永远不出现（本用例长期红）。
        await page.route("**/api/v1/workspaces/workspace-2", async (route) => {
            if (route.request().method() !== "GET") {
                await route.fallback();
                return;
            }
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    workspace: workspaceWire({ id: "workspace-2", name: "Workspace Two" }),
                }),
            });
        });

        const firstHistory = page.waitForResponse((response) =>
            response.url().includes(`/api/v1/sessions/${firstSession}/messages`),
        );
        await page.goto(`/workspace/${firstWorkspace}/chat/${firstSession}`);
        await firstHistory;
        await expect(page.getByText(firstMessage)).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await page.goto(`/workspace/${secondWorkspace}/chat/${secondSession}`);
        await expect(page.getByText(secondMessage)).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await expect(page.getByText(firstMessage)).toHaveCount(0);
        expect(
            workspaceEvents.some((url) => url.includes(`/workspaces/${firstWorkspace}/events`)),
        ).toBe(true);
        expect(
            workspaceEvents.some((url) => url.includes(`/workspaces/${secondWorkspace}/events`)),
        ).toBe(true);
    });

    test("switching away from an in-flight run detaches and replays on return", async ({
        page,
    }) => {
        const firstWorkspace = "workspace-1",
            secondWorkspace = "workspace-2",
            firstSession = "in-flight-session";
        const secondSession = "other-workspace-session";
        await setupMockAuth(page, { sse: { tokens: ["replayed response"], delayMs: 200 } });
        await setupMockSessions(page, {
            sessions: [
                { id: firstSession, title: "In-flight", workspaceId: firstWorkspace },
                { id: secondSession, title: "Other", workspaceId: secondWorkspace },
            ],
            messages: {
                [firstSession]: [],
                [secondSession]: [],
            },
        });
        let historyReads = 0;
        await page.route(`**/api/v1/sessions/${firstSession}/messages*`, async (route) => {
            historyReads += 1;
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(
                    historyReads >= 2
                        ? [
                              {
                                  id: "replayed-message",
                                  sessionId: firstSession,
                                  role: "ASSISTANT",
                                  content: "replayed response",
                                  createdAt: new Date().toISOString(),
                              },
                          ]
                        : [],
                ),
            });
        });

        const firstHistory = page.waitForResponse((response) =>
            response.url().includes(`/api/v1/sessions/${firstSession}/messages`),
        );
        await page.goto(`/workspace/${firstWorkspace}/chat/${firstSession}`);
        await firstHistory;
        const input = page.locator('[data-testid="chat-input"]');
        await input.fill("start a long run");
        await page.locator('button[aria-label="chat.send"], button[aria-label="发送"]').click();
        await expect(page.getByText("start a long run")).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });

        await page.goto(`/workspace/${secondWorkspace}/chat/${secondSession}`);
        const returnedHistory = page.waitForResponse((response) =>
            response.url().includes(`/api/v1/sessions/${firstSession}/messages`),
        );
        await page.goto(`/workspace/${firstWorkspace}/chat/${firstSession}`);
        await returnedHistory;
        expect(historyReads).toBeGreaterThanOrEqual(2);
        await expect(page.getByText("replayed response")).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(page.locator('[data-testid="chat-input"]')).toBeVisible();
    });
});
