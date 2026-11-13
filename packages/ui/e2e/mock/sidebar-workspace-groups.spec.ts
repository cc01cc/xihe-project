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
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS } from "../timeouts";

const WS_A = "workspace-1";
const WS_B = "workspace-2";

function sessionWire(id: string, title: string, workspaceId: string) {
    const now = new Date().toISOString();
    return {
        id,
        title,
        workspaceId,
        createdAt: now,
        updatedAt: now,
        modelProvider: null,
        modelName: null,
        archived: false,
        agentPrincipalId: null,
    };
}

/** 收集「拉某 workspace 会话」的请求：值是该请求带的 `X-Workspace-Id`。 */
function recordSessionGets(page: import("@playwright/test").Page): string[] {
    const seen: string[] = [];
    page.on("request", (request) => {
        if (request.method() !== "GET") return;
        if (new URL(request.url()).pathname !== "/api/v1/sessions") return;
        seen.push(request.headers()["x-workspace-id"] ?? "<tab-context>");
    });
    return seen;
}

async function stubTwoWorkspaces(page: import("@playwright/test").Page) {
    await page.route(
        (url) => url.pathname === "/api/v1/workspaces",
        async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify([
                    { id: WS_A, name: "Alpha 工作区", ownerId: "user-1", workspaceRole: "OWNER" },
                    { id: WS_B, name: "Beta 工作区", ownerId: "user-1", workspaceRole: "OWNER" },
                ]),
            });
        },
    );
    // 每个 workspace 拿自己那一份；这条桩就是「按组取数」的替身。
    await page.route(
        (url) => url.pathname === "/api/v1/sessions",
        async (route) => {
            const workspaceId = route.request().headers()["x-workspace-id"];
            const sessions =
                workspaceId === WS_B
                    ? [sessionWire("s-b1", "Beta 会话", WS_B)]
                    : [sessionWire("s-a1", "Alpha 会话", WS_A)];
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ sessions }),
            });
        },
    );
}

test.describe("左栏工作区分组（task-352 / D-1206）", () => {
    test("首屏只拉当前组；展开第二组 +1；折叠再展开不重拉", async ({ page }) => {
        const sessionGets = recordSessionGets(page);
        await setupMockAuth(page);
        await setupMockSessions(page, {
            sessions: [{ id: "s-a1", title: "Alpha 会话", workspaceId: WS_A }],
        });
        await stubTwoWorkspaces(page);

        await page.goto(`/workspace/${WS_A}/chat/s-a1`);

        // ① 两个分组头都渲染出来（未做时只有当前那一个）
        await expect(page.getByTestId(`sidebar-workspace-group-${WS_A}`)).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(page.getByTestId(`sidebar-workspace-group-${WS_B}`)).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(page.getByText("Alpha 会话")).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });

        // ② 首屏请求数：只允许 0 或 1（未做懒加载时 = workspace 数 = 2）
        expect(sessionGets.length).toBeLessThanOrEqual(1);
        const afterFirstPaint = sessionGets.length;

        // 展开第二组 ⇒ 恰好 +1，且它的会话出现
        await page.getByTestId(`sidebar-workspace-group-toggle-${WS_B}`).click();
        await expect(page.getByText("Beta 会话")).toBeVisible({ timeout: ACTION_TIMEOUT_MS });
        expect(sessionGets.length).toBe(afterFirstPaint + 1);
        expect(sessionGets.at(-1)).toBe(WS_B);

        // ③ 折叠再展开：**不许重新拉取**（计数不变）—— 这条要给计数，不许写「正常」
        const beforeCollapse = sessionGets.length;
        await page.getByTestId(`sidebar-workspace-group-toggle-${WS_B}`).click();
        await expect(page.getByTestId(`sidebar-workspace-group-body-${WS_B}`)).toHaveCount(0);
        await page.getByTestId(`sidebar-workspace-group-toggle-${WS_B}`).click();
        await expect(page.getByText("Beta 会话")).toBeVisible({ timeout: ACTION_TIMEOUT_MS });
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
    });
});
