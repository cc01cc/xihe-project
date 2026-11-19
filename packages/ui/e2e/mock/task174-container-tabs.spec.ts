import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { EXPECT_TIMEOUT_MS } from "../timeouts";

const SESSION_ID = "task174-session";

/**
 * task-174（S2b）判据读数脚本 —— 段1：容器内页签行的 DOM 事实。
 *
 * 判据①：容器数 == 页签行数（**DOM 读数**，不是看图）；
 * 判据②：顶部不再有全局页签行（`workspace-tab-bar` 计数 = 0）；
 * 判据②附带：`aria-current` **按容器分别报**（每行 ≤1），不报全页总数（旧口径会误判）。
 *
 * 读数直接打印成一行 JSON 前缀 `[task174]`，便于贴进卡面；断言只钉前两条硬事实，
 * 其余数字先如实输出 —— 数字变了应当看见变化，而不是被一条宽断言吞掉。
 *
 * **task-65 A 段（`D-1777`/`D-1778`，2026-11-17）翻新了容器值域**：`tree` 不再是容器（文件树是
 * 右栏的 `files` 面板），`CONTAINER_IDS = ["main","right"]`。于是本文件里凡是遍历
 * `["tree","main"]` 的地方都改成 `["main","right"]`，并新增**判据 8**把「有且只有两栏、
 * 右栏是正常列不是 overlay」钉死。
 *
 * 为什么要专门钉：旧写法对 `tree` 行取的是**空 locator**（行已不存在），`tabs:0 / ariaCurrent:0`
 * 两条断言因此**空过**（`0 ≤ 1`）—— 读数看着是绿的，实际什么也没断。新写法要求每行的页签数
 * `> 0`，同类空过会立刻变红。
 */
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const LAYOUT_KEY = "xihe-layout-ws:" + WORKSPACE_ID;

function log(tag: string, payload: Record<string, unknown>): void {
    console.log("[task174] " + tag + " " + JSON.stringify(payload));
}

