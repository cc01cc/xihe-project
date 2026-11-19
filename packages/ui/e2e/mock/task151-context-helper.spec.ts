/**
 * task-151（承 D-1907 / task-129 rev10）：**`openContextPanel` 打开的是 `context` 页签，不是会话配置**。
 *
 * <p>背景：helper 过去在 dock 收起时点聊天列摘要行（`session-settings-summary`）开面板，而 task-129 之后
 * 摘要行改成「会话配置」页签的快捷开关（`pane:right:session-config:<sid>`）⇒ 5 个消费 spec 的
 * 「打开 context 面板」被静默换成「打开会话配置页签」：面板看得见（同一份 `SessionContextPanel`），
 * 页签 id 却换了人。本 spec 把这两条路分别钉死：</p>
 *
 * <p>① 点摘要行 ⇒ 开的是会话配置页签（钉住产品现状，防止 helper 又退回这条路）；
 * ② 走 `openContextPanel` ⇒ 页签 id 是 `context`（且不额外开出会话配置页签）；
 * ③ `viaAddMenu:false` 且 dock 收起时**必须报错**，不许偷偷走摘要行（旧行为的入口）。</p>
 */
import { expect, test, type Page } from "@playwright/test";
import { openContextPanel } from "../helpers/context-panel";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS } from "../timeouts";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "task151-session";
const CHAT_PATH = "/workspace/" + WORKSPACE_ID + "/chat/" + SESSION_ID;
const LAYOUT_KEY = "xihe-layout-ws:" + WORKSPACE_ID;
/** 会话配置页签（task-129 / D-1907 的三元组值域），摘要行现在开的就是它。 */
const CONFIG_TAB_ID = "pane:right:session-config:" + SESSION_ID;

/** 固定首启态：右栏收起、无 dock 页签 —— 让「从零开面板」的读数可复现（同 task-129 的 boot 口径）。 */
async function boot(page: Page): Promise<void> {
    await setupMockAuth(page, {});
    await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "task-151" }] });
    await page.addInitScript(
        ({ key, firstTab }: { key: string; firstTab: string }) => {
            localStorage.setItem("xihe-mock-filetree", JSON.stringify([]));
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
            body: JSON.stringify({ catalogRevision: "task151", providers: [] }),
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
                executionSpec: { status: "assigned", generation: 1, sandboxSpecHash: "task151" },
                runtime: { status: "ready", deviceId: "task151-device", lastHeartbeatAt: "now" },
            }),
        }),
    );
    await page.goto(CHAT_PATH);
    await page.locator('[data-testid="workspace-main"]').waitFor({
        state: "visible",
        timeout: EXPECT_TIMEOUT_MS,
    });
}

/** 会话配置页签芯片（右栏通用规则 `dock-tab-<id>`；id 里带 `:sid`，只能整串匹配）。 */
function configTab(page: Page) {
    return page.getByTestId("dock-tab-" + CONFIG_TAB_ID);
}

/** `context` 页签芯片。 */
function contextTab(page: Page) {
    return page.getByTestId("dock-tab-context");
}

test("the summary row opens the session-config pane, not the context pane (task-151)", async ({
    page,
}) => {
    await boot(page);

    await page.getByTestId("session-settings-summary").click({ timeout: ACTION_TIMEOUT_MS });

    // 摘要行 = 会话配置快捷开关（task-129 rev10 产品现状）。
    await expect(configTab(page)).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
    await expect(configTab(page)).toHaveAttribute("aria-selected", "true");
    // 关键反证：它没有开出 context 页签。
    await expect(contextTab(page)).toHaveCount(0);
});

test("openContextPanel opens the context pane through the main add menu (task-151)", async ({
    page,
}) => {
    await boot(page);

    await openContextPanel(page);

    // 打开的是 context 页签本身（不是会话配置），且已选中。
    await expect(contextTab(page)).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
    await expect(contextTab(page)).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("dock-tab-pane:right:session-config:" + SESSION_ID)).toHaveCount(
        0,
    );
    // 面板本体仍可见（判据不变，只是页签 id 现在被钉住了）。
    await expect(
        page.locator('[data-testid="session-context-panel"]').filter({ visible: true }),
    ).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
});

test("openContextPanel refuses to fall back to the summary row (task-151)", async ({ page }) => {
    await boot(page);

    // dock 收起且 viaAddMenu=false ⇒ 必须显式报错，不许偷偷点摘要行（旧行为的入口）。
    // 顶层消息是带 dock 快照的包装串，**原因在 cause 里** —— 两条分别钉，缺一条就测不到真实理由。
    const error = await openContextPanel(page, { viaAddMenu: false }).then(
        () => null,
        (caught: Error & { cause?: Error }) => caught,
    );
    expect(error, "viaAddMenu=false 且 dock 收起时必须抛错").not.toBeNull();
    expect(error?.message, "顶层消息要带 dock 快照").toMatch(/openContextPanel\("context"\) 失败/);
    expect(error?.cause?.message, "原因要说清是哪条路被禁").toMatch(/viaAddMenu=false/);
    await expect(contextTab(page)).toHaveCount(0);
});
