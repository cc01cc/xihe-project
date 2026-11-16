/**
 * task-90 判据 ① ② —— 成员页 `tablist` 的**可访问名**必须落在有 `role` 的那个元素上。
 *
 * 病因（与 task-81 P1-2 同源，本页是漏改的姊妹页）：`aria-label` 原来挂在 `<Tabs>` 根上。
 * reka 的 `TabsRoot.cjs` **不输出任何 `role`**（源码 `grep -c role` = 0 命中），
 * vendor `Tabs.vue` 只把 attrs 透传给 `TabsRoot` ⇒ label 落到一个无 role 的外层 div，
 * `[role="tablist"]` 自身的可访问名仍是空 ⇒ 屏幕阅读器不播报组名。
 * 「有 aria-label」看起来满足了，实际没说话 —— 这比完全没有更危险（会让人以为已合规）。
 *
 * 为什么必须用真实浏览器而不只是单测：单测（jsdom）能看出 attrs 落点，但看不出
 * 「浏览器 aria 树算出来的名字」；本 spec 钉的正是「念得出来」这件事。
 *
 * 判据为什么取 `[role="tablist"]` 的 `aria-label` **非空**，而不是 `getByRole(..., { name })`：
 * 后者把「名字为空」与「名字不匹配」混成同一个失败，报告里分不清是挂错位置还是文案变了。
 * 直接读属性，「为空」与「值不对」是两个可区分的读数。
 *
 * 【变异验证方法（判据 ②）】把 `aria-label` 移回 `<Tabs>` 根后重跑本 spec：
 * 下面「带名字的 tablist 数 = 1」这条会变成 **0** ⇒ 红。
 * 实测已在 task-90 执行过（改前红、改后绿，读数见报告）；
 * 变异本身（改代码→跑→红→改回）不是常驻断言，故不留在文件里。
 */
import { expect, test } from "./helpers/mock-test";
import type { Page } from "@playwright/test";
import { setupMockAuth } from "./helpers/auth";
import { EXPECT_TIMEOUT_MS } from "../timeouts";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const THEME_KEY = "xihe-theme";

/** 等 SPA 真的渲染完（domcontentloaded 后 #app 还要一会儿才出内容）。 */
async function settle(page: Page): Promise<void> {
    await page.waitForSelector("main", { state: "visible", timeout: EXPECT_TIMEOUT_MS });
}

async function gotoMembers(page: Page, dark: boolean): Promise<void> {
    if (dark) {
        await page.addInitScript(
            ([key]) => {
                window.localStorage.setItem(key, JSON.stringify("dark"));
            },
            [THEME_KEY],
        );
    }
    await page.goto(`/workspace/${WORKSPACE_ID}/members`, { waitUntil: "load" });
    await settle(page);
}

/** 装着成员页两个页签的那个 tablist（用 `:has` 限定，避免抓到导航的 tablist）。 */
const MEMBERS_TABLIST = '[role="tablist"]:has([data-testid="members-tab-members"])';

test.describe("task-90 ① 成员页 tablist 的组名", () => {
    test("成员页那个 tablist 自身带非空 aria-label", async ({ page }) => {
        await setupMockAuth(page);
        await gotoMembers(page, false);

        // 先钉「页签确实在用 vendor TabsList」：没有 tablist 时下面的断言会红在
        // 「元素不存在」上，那是替身/渲染问题，不是本卡的无障碍缺陷 —— 两条分开。
        const list = page.locator(MEMBERS_TABLIST);
        await expect(list, "成员页应有 vendor TabsList 承载的两个页签").toHaveCount(1);

        const label = await list.getAttribute("aria-label");
        expect(
            label,
            "组名必须落在 [role=tablist] 自身：挂到 <Tabs> 根上会落到无 role 的外层 div，" +
                "tablist 的可访问名仍为空 ⇒ 屏幕阅读器念不到组名（task-81 / task-90 病因）",
        ).toBeTruthy();
        expect(label?.trim().length, "组名不得是空白字符串").toBeGreaterThan(0);

        // 两个页签都在这个组内（组名归属正确，不是抓了个空壳）
        await expect(page.getByTestId("members-tab-members")).toHaveCount(1);
        await expect(page.getByTestId("members-tab-agents")).toHaveCount(1);
    });

    test("全页「带名字的 tablist」恰好 1 个 —— 组名没有漏挂到别处，也没有挂两遍", async ({
        page,
    }) => {
        await setupMockAuth(page);
        await gotoMembers(page, false);

        // 本页实测有 2 个 tablist：工作区导航（aria-label 为空，task-83 已登记为另一件事）
        // 与成员页页签（本卡修好后有名字）。⇒ 「带名字的」只应有 1 个。
        // 若把 label 移回 <Tabs> 根：这个数变成 0（外层 div 无 role，不算 tablist）⇒ 红。
        // 若两处都挂：这个数仍是 1，但上一用例的真实缺陷（tablist 名为空）已在上面被钉住。
        await expect(
            page.locator('[role="tablist"]'),
            "本页 tablist 总数（导航 + 页签）",
        ).toHaveCount(2);

        const named = page.locator('[role="tablist"][aria-label]');
        await expect(named, "带 aria-label 的 tablist 必须恰好 1 个（成员页页签）").toHaveCount(1);
        await expect(named.locator('[data-testid="members-tab-members"]')).toHaveCount(1);
    });

    test("深色主题下组名同样在（改位置不依赖配色）", async ({ page }) => {
        await setupMockAuth(page);
        await gotoMembers(page, true);
        await page.waitForFunction(
            () => document.documentElement.classList.contains("dark"),
            undefined,
            { timeout: EXPECT_TIMEOUT_MS },
        );
        const label = await page.locator(MEMBERS_TABLIST).getAttribute("aria-label");
        expect(label, "深色下组名不得因主题分支丢失").toBeTruthy();
    });
});
