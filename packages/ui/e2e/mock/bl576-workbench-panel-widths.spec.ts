/**
 * BL-576 守卫（真实布局）：工作台**两栏**的宽度几何。
 *
 * ── 迁移（2026-11-17 · task-65 收尾段 · D-1777 / D-1778）────────────────────────────────
 * 本文件原断的是「中栏容器**内层 splitter** 的两道 panel（树 | 主区）」，BL-576 的病征是
 * 「主列被压成 5 px」。用户 2026-11-17 裁定把树搬进右栏的 files 面板（D-1777）后，内层 splitter
 * **整个退场**（工作台只剩 flex 列）⇒ 原断对象不存在。
 *
 * **但契约本身仍然有效，所以这是「迁移」不是「退场」**：BL-576 要守的是「主列不得被另一栏吃掉」，
 * 而今天吃主列的那一栏就是**右栏 dock** ⇒ 断对象从「树 panel」换成
 * `[data-testid="workspace-aux-panel"]`，判据 ④ 从「树 ≤ TREE_WIDTH_MAX」换成
 * 「右栏 ≤ DOCK_WIDTH_MAX」。判据强度不降：5 px 级坍缩照样红。
 *
 * 为什么要 e2e 而不是 jsdom 单测：`data-panel-size` 只是 inline `flex-grow` 的回声，reka 的
 * layout 为空时会回落到 default-size ⇒ 单测只能证明「默认尺寸配置正确」，证明不了「layout 已初始化」。
 * BL-576 的病征（主列 5 px）只有真实布局才能观察到，右栏也一样。
 *
 * 三条断言各管一段，**别把 ① 当守卫**：
 *   ① 主列宽 > 0              —— 形状检查（5 px 也 > 0，pre-E 上照样绿）
 *   ② 主列宽 ≥ 行宽 30%       —— 守卫之一（BL-576 时 pre-E 实测 mainWidth=5.0）
 *   ③ 主列宽 + 右栏宽 ≈ 行宽（±2 px）—— **不是本 bug 的守卫**，职责见其注释
 *   ④ 右栏宽 ≤ DOCK_WIDTH_MAX + 2 —— 守卫之二（取代原「树 ≤ TREE_WIDTH_MAX」：max-size 失效时
 *     右栏会吃到行宽的 100%）
 * 断言消息一律带 mainWidth / dockWidth / rowWidth：红了要能直接读出「主列 5 px」。
 */
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import type { Page } from "@playwright/test";
import { EXPECT_TIMEOUT_MS } from "../timeouts";
import { DOCK_WIDTH_MAX, DOCK_WIDTH_MIN } from "../../src/composables/useWorkspaceLayout";

const WORKSPACE_PATH = "/workspace/11111111-1111-4111-8111-111111111111";

interface PanelGeometry {
    /** 工作台这一行的可用宽（= 中栏列 + 右栏，不含导航）。 */
    rowWidth: number;
    /** 中栏容器内的主列（会话/文件内容）。 */
    mainWidth: number;
    /** 右栏容器（dock）**自身**的宽 —— 原「树宽」的量法位置。 */
    dockWidth: number;
}