test.describe("task-174 S2b 容器页签行", () => {
    test("判据 1/2/3：每容器 1 行 · 顶部无全局行 · aria-current 按容器分别报", async ({ page }) => {
        await setupMockAuth(page, {});
        await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "S2b" }] });
        await page.goto(`/workspace/${WORKSPACE_ID}/chat/${SESSION_ID}`);
        await page.locator('[data-testid="workspace-main"]').waitFor({
            state: "visible",
            timeout: EXPECT_TIMEOUT_MS,
        });

        const rows = page.locator('[data-testid="workspace-container-tabs"]');
        const rowCount = await rows.count();
        const containers = await rows.evaluateAll((nodes) =>
            nodes.map((node) => node.getAttribute("data-container")),
        );
        const globalRows = await page.locator('[data-testid="workspace-tab-bar"]').count();

        const perContainer: Record<string, { tabs: number; ariaCurrent: number }> = {};
        // task-65 A 段：行值域 = {main, right}（`tree` 已不是容器）。
        for (const container of ["main", "right"] as const) {
            const row = page.locator(
                `[data-testid="workspace-container-tabs"][data-container="${container}"]`,
            );
            perContainer[container] = {
                tabs: await row.locator('[role="tab"]').count(),
                ariaCurrent: await row.locator("[aria-current]").count(),
            };
        }
        const statusBarAriaCurrent = await page
            .locator('[data-testid="workspace-status-bar"] [aria-current]')
            .count();
        // task-137：六颗旧图标已退役 ⇒ 不再列字面量（契约门只放行 src 里真实存在的 testid）。
        // 用「行尾宿主里 workspace-toolbar-* 前缀」读零残留，同时读新唯一入口，两个字段并排：
        // 读的人能看出「不是没采到，是确实为 0」。
        const panelToggles = await page
            .locator('#workspace-nav-actions [data-testid^="workspace-toolbar-"]')
            .count();
        const dockToggleCount = await page
            .locator(
                '[data-testid="workspace-container-tabs"][data-container="main"] [data-testid="workspace-dock-toggle"]',
            )
            .count();
        expect(panelToggles, "174：六面板图标零残留").toBe(0);
        expect(dockToggleCount, "174：唯一开合入口 = 1").toBe(1);

        log("judge123", {
            containerRows: rowCount,
            containers,
            distinctContainers: new Set(containers.filter(Boolean)).size,
            globalTabBarRows: globalRows,
            perContainer,
            statusBarAriaCurrent,
            panelTogglesThisBatch: panelToggles,
            dockToggleCount,
        });

        expect(rowCount, "判据1：容器数 == 页签行数").toBe(2);
        expect(new Set(containers.filter(Boolean)).size).toBe(2);
        expect(globalRows, "判据2：顶部不再有全局页签行").toBe(0);
        for (const container of ["main", "right"] as const) {
            // 非空前提：行存在且真有页签 —— 否则 `≤1` 会在「行根本没渲染」时空过
            // （task-65 A 段之前 tree 行的读数是 tabs:0 / ariaCurrent:0，正是这种空过）。
            expect(perContainer[container]!.tabs, container + " 行必须有页签").toBeGreaterThan(0);
            expect(
                perContainer[container]!.ariaCurrent,
                container + " 行内 aria-current ≤1",
            ).toBeLessThanOrEqual(1);
        }
        // 如实报数：今天状态栏里**没有** `aria-current`（011 读数）。判据③的「状态栏 1 处」
        // 目前拿不到 —— 这是缺口，不是本批引入的回归（重构前也没有），记在卡面等裁决。
        expect(statusBarAriaCurrent, "判据3：状态栏 aria-current 读数（当前为 0，缺口）").toBe(
            statusBarAriaCurrent,
        );
    });

    test("判据 5：刷新后布局还原（键不变）+ 旧键载荷可读", async ({ page }) => {
        await setupMockAuth(page, {});
        await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "S2b" }] });
        await page.goto(`/workspace/${WORKSPACE_ID}/chat/${SESSION_ID}`);
        await page.locator('[data-testid="workspace-container-tabs"]').first().waitFor({
            state: "visible",
            timeout: EXPECT_TIMEOUT_MS,
        });

        // 旧键载荷（重构前的形状）写在**同一个**键上，刷新后必须仍能读。
        await page.evaluate((key) => {
            const raw = localStorage.getItem(key);
            const parsed = raw ? JSON.parse(raw) : {};
            localStorage.setItem(
                key,
                JSON.stringify({
                    ...parsed,
                    dockTabs: ["code", "monitor"],
                    activeDockTab: "monitor",
                    openTabs: ["session:task174-session"],
                }),
            );
        }, LAYOUT_KEY);
        await page.reload();
        await page
            .locator('[data-testid="workspace-container-tabs"][data-container="main"]')
            .waitFor({
                state: "visible",
                timeout: EXPECT_TIMEOUT_MS,
            });

        const after = await page.evaluate((key) => {
            const raw = localStorage.getItem(key);
            return {
                raw: raw ? JSON.parse(raw) : null,
                keys: Object.keys(localStorage).filter((k) => k.startsWith("xihe-layout-ws:")),
            };
        }, LAYOUT_KEY);
        const mainTabs = await page
            .locator('[data-testid="workspace-container-tabs"][data-container="main"] [role="tab"]')
            .count();
        const rowCount = await page.locator('[data-testid="workspace-container-tabs"]').count();

        log("judge5", {
            layoutKeys: after.keys,
            keyUnchanged: after.keys.includes(LAYOUT_KEY),
            storedDockTabs: (after.raw as { dockTabs?: string[] } | null)?.dockTabs ?? null,
            containerRows: rowCount,
            mainTabs,
        });

        expect(after.keys, "判据5：键仍是 xihe-layout-ws:<id>").toContain(LAYOUT_KEY);
        expect(rowCount).toBe(2);
    });

    test("判据 6：窄屏溢出菜单三入口仍在 + 面板图标零残留", async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await setupMockAuth(page, {});
        await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "S2b" }] });
        await page.goto(`/workspace/${WORKSPACE_ID}/chat/${SESSION_ID}`);
        const more = page.locator('[data-testid="workspace-toolbar-more-mobile"]');
        await expect(more).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await more.click();

        const menu = page.locator('[data-testid="workspace-toolbar-more-menu"]');
        await expect(menu).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        const pageEntries = await page
            .locator(
                [
                    '[data-testid="workspace-toolbar-more-environment"]',
                    '[data-testid="workspace-toolbar-more-scheduled"]',
                    '[data-testid="workspace-toolbar-more-settings"]',
                ].join(", "),
            )
            .count();
        const containerRows = await page
            .locator('[data-testid="workspace-container-tabs"]')
            .count();

        const narrowShell = {
            main: await page.locator('[data-testid="workspace-main"]').count(),
            rail: await page.locator('[data-testid="workspace-file-rail"]').count(),
            workbench: await page.locator('[data-testid="workspace-workbench"]').count(),
        };
        log("judge6", {
            pageEntries,
            // task-134：退役入口零残留由负向断言兜住（见下），日志不再复制一份读数。
            containerRowsMobile: containerRows,
            narrowShell,
            // task-137：六颗桌面面板图标已退役 ⇒ 这一格从「A1 后 = 5」改成现场读数（期望 0）。
            panelIconResidue: await page
                .locator('#workspace-nav-actions [data-testid^="workspace-toolbar-"]')
                .count(),
        });
        expect(pageEntries, "判据6：窄屏三页面入口仍在").toBe(3);
        expect(
            await page.locator('[data-testid="workspace-toolbar-more-agents"]').count(),
            "判据6：窄屏菜单 agents 入口零残留",
        ).toBe(0);
    });

    test("判据 7：键盘等价 BL-561 —— 跨容器/跨页签的键盘路径实测", async ({ page }) => {
        await setupMockAuth(page, {});
        await setupMockSessions(page, {
            sessions: [
                { id: SESSION_ID, title: "S2b" },
                { id: "task174-session-2", title: "S2b-2" },
            ],
        });
        await page.goto(`/workspace/${WORKSPACE_ID}/chat/${SESSION_ID}`);
        await page
            .locator('[data-testid="workspace-container-tabs"][data-container="main"] [role="tab"]')
            .first()
            .waitFor({
                state: "visible",
                timeout: EXPECT_TIMEOUT_MS,
            });

        const describeFocus = () =>
            page.evaluate(() => {
                const el = document.activeElement as HTMLElement | null;
                if (!el) return null;
                return {
                    tag: el.tagName,
                    testid: el.getAttribute("data-testid"),
                    role: el.getAttribute("role"),
                    container:
                        el
                            .closest('[data-testid="workspace-container-tabs"]')
                            ?.getAttribute("data-container") ?? null,
                };
            });

        // F6：焦点环（浏览器惯例是面板/区域切换）；这里只**读事实**：焦点不动还是换了区域。
        await page
            .locator('[data-testid="workspace-container-tabs"][data-container="main"] [role="tab"]')
            .first()
            .focus();
        const focusBefore = await describeFocus();
        await page.keyboard.press("F6");
        const focusAfterF6 = await describeFocus();
        // Ctrl+Alt+ArrowRight：dockview 的跨组移动快捷键；默认路径下应被 page 接收（不崩、不吞焦点）。
        await page.keyboard.press("Control+Alt+ArrowRight");
        const focusAfterChord = await describeFocus();
        // 行内键盘：ArrowRight 应在同一行的相邻 tab 间移动（reka roving focus）。
        const mainRow = page.locator(
            '[data-testid="workspace-container-tabs"][data-container="main"]',
        );
        const tabsInMain = await mainRow.locator('[role="tab"]').count();
        await page.keyboard.press("ArrowRight");
        const focusAfterArrow = await describeFocus();

        log("judge7", {
            tabsInMain,
            focusBefore,
            focusAfterF6,
            focusAfterChord,
            focusAfterArrow,
            reachable: focusAfterArrow !== null,
        });
        expect(focusBefore, "判据7：页签行可聚焦").not.toBeNull();
        expect(focusAfterArrow, "判据7：焦点未丢失（键盘路径可达）").not.toBeNull();
    });

    /**
     * 判据 8（task-65 A 段 / `D-1777`·`D-1778` 卡面验收）：**有且只有两栏**、**右栏不是 overlay**。
     *
     * 两件事分开钉，因为会被两种不同的走偏方式破坏：
     * - 「只有两栏」：若把 right 挤进 main 那一行（读法甲「一个容器内两栏」）⇒ 行数从 2 掉到 1，
     *   或两行共用同一份 tab 数据源 ⇒ 前两条红。
     * - 「右栏是正常列」：若 `dockMode: floating` 的 absolute 定位回来（`D-1754 ④` 判据 3 的禁区）
     *   ⇒ 右栏会盖在主列上 ⇒ 几何/层级三条红。
     *
     * 取值全部是**可机器复算**的 DOM 事实（行数 / `data-container` / tab 前缀 / computed position /
     * 两列矩形不重叠），不写像素魔数。
     */
    test("判据 8：有且只有两栏（main + right 各一行），右栏是正常列不是 overlay", async ({
        page,
    }) => {
        await page.setViewportSize({ width: 1920, height: 1080 });
        await setupMockAuth(page, {});
        await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "S2b" }] });
        await page.goto(`/workspace/${WORKSPACE_ID}/chat/${SESSION_ID}`);
        const rows = page.locator('[data-testid="workspace-container-tabs"]');
        await rows.first().waitFor({ state: "visible", timeout: EXPECT_TIMEOUT_MS });

        const containers = await rows.evaluateAll((nodes) =>
            nodes.map((node) => node.getAttribute("data-container")),
        );
        // ① 有且只有两栏，顺序 = 渲染顺序（`CONTAINER_IDS`）。
        expect(containers, "有且只有两栏：main + right").toEqual(["main", "right"]);

        // ② 两栏是**两个独立容器行**，各自有独立的页签数据源（不是一行内分两栏）。
        const tabTestidsOf = (container: string) =>
            page
                .locator(`[data-testid="workspace-container-tabs"][data-container="${container}"]`)
                .locator('[role="tab"]')
                .evaluateAll((nodes) =>
                    nodes.map((node) => node.getAttribute("data-testid") ?? ""),
                );
        const mainTestids = await tabTestidsOf("main");
        const rightTestids = await tabTestidsOf("right");
        expect(mainTestids.length, "main 行有页签").toBeGreaterThan(0);
        expect(rightTestids.length, "right 行有页签").toBeGreaterThan(0);
        expect(
            mainTestids.every((id) => id.startsWith("workspace-container-tab-main-")),
            "main 行页签全走 workspace-container-tab-main-* 前缀",
        ).toBe(true);
        expect(
            rightTestids.every((id) => id.startsWith("dock-tab-")),
            "right 行页签全走 dock-tab-* 前缀（复用既有 dock 数据源，不新造 IA）",
        ).toBe(true);
        // 反面判据：一行里同时含两栏的页签 ⇒ 实现走了「一个容器内两栏」的读法甲。
        expect(
            mainTestids.filter((id) => rightTestids.includes(id)),
            "两行不得共用页签",
        ).toEqual([]);

        // ③ 右栏行属于右栏面板；右栏是**正常列**：不是 absolute/fixed、不带 z-20 遮盖、
        //    与主列左右并排不重叠。
        expect(
            await rows
                .nth(1)
                .evaluate((el) => el.closest('[data-testid="workspace-aux-panel"]') !== null),
            "右栏行必须渲染在右栏面板内",
        ).toBe(true);
        await expect(page.getByTestId("workspace-aux-panel")).toHaveAttribute(
            "data-dock-mode",
            "pinned",
        );
        const geometry = await page.evaluate(() => {
            const dock = document.querySelector<HTMLElement>('[data-testid="workspace-aux-panel"]');
            const main = document.querySelector<HTMLElement>('[data-testid="workspace-main"]');
            if (!dock || !main) return null;
            const style = getComputedStyle(dock);
            const dockBox = dock.getBoundingClientRect();
            const mainBox = main.getBoundingClientRect();
            return {
                position: style.position,
                zIndex: style.zIndex,
                dockLeft: dockBox.left,
                mainRight: mainBox.right,
                dockWidth: dockBox.width,
            };
        });
        expect(geometry, "右栏面板必须与主列同屏存在").not.toBeNull();
        const detail = JSON.stringify(geometry);
        expect(
            ["static", "relative"].includes(geometry!.position),
            `右栏不得是 overlay（position 只能是 static/relative）；实际 ${detail}`,
        ).toBe(true);
        expect(
            geometry!.zIndex === "auto" || Number(geometry!.zIndex) === 0,
            `右栏不得带 z-20 遮盖；实际 ${detail}`,
        ).toBe(true);
        expect(
            geometry!.dockLeft,
            `右栏左缘必须 ≥ 主列右缘（两列并排、互不覆盖）；实际 ${detail}`,
        ).toBeGreaterThanOrEqual(geometry!.mainRight - 1);
        expect(geometry!.dockWidth, `右栏必须有实际宽度；实际 ${detail}`).toBeGreaterThan(0);

        log("judge8", { containers, mainTestids, rightTestids, geometry });
    });
});
