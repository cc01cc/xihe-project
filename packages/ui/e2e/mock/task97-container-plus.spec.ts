// task-97（D-1754 ②）：容器页签行「+」新建/重开 —— 三条判据的读数骨架。
//
// **本文件在实现落地前必然红**：每条用例的第一条断言就是「+ 存在」，而产品路径今天两行都没有 +
// （组件 `WorkspaceContainerTabs.vue` 的 `#actions` 槽存在、但 main 行未传、right 行传的是
//  overflow/pin/focus/close 四件）。红 = 实现还没落地，不是回归；写窗开启后按 testid 填充即转绿。
//
// 判据原文（D-1754 ②，用户：「参考浏览器设计，就在标签页最右侧，但是不会被溢出挤掉或者消失」）：
//   a. 位置 = 页签行**最右端**（浏览器 tab strip 的 + 语义），不是页签流末尾
//   b. 溢出时 + **固定、不随滚动移动**（不与滚动容器同一滚动轴）
//   c. 任何页签数量（0 / 1 / 多 / 溢出）下 + **恒可见**，不得被 flex 挤压成 0 宽
//
// 两处口径已由 Lead 裁（2026-11-17）：
//   ① a 的「最右端」= **紧贴页签右侧、窗口控件（pin/focus/close）之前** —— 落在 close 右边是
//      落进窗口控制区，那是另一个语义区。right 行因此断言 `plus.right <= mode-toggle.x`。
//   ② b 改成「**溢出时 + 的 rect 不被页签覆盖、宽 > 0**」用 elementFromPoint 判：
//      今天两行都**没有滚动容器**（组件无 overflow-x；右栏溢出 = 固定上限 maxVisibleTabs:3 + 下拉），
//      「scrollLeft 变化后 + 不动」这条**取不到数**，不是判据不成立而是没有轴可测。
//
// 第三处口径（Lead 2026-11-17 更正；D-1792 同族）：`D-1754 ④` 判据 3 =「右栏是正常列，不得是浮窗/overlay」
// **成立，且正在落实**——task-94 S1 把 `deriveDockMode` 改成恒 pinned、删掉 pin/浮窗切换按钮，就是在执行它。
// 先前「判据 3 已被推翻」的转述是错的（方向说反了），后果会是把人引去做相反方向的改动。
// 纪律（D-1792）：**引用判据必须带「它在要求什么」**，不能只带编号加一句评价。
// 与本文件的关系：判据 a 只要求「+ 在窗口控件之前」，**不依赖 pin 按钮是否存在** ⇒ 断言取「控件族
// 存在者最小 x」，pin 退场当天不会假红（写死 `dock-mode-toggle` 会在退场当天变成找不到元素的假红）。
//
// 0 页签态的诚实处理：`+` 恒可见要求行在 0 页签时也渲染（D-1757 裁③ 只给 main 传 allowEmpty），
// 但该状态在产品路径是否可达尚未证实 ⇒ 用例先探针，不可达就 `test.skip` 并打印读数，
// **不写成「满足」**（D-1782：没测到的判据不能算通过）。
import { expect, test, type Page } from "@playwright/test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS } from "../timeouts";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const LAYOUT_KEY = "xihe-layout-ws:" + WORKSPACE_ID;
/** 四个会话夹具：多页签/溢出两态都靠它的 openTabs 累积。 */
const SESSIONS = ["task97-a", "task97-b", "task97-c", "task97-d"] as const;
/** 右栏「窗口控件族」候选 testid：pin 正在随浮窗退场，故用「存在者取最小 x」而不是写死一个。 */
const WINDOW_CONTROL_TESTIDS = ["dock-mode-toggle", "dock-focus-toggle", "workspace-aux-close"];

function log(tag: string, payload: Record<string, unknown>): void {
    console.log("[task97] " + tag + " " + JSON.stringify(payload));
}

function row(page: Page, container: "main" | "right") {
    return page.locator(`[data-testid="workspace-container-tabs"][data-container="${container}"]`);
}

/** 实现落地后的 testid 契约（本文件是它的第一消费者，改名要同批改这里）。 */
function plus(page: Page, container: "main" | "right") {
    return page.getByTestId(`workspace-container-plus-${container}`);
}

