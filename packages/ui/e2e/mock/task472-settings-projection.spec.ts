import { type Page } from "@playwright/test";
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth } from "./helpers/auth";

/**
 * task-472（D-1367 健壮性/潜在缺陷）：工作区设置页必须**自己确保** `/me/permissions` 投影被加载。
 *
 * <p><b>为什么单独一份 spec 而不是加进 plan-0560-settings</b>：那是运行时判定集的一员，不在本卡
 * 的可动面内（Lead 约束）。</p>
 *
 * <p><b>为什么必须自注册投影桩</b>：`setupMockAuth` 与下面的通用兜底都会把 `/me/permissions`
 * 答成 `200 {}`（无 `workspaces`）⇒ 投影为 null ⇒ 角色回落 ⇒ `canManageWorkspace` 恒 false
 * ⇒ **修前修后都只读，用例是空的**（D-1281）。所以本条按需给一份**带该工作区 admin 的投影**，
 * 注册在兜底**之后**（Playwright LIFO ⇒ 后注册优先）覆盖它。</p>
 *
 * <p><b>注意形状</b>：本 spec 的专用桩**就是要** present 且 `workspaceAdmin: true`（那是被测
 * 语义本身）。这与「公共中性兜底不得 present 空工作区行」是两件事，别混用。</p>
 */

const WORKSPACE_ID = "workspace-1";

const CONFIG_DOMAINS: Record<string, Record<string, string>> = {
    "llm-provider": {
        profile: JSON.stringify({
            providerId: "deepseek",
            connectionKey: "default",
            model: "deepseek-chat",
        }),
    },
};

async function stubBase(page: Page) {
    await setupMockAuth(page);
    await page.route("**/api/v1/**", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
    );
    await page.route(/\/api\/v1\/(?:workspaces\/[^/]+\/)?sessions(?:\?.*)?$/, (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ sessions: [] }),
        });
    });
    await page.route("**/api/v1/workspaces/workspace-1", (route) => {
        const url = route.request().url();
        // 该路由是**前缀**匹配：配置域与成员等子路径交给后面的专用桩/兜底。
        if (!/\/api\/v1\/workspaces\/workspace-1(?:\?.*)?$/.test(url)) return route.fallback();
        return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ id: WORKSPACE_ID, name: "Mock Workspace", ownerId: "user-1" }),
        });
    });
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
}

/** 与真实 CP 同形的投影：**必须带该工作区那一条**，否则回落成「未知名单」。 */
async function stubProjection(page: Page, workspaceAdmin: boolean) {
    await page.route("**/api/v1/me/permissions", (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                userId: "user-1",
                instanceCapabilities: [],
                instancePermissions: [],
                workspaces: [
                    {
                        workspaceId: WORKSPACE_ID,
                        workspaceRole: "OWNER",
                        workspaceAdmin,
                        permissions: [{ actionClass: "WRITE_WORKSPACE_CONTENT", resource: null }],
                    },
                ],
            }),
        }),
    );
}

/** 面板里**可编辑**的控件数 —— `readonly` 会把它变成 0，是这条卡的可观察判据。 */
function editableControlCount(page: Page): Promise<number> {
    return page
        .getByTestId("ws-settings-config")
        .locator("input:not([disabled]), textarea:not([disabled]), select:not([disabled])")
        .count();
}

test.describe("task-472 工作区设置页投影加载", () => {
    test("投影给该工作区 admin 时，常规 tab 的编辑入口出现", async ({ page }) => {
        await stubBase(page);
        await stubProjection(page, true);

        await page.goto(`/workspace/${WORKSPACE_ID}/settings?tab=general`, { waitUntil: "load" });
        await expect(page.getByTestId("workspace-settings-page")).toBeVisible();
        await expect(page.getByTestId("ws-settings-edit")).toBeVisible();
    });

    test("负对照：投影不给 admin 时编辑入口不出现（显隐由能力位驱动）", async ({ page }) => {
        await stubBase(page);
        await stubProjection(page, false);

        await page.goto(`/workspace/${WORKSPACE_ID}/settings?tab=general`, { waitUntil: "load" });
        await expect(page.getByTestId("workspace-settings-page")).toBeVisible();
        await expect(page.getByTestId("ws-settings-general")).toBeVisible();
        await expect(page.getByTestId("ws-settings-edit")).toHaveCount(0);
    });

    // 面板那条要看**可编辑性**而不是「面板渲染了」：后者与投影无关（修前也绿 ⇒ 空断言）。
    test("配置 tab：拿到 admin 投影后面板里有可编辑控件", async ({ page }) => {
        await stubBase(page);
        await stubProjection(page, true);

        await page.goto(`/workspace/${WORKSPACE_ID}/settings?tab=config`, { waitUntil: "load" });
        await expect(page.getByTestId("ws-settings-config")).toBeVisible();
        await expect.poll(() => editableControlCount(page)).toBeGreaterThan(0);
    });

    test("配置 tab 负对照：无 admin 投影时面板零可编辑控件（只读）", async ({ page }) => {
        await stubBase(page);
        await stubProjection(page, false);

        await page.goto(`/workspace/${WORKSPACE_ID}/settings?tab=config`, { waitUntil: "load" });
        await expect(page.getByTestId("ws-settings-config")).toBeVisible();
        expect(await editableControlCount(page)).toBe(0);
    });
});
