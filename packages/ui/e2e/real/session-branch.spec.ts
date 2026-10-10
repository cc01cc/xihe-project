import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import {
    CP_URL,
    awaitOperationCompletedForRun,
    ensureAgentWorkspaceBinding,
    getRootBranchId,
    registerJourneyUser,
    seedPage,
    sendChat,
    waitForControlPlaneAgentReady,
    type JourneyContext,
} from "./helpers/journey";

test.describe.configure({ mode: "serial", retries: 0, timeout: 90000 });

test.describe("@host Session branch path", () => {
    let journey: JourneyContext,
        workspaceHeaders: Record<string, string>,
        sessionId = "",
        principalId = "";
    let userId = "";

    test.beforeAll(async ({ request }) => {
        journey = await registerJourneyUser(request, "session-branch");
        workspaceHeaders = {
            ...journey.headers,
            "X-Workspace-Id": journey.workspaceId,
        };
        const meResponse = await request.get(`${CP_URL}/api/v1/auth/me`, {
            headers: workspaceHeaders,
        });
        expect(meResponse.ok(), await meResponse.text()).toBe(true);
        userId = ((await meResponse.json()) as { id: string }).id;
        seedUserGrant(userId, journey.workspaceId);

        const roleId = randomUUID(),
            templateId = randomUUID();
        const templateWrite = await request.put(`${CP_URL}/api/v1/config/user/agent-templates`, {
            headers: workspaceHeaders,
            data: {
                roles: JSON.stringify([
                    {
                        id: roleId,
                        name: "Session Branch Role",
                        permissions: [{ actionClass: "read", resource: "*" }],
                    },
                ]),
                templates: JSON.stringify([
                    {
                        id: templateId,
                        name: "Session Branch Agent",
                        description: "Workspace-bound host fixture for branch path verification",
                        systemPrompt: "Respond briefly using only the current chat context.",
                        toolMode: "workspace",
                        provider: "openai",
                        model: "fake-openai",
                        roleId,
                    },
                ]),
            },
        });
        expect(templateWrite.status(), await templateWrite.text()).toBe(200);

        const principalResponse = await request.post(`${CP_URL}/api/v1/agent-principals`, {
            headers: workspaceHeaders,
            data: { name: "Session Branch Agent", templateId },
        });
        expect(principalResponse.status(), await principalResponse.text()).toBe(201);
        principalId = ((await principalResponse.json()) as { principalId: string }).principalId;
        const binding = await request.put(
            `${CP_URL}/api/v1/workspaces/${journey.workspaceId}/agents/${principalId}`,
            {
                headers: workspaceHeaders,
                data: { permissions: [{ actionClass: "read", resource: "*" }] },
            },
        );
        expect(binding.status(), await binding.text()).toBe(200);

        const sessionResponse = await request.post(`${CP_URL}/api/v1/sessions`, {
            headers: workspaceHeaders,
            data: { title: "Session branch browser journey", agentPrincipalId: principalId },
        });
        expect(sessionResponse.status(), await sessionResponse.text()).toBe(201);
        sessionId = ((await sessionResponse.json()) as { id: string }).id;
    });

    test("branches and forks through the UI, preserves the child after source deletion, and works on mobile", async ({
        page,
        request,
    }, testInfo) => {
        await ensureAgentWorkspaceBinding(journey.workspaceId);
        await waitForControlPlaneAgentReady(request, workspaceHeaders);
        seedPage(page, journey);
        await page.setViewportSize({ width: 1920, height: 1080 });

        const submissions: Array<{ sessionId?: string; branchId?: string; content?: string }> = [];
        const pageErrors: string[] = [],
            consoleErrors: string[] = [],
            requestFailures: string[] = [];
        const messageReads: Array<{ sessionId: string; branchId: string | null }> = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        page.on("console", (message) => {
            if (message.type() === "error") consoleErrors.push(message.text());
        });
        page.on("requestfailed", (failed) => {
            requestFailures.push(
                `${failed.method()} ${failed.url()} ${failed.failure()?.errorText ?? ""}`,
            );
        });
        page.on("request", (outgoing) => {
            const url = new URL(outgoing.url());
            const messageMatch = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/messages$/);
            if (outgoing.method() === "GET" && messageMatch) {
                messageReads.push({
                    sessionId: decodeURIComponent(messageMatch[1]),
                    branchId: url.searchParams.get("branchId"),
                });
            }
            if (outgoing.method() !== "POST" || url.pathname !== "/api/v1/chat") return;
            try {
                submissions.push(
                    JSON.parse(outgoing.postData() ?? "{}") as {
                        sessionId?: string;
                        branchId?: string;
                        content?: string;
                    },
                );
            } catch (error) {
                pageErrors.push(`invalid Chat JSON: ${String(error)}`);
            }
        });

        await page.goto(`/workspace/${journey.workspaceId}/chat/${sessionId}`, {
            waitUntil: "load",
        });
        await page
            .locator('[data-testid="chat-input"]')
            .waitFor({ state: "visible", timeout: 30000 });

        const anchorText = `root-anchor-${Date.now()}`;
        const attachmentBytes = Buffer.from("PLAN-0409 browser fork attachment bytes\n");
        const uploadResponsePromise = page.waitForResponse(
            (response) =>
                response.request().method() === "POST" &&
                new URL(response.url()).pathname === `/api/v1/sessions/${sessionId}/attachments`,
        );
        await page.getByTestId("file-upload-input").setInputFiles({
            name: "fork-proof.txt",
            mimeType: "text/plain",
            buffer: attachmentBytes,
        });
        await expect(page.getByTestId("selected-attachment")).toBeVisible();
        const rootChatResponsePromise = page.waitForResponse(
            (response) =>
                response.request().method() === "POST" &&
                new URL(response.url()).pathname === "/api/v1/chat",
        );
        await sendChat(page, anchorText);
        const uploadResponse = await uploadResponsePromise;
        expect(uploadResponse.status(), await uploadResponse.text()).toBe(200);
        const uploadResult = (await uploadResponse.json()) as {
            success?: Array<{ id: string; name: string }>;
            failed?: Array<{ fileName: string; reason: string }>;
        };
        expect(uploadResult.failed ?? []).toEqual([]);
        expect(uploadResult.success?.map((file) => file.name)).toContain("fork-proof.txt");
        const rootChatResponse = await rootChatResponsePromise;
        expect(rootChatResponse.status(), await rootChatResponse.text()).toBe(202);
        const rootChat = (await rootChatResponse.json()) as { runId?: string };
        if (!rootChat.runId) throw new Error("Root Chat response did not contain runId");
        await expect(
            page.locator('[data-slot="message"][data-align="start"]').last(),
        ).toBeVisible();
        await awaitOperationCompletedForRun(request, workspaceHeaders, rootChat.runId);

        const rootBranchId = await getRootBranchId(request, sessionId, workspaceHeaders);
        const branchSelect = page.getByTestId("session-branch-select");
        await expect(branchSelect).toHaveValue(rootBranchId);

        const anchorMessage = page.locator('[data-slot="message"][data-align="start"]').last();
        await anchorMessage.hover();
        const createBranchButton = anchorMessage.getByTestId("message-branch-button");
        await expect(createBranchButton).toBeVisible();
        const branchResponsePromise = page.waitForResponse(
            (response) =>
                response.request().method() === "POST" &&
                new URL(response.url()).pathname === `/api/v1/sessions/${sessionId}/branches`,
        );
        await createBranchButton.click();
        const branchResponse = await branchResponsePromise;
        expect(branchResponse.status(), await branchResponse.text()).toBe(201);
        const createdBranch = (await branchResponse.json()) as {
            branchId: string;
            parentBranchId: string;
            forkPointMessageId: string;
        };
        expect(createdBranch.parentBranchId).toBe(rootBranchId);
        await expect(branchSelect).toHaveValue(createdBranch.branchId);

        const branchChatText = `selected-branch-${Date.now()}`,
            beforeBranchChat = submissions.length;
        const branchChatResponsePromise = page.waitForResponse(
            (response) =>
                response.request().method() === "POST" &&
                new URL(response.url()).pathname === "/api/v1/chat",
        );
        await sendChat(page, branchChatText);
        const branchChatResponse = await branchChatResponsePromise;
        expect(branchChatResponse.status(), await branchChatResponse.text()).toBe(202);
        const branchChat = (await branchChatResponse.json()) as { runId?: string };
        if (!branchChat.runId) throw new Error("Branch Chat response did not contain runId");
        await expect.poll(() => submissions.length).toBe(beforeBranchChat + 1);
        expect(submissions.at(-1)).toMatchObject({
            sessionId,
            branchId: createdBranch.branchId,
            content: branchChatText,
        });
        await awaitOperationCompletedForRun(request, workspaceHeaders, branchChat.runId);

        const branchMessagesResponse = await request.get(
            `${CP_URL}/api/v1/sessions/${sessionId}/messages?branchId=${createdBranch.branchId}`,
            { headers: workspaceHeaders },
        );
        expect(branchMessagesResponse.ok(), await branchMessagesResponse.text()).toBe(true);
        const branchMessages = (await branchMessagesResponse.json()) as Array<{
            id: string;
            runId?: string;
            role: string;
            content: string;
            attachments?: Array<{ id?: string; fileId?: string; name?: string }>;
        }>;
        expect(branchMessages.some((message) => message.content === anchorText)).toBe(true);
        expect(branchMessages.some((message) => message.content === branchChatText)).toBe(true);
        await expect(page.locator('[data-slot="message"][data-align="end"]').last()).toContainText(
            branchChatText,
        );

        const branchAnchor = branchMessages.at(-1);
        expect(branchAnchor?.role).toBe("ASSISTANT");
        expect(branchAnchor?.runId).toBe(branchChat.runId);
        const rootAttachment = branchMessages
            .flatMap((message) => message.attachments ?? [])
            .find((file) => file.name === "fork-proof.txt");
        expect(rootAttachment).toBeDefined();

        const rootMessagesResponse = await request.get(
            `${CP_URL}/api/v1/sessions/${sessionId}/messages?branchId=${rootBranchId}`,
            { headers: workspaceHeaders },
        );
        expect(rootMessagesResponse.ok(), await rootMessagesResponse.text()).toBe(true);
        const rootMessages = (await rootMessagesResponse.json()) as Array<{ content: string }>;
        expect(rootMessages.some((message) => message.content === branchChatText)).toBe(false);

        // V8 second flow: rewind to the original path by switching the selector back
        // to root, assert the original messages are shown again and the branch-only
        // message is gone from the DOM, then re-select the branch before forking.
        await branchSelect.selectOption(rootBranchId);
        await expect(branchSelect).toHaveValue(rootBranchId);
        await expect(page.locator('[data-slot="message"]').last()).toContainText(anchorText);
        await expect(page.getByText(branchChatText)).toHaveCount(0);
        await branchSelect.selectOption(createdBranch.branchId);
        await expect(branchSelect).toHaveValue(createdBranch.branchId);
        await expect(page.locator('[data-slot="message"][data-align="end"]').last()).toContainText(
            branchChatText,
        );

        const forkRequestPromise = page.waitForRequest(
            (outgoing) =>
                outgoing.method() === "POST" &&
                new URL(outgoing.url()).pathname === `/api/v1/sessions/${sessionId}/fork`,
        );
        const forkResponsePromise = page.waitForResponse(
            (response) =>
                response.request().method() === "POST" &&
                new URL(response.url()).pathname === `/api/v1/sessions/${sessionId}/fork`,
        );
        const activeSessionItem = page.locator('[data-testid="session-item"][aria-current="page"]');
        await expect(activeSessionItem).toBeVisible();
        await activeSessionItem.click({ button: "right" });
        await page.getByTestId("session-item-fork").click();
        const forkRequest = await forkRequestPromise,
            forkResponse = await forkResponsePromise;
        expect(forkResponse.status(), await forkResponse.text()).toBe(201);
        const idempotencyKey = forkRequest.headers()["idempotency-key"];
        expect(idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
        expect(forkRequest.postDataJSON()).toEqual({
            sourceBranchId: createdBranch.branchId,
            anchorMessageId: branchAnchor?.id,
        });
        const forkedSession = (await forkResponse.json()) as {
            id: string;
            kind: string;
            spawnedFromSessionId: string;
            spawnedFromRunId: string;
            spawnedAt: string;
        };
        expect(forkedSession).toMatchObject({
            kind: "fork",
            spawnedFromSessionId: sessionId,
            spawnedFromRunId: branchChat.runId,
        });
        expect(forkedSession.spawnedAt).toBeTruthy();
        expect(forkResponse.headers().location).toContain(`/api/v1/sessions/${forkedSession.id}`);
        const childId = forkedSession.id;
        await expect
            .poll(() => new URL(page.url()).pathname)
            .toBe(`/workspace/${journey.workspaceId}/chat/${childId}`);
        await page
            .locator('[data-testid="chat-input"]')
            .waitFor({ state: "visible", timeout: 30000 });

        const childBranchId = await getRootBranchId(request, childId, workspaceHeaders);
        const childBranchSelect = page.getByTestId("session-branch-select");
        await expect(childBranchSelect).toHaveValue(childBranchId);
        const childMessagesResponse = await request.get(
            `${CP_URL}/api/v1/sessions/${childId}/messages?branchId=${childBranchId}`,
            { headers: workspaceHeaders },
        );
        expect(childMessagesResponse.ok(), await childMessagesResponse.text()).toBe(true);
        const childMessages = (await childMessagesResponse.json()) as Array<{
            content: string;
            attachments?: Array<{ id?: string; fileId?: string; name?: string }>;
        }>;
        expect(childMessages.some((message) => message.content === anchorText)).toBe(true);
        expect(childMessages.some((message) => message.content === branchChatText)).toBe(true);
        await expect
            .poll(() =>
                messageReads.some(
                    (read) => read.sessionId === childId && read.branchId === childBranchId,
                ),
            )
            .toBe(true);

        const sourceDb = readSessionSnapshot(sessionId),
            childDb = readSessionSnapshot(childId);
        expect(childDb).toMatchObject({
            id: childId,
            kind: "fork",
            workspaceId: journey.workspaceId,
            userId,
            agentPrincipalId: principalId,
            spawnedFromSessionId: sessionId,
            spawnedFromRunId: branchChat.runId,
            branchCount: 1,
            messageCount: branchMessages.length,
            fileCount: 1,
            chatRunCount: 0,
            historyCount: 0,
        });
        expect(childDb.agentPermissionsSnapshot).toEqual(sourceDb.agentPermissionsSnapshot);
        if (!childDb.seedPayload)
            throw new Error("Forked Session did not persist its summary seed event");
        expect(childDb.seedPayload.summary_seed.messages).toHaveLength(branchMessages.length);
        expect(sourceDb.chatRunCount).toBeGreaterThan(0);
        // PLAN-0464: a ChatRun has no Operation root any more; its durable
        // transition record is the chat_run_history row.
        expect(sourceDb.historyCount).toBeGreaterThan(0);
        expect(sourceDb.files).toHaveLength(1);
        expect(childDb.files).toHaveLength(1);
        expect(childDb.files[0].id).not.toBe(sourceDb.files[0].id);
        expect(childDb.files[0].messageId).not.toBe(sourceDb.files[0].messageId);
        const childFileId = childDb.files[0].id as string;
        const childFileResponse = await request.get(`${CP_URL}/api/v1/files/${childFileId}`, {
            headers: workspaceHeaders,
        });
        expect(childFileResponse.status(), await childFileResponse.text()).toBe(200);
        const childFileHash = createHash("sha256")
            .update(await childFileResponse.body())
            .digest("hex");
        expect(childFileHash).toBe(createHash("sha256").update(attachmentBytes).digest("hex"));
        expect(
            childMessages
                .flatMap((message) => message.attachments ?? [])
                .some(
                    (file) =>
                        (file.id === childFileId || file.fileId === childFileId) &&
                        file.name === "fork-proof.txt",
                ),
        ).toBe(true);

        const desktopScreenshot = test.info().outputPath("session-branch-desktop.png");
        await page.screenshot({ path: desktopScreenshot, fullPage: false });
        await test.info().attach("session-branch-desktop.png", {
            path: desktopScreenshot,
            contentType: "image/png",
        });

        const sourceSessionItem = page.locator(
            `[data-testid="session-item"][aria-label="Session branch browser journey"]`,
        );
        await expect(sourceSessionItem).toBeVisible();
        await sourceSessionItem.click({ button: "right" });
        await page.getByTestId("session-item-delete").click();
        const deleteWarning = page.getByTestId("session-delete-warning");
        await expect(deleteWarning).toBeVisible();
        const deleteResponsePromise = page.waitForResponse(
            (response) =>
                response.request().method() === "DELETE" &&
                new URL(response.url()).pathname === `/api/v1/sessions/${sessionId}`,
        );
        await page.getByTestId("session-delete-confirm").click();
        const deleteResponse = await deleteResponsePromise;
        // 204 has no body: reading it via CDP raises "No data found for resource",
        // so only fetch the body for diagnostics when the status is unexpected.
        const deleteStatus = deleteResponse.status();
        expect(deleteStatus, deleteStatus === 204 ? "" : await deleteResponse.text()).toBe(204);
        await expect(sourceSessionItem).toHaveCount(0);
        const sourceGone = await request.get(`${CP_URL}/api/v1/sessions/${sessionId}`, {
            headers: workspaceHeaders,
        });
        expect(sourceGone.status()).toBe(404);
        const childFileAfterDelete = await request.get(`${CP_URL}/api/v1/files/${childFileId}`, {
            headers: workspaceHeaders,
        });
        expect(childFileAfterDelete.status(), await childFileAfterDelete.text()).toBe(200);
        expect(
            createHash("sha256")
                .update(await childFileAfterDelete.body())
                .digest("hex"),
        ).toBe(createHash("sha256").update(attachmentBytes).digest("hex"));

        const childPostDeleteText = `child-after-source-delete-${Date.now()}`;
        const childChatResponsePromise = page.waitForResponse(
            (response) =>
                response.request().method() === "POST" &&
                new URL(response.url()).pathname === "/api/v1/chat",
        );
        await sendChat(page, childPostDeleteText);
        const childChatResponse = await childChatResponsePromise;
        expect(childChatResponse.status(), await childChatResponse.text()).toBe(202);
        const childChat = (await childChatResponse.json()) as { runId?: string };
        if (!childChat.runId) throw new Error("Child Chat response did not contain runId");
        await awaitOperationCompletedForRun(request, workspaceHeaders, childChat.runId);
        await expect(page.locator('[data-slot="message"][data-align="end"]').last()).toContainText(
            childPostDeleteText,
        );
        const childMessagesAfterDeleteResponse = await request.get(
            `${CP_URL}/api/v1/sessions/${childId}/messages?branchId=${childBranchId}`,
            { headers: workspaceHeaders },
        );
        expect(
            childMessagesAfterDeleteResponse.ok(),
            await childMessagesAfterDeleteResponse.text(),
        ).toBe(true);
        const childMessagesAfterDelete = (await childMessagesAfterDeleteResponse.json()) as Array<{
            content: string;
        }>;
        expect(
            childMessagesAfterDelete.some((message) => message.content === childPostDeleteText),
        ).toBe(true);

        const childDesktopScreenshot = testInfo.outputPath("session-fork-child-desktop.png");
        await page.screenshot({ path: childDesktopScreenshot, fullPage: false });
        await testInfo.attach("session-fork-child-desktop.png", {
            path: childDesktopScreenshot,
            contentType: "image/png",
        });

        await page.setViewportSize({ width: 390, height: 844 });
        await page.getByRole("button", { name: "Open chat" }).click();
        const mobileChatSheet = page.getByTestId("mobile-chat-sheet");
        await expect(mobileChatSheet).toBeVisible();
        const mobileBranchSelect = mobileChatSheet.getByTestId("session-branch-select");
        await expect(mobileBranchSelect).toHaveValue(childBranchId);
        // The messages list is pinned to the bottom by MessageScroller, so the header
        // select cannot stay in-viewport while the latest message is shown; assert it
        // is rendered and holds the child branch instead of viewport intersection.
        await expect(mobileBranchSelect).toBeVisible();
        await expect(
            mobileChatSheet.locator('[data-slot="message"][data-align="end"]').last(),
        ).toContainText(childPostDeleteText);
        const mobileOverflow = await page.evaluate(
            () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
        );
        expect(mobileOverflow).toBe(false);
        const mobileScreenshot = testInfo.outputPath("session-fork-child-mobile.png");
        await page.screenshot({ path: mobileScreenshot, fullPage: false });
        await testInfo.attach("session-fork-child-mobile.png", {
            path: mobileScreenshot,
            contentType: "image/png",
        });

        expect(pageErrors).toEqual([]);
        expect(consoleErrors).toEqual([]);
        // net::ERR_ABORTED marks intentional cancellations (SSE EventSource teardown on
        // session delete / route change), not network faults; everything else is fatal.
        expect(requestFailures.filter((entry) => !entry.includes("net::ERR_ABORTED"))).toEqual([]);
    });

    test("fork after manual compaction carries the summary seed and the child first round works", async ({
        page,
        request,
    }, testInfo) => {
        await ensureAgentWorkspaceBinding(journey.workspaceId);
        await waitForControlPlaneAgentReady(request, workspaceHeaders);
        seedPage(page, journey);
        await page.setViewportSize({ width: 1920, height: 1080 });

        const pageErrors: string[] = [],
            consoleErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        page.on("console", (message) => {
            if (message.type() === "error") consoleErrors.push(message.text());
        });

        const sessionResponse = await request.post(`${CP_URL}/api/v1/sessions`, {
            headers: workspaceHeaders,
            data: { title: "Compressed fork scenario", agentPrincipalId: principalId },
        });
        expect(sessionResponse.status(), await sessionResponse.text()).toBe(201);
        const compactSessionId = ((await sessionResponse.json()) as { id: string }).id;
        const compactRootBranchId = await getRootBranchId(
            request,
            compactSessionId,
            workspaceHeaders,
        );

        await page.goto(`/workspace/${journey.workspaceId}/chat/${compactSessionId}`, {
            waitUntil: "load",
        });
        await page
            .locator('[data-testid="chat-input"]')
            .waitFor({ state: "visible", timeout: 30000 });

        const runChatRound = async (text: string) => {
            const responsePromise = page.waitForResponse(
                (response) =>
                    response.request().method() === "POST" &&
                    new URL(response.url()).pathname === "/api/v1/chat",
            );
            await sendChat(page, text);
            const response = await responsePromise;
            expect(response.status(), await response.text()).toBe(202);
            const body = (await response.json()) as { runId?: string };
            if (!body.runId) throw new Error("Chat response did not contain runId");
            await awaitOperationCompletedForRun(request, workspaceHeaders, body.runId);
            return body.runId;
        };

        const stamp = Date.now();
        await runChatRound(`compressed-round-one-${stamp}`);
        await runChatRound(`compressed-round-two-${stamp}`);

        // Manual compaction on the root branch, then one more round so the fork anchor
        // cursor sits after the compaction event (anchor-bounded projection includes SUM).
        const compactResponse = await request.post(
            `${CP_URL}/api/v1/sessions/${compactSessionId}/compact`,
            {
                headers: workspaceHeaders,
                data: { branchId: compactRootBranchId },
            },
        );
        expect(compactResponse.status(), await compactResponse.text()).toBe(200);
        expect(await compactResponse.json()).toMatchObject({
            eventType: "compaction.manual_applied",
        });
        await runChatRound(`compressed-round-three-after-compact-${stamp}`);

        // Fork through the real UI on the selected root branch.
        const forkRequestPromise = page.waitForRequest(
            (outgoing) =>
                outgoing.method() === "POST" &&
                new URL(outgoing.url()).pathname === `/api/v1/sessions/${compactSessionId}/fork`,
        );
        const forkResponsePromise = page.waitForResponse(
            (response) =>
                response.request().method() === "POST" &&
                new URL(response.url()).pathname === `/api/v1/sessions/${compactSessionId}/fork`,
        );
        const activeSessionItem = page.locator('[data-testid="session-item"][aria-current="page"]');
        await expect(activeSessionItem).toBeVisible();
        await activeSessionItem.click({ button: "right" });
        await page.getByTestId("session-item-fork").click();
        const forkRequest = await forkRequestPromise,
            forkResponse = await forkResponsePromise;
        expect(forkResponse.status(), await forkResponse.text()).toBe(201);
        expect(forkRequest.headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/i);
        expect(forkRequest.postDataJSON()).toMatchObject({
            sourceBranchId: compactRootBranchId,
            anchorMessageId: expect.any(String),
        });
        const childId = ((await forkResponse.json()) as { id: string }).id;
        await expect
            .poll(() => new URL(page.url()).pathname)
            .toBe(`/workspace/${journey.workspaceId}/chat/${childId}`);

        // Compressed seed: summary slot present alongside the projected messages.
        const childDb = readSessionSnapshot(childId);
        const summarySeed = childDb.seedPayload?.summary_seed as
            | {
                  messages: unknown[];
                  summary?: string;
                  summaryHash?: string;
                  contextEpoch?: string;
              }
            | undefined;
        if (!summarySeed) throw new Error("Compressed fork did not persist its summary seed event");
        expect(summarySeed.messages.length).toBeGreaterThan(0);
        expect(
            summarySeed.summary,
            "anchor-bounded projection must include the manual compaction SUM",
        ).toBeTruthy();
        expect(summarySeed.summaryHash).toBeTruthy();
        expect(summarySeed.contextEpoch).toBeTruthy();

        // First child round on the seeded context must complete (uncompressed equivalence
        // is covered by the first test in this file).
        await page
            .locator('[data-testid="chat-input"]')
            .waitFor({ state: "visible", timeout: 30000 });
        const childFirstRound = `child-first-round-after-compact-${Date.now()}`;
        await runChatRound(childFirstRound);
        await expect(page.locator('[data-slot="message"][data-align="end"]').last()).toContainText(
            childFirstRound,
        );

        const screenshot = testInfo.outputPath("session-branch-compressed-child.png");
        await page.screenshot({ path: screenshot, fullPage: false });
        await testInfo.attach("session-branch-compressed-child.png", {
            path: screenshot,
            contentType: "image/png",
        });
        expect(pageErrors).toEqual([]);
        expect(consoleErrors).toEqual([]);
    });
});

