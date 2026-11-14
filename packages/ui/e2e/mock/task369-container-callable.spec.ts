/**
 * task-369 S1 / D-1222：容器内可调用组件 —— dockview 双容器的**模型判据**（mock lane，L0 单 spec）。
 *
 * 被测件：`WorkspaceShellDockview.vue`（一个 DockviewVue 实例横跨中栏与右栏），
 * 由 `globalThis.__xhUseDockview` 注入面打开（**默认 false**，产品路径不受影响）。
 *
 * 四性质（D-1222 ⑤）各自的判据：
 *   ① 树能被关闭：面板与 40px `workspace-file-rail` **一起消失**；
 *   ② 能从容器内重开：组头 rightHeaderActions 的「+」菜单；
 *   ③ 能指定投中栏或右栏：**投哪个容器由被点击的组头决定**（几何左右序，不是「不同组」这种
 *      不区分状态的弱断言 —— run2 曾因此假绿：壳恒放左侧时弱断言也过）；
 *   ④ 中栏与右栏共用一个实例：全页 `.dv-dockview` 恰好 1 个，树/主列/dock 同属它。
 *
 * dockview 语义注记（run2 实测纠正）：`direction: left|right` 是**新建 group**，不是同组加 tab
 * ⇒ 并排的树/主列/dock 各是一个 group；「同容器」用**几何左右序**判，不用「同 group」。
 * 面板定位用产品自己的 `data-dockview-panel="<id>"` 钩子（不依赖 locale 文案）。
 *
 * S1 边界判据（Lead 裁定②）：树宽锁死 ⇒ 拖中缝（`.dv-sash`）宽度不变；折叠/展开是离散 40/240。
 * **task-486（S2）已翻转锁死这条**（同批接线 `dockSashA11y`）⇒ 本 spec 末条改成「可拖 + 回写」，
 * 键盘与 separator 契约的判据在 `task486-sash-a11y.spec.ts`。
 *
 * 跑法：`$env:XIHE_UI_PORT='12660'; pnpm exec playwright test --config e2e/playwright.config.ts
 * e2e/mock/task369-container-callable.spec.ts`（mock lane 专用端口，不碰真栈 12630–12643）。
 */
import { expect, test } from "./helpers/mock-test";
import type { Page } from "@playwright/test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { EXPECT_TIMEOUT_MS } from "../timeouts";
import {
    TREE_COLLAPSED_WIDTH,
    TREE_WIDTH_DEFAULT,
    TREE_WIDTH_MAX,
} from "../../src/composables/useWorkspaceLayout";

const WORKSPACE_PATH = "/workspace/workspace-1";
const TREE_TAB_TITLE = "展开文件树";

async function openWorkbench(page: Page): Promise<void> {
    await page.goto(WORKSPACE_PATH);
    await page.waitForSelector('[data-testid="workspace-workbench"]', {
        state: "attached",
        timeout: EXPECT_TIMEOUT_MS,
    });
    await page.waitForSelector('[data-testid="workspace-main"]', {
        state: "attached",
        timeout: EXPECT_TIMEOUT_MS,
    });
}

function treeTabClose(page: Page) {
    return page
        .locator(".dv-tab")
        .filter({ hasText: TREE_TAB_TITLE })
        .locator(".dv-default-tab-action");
}

/** 面板所在 group 相对主列 group 的几何位置（判据③④的强断言基础）。 */
async function sideOf(page: Page, panelId: string): Promise<string> {
    return page.evaluate((id) => {
        const own = document.querySelector(`[data-dockview-panel="${id}"]`);
        const main = document.querySelector('[data-dockview-panel="main"]');
        if (!own || !main) return "absent";
        const og = own.closest(".dv-groupview");
        const mg = main.closest(".dv-groupview");
        if (!og || !mg) return "absent";
        if (og === mg) return "same";
        return og.getBoundingClientRect().left < mg.getBoundingClientRect().left ? "left" : "right";
    }, panelId);
}

async function railWidth(page: Page): Promise<number> {
    return page.evaluate(() => {
        const rail = document.querySelector('[data-testid="workspace-file-rail"]');
        return rail ? rail.getBoundingClientRect().width : -1;
    });
}

