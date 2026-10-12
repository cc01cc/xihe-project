import { test, expect } from "@playwright/test";
import { generateE2EPassword } from "./helpers/password";
import {
    createSessionWithPrincipal,
    provisionWorkspaceAgentPrincipal,
} from "./helpers/agent-principal";

const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();
const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;
const LLM_MODE = process.env.XIHE_E2E_LLM_MODE ?? "mock";

/**
 * PLAN-0492 T3.1/T3.2 host lane — real UI → CP → Agent chain:
 *
 * 1. Save `agent-runtime.runMaxTokens=1` through the real settings UI (user
 *    layer; the key is user/workspace writable per decision #19).
 * 2. Send one chat message: the first LLM call reports usage >= 1 token, the
 *    Agent's cumulative budget trips RUN_BUDGET_EXHAUSTED (dimension=tokens),
 *    the CP maps the run to `failed` and the UI shows the localized reason.
 * 3. Send a second message and prove the takeover entry: the session accepts a
 *    new run from the same input (the follow-up queue / takeover is the
 *    ordinary send path, no new mechanism).
 *
 * Run: mise run test:e2e:host -- --batch=run-budget
 */
test.describe("@host PLAN-0492 run-budget exhaustion", () => {
    test.skip(LLM_MODE !== "write_file", "requires XIHE_E2E_LLM_MODE=write_file (fake LLM usage)");

    test("exhausted run shows the localized token reason and stays resumable", async ({
        page,
        request,
    }) => {
        test.setTimeout(120000);

        const reg = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: {
                email: `run-budget-${Date.now()}@test.com`,
                password: SHARED_PASSWORD,
                name: "Run Budget",
            },
        });
        expect(reg.ok()).toBe(true);
        const auth = await reg.json();
        const principalId = await provisionWorkspaceAgentPrincipal(request, auth, {
            name: "Run Budget Agent",
            actions: ["read", "write"],
        });
        const sessionId = await createSessionWithPrincipal(request, auth, {
            principalId,
            title: "Run Budget",
        });
        await page.addInitScript(
            ({ token, workspaceId }) => {
                localStorage.setItem("xihe-token", token);
                localStorage.setItem("xihe-user", JSON.stringify({ workspaceId }));
                localStorage.setItem(
                    "xihe-workspace",
                    JSON.stringify({ id: workspaceId, name: "Default Workspace" }),
                );
            },
            { token: auth.accessToken, workspaceId: auth.workspaceId },
        );

        // 1. Tighten the run budget through the real config UI (user layer).
        await page.goto("/settings/config", { waitUntil: "load" });
        await expect(page.getByTestId("settings-config-heading")).toBeVisible({ timeout: 10000 });
        await page.getByTestId("config-tab-user").click();
        const panel = page.getByTestId("config-domain-agent-runtime");
        await expect(panel).toBeVisible({ timeout: 8000 });
        await panel.locator(":scope > button").click();
        const tokenInput = panel
            .getByTestId("config-field-agent-runtime-runMaxTokens")
            .locator("input");
        await expect(tokenInput).toBeVisible({ timeout: 8000 });
        await tokenInput.fill("1");
        const [saveResponse] = await Promise.all([
            page.waitForResponse(
                (response) =>
                    response.url().includes("/api/v1/config/user/agent-runtime") &&
                    response.request().method() === "PUT",
            ),
            panel.getByRole("button", { name: "保存", exact: true }).click(),
        ]);
        expect(saveResponse.status()).toBe(200);
        await expect(page.getByText(/已保存/)).toBeVisible({ timeout: 10000 });

        // 2. First run exhausts the token budget.
        await page.goto(`/workspace/${auth.workspaceId}/chat/${sessionId}`, { waitUntil: "load" });
        const textarea = page.locator("textarea");
        await expect(textarea).toBeVisible({ timeout: 15000 });
        const firstMarker = `budget-first-${Date.now()}`;
        await textarea.fill(firstMarker);
        await page.keyboard.press("Enter");
        await expect(page.getByText(firstMarker, { exact: true })).toBeVisible({ timeout: 10000 });

        const error = page.locator('[data-testid="message-error"]');
        await expect(error).toHaveCount(1, { timeout: 30000 });
        await expect(error).toContainText("RUN_BUDGET_EXHAUSTED");
        await expect(error).toContainText("budgetDimension=tokens");
        await expect(error).toContainText("本次运行已达到 Token 上限");
        await expect(page.locator('[data-testid="message-budget-exhausted-hint"]')).toContainText(
            "可在下方输入框继续发送，接续本次会话",
        );
        await expect(page.locator('[data-testid="message-retry-button"]')).toHaveCount(0);
        await page.screenshot({
            path: test.info().outputPath("run-budget-exhausted.png"),
            fullPage: true,
        });

        // 3. Takeover entry: the same input starts a new run in the same session.
        const secondMarker = `budget-second-${Date.now()}`;
        await expect(textarea).toBeEnabled({ timeout: 10000 });
        await textarea.fill(secondMarker);
        await page.keyboard.press("Enter");
        await expect(page.getByText(secondMarker, { exact: true })).toBeVisible({ timeout: 15000 });
        await expect(error).toHaveCount(2, { timeout: 30000 });
        await page.screenshot({
            path: test.info().outputPath("run-budget-exhausted-takeover.png"),
            fullPage: true,
        });
    });
});
