// timeout-exempt: long E2E step(s) reviewed in task-152 (LONG_TIMEOUT_MS, default 30 s)
import type { Page } from "@playwright/test";
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS, LONG_TIMEOUT_MS } from "../timeouts";

/**
 * task-152 / `D-1221` ④：**独立会话（L3）可排序** —— 真实浏览器判据。
 *
 * <p>夹具事实（决定判据怎么写）：独立会话区**今天没有时间桶** —— 快照模式下
 * `timeGroups` 返回单个 `foreign` 桶且无标签（`SessionList.vue`），渲染是「一段平铺列表」。
 * 所以「桶内排序」在这里退化为「整段内」，跨桶不可达**自动成立**；真正要钉的是
 * 「**全侧栏只有独立会话区一个 droppable**」（判据 2 的采纳版，取代原「桶外没有 droppable」
 * —— 在 0 个桶外区域时那是空断言，会假绿）。</p>
 *
 * <p>判据：① 拖拽改序后刷新仍保持（判据 3）；② `Alt+↓` 键盘等价 + `aria-live` 播报；
 * ③ 只有独立会话区挂 droppable（工作区分组 0 个）；④ 搜索态不挂（否则会把不可见的行
 * 从顺序里抹掉）。</p>
 */
const WS_ID = "11111111-1111-4111-8111-111111111111";
const WS_SESSION = "22222222-2222-4222-8222-222222222222";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const GLOBAL_KEY = "xihe-layout-global";

async function stubWorkspaces(page: Page) {
    await page.route(
        (url) => url.pathname === "/api/v1/workspaces",
        async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify([
                    { id: WS_ID, name: "Workspace 1", workspaceRole: "WS_OWNER" },
                ]),
            });
        },
    );
}

/** 装配：一个工作区会话 + 三个独立会话（顺序 = 夹具顺序，三个 `updatedAt` 同值）。 */
async function seed(page: Page) {
    await setupMockAuth(page);
    await stubWorkspaces(page);
    await setupMockSessions(page, {
        sessions: [{ id: WS_SESSION, title: "工作区会话" }],
        workspacelessSessions: [
            { id: A, title: "独立会话甲" },
            { id: B, title: "独立会话乙" },
            { id: C, title: "独立会话丙" },
        ],
    });
    await page.goto("/workspace/" + WS_ID + "/session/" + WS_SESSION);
    await expect(page.getByTestId("sidebar-standalone-group")).toBeVisible({
        timeout: EXPECT_TIMEOUT_MS,
    });
}

/** 独立会话区当前的**渲染**顺序（拖拽单元上的 data-session-id）。 */
async function standaloneIds(page: Page): Promise<string[]> {
    return page
        .locator('[data-testid="sidebar-standalone-group"] [data-session-id]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-session-id") ?? ""));
}

/**
 * 鼠标拖拽（Sortable 走 mousedown/mousemove，不是 HTML5 DnD ⇒ 不能用 `dragTo`）。
 * 分步移动是必须的：一步到位时 Sortable 的落点计算常常还没启动。
 */
async function dragRowOnto(page: Page, fromId: string, toId: string) {
    const from = page.locator(`[data-session-id="${fromId}"]`);
    const to = page.locator(`[data-session-id="${toId}"]`);
    const fromBox = await from.boundingBox();
    const toBox = await to.boundingBox();
    if (!fromBox || !toBox) throw new Error("拖拽源/目标不可见，夹具或滚动位置有问题");
    const startX = fromBox.x + fromBox.width / 2;
    const startY = fromBox.y + fromBox.height / 2;
    const endY = toBox.y + toBox.height - 2; // 落到目标行下半部分 ⇒ 插到它后面
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX, startY + 8, { steps: 6 });
    await page.mouse.move(startX, endY, { steps: 18 });
    await page.mouse.up();
}

