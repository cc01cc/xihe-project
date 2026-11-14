/**
 * task-486（S2）/ BL-561：dockview 分隔条的无障碍契约 —— **接线判据**（mock lane，L0 单 spec）。
 *
 * 被测件：`WorkspaceShellDockview.vue` + `dockSashA11y.ts`（后者是纯逻辑，已有单测；
 * 本 spec 只问「接上了没有」）。理由（Lead 2026-11-14 裁定）：库里 spec 绿 ≠ 产品接上了，
 * 没有这条断言时「接线」这件事本身没有任何判据（D-1381 同族：假绿比假红更贵）。
 *
 * 判据：
 *   ① 树↔主列那道缝有 `role=separator` + `tabindex=0` + `aria-valuenow` + 可读名；
 *   ② 主列↔右栏那道缝**没有**被装饰（判别力：证明判据不是「所有 sash 都挂了」）；
 *   ③ 方向键让占比变化，且**播报值跟着变**（apply 后重读实际值）；
 *   ④ Home/End 到 200/320 边界；双击复位回 240；
 *   ⑤ 变化写回 `xihe-layout-ws:<id>.treeWidth`（单一 writer 仍是 Workbench），reload 后保持。
 *
 * 跑法：`$env:XIHE_UI_PORT='12737'; pnpm exec playwright test --config e2e/playwright.config.ts
 * e2e/mock/task486-sash-a11y.spec.ts`
 */
import { expect, test } from "./helpers/mock-test";
import type { Page } from "@playwright/test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { EXPECT_TIMEOUT_MS } from "../timeouts";
import {
    TREE_COLLAPSED_WIDTH,
    TREE_WIDTH_DEFAULT,
    TREE_WIDTH_MAX,
    TREE_WIDTH_MIN,
    WORKSPACE_LAYOUT_STORAGE_PREFIX,
} from "../../src/composables/useWorkspaceLayout";

const WORKSPACE_ID = "workspace-1";
const WORKSPACE_PATH = `/workspace/${WORKSPACE_ID}`;
const LAYOUT_KEY = `${WORKSPACE_LAYOUT_STORAGE_PREFIX}${WORKSPACE_ID}`;
const SASH_LABEL = "调整文件树宽度";

/**
 * 打开工作台并**等树宽落到期望值**。
 *
 * 为什么必须等：挂载后树宽先落在库默认最小宽 200，再由产品值纠到 240（`addPanel({initialWidth})`
 * 不被库兑现 ⇒ 依赖同步后的 setSize）。裸读会读到中间帧，判据会在「产品对、读数早」上假红。
 */
async function openWorkbench(
    page: Page,
    expectedTreeWidth: number = TREE_WIDTH_DEFAULT,
): Promise<void> {
    await page.goto(WORKSPACE_PATH);
    await page.waitForSelector('[data-testid="workspace-workbench"]', {
        state: "attached",
        timeout: EXPECT_TIMEOUT_MS,
    });
    await page.waitForSelector('[data-dockview-panel="tree"]', {
        state: "attached",
        timeout: EXPECT_TIMEOUT_MS,
    });
    await expect
        .poll(() => treeWidth(page), { timeout: EXPECT_TIMEOUT_MS })
        .toBe(expectedTreeWidth);
    // 还要等**主列**稳定：`aria-valuenow` 是「树 / (树+主列)」的占比，主列在挂载后会随
    // 宿主宽度动画（`transition-[flex-grow] duration-300`）继续变 ⇒ 主列没稳时读到的占比是
    // 中间帧（实测 67% vs 稳态 31%），方向键后的「占比应变大」会因此判反。
    await waitForStableGroups(page);
}

/** 三组几何两次采样一致 ⇒ 稳态（readiness probe，不是 sleep）。 */
async function waitForStableGroups(page: Page): Promise<void> {
    await page.waitForFunction(
        () => {
            const w = (sel: string): number => {
                const el = document.querySelector(sel)?.closest(".dv-groupview");
                return el ? Math.round(el.getBoundingClientRect().width) : -1;
            };
            const key = [w('[data-dockview-panel="tree"]'), w('[data-dockview-panel="main"]')].join(
                "/",
            );
            const box = globalThis as { __xh486Stable?: { at: number; key: string } };
            const now = performance.now();
            if (!box.__xh486Stable || box.__xh486Stable.key !== key) {
                box.__xh486Stable = { at: now, key };
                return false;
            }
            return now - box.__xh486Stable.at >= 300;
        },
        undefined,
        { timeout: EXPECT_TIMEOUT_MS, polling: 50 },
    );
}

