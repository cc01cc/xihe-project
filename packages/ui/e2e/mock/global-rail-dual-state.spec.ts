// timeout-exempt: long E2E step(s) reviewed in task-189 (mock lane boot + module menus)
import { expect, test } from "./helpers/mock-test";

/**
 * task-189 / BL-584 / BL-578 / D-896（**④b 已由 D-899 推翻**，`task-259` 回退）：
 * 全局条双态 + 二级菜单的**真浏览器证据**。
 *
 * <p>为什么必须是 Playwright 而不是 jsdom：本卡要证明的三件事都在「真实布局 + 真实 popup」上——
 * ① 折叠/展开的**实测宽度**（56px ↔ 192/224px，vendor Sidebar 的 `--sidebar-width` 变量参与），
 * ② `DropdownMenu` 的 popup 真的挂在 body 上并可按 `side=right` 定位，
 * ③ 键盘（Tab → Enter/Space）能开菜单与切态。这三条 jsdom 全测不了（reka-ui 的程序化选择
 * 与 popup 定位在 jsdom 下不存在，见 `packages/ui/AGENTS.md` §Reka UI 交互陷阱）。
 * ④（`task-259`）**指针停在模块行上不开菜单** —— 这是一条"什么都没发生"的断言，只有真实
 * 浏览器 + 真墙钟等待才判得了（jsdom 里没有指针合成，删 handler 与没触发同读数）。它与
 * 第 1 条用例里「chevron 点击后菜单出现」**成对**：只留前者会变成"删了菜单也算绿"。</p>
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

    /**
     * task-259（回退 `83b4fd213` 的悬停通道）：**折叠态指针停住不出现菜单** + **点 chevron 才出现**
     * —— 两条一起才证明「删对了通道」而不是「把菜单删了」（D-899 判 BL-578 缓做，
     * `D-896 ④b` 的悬浮方向由用户本人推翻；点击/键盘通道仍成立）。
     *
     * <p>为什么 jsdom 不足以判这条：`pointerenter` 是浏览器合成事件，`trigger("pointerenter")`
     * 只能证明"我们把 handler 接上了"，删掉 handler 与"指针真的没触发"在单测里同一个读数；
     * 这里用**真实指针 + 真墙钟等待**，判据是"等过足够长时间后菜单依然不存在"。</p>
     */
    test("折叠态悬浮不打开二级菜单（D-899 回退），chevron 点击才打开且内容由 SSOT 派生", async ({
        page,
    }) => {
        await gotoRail(page);

        const rail = page.getByTestId("global-rail");
        const collapsedBox = await rail.boundingBox();
        expect(collapsedBox?.width ?? 999).toBeLessThan(RAIL_COLLAPSED_MAX);

        // ① 反向断言：指针停在模块行上 900ms（远大于历史上那条 160ms 打开延迟）⇒ 菜单**不存在**。
        // 用 toHaveCount(0) 而不是 not.toBeVisible：关闭态 reka 直接不挂载内容，
        // "不可见"对"没渲染"与"渲染了但藏起来"两种实现都成立 ⇒ 判据会过松。
        //
        // 用 `mouse.move` 而不是 `hover()`：`hover()` 带 actionability 检查，一旦有人把悬浮通道
        // 加回来，菜单（reka 默认 modal）会把内容区标成 `pointer-events:none` ⇒ `hover()` 永远等不到
        // "可接收指针事件" ⇒ 整条用例**以 30s 超时收场**（实测反例输入：把 `@pointerenter` 接回
        // 打开通道，本用例红为 "Test timeout of 30000ms exceeded"，看不出是哪条判据红）。
        // `mouse.move` 不做该检查 ⇒ 断言落在 toHaveCount 上，同一次反例输入的失败信息是
        // "Expected: 0 / Received: 1"，直接点出是「菜单真出现了」。
        const row = await page.getByTestId("global-rail-module-resources").boundingBox();
        if (!row) throw new Error("折叠态模块行没有 bounding box（rail 没渲染出来）");
        await page.mouse.move(row.x + row.width / 2, row.y + row.height / 2);
        await page.waitForTimeout(900);
        await expect(page.getByTestId("global-rail-menu-content-resources")).toHaveCount(0);
        // 触发器的 aria 状态也没被指针改过（悬浮不改变可访问性状态）。
        await expect(page.getByTestId("global-rail-menu-resources")).toHaveAttribute(
            "aria-expanded",
            "false",
        );

        // ② 正例（**点击通道**）：折叠态 chevron 是 `sr-only`（视觉让位、键盘仍可达，见下一条用例的
        // 键盘 Enter），Playwright 的 actionability 会拒绝点不可见元素 —— 这不是缺陷，而是折叠态的
        // 事实：**折叠态用键盘、展开态用点击**。所以先把栏展开，再点同一行的 chevron。
        const menu = page.getByTestId("global-rail-menu-content-resources");
        await page.getByTestId("global-rail-toggle").click();
        await expect
            .poll(async () => (await rail.boundingBox())?.width ?? 0, { timeout: 3_000 })
            .toBeGreaterThan(RAIL_EXPANDED_MIN);
        await page.getByTestId("global-rail-menu-resources").click();
        await expect(menu).toBeVisible();
        // 「开着」还不够：历史上正是这里被 hover 计时器关掉又重开（周期 ≈700ms 的自激开关）
        // ⇒ 等过两个周期后仍必须可见（R1：观察窗 ≥ 触发阈值 3 倍）。
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