function seedUserGrant(userId: string, workspaceId: string) {
    const container = process.env.XIHE_E2E_PG_CONTAINER,
        database = process.env.XIHE_E2E_PG_DATABASE;
    const dbUser = process.env.XIHE_E2E_PG_USER;
    if (!container || !database || !dbUser) {
        throw new Error(
            "isolated PostgreSQL fixture metadata is unavailable; run through scripts/e2e-host.mjs",
        );
    }
    const permissions = JSON.stringify([
        { actionClass: "CREATE_ACCOUNT", resource: "*" },
        { actionClass: "CREATE_TEMPLATE", resource: "*" },
        { actionClass: "MANAGE_WORKSPACE_AGENTS", resource: workspaceId },
    ]).replaceAll("'", "''");
    execFileSync(
        process.platform === "win32" ? "docker.exe" : "docker",
        [
            "exec",
            container,
            "psql",
            "-X",
            "-A",
            "-t",
            "-U",
            dbUser,
            "-d",
            database,
            "-c",
            `INSERT INTO grants (id, granter_type, granter_id, subject_type, subject_id, permissions, source, read_state) ` +
                `VALUES (gen_random_uuid(), 'user', '${userId}'::uuid, 'user', '${userId}'::uuid, ` +
                `'${permissions}'::jsonb, 'direct', 'read')`,
        ],
        { encoding: "utf8", timeout: 15_000, windowsHide: true },
    );
}

