import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { generateE2EPassword } from "./password";
import { createWorkspaceSessionWithPrincipal } from "./agent-principal";
import {
    ensureAgentWorkspaceBinding,
    ensureChatBinding,
    seedPage,
    waitForControlPlaneAgentReady,
} from "./journey";
import type { JourneyContext } from "./journey";

/**
 * PLAN-0530/0536 shared Host fixture: register a user, create an approval-mode
 * agent, open a Session in the real UI, and drive one chat turn until the Run is
 * parked in `awaiting_approval` (the only deterministic active-Run state the
 * fake LLM can reach).
 *
 * Extracted from `guidance-ui.spec.ts` so the race journey (PLAN-0536) reuses
 * the identical precondition instead of duplicating it.
 */
export const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;

export interface GuidanceSessionFixture {
    authHeaders: Record<string, string>;
    workspaceId: string;
    sessionId: string;
    runId: string;
}

export async function registerAndCreateGuidanceSession(
    page: Page,
    request: APIRequestContext,
): Promise<GuidanceSessionFixture> {
    const password = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword(),
        register = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: {
                email: `guidance-ui-e2e-${Date.now()}@test.com`,
                password,
                name: "GuidanceUIE2E",
            },
        });
    expect([200, 201], await register.text()).toContain(register.status());
    const authBody = (await register.json()) as { accessToken: string; workspaceId: string },
        authHeaders = {
            Authorization: `Bearer ${authBody.accessToken}`,
            "Content-Type": "application/json",
        },
        me = await request.get(`${CP_URL}/api/v1/auth/me`, { headers: authHeaders });
    expect(me.status(), await me.text()).toBe(200);
    const userId = ((await me.json()) as { id: string }).id;

    const { createApprovalAgent } = await import("./guidance-approval-agent.ts");
    const principalId = await createApprovalAgent(request, {
        userId,
        workspaceId: authBody.workspaceId,
        headers: authHeaders,
    });

    await ensureAgentWorkspaceBinding(authBody.workspaceId);
    await waitForControlPlaneAgentReady(request, authHeaders);
    seedPage(page, {
        authToken: authBody.accessToken,
        workspaceId: authBody.workspaceId,
    } as JourneyContext);
    await page.goto(`/workspace/${authBody.workspaceId}`, { waitUntil: "load" });
    const sessionId = await createWorkspaceSessionWithPrincipal(page, principalId);
    await ensureChatBinding(page, sessionId);

    const textarea = page.locator("textarea");
    await expect(textarea).toBeVisible({ timeout: 20_000 });
    const sent = page.waitForResponse(
        (response) =>
            response.url().endsWith("/api/v1/chat") && response.request().method() === "POST",
    );
    await textarea.fill("please delete README.md");
    await page.getByTestId("chat-send-button").click();
    const chatResponse = await sent;
    expect(chatResponse.status(), await chatResponse.text()).toBe(202);
    const runId = ((await chatResponse.json()) as { runId: string }).runId;
    expect(runId).toBeTruthy();

    // The approval modal only renders once CP reports awaiting_approval.
    await expect(page.locator('[data-testid="modal-content"]')).toBeVisible({ timeout: 60_000 });

    return { authHeaders, workspaceId: authBody.workspaceId, sessionId, runId };
}

/** Dismisses the approval modal so the independent Guidance panel is clickable. */
export async function closeApprovalModal(page: Page): Promise<void> {
    const modal = page.locator('[data-testid="modal-content"]');
    await modal.getByRole("button", { name: "Close" }).click();
    await expect(modal).toBeHidden();
}
