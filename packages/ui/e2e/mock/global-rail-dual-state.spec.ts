// timeout-exempt: long E2E step(s) reviewed in task-189 (mock lane boot + module menus)
import { expect, test } from "./helpers/mock-test";

/**
 * task-189 / BL-584 / BL-578 / D-896：全局条双态 + 二级菜单的**真浏览器证据**。
 *
 * <p>为什么必须是 Playwright 而不是 jsdom：本卡要证明的三件事都在「真实布局 + 真实 popup」上——
 * ① 折叠/展开的**实测宽度**（56px ↔ 192/224px，vendor Sidebar 的 `--sidebar-width` 变量参与），
 * ② `DropdownMenu` 的 popup 真的挂在 body 上并可按 `side=right` 定位，
 * ③ 键盘（Tab → Enter/Space）能开菜单与切态。这三条 jsdom 全测不了（reka-ui 的程序化选择
 * 与 popup 定位在 jsdom 下不存在，见 `packages/ui/AGENTS.md` §Reka UI 交互陷阱）。</p>
 */

/** 折叠态 56px（vendor `--sidebar-width-icon: 3.5rem`）；断言留 ±8px 容差（边框/内距）。 */
const RAIL_COLLAPSED_MAX = 72;
/** 展开态默认 192px；只断言「明显更宽」而不钉死像素（宽度是持久化状态，不是设计常量）。 */
const RAIL_EXPANDED_MIN = 150;