function readSessionSnapshot(sessionId: string): {
    id: string;
    kind: string | null;
    workspaceId: string;
    userId: string;
    agentPrincipalId: string;
    agentPermissionsSnapshot: unknown;
    spawnedFromSessionId: string | null;
    spawnedFromRunId: string | null;
    branchCount: number;
    messageCount: number;
    fileCount: number;
    chatRunCount: number;
    historyCount: number;
    files: Array<{ id: string; messageId: string }>;
    seedPayload: { summary_seed: { messages: unknown[] } } | null;
} {
    const container = process.env.XIHE_E2E_PG_CONTAINER,
        database = process.env.XIHE_E2E_PG_DATABASE;
    const dbUser = process.env.XIHE_E2E_PG_USER;
    if (!container || !database || !dbUser) {
        throw new Error(
            "isolated PostgreSQL fixture metadata is unavailable; run through scripts/e2e-host.mjs",
        );
    }
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error("unexpected Session id");
    const sql =
        `SELECT jsonb_build_object(` +
        `'id', s.id, 'kind', s.kind, 'workspaceId', s.workspace_id, 'userId', s.user_id, ` +
        `'agentPrincipalId', s.agent_principal_id, 'agentPermissionsSnapshot', s.agent_permissions_snapshot, ` +
        `'spawnedFromSessionId', s.spawned_from_session_id, 'spawnedFromRunId', s.spawned_from_run_id, ` +
        `'branchCount', (SELECT count(*) FROM session_branches WHERE session_id = s.id), ` +
        `'messageCount', (SELECT count(*) FROM messages WHERE session_id = s.id), ` +
        `'fileCount', (SELECT count(*) FROM files WHERE session_id = s.id), ` +
        `'chatRunCount', (SELECT count(*) FROM chat_runs WHERE session_id = s.id), ` +
        `'historyCount', (SELECT count(*) FROM chat_run_history h JOIN chat_runs r ON r.id = h.run_id WHERE r.session_id = s.id), ` +
        `'files', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', f.id, 'messageId', f.message_id) ` +
        `ORDER BY f.created_at) FROM files f WHERE f.session_id = s.id), '[]'::jsonb), ` +
        `'seedPayload', (SELECT payload FROM context_events WHERE session_id = s.id ` +
        `AND event_type = 'session.forked' ORDER BY sequence DESC LIMIT 1)` +
        `)::text FROM sessions s WHERE s.id = '${sessionId}'::uuid`;
    const output = execFileSync(
        process.platform === "win32" ? "docker.exe" : "docker",
        ["exec", container, "psql", "-X", "-A", "-t", "-U", dbUser, "-d", database, "-c", sql],
        { encoding: "utf8", timeout: 15_000, windowsHide: true },
    ).trim();
    if (!output)
        throw new Error(`Session ${sessionId} was not found in the isolated PostgreSQL fixture`);
    return JSON.parse(output) as ReturnType<typeof readSessionSnapshot>;
}