async function boot(page: Page): Promise<void> {
    await setupMockAuth(page, {});
    await setupMockSessions(page, {
        sessions: SESSIONS.map((id) => ({ id, title: id })),
    });
    await page.goto(`/workspace/${WORKSPACE_ID}/chat/${SESSIONS[0]}`);
    await page.locator('[data-testid="workspace-main"]').waitFor({
        state: "visible",
        timeout: EXPECT_TIMEOUT_MS,
    });
}

/** 挨个点亮右栏面板开关（`aria-pressed` 已是 true 就不再点，避免关掉）。 */
async function openDockPanels(page: Page, ids: readonly string[]): Promise<void> {
    for (const id of ids) {
        const toggle = page.getByTestId(`workspace-toolbar-${id}`);
        if ((await toggle.getAttribute("aria-pressed")) !== "true") {
            await toggle.click({ timeout: ACTION_TIMEOUT_MS });
        }
    }
    await expect(page.getByTestId("workspace-aux-panel")).toBeVisible({
        timeout: EXPECT_TIMEOUT_MS,
    });
}

interface PlusGeometry {
    plusX: number;
    plusRight: number;
    plusWidth: number;
    lastTabRight: number;
    rowRight: number;
}

/** 量「+ 与页签行右端/最后一个页签」的几何关系；+ 尚未落地时返回 null。 */
async function measurePlus(page: Page, container: "main" | "right"): Promise<PlusGeometry | null> {
    const button = plus(page, container);
    if ((await button.count()) === 0) return null;
    return button.evaluate((el, tabsSel) => {
        const nav = el.closest('[data-testid="workspace-container-tabs"]')!;
        const all = nav.querySelectorAll(tabsSel);
        const last = all[all.length - 1];
        const plusBox = el.getBoundingClientRect();
        return {
            plusX: plusBox.x,
            plusRight: plusBox.right,
            plusWidth: plusBox.width,
            lastTabRight: last ? last.getBoundingClientRect().right : Number.NaN,
            rowRight: nav.getBoundingClientRect().right,
        };
    }, '[role="tab"]');
}

/** 溢出态非空前提：+ 至少 1px 落在页签行的可见区里（否则下面的断言会在「行塌了」时空过）。 */
async function isHitByPlus(page: Page, container: "main" | "right"): Promise<boolean> {
    const button = plus(page, container);
    return button.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return !!target && (target === el || el.contains(target));
    });
}

