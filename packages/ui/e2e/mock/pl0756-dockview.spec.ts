/**
 * PLAN-0756 V2/V3/V5：dock 区 dockview 集成 Playwright 验证（决策 #18 ②：dockview 集成一律
 * Playwright，jsdom 不覆盖）。mock lane，route 模式参照 `bl382-prepend-full-scroll.spec.ts`。
 *
 * 覆盖：
 * - V2  序列化往返：打开 tab 集 / 活动 tab 与布局持久面一致；
 * - V2b dockview 宿主实渲染（`globalThis.__xhUseDockview` 开启后 `.dv-shell` 出现 + 面板内容挂载）；
 * - V3  clamp 不写回：`proportionalLayout:false` 下视口收窄，持久尺寸不变；
 * - V5  模式：pinned/floating 断点派生 + 手选优先（`dockModeManual`）。
 *
 * 跑法（lane 内）：`XIHE_UI_PORT=<port> XIHE_E2E_EXTERNAL_SERVER=1 pnpm exec playwright test
 * --config e2e/playwright.config.ts e2e/mock/pl0756-dockview.spec.ts`
 *
 * ⚠️ 整块已 `test.describe.skip`：**用户 2026-11-10 裁定「dockview 保留依赖但不用于
 * MVP」**，`WorkspaceDock.vue` 的 dockview 渲染分支已整段注释、`dockviewEnabled` 恒
 * false，这些用例当前必然失败（V2b 断言 `.dv-shell` 出现）。文件保留作重新启用时的
 * 现成验收脚本：恢复 `WorkspaceDock.vue` 渲染分支 + 去掉本文件的 `.skip` 即可复用。
 * 裁定与重新启用清单见 `plans/PLAN-0756-XH-m7m8-dock-layout-deps/evidence/
 * dockview-capability-demo.md`。
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { collectPageFailures, expectNoPageFailures } from "./helpers/page-failures";
import { EXPECT_TIMEOUT_MS } from "../timeouts";

const WORKSPACE_PATH = "/workspace/workspace-1";
const LAYOUT_KEY = "xihe-layout-ws:workspace-1";
const AUX_PANEL = '[data-testid="workspace-aux-panel"]';

/** 打开 dock（走真实 toolbar，不绕过 UI）。 */
async function openDock(page: Page, tab = "code"): Promise<void> {
    await page.goto(WORKSPACE_PATH);
    await page.waitForSelector('[data-testid="workspace-workbench"]', {
        state: "attached",
        timeout: EXPECT_TIMEOUT_MS,
    });
    await page.click(`[data-testid="workspace-toolbar-${tab}"]`);
    await page.waitForSelector(AUX_PANEL, { state: "attached", timeout: EXPECT_TIMEOUT_MS });
}

/** 读持久布局（`xihe-layout-ws:workspace-1`）。 */
async function readLayout(page: Page): Promise<Record<string, unknown>> {
    return page.evaluate((key) => {
        return JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, unknown>;
    }, LAYOUT_KEY);
}

test.beforeEach(async ({ page }) => {
    await setupMockAuth(page);
    await setupMockSessions(page, { sessions: [{ id: "session-1", title: "Session 1" }] });
    await page.route("**/api/v1/me/permissions", async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                userId: "user-1",
                instanceCapabilities: ["CREATE_ACCOUNT"],
                instancePermissions: [{ actionClass: "CREATE_ACCOUNT", resource: "*" }],
                workspaces: [
                    {
                        workspaceId: "workspace-1",
                        workspaceAdmin: true,
                        permissions: [
                            { actionClass: "MANAGE_WORKSPACE_AGENTS", resource: "workspace-1" },
                        ],
                    },
                ],
            }),
        });
    });
    // 每条用例从干净布局开始（否则上一条的 dockTabs/dockMode 会串味）。
    await page.addInitScript((key) => localStorage.removeItem(key), LAYOUT_KEY);
});

test.describe.skip("PLAN-0756 dockview 集成（用户 2026-11-10 裁定停用，恢复见文件头）", () => {
    test("V2 dock keeps the open tab set and active tab in the layout store", async ({ page }) => {
        await openDock(page, "code");

        await expect(page.locator(AUX_PANEL)).toBeVisible();
        await expect
            .poll(async () => (await readLayout(page)).dockTabs, { timeout: EXPECT_TIMEOUT_MS })
            .toContain("code");
        await expect
            .poll(async () => (await readLayout(page)).activeDockTab, {
                timeout: EXPECT_TIMEOUT_MS,
            })
            .toBe("code");

        expectNoPageFailures(collectPageFailures(page));
    });

    test("V2b dockview host renders the dock area when the flag is on", async ({ page }) => {
        // PLAN-0756 T1：打开 dockview 宿主后 dock 区由 dockview 接管（`.dv-shell` + 面板内容）。
        await page.addInitScript(() => {
            (globalThis as { __xhUseDockview?: boolean }).__xhUseDockview = true;
        });
        await openDock(page, "code");

        // dockview 根渲染。
        await expect(page.locator(".dv-shell").first()).toBeAttached({
            timeout: EXPECT_TIMEOUT_MS,
        });
        // dockview 自绘 tab 条：XH 的 dock tab 集投影为 `.dv-tab`（标题非空 = 面板已注册）。
        const dockTabs = page.locator(".dv-tab");
        await expect(dockTabs.first()).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        expect((await dockTabs.first().innerText()).trim().length).toBeGreaterThan(0);
        // 面板内容经 teleport 挂进 dockview 内容区。
        await expect(page.locator(".dv-content-container").first()).toBeAttached({
            timeout: EXPECT_TIMEOUT_MS,
        });

        expectNoPageFailures(collectPageFailures(page));
    });

    test("V3 proportionalLayout:false keeps the persisted width across a viewport shrink", async ({
        page,
    }) => {
        await openDock(page, "code");
        await expect
            .poll(async () => (await readLayout(page)).dockWidth, { timeout: EXPECT_TIMEOUT_MS })
            .toBeGreaterThan(0);

        const before = await readLayout(page);

        // 视口收窄（1920 → 1280）：渲染 clamp 生效，但持久宽度不得被写回。
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.waitForSelector(AUX_PANEL, { state: "attached", timeout: EXPECT_TIMEOUT_MS });

        const after = await readLayout(page);
        expect(after.dockWidth).toBe(before.dockWidth);
        expectNoPageFailures(collectPageFailures(page));
    });

    test("V5 dock mode derives from the breakpoint and honours the manual override", async ({
        page,
    }) => {
        await openDock(page, "code");

        // ≥1800 → pinned 派生；dockModeManual 未置位。
        await expect
            .poll(async () => (await readLayout(page)).dockMode, { timeout: EXPECT_TIMEOUT_MS })
            .toBe("pinned");
        await expect
            .poll(async () => (await readLayout(page)).dockModeManual, {
                timeout: EXPECT_TIMEOUT_MS,
            })
            .toBe(false);

        // 手选优先：切换后 dockModeManual=true 且持久 dockMode 为用户选择。
        await page.click('[data-testid="dock-mode-toggle"]');
        await expect
            .poll(async () => (await readLayout(page)).dockMode, { timeout: EXPECT_TIMEOUT_MS })
            .toBe("floating");
        await expect
            .poll(async () => (await readLayout(page)).dockModeManual, {
                timeout: EXPECT_TIMEOUT_MS,
            })
            .toBe(true);

        expectNoPageFailures(collectPageFailures(page));
    });
});
