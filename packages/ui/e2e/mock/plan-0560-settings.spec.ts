import { type Page } from "@playwright/test";
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth } from "./helpers/auth";

// PLAN-0560：工作区设置页 IA（B#6 不做兼容、VIEWER 只读、移动端入口）。
const WORKSPACE_ID = "workspace-1";

async function assertNoHorizontalOverflow(page: Page) {
    const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflow).toBe(false);
}

const CONFIG_DOMAINS: Record<string, Record<string, string>> = {
    "llm-provider": {
        profile: JSON.stringify({
            providerId: "deepseek",
            connectionKey: "default",
            model: "deepseek-chat",
        }),
    },
    "agent-runtime": { useRegistry: "true" },
    "approval-policy": { mode: "manual" },
};

test.describe("PLAN-0560 workspace settings", () => {
    test.beforeEach(async ({ page }) => {
        await setupMockAuth(page);
        await page.route("**/api/v1/**", (route) =>
            route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
        );
        // BL-318：上面的兜底把 `/sessions` 也答成 `{}`，会话列表解析报
        // `Invalid sessions response: missing sessions`（真产品错误日志）并让工作区加载失败。
        // 这条桩必须**注册在兜底之后**（后注册优先），给列表一个合法信封。
        await page.route(/\/api\/v1\/(?:workspaces\/[^/]+\/)?sessions(?:\?.*)?$/, (route) => {
            if (route.request().method() !== "GET") return route.fallback();
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ sessions: [] }),
            });
        });
        await page.route("**/api/v1/workspaces/workspace-1", (route) =>
            route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    id: WORKSPACE_ID,
                    name: "Mock Workspace",
                    ownerId: "user-1",
                }),
            }),
        );
        await page.route("**/api/v1/config/**", (route) => {
            const url = new URL(route.request().url()),
                domain = url.pathname.split("/").pop() ?? "";
            if (route.request().method() === "PUT") {
                return route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({ status: "ok", keys: 1 }),
                });
            }
            const entries = CONFIG_DOMAINS[domain] ?? {};
            const body = url.searchParams.has("layer")
                ? { domain, entries, envOverridden: {} }
                : entries;
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(body),
            });
        });
        await page.route("**/api/v1/events**", (route) =>
            route.fulfill({
                status: 200,
                headers: { "Content-Type": "text/event-stream" },
                body: "retry: 5000\n\n",
            }),
        );
    });

    test("B#6: legacy ?tab=workspace lands on the default tab without redirect", async ({
        page,
    }) => {
        // 工作区设置页：未知 tab 值落「常规」，不报错、不重定向。
        await page.goto(`/workspace/${WORKSPACE_ID}/settings?tab=workspace`, {
            waitUntil: "load",
        });
        await expect(page.getByTestId("workspace-settings-page")).toBeVisible();
        await expect(page.getByTestId("ws-settings-general")).toBeVisible();
        expect(page.url()).toContain("tab=workspace");

        // 旧契约「全局配置页不消费 tab query、落个人层」在层进 URL 下已**废弃**（Lead 2026-11-10 裁定：
        // URL 不承载层参数，层只由 /settings/{layer}/{domain} 的路径段表达）。
        // 新契约：/settings/config（无论带什么 tab）一律 redirect 到实例层第一个域页；
        // 非管理员在该域页看到 403 视图（入口分层），不会被 tabs 参数分派到别的层。
        await page.goto("/settings/config?tab=workspace", { waitUntil: "load" });
        // 重定向保留 query（路由只换 path），但层已由路径段决定 ⇒ tab=workspace 不再有分派作用。
        await expect(page).toHaveURL(/\/settings\/instance\/llm-provider(\?.*)?$/);
        await expect(page.getByTestId("settings-forbidden")).toBeVisible();
        await expect(page.getByTestId("settings-domain-view")).toHaveCount(0);
    });

    // task-253（2026-11-10）：工作区块配置层整体退役 ⇒ 本用例的「config 区块只读」段（含
    // ws-settings-tab-config 入口与 config-domain-* 面板断言）随删；常规信息与 MCP 两段保留。
    test("VIEWER sees read-only general info and MCP", async ({ page }) => {
        await page.addInitScript(() => {
            sessionStorage.setItem(
                "xihe-workspace",
                JSON.stringify({
                    id: "workspace-1",
                    name: "Mock Workspace",
                    workspaceRole: "VIEWER",
                    ownerId: "owner-1",
                }),
            );
        });
        await page.goto(`/workspace/${WORKSPACE_ID}/settings`, { waitUntil: "load" });
        await expect(page.getByTestId("workspace-settings-page")).toBeVisible();

        // 常规区块只读：无编辑表单与删除入口。
        await expect(page.getByTestId("ws-settings-edit")).toHaveCount(0);
        await expect(page.getByTestId("ws-settings-delete")).toHaveCount(0);
        await expect(page.getByTestId("ws-settings-name")).toBeVisible();

        // (a) 删 —— 配置区块只读段：工作区域配置 tab 已随 task-253 退役，没有可点的入口了。
        // 工作区配置面的只读判定不再有产品对象（实例/用户两层的锁定语义由 config-settings 覆盖）。

        // MCP 区块：JSON textarea 禁用、保存按钮不渲染。
        await page.getByTestId("ws-settings-tab-mcp").click();
        const textarea = page.getByTestId("mcp-config-textarea");
        await expect(textarea).toBeDisabled();
        await expect(
            page.getByTestId("workspace-settings-page").getByText("保存", { exact: true }),
        ).toHaveCount(0);
    });

    test("mobile toolbar collapses into ＋ and ⋯ overflow", async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`/workspace/${WORKSPACE_ID}`, { waitUntil: "load" });

        const newChat = page.getByTestId("workspace-toolbar-new-chat-mobile");
        const more = page.getByTestId("workspace-toolbar-more-mobile");
        await expect(newChat).toBeVisible();
        await expect(more).toBeVisible();

        await more.click();
        const menu = page.getByTestId("workspace-toolbar-more-menu");
        await expect(menu).toBeVisible();
        await assertNoHorizontalOverflow(page);

        await page.getByTestId("workspace-toolbar-more-settings").click();
        await expect(page).toHaveURL(new RegExp(`/workspace/${WORKSPACE_ID}/settings`));
        await expect(page.getByTestId("workspace-settings-page")).toBeVisible();

        // 设置页头部动作组在 390 宽可用且无横向溢出。
        await expect(page.getByTestId("ws-settings-actions")).toBeVisible();
        await assertNoHorizontalOverflow(page);
        await page.getByTestId("ws-settings-back").click();
        await expect(page).toHaveURL(new RegExp(`/workspace/${WORKSPACE_ID}$`));
    });
});
