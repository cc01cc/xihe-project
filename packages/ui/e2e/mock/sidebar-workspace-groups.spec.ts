// timeout-exempt: 首屏到分组渲染要等 workspace 列表 + 一组会话两跳（task-352 review）
/**
 * task-352 / `D-1206`：左栏二级列表 = 工作区分组 + 会话项，懒加载。
 *
 * <p>这里只钉**只能整链路验的那两条**：请求账本（首屏 0/1、展开 +1、折叠再展开 +0）与
 * 两种空态的可见差异。组件层的那几条在 `src/features/workspace/chat/__tests__/` 里。
 * 请求数用 `page.on("request")` 数，不用断言「看起来不卡」—— 卡面硬约束①的判据就是这条读数。</p>
 *
 * <p>夹具策略：`setupMockAuth` / `setupMockSessions` 之后**再**注册两条路由
 * （Playwright 后注册者优先），所以本 spec 不改编共享夹具的行为 ——
 * 别的 spec 看到的仍是单工作区那份老数据。</p>
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { stubGroupedWorkspaceSessions, stubWorkspaceList } from "./helpers/grouped-sessions";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS } from "../timeouts";

const WS_A = "11111111-1111-4111-8111-111111111111";
const WS_B = "22222222-2222-4222-8222-222222222222";

/**
 * 收集「拉某 workspace 会话」的请求：值是该请求带的 `X-Workspace-Id`。
 *
 * **独立会话读不算「按组扇出」**：`GET /sessions?scope=workspaceless`（`api.ts:3271`）与按组读
 * 同路径，且故意带**空** `X-Workspace-Id`（压住 tab 注入）——它是左栏「独立会话」组的一次性
 * 探针，与「当前组 / 别组」无关。并进同一账本会让「首屏绝不碰别的工作区」假红（`""` ≠ WS_A，
 * 2026-11-15 实测）。所以分两本账：`scoped` = 按组读，`workspaceless` = 独立会话探针计数。
 */
function recordSessionGets(page: Page): {
    scoped: string[];
    workspaceless: number;
} {
    const ledger = { scoped: [] as string[], workspaceless: 0 };
    page.on("request", (request) => {
        if (request.method() !== "GET") return;
        const url = new URL(request.url());
        if (url.pathname !== "/api/v1/sessions") return;
        if (url.searchParams.get("scope") === "workspaceless") {
            ledger.workspaceless += 1;
            return;
        }
        ledger.scoped.push(request.headers()["x-workspace-id"] ?? "<tab-context>");
    });
    return ledger;
}

/**
 * 交付图（1920x1080）。`ui-mock-shot.mjs` 拍不了这两个态 —— 它的数据来自 mock 路由拦截，
 * 而那是 Playwright 进程内的东西；所以图由本 spec 自己按 commit + 一条命令重拍：
 * `XIHE_RAIL_SHOT_DIR=<dir> pnpm exec playwright test e2e/mock/sidebar-workspace-groups.spec.ts`
 * （不设该变量时**一条断言都不多做**，测试行为逐字不变）。
 */
async function capture(page: Page, name: string) {
    const dir = process.env.XIHE_RAIL_SHOT_DIR;
    if (!dir) return;
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.screenshot({ path: `${dir}/${name}.png` });
}

