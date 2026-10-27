import { test, expect, type Page } from "@playwright/test";
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

        // 全局配置页不消费 tab query：同样落默认（mock 用户非 ADMIN → 个人层）。
        await page.goto("/settings/config?tab=workspace", { waitUntil: "load" });
        await expect(page.getByTestId("config-tab-user")).toBeVisible();
        await expect(page.getByTestId("config-tab-instance")).toHaveCount(0);
    });

    test("VIEWER sees read-only general info, config and MCP", async ({ page }) => {
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

        // 配置区块：无保存按钮；字段以只读文本呈现（无 select/input）。
        await page.getByTestId("ws-settings-tab-config").click();
        const domain = page.getByTestId("config-domain-agent-runtime");
        await expect(domain).toBeVisible();
        await domain.locator("button").first().click();
        await expect(
            page.getByTestId("config-domain-agent-runtime").getByRole("button", { name: "保存" }),
        ).toHaveCount(0);
        await expect(
            page.getByTestId("config-field-agent-runtime-useRegistry").locator("select"),
        ).toHaveCount(0);
        await expect(
            page.getByTestId("config-field-agent-runtime-useRegistry").locator("input"),
        ).toHaveCount(0);

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