test.describe("GlobalRail 双态 + 二级菜单", () => {
    test.beforeEach(async ({ page }) => {
        await page.addInitScript(() => {
            localStorage.setItem("xihe-token", "mock-token");
            localStorage.setItem(
                "xihe-user",
                JSON.stringify({
                    id: "u1",
                    email: "admin@xihe.local",
                    capabilities: {
                        isInstanceAdmin: true,
                        isInstanceSuper: true,
                        workspaceAdminOf: ["ws-1"],
                    },
                }),
            );
            localStorage.setItem(
                "xihe-workspace",
                JSON.stringify({ id: "ws-1", name: "Mock Workspace" }),
            );
        });
        // mock 车道没有后端：所有 API 走空对象兜底（本 spec 只验导航，不验页面数据）。
        await page.route("**/api/v1/**", (route) =>
            route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
        );
    });

    async function gotoRail(page: import("@playwright/test").Page) {
        await page.goto("/settings/instance/llm-provider");
        await expect(page.getByTestId("global-rail")).toBeVisible();
    }

    test("折叠态悬浮打开二级菜单，内容由 SSOT 派生（资源 5 项）", async ({ page }) => {
        await gotoRail(page);

        const rail = page.getByTestId("global-rail");
        const collapsedBox = await rail.boundingBox();
        expect(collapsedBox?.width ?? 999).toBeLessThan(RAIL_COLLAPSED_MAX);

        // 折叠态只有图标 ⇒ 悬浮是「这个图标是什么」的唯一通道（D-896）。
        await page.getByTestId("global-rail-module-resources").hover();
        const menu = page.getByTestId("global-rail-menu-content-resources");
        await expect(menu).toBeVisible();
        // **「开着」还不够，必须「一直开着」**（task-189 实测抓到的一次真缺陷）：
        // 指针停住不动，菜单若在 160ms 后自己关掉又打开（周期 ≈700ms 的自激开关），
        // 上面那句 `toBeVisible()` 正好落在开的那一帧 ⇒ 断言全过、产品是坏的。
        // 判据：停在同一位置等过两个关闭周期后，仍然可见。
        await page.waitForTimeout(900);
        await expect(menu).toBeVisible();

        // 菜单项 = RESOURCE_DEFS 的投影（5 项，`lib/globalModules.ts`）。
        const items = menu.locator("[data-testid^='global-rail-menu-item-resources-']");
        await expect(items).toHaveCount(5);
        await expect(page.getByTestId("global-rail-menu-item-resources-credentials")).toContainText(
            "凭据",
        );
        await expect(page.getByTestId("global-rail-menu-item-resources-knowledge")).toContainText(
            "知识库",
        );

        // 点菜单项 = 真跳转（不是空壳菜单）。
        await page.getByTestId("global-rail-menu-item-resources-credentials").click();
        await expect(page).toHaveURL(/\/resources\/credentials/);
    });

    test("可见切换控件：aria-expanded 翻转 + 宽度变化 + 键盘可切", async ({ page }) => {
        await gotoRail(page);

        const toggle = page.getByTestId("global-rail-toggle");
        await expect(toggle).toBeVisible();
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
        await expect(toggle).toHaveAttribute("aria-label", "展开侧边栏");

        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-expanded", "true");
        await expect(toggle).toHaveAttribute("aria-label", "收起侧边栏");

        // 宽度是 CSS 过渡出来的（`transition-[width] duration-200`）⇒ 必须轮询到过渡结束，
        // 不能点完就量：实测点完那一帧量到 67.3px（56 → 192 动画的中间值），会假红。
        await expect
            .poll(async () => (await page.getByTestId("global-rail").boundingBox())?.width ?? 0, {
                timeout: 3_000,
            })
            .toBeGreaterThan(RAIL_EXPANDED_MIN);
        // 展开态文字可见（折叠态是 hidden，两者必须是**不同的渲染**，否则「展开了」只是变宽）。
        await expect(page.getByTestId("global-rail-module-workbench")).toContainText("工作台");

        // 键盘：Space 也能切（原生 button，不需要鼠标）。
        await toggle.focus();
        await page.keyboard.press("Space");
        await expect(toggle).toHaveAttribute("aria-expanded", "false");

        // 折叠态的菜单触发器是 `sr-only`（视觉让位）但**留在可达性树里**：键盘仍能开菜单。
        const settingsMenuTrigger = page.getByTestId("global-rail-menu-settings");
        await settingsMenuTrigger.focus();
        await page.keyboard.press("Enter");
        await expect(page.getByTestId("global-rail-menu-content-settings")).toBeVisible();
        // 设置模块的菜单项 = 实例层域清单（12 项，`settingsIa.ts` 的 LAYER_DOMAINS.instance）。
        await expect(page.locator("[data-testid^='global-rail-menu-item-settings-']")).toHaveCount(
            12,
        );
    });

    test("持久化：刷新后折叠态与宽度都恢复（xihe-global-rail 键值原文）", async ({ page }) => {
        // 预置一份「展开 + 非默认宽度 224」的状态：只靠默认值无法区分「恢复」与「没动过」。
        // ⚠️ addInitScript 在**每次**导航（含 `page.reload()`）都会跑：写成无条件 setItem 的话，
        // 刷新会把「收起」重放成「展开」，于是测的不是持久化而是脚本 —— 条件写入是这条断言的前提。
        await page.addInitScript(() => {
            if (!localStorage.getItem("xihe-global-rail")) {
                localStorage.setItem(
                    "xihe-global-rail",
                    JSON.stringify({ open: true, width: 224 }),
                );
            }
        });
        await gotoRail(page);

        const toggle = page.getByTestId("global-rail-toggle");
        await expect(toggle).toHaveAttribute("aria-expanded", "true");
        await expect
            .poll(async () => (await page.getByTestId("global-rail").boundingBox())?.width ?? 0, {
                timeout: 3_000,
            })
            .toBeGreaterThan(200);

        const stored = await page.evaluate(() => localStorage.getItem("xihe-global-rail"));
        expect(stored).toBe(JSON.stringify({ open: true, width: 224 }));

        // 收起后**宽度仍留在键里**（收起不改宽度、展开回原宽）。
        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
        const afterCollapse = await page.evaluate(() => localStorage.getItem("xihe-global-rail"));
        expect(JSON.parse(afterCollapse ?? "{}")).toEqual({ open: false, width: 224 });

        await page.reload();
        await expect(page.getByTestId("global-rail-toggle")).toHaveAttribute(
            "aria-expanded",
            "false",
        );
        await page.getByTestId("global-rail-toggle").click();
        await expect(page.getByTestId("global-rail-toggle")).toHaveAttribute(
            "aria-expanded",
            "true",
        );
        await expect
            .poll(async () => (await page.getByTestId("global-rail").boundingBox())?.width ?? 0, {
                timeout: 3_000,
            })
            .toBeGreaterThan(200);
    });
});
