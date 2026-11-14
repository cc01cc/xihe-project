import type { Page } from "@playwright/test";
// 走 mock 车道的公共失败门禁（BL-318）：console error / pageerror / 非预期 >=400 自动断言。
import { expect, test } from "./helpers/mock-test";

/**
 * task-33（用户截图报障）：组织树层级缩进的**文字起点**判据。
 *
 * <p>为什么这条断言必须放在真浏览器、不能放进 jsdom 单测：</p>
 * <ul>
 * <li>缩进实现是 `padding-left`，它在盒**内部** ⇒ `label.getBoundingClientRect().left`
 *     三行**完全相同**（实测 464 / 464 / 464）。按盒左缘写断言，**修好之前也是绿的** ——
 *     那是假绿判据，比没有判据更糟（它让人以为已经被守住了）。</li>
 * <li>只有把"文字起点"量出来（DOM `Range`）才能证明**文字真的移动了**。
 *     而 jsdom 的 `Range` **没有** `getBoundingClientRect`（`[实测]` `TypeError: … is not a function`
 *     ——不是返回 0），所以这条断言没有第二次机会，只能放真浏览器。</li>
 * </ul>
 *
 * <p>夹具来自 mock 车道自己的 org-units 数据（`preview/mock/data/orgUnits.ts`）：
 * 研发部(0) → 平台组(1) → 存储组(2)，数据部(0) → 分析组(1)。</p>
 */

const BASE_LABEL = '[data-testid="org-tree-toggle-ou-rd"]';

/** 展开三档深度所需的点击（按依赖顺序）。 */
async function expandThreeLevels(page: Page) {
    await page.locator('[data-testid="org-tree-toggle-ou-data"]').click();
    await page.waitForSelector('[data-testid="org-tree-label-ou-analytics"]');
    await page.locator('[data-testid="org-tree-toggle-ou-rd"]').click();
    await page.waitForSelector('[data-testid="org-tree-label-ou-platform"]');
    await page.locator('[data-testid="org-tree-toggle-ou-platform"]').click();
    await page.waitForSelector('[data-testid="org-tree-label-ou-storage"]');
}

type RowReading = { key: string; boxLeft: number; textLeft: number; paddingLeft: string };

/** 读一行：**盒左缘**与**文字起点**分开量（两者不是一回事，见头注释）。 */
async function readRow(page: Page, key: string): Promise<RowReading> {
    return page.evaluate((rowKey) => {
        const label = document.querySelector(`[data-testid="org-tree-label-${rowKey}"]`);
        if (!(label instanceof HTMLElement)) throw new Error(`缺少行 ${rowKey}`);
        const box = label.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(label);
        const textRect = range.getBoundingClientRect();
        return {
            key: rowKey,
            boxLeft: Math.round(box.left * 100) / 100,
            textLeft: Math.round(textRect.left * 100) / 100,
            paddingLeft: getComputedStyle(label).paddingLeft,
        };
    }, key);
}

/**
 * 只种登录态，**不调用 `setupMockAuth`** —— 这条是本 spec 能跑通的前提，理由值得单独记：
 *
 * <p>`setupMockAuth` 挂了一条覆盖 `/api/v1/` 前缀的通配路由兜底（`helpers/auth.ts:487`），
 * 未桩的端点一律回 **`200 {}`**。于是 `GET /api/v1/org-units` 拿到的是空对象而不是数值数组
 * ⇒ 组织树为空 ⇒ 本 spec 的 `waitForSelector('[data-testid=org-tree-toggle-ou-rd]')` 只能等到
 * 30 s 超时（`[实测]` 三条用例全部红在 `beforeEach`）。</p>
 *
 * <p><b>空对象比 404 更难查</b>：页面不报错、只是"数据看起来是空的"，断言红在"元素不存在"上，
 * 排查会被引向产品代码。正因如此，本 spec **不经过那条兜底**：只种 localStorage 让请求真的打到
 * dev mock server（`preview/mock/api-server.ts` 有 `/org-units` 真数据），数据面由它负责。</p>
 *
 * <p><b>与夹具口径无关</b>：即便将来 `task-64` 把兜底改成"404 + 明确 body"（保留 `permissive`
 * 开关），本 spec 也不会受影响 —— 它压根不注册那条 blanket。若某天确实需要 `setupMockAuth`
 * （例如要会话投影夹具），**必须在本 spec 之后再给 `/org-units` 注册自己的 route**：
 * Playwright 的 route 是 **LIFO**（后注册的优先匹配），顺序写反就会被 `200 {}` 吃掉。</p>
 */
