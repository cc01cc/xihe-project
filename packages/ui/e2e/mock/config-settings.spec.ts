// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
import { DEFAULT_MOCK_ALLOW, expect, test } from "./helpers/mock-test";
import { expectPlatformScreenshot } from "../helpers/visual";
import { LONG_TIMEOUT_MS } from "../timeouts";
import { expectTriggerLabel, selectByTestId } from "../helpers/select";

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

    // PLAN-0752 M1 换掉了「层 = 页内页签」的交互：层现在是左栏的两个分组，域是二级链接
    // （`SettingsSidebar`）。所以本用例证明的同一件事换了承载物：
    //   旧 config-tab-instance / config-tab-user    → settings-nav-group-primary 的两段（实例配置 / 用户配置）
    //   旧 config-tab-workspace 不存在              → 所有域链接都是 /settings/(instance|user)/<domain>，无 workspace 段
    //   旧 config-domain-logging / -agent-runtime   → 域页 `/settings/instance/<domain>` 里的同名面板
    // 旧用例里的「admin 才看得到导入导出入口」移到导出用例（数据页）继续断言，不在这里重复。
    test("settings sidebar exposes both layers to admins, domain pages render their panels", async ({
        page,
    }) => {
        await mockConfigAPIs(page);
        await page.goto("/settings/instance/logging", { waitUntil: "load" });

        // 侧栏层分组要等能力投影落定（cap:instance:admin）；给足 lane 预算而不是 5 s 默认值。
        await expect(page.getByTestId("settings-nav-group-primary")).toHaveCount(2, {
            timeout: LONG_TIMEOUT_MS,
        });
        await expect(page.getByTestId("settings-domain-title")).toHaveText("日志设置");
        await expect(page.getByTestId("config-domain-logging")).toBeVisible();

        // 同层另一个域：一页一域，所以换页验第二块面板仍在。
        await page.goto("/settings/instance/agent-runtime", { waitUntil: "load" });
        await expect(page.getByTestId("config-domain-agent-runtime")).toBeVisible();

        // PLAN-0560：工作区层不在全局设置区（只在 /workspace/:id/settings）——层进 URL 里没有 workspace 段。
        const hrefs = await page
            .getByTestId("settings-nav-domain")
            .evaluateAll((els) => els.map((el) => el.getAttribute("href") ?? ""));
        expect(hrefs.length).toBeGreaterThan(0);
        expect(hrefs.every((href) => /^\/settings\/(instance|user)\/[\w-]+$/.test(href))).toBe(
            true,
        );
        await expectPlatformScreenshot(page, "config-instance-tab.png");
    });

    test("instance layer keeps the instance-only instructions field", async ({ page }) => {
        await mockConfigAPIs(page);
        // 旧：/settings/config 的 instance 层签里展开 agent-runtime；新：instance 层的 agent-runtime 域页（一页一域）。
        await page.goto("/settings/instance/agent-runtime", { waitUntil: "load" });

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
        // 旧：/settings/config 的 instance 层签；新：instance 层的 approval-policy 域页。
        await page.goto("/settings/instance/approval-policy", { waitUntil: "load" });

        // PLAN-0364 决策 #9（supersede PLAN-0337 选项①）：instance 层可写默认。
        const instanceDomain = page.getByTestId("config-domain-approval-policy");
        await expect(instanceDomain).toBeVisible();
        await instanceDomain.locator("button").first().click();
        await expectTriggerLabel(page, "config-select-approval-policy-mode", "manual");

        // PLAN-0560: workspace override lives on the workspace settings page.
        await page.goto("/workspace/ws-1/settings?tab=config", { waitUntil: "load" });
        await expect(page.getByTestId("workspace-settings-page")).toBeVisible();
        const domain = page.getByTestId("config-domain-approval-policy");
        await expect(domain).toBeVisible();
        await domain.locator("button").first().click();

        const modeSelect = page.getByTestId("config-select-approval-policy-mode");
        await expect(modeSelect).toContainText("手动审批");
        await modeSelect.click();
        await expect(page.getByRole("option")).toHaveCount(2);
        await page.keyboard.press("Escape");

        // user 层仍不可写（显式例外）：层×域矩阵里 user 层没有 approval-policy，
        // 直链落「该组合不存在」的 404 视图（V3/V25），而不是渲染一块点不动的面板。
        await page.goto("/settings/user/approval-policy", { waitUntil: "load" });
        await expect(page.getByTestId("settings-not-found")).toBeVisible();
        await expect(page.getByTestId("config-domain-approval-policy")).toHaveCount(0);
    });

    test("saving the approval mode goes through the workspace endpoint", async ({ page }) => {
        await mockConfigAPIs(page);
        await page.goto("/workspace/ws-1/settings?tab=config", { waitUntil: "load" });

        await page.getByTestId("config-domain-approval-policy").locator("button").first().click();
        await selectByTestId(page, "config-select-approval-policy-mode", "auto");

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

    test("user layer drops instance-only domains and the instructions field", async ({ page }) => {
        await mockConfigAPIs(page);

        // 用户层的域各占一页；旧用例在同一个「用户层签」里一次看全，现在按域逐个验同一批事实。
        await page.goto("/settings/user/agent-profile", { waitUntil: "load" });
        await expect(page.getByTestId("config-domain-agent-profile")).toBeVisible();
        await page.goto("/settings/user/user-preference", { waitUntil: "load" });
        await expect(page.getByTestId("config-domain-user-preference")).toBeVisible();

        // logging 是实例独占域：用户层矩阵里没有它 ⇒ 直链 404 视图（旧断言是「用户层签里不出现该面板」）。
        await page.goto("/settings/user/logging", { waitUntil: "load" });
        await expect(page.getByTestId("settings-not-found")).toBeVisible();
        await expect(page.getByTestId("config-domain-logging")).toHaveCount(0);

        // 实例专属字段：「用户层看不到」这条旧口径被 PLAN-0752 T3.2 / design §5.1 取代 ——
        // 不再静默隐藏（隐藏会让人以为没这项），而是渲染成只读行 + 「仅实例层」徽标。
        await page.goto("/settings/user/agent-runtime", { waitUntil: "load" });
        await expect(page.getByTestId("config-domain-agent-runtime")).toBeVisible();
        await page.getByTestId("config-domain-agent-runtime").locator("button").first().click();
        const instructions = page.getByTestId("config-field-agent-runtime-instructions");
        await expect(instructions).toBeVisible();
        await expect(
            page.getByTestId("config-key-layer-badge-agent-runtime-instructions"),
        ).toHaveText("仅实例层");
        await expect(instructions.locator("input, textarea").first()).toBeDisabled();
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
        // 旧：/settings/config 的 instance 层签；新：instance 层的 logging 域页，保存仍走层端点。
        await page.goto("/settings/instance/logging", { waitUntil: "load" });

        // 域面板要等层配置 GET 落定才挂载；4 worker 满载时 5 s 默认值不够（2026-11-10 全量实测 flaky），
        // 这里给 lane 预算（文件头已有 timeout-exempt 说明），只放宽等待、不放宽断言。
        await expect(page.getByTestId("config-domain-logging")).toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
        await page.getByTestId("config-domain-logging").locator("button").first().click();
        await selectByTestId(page, "config-select-logging-levelCp", "ERROR");

        const [request] = await Promise.all([
            page.waitForRequest(
                (req) =>
                    req.method() === "PUT" && req.url().includes("/api/v1/config/instance/logging"),
            ),
            page.getByTestId("config-domain-logging").getByRole("button", { name: "保存" }).click(),
        ]);
        expect(JSON.parse(request.postData() ?? "{}").levelCp).toBe("ERROR");
    });

    // PLAN-0752 M1 把配置页换成域页后，旧的「配置导入/导出」区块随死页一起没了入口；
    // 现存的导出/导入入口在「数据」页（/settings/data，T4.4：数据面是有 atom 的页）。
    // 旧断言还验过 URL 上的 layer=instance 与 includeSecrets=true —— 这两个值自 0752 起不再由 UI 传参，
    // 而是 CP 的默认值（ConfigController.java:492-505：layer 服务端写死 instance、includeSecrets 默认 true）；
    // 该不变量由 CP 侧测试守（task-111/dev-1 补），UI 侧只证明「导出按钮确实打到实例导出端点」。
    test("export triggers the instance export request", async ({ page }) => {
        await mockConfigAPIs(page);
        await page.goto("/settings/data", { waitUntil: "load" });

        const [request] = await Promise.all([
            page.waitForRequest((req) => req.url().includes("/api/v1/config/export")),
            page.locator('button:has-text("导出设置")').click(),
        ]);
        expect(request.url()).toContain("/api/v1/config/export");
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

    // 待裁定（task-109 报告 §三）：旧的「初始加载中…」是死页 ConfigSettings 里的整页状态
    // （showInitialLoading），新壳 SettingsDomainView 没有等价的 pending 呈现 —— 加载期间它会渲染
    // 「本域 0 项配置」+ 空表单，等于把「还没回来」画成「没有配置」。要么产品补 loading，要么
    // 明示该断言退役；在裁定前保持红，不改弱断言。
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
        // 旧：/settings/config 里层的整块加载失败；新：域页拉层配置失败（SettingsDomainView 的 fetchError 分支）。
        await page.goto("/settings/instance/logging", { waitUntil: "load" });
        await expect(page.getByTestId("settings-domain-title")).toBeVisible();
        await expect(page.locator("text=保存失败")).toBeVisible();
    });
});