/** 含主列的 group = 主列组；右栏组 = 含 monitor 面板的组。 */
const mainGroup = (page: Page) =>
    page.locator(".dv-groupview").filter({ has: page.locator('[data-dockview-panel="main"]') });
const dockGroup = (page: Page) =>
    page.locator(".dv-groupview").filter({ has: page.locator('[data-dockview-panel="monitor"]') });

async function openDockTab(page: Page, tab: string): Promise<void> {
    await page.click(`[data-testid="workspace-toolbar-${tab}"]`);
    await page.waitForSelector(`[data-dockview-panel="${tab}"]`, {
        state: "attached",
        timeout: EXPECT_TIMEOUT_MS,
    });
}

test.beforeEach(async ({ page }) => {
    // task-369 S1：注入面复活（PLAN-0756 原设计）。addInitScript 先于应用脚本 ⇒ 壳必挂。
    await page.addInitScript(() => {
        (globalThis as { __xhUseDockview?: boolean }).__xhUseDockview = true;
    });
    await setupMockAuth(page);
    await setupMockSessions(page, { sessions: [{ id: "session-1", title: "Session 1" }] });
    await page.setViewportSize({ width: 1920, height: 1080 });
});

test("④ 单实例：.dv-dockview 恰好 1 个；树在主列左、dock 在主列右，同属该实例", async ({
    page,
}) => {
    await openWorkbench(page);
    expect(await page.evaluate(() => document.querySelectorAll(".dv-dockview").length)).toBe(1);
    expect(await sideOf(page, "tree")).toBe("left");
    expect(await sideOf(page, "monitor")).toBe("right");
    await openDockTab(page, "code");
    const shape = await page.evaluate(() => {
        const shell = document.querySelector(".dv-dockview");
        const groups = Array.from(document.querySelectorAll(".dv-groupview"));
        return {
            groups: groups.length,
            allInside: groups.every((g) => shell?.contains(g)),
        };
    });
    // 树 / 主列 / dock（monitor+code 同组）= 3 个 group，全在同一实例内。
    expect(shape.groups).toBe(3);
    expect(shape.allInside).toBe(true);
    expect(await sideOf(page, "code")).toBe("right");
});

test("① 树可关闭：面板与 40px rail 一起消失，主列仍在", async ({ page }) => {
    await openWorkbench(page);
    await treeTabClose(page).click();
    await expect(page.locator('[data-testid="workspace-file-rail"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="workspace-file-tree"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="workspace-main"]')).toBeAttached();
    await expect(page.locator(".dv-tab").filter({ hasText: TREE_TAB_TITLE })).toHaveCount(0);
    expect(await sideOf(page, "tree")).toBe("absent");
});

test("② 关闭后从主列组头「+」重开 ⇒ 树回到主列左侧（入口在容器内）", async ({ page }) => {
    await openWorkbench(page);
    await treeTabClose(page).click();
    await expect(page.locator('[data-testid="workspace-file-rail"]')).toHaveCount(0);
    await mainGroup(page).locator('[data-testid="dockview-add-trigger"]').click();
    const item = page.locator('[data-testid="dockview-add-item-tree"]');
    await expect(item).toBeAttached();
    await item.click();
    await expect(page.locator('[data-testid="workspace-file-rail"]')).toBeVisible();
    expect(await sideOf(page, "tree")).toBe("left");
});

test("③ 从右栏组头「+」重开 ⇒ 树投到主列右侧（目标由被点组头决定）", async ({ page }) => {
    await openWorkbench(page);
    await treeTabClose(page).click();
    await expect(page.locator('[data-testid="workspace-file-rail"]')).toHaveCount(0);
    await dockGroup(page).locator('[data-testid="dockview-add-trigger"]').click();
    const item = dockGroup(page).locator('[data-testid="dockview-add-item-tree"]');
    await expect(item).toBeAttached();
    await item.click();
    await expect(page.locator('[data-testid="workspace-file-rail"]')).toBeVisible();
    // 强断言：必须在主列**右侧**。弱断言「不同组」在壳恒放左侧时也会过（run2 假绿）。
    expect(await sideOf(page, "tree")).toBe("right");
});