/** 树组宽度（树在 dockview 里的真实几何，不是 store 值）。 */
async function treeWidth(page: Page): Promise<number> {
    return page.evaluate(() => {
        const el = document.querySelector('[data-dockview-panel="tree"]')?.closest(".dv-groupview");
        return el ? Math.round(el.getBoundingClientRect().width) : -1;
    });
}

/** 主列组宽度（`aria-valuenow` 的占比分母含它 ⇒ 判据要能重算）。 */
async function mainWidth(page: Page): Promise<number> {
    return page.evaluate(() => {
        const el = document.querySelector('[data-dockview-panel="main"]')?.closest(".dv-groupview");
        return el ? Math.round(el.getBoundingClientRect().width) : -1;
    });
}

/** 缝上播报的占比是否等于「树 / (树 + 主列)」—— 播报不撒谎的机器判据。 */
async function expectValueTracksGeometry(page: Page): Promise<void> {
    const tree = await treeWidth(page);
    const main = await mainWidth(page);
    const expected = Math.round((100 * tree) / (tree + main));
    const actual = Number(await treeSash(page).getAttribute("aria-valuenow"));
    expect(
        Math.abs(actual - expected),
        `播报值 ${actual}% 与几何 ${expected}% 不一致`,
    ).toBeLessThanOrEqual(1);
}

/** 树↔主列那道缝（几何判定：中线落在树组与主列组的交界上）。 */
const treeSash = (page: Page) => page.locator('.dv-sash[data-dock-sash-a11y="true"]');

async function storedTreeWidth(page: Page): Promise<number | null> {
    return page.evaluate((key) => {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        try {
            const parsed = JSON.parse(raw) as { treeWidth?: unknown };
            return typeof parsed.treeWidth === "number" ? parsed.treeWidth : null;
        } catch {
            return null;
        }
    }, LAYOUT_KEY);
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        (globalThis as { __xhUseDockview?: boolean }).__xhUseDockview = true;
    });
    await setupMockAuth(page);
    await setupMockSessions(page, { sessions: [{ id: "session-1", title: "Session 1" }] });
    await page.setViewportSize({ width: 1920, height: 1080 });
});

test("① 接线：树↔主列那道缝有 separator 契约（可读名 + 焦点 + 播报值）", async ({ page }) => {
    await openWorkbench(page);
    const sash = treeSash(page);
    await expect(sash).toHaveCount(1);
    await expect(sash).toHaveAttribute("role", "separator");
    await expect(sash).toHaveAttribute("aria-label", SASH_LABEL);
    await expect(sash).toHaveAttribute("aria-orientation", "vertical");
    await expect(sash).toHaveAttribute("tabindex", "0");
    const now = Number(await sash.getAttribute("aria-valuenow"));
    const min = Number(await sash.getAttribute("aria-valuemin"));
    const max = Number(await sash.getAttribute("aria-valuemax"));
    expect(Number.isFinite(now), "aria-valuenow 必须是数值").toBe(true);
    expect(min).toBeLessThan(max);
    expect(now).toBeGreaterThanOrEqual(min);
    expect(now).toBeLessThanOrEqual(max);
});

