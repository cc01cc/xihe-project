/**
 * task-129（D-1907 rev9/rev10）：**会话配置 = 容器组件**。
 *
 * <p>本 spec 钉三件事（卡面验收「开→关→再开」+ rev2 的「点一次只多一个页签」）：
 * ① 聊天列 32px 摘要行是**快捷开关**：点一次在右栏容器开 `pane:right:session-config:<sid>`，
 *    再点一次只聚焦、不新增；② 关掉之后页签与面板体都不残留；③ 主栏「+」的组件选择器里
 *    列出同一项（rev7「两容器 + 弹出同一组组件」），从它也能再开一次。</p>
 *
 * <p><b>为什么落 mock 车道</b>：判据是**页签生命周期**（开/关/复用），与会话配置里的
 * 审批/模板/分支数据无关 —— 真机栈跑这一条只会把 CP/runner 的可用性混进读数。面板体是
 * 同一份 `SessionContextPanel`（138 已接），内容正确性由 vitest 与本 spec 之外的既有 e2e 管。</p>
 *
 * <p><b>为什么 testid 用稳定名而不是拼 id</b>：页签 id 带 `:sid`（每次会话都不同），
 * 右栏「+」的项因此用 `dock-reopen-item-session-config`；页签芯片本身仍是通用规则
 * `dock-tab-<id>`（`WorkspaceContainerTabs` 的契约），断言里用 `getByTestId` 传完整 id。</p>
 */
import { expect, test, type Page } from "@playwright/test";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS } from "../timeouts";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "task129-session";
const CHAT_PATH = "/workspace/" + WORKSPACE_ID + "/chat/" + SESSION_ID;
const LAYOUT_KEY = "xihe-layout-ws:" + WORKSPACE_ID;
/** 138 的三元组值域：容器 + view + 会话 id 都在里面（两栏/两会话各一份不会撞）。 */
const CONFIG_TAB_ID = "pane:right:session-config:" + SESSION_ID;

/** 显式桩：与本卡无关的页面依赖一律给最小合法响应（口径同 task-118/task-125 的 mock spec）。 */
async function boot(page: Page): Promise<void> {
    await setupMockAuth(page, {});
    await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "task-129" }] });
    await page.addInitScript(
        ({ key, firstTab }: { key: string; firstTab: string }) => {
            localStorage.setItem("xihe-mock-filetree", JSON.stringify([]));
            // 固定首启态：右栏关闭、只留一个会话页签 —— 让「开页签」的读数可复现。
            localStorage.setItem(
                key,
                JSON.stringify({
                    treeCollapsed: false,
                    treeWidth: 240,
                    dockCollapsed: true,
                    dockWidth: 360,
                    dockTabs: [],
                    activeDockTab: null,
                    dockMode: "pinned",
                    dockFocus: false,
                    openTabs: [firstTab],
                    activeColumn: "main",
                    openTarget: "main",
                }),
            );
        },
        { key: LAYOUT_KEY, firstTab: "session:" + SESSION_ID },
    );
    await page.route("**/api/v1/config/**", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
    );
    await page.route("**/api/v1/provider-catalog", (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ catalogRevision: "task129", providers: [] }),
        }),
    );
    await page.route("**/api/v1/provider-connections", (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ connections: [] }),
        }),
    );
    await page.route("**/api/v1/workspaces/" + WORKSPACE_ID + "/environment", (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                workspaceId: WORKSPACE_ID,
                status: "ready",
                storageBackend: "host_directory",
                storageRef: WORKSPACE_ID,
                executionSpec: { status: "assigned", generation: 1, sandboxSpecHash: "task129" },
                runtime: { status: "ready", deviceId: "task129-device", lastHeartbeatAt: "now" },
            }),
        }),
    );
    await page.goto(CHAT_PATH);
    await page.locator('[data-testid="workspace-main"]').waitFor({
        state: "visible",
        timeout: EXPECT_TIMEOUT_MS,
    });
}

/** 会话配置页签的芯片（右栏行通用规则 `dock-tab-<id>`）。 */
function configTab(page: Page) {
    return page.getByTestId("dock-tab-" + CONFIG_TAB_ID);
}

/** 面板体：同一 testid 在移动端 sheet 里也可能有一份 ⇒ 只取可见的那份。 */
function configPanel(page: Page) {
    return page.locator('[data-testid="session-context-panel"]').filter({ visible: true });
}

test("session config opens from the summary row, focuses on repeat, closes clean and reopens (task-129)", async ({
    page,
}) => {
    await boot(page);

    // ① 快捷开关：点摘要行 ⇒ 右栏开出一个 session-config 页签，且只有这一个。
    const summary = page.getByTestId("session-settings-summary");
    await summary.click({ timeout: ACTION_TIMEOUT_MS });
    await expect(configTab(page)).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
    await expect(configTab(page)).toHaveAttribute("aria-selected", "true");
    await expect(configPanel(page)).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
    await expect(page.locator('[data-testid^="dock-tab-pane:right:session-config:"]')).toHaveCount(
        1,
    );

    // ② 再点一次：只聚焦，不重复开（卡面 rev2 的门）。
    await summary.click({ timeout: ACTION_TIMEOUT_MS });
    await expect(page.locator('[data-testid^="dock-tab-pane:right:session-config:"]')).toHaveCount(
        1,
    );
    await expect(configTab(page)).toHaveAttribute("aria-selected", "true");

    // ③ 关掉：页签与面板体都不残留。
    await page.getByTestId("dock-tab-close-" + CONFIG_TAB_ID).click({ timeout: ACTION_TIMEOUT_MS });
    await expect(page.getByTestId("dock-tab-" + CONFIG_TAB_ID)).toHaveCount(0);
    await expect(configPanel(page)).toHaveCount(0);

    // ④ 再开：主栏「+」的组件选择器里列出同一项（两容器对等），从它开回来。
    await page.getByTestId("workspace-container-plus-main").click({ timeout: ACTION_TIMEOUT_MS });
    await expect(page.getByTestId("workspace-add-item-session-config")).toBeVisible({
        timeout: EXPECT_TIMEOUT_MS,
    });
    await page
        .getByTestId("workspace-add-item-session-config")
        .click({ timeout: ACTION_TIMEOUT_MS });
    await expect(configTab(page)).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
    await expect(configTab(page)).toHaveAttribute("aria-selected", "true");

    // ⑤ 右栏「+」里也有它（稳定 testid，不拼会话 id）。
    await page.getByTestId("workspace-container-plus-right").click({ timeout: ACTION_TIMEOUT_MS });
    await expect(page.getByTestId("dock-reopen-item-session-config")).toBeVisible({
        timeout: EXPECT_TIMEOUT_MS,
    });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("dock-reopen-item-session-config")).toHaveCount(0);
});
