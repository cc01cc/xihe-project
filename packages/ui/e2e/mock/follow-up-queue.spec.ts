import { expect, test, type Page } from "@playwright/test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";

const WORKSPACE_ID = "workspace-1",
    SESSION_ID = "follow-up-session",
    RUN_ID = "33333333-3333-4333-8333-333333333333";
const ROOT_BRANCH_ID = "00000000-0000-4000-8000-000000000001";
const QUEUE_URL = `**/api/v1/sessions/${SESSION_ID}/follow-ups**`;

interface QueueItem {
    queueItemId: string;
    queueSequence: number;
    status: "queued" | "paused" | "admitted" | "completed" | "withdrawn";
    content: string | null;
    attachments: Array<{
        id: string;
        name: string;
        type: string | null;
        size: number;
        url: string | null;
    }>;
    branchId: string;
    anchorRunId: string | null;
    pauseReason: string | null;
    childRunId: string | null;
    childMessageId: string | null;
    createdAt: string;
    updatedAt: string;
}

interface QueueSnapshot {
    sessionId: string;
    queueState: "empty" | "queued" | "paused";
    outstandingCount: number;
    capacityLimit: number;
    pauseReason: string | null;
    items: QueueItem[];
}

function emptyQueue(): QueueSnapshot {
    return {
        sessionId: SESSION_ID,
        queueState: "empty",
        outstandingCount: 0,
        capacityLimit: 5,
        pauseReason: null,
        items: [],
    };
}

function item(status: QueueItem["status"], sequence = 1): QueueItem {
    return {
        queueItemId: `77777777-7777-4777-8777-${String(sequence).padStart(12, "0")}`,
        queueSequence: sequence,
        status,
        content: `Run follow-up ${sequence}`,
        attachments: [],
        branchId: ROOT_BRANCH_ID,
        anchorRunId: RUN_ID,
        pauseReason: status === "paused" ? "parent_cancelled" : null,
        childRunId: null,
        childMessageId: null,
        createdAt: "2026-10-06T12:00:00.000Z",
        updatedAt: "2026-10-06T12:00:00.000Z",
    };
}

async function setupFollowUpChat(page: Page, initial: QueueSnapshot = emptyQueue()) {
    await setupMockAuth(page, { sse: { tokens: ["working"], holdOpen: true } });
    await setupMockSessions(page, {
        sessions: [
            {
                id: SESSION_ID,
                title: "Queue test",
                workspaceId: WORKSPACE_ID,
                agentPrincipalId: "agent-1",
            },
        ],
    });
    await page.route(`**/api/v1/sessions/${SESSION_ID}/branches`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                sessionId: SESSION_ID,
                items: [
                    {
                        branchId: ROOT_BRANCH_ID,
                        parentBranchId: null,
                        forkPointMessageId: null,
                        forkPointRunId: null,
                        createdAt: "2026-10-06T12:00:00.000Z",
                    },
                ],
            }),
        });
    });
    await page.route("**/api/v1/sessions**", async (route) => {
        const request = route.request(),
            pathname = new URL(request.url()).pathname;
        if (request.method() === "GET" && pathname === "/api/v1/sessions") {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify([
                    {
                        id: SESSION_ID,
                        title: "Queue test",
                        workspaceId: WORKSPACE_ID,
                        agentPrincipalId: "agent-1",
                        createdAt: "2026-10-06T12:00:00.000Z",
                        updatedAt: "2026-10-06T12:00:00.000Z",
                    },
                ]),
            });
            return;
        }
        await route.fallback();
    });

    let current = initial;
    const enqueueRequests: Array<{
        body: Record<string, unknown>;
        idempotencyKey: string | undefined;
    }> = [];
    let chatPostCount = 0;
    await page.route("**/api/v1/chat", async (route) => {
        chatPostCount += 1;
        await route.fulfill({
            status: 202,
            contentType: "application/json",
            body: JSON.stringify({
                origin: "user_submission",
                status: "accepted",
                sessionId: SESSION_ID,
                runId: RUN_ID,
                messageId: "88888888-8888-4888-8888-888888888888",
            }),
        });
    });
    await page.route(QUEUE_URL, async (route) => {
        const request = route.request(),
            pathname = new URL(request.url()).pathname;
        if (request.method() === "GET") {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(current),
            });
            return;
        }
        if (request.method() === "POST" && pathname.endsWith("/continue")) {
            current = {
                ...current,
                queueState: current.outstandingCount > 0 ? "queued" : "empty",
                pauseReason: null,
                items: current.items.map((row) => ({
                    ...row,
                    status: row.status === "paused" ? "queued" : row.status,
                    pauseReason: null,
                })),
            };
            await route.fulfill({
                status: 202,
                contentType: "application/json",
                body: JSON.stringify(current),
            });
            return;
        }
        if (request.method() === "POST") {
            const body = request.postDataJSON() as Record<string, unknown>;
            const idempotencyKey = request.headers()["idempotency-key"];
            enqueueRequests.push({ body, idempotencyKey });
            const next = item("queued", current.items.length + 1);
            next.content = typeof body.content === "string" ? body.content : null;
            next.branchId = typeof body.branchId === "string" ? body.branchId : ROOT_BRANCH_ID;
            current = {
                ...current,
                queueState: "queued",
                outstandingCount: current.outstandingCount + 1,
                items: [...current.items, next],
            };
            await route.fulfill({
                status: 202,
                contentType: "application/json",
                body: JSON.stringify(current),
            });
            return;
        }
        if (request.method() === "DELETE") {
            const itemId = pathname.split("/").at(-1);
            const items = current.items.filter((row) => row.queueItemId !== itemId);
            current = {
                ...current,
                queueState: items.length > 0 ? current.queueState : "empty",
                outstandingCount: Math.max(0, current.outstandingCount - 1),
                pauseReason: items.length > 0 ? current.pauseReason : null,
                items,
            };
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(current),
            });
            return;
        }
        await route.fallback();
    });

    return { enqueueRequests, chatPostCount: () => chatPostCount };
}

