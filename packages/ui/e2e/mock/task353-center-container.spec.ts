/**
 * task-353 / D-1207 甲案：文件树住进中栏容器 —— 判据①（层级）与判据③（折叠可逆）。
 *
 * 判据②（宽度守恒）**不在这里**：它的量法归 `bl576-workbench-panel-widths.spec.ts`（同一份量法只留
 * 一处 —— 新写一条并行断言看起来更安全，实际会让旧守卫静默失效）。本文件只补 bl576 不覆盖的两件：
 *   ① 层级：文件树 panel 的祖先里有 `[data-testid="workspace-center"]`，且它与主区同属一个 group；
 *      反向（改造前）：树是工作台的第三列，父链上没有任何 `workspace-center` ⇒ 本断言必红。
 *   ③ 折叠可逆：收起 → 主区吃掉释放的宽度；展开 → 回到原宽（PLAN-0582「折叠态与宽度分开存」）。
 * 顺带出两张 1920×1080 辅助证据图（展开/收起各一张；图不作判据，判据是上面的数字）。
 */
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import type { Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { EXPECT_TIMEOUT_MS } from "../timeouts";
import { TREE_COLLAPSED_WIDTH, TREE_WIDTH_DEFAULT } from "../../src/composables/useWorkspaceLayout";

const WORKSPACE_PATH = "/workspace/workspace-1";
/** 图落 gitignored 的 `.tmp`（A03 仓库根上一级 = one 根），不进产品仓库。 */
const SHOT_DIR = resolve(process.cwd(), "../../../.tmp/xh/task-353");

interface CenterGeometry {
    centerWidth: number;
    treeWidth: number;
    mainWidth: number;
    hasCenter: boolean;
    railInCenter: boolean;
    treeInCenter: boolean;
    mainInCenter: boolean;
    groupInCenter: boolean;
    sameGroup: boolean;
}

/** 直读几何与层级（不引入固定 sleep；调用方负责轮询到稳定）。 */
async function measure(page: Page): Promise<CenterGeometry | null> {
    return page.evaluate(() => {
        const center = document.querySelector('[data-testid="workspace-center"]');
        const rail = document.querySelector('[data-testid="workspace-file-rail"]');
        const mainColumn = document.querySelector('[data-testid="workspace-main"]');
        const group = center?.querySelector("[data-panel-group]") ?? null;
        const tree = rail?.closest("[data-panel]") ?? null;
        const main = mainColumn?.closest("[data-panel]") ?? null;
        if (!center || !tree || !main) return null;
        return {
            centerWidth: center.getBoundingClientRect().width,
            treeWidth: tree.getBoundingClientRect().width,
            mainWidth: main.getBoundingClientRect().width,
            hasCenter: true,
            railInCenter: rail !== null && center.contains(rail),
            treeInCenter: center.contains(tree),
            mainInCenter: center.contains(main),
            groupInCenter: group !== null,
            sameGroup: tree.parentElement === main.parentElement,
        };
    });
}

/** 轮询到「连续两次测量相同」再返回（等价稳定点，不引入固定等待）。 */
async function measureStable(page: Page): Promise<CenterGeometry> {
    const deadline = Date.now() + EXPECT_TIMEOUT_MS;
    let previous: CenterGeometry | null = null;
    while (Date.now() < deadline) {
        const current = await measure(page);
        if (
            current &&
            previous &&
            Math.abs(current.treeWidth - previous.treeWidth) < 0.5 &&
            Math.abs(current.mainWidth - previous.mainWidth) < 0.5
        ) {
            return current;
        }
        previous = current;
        await page.waitForTimeout(50);
    }
    throw new Error(
        `中栏几何在 ${EXPECT_TIMEOUT_MS} ms 内未稳定；最后一次测量 = ${JSON.stringify(previous)}`,
    );
}

test.beforeEach(async ({ page }) => {
    await setupMockAuth(page);
    await setupMockSessions(page, { sessions: [{ id: "session-1", title: "Session 1" }] });
});

test("task-353 判据①③：文件树在中栏容器内，收起与展开的宽度可逆", async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(WORKSPACE_PATH);
    await page.waitForSelector(String.raw`[data-testid="workspace-workbench"]`, {
        state: "attached",
        timeout: EXPECT_TIMEOUT_MS,
    });
    await expect(page.getByTestId("workspace-file-tree")).toBeVisible({
        timeout: EXPECT_TIMEOUT_MS,
    });

    const expanded = await measureStable(page);
    const detail = `tree=${expanded.treeWidth.toFixed(1)} main=${expanded.mainWidth.toFixed(1)} center=${expanded.centerWidth.toFixed(1)}`;

    // 判据①：层级（不是可见性）。
    expect(expanded.hasCenter, `中栏容器必须存在；${detail}`).toBe(true);
    expect(expanded.treeInCenter, `文件树 panel 必须在 workspace-center 内；${detail}`).toBe(true);
    expect(expanded.railInCenter, `文件树列壳必须在 workspace-center 内；${detail}`).toBe(true);
    expect(expanded.mainInCenter, `主区必须在同一个容器内；${detail}`).toBe(true);
    expect(expanded.groupInCenter, `splitter group 必须在 workspace-center 内；${detail}`).toBe(
        true,
    );
    expect(expanded.sameGroup, `文件树与主区必须是同一 group 的两道 panel；${detail}`).toBe(true);

    // 展开态的形状基线：树按 PLAN-0582 默认宽（240），主区吃掉其余。
    expect(
        Math.abs(expanded.treeWidth - TREE_WIDTH_DEFAULT),
        `展开态树宽应 ≈ TREE_WIDTH_DEFAULT(${TREE_WIDTH_DEFAULT})；${detail}`,
    ).toBeLessThanOrEqual(2);
    expect(
        Math.abs(expanded.treeWidth + expanded.mainWidth - expanded.centerWidth),
        `树 + 主区应 ≈ 中栏容器宽（±2 px）；${detail}`,
    ).toBeLessThanOrEqual(2);

    mkdirSync(SHOT_DIR, { recursive: true });
    await page.screenshot({ path: resolve(SHOT_DIR, "01-tree-expanded-1920x1080.png") });

    // 判据③ 前半：收起 ⇒ 树变 40px rail，主区吃掉释放的宽度。
    await page.getByTestId("workspace-toolbar-toggle-tree").click();
    await expect(page.getByTestId("workspace-tree-expand")).toBeVisible({
        timeout: EXPECT_TIMEOUT_MS,
    });
    const collapsed = await measureStable(page);
    const collapsedDetail = `tree=${collapsed.treeWidth.toFixed(1)} main=${collapsed.mainWidth.toFixed(1)} center=${collapsed.centerWidth.toFixed(1)}`;
    expect(
        Math.abs(collapsed.treeWidth - TREE_COLLAPSED_WIDTH),
        `收起后树宽应 = TREE_COLLAPSED_WIDTH(${TREE_COLLAPSED_WIDTH})；${collapsedDetail}`,
    ).toBeLessThanOrEqual(2);
    expect(
        Math.abs(
            collapsed.mainWidth - (expanded.mainWidth + expanded.treeWidth - TREE_COLLAPSED_WIDTH),
        ),
        `主区应吃掉树释放的宽度；${collapsedDetail}`,
    ).toBeLessThanOrEqual(2);

    await page.screenshot({ path: resolve(SHOT_DIR, "02-tree-collapsed-1920x1080.png") });

    // 折叠态与宽度分开存（PLAN-0582）：收起**不得**改写持久化的 treeWidth。
    const stored = await page.evaluate(() =>
        JSON.parse(localStorage.getItem("xihe-layout-ws:workspace-1") ?? "{}"),
    );
    expect(stored.treeCollapsed, "收起必须写进 treeCollapsed").toBe(true);
    expect(
        stored.treeWidth,
        `收起不得改写持久化宽度（PLAN-0582：折叠态与宽度分开存）；实际 ${String(stored.treeWidth)}`,
    ).toBe(TREE_WIDTH_DEFAULT);

    // 判据③ 后半：展开 ⇒ 回到原宽（不是回到某个夹取后的值）。
    await page.getByTestId("workspace-tree-expand").click();
    await expect(page.getByTestId("workspace-file-tree")).toBeVisible({
        timeout: EXPECT_TIMEOUT_MS,
    });
    const restored = await measureStable(page);
    const restoredDetail = `tree=${restored.treeWidth.toFixed(1)} main=${restored.mainWidth.toFixed(1)} center=${restored.centerWidth.toFixed(1)}`;
    expect(
        Math.abs(restored.treeWidth - expanded.treeWidth),
        `展开后树宽应回到原宽（±2 px）；before=${expanded.treeWidth.toFixed(1)} ${restoredDetail}`,
    ).toBeLessThanOrEqual(2);
    expect(
        Math.abs(restored.mainWidth - expanded.mainWidth),
        `展开后主区应回到原宽（±2 px）；before=${expanded.mainWidth.toFixed(1)} ${restoredDetail}`,
    ).toBeLessThanOrEqual(2);
});
