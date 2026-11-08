// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
import { DEFAULT_MOCK_ALLOW, expect, test } from "./helpers/mock-test";
import { expectPlatformScreenshot } from "../helpers/visual";
import { LONG_TIMEOUT_MS } from "../timeouts";

// BL-318：`shows an error banner when layer config cannot be loaded` 用
// `route.abort("connectionrefused")` **故意**制造网络失败（验"保存失败"横幅），逐条放行该信号。
test.use({ mockAllow: [...DEFAULT_MOCK_ALLOW, String.raw`net::ERR_CONNECTION_REFUSED`] });

const CONFIG_DOMAINS: Record<string, Record<string, string>> = {
    "llm-provider": {
        profile: JSON.stringify({
            providerId: "deepseek",
            connectionKey: "default",
            model: "deepseek-chat",
        }),
        temperature: "0.7",
    },
    "context-policy": { defaults: '{"softThresholdPct":0.8}' },
    embedding: { model: "text-embedding-3-small", dimensions: "1536" },
    rag: { chunkSize: "1000", topK: "5" },
    "agent-runtime": { useRegistry: "true" },
    "agent-profile": { userName: "zero" },
    "user-preference": { theme: "dark" },
    logging: { logLevel: "INFO", levelCp: "DEBUG" },
    "approval-policy": { mode: "manual" },
};

