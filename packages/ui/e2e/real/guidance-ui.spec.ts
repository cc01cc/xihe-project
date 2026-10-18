import { expect, test, type APIRequestContext } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { generateE2EPassword } from "./helpers/password";
import { createWorkspaceSessionWithPrincipal } from "./helpers/agent-principal";
import {
    ensureAgentWorkspaceBinding,
    ensureChatBinding,
    seedPage,
    waitForControlPlaneAgentReady,
} from "./helpers/journey";
import type { JourneyContext } from "./helpers/journey";

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`,
    LLM_MODE = process.env.XIHE_E2E_LLM_MODE ?? "mock";

const evidenceDir = path.resolve(process.cwd(), "../../.local/evidence");

async function captureEvidence(page: import("@playwright/test").Page, name: string) {
    await mkdir(evidenceDir, { recursive: true });
    const path = `${evidenceDir}/${name}`;
    await page.screenshot({ path, fullPage: true });
    return path;
}

test.describe.configure({ mode: "serial", retries: 0 });

async function registerAndCreateSession(
    page: import("@playwright/test").Page,
    request: APIRequestContext,
): Promise<{
    authHeaders: Record<string, string>;
    sessionId: string;
    runId: string;
}> {
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

    // Reuse the approval-mode fixture from guidance-consume.spec.ts.
    const { createApprovalAgent } = await import("./helpers/guidance-approval-agent.ts");
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

    // Wait for the approval modal to confirm the run is in awaiting_approval.
    const modal = page.locator('[data-testid="modal-content"]');
    await expect(modal).toBeVisible({ timeout: 60_000 });

    return { authHeaders, sessionId, runId };
}

test("@host Guidance UI entry submits and projects pending status", async ({ page, request }) => {
    test.skip(LLM_MODE !== "approval", "requires deterministic approval tool-call fixture");
    test.setTimeout(180_000);

    const { authHeaders, sessionId, runId } = await registerAndCreateSession(page, request);

    // The GuidancePanel should now be visible (run is awaiting_approval).
    const panel = page.locator('[data-testid="guidance-panel"]');
    await expect(panel).toBeVisible({ timeout: 10_000 });

    // Guidance input should be visible and enabled.
    const input = page.locator('[data-testid="guidance-input"]');
    await expect(input).toBeVisible();
    const submitBtn = page.locator('[data-testid="guidance-submit"]');
    await expect(submitBtn).toBeVisible();

    const approvalModal = page.locator('[data-testid="modal-content"]');
    await approvalModal.getByRole("button", { name: "Close" }).click();
    await expect(approvalModal).toBeHidden();
    await expect(page.getByTestId("pending-approval-reopen-pill")).toBeVisible();

    // Fill and submit Guidance via UI.
    await input.fill("After the approved deletion, briefly confirm the result.");
    const guidanceResponse = page.waitForResponse(
        (response) =>
            response.url().includes(`/api/v1/chat/runs/${runId}/guidance`) &&
            response.request().method() === "POST",
    );
    await submitBtn.click();
    const response = await guidanceResponse;
    expect(response.status(), await response.text()).toBe(201);

    // The list should show the pending item.
    const list = page.locator('[data-testid="guidance-list"]');
    await expect(list).toBeVisible({ timeout: 5_000 });
    const item = list.locator('[data-status="pending"]');
    await expect(item).toBeVisible();
    await expect(item).toContainText("After the approved deletion");

    // Reopen and approve the pending tool call — the Agent should consume Guidance.
    await page.getByTestId("pending-approval-reopen-pill").click();
    const modal = page.locator('[data-testid="modal-content"]');
    await modal.locator('[data-testid="approval-approve"]').click();
    await expect(modal).toBeHidden({ timeout: 20_000 });

    // Poll for the consumed status via CP snapshot.
    let consumed = false;
    for (let poll = 0; poll < 120; poll += 1) {
        const snapshot = await request.get(`${CP_URL}/api/v1/chat/runs/${runId}/guidance`, {
            headers: authHeaders,
        });
        expect(snapshot.status(), await snapshot.text()).toBe(200);
        const body = (await snapshot.json()) as {
            items: Array<{ id: string; sequence: number; status: string }>;
        };
        if (body.items.some((item) => item.status === "consumed")) {
            consumed = true;
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(consumed, "Agent must consume Guidance after approval").toBe(true);

    // The approval fixture keeps requesting tools after the injected model call.
    // Reject every subsequent approval until the Run terminalizes so the terminal
    // refetch path is exercised; consumed entries stay consumed (never re-expired).
    for (let round = 0; round < 4; round += 1) {
        const nextApproval = modal.locator('[data-testid="approval-reject"]');
        const visible = await nextApproval
            .waitFor({ state: "visible", timeout: 10_000 })
            .then(() => true)
            .catch(() => false);
        if (!visible) break;
        await nextApproval.click();
        await expect(modal).toBeHidden({ timeout: 20_000 });
    }

    await expect(page.locator('[data-status="consumed"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-status="consumed"]')).toContainText("已纳入下一轮");

    const consumedScreenshot = await captureEvidence(page, "guidance-ui-consumed.png");
    expect(consumedScreenshot).toContain("guidance-ui-consumed.png");
});

test("@host Guidance UI hides input after cancel and an API rejection adds no phantom item", async ({
    page,
    request,
}) => {
    test.skip(LLM_MODE !== "approval", "requires deterministic approval tool-call fixture");
    test.setTimeout(180_000);

    const { authHeaders, runId } = await registerAndCreateSession(page, request);

    const panel = page.locator('[data-testid="guidance-panel"]');
    await expect(panel).toBeVisible({ timeout: 10_000 });

    // Dismiss the approval modal temporarily so the independent Guidance panel is reachable.
    await page
        .locator('[data-testid="modal-content"]')
        .getByRole("button", { name: "Close" })
        .click();
    await expect(page.locator('[data-testid="modal-content"]')).toBeHidden();

    const input = page.locator('[data-testid="guidance-input"]');
    await expect(input).toBeVisible();

    // Cancel through CP; the UI must stop offering the independent action (input hidden).
    const cancel = await request.post(`${CP_URL}/api/v1/chat/runs/${runId}/cancel`, {
        headers: authHeaders,
        data: { reason: "test_cancel_for_rejection" },
    });
    expect(cancel.status(), await cancel.text()).toBe(200);
    await expect(input).toBeHidden({ timeout: 20_000 });

    // V7b: a direct CP submission is rejected and the visible list gains no phantom item.
    const rejected = await request.post(`${CP_URL}/api/v1/chat/runs/${runId}/guidance`, {
        headers: { ...authHeaders, "Idempotency-Key": `guidance-e2e-${Date.now()}` },
        data: { content: "This must be rejected." },
    });
    expect(rejected.status(), await rejected.text()).toBe(409);
    await expect(page.locator('[data-testid="guidance-list"] li')).toHaveCount(0);

    const errorScreenshot = await captureEvidence(page, "guidance-ui-cancelled.png");
    expect(errorScreenshot).toContain("guidance-ui-cancelled.png");
});
