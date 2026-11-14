import { type Page } from "@playwright/test";
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth } from "./helpers/auth";

/**
 * task-537（Lead 2026-11-14 派；来自 task-397 真栈读数）：**非 UUID 的工作区路径不许渲染成空壳**。
 *
 * <p>真栈修前读数：`/workspace/11111111-1111-4111-8111-111111111111` ⇒ CP `400 X-Workspace-Id must be a UUID`（两条），
 * 左栏「还没有工作区」、页面无任何错误文案 —— 用户看到的是「空」而不是「错」。</p>
 *
 * <p>修法（前端一行守卫）：**先验形状再写 tab 上下文**，形状不对就清上下文回工作区列表，
 * 并带 `?invalidWorkspace=1` 让列表页明说「链接无效 + 下一步」。所以本 spec 钉三件事：
 * ① 明确错误态（不是空态）② 非法 id 一次都不发给后端 ③ 合法 UUID 不被误伤（负向对照）。</p>
 */

const INVALID_WORKSPACE_ID = "11111111-1111-4111-8111-111111111111"; // 真栈上撞 400 的那个 slug
const VALID_WORKSPACE_ID = "19e1c21c-9b93-40d8-94e6-0b371f3c7f19";

async function stubWorkspaceApis(page: Page): Promise<string[]> {
    const sent: string[] = [];
    page.on("request", (request) => {
        const url = request.url();
        if (url.includes("/api/v1/workspaces")) sent.push(url);
    });
    await setupMockAuth(page);
    await page.route("**/api/v1/**", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
    );
    await page.route(/\/api\/v1\/workspaces(?:\?.*)?$/, (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ workspaces: [], items: [] }),
        }),
    );
    await page.route(/\/api\/v1\/(?:workspaces\/[^/]+\/)?sessions(?:\?.*)?$/, (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: '{"sessions":[]}' }),
    );
    return sent;
}

test("task-537 非 UUID 工作区路径：回列表页 + 明确错误态 + 不把非法 id 发出去", async ({
    page,
}) => {
    const sent = await stubWorkspaceApis(page);

    await page.goto(`/workspace/${INVALID_WORKSPACE_ID}`);

    // ① 落地在工作区列表页（可行动作就在眼前），不是停在一个空壳工作区里
    await expect(page.getByTestId("workspace-picker")).toBeVisible();
    await expect(page).toHaveURL(/\/workspace(?:\?|$)/);

    // ② 明确错误态：文案说清是「链接无效」，且带一个可关闭的动作
    const banner = page.getByTestId("workspace-invalid-id");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/链接无效/);
    await expect(banner.getByTestId("workspace-invalid-id-dismiss")).toBeVisible();

    // ③ 非法 id 一次都不该进请求（修前是两条 400）
    expect(sent.filter((url) => url.includes(INVALID_WORKSPACE_ID))).toEqual([]);
});

test("task-537 负向对照：合法 UUID 不被守卫误伤（保持在工作区路由上）", async ({ page }) => {
    await stubWorkspaceApis(page);

    await page.goto(`/workspace/${VALID_WORKSPACE_ID}`);

    // 守卫只拦「形状不对」，合法 UUID 仍应留在工作区路由（是否 403/404 由 CP 决定，本 spec 不管）
    await expect(page).toHaveURL(new RegExp(`/workspace/${VALID_WORKSPACE_ID}`));
    await expect(page.getByTestId("workspace-invalid-id")).toHaveCount(0);
});
