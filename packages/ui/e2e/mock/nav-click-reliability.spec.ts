import type { Page } from "@playwright/test";
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth } from "./helpers/auth";

/**
 * task-1021：全局导航「点击被吞」的**常驻**回归（task-1012 一次性脚本的固化）。
 *
 * <p>task-1012 的根因有两条，本 spec 各用一格行为断言钉住：</p>
 * <ol>
 *   <li><b>模态二级菜单吃点击</b>：reka `DropdownMenu` 默认 modal，菜单开着时文档其余部分是
 *       `pointer-events: none`，于是「点另一个 rail 模块」的第一次点击只用来关菜单。
 *       判据 = 菜单开着时**一次**点击就落地，且菜单打开期间 `body.pointerEvents === "auto"`
 *       （非模态的抽象语义，不去读 reka 内部字段）。</li>
 *   <li><b>chevron 压住行右缘</b>：旧实现把 28×28 的触发器 `absolute right-1` 叠在整行按钮上，
 *       点行右缘只开菜单不导航。判据 = 点导航按钮自身右缘 14px 必须**导航**，且没有弹出菜单。</li>
 *   <li><b>同 tick 连点</b>：最终 URL 必须等于最后一次点击的目标（不是"发起过 push"）。</li>
 * </ol>
 *
 * <p>为什么必须在真浏览器：modal 的指针屏蔽、popup 命中区、同 tick 的双次点击都是浏览器合成行为，
 * jsdom 下不存在（`packages/ui/AGENTS.md` §Reka UI 交互陷阱）。</p>
 *
 * <p>无头默认：`pnpm test:e2e`（`e2e/mock/**` 全量）或
 * `pnpm test:e2e:nav-click`（本文件）。需要目视时用 `XIHE_E2E_HEADED=1` 前缀 ——
 * 配置里 headed 是显式开关（`e2e/playwright.config.ts`），不是本 spec 自造。</p>
 *
 * <p>反例输入（证明本测试能抓回归）：把 `GlobalRailModule.vue` 的 `:modal="false"` 去掉，
 * 场景 1/3 红；把 chevron 改回 `absolute`，场景 2 红。读数见
 * `internal/A03-xihe/evidence/2026-11-24-nav-click-e2e/`。</p>
 */
test.describe("task-1021：全局导航点击可靠性（rail）", () => {
    test.beforeEach(async ({ page }) => {
        // 与 `resources-ia` / `global-rail-dual-state` 同口径：mock 数据集完整挂载，
        // 而不是自己拼一份 `{}` 兜底（缺字段会让页面渲染半截，红点离根因很远）。
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
    });

    /** 设置 rail 双态后再进页面；状态键与产品同源（`xihe-global-rail = { open, width }`）。 */
    async function openRail(page: Page, path: string, open: boolean) {
        await page.addInitScript(
            (state) => localStorage.setItem("xihe-global-rail", JSON.stringify(state)),
            { open, width: 192 },
        );
        await page.goto(path);
        await expect(page.getByTestId("global-rail")).toBeVisible();
    }

    /** 用原始指针坐标点击 —— 不做 actionability 重试，读数就是"用户真的点了一下"。 */
    async function clickCenter(page: Page, testId: string) {
        const box = await page.getByTestId(testId).boundingBox();
        if (!box) throw new Error(`${testId} 没有 bounding box（rail 没渲染出来）`);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }

    test("二级菜单开着 → 点另一个 rail 模块：一次点击就落地（非模态）", async ({ page }) => {
        // 展开态：折叠态的 chevron 是 sr-only（键盘通道），鼠标点的就是模块按钮本身，
        // 用展开态才能用指针复现「菜单开着」这个真实用户路径。
        await openRail(page, "/resources/credentials", true);

        await page.getByTestId("global-rail-menu-resources").click();
        const menu = page.getByTestId("global-rail-menu-content-resources");
        await expect(menu).toBeVisible();

        // 「modal=false」的抽象判据：菜单开着时页面其余部分仍接受指针事件。
        // 模态实现会把 body 标成 pointer-events:none —— 那正是第一次点击被吞的机制。
        expect(await page.evaluate(() => getComputedStyle(document.body).pointerEvents)).toBe(
            "auto",
        );

        // 只点一次，不重试、不加等待：事件/URL 等待由 expect 承担。
        await clickCenter(page, "global-rail-module-settings");
        await expect(page).toHaveURL(/\/settings(\/|$)/);
        await expect(menu).toHaveCount(0);
    });

    test("展开态点模块行右缘 14px（旧 chevron 区）→ 必须导航，不是只开菜单", async ({ page }) => {
        await openRail(page, "/resources/credentials", true);

        const row = await page.getByTestId("global-rail-module-settings").boundingBox();
        if (!row) throw new Error("settings 行没有 bounding box");
        // 判据是**导航按钮自身**的右缘：修复后 chevron 是独立列，不再压在按钮命中区内。
        // 旧实现（chevron absolute）下这一击会命中触发器，URL 不变 —— 回归即红。
        await page.mouse.click(row.x + row.width - 14, row.y + row.height / 2);

        await expect(page).toHaveURL(/\/settings(\/|$)/);
        await expect(page.getByTestId("global-rail-menu-content-settings")).toHaveCount(0);
    });

    test("同一 tick 连点两个模块 → 最终 URL = 最后一次点击目标", async ({ page }) => {
        await openRail(page, "/settings/instance/llm-provider", false);

        // 同一个事件循环里两次 click()：模拟"手快连点"，中间不给任何帧。
        await page.evaluate(() => {
            const resources = document.querySelector<HTMLElement>(
                '[data-testid="global-rail-module-resources"]',
            );
            const scheduled = document.querySelector<HTMLElement>(
                '[data-testid="global-rail-module-scheduled-tasks"]',
            );
            if (!resources || !scheduled) throw new Error("rail 模块按钮缺失");
            resources.click();
            scheduled.click();
        });

        // 目标取 `/scheduled-tasks`：工作台落地会按 tab 工作区上下文展开成 `/workspace/<id>`，
        // 那是守卫语义不是本卡判据；这里只要「最后一次点击的目标赢了」。
        await expect(page).toHaveURL(/\/scheduled-tasks$/);
    });
});
