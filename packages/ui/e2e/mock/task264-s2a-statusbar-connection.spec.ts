import { DEFAULT_MOCK_ALLOW, expect, test } from "./helpers/mock-test";
import { MOCK_WORKSPACE_ID, setupMockAuth, setupMockSessions } from "./helpers/auth";
import { EXPECT_TIMEOUT_MS } from "../timeouts";

const SESSION_ID = "task264-session";

/**
 * task-264（S2a）验收：**非聊天页面包屑可见 + 连接态正确**。
 *
 * <p>这是开口项 1（D-1640 ①：SSE 连接态提升 store、状态栏上移壳层）「做与不做」的唯一差别：
 * 状态栏若仍是页面级（只挂 WorkspaceView），其余五页就没有面包屑。本 spec 用**非聊天页**咬住它。</p>
 *
 * <p><b>为什么选 environment 而不是 scheduled-tasks</b>：连接态「正确与否」取决于该页是否订阅
 * workspace SSE。实测（本 spec 首跑）scheduled-tasks 也调 useWorkspaceSSE（ScheduledTasksView.vue:182）
 * ⇒ 它上面 connected 才是对的；而 environment **不订阅** SSE（WorkspaceEnvironmentView 无
 * useWorkspaceSSE）⇒ 它上面应当是 disconnected。选非订阅页才能把「连接态随页面生命周期归零」
 * （useWorkspaceSSE onBeforeUnmount → connectionStore.reset）这条咬出来。</p>
 *
 * <p>两条用例各咬一个回归方向：</p>
 * <ol>
 *   <li><b>直链非聊天页</b>：面包屑三段 + 唯一 aria-current + 连接态=未连接。
 *       咬「面包屑只在聊天页可见」（把状态栏搬回页面级即红）。</li>
 *   <li><b>会话页已连接 → 导航到非订阅页</b>：连接态从 connected 归零为 disconnected。
 *       咬两个方向的假绿：① 状态栏读数若是硬编码 disconnected，会话页那腿（connected）红；
 *       ② 页面卸载若不 reset，非聊天页会残留上一页的 connected，本腿红。
 *       ⇒ 证明读数是「活的 store 通道」且随页面生命周期归零。</li>
 * </ol>
 *
 * <p>连接态断言用 data-connection-state 属性（三态各有独立值），不是「元素存在」
 * （D-1153 判据，与 WorkspaceStatusBar.spec.ts 同口径）。面包屑段结构用 data-slot，
 * 与 task185-breadcrumb-segments.spec.ts 同口径。</p>
 */
test.describe("task-264 S2a：状态栏壳化（面包屑全页可见 + 连接态读数）", () => {
    // 夹具缺口（不是放宽产品断言）：mock 车道没有「工作区环境」读面端点
    // （GET /api/v1/workspaces/{id}/environment）⇒ 环境页必 404。本读数只关心壳层面包屑/连接态，
    // 页面自身的错误态不影响读数；逐条放行该端点（task174-six-pages-aria.spec.ts 同口径）。
    test.use({ mockAllow: [...DEFAULT_MOCK_ALLOW, "workspaces/[^/]+/environment"] });

    test("直链非聊天页（environment，不订阅 SSE）：面包屑三段、唯一 aria-current、连接态=未连接", async ({
        page,
    }) => {
        await setupMockAuth(page, {});
        await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "T264" }] });

        await page.goto(`/workspace/${MOCK_WORKSPACE_ID}/environment`);

        const bar = page.locator('[data-testid="workspace-status-bar"]');
        await bar.waitFor({ state: "visible", timeout: EXPECT_TIMEOUT_MS });

        // ① 面包屑在状态栏内且可见（前提先过，否则下面的 0 可能是「没渲染」）。
        const breadcrumb = page.locator('[data-testid="workspace-breadcrumb"]');
        await expect(breadcrumb).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await expect(bar.locator('[data-testid="workspace-breadcrumb"]')).toHaveCount(1);

        // ② 三段：工作区 › 工作区名 › 当前页；末段 aria-current 全状态栏唯一。
        await expect(breadcrumb.locator('[data-slot="breadcrumb-item"]')).toHaveCount(3);
        await expect(breadcrumb.locator('[data-slot="breadcrumb-page"]')).toHaveCount(1);
        await expect(bar.locator('[aria-current="page"]')).toHaveCount(1);

        // ③ 连接态正确：environment 不订阅 SSE ⇒ 未连接（不是「元素存在」就算过）。
        await expect(page.locator('[data-testid="workspace-status-connection"]')).toHaveAttribute(
            "data-connection-state",
            "disconnected",
            { timeout: EXPECT_TIMEOUT_MS },
        );
    });

    test("会话页已连接 → 点导航到 environment：面包屑仍可见、连接态归零为未连接", async ({
        page,
    }) => {
        await setupMockAuth(page, {});
        await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "T264" }] });

        const connection = page.locator('[data-testid="workspace-status-connection"]');

        // ① 会话页（WorkspaceView 订阅 SSE，mock 默认 hold 长流）：连接态必须真到达 connected。
        //    这一腿证明状态栏读数是活的 store 通道，不是硬编码 disconnected。
        await page.goto(`/workspace/${MOCK_WORKSPACE_ID}/`);
        await expect(connection).toHaveAttribute("data-connection-state", "connected", {
            timeout: EXPECT_TIMEOUT_MS,
        });

        // ② 真实导航动作：点二级导航「环境」（非聊天、不订阅 SSE），不是 page.goto 旁路。
        await page.locator('[data-testid="workspace-nav-environment"]').click();
        await expect(page).toHaveURL(/\/environment$/, { timeout: EXPECT_TIMEOUT_MS });

        // ③ 非聊天页面包屑仍可见（壳层挂载，不随页面卸载消失）。
        const breadcrumb = page.locator('[data-testid="workspace-breadcrumb"]');
        await expect(breadcrumb).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await expect(breadcrumb.locator('[data-slot="breadcrumb-item"]')).toHaveCount(3);

        // ④ 连接态归零：页面卸载 reset ⇒ 未连接，不能残留上一页的 connected。
        await expect(connection).toHaveAttribute("data-connection-state", "disconnected", {
            timeout: EXPECT_TIMEOUT_MS,
        });
    });
});
