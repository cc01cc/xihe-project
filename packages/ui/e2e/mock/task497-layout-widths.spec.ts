/**
 * task-497：wokbench 三栏几何 —— **dock 组必须有约束**（mock lane，L0 单 spec）。
 *
 * 背景（task-486 接线时的超范围观察，已由 Lead 立项）：dock 组此前**没有任何约束**，
 * 库把剩下的空间全给它 ⇒ 宿主 1158 时实测 tree=240 / main=100 / dock=818。
 * S1 时树宽 min=max=240 把注意力钉在树上，所以没人看见。
 *
 * 本卡的边界（Lead 2026-11-14 裁定）：
 *   · 497 = dock 组有约束（不超 480）+ 主列拿到余量（不再出现 main=100）；
 *   · **640 硬底线与 §1.5-C 让位顺序属 task-504**，不在本卡做。
 *     算术依据：`host 1158 − tree_min 200 − dock_min 320 − 两条缝 ≈ 8 = 630 < 640`
 *     ⇒ 三栏全取最小也到不了 640，那不是「修 dock 吃余量」而是布局策略。
 *
 * 判据（含 Lead 裁定①：**pinned 档才断言 dock 夹取**）：
 *   ① pinned（视口 ≥1800 派生）：dock 在实例内，宽度落在 320–480；
 *   ② pinned：主列拿到余量（本卡的中间底线 480，取代原来的 100）；
 *   ③ floating（窄档）：右栏**不在实例内** —— `[data-dockview-panel=monitor]` 计数 0、
 *      `.dv-sash` 仅 1 条（负向断言：对象不存在时，断言它不存在本身就是有判别力的判据）；
 *   ④ 树宽仍在 200–320（折叠态 40）且与持久值一致 —— 不许为救主列把树宽改回钉死。
 *
 * 跑法：`$env:XIHE_UI_PORT='12737'; pnpm exec playwright test --config e2e/playwright.config.ts
 * e2e/mock/task497-layout-widths.spec.ts`
 */
import { expect, test } from "./helpers/mock-test";
import type { Page } from "@playwright/test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { EXPECT_TIMEOUT_MS } from "../timeouts";
import {
    DOCK_WIDTH_MAX,
    DOCK_WIDTH_MIN,
    TREE_COLLAPSED_WIDTH,
    TREE_WIDTH_MAX,
    TREE_WIDTH_MIN,
    WORKSPACE_LAYOUT_STORAGE_PREFIX,
} from "../../src/composables/useWorkspaceLayout";

const WORKSPACE_PATH = "/workspace/workspace-1";
const LAYOUT_KEY = `${WORKSPACE_LAYOUT_STORAGE_PREFIX}workspace-1`;
/** 本卡的中间底线（640 属 task-504）。取 480 = dock 夹取上限，低于它说明主列又被吃回去了。 */
const MAIN_INTERIM_FLOOR = 480;

interface Geometry {
    host: number;
    tree: number;
    main: number;
    dock: number;
    dockPanel: number;
    sashes: number;
}

/**
 * 等几何稳定再量（**不是礼貌等待，是判据前提**）。
 *
 * 宿主链上有 `transition-[flex-grow] duration-300`，挂载后宽度从 ~410 长到最终值；
 * 300 ms 内取样会读到中间态（实测 1920 视口中途取到 host=1149 / tree=200 / main=100，
 * 稳定值是 host=1158 / tree=240）。把中间态当缺陷读数会假红，把它当"修好了"会假绿。
 */
async function waitForStableGeometry(page: Page): Promise<void> {
    await page.waitForFunction(
        () => {
            const read = (): string => {
                const w = (sel: string): number => {
                    const el = document.querySelector(sel);
                    return el ? Math.round(el.getBoundingClientRect().width) : -1;
                };
                return [
                    w(".dockview-host"),
                    w('[data-dockview-panel="tree"]'),
                    w('[data-dockview-panel="main"]'),
                    w('[data-dockview-panel="monitor"]'),
                ].join("/");
            };
            const box = globalThis as { __xh497Stable?: { at: number; w: string } };
            const now = performance.now();
            const w = read();
            if (!box.__xh497Stable || box.__xh497Stable.w !== w) {
                box.__xh497Stable = { at: now, w };
                return false;
            }
            return now - box.__xh497Stable.at >= 350;
        },
        undefined,
        { timeout: EXPECT_TIMEOUT_MS, polling: 50 },
    );
}

async function openWorkbench(
    page: Page,
    viewport: { width: number; height: number },
): Promise<void> {
    await page.setViewportSize(viewport);
    await page.goto(WORKSPACE_PATH);
    await page.waitForSelector('[data-testid="workspace-main"]', {
        state: "attached",
        timeout: EXPECT_TIMEOUT_MS,
    });
    await page.waitForSelector('[data-dockview-panel="tree"]', {
        state: "attached",
        timeout: EXPECT_TIMEOUT_MS,
    });
    await waitForStableGeometry(page);
}

