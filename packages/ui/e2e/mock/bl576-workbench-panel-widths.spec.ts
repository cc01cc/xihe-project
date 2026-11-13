/**
 * BL-576 守卫（真实布局）：工作台内层 splitter 两个面板的宽度几何。
 *
 * 为什么必须在 e2e 而不是 jsdom 单测：`data-panel-size` 只是 inline `flex-grow` 的回声（reka-ui
 * `SplitterPanel.js:124` 写的是 `flexGrow.toFixed(1)`），layout 为空时它回落到 default-size
 * ⇒ 单测只能证明「默认尺寸配置正确」，证明不了「layout 已初始化」。BL-576 的病征是
 * **主列被压成 5 px**，那是只有真实布局才能观察到的事实。
 *
 * 三条断言各管一段，**别把 ① 当守卫**：
 *   ① 主列宽 > 0          —— 形状检查（5 px 也 > 0，pre-E 上照样绿）
 *   ② 主列宽 ≥ 容器宽 30% —— 守卫之一（pre-E 上红，实测 mainWidth=5.0 / 容器 1213.0）
 *   ④ 树宽 ≤ TREE_WIDTH_MAX + 2 —— 守卫之二（pre-E 树 1208 px ⇒ 红；② 与 ④ 可各自独立失败）
 *   ③ 树宽 + 主列宽 ≈ 容器宽（±2 px）—— **不是本 bug 的守卫**，职责见其注释
 * 断言消息一律带 mainWidth / containerWidth：红了要能直接读出「主列 5 px」。
 */
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import type { Page } from "@playwright/test";
import { EXPECT_TIMEOUT_MS } from "../timeouts";
import { TREE_WIDTH_MAX } from "../../src/composables/useWorkspaceLayout";

const WORKSPACE_PATH = "/workspace/workspace-1";

interface PanelGeometry {
    containerWidth: number;
    treeWidth: number;
    mainWidth: number;
}

/** 直读几何（不用固定 sleep）：调用方负责轮询到稳定。 */
async function measure(page: Page): Promise<PanelGeometry | null> {
    return page.evaluate(() => {
        // task-353（D-1207 甲案）后：工作台里只剩**一道** group —— 中栏容器内部那道，
        // 两道 panel 是 [文件树 | 主区]。面板**按 testid 定位，不按 index**：index 依赖 DOM
        // 顺序，结构一改就静默错位（旧写法 `panels[0]` 会把主区当成树来量，量出来的数还对得上）。
        const center = document.querySelector('[data-testid="workspace-center"]');
        const group = center?.querySelector("[data-panel-group]") ?? null;
        if (!center || !group) return null;
        const tree = document
            .querySelector('[data-testid="workspace-file-rail"]')
            ?.closest("[data-panel]");
        const main = document
            .querySelector('[data-testid="workspace-main"]')
            ?.closest("[data-panel]");
        if (!tree || !main) return null;
        // 层级（判据①的量法侧）：两块 panel 都在中栏容器内，且是同一 group 的兄弟。
        if (!center.contains(tree) || !center.contains(main)) return null;
        if (tree.parentElement !== main.parentElement) return null;
        const g = group.getBoundingClientRect();
        return {
            containerWidth: g.width,
            treeWidth: tree.getBoundingClientRect().width,
            mainWidth: main.getBoundingClientRect().width,
        };
    });
}

/** 轮询到「连续两次测量相同」再返回（等价稳定点，不引入固定等待）。 */
async function measureStable(page: Page): Promise<PanelGeometry> {
    const deadline = Date.now() + EXPECT_TIMEOUT_MS;
    let previous: PanelGeometry | null = null;
    while (Date.now() < deadline) {
        const current = await measure(page);
        if (
            current &&
            previous &&
            Math.abs(current.mainWidth - previous.mainWidth) < 0.5 &&
            Math.abs(current.treeWidth - previous.treeWidth) < 0.5 &&
            Math.abs(current.containerWidth - previous.containerWidth) < 0.5
        ) {
            return current;
        }
        previous = current;
        await page.waitForTimeout(50);
    }
    throw new Error(
        `splitter 几何在 ${EXPECT_TIMEOUT_MS} ms 内未稳定；最后一次测量 = ${JSON.stringify(previous)}`,
    );
}

