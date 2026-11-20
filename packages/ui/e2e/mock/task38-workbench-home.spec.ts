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
/**
 * task-34（D1472 ②）：`/workbench` 恢复的是**上一跳落下的那一页**（页级，不是「工作区根」）。
 *
 * <p>四个面各一条：① 裸工作区上一跳（page = environment）⇒ 落在该工作区环境页；② 会话页上一跳
 * ⇒ 落在会话页；③ 上一跳属于别的工作区而本 tab 上下文是 A ⇒ **上下文优先**，落 A 的工作区页
 * （不被拖去 B）；④ 旧键形（无 `page` 字段）⇒ fail-closed 丢弃，回工作台空态 picker。</p>
 *
 * <p>种子写法说明：`seedSession` 不写 `xihe-last-location`，所以这里自带 `addInitScript`。它为
 * 「清 `xihe-workspace`」这一步排在 `setupMockAuth` 的播种之后（Playwright 按注册顺序跑 init
 * script），保证 tab 上下文只在明确要它的用例里存在。</p>
 *
 * <p><b>播种必须是「每个 context 一次」，不能每次导航都跑</b>（`task-34` 实施期踩到）：
 * `page.addInitScript` 在**每一次**导航前都会执行（含 `page.goto`），而无条件 `removeItem` 会在
 * 第二次导航前把上一跳与 tab 上下文抹掉 —— 症状是「进内容页 → 回 `/workbench`」永远落 picker，
 * 看上去像恢复逻辑失效。这里用 sessionStorage 的标记位做一次性守卫：同一 context 内只有首次
 * 装载播种／清理，之后保留被测代码自己写下的状态。</p>
 */
const SESSION_ID = "33333333-3333-4333-8333-333333333333";

/** 播种一次性守卫的键（同一 context 内只播种一次，后续导航保留被测代码写下的状态）。 */
const SEED_APPLIED_KEY = "zz-task38-seed-applied";

/** 上一跳记录（五字段口径：kind / workspaceId / sessionId / page / at）。 */
function lastLocation(entry: Record<string, unknown>): Record<string, unknown> {
    return { at: new Date().toISOString(), ...entry };
}

/**
 * 落到 `/workbench` 前播种：tab 上下文（可选）+ 上一跳记录（可选）。
 * `last === null` 表示「没有上一跳」，`undefined` 的值不会被写入。
 */
async function openWorkbenchWithSeed(
    page: Page,
    seed: { last?: Record<string, unknown> | null; tabWorkspaceId?: string },
): Promise<void> {
    await setupMockAuth(page, {
        workspaceEvents: "off",
        workspaceList: [
            { id: WS_A, name: "Alpha", workspaceRole: "WS_OWNER" },
            { id: WS_B, name: "Beta", workspaceRole: "WS_OWNER" },
        ],
    });
    await setupMockSessions(page, {
        workspaceId: WS_A,
        sessions: [{ id: SESSION_ID, title: "任务 34 的会话" }],
    });
    await page.addInitScript(
        (payload) => {
            // 一次性守卫：init script 每次导航都会跑，重复清理会把上一跳抹掉（见上方说明）。
            // 守卫键必须从参数传进来 —— init script 在浏览器里跑，拿不到模块作用域常量
            // （写成裸标识符会是 `ReferenceError: … is not defined` 的 pageerror）。
            if (sessionStorage.getItem(payload.seedKey)) return;
            sessionStorage.setItem(payload.seedKey, "1");
            localStorage.removeItem("xihe-workspace");
            sessionStorage.removeItem("xihe-workspace");
            localStorage.removeItem("xihe-last-location");
            if (payload.last) {
                localStorage.setItem("xihe-last-location", JSON.stringify(payload.last));
            }
            if (payload.tabWorkspaceId) {
                sessionStorage.setItem(
                    "xihe-workspace",
                    JSON.stringify({ id: payload.tabWorkspaceId }),
                );
            }
        },
        {
            last: seed.last ?? null,
            tabWorkspaceId: seed.tabWorkspaceId ?? null,
            seedKey: SEED_APPLIED_KEY,
        },
    );
    await page.goto("/workbench");
}