/** 三栏 + 宿主宽度（取 dockview 里真实 group 的几何，不是 store 值）。 */
async function geometry(page: Page): Promise<Geometry> {
    return page.evaluate(() => {
        const groupWidth = (panelId: string): number => {
            const el = document
                .querySelector(`[data-dockview-panel="${panelId}"]`)
                ?.closest(".dv-groupview");
            return el ? Math.round(el.getBoundingClientRect().width) : -1;
        };
        return {
            host: Math.round(
                document.querySelector(".dockview-host")?.getBoundingClientRect().width ?? -1,
            ),
            tree: groupWidth("tree"),
            main: groupWidth("main"),
            dock: groupWidth("monitor"),
            dockPanel: document.querySelectorAll('[data-dockview-panel="monitor"]').length,
            sashes: document.querySelectorAll(".dv-sash").length,
        };
    });
}

async function storedTreeWidth(page: Page): Promise<number | null> {
    return page.evaluate((key) => {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as { treeWidth?: unknown };
        return typeof parsed.treeWidth === "number" ? parsed.treeWidth : null;
    }, LAYOUT_KEY);
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        (globalThis as { __xhUseDockview?: boolean }).__xhUseDockview = true;
    });
    await setupMockAuth(page);
    await setupMockSessions(page, { sessions: [{ id: "session-1", title: "Session 1" }] });
});

test("① pinned（1920）：dock 落进 320–480 夹取区间，主列不再被压到 100", async ({ page }) => {
    await openWorkbench(page, { width: 1920, height: 1080 });
    const g = await geometry(page);
    const reading = `host=${g.host} tree=${g.tree} main=${g.main} dock=${g.dock}`;

    // 1920 视口按 `deriveDockMode` 派生 pinned ⇒ 右栏必须在实例内，否则本条判据没有被测对象。
    expect(g.dockPanel, `pinned 档右栏应在 dockview 实例内（${reading}）`).toBe(1);
    expect(g.dock, `dock 宽 ${g.dock} 不在 320–480（${reading}）`).toBeGreaterThanOrEqual(
        DOCK_WIDTH_MIN,
    );
    expect(g.dock, `dock 宽 ${g.dock} 超出夹取上限（${reading}）`).toBeLessThanOrEqual(
        DOCK_WIDTH_MAX,
    );
    expect(
        g.main,
        `主列被压到 ${g.main}（本卡底线 ${MAIN_INTERIM_FLOOR}；640 底线属 task-504）—— ${reading}`,
    ).toBeGreaterThanOrEqual(MAIN_INTERIM_FLOOR);
    expect(g.tree, `树宽 ${g.tree} 应仍在 200–320`).toBeGreaterThanOrEqual(TREE_WIDTH_MIN);
    expect(g.tree, `树宽 ${g.tree} 应仍在 200–320`).toBeLessThanOrEqual(TREE_WIDTH_MAX);
});

for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
]) {
    test(`③ ${viewport.width}（floating）：右栏不在实例内 + 两栏几何仍成立`, async ({ page }) => {
        await openWorkbench(page, viewport);
        const g = await geometry(page);
        const reading = `host=${g.host} tree=${g.tree} main=${g.main} dock=${g.dock} sashes=${g.sashes}`;

        // 负向判据（Lead 裁定①）：floating 档右栏由手写 dock 承载，**不在** dockview 实例里。
        // 把 -1 当宽度 0 去比 320–480 是假判据；断言「对象不存在」才有判别力。
        expect(g.dockPanel, `floating 档右栏不得在实例内（${reading}）`).toBe(0);
        expect(g.sashes, `floating 档只该有树↔主列一条缝（${reading}）`).toBe(1);

        expect(g.main, `主列被压到 ${g.main}（${reading}）`).toBeGreaterThanOrEqual(
            MAIN_INTERIM_FLOOR,
        );
        // 1024 档树默认折叠成 40px rail（PLAN-0582 §1.5-A），展开档才是 200–320。
        const treeOk =
            g.tree === TREE_COLLAPSED_WIDTH ||
            (g.tree >= TREE_WIDTH_MIN && g.tree <= TREE_WIDTH_MAX);
        expect(treeOk, `树宽 ${g.tree} 既不是折叠 40 也不在 200–320（${reading}）`).toBe(true);
    });
}

test("④ 树宽与持久值一致（不许为救主列把树宽改回钉死）", async ({ page }) => {
    await openWorkbench(page, { width: 1920, height: 1080 });
    // 挂载本身不一定写盘（宽度没变就不发）⇒ 先用键盘把宽度改到边界，再核对「几何 == 持久值」。
    // 这一条同时守「497 不许靠把树宽改回 min=max 来救主列」：锁死时键盘改不动 ⇒ poll 超时即红。
    const sash = page.locator('.dv-sash[data-dock-sash-a11y="true"]');
    await sash.focus();
    await page.keyboard.press("End");
    await expect
        .poll(() => storedTreeWidth(page), { timeout: EXPECT_TIMEOUT_MS })
        .toBe(TREE_WIDTH_MAX);
    await expect
        .poll(() => geometry(page).then((g) => g.tree), { timeout: EXPECT_TIMEOUT_MS })
        .toBe(TREE_WIDTH_MAX);
    const g = await geometry(page);
    expect(g.dock, "树取最大宽后 dock 仍需在夹取区间内").toBeLessThanOrEqual(DOCK_WIDTH_MAX);
    expect(
        g.main,
        `主列在树取最大宽时仍需 >= ${MAIN_INTERIM_FLOOR}（实际 ${g.main}）`,
    ).toBeGreaterThanOrEqual(MAIN_INTERIM_FLOOR);
});
