import { expect, test } from "./helpers/mock-test";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS } from "../timeouts";
import { workspaceSessionPath } from "../../src/lib/routes";
import { MOCK_SESSION_WORKSPACE_ID, mockSessions } from "../../src/preview/mock/data/sessions";

/**
 * task-249（2026-11-15，D-1625）：**默认 mock 车道不跑本 spec**，因为它是 preview 链路 spec。
 * 实测三态（同一 spec、同一棵树、唯一变量是条件）：
 *   ① 默认车道 ⇒ 11 failed（失败页快照 = 登录页 / 按钮 disabled）
 *   ② preview 链路 + vite deps 冷缓存 ⇒ 1 passed / 10 failed（net::ERR_CONNECTION_REFUSED，门自报 env(stale-deps)×7）
 *   ③ preview 链路 + deps 已预热 ⇒ 11 passed（19.8 s）
 * ⇒ 结论：红来自**跑法条件**，不是夹具缺失（一条桩都不用补）。
 *
 * skip 的原因串必须能复现（D-1625②）：写明 env 名与取值，不写「需要预览环境」这种话。
 * 车道命令（复制即可跑；首跑若撞 stale-deps 再跑一次即可，第二次是预热后的稳态）：
 *   $env:XIHE_E2E_PROFILE="mock"; $env:XIHE_E2E_BROWSER_CHANNEL="chrome-beta";
 *   $env:XIHE_UI_PORT="28640"; $env:XIHE_E2E_EXPECT_CHAIN="preview"
 *   pnpm exec playwright test --config e2e/playwright.config.ts e2e/mock/<本文件> --workers=1 --retries=0
 */
test.skip(
    process.env.XIHE_E2E_EXPECT_CHAIN !== "preview",
    "需要 XIHE_E2E_EXPECT_CHAIN=preview（preview 链路 spec；未设时页面停在登录页，红不指向产品）",
);

/**
 * task-25 D（`D-1175` 收窄重开）的**浏览器判据**，跑在 **preview 链路**上：
 * `XIHE_E2E_EXPECT_CHAIN=preview` ⇒ config 注入 `XIHE_UI_MOCK_API=1` ⇒ vite 挂 mock 中间件，
 * 并把 `/workspace/**` 的 HTML 入口改写成 `preview-real.html`（注入 mock 登录态、强制 zh-CN）。
 *
 * <p>**为什么不调 `setupMockAuth`**：它给 `**\/api/v1/**` 挂通配兜底（未登记路径回 200 {}），
 * 会把本卡要验的**夹具通路整个盖掉** —— 那样测的是 spec 自己的桩，不是 `data/sessions.ts`，
 * 属假绿。这里只借 `mock-test` 的失败门禁（0 pageerror / 0 console error / 0 非预期 ≥400），
 * 让「mock 车道打开 /workspace 能看到会话与消息、无失败态」这条卡面判据由机器守住。</p>
 *
 * <p>跑法（单 spec = L0）：
 * `XIHE_E2E_PROFILE=mock XIHE_UI_PORT=12736 XIHE_E2E_BROWSER_CHANNEL=chrome-beta XIHE_E2E_EXPECT_CHAIN=preview`
 * `pnpm exec playwright test --config e2e/playwright.config.ts e2e/mock/task25-preview-sessions.spec.ts --workers=1`</p>
 */
/** task-35：直接取夹具常量，别再手抄一份 —— 抄的那份会和夹具静默漂移。 */
const WS_ID = MOCK_SESSION_WORKSPACE_ID;
const SESSION_TITLE = "流水线失败日志排查";
const WORKSPACELESS_TITLE = "独立会话：契约核对";

