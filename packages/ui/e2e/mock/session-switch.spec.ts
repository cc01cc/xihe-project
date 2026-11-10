import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
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

        await page.getByTestId("sidebar-workspace").click();
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
