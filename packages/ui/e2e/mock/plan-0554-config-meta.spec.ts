import { expect, test } from "./helpers/mock-test";

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
            JSON.stringify({
                id: "user-1",
                email: "test@xihe.local",
                name: "Test",
                // PLAN-0610 W3-2b decision #22: authority comes from the capability projection,
                // never from the retired `role` string — `authStore.isAdmin` reads
                // `user.capabilities.isInstanceAdmin`. A fixture that only carries `role` models a
                // pre-upgrade cached user, so the instance layer this spec is about is unreachable
                // (the page silently falls back to the user layer and every source reads "user").
                capabilities: {
                    isInstanceAdmin: role === "ADMIN",
                    isInstanceSuper: role === "ADMIN",
                    workspaceAdminOf: role === "ADMIN" ? ["workspace-1"] : [],
                },
            }),
        );
        localStorage.setItem(
            "xihe-workspace",
            JSON.stringify({ id: "workspace-1", name: "Mock Workspace", ownerId: "user-1" }),
        );
    }, role);
    await page.route("**/api/v1/**", async (route) => {
        await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    // PLAN-0560: workspace settings page resolves the workspace context first.
    await page.route("**/api/v1/workspaces/workspace-1", (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                id: "workspace-1",
                name: "Mock Workspace",
                ownerId: "user-1",
            }),
        }),
    );
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
        // 旧：/settings/config 的 instance 层签；新：instance 层的 rag 域页（一页一域）。
        await page.goto("/settings/instance/rag", { waitUntil: "load" });
        await openRag(page);

        await expect(page.getByTestId("config-source-rag-chunkSize")).toContainText("instance");
        await expect(page.getByTestId("config-source-rag-chunkSize")).toContainText("可被覆盖");
        await expect(page.getByTestId("config-source-rag-topK")).toContainText("code default");
        await expect(page.getByTestId("config-source-rag-minScore")).toContainText("env 锁定");
        await expect(page.getByTestId("config-env-lock-rag-minScore")).toBeVisible();
        await expect(page.locator('input[type="checkbox"][name*="lock"]')).toHaveCount(0);
        await expect(page.getByRole("button", { name: /锁定|解锁/ })).toHaveCount(0);
    });

    test("user layer shows own value and inheritance", async ({ page }) => {
        await mockConfig(page, "ADMIN");
        // 旧：切到用户层签；新：用户层的 rag 域页。
        await page.goto("/settings/user/rag", { waitUntil: "load" });
        await openRag(page);

        await expect(page.getByTestId("config-source-rag-chunkSize")).toContainText("user");
        await expect(page.getByTestId("config-source-rag-chunkOverlap")).toContainText(
            "继承自 instance",
        );
        await expect(page.getByTestId("config-source-rag-minScore")).toContainText("env 锁定");
    });

    // PLAN-0752 V6（task-133）：点继承层徽标 ⇒ 跳到对应层同一条目并**聚焦**那条目。
    // 旧口径 V18 只把「徽标跳转」列成覆盖面（verify.md:113 自陈缺断言），这条把它变成判据：
    // ①落地 URL 的层与域正确且带 #<setting-key>；②目标行获得焦点并短暂高亮；③**无整页刷新**。
    test("inherited source chip jumps to the same key on the instance layer", async ({ page }) => {
        await mockConfig(page, "ADMIN");
        await page.goto("/settings/user/rag", { waitUntil: "load" });
        await openRag(page);

        // 用户层里 chunkOverlap 由实例层生效 ⇒ 继承层徽标可点（chunkSize 是生效层，不可点）
        const jump = page.getByTestId("config-source-jump-rag-chunkOverlap");
        await expect(jump).toBeVisible();
        await expect(page.getByTestId("config-source-jump-rag-chunkSize")).toHaveCount(0);

        // ③ 无整页刷新的判据：SPA 内跳转会保留 window 上的标记，整页刷新会把它抹掉。
        //    （不用 framenavigated —— 同文档 pushState 也会触发它，判不出「刷新」）
        //    偏离卡面：卡里给的备选是 performance.navigation 判据，但它已废弃（Navigation
        //    Timing L1），且"某事件没触发"是**负向证据**（监听器漏挂也会绿）；这里换成**正向
        //    证据**——整页刷新必然重建 window，标记必然消失。Lead 已于 VW-35 批准该偏离。
        await page.evaluate(() => {
            (window as unknown as { __spaMarker?: string }).__spaMarker = "alive";
        });
        await jump.click();

        // ① 落地 URL：实例层 + 同域 + 锚点
        await expect(page).toHaveURL(/\/settings\/instance\/rag#chunkOverlap$/);
        // ② 目标行：自动展开、获得焦点、短暂高亮
        const row = page.getByTestId("config-field-rag-chunkOverlap");
        await expect(row).toBeVisible();
        await expect(row).toHaveClass(/ring-2/);
        expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe(
            "config-field-rag-chunkOverlap",
        );
        // ③ 标记仍在 ⇒ 没有整页刷新
        expect(
            await page.evaluate(
                () => (window as unknown as { __spaMarker?: string }).__spaMarker ?? "",
            ),
        ).toBe("alive");
    });

    test("workspace settings config tab shows workspace override and instance inheritance", async ({
        page,
    }) => {
        await mockConfig(page, "ADMIN");
        await page.goto("/workspace/workspace-1/settings?tab=config", { waitUntil: "load" });
        await expect(page.getByTestId("workspace-settings-page")).toBeVisible();
        await openRag(page);

        await expect(page.getByTestId("config-source-rag-chunkSize")).toContainText("workspace");
        await expect(page.getByTestId("config-source-rag-chunkOverlap")).toContainText(
            "继承自 instance",
        );
    });

    test("ordinary user has no instance layer in the settings sidebar", async ({ page }) => {
        await mockConfig(page, "USER");
        await page.goto("/settings/user/rag", { waitUntil: "load" });

        // 旧：页签里只有 user（无 instance / workspace 签）；新：侧栏只渲染「用户配置」一段层分组。
        await expect(page.getByTestId("settings-nav-group-primary")).toHaveCount(1);
        await expect(page.getByTestId("settings-nav-group-primary")).toHaveText("用户配置");
        // 域链接必须全是用户层 URL —— 既没有 instance 段，也没有退役的 Policy 入口。
        const hrefs = await page
            .getByTestId("settings-nav-domain")
            .evaluateAll((els) => els.map((el) => el.getAttribute("href") ?? ""));
        expect(hrefs.length).toBeGreaterThan(0);
        expect(hrefs.every((href) => /^\/settings\/user\/[\w-]+$/.test(href))).toBe(true);
        expect(hrefs.some((href) => href.includes("/policy"))).toBe(false);
        // 实例独占域对普通用户不存在：直链落 404 视图，且不渲染该域面板。
        await page.goto("/settings/user/logging", { waitUntil: "load" });
        await expect(page.getByTestId("settings-not-found")).toBeVisible();
        await expect(page.getByTestId("config-domain-logging")).toHaveCount(0);
    });

    test("provider connection keeps master-detail, new-connection and source summary", async ({
        page,
    }) => {
        await mockConfig(page, "ADMIN");
        // 旧：切到用户层签再看 ProviderHub；新：用户层 llm-provider 域页就是 ProviderHub 的宿主。
        await page.goto("/settings/user/llm-provider", { waitUntil: "load" });

        await expect(page.getByTestId("provider-hub")).toBeVisible();
        await expect(page.getByTestId("provider-hub-connect")).toBeVisible();
        await expect(page.getByTestId("provider-connection-search")).toBeVisible();
        await expect(page.getByTestId("config-source-summary-llm-provider")).toContainText(
            "llm-provider.profile",
        );
    });
});