test("③b dock 面板从主列组头重开 ⇒ 投到主列左侧（判据③对 dock 面板同样成立）", async ({ page }) => {
    await openWorkbench(page);
    // 关掉默认的 monitor（右栏），再从主列组头把它重开 ⇒ 应落中栏。
    await dockGroup(page).locator(".dv-default-tab-action").first().click();
    await expect(page.locator('[data-dockview-panel="monitor"]')).toHaveCount(0);
    await mainGroup(page).locator('[data-testid="dockview-add-trigger"]').click();
    const item = page.locator('[data-testid="dockview-add-item-monitor"]');
    await expect(item).toBeAttached();
    await item.click();
    await expect(page.locator('[data-dockview-panel="monitor"]')).toBeAttached();
    expect(await sideOf(page, "monitor")).toBe("left");
});

test("折叠 ≠ 关闭：折叠后 40px rail 仍在，展开回 240；关闭则 rail 一起消失", async ({ page }) => {
    await openWorkbench(page);
    expect(Math.round(await railWidth(page))).toBe(TREE_WIDTH_DEFAULT);
    await page.click('[data-testid="workspace-toolbar-toggle-tree"]');
    await page.waitForSelector('[data-testid="workspace-tree-expand"]', {
        state: "attached",
        timeout: EXPECT_TIMEOUT_MS,
    });
    await expect
        .poll(async () => Math.round(await railWidth(page)), { timeout: EXPECT_TIMEOUT_MS })
        .toBe(TREE_COLLAPSED_WIDTH);
    await expect(page.locator('[data-testid="workspace-file-rail"]')).toBeVisible();
    await page.click('[data-testid="workspace-tree-expand"]');
    await expect
        .poll(async () => Math.round(await railWidth(page)), { timeout: EXPECT_TIMEOUT_MS })
        .toBe(TREE_WIDTH_DEFAULT);
    // 折叠态下关闭 ⇒ rail 也消失（折叠与关闭是两件事）。
    await treeTabClose(page).click();
    await expect(page.locator('[data-testid="workspace-file-rail"]')).toHaveCount(0);
});

/**
 * **判据翻转（task-486 S2，2026-11-14）**：S1 时这条判的是「树宽锁死 ⇒ 拖中缝不变」。
 * S2 拆了 `min=max` 锁并要求同批接上 `dockSashA11y`（Lead 裁定②），所以锁死不再是特性而是缺口：
 * 这里改成**可拖 + 回写**，键盘/separator 契约的判据在 `task486-sash-a11y.spec.ts`（同 lane）。
 * 保留文件位置的余量理由：本条仍在 S1 的容器模型 spec 里，因为它验的是「同一个 dockview 实例的几何」。
 */
test("S2 树宽可拖：拖中缝后宽度真的变，并写回持久键（原 S1「锁死」判据已翻转）", async ({
    page,
}) => {
    await openWorkbench(page);
    expect(Math.round(await railWidth(page))).toBe(TREE_WIDTH_DEFAULT);
    // **认缝要用接线标记**：容器里有两条缝（树↔主列、主列↔右栏），`.dv-sash` 的 DOM 顺序
    // 不能当语义用（按 `.first()` 取到的可能不是树那条 —— 实测拖不动 240 就是这个原因）。
    const sash = page.locator('.dv-sash[data-dock-sash-a11y="true"]');
    const box = await sash.boundingBox();
    if (!box) throw new Error("树↔主列那道缝（已接线）不存在");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    // 变宽且不超过产品夹取上限 320（与手写分支 `clampTreeWidth` 同界）。
    await expect
        .poll(async () => Math.round(await railWidth(page)), { timeout: EXPECT_TIMEOUT_MS })
        .toBeGreaterThan(TREE_WIDTH_DEFAULT);
    const widened = Math.round(await railWidth(page));
    expect(widened, "不得超过 200–320 的产品夹取上限").toBeLessThanOrEqual(TREE_WIDTH_MAX);
    // 回写：单一 writer 仍是 Workbench（本 spec 只读 localStorage 做交叉核对）。
    await expect
        .poll(
            () =>
                page.evaluate((key) => {
                    const raw = localStorage.getItem(key);
                    if (!raw) return null;
                    const parsed = JSON.parse(raw) as { treeWidth?: unknown };
                    return typeof parsed.treeWidth === "number" ? parsed.treeWidth : null;
                }, "xihe-layout-ws:workspace-1"),
            { timeout: EXPECT_TIMEOUT_MS },
        )
        .toBe(widened);
});