test.describe("Config Settings (three layers)", () => {
    test.beforeEach(async ({ page }) => {
        await page.addInitScript(() => {
            localStorage.setItem("xihe-token", "mock-token");
            localStorage.setItem(
                "xihe-user",
                JSON.stringify({
                    id: "u1",
                    email: "admin@xihe.local",
                    // PLAN-0610 W3-2b decision #22: `authStore.isAdmin` reads the capability
                    // projection (`user.capabilities.isInstanceAdmin`), not the retired `role`
                    // string. Without it the page renders as a plain user — no instance tab, no
                    // import/export block — which is what every assertion below depends on.
                    capabilities: {
                        isInstanceAdmin: true,
                        isInstanceSuper: true,
                        workspaceAdminOf: ["ws-1"],
                    },
                }),
            );
            localStorage.setItem(
                "xihe-workspace",
                JSON.stringify({ id: "ws-1", name: "Mock Workspace" }),
            );
        });
    });

    async function mockConfigAPIs(page: any, options: { delayMs?: number } = {}) {
        // Catch-all first: Playwright routes are LIFO, specific routes below win.
        await page.route("**/api/v1/**", async (route: any) => {
            if (options.delayMs)
                await new Promise((resolve) => setTimeout(resolve, options.delayMs));
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({}),
            });
        });
        // PLAN-0560: workspace settings page resolves the workspace context first.
        await page.route("**/api/v1/workspaces/ws-1", (route: any) =>
            route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ id: "ws-1", name: "Mock Workspace" }),
            }),
        );
        await page.route("**/api/v1/config/**", async (route: any) => {
            const url = new URL(route.request().url()),
                domain = url.pathname.split("/").pop() ?? "";
            if (options.delayMs)
                await new Promise((resolve) => setTimeout(resolve, options.delayMs));
            if (route.request().method() === "PUT") {
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({ status: "ok", keys: 1 }),
                });
                return;
            }
            const entries = CONFIG_DOMAINS[domain] ?? {};
            // Layer views get the includeMeta envelope; resolved reads stay flat.
            const body = url.searchParams.has("layer")
                ? {
                      domain,
                      entries,
                      envOverridden: domain === "embedding" ? { model: "env-embedding-model" } : {},
                  }
                : entries;
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(body),
            });
        });
        await page.route("**/api/v1/config/*/meta**", async (route: any) => {
            const url = new URL(route.request().url()),
                domain = url.pathname.split("/")[4] ?? "",
                layer = url.searchParams.get("layer") ?? "instance",
                entries = CONFIG_DOMAINS[domain] ?? {};
            const keys = Object.keys(entries).map((key) => {
                const locked = domain === "embedding" && key === "model";
                return {
                    key,
                    source: locked ? "env" : layer,
                    locked,
                    writable: !locked,
                    reason: locked ? "ENV_LOCKED" : null,
                    instanceEligible: true,
                    defaultPresent: false,
                    overridable: true,
                };
            });
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ domain, layer, keys }),
            });
        });
        await page.route("**/api/v1/events**", (route: any) =>
            route.fulfill({
                status: 200,
                headers: { "Content-Type": "text/event-stream" },
                body: "retry: 5000\n\n",
            }),
        );
    }

    test("renders layer tabs and the import/export entry for admins", async ({ page }) => {
        await mockConfigAPIs(page);
        await page.goto("/settings/config", { waitUntil: "load" });

        // The tabs render after `loadLayerDomains` settles; give that state wait a lane-sized
        // budget instead of the 5 s default (the element simply had not mounted yet under load).
        await expect(page.getByTestId("config-tab-instance")).toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
        // PLAN-0560: the workspace layer moved to each workspace's settings page.
        await expect(page.getByTestId("config-tab-workspace")).toHaveCount(0);
        await expect(page.getByTestId("config-tab-user")).toBeVisible();
        await expect(page.getByTestId("config-import-export")).toBeVisible();
        await expect(page.getByTestId("config-domain-logging")).toBeVisible();
        await expect(page.getByTestId("config-domain-agent-runtime")).toBeVisible();
        await expectPlatformScreenshot(page, "config-instance-tab.png");
    });

    test("instance tab keeps the instance-only instructions field", async ({ page }) => {
        await mockConfigAPIs(page);
        await page.goto("/settings/config", { waitUntil: "load" });

        await page.getByTestId("config-domain-agent-runtime").locator("button").first().click();
        await expect(page.getByTestId("config-field-agent-runtime-instructions")).toBeVisible();
    });

    test("workspace settings config tab shows workspace-scoped domains; MCP lives on its own tab", async ({
        page,
    }) => {
        await mockConfigAPIs(page);
        await page.goto("/workspace/ws-1/settings?tab=config", { waitUntil: "load" });

        await expect(page.getByTestId("workspace-settings-page")).toBeVisible();
        await expect(page.getByTestId("config-domain-agent-runtime")).toBeVisible();
        await expect(page.getByTestId("config-domain-agent-profile")).toHaveCount(0);
        await expect(page.getByTestId("config-domain-user-preference")).toHaveCount(0);
        await expect(page.getByTestId("config-domain-logging")).toHaveCount(0);
        await expectPlatformScreenshot(page, "config-workspace-tab.png");

        await page.getByTestId("ws-settings-tab-mcp").click();
        await expect(page.getByTestId("mcp-config-textarea")).toBeVisible();
        await expectPlatformScreenshot(page, "config-workspace-mcp-tab.png");
    });

    test("approval-policy is instance-writable, workspace-overridable and user-hidden", async ({
        page,
    }) => {
        await mockConfigAPIs(page);
        await page.goto("/settings/config", { waitUntil: "load" });

        // PLAN-0364 决策 #9（supersede PLAN-0337 选项①）：instance 层可写默认。
        const instanceDomain = page.getByTestId("config-domain-approval-policy");
        await expect(instanceDomain).toBeVisible();
        await instanceDomain.locator("button").first().click();
        const instanceSelect = page
            .getByTestId("config-field-approval-policy-mode")
            .locator("select");
        await expect(instanceSelect).toHaveValue("manual");

        // PLAN-0560: workspace override lives on the workspace settings page.
        await page.goto("/workspace/ws-1/settings?tab=config", { waitUntil: "load" });
        await expect(page.getByTestId("workspace-settings-page")).toBeVisible();
        const domain = page.getByTestId("config-domain-approval-policy");
        await expect(domain).toBeVisible();
        await domain.locator("button").first().click();

        const modeSelect = page.getByTestId("config-field-approval-policy-mode").locator("select");
        await expect(modeSelect).toHaveValue("manual");
        await expect(modeSelect.locator("option")).toHaveCount(2);

        // user 层仍不可写（显式例外）
        await page.goto("/settings/config", { waitUntil: "load" });
        await page.getByTestId("config-tab-user").click();
        await expect(page.getByTestId("config-domain-approval-policy")).toHaveCount(0);
    });

    test("saving the approval mode goes through the workspace endpoint", async ({ page }) => {
        await mockConfigAPIs(page);
        await page.goto("/workspace/ws-1/settings?tab=config", { waitUntil: "load" });

        await page.getByTestId("config-domain-approval-policy").locator("button").first().click();
        await page
            .getByTestId("config-field-approval-policy-mode")
            .locator("select")
            .selectOption("auto");

        const [request] = await Promise.all([
            page.waitForRequest(
                (req) =>
                    req.method() === "PUT" &&
                    req.url().includes("/api/v1/config/workspace/approval-policy"),
            ),
            page
                .getByTestId("config-domain-approval-policy")
                .getByRole("button", { name: "保存" })
                .click(),
        ]);
        expect(JSON.parse(request.postData() ?? "{}").mode).toBe("auto");
    });

    test("user tab drops instance-only domains and the instructions field", async ({ page }) => {
        await mockConfigAPIs(page);
        await page.goto("/settings/config", { waitUntil: "load" });

        await page.getByTestId("config-tab-user").click();
        await expect(page.getByTestId("config-domain-agent-profile")).toBeVisible();
        await expect(page.getByTestId("config-domain-user-preference")).toBeVisible();
        await expect(page.getByTestId("config-domain-logging")).toHaveCount(0);
        await page.getByTestId("config-domain-agent-runtime").locator("button").first().click();
        await expect(page.getByTestId("config-field-agent-runtime-instructions")).toHaveCount(0);
    });

    test("env-locked embedding model shows the env source and stays read-only", async ({
        page,
    }) => {
        await mockConfigAPIs(page);
        await page.goto("/workspace/ws-1/settings?tab=config", { waitUntil: "load" });

        await expect(page.getByTestId("embedding-settings")).toBeVisible();
        const source = page.getByTestId("config-source-summary-embedding");
        await expect(source).toBeVisible();
        await expect(source).toContainText("embedding.model");
        await expect(source).toContainText("env 锁定");
    });

    test("saving a value goes through the layer endpoint", async ({ page }) => {
        await mockConfigAPIs(page);
        await page.goto("/settings/config", { waitUntil: "load" });

        await expect(page.getByTestId("config-domain-logging")).toBeVisible();
        await page.getByTestId("config-domain-logging").locator("button").first().click();
        await page
            .getByTestId("config-field-logging-levelCp")
            .locator("select")
            .selectOption("ERROR");

        const [request] = await Promise.all([
            page.waitForRequest(
                (req) =>
                    req.method() === "PUT" && req.url().includes("/api/v1/config/instance/logging"),
            ),
            page.getByTestId("config-domain-logging").getByRole("button", { name: "保存" }).click(),
        ]);
        expect(JSON.parse(request.postData() ?? "{}").levelCp).toBe("ERROR");
    });

    test("export triggers the instance export request", async ({ page }) => {
        await mockConfigAPIs(page);
        await page.goto("/settings/config", { waitUntil: "load" });

        const [request] = await Promise.all([
            page.waitForRequest((req) => req.url().includes("/api/v1/config/export")),
            page.getByTestId("config-export-button").click(),
        ]);
        expect(request.url()).toContain("layer=instance");
        expect(request.url()).toContain("includeSecrets=true");
    });

    test("import posts the file and renders skip warnings", async ({ page }) => {
        await mockConfigAPIs(page);
        await page.route("**/api/v1/config/import**", async (route: any) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    status: "ok",
                    imported: 2,
                    skipped: 1,
                    warnings: [
                        "provider-connections: 1 credential(s) skipped - rebuild them via the provider connections API/UI",
                    ],
                }),
            });
        });
        await page.goto("/settings/config", { waitUntil: "load" });

        await page.getByTestId("config-import-input").setInputFiles({
            name: "config.import.local.jsonc",
            mimeType: "application/json",
            buffer: Buffer.from('{"logging":{"logLevel":"INFO"}}'),
        });
        await expect(page.getByTestId("config-import-warnings")).toBeVisible();
        await expect(page.getByTestId("config-import-warnings")).toContainText(
            "credential(s) skipped",
        );
    });

    test("shows loading state while layer config is pending", async ({ page }) => {
        await mockConfigAPIs(page, { delayMs: 3000 });
        await page.goto("/settings/config", { waitUntil: "load" });
        await expect(page.locator("text=加载中...")).toBeVisible();
    });

    test("shows an error banner when layer config cannot be loaded", async ({ page }) => {
        await page.route("**/api/v1/**", (route: any) =>
            route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({}),
            }),
        );
        await page.route("**/api/v1/config/**", (route: any) => route.abort("connectionrefused"));
        await page.route("**/api/v1/events**", (route: any) =>
            route.fulfill({
                status: 200,
                headers: { "Content-Type": "text/event-stream" },
                body: "retry: 5000\n\n",
            }),
        );
        await page.goto("/settings/config", { waitUntil: "load" });
        await expect(page.getByTestId("settings-config-heading")).toBeVisible();
        await expect(page.locator("text=保存失败")).toBeVisible();
    });
});