test.describe("左栏工作区分组（task-352 / D-1206）", () => {
    test("首屏只拉当前组；展开第二组 +1；折叠再展开不重拉", async ({ page }) => {
        const ledger = recordSessionGets(page);
        const sessionGets = ledger.scoped;
        await setupMockAuth(page);
        await setupMockSessions(page, {
            sessions: [{ id: "s-a1", title: "Alpha 会话", workspaceId: WS_A }],
        });
        // task-189 对接：能力已提取到 helpers/grouped-sessions.ts（G4 单一实现）。
        await stubWorkspaceList(page, [
            { id: WS_A, name: "Alpha 工作区" },
            { id: WS_B, name: "Beta 工作区" },
        ]);
        await stubGroupedWorkspaceSessions(page, [
            { id: "s-a1", title: "Alpha 会话", workspaceId: WS_A, agentPrincipalId: null },
            { id: "s-b1", title: "Beta 会话", workspaceId: WS_B, agentPrincipalId: null },
        ]);

        await page.goto(`/workspace/${WS_A}/session/s-a1`);

        // ① 两个分组头都渲染出来（未做时只有当前那一个）
        await expect(page.getByTestId(`sidebar-workspace-group-${WS_A}`)).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(page.getByTestId(`sidebar-workspace-group-${WS_B}`)).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        // 会话标题在页头 / 页签里也会出现（严格模式会命中多个），所以只认左栏里的行。
        const sidebar = page.getByTestId("sidebar");
        await expect(
            sidebar.getByTestId("session-item").filter({ hasText: "Alpha 会话" }),
        ).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });

        await capture(page, "sidebar-workspace-groups");

        // ② 首屏请求：**判据是「有没有按组扇出」，不是总数**。
        //
        // [实测] 首屏总数 = 2，两条的 `X-Workspace-Id` 都是 `11111111-1111-4111-8111-111111111111` —— 一条来自
        // `App.vue:58`、一条来自 `WorkspaceView.vue:225`，是「拉当前工作区会话」的既有启动路径
        // （与本卡无关，改前就是 2；不带参数时 `api.ts` 用 tab 上下文补这个头）。
        // 所以真正的判据是**首屏绝不碰别的工作区**：做成「一次拉全部 workspace」时，首屏必然
        // 出现带 `22222222-2222-4222-8222-222222222222` 的请求 ⇒ 下面这条会红。左栏自己首屏贡献 0 条：它在 store 为空时
        // 才调 `loadSessions()`，而 store 的 `loadPromise` 把已经在飞的请求复用掉。
        expect(sessionGets.filter((header) => header === WS_B)).toEqual([]);
        expect(sessionGets.every((header) => header === WS_A)).toBe(true);
        expect(sessionGets.length).toBeLessThanOrEqual(2);
        const afterFirstPaint = sessionGets.length;
        // 独立会话探针单独记账：首屏至多 1 次（`workspacelessLoaded` 缓存后不再拉），
        // 它的存在不改变上面「按组扇出」的判据，也不能被当成「碰了别的工作区」。
        expect(ledger.workspaceless).toBeLessThanOrEqual(1);

        // 展开第二组 ⇒ 恰好 +1，且它的会话出现
        await page.getByTestId(`sidebar-workspace-group-toggle-${WS_B}`).click();
        await expect(
            sidebar.getByTestId("session-item").filter({ hasText: "Beta 会话" }),
        ).toBeVisible({
            timeout: ACTION_TIMEOUT_MS,
        });
        expect(sessionGets.length).toBe(afterFirstPaint + 1);
        expect(sessionGets.at(-1)).toBe(WS_B);

        // ③ 折叠再展开：**不许重新拉取**（计数不变）—— 这条要给计数，不许写「正常」
        const beforeCollapse = sessionGets.length;
        await page.getByTestId(`sidebar-workspace-group-toggle-${WS_B}`).click();
        await expect(page.getByTestId(`sidebar-workspace-group-body-${WS_B}`)).toHaveCount(0);
        await page.getByTestId(`sidebar-workspace-group-toggle-${WS_B}`).click();
        await expect(
            sidebar.getByTestId("session-item").filter({ hasText: "Beta 会话" }),
        ).toBeVisible({
            timeout: ACTION_TIMEOUT_MS,
        });
        expect(sessionGets.length).toBe(beforeCollapse);
    });

    test("两种空态可区分：一个分组都没有 vs 分组展开但该组无会话", async ({ page }) => {
        await setupMockAuth(page);
        await setupMockSessions(page, { sessions: [] });

        // 只有当前工作区，且它没有会话 ⇒ 分组在、组内空
        await page.route(
            (url) => url.pathname === "/api/v1/workspaces",
            async (route) => {
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify([
                        {
                            id: WS_A,
                            name: "Alpha 工作区",
                            ownerId: "user-1",
                            workspaceRole: "OWNER",
                        },
                    ]),
                });
            },
        );
        await page.goto(`/workspace/${WS_A}`);
        await expect(page.getByTestId("sidebar-empty-no-session")).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(page.getByTestId("sidebar-empty-no-workspace")).toHaveCount(0);
        await expect(page.getByTestId("sidebar-empty-no-session-action")).toBeVisible();
        await capture(page, "sidebar-empty-no-session");

        // 一个工作区都没有 ⇒ 另一块，另一个出口（文案也不许相等）
        await page.unroute((url) => url.pathname === "/api/v1/workspaces");
        await page.route(
            (url) => url.pathname === "/api/v1/workspaces",
            async (route) => {
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify([]),
                });
            },
        );
        await page.reload();
        await expect(page.getByTestId("sidebar-empty-no-workspace")).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(page.getByTestId("sidebar-empty-no-session")).toHaveCount(0);
        await expect(page.getByTestId("sidebar-empty-no-workspace-action")).toBeVisible();
        await capture(page, "sidebar-empty-no-workspace");
    });
});
