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
        const group = document.querySelector(
            String.raw`[data-testid="workspace-workbench"] [data-panel-group]`,
        );
        if (!group) return null;
        const panels = Array.from(group.querySelectorAll("[data-panel]"));
        if (panels.length < 2) return null;
        const g = group.getBoundingClientRect();
        const tree = panels[0]?.getBoundingClientRect();
        const main = panels[1]?.getBoundingClientRect();
        if (!tree || !main) return null;
        return {
            containerWidth: g.width,
            treeWidth: tree.width,
            mainWidth: main.width,
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
});