test.beforeEach(async ({ page }) => {
    await setupMockAuth(page);
    await setupMockSessions(page, { sessions: [{ id: "session-1", title: "Session 1" }] });
});

test("BL-576 守卫：主列不是坍缩态，两面板按百分比分配且吃掉整行宽度", async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(WORKSPACE_PATH);
    await page.waitForSelector(String.raw`[data-testid="workspace-workbench"]`, {
        state: "attached",
        timeout: EXPECT_TIMEOUT_MS,
    });

    const geom = await measureStable(page);
    const round = (value: number) => value.toFixed(1);
    const ratio = round((geom.mainWidth / geom.containerWidth) * 100);
    // task-353：把读数无条件打出来 —— 通过时断言消息不进报告，改前/改后就没法对比数字。
    console.log("[bl576]", JSON.stringify(geom));
    const detail =
        `mainWidth=${round(geom.mainWidth)} treeWidth=${round(geom.treeWidth)} ` +
        `containerWidth=${round(geom.containerWidth)} mainRatio=${ratio}%`;

    // ① 形状检查：宽 > 0（注意：5 px 也满足，它不是守卫）。
    expect(geom.mainWidth, `主列宽应 > 0（形状检查）；${detail}`).toBeGreaterThan(0);

    // ② 守卫之一：主列至少占容器宽 30%（BL-576 时是 5 px ⇒ 必红）。
    //    用 soft：②③④ 各自独立归因，一次运行能同时看到「哪几条被违反」，而不是只看第一条。
    expect
        .soft(
            geom.mainWidth,
            `主列宽应 ≥ 容器宽 30%（BL-576 的坍缩会让它变成个位数 px）；${detail}`,
        )
        .toBeGreaterThanOrEqual(geom.containerWidth * 0.3);

    // ④ 守卫之二：文件树不得超过它自己声明的最大宽（否则 max-size 约束失效 —— preE 里树是 1208 px）。
    //    与 ② 独立：② 管主列下限、④ 管树上限，可各自单独失败。
    expect
        .soft(
            geom.treeWidth,
            `树宽应 ≤ TREE_WIDTH_MAX(${TREE_WIDTH_MAX}) + 2 px，超过说明 max-size 约束失效；${detail}`,
        )
        .toBeLessThanOrEqual(TREE_WIDTH_MAX + 2);

    // ③ 的职责是「容器宽度没被第三方面板吃掉」，不是「主列没坍缩」。
    //    BL-576 在 preE 上它也是绿的（tree 1208 + main 5 = 1213 = 容器宽，宽度没被吃掉，是文件树把它吃掉了）。
    //    能抓它的是 ②（主列 ≥30%）与 ④（树 ≤ TREE_WIDTH_MAX）。@see BL-576
    expect
        .soft(
            Math.abs(geom.treeWidth + geom.mainWidth - geom.containerWidth),
            `树宽 + 主列宽应 ≈ 容器宽（±2 px）；${detail}`,
        )
        .toBeLessThanOrEqual(2);
    // ⑤ 层级（task-353 判据① 的量法侧）：上面四个数只在「group 位于中栏容器内」时才有意义。
    //    没有这条，同一个量法在改造前的结构（group = 工作台根下那道、树是第三列）上也全绿 ——
    //    那就成了「量的是旧结构、报的是新结构」的假绿。
    const hierarchy = await page.evaluate(() => {
        const center = document.querySelector('[data-testid="workspace-center"]');
        const rail = document.querySelector('[data-testid="workspace-file-rail"]');
        return {
            groupInCenter: center?.querySelector("[data-panel-group]") != null,
            railInCenter: center != null && rail != null && center.contains(rail),
        };
    });
    expect(hierarchy.groupInCenter, "splitter group 必须在中栏容器内（判据①的量法侧）").toBe(true);
    expect(hierarchy.railInCenter, "文件树列壳必须在中栏容器内（判据①b）").toBe(true);
});