test.describe("task-97 容器页签行「+」（D-1754 ②）", () => {
    test("判据 a：main 行 + 紧贴页签右侧；right 行 + 在 pin/focus/close 之前", async ({ page }) => {
        await boot(page);
        await openDockPanels(page, ["code"]);

        const mainRow = row(page, "main");
        await expect(mainRow, "main 行存在（非空前提）").toBeVisible();
        await expect
            .poll(async () => mainRow.locator('[role="tab"]').count(), {
                timeout: EXPECT_TIMEOUT_MS,
            })
            .toBeGreaterThan(0);

        // ↓ 实现落地前，红从这一条开始（+ 不存在）。
        await expect(plus(page, "main"), "main 行必须有 +（D-1754 ②）").toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(plus(page, "right"), "right 行必须有 +（D-1754 ②）").toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });

        const mainGeometry = await measurePlus(page, "main");
        const rightGeometry = await measurePlus(page, "right");
        // 窗口控件族的左边界：取**存在**控件的最小 x。
        // 为什么不是一个固定 testid：pin/浮窗切换（`dock-mode-toggle`）正随浮窗退场被删
        // （task-94 S1），固定写死它会让本判据在退场当天变成「找不到元素」的假红。
        const windowControls = await page.evaluate((ids: string[]) => {
            const found = ids
                .map((id) => document.querySelector(`[data-testid="${id}"]`))
                .filter((el): el is HTMLElement => el !== null)
                .map((el) => ({ id: el.dataset.testid!, x: el.getBoundingClientRect().x }));
            return {
                ids: found.map((item) => item.id),
                minX: found.length > 0 ? Math.min(...found.map((item) => item.x)) : null,
            };
        }, WINDOW_CONTROL_TESTIDS);
        log("judgeA", { mainGeometry, rightGeometry, windowControls });

        expect(mainGeometry, "main 行几何可量").not.toBeNull();
        expect(rightGeometry, "right 行几何可量").not.toBeNull();
        // a：+ 在页签流的右边（紧贴最后一个页签），而不是插在页签流末尾里。
        expect(
            mainGeometry!.plusX,
            "main：+ 的左边界不早于最后一个页签的右边界",
        ).toBeGreaterThanOrEqual(mainGeometry!.lastTabRight - 1);
        expect(rightGeometry!.plusX, "right：同上").toBeGreaterThanOrEqual(
            rightGeometry!.lastTabRight - 1,
        );
        // a 的子裁定：+ 必须在窗口控件之前（落在 close 右边 = 落进窗口控制区）。
        expect(
            windowControls.minX,
            "非空前提：right 行必须有窗口控件（focus/close 至少一个）",
        ).not.toBeNull();
        expect(
            rightGeometry!.plusRight,
            "right：+ 的右边界不越过窗口控件族最左项（focus/close 属窗口控制区）",
        ).toBeLessThanOrEqual(windowControls.minX! + 1);
        // 两行都不得越出页签行。
        expect(mainGeometry!.plusRight, "main：+ 不越出页签行右端").toBeLessThanOrEqual(
            mainGeometry!.rowRight + 1,
        );
        expect(rightGeometry!.plusRight, "right：+ 不越出页签行右端").toBeLessThanOrEqual(
            rightGeometry!.rowRight + 1,
        );
    });

    test("判据 b（改判后）：溢出态 + 的 rect 不被页签覆盖、宽 > 0", async ({ page }) => {
        await boot(page);
        // 4 个面板 > maxVisibleTabs(3) ⇒ 右栏进入溢出态（下拉触发器出现 = 非空前提）。
        await openDockPanels(page, ["code", "changes", "monitor", "members"]);
        await expect(
            page.getByTestId("dock-overflow-trigger"),
            "非空前提：右栏必须真的进入溢出态（否则本用例测的是常态）",
        ).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });

        const tablist = row(page, "right").locator('[role="tablist"]').first();
        const overflowReading =
            (await tablist.count()) === 0
                ? null
                : await tablist.evaluate((el) => ({
                      overflowX: getComputedStyle(el).overflowX,
                      scrollWidth: el.scrollWidth,
                      clientWidth: el.clientWidth,
                  }));
        log("judgeB", {
            overflowReading,
            overflowTrigger: await page.getByTestId("dock-overflow-trigger").count(),
        });

        const button = plus(page, "right");
        await expect(button, "溢出态下 right 行必须有 +（被挤掉 = 红）").toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        const width = await button.evaluate((el) => el.getBoundingClientRect().width);
        expect(width, "溢出态下 + 不得被挤压成 0 宽").toBeGreaterThan(0);
        // 轮询而非一次性取数：溢出态下布局会随面板注入再稳一次。
        await expect
            .poll(async () => isHitByPlus(page, "right"), {
                timeout: EXPECT_TIMEOUT_MS,
            })
            .toBe(true);
    });

    test("判据 c-单/多：1 与 3 个页签下 + 恒可见、命中盒 ≥24px", async ({ page }) => {
        await boot(page);
        const mainRow = row(page, "main");
        await expect(mainRow).toBeVisible();
        const singleTabs = await mainRow.locator('[role="tab"]').count();
        log("judgeC1", { tabs: singleTabs });
        expect(singleTabs, "非空前提：单页签态确实只有 1 个页签").toBe(1);
        await expect(plus(page, "main"), "单页签下 + 存在").toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });

        // 再进两个会话 ⇒ openTabs 累积成多页签（同一个 workspace 键）。
        for (const id of SESSIONS.slice(1, 3)) {
            await page.goto(`/workspace/${WORKSPACE_ID}/chat/${id}`);
            await page.locator('[data-testid="workspace-main"]').waitFor({
                state: "visible",
                timeout: EXPECT_TIMEOUT_MS,
            });
        }
        await expect
            .poll(async () => mainRow.locator('[role="tab"]').count(), {
                timeout: EXPECT_TIMEOUT_MS,
            })
            .toBeGreaterThanOrEqual(3);
        const multi = await plus(page, "main").evaluate((el) => {
            const box = el.getBoundingClientRect();
            return { width: box.width, height: box.height };
        });
        log("judgeC2", { multi });
        // WCAG 2.2 SC 2.5.8 的 24px 是仓内既有命中盒口径（close 按钮 24.5px）。
        expect(multi.width, "多页签下 + 命中盒 ≥24px（不被挤压）").toBeGreaterThanOrEqual(24);
        await expect(plus(page, "main"), "多页签下 + 仍可见").toBeVisible();
    });

    test("判据 c-零：0 页签态下行在、+ 恒可见（2026-11-17 实测可达）", async ({ page }) => {
        await setupMockAuth(page, {});
        await setupMockSessions(page, {
            sessions: [{ id: SESSIONS[0], title: SESSIONS[0] }],
        });
        // 真 0 态探针：直接落裸工作区入口，并清掉本 context 的布局持久化键 ——
        // 不然任何先导航过会话的足迹都会残留在 openTabs 里，量到的不是 0 态。
        await page.goto(`/workspace/${WORKSPACE_ID}`);
        await page.evaluate((key) => localStorage.removeItem(key), LAYOUT_KEY);
        await page.goto(`/workspace/${WORKSPACE_ID}`);
        await page.locator('[data-testid="workspace-main"]').waitFor({
            state: "visible",
            timeout: EXPECT_TIMEOUT_MS,
        });
        const tabs = await row(page, "main").locator('[role="tab"]').count();
        log("judgeC0", { mainTabs: tabs });
        test.skip(
            tabs > 0,
            `0 页签态当前不可达（实测 main 行 ${tabs} 个页签）⇒ 本条判据未实测，不写「满足」`,
        );
        // 可达时才走到这里：行必须在（allowEmpty，D-1757 裁③ 只给 main），+ 必须可见。
        await expect(row(page, "main"), "0 页签时 main 行仍须渲染（allowEmpty）").toBeVisible();
        await expect(plus(page, "main"), "0 页签时 + 恒可见").toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
    });

    test("行为：点击 = 打开新面板（main → 新建会话流；right → 重开页签出现）", async ({ page }) => {
        await boot(page);
        await openDockPanels(page, ["code"]);

        // main 行 +：**task-140（D-1907 rev7）起是组件选择器**，不再是 ?newChat=1。
        // 判据：点击弹出菜单 → 菜单里是组件项（含「会话设置」，G-11）→ Esc 关闭不改布局。
        // 不在这里点开面板：下面几段按固定布局读数（files/monitor/code），改布局会让后续
        // 计数断言变成顺序相关的脆断言。
        await plus(page, "main").click({ timeout: ACTION_TIMEOUT_MS });
        const mainMenu = page.getByTestId("workspace-container-add-menu-main");
        await expect(mainMenu, "main + 应弹出组件选择器（D-1907 rev7）").toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(
            mainMenu.getByTestId("workspace-add-item-context"),
            "选择器里应有「会话设置」组件项（G-11）",
        ).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await page.keyboard.press("Escape");
        await expect(mainMenu, "Esc 关闭选择器").toBeHidden({ timeout: EXPECT_TIMEOUT_MS });

        // right 行 +：菜单列出未打开面板，点击后页签真实出现（自包含，不依赖 API）。
        await page.goto(`/workspace/${WORKSPACE_ID}/chat/${SESSIONS[0]}`);
        await page
            .locator('[data-testid="workspace-main"]')
            .waitFor({ state: "visible", timeout: EXPECT_TIMEOUT_MS });
        await openDockPanels(page, ["code"]);
        await plus(page, "right").click({ timeout: ACTION_TIMEOUT_MS });
        await expect(page.getByTestId("dock-reopen-menu"), "+ 菜单打开").toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        // 注：mock 默认布局已开 files+monitor（closedDockTabs 正确排除已开面板），
        // 故选 changes 做重开对象。
        await page.getByTestId("dock-reopen-item-changes").click({ timeout: ACTION_TIMEOUT_MS });
        // 4 页签 > maxVisibleTabs(3) ⇒ 重开的 changes 追加到 dockTabs 末尾、落进溢出桶：
        // 读数 = 溢出触发器出现且徽标为 1，打开溢出菜单后 changes 项可见。
        // （不钉「可见页签位」：追加顺序决定它先落在溢出桶，钉顺序相关断言是脆的。）
        const overflowTrigger = page.getByTestId("dock-overflow-trigger");
        await expect(overflowTrigger, "重开后溢出触发器出现（第 4 页签进溢出桶）").toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        expect((await overflowTrigger.innerText()).trim(), "溢出徽标 = 1").toBe("1");
        await overflowTrigger.click({ timeout: ACTION_TIMEOUT_MS });
        await expect(
            page.getByTestId("dock-overflow-item-changes"),
            "溢出菜单里 changes 项可见",
        ).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
    });
});
