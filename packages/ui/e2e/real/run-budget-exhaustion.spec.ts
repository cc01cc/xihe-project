import { test, expect } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { createHash } from "node:crypto";
import {
    createSessionWithPrincipal,
    provisionWorkspaceAgentPrincipal,
} from "./helpers/agent-principal";

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;
const LLM_MODE = process.env.XIHE_E2E_LLM_MODE ?? "mock";
const SHARED_EMAIL = "run-budget@test.com";
// The batch reuses one stack, so the shared account's password must be stable
// across runs (a fresh random password would 401 on the second run).
const SHARED_PASSWORD =
    process.env.XIHE_E2E_PASSWORD ??
    `Rb${createHash("sha256").update(SHARED_EMAIL).digest("hex").slice(0, 16)}`;

// The Agent process binds one MCP workspace context per lifetime, so the mobile
// viewport pass must reuse the desktop pass's user/workspace (xh-host-e2e-pitfalls).
test.describe.configure({ mode: "serial" });

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
 * 4. A second, serial pass re-checks the same surface at the 390x844 mobile
 *    viewport (same user/workspace because of the single-workspace Agent binding).
 *
 * Run: mise run test:e2e:host -- --batch=run-budget
 */
test.describe("@host PLAN-0492 run-budget exhaustion", () => {
    test.skip(LLM_MODE !== "write_file", "requires XIHE_E2E_LLM_MODE=write_file (fake LLM usage)");

    type Auth = { accessToken: string; workspaceId: string };
    let auth: Auth;
    let sessionId: string;

    function installAuth(page: Page, value: Auth): Promise<void> {
        return page.addInitScript(
            ({ token, workspaceId }) => {
                localStorage.setItem("xihe-token", token);
                localStorage.setItem("xihe-user", JSON.stringify({ workspaceId }));
                localStorage.setItem(
                    "xihe-workspace",
                    JSON.stringify({ id: workspaceId, name: "Default Workspace" }),
                );
            },
            { token: value.accessToken, workspaceId: value.workspaceId },
        );
    }

    async function registerUser(request: APIRequestContext): Promise<Auth> {
        const reg = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: { email: SHARED_EMAIL, password: SHARED_PASSWORD, name: "Run Budget" },
        });
        if (reg.ok()) return (await reg.json()) as Auth;
        const login = await request.post(`${CP_URL}/api/v1/auth/login`, {
            data: { identifier: SHARED_EMAIL, password: SHARED_PASSWORD },
        });
        expect(login.ok()).toBe(true);
        return (await login.json()) as Auth;
    }

    async function tightenTokenBudget(page: Page): Promise<void> {
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
    }

    test("exhausted run shows the localized token reason and stays resumable", async ({
        page,
        request,
    }) => {
        test.setTimeout(120000);

        auth = await registerUser(request);
        const principalId = await provisionWorkspaceAgentPrincipal(request, auth, {
            name: "Run Budget Agent",
            actions: ["read", "write"],
        });
        sessionId = await createSessionWithPrincipal(request, auth, {
            principalId,
            title: "Run Budget",
        });
        await installAuth(page, auth);

        // 1. Tighten the run budget through the real config UI (user layer).
        await tightenTokenBudget(page);

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

    test("exhaustion surface stays readable on a mobile viewport", async ({ page }) => {
        test.setTimeout(120000);

        // Reuse the same user/workspace as the desktop pass (Agent single-workspace
        // MCP binding); the token budget is already 1 from the first pass.
        await installAuth(page, auth);
        await page.goto(`/workspace/${auth.workspaceId}/chat/${sessionId}`, { waitUntil: "load" });
        await page.setViewportSize({ width: 390, height: 844 });
        // At 390px the app shell defaults to the Files pane; the chat composer is
        // reachable through the "Open chat" toggle (same entry as the queue mobile spec).
        const openChat = page.getByRole("button", { name: "Open chat" });
        await expect(openChat).toBeVisible({ timeout: 20000 });
        await openChat.click();
        const textarea = page.locator("textarea");
        await expect(textarea).toBeVisible({ timeout: 15000 });
        const marker = `budget-mobile-${Date.now()}`;
        await textarea.fill(marker);
        await page.keyboard.press("Enter");
        await expect(page.getByText(marker, { exact: true })).toBeVisible({ timeout: 10000 });

        // The session already carries the two desktop-run errors; this mobile run
        // adds the third block (fresh render at the mobile viewport).
        const error = page.locator('[data-testid="message-error"]');
        await expect(error).toHaveCount(3, { timeout: 30000 });
        const latest = error.last();
        await expect(latest).toContainText("本次运行已达到 Token 上限");
        const hint = page.locator('[data-testid="message-budget-exhausted-hint"]').last();
        await expect(hint).toBeVisible();

        const errorBox = await latest.boundingBox();
        expect(errorBox).not.toBeNull();
        expect(errorBox!.x + errorBox!.width).toBeLessThanOrEqual(390 + 1);
        await page.screenshot({
            path: test.info().outputPath("run-budget-exhausted-mobile.png"),
            fullPage: true,
        });
    });
});