test.describe("preview mock sessions (task-25 D)", () => {
    test("工作区会话列表来自夹具（不是空态），点开能看到消息体与工具卡", async ({ page }) => {
        await page.goto("/workspace");
        // 无 tab 上下文 ⇒ 选择面（PLAN-0608 C′）；mock 只有一个工作区，点它进去。
        await page
            .getByTestId(`workspace-picker-item-${WS_ID}`)
            .click({ timeout: ACTION_TIMEOUT_MS });
        await expect(page.getByTestId(`sidebar-workspace-group-${WS_ID}`)).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(page.getByText(SESSION_TITLE, { exact: false }).first()).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });

        await page.getByText(SESSION_TITLE, { exact: false }).first().click({
            timeout: ACTION_TIMEOUT_MS,
        });
        await expect(page.getByTestId("message-list")).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        // 夹具给了 6 条；虚拟列表可能只渲染视口内的，所以判「≥3 条已挂载」而不是全等。
        await expect
            .poll(async () => page.getByTestId("message-item").count(), {
                timeout: EXPECT_TIMEOUT_MS,
            })
            .toBeGreaterThanOrEqual(3);
        // 工具卡真的挂上了（read_file / run_command 是夹具里的工具名）。
        await expect(page.getByText("read_file", { exact: false }).first()).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        // 长值样本真的渲染成代码块（cp-2 task-392 的折行取证前提）。
        await expect
            .poll(async () => page.locator("pre").count(), { timeout: EXPECT_TIMEOUT_MS })
            .toBeGreaterThanOrEqual(1);
    });

    test("独立会话分组走 scope=workspaceless 读面（workspaceId 显式 null）", async ({ page }) => {
        await page.goto("/workspace");
        await page
            .getByTestId(`workspace-picker-item-${WS_ID}`)
            .click({ timeout: ACTION_TIMEOUT_MS });
        await expect(page.getByText(WORKSPACELESS_TITLE, { exact: false }).first()).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
    });

    test("页面上没有夹具缺口文案（MOCK_ENDPOINT_MISSING / 加载失败）", async ({ page }) => {
        await page.goto("/workspace");
        await page
            .getByTestId(`workspace-picker-item-${WS_ID}`)
            .click({ timeout: ACTION_TIMEOUT_MS });
        await page.getByText(SESSION_TITLE, { exact: false }).first().click({
            timeout: ACTION_TIMEOUT_MS,
        });
        await expect(page.getByTestId("message-list")).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await expect(page.getByText("MOCK_ENDPOINT_MISSING")).toHaveCount(0);
        await expect(page.getByText("文件树加载失败")).toHaveCount(0);
        await expect(page.getByTestId("sidebar-groups-error")).toHaveCount(0);
    });

    test.describe("mobile viewport", () => {
        test.use({ viewport: { width: 390, height: 844 } });

        // 拆成两条：抽屉与聊天壳**各自带遮罩**，同一条用例里先开抽屉再点 FAB 会被遮罩拦
        // （首跑实测 `<div class="fixed inset-0 z-30 bg-black/50"> intercepts pointer events`，
        // 且该抽屉不是 reka Dialog ⇒ Esc 不收）。分开测各自稳定，判据也更清楚。
        test("390×844：深链会话 + 聊天壳能挂出消息体", async ({ page }) => {
            // 走产品自己的深链（router `session/:sessionId`），不在抽屉里点行 —— 抽屉会在
            // 加载完成后自动收起，点击撞动画（实测 not stable → not visible）。
            await page.goto(workspaceSessionPath(WS_ID, mockSessions[0]!.id));
            await page.getByTestId("mobile-chat-open").click({ timeout: ACTION_TIMEOUT_MS });
            await expect
                .poll(async () => page.getByTestId("message-item").count(), {
                    timeout: EXPECT_TIMEOUT_MS,
                })
                .toBeGreaterThanOrEqual(1);
        });

        test("390×844：导航抽屉里能看到夹具会话（列表不是空态）", async ({ page }) => {
            await page.goto(workspaceSessionPath(WS_ID, mockSessions[0]!.id));
            await page.getByTestId("mobile-sidebar-toggle").click({ timeout: ACTION_TIMEOUT_MS });
            await expect(
                page.getByRole("button", { name: SESSION_TITLE, exact: false }).first(),
            ).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        });
    });
});
