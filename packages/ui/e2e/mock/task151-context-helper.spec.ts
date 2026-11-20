/**
 * task-151 / task-6（承 D-1907 / D-1453）：**会话设置面板只有一条页签路，静态 `context` 页签已退役**。
 *
 * <p>task-151 时这里钉的是「helper 开的是 `context` 页签、不是会话配置」；task-6（D1453 / N-6 选 A）
 * 把静态 `context` 页签整个退役后，会话设置面板只经 `pane:right:session-config:<sid>` 打开，
 * helper 也随之改为「固定开 session-config」。本 spec 因此钉三件事：</p>
 *
 * <p>① 点聊天列摘要行 ⇒ 开的是会话配置页签，且没有 `dock-tab-context`（静态页签不退回来）；
 * ② `openContextPanel(page)`（无参，9 个消费 spec 的调用形态）⇒ 开的是会话配置页签、已选中，
 *    `dock-tab-context` 与「+」选择器里的 `workspace-add-item-context` 都不存在；
 * ③ `viaAddMenu:false` 且 dock 收起时**必须报错**，不许偷偷点摘要行（旧行为的入口）。</p>
 */
import { expect, test, type Page } from "@playwright/test";
import { openContextPanel } from "../helpers/context-panel";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS } from "../timeouts";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "task151-session";
const CHAT_PATH = "/workspace/" + WORKSPACE_ID + "/session/" + SESSION_ID;
const LAYOUT_KEY = "xihe-layout-ws:" + WORKSPACE_ID;
/** 会话配置页签（task-129 / D-1907 的三元组值域），摘要行与 helper 开的就是它。 */
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

/** 已退役的静态 `context` 页签芯片（task-6 后必须恒为 0）。 */
function contextTab(page: Page) {
    return page.getByTestId("dock-tab-context");
}

test("the summary row opens the session-config pane, not the retired context pane (task-151)", async ({
    page,
}) => {
    await boot(page);

    await page.getByTestId("session-settings-summary").click({ timeout: ACTION_TIMEOUT_MS });

    // 摘要行 = 会话配置快捷开关（task-129 rev10 产品现状）。
    await expect(configTab(page)).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
    await expect(configTab(page)).toHaveAttribute("aria-selected", "true");
    // 关键反证：退役的静态 context 页签没有以任何形态出现。
    await expect(contextTab(page)).toHaveCount(0);
});

test("openContextPanel opens the session-config pane through the main add menu (task-6)", async ({
    page,
}) => {
    await boot(page);

    // 9 个消费 spec 的调用形态：无参 ⇒ 会话设置面板（唯一的面板入口）。
    await openContextPanel(page);

    // 打开的是会话配置页签本身，且已选中。
    await expect(configTab(page)).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
    await expect(configTab(page)).toHaveAttribute("aria-selected", "true");
    // **task-6 红线**：静态 context 页签退役后不再出现（芯片不存在）。
    await expect(contextTab(page), "静态 context 页签必须已退役").toHaveCount(0);
    // 面板本体仍可见（判据不变，只是页签 id 现在被钉在了 session-config 上）。
    await expect(
        page.locator('[data-testid="session-context-panel"]').filter({ visible: true }),
    ).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });

    // 「+」组件选择器里也没有 context 项（入口侧同样退役，见 task97-container-plus.spec.ts）。
    await page.getByTestId("workspace-container-plus-main").click({ timeout: ACTION_TIMEOUT_MS });
    await expect(
        page.getByTestId("workspace-container-add-menu-main"),
        "main + 应弹出组件选择器",
    ).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
    await expect(page.getByTestId("workspace-add-item-context")).toHaveCount(0);
    await page.keyboard.press("Escape");
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
    expect(error?.message, "顶层消息要带 dock 快照").toMatch(
        /openContextPanel\("session-config"\) 失败/,
    );
    expect(error?.cause?.message, "原因要说清是哪条路被禁").toMatch(/viaAddMenu=false/);
    await expect(contextTab(page)).toHaveCount(0);
});