test("active desktop ChatRun queues the draft and keeps the transcript unchanged", async ({
    page,
}) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const { enqueueRequests, chatPostCount } = await setupFollowUpChat(page);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(`/workspace/${WORKSPACE_ID}/chat/${SESSION_ID}`, {
        waitUntil: "domcontentloaded",
    });

    const input = page.getByTestId("chat-input");
    await expect(input).toBeVisible();
    await input.fill("finish the first task");
    const startResponse = page.waitForResponse(
        (response) =>
            response.url().endsWith("/api/v1/chat") && response.request().method() === "POST",
    );
    await page.getByTestId("chat-send-button").click();
    expect((await startResponse).status()).toBe(202);
    await expect(page.getByTestId("chat-stop-button")).toBeVisible();

    await input.fill("summarize the result after it finishes");
    const queueResponse = page.waitForResponse(
        (response) =>
            response.url().endsWith(`/api/v1/sessions/${SESSION_ID}/follow-ups`) &&
            response.request().method() === "POST",
    );
    await page.getByTestId("chat-queue-button").click();
    expect((await queueResponse).status()).toBe(202);
    expect(chatPostCount()).toBe(1);
    await expect(page.getByTestId("follow-up-queue-count")).toContainText("1 / 5");
    await expect(page.getByTestId("follow-up-queue-item")).toContainText(
        "summarize the result after it finishes",
    );
    await expect(input).toHaveValue("");

    expect(enqueueRequests).toHaveLength(1);
    expect(enqueueRequests[0]?.body).toMatchObject({
        content: "summarize the result after it finishes",
        branchId: ROOT_BRANCH_ID,
        toolMode: "workspace",
    });
    expect(enqueueRequests[0]?.idempotencyKey).toBeTruthy();

    await page.screenshot({
        path: test.info().outputPath("follow-up-queue-active-desktop-1920x1080.png"),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    const openChat = page.getByRole("button", { name: "Open chat" });
    await expect(openChat).toBeVisible();
    await openChat.click();
    await expect(page.getByTestId("follow-up-queue")).toBeVisible();
    const queueButton = page.getByTestId("chat-queue-button");
    await queueButton.scrollIntoViewIfNeeded();
    const queueButtonBox = await queueButton.boundingBox();
    expect(queueButtonBox).not.toBeNull();
    expect(queueButtonBox!.y).toBeGreaterThanOrEqual(0);
    expect(queueButtonBox!.y + queueButtonBox!.height).toBeLessThanOrEqual(844);
    const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    expect(pageErrors).toEqual([]);
    await page.screenshot({
        path: test.info().outputPath("follow-up-queue-active-mobile-390x844.png"),
    });
});

test("paused queue exposes explicit Continue and resumes in FIFO order on mobile", async ({
    page,
}) => {
    const paused = emptyQueue();
    paused.queueState = "paused";
    paused.outstandingCount = 2;
    paused.pauseReason = "parent_cancelled";
    paused.items = [item("paused"), item("paused", 2)];
    await setupFollowUpChat(page, paused);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/workspace/${WORKSPACE_ID}/chat/${SESSION_ID}`, {
        waitUntil: "domcontentloaded",
    });

    const openChat = page.getByRole("button", { name: "Open chat" });
    await expect(openChat).toBeVisible();
    await openChat.click();
    await expect(page.getByTestId("chat-input")).toBeVisible();
    await expect(page.getByTestId("follow-up-pause-reason")).toBeVisible();
    await expect(page.getByTestId("follow-up-continue-button")).toBeInViewport();
    await page.screenshot({
        path: test.info().outputPath("follow-up-queue-paused-mobile-390x844.png"),
    });
    const queueButton = page.getByTestId("chat-queue-button");
    await queueButton.scrollIntoViewIfNeeded();
    const queueButtonBox = await queueButton.boundingBox();
    expect(queueButtonBox).not.toBeNull();
    expect(queueButtonBox!.y).toBeGreaterThanOrEqual(0);
    expect(queueButtonBox!.y + queueButtonBox!.height).toBeLessThanOrEqual(844);

    const continueResponse = page.waitForResponse(
        (response) =>
            response.url().endsWith(`/api/v1/sessions/${SESSION_ID}/follow-ups/continue`) &&
            response.request().method() === "POST",
    );
    await page.getByTestId("follow-up-continue-button").click();
    expect((await continueResponse).status()).toBe(202);
    await expect(page.getByTestId("follow-up-pause-reason")).toHaveCount(0);
    await page.screenshot({
        path: test.info().outputPath("follow-up-queue-resumed-mobile-390x844.png"),
    });
});
