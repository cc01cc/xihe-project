import { expect, test } from "./helpers/mock-test";
import { ChatPage } from "../page-objects/ChatPage";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";

const sessionId = "attachment-session";

test.describe("Chat attachment persistence", () => {
    test("uploads attachment, merges with text, and persists after reload", async ({ page }) => {
        await setupMockAuth(page, { sse: { tokens: ["OK"] } });
        // 会话必须在列表里，否则路由守卫回落到默认 Mock Session，发送面拿不到 attachment-session。
        await setupMockSessions(page, {
            sessions: [{ id: sessionId, title: "Attachment session" }],
        });
        // PLAN-0699 M2：发送走 POST /api/v1/chat（不是 /messages）；不桩则 catch-all 回 {}，
        // 无 runId 的 202 体让乐观用户消息/流式回复都无法落位。补最小 202 契约。
        await page.route("**/api/v1/chat", async (route) => {
            await route.fulfill({
                status: 202,
                contentType: "application/json",
                body: JSON.stringify({
                    status: "accepted",
                    sessionId,
                    runId: "run-attachment-1",
                }),
            });
        });

        let messagesResponse: Array<Record<string, unknown>> = [];

        await page.route(`**/api/v1/sessions/${sessionId}/attachments`, async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    success: [
                        {
                            id: "file-1",
                            name: "note.txt",
                            type: "text/plain",
                            size: 12,
                            url: "/files/file-1",
                        },
                    ],
                    failed: [],
                }),
            });
        });

        await page.route(`**/api/v1/sessions/${sessionId}/messages*`, async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(messagesResponse),
            });
        });

        const chat = new ChatPage(page);
        await chat.goto(sessionId);
        await expect(chat.input).toBeVisible();

        await chat.attachFiles([
            { name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("hello world") },
        ]);
        await expect(page.locator('[data-testid="selected-attachment"]')).toContainText("note.txt");

        await chat.input.fill("see attachment");
        await chat.sendButton.click();

        await expect(chat.uploadIndicator).toBeHidden();
        await expect(page.locator("text=see attachment")).toBeVisible();
        await expect(
            page.locator('[data-testid="message-attachment"]').filter({ hasText: "note.txt" }),
        ).toBeVisible();

        messagesResponse = [
            {
                id: "msg-1",
                sessionId,
                role: "USER",
                content: "see attachment",
                createdAt: new Date().toISOString(),
                attachments: [{ fileId: "file-1", name: "note.txt", type: "text/plain", size: 12 }],
            },
            {
                id: "msg-2",
                sessionId,
                role: "ASSISTANT",
                content: "OK",
                createdAt: new Date().toISOString(),
                attachments: [],
            },
        ];

        await page.reload();
        await expect(page.locator("text=see attachment")).toBeVisible();
        await expect(
            page.locator('[data-testid="message-attachment"]').filter({ hasText: "note.txt" }),
        ).toBeVisible();
    });

    test("sends a pure attachment message when no text is entered", async ({ page }) => {
        await setupMockAuth(page, { sse: { tokens: ["Received"] } });
        await setupMockSessions(page, {
            sessions: [{ id: sessionId, title: "Attachment session" }],
        });
        await page.route("**/api/v1/chat", async (route) => {
            await route.fulfill({
                status: 202,
                contentType: "application/json",
                body: JSON.stringify({
                    status: "accepted",
                    sessionId,
                    runId: "run-attachment-2",
                }),
            });
        });

        await page.route(`**/api/v1/sessions/${sessionId}/attachments`, async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    success: [
                        {
                            id: "file-2",
                            name: "image.png",
                            type: "image/png",
                            size: 32,
                            url: "/files/file-2",
                        },
                    ],
                    failed: [],
                }),
            });
        });

        await page.route(`**/api/v1/sessions/${sessionId}/messages*`, async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify([]),
            });
        });

        const chat = new ChatPage(page);
        await chat.goto(sessionId);
        await chat.attachFiles([
            { name: "image.png", mimeType: "image/png", buffer: Buffer.from("fake-image") },
        ]);
        await chat.sendButton.click();

        await expect(chat.uploadIndicator).toBeHidden();
        await expect(
            page.locator('[data-testid="message-attachment"]').filter({ hasText: "image.png" }),
        ).toBeVisible();
    });
});
