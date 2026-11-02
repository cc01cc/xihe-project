import { test, expect } from "@playwright/test";
import { ModelPopoverPage } from "../page-objects/ModelPopoverPage";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";

test.describe("Model Popover", () => {
    test.beforeEach(async ({ page }) => {
        await setupMockAuth(page);
        // Sessions are server-canonical (PLAN-029); the popover persists the
        // per-session binding, so the mock must expose the session endpoint.
        await setupMockSessions(page, { sessions: [{ id: "sid-1", title: "Test Chat" }] });

        await page.route("**/api/v1/models", async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    models: {
                        deepseek: ["deepseek-chat", "deepseek-reasoner"],
                        openai: ["gpt-4o"],
                    },
                    // PLAN-0438/0523: catalogs are keyed by **ProviderConnection id** (the
                    // `connectionId`), not by provider id, and `ModelPopover.providerGroups`
                    // keeps only catalogs whose key is an enabled + READY + `operation=chat`
                    // connection. A provider-keyed catalog with no connections (the previous
                    // fixture) produced zero groups, so the popover opened empty.
                    providers: {
                        "conn-deepseek": {
                            providerId: "deepseek",
                            displayName: "DeepSeek",
                            status: "ready",
                            connectionId: "conn-deepseek",
                            connectionRevision: 1,
                            models: [
                                {
                                    name: "deepseek-chat",
                                    capabilities: { chat: true, vision: false, tools: true },
                                },
                                {
                                    name: "deepseek-reasoner",
                                    capabilities: { chat: true, vision: false, tools: true },
                                },
                            ],
                        },
                        "conn-openai": {
                            providerId: "openai",
                            displayName: "OpenAI",
                            status: "ready",
                            connectionId: "conn-openai",
                            connectionRevision: 1,
                            models: [
                                {
                                    name: "gpt-4o",
                                    capabilities: { chat: true, vision: true, tools: true },
                                },
                            ],
                        },
                    },
                }),
            });
        });

        // The connection list is the authority the popover gates catalogs on, so it must
        // describe the same two connections the catalog is keyed by (PLAN-0523 T3.5).
        await page.route("**/api/v1/provider-connections**", async (route) => {
            const connection = (
                id: string,
                providerId: string,
                connectionKey: string,
                label: string,
            ) => ({
                id,
                providerId,
                connectionKey,
                apiTypeId: "openai-chat-completions",
                apiTypeVersion: 1,
                operation: "chat",
                label,
                scope: "USER",
                modelDiscovery: "curated",
                manualModels: [],
                hasKey: true,
                enabled: true,
                status: "READY",
                revision: 1,
            });
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    connections: [
                        connection("conn-deepseek", "deepseek", "default", "DeepSeek 默认"),
                        connection("conn-openai", "openai", "default", "OpenAI 默认"),
                    ],
                }),
            });
        });
    });

    test("model popover trigger button is visible", async ({ page }) => {
        await page.goto("/workspace/workspace-1/chat/sid-1");
        await page.waitForTimeout(2000);

        const popover = new ModelPopoverPage(page);
        await expect(popover.trigger).toBeVisible({ timeout: 5000 });
    });

    test("clicking trigger opens popover with provider groups", async ({ page }) => {
        await page.goto("/workspace/workspace-1/chat/sid-1");
        await page.waitForTimeout(2000);

        const popover = new ModelPopoverPage(page);
        await popover.open();
        await page.waitForTimeout(500);

        await expect(popover.groupLocator("deepseek")).toBeVisible();
        await expect(popover.groupLocator("openai")).toBeVisible();
        await expect(popover.itemLocator("deepseek", "deepseek-chat")).toBeVisible();
        await expect(popover.itemLocator("openai", "gpt-4o")).toBeVisible();
    });

    test("selecting a model updates trigger text and persists to localStorage", async ({
        page,
    }) => {
        await page.goto("/workspace/workspace-1/chat/sid-1");
        await page.waitForTimeout(2000);

        const popover = new ModelPopoverPage(page);
        await popover.open();
        await page.waitForTimeout(500);

        await popover.selectModel("deepseek", "deepseek-chat");
        await page.waitForTimeout(500);

        await expect(popover.trigger).toContainText("deepseek-chat");

        const stored = await page.evaluate(() => localStorage.getItem("xihe-session-models"));
        expect(stored).toBeTruthy();
        const parsed = JSON.parse(stored!);
        // PLAN-0438 scoped bindings: a selection now persists the concrete connection and its
        // revision next to provider/model, because dispatch is connection-scoped. Asserting the
        // full new shape (not a subset) keeps this exact-match check as strict as before.
        expect(parsed["sid-1"]).toEqual({
            provider: "deepseek",
            model: "deepseek-chat",
            connectionId: "conn-deepseek",
            connectionRevision: 1,
        });
    });

    test("search filters models", async ({ page }) => {
        await page.goto("/workspace/workspace-1/chat/sid-1");
        await page.waitForTimeout(2000);

        const popover = new ModelPopoverPage(page);
        await popover.open();
        await page.waitForTimeout(500);

        await popover.search("reasoner");
        await page.waitForTimeout(300);

        await expect(popover.itemLocator("deepseek", "deepseek-reasoner")).toBeVisible();
        await expect(popover.itemLocator("openai", "gpt-4o")).not.toBeVisible();
    });

    test("selected model persists after page reload", async ({ page }) => {
        await page.goto("/workspace/workspace-1/chat/sid-1");
        await page.waitForTimeout(2000);

        const popover = new ModelPopoverPage(page);
        await popover.open();
        await page.waitForTimeout(500);

        await popover.selectModel("openai", "gpt-4o");
        await page.waitForTimeout(500);

        await page.reload();
        await page.waitForTimeout(2000);

        await expect(popover.trigger).toContainText("gpt-4o");
    });

    test("favorite toggle persists to localStorage", async ({ page }) => {
        await page.addInitScript(() => {
            localStorage.setItem("xihe-model-favorites", "[]");
        });

        await page.goto("/workspace/workspace-1/chat/sid-1");
        await page.waitForTimeout(2000);

        const popover = new ModelPopoverPage(page);
        await popover.open();
        await page.waitForTimeout(500);

        await popover.toggleFavorite("deepseek", "deepseek-chat");
        await page.waitForTimeout(300);

        const stored = await page.evaluate(() => localStorage.getItem("xihe-model-favorites"));
        expect(stored).toBeTruthy();
        const parsed = JSON.parse(stored!);
        expect(parsed.length).toBeGreaterThan(0);
    });
});
