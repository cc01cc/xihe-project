import { test, expect } from "@playwright/test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";

const connections = [
    {
        id: "connection-a",
        providerId: "openai",
        connectionKey: "default",
        apiTypeId: "openai-chat-completions",
        apiTypeVersion: 1,
        operation: "chat",
        label: "Personal",
        scope: "USER",
        enabled: true,
        status: "READY",
        revision: 1,
        hasKey: true,
        modelDiscovery: "manual",
        manualModels: ["gpt-5.1"],
    },
    {
        id: "connection-b",
        providerId: "openai",
        connectionKey: "openai-compat",
        apiTypeId: "openai-chat-completions",
        apiTypeVersion: 1,
        operation: "chat",
        label: "Work account",
        scope: "USER",
        enabled: true,
        status: "READY",
        revision: 2,
        hasKey: true,
        modelDiscovery: "manual",
        manualModels: ["gpt-5.1"],
    },
];

async function mockLabelBackend(page: import("@playwright/test").Page) {
    await page.route("**/api/v1/provider-connections**", async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ connections }),
        });
    });
    await page.route("**/api/v1/models", async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                models: { "connection-a": ["gpt-5.1"], "connection-b": ["gpt-5.1"] },
                providers: {
                    "connection-a": {
                        providerId: "openai",
                        connectionId: "connection-a",
                        connectionRevision: 1,
                        displayName: "OpenAI",
                        status: "ready",
                        models: [{ name: "gpt-5.1", capabilities: { chat: true } }],
                    },
                    "connection-b": {
                        providerId: "openai",
                        connectionId: "connection-b",
                        connectionRevision: 2,
                        displayName: "OpenAI",
                        status: "ready",
                        models: [{ name: "gpt-5.1", capabilities: { chat: true } }],
                    },
                },
            }),
        });
    });
}

test.describe("PLAN-0555 connection labels", () => {
    test.beforeEach(async ({ page }) => {
        await setupMockAuth(page);
        await setupMockSessions(page, { sessions: [{ id: "sid-1", title: "Labels" }] });
        await mockLabelBackend(page);
    });

    test("shows model, provider and connection, and the picker distinguishes two connections", async ({
        page,
    }) => {
        await page.goto("/workspace/workspace-1/chat/sid-1");
        const trigger = page.getByTestId("model-popover-trigger");
        await trigger.waitFor({ timeout: 10000 });

        await trigger.click();
        const groups = page.getByTestId("model-group-openai");
        await expect(groups.first()).toContainText("Personal");
        await expect(groups.first()).toContainText("default");
        await expect(groups.nth(1)).toContainText("Work account");
        await expect(groups.nth(1)).toContainText("openai-compat");
        await page.screenshot({ path: "test-results/plan-0555-desktop-picker.png" });

        const patchRequest = page.waitForRequest(
            (request) =>
                request.method() === "PATCH" && request.url().includes("/api/v1/sessions/sid-1"),
        );
        await page.locator('[data-connection-id="connection-b"] [role="option"]').first().click();
        const patchBody = (await patchRequest).postDataJSON() as {
            providerConnectionId?: string;
            modelName?: string;
        };
        expect(patchBody.providerConnectionId).toBe("connection-b");
        expect(patchBody.modelName).toBe("gpt-5.1");
        await expect(page.getByTestId("model-trigger-segment-model")).toHaveText("gpt-5.1");
        await expect(page.getByTestId("model-trigger-segment-provider")).toHaveText("OpenAI");
        await expect(page.getByTestId("model-trigger-segment-connection")).toHaveText(
            "Work account",
        );
        await page.screenshot({ path: "test-results/plan-0555-desktop.png", fullPage: false });

        await page.reload();
        await page.getByTestId("model-popover-trigger").waitFor({ timeout: 10000 });
        await expect(page.getByTestId("model-trigger-segment-connection")).toHaveText(
            "Work account",
        );
    });
});

test.describe("PLAN-0555 mobile label", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test("keeps three segments without overflow or touch tooltips", async ({ page }) => {
        await setupMockAuth(page);
        await setupMockSessions(page, { sessions: [{ id: "sid-1", title: "Labels" }] });
        await mockLabelBackend(page);
        await page.addInitScript(() => {
            localStorage.setItem(
                "xihe-session-models",
                JSON.stringify({
                    "sid-1": {
                        provider: "openai",
                        model: "gpt-5.1",
                        connectionId: "connection-b",
                        connectionRevision: 2,
                    },
                }),
            );
        });
        await page.goto("/workspace/workspace-1/chat/sid-1");
        await page.getByRole("button", { name: "Open chat" }).click();
        await page.getByTestId("model-popover-trigger").waitFor({ timeout: 10000 });

        await expect(page.getByTestId("model-trigger-segment-model")).toHaveText("gpt-5.1");
        await expect(page.getByTestId("model-trigger-segment-provider")).toHaveText("OpenAI");
        await expect(page.getByTestId("model-trigger-segment-connection")).toBeVisible();
        const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
        );
        expect(overflow).toBe(true);
        for (const testId of [
            "model-trigger-segment-model",
            "model-trigger-segment-provider",
            "model-trigger-segment-connection",
        ]) {
            const box = await page.getByTestId(testId).boundingBox();
            expect(box?.width ?? 0).toBeGreaterThan(20);
        }
        const tooltip = await page
            .getByTestId("model-trigger-segment-connection")
            .evaluate((element) => getComputedStyle(element, "::after").display);
        expect(tooltip).toBe("none");
        await page.screenshot({ path: "test-results/plan-0555-mobile.png", fullPage: false });
    });
});
