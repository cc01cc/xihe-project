import { test, expect } from "@playwright/test";

const META: Record<string, Record<string, unknown>> = {
    chunkSize: {
        key: "chunkSize",
        source: "instance",
        locked: false,
        writable: true,
        reason: null,
        instanceEligible: true,
        defaultPresent: true,
        overridable: true,
    },
    topK: {
        key: "topK",
        source: "code",
        locked: false,
        writable: true,
        reason: null,
        instanceEligible: true,
        defaultPresent: true,
        overridable: true,
    },
    chunkOverlap: {
        key: "chunkOverlap",
        source: "instance",
        locked: false,
        writable: true,
        reason: null,
        instanceEligible: true,
        defaultPresent: true,
        overridable: true,
    },
    minScore: {
        key: "minScore",
        source: "env",
        locked: true,
        writable: false,
        reason: "ENV_LOCKED",
        instanceEligible: true,
        defaultPresent: false,
        overridable: true,
    },
};

async function mockConfig(page: import("@playwright/test").Page, role: "ADMIN" | "USER") {
    await page.addInitScript((role) => {
        localStorage.setItem("xihe-token", "mock-token");
        localStorage.setItem(
            "xihe-user",
            JSON.stringify({ id: "user-1", email: "test@xihe.local", name: "Test", role }),
        );
        localStorage.setItem(
            "xihe-workspace",
            JSON.stringify({ id: "workspace-1", name: "Mock Workspace", ownerId: "user-1" }),
        );
    }, role);
    await page.route("**/api/v1/**", async (route) => {
        await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    const handleMeta = async (route: any) => {
        const requestUrl = new URL(route.request().url());
        const domain = requestUrl.pathname.split("/")[4] ?? "";
        const layer = requestUrl.searchParams.get("layer") ?? "instance";
        const keys =
            domain === "rag"
                ? Object.values(META).map((item) => ({ ...item }))
                : domain === "llm-provider"
                  ? [
                        {
                            key: "profile",
                            source: "user",
                            locked: false,
                            writable: true,
                            reason: null,
                            instanceEligible: false,
                            defaultPresent: false,
                            overridable: true,
                        },
                        {
                            key: "modelParams",
                            source: "user",
                            locked: false,
                            writable: true,
                            reason: null,
                            instanceEligible: false,
                            defaultPresent: false,
                            overridable: true,
                        },
                    ]
                  : [];
        if (layer === "user") {
            keys.forEach((item: any) => {
                if (item.key === "chunkSize") Object.assign(item, { source: "user" });
                if (item.key === "chunkOverlap") Object.assign(item, { source: "instance" });
                if (item.key === "minScore") Object.assign(item, { source: "env", locked: true });
            });
        }
        if (layer === "workspace") {
            keys.forEach((item: any) => {
                if (item.key === "chunkSize") Object.assign(item, { source: "workspace" });
                if (item.key === "chunkOverlap") Object.assign(item, { source: "instance" });
            });
        }
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ domain, layer, keys }),
        });
    };
    await page.route("**/api/v1/config/**", async (route) => {
        const requestUrl = new URL(route.request().url());
        const domain = requestUrl.pathname.split("/").pop() ?? "";
        if (domain === "meta") {
            await route.fallback();
            return;
        }
        const layer = requestUrl.searchParams.get("layer");
        const entries =
            domain === "rag"
                ? layer === "workspace"
                    ? { chunkSize: "800", minScore: "0.35" }
                    : layer === "user"
                      ? { chunkSize: "1200", minScore: "0.35" }
                      : { chunkSize: "1000", chunkOverlap: "200", minScore: "0.35" }
                : {};
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                domain,
                entries,
                envOverridden: domain === "rag" ? { minScore: "0.35" } : {},
            }),
        });
    });
    await page.route("**/api/v1/config/*/meta**", handleMeta);
    await page.route("**/api/v1/provider-connections**", (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ connections: [] }),
        }),
    );
    await page.route("**/api/v1/events**", (route) =>
        route.fulfill({
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
            body: "retry: 5000\n\n",
        }),
    );
}

async function openRag(page: import("@playwright/test").Page) {
    const domain = page.getByTestId("config-domain-rag");
    await expect(domain).toBeVisible();
    await domain.locator("button").first().click();
}

test.describe("PLAN-0554 config provenance", () => {
    test("instance shows source, code default and env lock without a lock switch", async ({
        page,
    }) => {
        await mockConfig(page, "ADMIN");
        await page.goto("/settings/config", { waitUntil: "load" });
        await openRag(page);

        await expect(page.getByTestId("config-source-rag-chunkSize")).toContainText("instance");
        await expect(page.getByTestId("config-source-rag-chunkSize")).toContainText("可被覆盖");
        await expect(page.getByTestId("config-source-rag-topK")).toContainText("code default");
        await expect(page.getByTestId("config-source-rag-minScore")).toContainText("env 锁定");
        await expect(page.getByTestId("config-env-lock-rag-minScore")).toBeVisible();
        await expect(page.locator('input[type="checkbox"][name*="lock"]')).toHaveCount(0);
        await expect(page.getByRole("button", { name: /锁定|解锁/ })).toHaveCount(0);
    });

    test("user tab shows own value and inheritance", async ({ page }) => {
        await mockConfig(page, "ADMIN");
        await page.goto("/settings/config", { waitUntil: "load" });
        await page.getByTestId("config-tab-user").click();
        await openRag(page);

        await expect(page.getByTestId("config-source-rag-chunkSize")).toContainText("user");
        await expect(page.getByTestId("config-source-rag-chunkOverlap")).toContainText(
            "继承自 instance",
        );
        await expect(page.getByTestId("config-source-rag-minScore")).toContainText("env 锁定");
    });

    test("workspace tab shows workspace override and instance inheritance", async ({ page }) => {
        await mockConfig(page, "ADMIN");
        await page.goto("/settings/config", { waitUntil: "load" });
        await page.getByTestId("config-tab-workspace").click();
        await openRag(page);

        await expect(page.getByTestId("config-workspace-transition")).toBeVisible();
        await expect(page.getByTestId("config-source-rag-chunkSize")).toContainText("workspace");
        await expect(page.getByTestId("config-source-rag-chunkOverlap")).toContainText(
            "继承自 instance",
        );
    });

    test("ordinary user has no instance tab or policy entry", async ({ page }) => {
        await mockConfig(page, "USER");
        await page.goto("/settings/config", { waitUntil: "load" });

        await expect(page.getByTestId("config-tab-instance")).toHaveCount(0);
        await expect(page.getByTestId("config-tab-user")).toBeVisible();
        await expect(page.getByTestId("config-tab-workspace")).toBeVisible();
        await expect(page.locator("nav").getByText("Policy", { exact: false })).toHaveCount(0);
        await expect(page.getByTestId("config-domain-logging")).toHaveCount(0);
    });

    test("provider connection keeps master-detail, new-connection and source summary", async ({
        page,
    }) => {
        await mockConfig(page, "ADMIN");
        await page.goto("/settings/config", { waitUntil: "load" });
        await page.getByTestId("config-tab-user").click();

        await expect(page.getByTestId("provider-hub")).toBeVisible();
        await expect(page.getByTestId("provider-hub-connect")).toBeVisible();
        await expect(page.getByTestId("provider-connection-search")).toBeVisible();
        await expect(page.getByTestId("config-source-summary-llm-provider")).toContainText(
            "llm-provider.profile",
        );
    });
});
