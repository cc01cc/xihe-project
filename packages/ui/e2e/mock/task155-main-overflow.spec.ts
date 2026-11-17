// task-155（P2）：主栏页签行溢出策略 —— 与右栏同形态（上限 + 下拉）。
//
// 卡面三步判据：
//   ① 先造出溢出态（造不出写未实测）——本文件首条用例就是造态探针 + 改前读数；
//   ② 策略与右栏同形态（maxVisibleTabs 上限 + 下拉菜单，照 WorkspaceDock 的既有形态）；
//   ③ 溢出时「+」rect 不被页签覆盖、宽 > 0、页签全部可达。
//
// timeout-exempt: 判据需要 12 个真实会话页签（逐跳 goto + 等 workspace-main readiness 累积，
// 单用例步数 >10 s 预算）；溢出读数不接受用 DOM 注入伪造页签替代（非空前提纪律）。
//
// 写窗 fence（Lead 2026-11-17）：write 面 = WorkspaceContainerTabs.vue + 其 spec + 本 spec；
// 优先组件级实现（maxVisibleTabs prop）；必须动 Workbench.vue / useWorkspaceLayout.ts 时先报 Lead。
//
// 改前现状（task-97 分析，本探针实测复核）：主栏行**没有任何溢出策略** —— TabsList 是
// `inline-flex w-fit`（components/ui/tabs/index.ts:12-24），Tabs 盒 `min-w-0 flex-1` 但无
// overflow 裁剪 ⇒ 页签多时视觉上**溢出盖进行尾 actions 区**（task-97 的「+」被覆盖的风险面）。
import { expect, test, type Page } from "@playwright/test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS } from "../timeouts";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
/** 12 个会话：按 ~150px/页签 × ~1200px 行宽估算，10 个即溢出；多备两个余量。 */
const SESSIONS = Array.from({ length: 12 }, (_, i) => "task155-s" + String(i + 1).padStart(2, "0"));

function log(tag: string, payload: object): void {
    console.log("[task155] " + tag + " " + JSON.stringify(payload));
}

function mainRow(page: Page) {
    return page.locator('[data-testid="workspace-container-tabs"][data-container="main"]');
}

async function boot(page: Page): Promise<void> {
    await setupMockAuth(page, {});
    await setupMockSessions(page, {
        sessions: SESSIONS.map((id) => ({ id, title: id })),
    });
}

/** 逐个点开全部会话 ⇒ openTabs 累积成多页签（同一 workspace 布局键）。 */
async function openAllSessions(page: Page): Promise<void> {
    for (const id of SESSIONS) {
        await page.goto(`/workspace/${WORKSPACE_ID}/chat/${id}`);
        await page.locator('[data-testid="workspace-main"]').waitFor({
            state: "visible",
            timeout: EXPECT_TIMEOUT_MS,
        });
    }
}

interface OverflowReading {
    tabCount: number;
    tablistScrollWidth: number;
    tablistClientWidth: number;
    tablistOverflowX: string;
    /** 行（nav）自身的右边界 —— 溢出判定的对照基准。 */
    navRight: number;
    /** 最后一个页签中心是否还能被指针命中（被裁剪/被覆盖 = false）。 */
    lastTabHittable: boolean;
    lastTabRight: number;
    /** 行尾「+」中心命中的是不是它自己（被溢出的页签盖住 = false）。 */
    plusHittable: boolean;
    plusWidth: number;
}

async function measure(page: Page): Promise<OverflowReading> {
    return page.evaluate(() => {
        const nav = document.querySelector(
            '[data-testid="workspace-container-tabs"][data-container="main"]',
        );
        if (!nav) {
            throw new Error("main 行不存在");
        }
        const tablist = nav.querySelector('[role="tablist"]');
        const tabs = Array.from(nav.querySelectorAll('[role="tab"]'));
        const last = tabs[tabs.length - 1];
        const plus = nav.querySelector('[data-testid="workspace-container-plus-main"]');
        const hit = (el: Element | null): boolean => {
            if (!el) return false;
            const box = el.getBoundingClientRect();
            const target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
            return !!target && (target === el || el.contains(target));
        };
        return {
            tabCount: tabs.length,
            tablistScrollWidth: tablist?.scrollWidth ?? -1,
            tablistClientWidth: tablist?.clientWidth ?? -1,
            tablistOverflowX: tablist ? getComputedStyle(tablist).overflowX : "none",
            navRight: nav.getBoundingClientRect().right,
            lastTabHittable: hit(last),
            lastTabRight: last ? last.getBoundingClientRect().right : Number.NaN,
            plusHittable: hit(plus),
            plusWidth: plus ? plus.getBoundingClientRect().width : 0,
        };
    });
}

