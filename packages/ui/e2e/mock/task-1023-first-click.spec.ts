import { DEFAULT_MOCK_ALLOW, expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { LONG_TIMEOUT_MS } from "../timeouts";

/**
 * task-1023：两件事同批钉行为。
 *
 * 1. **设置侧栏每条链接的第一次点击必须导航**（冻结构建 c2823c9c 实测：第一次只获焦、
 *    URL/AX 不变，第二次才落地；且无二级菜单打开 —— 与 task-1012 的 modal 菜单是两回事）。
 *    判据只锁 URL（不锁像素）：每点一次就断言目标 URL。
 * 2. **侧栏区头 `+` 一次点击直接开「新建工作区」弹窗**（用户 2026-11-24 裁定，取代
 *    task-89 的「+ → 菜单 → 添加 Workspace」两步）。
 *
 * 本 spec 只验收「点击 → 落地」；设置页自身的数据面不在判据里，因此放行几个未桩端点的 404
 * （不是容忍错误：该页数据面由 settings 专项 spec 覆盖）。
 */
test.describe("task-1023 settings sidebar first click", () => {
    test.use({
        mockAllow: [
            ...DEFAULT_MOCK_ALLOW,
            String.raw`/api/v1/(credentials|status|config-locks|presets)`,
        ],
    });

    test("每条设置侧栏链接点一次即落地", async ({ page }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
        await page.goto("/settings/instance/agent-config");
        await expect(page.getByTestId("settings-sidebar")).toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });

        const targets = [
            ["settings-nav-ops-monitoring", /\/settings\/monitoring$/],
            ["settings-nav-ops-data", /\/settings\/data$/],
            ["settings-nav-ops-config-locks", /\/settings\/config-locks$/],
            ["settings-nav-ops-presets", /\/settings\/presets$/],
            ["settings-nav-domain-instance-agent-config", /\/settings\/instance\/agent-config$/],
        ] as const;

        for (const [testId, url] of targets) {
            const link = page.getByTestId(testId);
            await expect(link).toBeVisible();
            await link.click();
            await expect(page, `first click on ${testId} must navigate`).toHaveURL(url);
        }
    });
});

test.describe("task-1023 workspace header + opens create dialog in one click", () => {
    // 创建弹窗会顺带探测系统根目录与 MXC 安装快照；本卡只判「一次点击能开弹窗」，
    // 这两个端点的数据面由创建流程专项 spec 覆盖。
    test.use({
        mockAllow: [
            ...DEFAULT_MOCK_ALLOW,
            String.raw`/api/v1/workspaces/(import-source-roots|mxc-install)`,
            String.raw`Workspace system root discovery failed`,
        ],
    });

    test("one click on the header + opens the create dialog", async ({ page }) => {
        await setupMockAuth(page);
        await setupMockSessions(page, {
            sessions: [{ id: "session-1", title: "Session 1" }],
            messages: { "session-1": [] },
        });
        await page.goto("/workspace/11111111-1111-4111-8111-111111111111");
        await expect(page.getByTestId("sidebar-new-workspace")).toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });

        await page.getByTestId("sidebar-new-workspace").click();
        await expect(page.getByTestId("workspace-create-dialog")).toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
        // 旧两步入口不再存在：一次点击后不能还要求点菜单项。
        await expect(page.getByTestId("sidebar-add-workspace")).toHaveCount(0);
    });
});