async function seedMockAuth(page: Page) {
    // 键与 `helpers/auth.ts:258-274` 同源（token / user），只是不装任何 route。
    await page.addInitScript(() => {
        localStorage.setItem("xihe-token", "mock-token");
        localStorage.setItem(
            "xihe-user",
            JSON.stringify({ id: "user-1", email: "test@xihe.local", name: "Test User" }),
        );
    });
}

test.describe("task-33 组织树层级缩进（真浏览器）", () => {
    test.beforeEach(async ({ page }) => {
        await seedMockAuth(page);
        await page.goto("/members");
        await page.waitForSelector(BASE_LABEL);
    });

    test("文字起点相邻差 = 16；且盒左缘三行相同（盒左缘不能当判据）", async ({ page }) => {
        await expandThreeLevels(page);

        const depth0 = await readRow(page, "ou-rd");
        const depth1 = await readRow(page, "ou-analytics");
        const depth2 = await readRow(page, "ou-storage");

        // ① 盒左缘三行相同 —— 这一条**钉住**"盒左缘不是判据"这个事实：
        //    若有人把缩进从 padding 改成 margin/包容器，盒左缘就会开始变，此时这条会红，
        //    提醒改判据的人"你换实现方式了，Range 断言也要跟着复核"。
        expect([depth0.boxLeft, depth1.boxLeft, depth2.boxLeft]).toEqual([
            depth0.boxLeft,
            depth0.boxLeft,
            depth0.boxLeft,
        ]);
        // ② 文字起点：基准 8 + 深度 × 16（见 OrgUnitTreePanel 的 INDENT_BASE / INDENT_STEP）。
        expect(depth1.textLeft - depth0.textLeft).toBe(16);
        expect(depth2.textLeft - depth1.textLeft).toBe(16);
        // ③ 绝对差值也对上：8 / 24 / 40 的 padding 落在文字起点上。
        expect([depth0.paddingLeft, depth1.paddingLeft, depth2.paddingLeft]).toEqual([
            "8px",
            "24px",
            "40px",
        ]);
    });

    test("aria-level = 1 / 2 / 3（reka 由 level 派生，页面只钉不覆盖）", async ({ page }) => {
        await expandThreeLevels(page);

        for (const [key, expected] of [
            ["ou-rd", "1"],
            ["ou-analytics", "2"],
            ["ou-storage", "3"],
        ] as const) {
            const node = page.locator(`[data-testid="org-tree-node-${key}"]`);
            await expect(node).toHaveCount(1);
            await expect(node).toHaveAttribute("aria-level", expected);
        }
    });

    test("org-tree-node-* 真的进了 DOM（vendor TreeItem 的 $attrs 出口）", async ({ page }) => {
        // 旧账：模板里写了 `:data-testid="'org-tree-node-' + key"`，但 vendor `TreeItem`
        // 声明 `inheritAttrs: false` 且只传声明 props ⇒ `$attrs` 被静默丢弃，这个 testid
        // 从来没进过 DOM，也没人断言过。这条用例是它复活的**唯一**守护。
        for (const key of ["ou-rd", "ou-data"]) {
            await expect(page.locator(`[data-testid="org-tree-node-${key}"]`)).toHaveCount(1);
        }
    });
});
