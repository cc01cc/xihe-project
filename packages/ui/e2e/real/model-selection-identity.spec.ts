import { test, expect } from "@playwright/test";
import {
    CP_URL,
    ensureAgentWorkspaceBinding,
    getRootBranchId,
    registerJourneyUser,
    seedPage,
    sendChat,
    waitForControlPlaneAgentReady,
} from "./helpers/journey";
import {
    createSessionWithPrincipal,
    provisionWorkspaceAgentPrincipal,
} from "./helpers/agent-principal";

const LLM_MODE = process.env.XIHE_E2E_LLM_MODE ?? "mock";

test.describe("@host PLAN-0438 model selection connection identity", () => {
    test.skip(LLM_MODE !== "success", "requires XIHE_E2E_LLM_MODE=success fake LLM");

    test("selects fake-deepseek by real provider id and round-trips chat", async ({
        page,
        request,
    }) => {
        test.setTimeout(120_000);
        const ctx = await registerJourneyUser(request, "ModelSelection0438");
        const agentAuth = { accessToken: ctx.authToken, workspaceId: ctx.workspaceId };
        await ensureAgentWorkspaceBinding(ctx.workspaceId);
        await waitForControlPlaneAgentReady(request, ctx.headers);

        const principalId = await provisionWorkspaceAgentPrincipal(request, agentAuth, {
            name: "0438 Model Selector",
        });
        const sessionId = await createSessionWithPrincipal(request, agentAuth, {
            principalId,
            title: "0438 model selection",
        });

        seedPage(page, ctx);
        await page.goto(`/workspace/${ctx.workspaceId}/chat/${sessionId}`, { waitUntil: "load" });
        await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 15000 });

        // Open the model popover and pick the fake deepseek model through the
        // connection-scoped catalog (legacy provider/model selector contract).
        const trigger = page.getByTestId("model-popover-trigger");
        await expect(trigger).toBeVisible();
        await trigger.click();
        const search = page.getByTestId("model-popover-search");
        await expect(search).toBeVisible();
        await search.fill("fake-deepseek");
        const item = page.getByTestId("model-item-deepseek/fake-deepseek");
        await expect(item).toBeVisible({ timeout: 10000 });
        // First filter match selects on plain Enter (same guard as chat-availability).
        await search.press("Enter");

        // The session must persist the REAL provider id (deepseek), never the
        // connectionId-keyed catalog map key.
        await expect
            .poll(
                async () => {
                    const response = await request.get(`${CP_URL}/api/v1/sessions/${sessionId}`, {
                        headers: ctx.headers,
                    });
                    if (!response.ok()) return "";
                    const body = (await response.json()) as {
                        modelProvider?: string | null;
                        modelName?: string | null;
                        providerConnectionId?: string | null;
                    };
                    return `${body.modelProvider ?? ""}/${body.modelName ?? ""}`;
                },
                { timeout: 15000 },
            )
            .toBe("deepseek/fake-deepseek");

        const sessionResponse = await request.get(`${CP_URL}/api/v1/sessions/${sessionId}`, {
            headers: ctx.headers,
        });
        expect(sessionResponse.ok()).toBeTruthy();
        const sessionBody = (await sessionResponse.json()) as {
            providerConnectionId?: string | null;
        };
        if (sessionBody.providerConnectionId) {
            // When a concrete connection is bound it must be a UUID, not a provider id.
            expect(sessionBody.providerConnectionId).not.toBe("deepseek");
        }

        // End-to-end round trip through the selected model.
        const marker = `model-selection-${Date.now()}`;
        await sendChat(page, marker);
        await expect(page.getByText(marker, { exact: true })).toBeVisible({ timeout: 15000 });

        const headers = { ...ctx.headers, "X-Workspace-Id": ctx.workspaceId };
        const branchId = await getRootBranchId(request, sessionId, headers);
        await expect
            .poll(
                async () => {
                    const response = await request.get(
                        `${CP_URL}/api/v1/sessions/${sessionId}/messages?branchId=${branchId}`,
                        { headers },
                    );
                    if (!response.ok()) return 0;
                    const messages = (await response.json()) as Array<{
                        role?: string;
                        content?: string;
                    }>;
                    return messages.filter(
                        (message) =>
                            message.role === "ASSISTANT" && (message.content?.length ?? 0) > 0,
                    ).length;
                },
                { timeout: 60000 },
            )
            .toBeGreaterThan(0);

        const info = test.info();
        const screenshot = info.outputPath("plan-0438-model-selection-identity.png");
        await page.screenshot({ scale: "css", path: screenshot, fullPage: true });
        await info.attach("plan-0438-model-selection-identity.png", {
            path: screenshot,
            contentType: "image/png",
        });
    });
});