test.describe("task-155 主栏页签行溢出策略", () => {
    test("① 造态读数：12 页签下上限 8 生效（改前缺陷读数 2026-11-17 21:26 在案）", async ({
        page,
    }) => {
        await page.setViewportSize({ width: 1920, height: 1080 });
        await boot(page);
        await openAllSessions(page);
        // 非空前提：12 个会话真accumulated（8 可见 + 4 溢出 = 12 全量在 ③ 判）。
        await expect
            .poll(async () => mainRow(page).locator('[role="tab"]').count(), {
                timeout: EXPECT_TIMEOUT_MS,
            })
            .toBe(8);
        const reading = await measure(page);
        log("probe-after", reading);
        // 改前缺陷读数（同日 21:26，先于修复实测）：plusHittable:false、
        // lastTabHittable:false、lastTabRight:2025.9 > navRight:1550（溢出视口，页签不可达）。
        // 修复后该断言按设计翻转 ⇒ 缺陷断言退役，翻转后的不变量由 ③ 判（真浏览器读数）。
        expect(reading.lastTabRight, "修复后末可见页签不再越出行边界").toBeLessThanOrEqual(
            reading.navRight + 1,
        );
    });

    test("② 策略与右栏同形态：上限 8 + 计数触发器 + 下拉列出溢出页签", async ({ page }) => {
        await page.setViewportSize({ width: 1920, height: 1080 });
        await boot(page);
        await openAllSessions(page);
        // 非空前提：溢出真实存在（12 页签 > 上限 8），不靠「组件渲染了触发器」自证。
        await expect(mainRow(page).locator('[role="tab"]')).toHaveCount(8, {
            timeout: EXPECT_TIMEOUT_MS,
        });
        const trigger = page.getByTestId("workspace-container-overflow-main");
        await expect(trigger, "溢出触发器可见（照右栏形态）").toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        expect((await trigger.innerText()).trim(), "触发器计数 = 溢出数 4").toBe("4");
        await trigger.click({ timeout: ACTION_TIMEOUT_MS });
        const items = page.locator('[data-testid^="workspace-container-overflow-main-item-"]');
        await expect(items).toHaveCount(4, { timeout: EXPECT_TIMEOUT_MS });
        // 溢出的是最后 4 个（切分保序：前 8 可见，s09–s12 入下拉）。
        for (let i = 9; i <= 12; i++) {
            const id = "session:task155-s" + String(i).padStart(2, "0");
            await expect(
                page.getByTestId("workspace-container-overflow-main-item-" + id),
            ).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        }
        log("judge2", { visible: 8, overflow: 4, form: "cap+count+dropdown（同右栏）" });
    });

    test("③ 溢出时 + 不被覆盖、宽 > 0、页签全部可达", async ({ page }) => {
        await page.setViewportSize({ width: 1920, height: 1080 });
        await boot(page);
        await openAllSessions(page);
        const trigger = page.getByTestId("workspace-container-overflow-main");
        await expect(trigger, "非空前提：溢出态成立").toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });

        const reading = await measure(page);
        log("judge3", reading);
        expect(reading.plusHittable, "溢出态「+」中心命中自身（不被页签覆盖）").toBe(true);
        expect(reading.plusWidth, "溢出态「+」宽 > 0").toBeGreaterThan(0);
        expect(reading.lastTabRight, "溢出被兜住：末可见页签不再越出行边界").toBeLessThanOrEqual(
            reading.navRight + 1,
        );

        // 可达性：可见页签（data-tab-id）∪ 下拉项 = 12 个全量，一个不缺。
        await trigger.click({ timeout: ACTION_TIMEOUT_MS });
        const union = await page.evaluate(() => {
            const nav = document.querySelector(
                '[data-testid="workspace-container-tabs"][data-container="main"]',
            );
            const visible = Array.from(nav?.querySelectorAll("[data-tab-id]") ?? []).map((el) =>
                el.getAttribute("data-tab-id"),
            );
            const overflowItems = Array.from(
                document.querySelectorAll(
                    '[data-testid^="workspace-container-overflow-main-item-"]',
                ),
            ).map((el) =>
                el
                    .getAttribute("data-testid")
                    ?.replace("workspace-container-overflow-main-item-", ""),
            );
            return {
                visible: visible.length,
                overflow: overflowItems.length,
                union: new Set([...visible, ...overflowItems]).size,
            };
        });
        log("judge3-reachable", union);
        expect(union.union, "可见 ∪ 溢出 = 12 个页签全部可达").toBe(SESSIONS.length);

        // 指针可达闭环：点溢出项 ⇒ 真实导航到该会话（不是只画了菜单）。
        await page
            .getByTestId("workspace-container-overflow-main-item-session:task155-s12")
            .click({ timeout: ACTION_TIMEOUT_MS });
        await expect(page).toHaveURL(/\/chat\/task155-s12$/, { timeout: EXPECT_TIMEOUT_MS });
    });
});
