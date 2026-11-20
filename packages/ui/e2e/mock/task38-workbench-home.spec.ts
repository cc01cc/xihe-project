import type { Page } from "@playwright/test";
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions, type MockSessionOptions } from "./helpers/auth";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS } from "../timeouts";

/**
 * task-38：`/workbench` 是**工作台详情页**（用户 2026-11-20 11:32 裁定 —— 「这个页面也能选择已有的
 * 工作区之类的，就是一个工作台的详情页，然后能做一些简单的操作或者跳转索引」）。
 *
 * 覆盖卡面 ①–⑤：页头 + 主操作两枚、既有工作区面（搜索 / 列表，**既有 testid 一个都不许少**）、
 * 最近的独立会话（有数据按更新时间降序取前 5 / 无数据整块消失 / 可点击进入）、全局跳转三入口的 href。
 *
 * <p>为什么要清存储：`setupMockAuth` 会按 tab 上下文播种 `xihe-workspace`，于是 `/workbench`
 * 直接重定向进工作区视图、picker 永不渲染（2026-11-15 实测；`workspace-management.spec.ts` 同手法）。
 * 清存储的 init script 必须**排在** helpers 的 addInitScript **之后** —— Playwright 按注册顺序执行。</p>
 */
const WS_A = "11111111-1111-4111-8111-111111111111";
const WS_B = "44444444-4444-4444-4444-444444444444";

/** 6 条独立会话 ⇒ 详情页只取前 5；`updatedAt` 打散，用来钉「降序」这条判据。 */
const STANDALONE_NEWEST = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STANDALONE_ROWS = [
    {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        title: "独立会话 3",
        updatedAt: "2026-11-10T00:00:00Z",
    },
    { id: STANDALONE_NEWEST, title: "独立会话 1", updatedAt: "2026-11-20T00:00:00Z" },
    {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        title: "独立会话 2",
        updatedAt: "2026-11-15T00:00:00Z",
    },
    {
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        title: "独立会话 4",
        updatedAt: "2026-11-05T00:00:00Z",
    },
    {
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        title: "独立会话 5",
        updatedAt: "2026-11-04T00:00:00Z",
    },
    {
        id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        title: "独立会话 6",
        updatedAt: "2026-11-03T00:00:00Z",
    },
];

/**
 * 顺序是判据的一部分：`setupMockAuth` 自带 `GET /api/v1/sessions` 兜底（回空列表），而 Playwright
 * **后注册优先** ⇒ 会话夹具必须排在它**之后**、goto **之前**。反过来写时「最近的独立会话」会拿到
 * 兜底的空数组，块静默不渲染（2026-11-20 实测：4 passed / 1 failed，那块 element not found）。
 */
async function openWorkbench(page: Page, sessionOptions: MockSessionOptions): Promise<void> {
    await setupMockAuth(page, {
        workspaceEvents: "off",
        workspaceList: [
            { id: WS_A, name: "Alpha", workspaceRole: "WS_OWNER" },
            { id: WS_B, name: "Beta", workspaceRole: "WS_OWNER" },
        ],
    });
    await setupMockSessions(page, sessionOptions);
    await page.addInitScript(() => {
        localStorage.removeItem("xihe-workspace");
        sessionStorage.removeItem("xihe-workspace");
    });
    await page.goto("/workbench");
    await expect(page.getByTestId("workspace-picker")).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
}

test.describe("workbench detail page (task-38)", () => {
    test("页头 + 主操作两枚 + 既有工作区面都在", async ({ page }) => {
        await openWorkbench(page, { sessions: [] });

        await expect(page.getByRole("heading", { level: 1 })).toHaveText("工作台");
        const actions = page.getByTestId("workspace-picker-actions");
        await expect(actions.getByTestId("workspace-picker-new-session")).toBeVisible();
        await expect(actions.getByTestId("workspace-picker-new")).toBeVisible();
        // 改版不许吃掉既有选择面：两块工作区 + 搜索框逐项可见（testid 是既有契约）。
        await expect(page.getByTestId("workspace-picker-search")).toBeVisible();
        await expect(page.getByTestId("workspace-picker-item-" + WS_A)).toBeVisible();
        await expect(page.getByTestId("workspace-picker-item-" + WS_B)).toBeVisible();
    });

    test("全局跳转三入口指向 /members、/resources、/settings", async ({ page }) => {
        await openWorkbench(page, { sessions: [] });

        const links = page.getByTestId("workspace-picker-links");
        await expect(links.getByTestId("workspace-picker-link-members")).toHaveAttribute(
            "href",
            "/members",
        );
        await expect(links.getByTestId("workspace-picker-link-resources")).toHaveAttribute(
            "href",
            "/resources",
        );
        await expect(links.getByTestId("workspace-picker-link-settings")).toHaveAttribute(
            "href",
            "/settings",
        );
    });

    test("最近的独立会话：最多 5 条、按更新时间降序，点击进入该会话", async ({ page }) => {
        await openWorkbench(page, { sessions: [], workspacelessSessions: STANDALONE_ROWS });

        const block = page.getByTestId("workspace-picker-standalone");
        await expect(block).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        const items = block.locator('[data-testid^="workspace-picker-standalone-item-"]');
        // 6 条数据、上限 5 条：这条同时咬住「过滤/截断」与「不留第 6 个」。
        await expect(items).toHaveCount(5);
        // 降序：最新那条排第一（夹具里 updatedAt 被打散，不是插入顺序碰巧对）。
        await expect(items.first()).toHaveAttribute(
            "data-testid",
            "workspace-picker-standalone-item-" + STANDALONE_NEWEST,
        );

        await items.first().click({ timeout: ACTION_TIMEOUT_MS });
        await expect(page).toHaveURL(new RegExp(STANDALONE_NEWEST), { timeout: EXPECT_TIMEOUT_MS });
    });

    test("没有独立会话时整块不渲染，工作区列表照常", async ({ page }) => {
        await openWorkbench(page, { sessions: [], workspacelessSessions: [] });

        await expect(page.getByTestId("workspace-picker-item-" + WS_A)).toBeVisible();
        // 索引块是「有数据才出现」的：空数组不能留一个空标题/空位。
        await expect(page.getByTestId("workspace-picker-standalone")).toHaveCount(0);
    });

    test("主操作「新建会话」打开的是左栏同一个独立会话对话框", async ({ page }) => {
        await openWorkbench(page, { sessions: [] });

        await expect(page.getByTestId("standalone-dialog")).toHaveCount(0);
        await page
            .getByTestId("workspace-picker-new-session")
            .click({ timeout: ACTION_TIMEOUT_MS });
        // 复用既有组件（三个契约点：show / close / created）⇒ 打开即见它的根节点。
        await expect(page.getByTestId("standalone-dialog")).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
    });
});