test.describe("workbench landing restores the last visited workspace page (task-34)", () => {
    test("裸工作区上一跳停环境页 ⇒ 落在该工作区环境页，不是工作区根", async ({ page }) => {
        await openWorkbenchWithSeed(page, {
            last: lastLocation({
                kind: "workspace",
                workspaceId: WS_A,
                sessionId: null,
                page: "environment",
            }),
        });

        await expect(page).toHaveURL(new RegExp(`/workspace/${WS_A}/environment$`), {
            timeout: EXPECT_TIMEOUT_MS,
        });
        // 反证：没被退格到工作区根（page 维度真的被消费，而不是「随便落一个工作区页」）。
        await expect(page.getByTestId("workspace-picker")).toHaveCount(0);
    });

    test("会话页上一跳 ⇒ 落在该会话", async ({ page }) => {
        await openWorkbenchWithSeed(page, {
            last: lastLocation({
                kind: "workspace",
                workspaceId: WS_A,
                sessionId: SESSION_ID,
                page: null,
            }),
        });

        await expect(page).toHaveURL(new RegExp(`/workspace/${WS_A}/session/${SESSION_ID}$`), {
            timeout: EXPECT_TIMEOUT_MS,
        });
    });

    test("上一跳属于别的工作区 ⇒ tab 上下文优先，落本工作区页", async ({ page }) => {
        await openWorkbenchWithSeed(page, {
            tabWorkspaceId: WS_A,
            last: lastLocation({
                kind: "workspace",
                workspaceId: WS_B,
                sessionId: null,
                page: "scheduled-tasks",
            }),
        });

        await expect(page).toHaveURL(new RegExp(`/workspace/${WS_A}$`), {
            timeout: EXPECT_TIMEOUT_MS,
        });
        // 反向：没有被 B 的上一跳拖走。
        await expect(page).not.toHaveURL(new RegExp(WS_B));
    });

    test("旧键形（没有 page 字段）⇒ fail-closed 丢弃，回工作台空态", async ({ page }) => {
        // 旧记录 = task-34 之前的四字段形态；用户裁定「不做兼容、旧值丢弃不迁移」。
        await openWorkbenchWithSeed(page, {
            last: lastLocation({
                kind: "workspace",
                workspaceId: WS_A,
                sessionId: null,
            }),
        });

        await expect(page.getByTestId("workspace-picker")).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(page).toHaveURL(/\/workbench$/);
    });
});
test.describe("task-34（D1476 ③）：真导航进内容页 ⇒ 回 /workbench 落回该页", () => {
    test("环境页 ⇒ 冷启 /workbench 仍停在环境页（不是会话页、也不是 picker）", async ({ page }) => {
        await openWorkbenchWithSeed(page, {});
        await expect(page.getByTestId("workspace-picker")).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });

        // ① 真导航进内容页：上一跳由 router.afterEach 写入（不是本 spec 手写的种子）。
        await page.goto(`/workspace/${WS_A}/environment`);
        await expect(page).toHaveURL(new RegExp(`/workspace/${WS_A}/environment$`), {
            timeout: EXPECT_TIMEOUT_MS,
        });

        // 反证前半：真导航已经把上一跳写到环境页（不是本 spec 的种子）。
        // 写点是 `router.afterEach`，落在页面装载完成后的一拍 —— 直接读可能还是 null，
        // 所以用 poll 等它出现（不是固定 sleep）。
        await expect
            .poll(
                async () => {
                    const raw = await page.evaluate(() =>
                        localStorage.getItem("xihe-last-location"),
                    );
                    return JSON.parse(raw ?? "{}") as Record<string, unknown>;
                },
                { timeout: EXPECT_TIMEOUT_MS },
            )
            .toMatchObject({ kind: "workspace", workspaceId: WS_A, page: "environment" });

        // ② 冷启回 /workbench：必须落回环境页。
        await page.goto("/workbench");
        await expect(page).toHaveURL(new RegExp(`/workspace/${WS_A}/environment$`), {
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(page.getByTestId("workspace-picker")).toHaveCount(0);
    });
});