test.describe("独立会话可排序（task-152 / D-1221 ④）", () => {
    test("拖拽改序 ⇒ 刷新后仍保持（判据 3）", async ({ page }) => {
        await seed(page);
        expect(await standaloneIds(page)).toEqual([A, B, C]);

        await dragRowOnto(page, A, C);
        // 判据是「顺序真的变了 + 变了之后能被持久化」，不是「恰好落到第 N 位」——
        // 后者取决于落点插值（Sortable 在目标行上半/下半的判定），是拖拽机制的细节，
        // 拿它当产品判据会让用例在与真实改动无关的时候红。
        await expect
            .poll(() => standaloneIds(page), { timeout: LONG_TIMEOUT_MS })
            .not.toEqual([A, B, C]);
        const afterDrag = await standaloneIds(page);
        expect(afterDrag).toHaveLength(3);
        expect(new Set(afterDrag)).toEqual(new Set([A, B, C]));

        // 落盘在既有的全局布局键里（不建第二把键），且存的就是刚才渲染的那个顺序。
        const stored = await page.evaluate((key) => localStorage.getItem(key), GLOBAL_KEY);
        expect(stored, "全局布局键必须被写出").toBeTruthy();
        expect(
            (JSON.parse(stored ?? "{}") as { standaloneSessionOrder?: string[] })
                .standaloneSessionOrder,
        ).toEqual(afterDrag);

        // 判据 3 的核心：刷新后**仍是**那个顺序（顺序存组件里就会在这里丢）。
        await page.reload();
        await expect(page.getByTestId("sidebar-standalone-group")).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect
            .poll(() => standaloneIds(page), { timeout: LONG_TIMEOUT_MS })
            .toEqual(afterDrag);
    });

    test("键盘等价：Alt+↓ 移动一位并播报，刷新后保持", async ({ page }) => {
        await seed(page);
        const rowA = page.locator(`[data-session-id="${A}"] [data-testid="session-item"]`);
        await rowA.focus();
        await page.keyboard.press("Alt+ArrowDown", { delay: 20 });

        await expect
            .poll(() => standaloneIds(page), { timeout: LONG_TIMEOUT_MS })
            .toEqual([B, A, C]);
        await expect(page.getByTestId("sidebar-session-order-status")).toHaveText("已移到第 2 位", {
            timeout: EXPECT_TIMEOUT_MS,
        });
        // 焦点随行移动（否则连续按会打到别的行）
        await expect(
            page.locator(`[data-session-id="${A}"] [data-testid="session-item"]`),
        ).toBeFocused({
            timeout: EXPECT_TIMEOUT_MS,
        });

        await page.reload();
        await expect(page.getByTestId("sidebar-standalone-group")).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect
            .poll(() => standaloneIds(page), { timeout: LONG_TIMEOUT_MS })
            .toEqual([B, A, C]);
    });

    test("全侧栏只有独立会话区一个 droppable（判据 2 采纳版）", async ({ page }) => {
        await seed(page);
        await expect(
            page.locator('[data-testid="sidebar-standalone-group"] [data-session-id]'),
        ).toHaveCount(3, { timeout: EXPECT_TIMEOUT_MS });
        // 工作区分组的会话行**不得**被包成拖拽单元（L2 属 task-153，越界即违规）。
        await expect(
            page.locator('[data-testid^="sidebar-workspace-group-"] [data-session-id]'),
        ).toHaveCount(0);
    });

    test("搜索态不挂 droppable（过滤后的子集不参与排序）", async ({ page }) => {
        await seed(page);
        await page.getByPlaceholder("搜索会话...").fill("甲", { timeout: ACTION_TIMEOUT_MS });
        // 行还在（说明是"不挂排序"而不是"搜没了"），但拖拽单元消失。
        await expect(page.getByText("独立会话甲")).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await expect(
            page.locator('[data-testid="sidebar-standalone-group"] [data-session-id]'),
        ).toHaveCount(0);
    });
});