test("② 红线：主列↔右栏那道缝**不得**挂 tree-width 契约（挂上 = 一次方向键播报两个比例）", async ({
    page,
}) => {
    await openWorkbench(page);
    const counts = await page.evaluate(() => ({
        total: document.querySelectorAll(".dv-sash").length,
        decorated: document.querySelectorAll('.dv-sash[data-dock-sash-a11y="true"]').length,
    }));
    // 三个 group（树 / 主列 / 右栏）⇒ 两条缝；只有交界于树与主列的那条被装饰。
    expect(counts.total, "至少两条缝，否则本判据不成立").toBeGreaterThanOrEqual(2);
    expect(counts.decorated, "只有树↔主列那一条该被装饰").toBe(1);

    // 负向断言点名到「那道缝」（不是只数个数）：按几何找出**不在**树/主列交界上的缝，
    // 它必须既没有 separator 契约、也没有 tree-width 的可读名。
    const other = await page.evaluate(() => {
        const tree = document
            .querySelector('[data-dockview-panel="tree"]')
            ?.closest(".dv-groupview");
        const main = document
            .querySelector('[data-dockview-panel="main"]')
            ?.closest(".dv-groupview");
        if (!tree || !main) return null;
        const t = tree.getBoundingClientRect();
        const m = main.getBoundingClientRect();
        const boundary = t.left < m.left ? t.right : m.right;
        const rest = [...document.querySelectorAll<HTMLElement>(".dv-sash")].filter((sash) => {
            const r = sash.getBoundingClientRect();
            return Math.abs(r.left + r.width / 2 - boundary) > 4;
        });
        return rest.map((sash) => ({
            role: sash.getAttribute("role"),
            label: sash.getAttribute("aria-label"),
            decorated: sash.getAttribute("data-dock-sash-a11y"),
            tabindex: sash.getAttribute("tabindex"),
        }));
    });
    expect(other, "应能找到「另一道缝」").not.toBeNull();
    expect(other!.length).toBeGreaterThanOrEqual(1);
    for (const sash of other!) {
        expect(sash.decorated, "非树/主列交界的缝不得被装饰").toBeNull();
        expect(sash.role, "非树/主列交界的缝不得是 separator").not.toBe("separator");
        expect(sash.label, "非树/主列交界的缝不得带 tree-width 可读名").not.toBe(SASH_LABEL);
    }
});

test("②b 折叠态仍锁 40px：键盘在那道缝上不改变宽度（rail 没有可拖的余地）", async ({ page }) => {
    // 折叠态由持久值驱动（`treeCollapsed` 与宽度分开存，PLAN-0582 §1.5-A），直接在装载前种进去，
    // 免得依赖某个折叠按钮的 testid。
    await page.addInitScript((key) => {
        localStorage.setItem(key, JSON.stringify({ treeCollapsed: true }));
    }, LAYOUT_KEY);
    await openWorkbench(page, TREE_COLLAPSED_WIDTH);
    const collapsed = await treeWidth(page);
    expect(collapsed, "折叠态是 40px rail").toBe(TREE_COLLAPSED_WIDTH);

    const sash = treeSash(page);
    await sash.focus();
    await page.keyboard.press("End");
    expect(await treeWidth(page), "折叠态 min=max=40 ⇒ 键盘改不动（锁仍然生效）").toBe(
        TREE_COLLAPSED_WIDTH,
    );
});

test("③ 方向键让树宽变化，且播报值与真实几何一致", async ({ page }) => {
    await openWorkbench(page);
    const sash = treeSash(page);
    const before = await treeWidth(page);
    await sash.focus();

    await page.keyboard.press("ArrowRight");
    await expect
        .poll(() => treeWidth(page), { timeout: EXPECT_TIMEOUT_MS })
        .toBeGreaterThan(before);
    // 判据从「播报值应该变大」改成「播报值 == 几何占比」：
    // 占比的分母是「树 + 主列」，而主列宽度会随布局策略变化（task-497 之后主列不再被压到 100），
    // 于是「播报值变大」在主列同时变大时可能是**假红**；而「播报值必须等于真实占比」是更强的
    // 契约（不撒谎），且与主列怎么变无关 —— 这正是 a11y 要保证的东西。
    await expectValueTracksGeometry(page);

    const wider = await treeWidth(page);
    await page.keyboard.press("ArrowLeft");
    await expect.poll(() => treeWidth(page), { timeout: EXPECT_TIMEOUT_MS }).toBeLessThan(wider);
    await expectValueTracksGeometry(page);
});

test("④ Home/End 到 200/320 边界，双击复位回默认宽", async ({ page }) => {
    await openWorkbench(page);
    const sash = treeSash(page);
    await sash.focus();

    await page.keyboard.press("Home");
    expect(await treeWidth(page)).toBe(TREE_WIDTH_MIN);

    await page.keyboard.press("End");
    expect(await treeWidth(page)).toBe(TREE_WIDTH_MAX);

    await sash.dblclick();
    expect(await treeWidth(page)).toBe(TREE_WIDTH_DEFAULT);
});

test("⑤ 宽度写回持久键，reload 后保持（单一 writer 不变）", async ({ page }) => {
    await openWorkbench(page);
    const sash = treeSash(page);
    await sash.focus();
    await page.keyboard.press("End");
    const wide = await treeWidth(page);

    await expect.poll(async () => storedTreeWidth(page), { timeout: EXPECT_TIMEOUT_MS }).toBe(wide);

    await page.reload();
    await openWorkbench(page, wide);
    expect(await treeWidth(page), "reload 后宽度应保持").toBe(wide);
});