/** 直读几何（不用固定 sleep）：调用方负责轮询到稳定。 */
async function measure(page: Page): Promise<PanelGeometry | null> {
    return page.evaluate(() => {
        // 按 testid 定位，**不按 index**：index 依赖 DOM 顺序，结构一改就静默错位
        // （旧写法 `panels[0]` 会把主区当成树来量，量出来的数还对得上）。
        const root = document.querySelector('[data-testid="workspace-workbench"]');
        const center = document.querySelector('[data-testid="workspace-center"]');
        const main = document.querySelector('[data-testid="workspace-main"]');
        const dock = document.querySelector('[data-testid="workspace-aux-panel"]');
        if (!root || !center || !main || !dock) return null;
        // 层级（判据⑤的量法侧）：右栏与中栏列是**同一行的两个兄弟**（右栏不是 overlay、也不在
        // main 里面）；没有这条，同一个量法在「右栏盖在主列上」的结构上也能全绿。
        if (dock.parentElement !== center.parentElement) return null;
        const row = root.getBoundingClientRect();
        return {
            rowWidth: row.width,
            mainWidth: main.getBoundingClientRect().width,
            dockWidth: dock.getBoundingClientRect().width,
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
            Math.abs(current.dockWidth - previous.dockWidth) < 0.5 &&
            Math.abs(current.rowWidth - previous.rowWidth) < 0.5
        ) {
            return current;
        }
        previous = current;
        await page.waitForTimeout(50);
    }
    throw new Error(
        "两栏几何在 " +
            EXPECT_TIMEOUT_MS +
            " ms 内未稳定；最后一次测量 = " +
            JSON.stringify(previous),
    );
}

test.beforeEach(async ({ page }) => {
    await setupMockAuth(page);
    await setupMockSessions(page, { sessions: [{ id: "session-1", title: "Session 1" }] });
});

test("BL-576 守卫：主列不是坍缩态，右栏在 dock 夹取区间内且两栏吃掉整行宽度", async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(WORKSPACE_PATH);
    await page.waitForSelector('[data-testid="workspace-workbench"]', {
        state: "attached",
        timeout: EXPECT_TIMEOUT_MS,
    });
    // 1980+ 视口首启右栏默认开 files 面板（D-1777：右侧容器显示目录树组件）——
    // 没有它就说明右栏没渲染，下面的数会被量成 0（先钉「对象在」再钉数）。
    await page.waitForSelector('[data-testid="workspace-aux-panel"]', {
        state: "visible",
        timeout: EXPECT_TIMEOUT_MS,
    });

    const geom = await measureStable(page);
    const round = (value: number) => value.toFixed(1);
    const ratio = round((geom.mainWidth / geom.rowWidth) * 100);
    // 读数无条件打出来 —— 通过时断言消息不进报告，改前/改后就没法对比数字。
    console.log("[bl576/migrated]", JSON.stringify(geom));
    const detail =
        "mainWidth=" +
        round(geom.mainWidth) +
        " dockWidth=" +
        round(geom.dockWidth) +
        " rowWidth=" +
        round(geom.rowWidth) +
        " mainRatio=" +
        ratio +
        "%";

    // ① 形状检查：宽 > 0（注意：5 px 也满足，它不是守卫）。
    expect(geom.mainWidth, "主列宽应 > 0（形状检查）；" + detail).toBeGreaterThan(0);

    // ② 守卫之一：主列至少占行宽 30%（BL-576 时是 5 px ⇒ 必红）。
    //    用 soft：②③④ 各自独立归因，一次运行能同时看到「哪几条被违反」。
    expect
        .soft(geom.mainWidth, "主列宽应 ≥ 行宽 30%（BL-576 的坍缩会让它变成个位数 px）；" + detail)
        .toBeGreaterThanOrEqual(geom.rowWidth * 0.3);

    // ④ 守卫之二（迁移后）：右栏不得超过它自己声明的最大宽（否则 max-size 约束失效 ——
    //    preE 里树是 1208 px，同一失效形态换到右栏就是右栏吃掉整行）。
    //    与 ② 独立：② 管主列下限、④ 管右栏上限，可各自单独失败。
    expect
        .soft(
            geom.dockWidth,
            "右栏宽应 ≤ DOCK_WIDTH_MAX(" +
                DOCK_WIDTH_MAX +
                ") + 2 px，超过说明 max-size 约束失效；" +
                detail,
        )
        .toBeLessThanOrEqual(DOCK_WIDTH_MAX + 2);
    // 右栏也不得低于夹取下界（低于它是另一个方向的失效：右栏被挤成装饰）。
    expect
        .soft(geom.dockWidth, "右栏宽应 ≥ DOCK_WIDTH_MIN(" + DOCK_WIDTH_MIN + ")；" + detail)
        .toBeGreaterThanOrEqual(DOCK_WIDTH_MIN - 2);

    // ③ 的职责是「行宽没被第三方面板吃掉」，不是「主列没坍缩」。
    //    BL-576 在 preE 上它也是绿的（tree 1208 + main 5 = 1213 = 行宽）。
    expect
        .soft(
            Math.abs(geom.mainWidth + geom.dockWidth - geom.rowWidth),
            "主列宽 + 右栏宽应 ≈ 行宽（±2 px）；" + detail,
        )
        .toBeLessThanOrEqual(2);

    // ⑤ 层级（判据①的量法侧）：上面三个数只在「树是右栏面板、右栏是正常列」时才有意义。
    //    没有这条，同一个量法在改造前的结构（树是独立列、文件内容在右栏）上也全绿 ——
    //    那就成了「量的是旧结构、报的是新结构」的假绿。
    const hierarchy = await page.evaluate(() => {
        const center = document.querySelector('[data-testid="workspace-center"]');
        const dock = document.querySelector('[data-testid="workspace-aux-panel"]');
        const main = document.querySelector('[data-testid="workspace-main"]');
        const filesBody = document.querySelector('[data-testid="workspace-file-tree"]');
        const railColumns = document.querySelectorAll('[data-testid="workspace-file-rail"]').length;
        return {
            sameRow: dock != null && center != null && dock.parentElement === center.parentElement,
            dockRightOfMain:
                dock != null && main != null
                    ? dock.getBoundingClientRect().left >= main.getBoundingClientRect().right - 1
                    : null,
            filesInDock: dock != null && filesBody != null && dock.contains(filesBody),
            // 树**不再占独立列**：展开态下不该有那条 40px 折叠窄轨（它只在折叠时出现）。
            railColumns,
        };
    });
    console.log("[bl576/migrated] hierarchy", JSON.stringify(hierarchy));
    expect(hierarchy.sameRow, "右栏与中栏列必须是同一行的兄弟（判据⑤：右栏是正常列）").toBe(true);
    expect(hierarchy.dockRightOfMain, "右栏必须排在主列右侧（不是 overlay 盖住主列）").toBe(true);
    expect(hierarchy.filesInDock, "目录树必须渲染在右栏面板内（D-1777）").toBe(true);
    expect(hierarchy.railColumns, "展开态下树不得再占独立列（rail 只在折叠时出现）").toBe(0);
});
