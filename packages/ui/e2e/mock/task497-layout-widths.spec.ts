/**
 * task-497：工作台**右栏（dock）宽度有约束** + 主列拿回余量（mock lane，L0 单 spec）。
 *
 * ── 迁移（2026-11-17 · task-65 收尾段 · D-1777 / D-1778）────────────────────────────────
 * 原文件断的是 **dockview 实例里的三栏几何**（`data-dockview-panel="tree"/"main"/"monitor"`）：
 * 树在 dockview 里是**独立 group**，所以「树宽 200–320」「dock 宽 320–480」是两条独立的量。
 * 用户 2026-11-17 裁定（`D-1777`）把树搬进右栏 `files` 面板 ⇒ **树宽 = 右栏 dock 宽**，
 * 「两条独立的量」塌成一条；而 dockview 路径本身还在 S1（`WorkspaceShellDockview.vue`）里
 * 维护树面板、尚未跟上 `files` 面板身份（task-144 ② 在办）⇒ 本文件原来量的是**未跟上模型的那条路径**。
 *
 * **契约仍然有效，所以是迁移不是退场**：本卡要守的是「dock 组有约束（不超 480）+ 主列拿到余量
 * （不再出现 main=100）」，这两件事在**产品路径（手写 dock）**上同样可判 —— 断对象换成
 * `[data-testid="workspace-aux-panel"]`，主列仍是 `[data-testid="workspace-main"]`。
 * 顺带把浮动态的两条用例**退场**（它们断的是 `dockMode: floating` 的存在性，而那是 `D-1754 ④`
 * 判据 3 要消灭的形态 —— 判据**被推翻**，不是前提退场；接手 = task-94 / 判据 3 的裁定）。
 *
 * 本卡的边界（Lead 2026-11-14 裁定）：**640 硬底线与 §1.5-C 让位顺序属 task-504**，不在本卡做。
 * 算术依据：`host 1158 − tree_min 200 − dock_min 320 − 两条缝 ≈ 8 = 630 < 640`。
 *
 * 判据（含 Lead 裁定①：**pinned 档才断言 dock 夹取**）：
 *   ① pinned（1920）：dock 宽落在 320–480；主列拿到余量（本卡中间底线 480，不再是 100）；
 *   ② 树宽 = dock 宽：`workspace-file-tree` 必须按右栏宽渲染（树不再有自己的 200–320 夹取）；
 *   ③ 键盘 End 把 dock 夹到上限并落盘（取整/夹取通道不是装饰）；
 *   ④ 浮动态两条用例：**退场（判据被推翻）**，见文件末墓碑。
 *
 * 跑法：`$env:XIHE_UI_PORT='12737'; pnpm exec playwright test --config e2e/playwright.config.ts
 * e2e/mock/task497-layout-widths.spec.ts`
 */
import { expect, test } from "./helpers/mock-test";
import type { Page } from "@playwright/test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { EXPECT_TIMEOUT_MS } from "../timeouts";
import {
    DOCK_WIDTH_KEYBOARD_STEP,
    DOCK_WIDTH_MAX,
    DOCK_WIDTH_MIN,
    WORKSPACE_LAYOUT_STORAGE_PREFIX,
} from "../../src/composables/useWorkspaceLayout";

const WORKSPACE_PATH = "/workspace/11111111-1111-4111-8111-111111111111";
const LAYOUT_KEY = WORKSPACE_LAYOUT_STORAGE_PREFIX + "11111111-1111-4111-8111-111111111111";
/** 本卡的中间底线（640 属 task-504）。取 480 = dock 夹取上限，低于它说明主列又被吃回去了。 */
const MAIN_INTERIM_FLOOR = 480;

interface Geometry {
    /** 工作台这一行（中栏 + 右栏，不含导航）。 */
    row: number;
    main: number;
    dock: number;
    /** 目录树面板（右栏 files 的身体）的宽。 */
    files: number;
    /** 右栏左缘 / 主列右缘（判「并排不重叠」）。 */
    dockLeft: number;
    mainRight: number;
}

/**
 * 等几何稳定再量（**不是礼貌等待，是判据前提**）。
 *
 * 宿主链上有 `transition-[flex-grow] duration-300`，挂载后宽度从 ~410 长到最终值；
 * 300 ms 内取样会读到中间态（实测 1920 视口中途取到 host=1149 / tree=200 / main=100，
 * 稳定值是 host=1158 / tree=240）。把中间态当缺陷读数会假红，把它当「修好了」会假绿。
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
                    w('[data-testid="workspace-workbench"]'),
                    w('[data-testid="workspace-main"]'),
                    w('[data-testid="workspace-aux-panel"]'),
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

async function openWorkbench(page: Page, viewport = { width: 1920, height: 1080 }): Promise<void> {
    await page.setViewportSize(viewport);
    await page.goto(WORKSPACE_PATH);
    await page.waitForSelector('[data-testid="workspace-main"]', {
        state: "attached",
        timeout: EXPECT_TIMEOUT_MS,
    });
    // 1920 视口 pinned ⇒ 右栏是实例内正常列，且首启默认 active 页签是 files（D-1777）。
    await page.waitForSelector('[data-testid="workspace-aux-panel"]', {
        state: "visible",
        timeout: EXPECT_TIMEOUT_MS,
    });
    await waitForStableGeometry(page);
}

/** 两栏 + 行宽（取真实几何，不是 store 值）。 */
async function geometry(page: Page): Promise<Geometry> {
    return page.evaluate(() => {
        const box = (sel: string): DOMRect | null => {
            const el = document.querySelector(sel);
            return el ? el.getBoundingClientRect() : null;
        };
        const row = box('[data-testid="workspace-workbench"]');
        const main = box('[data-testid="workspace-main"]');
        const dock = box('[data-testid="workspace-aux-panel"]');
        const files = box('[data-testid="workspace-file-tree"]');
        return {
            row: row ? Math.round(row.width) : -1,
            main: main ? Math.round(main.width) : -1,
            dock: dock ? Math.round(dock.width) : -1,
            files: files ? Math.round(files.width) : -1,
            dockLeft: dock ? dock.left : -1,
            mainRight: main ? main.right : -1,
        };
    });
}

async function storedDockWidth(page: Page): Promise<number | null> {
    return page.evaluate((key) => {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as { dockWidth?: unknown };
        return typeof parsed.dockWidth === "number" ? parsed.dockWidth : null;
    }, LAYOUT_KEY);
}

test.beforeEach(async ({ page }) => {
    await setupMockAuth(page);
    await setupMockSessions(page, { sessions: [{ id: "session-1", title: "Session 1" }] });
});

test("① pinned（1920）：dock 落进 320–480 夹取区间，主列不再被压到 100", async ({ page }) => {
    await openWorkbench(page);
    const g = await geometry(page);
    const reading = "row=" + g.row + " main=" + g.main + " dock=" + g.dock + " files=" + g.files;
    console.log("[task497/migrated]", JSON.stringify(g));

    // 前提：右栏必须是**正常列**（并排不重叠），否则下面量到的是 overlay 的宽。
    expect(g.dock, "右栏必须有实际宽度（" + reading + "）").toBeGreaterThan(0);
    expect(
        g.dockLeft,
        "右栏左缘必须 ≥ 主列右缘（右栏是正常列，不是 overlay；" + reading + "）",
    ).toBeGreaterThanOrEqual(g.mainRight - 1);

    // ① dock 夹取：320–480
    expect(g.dock, "dock 宽 " + g.dock + " 不在 320–480（" + reading + "）").toBeGreaterThanOrEqual(
        DOCK_WIDTH_MIN,
    );
    expect(g.dock, "dock 宽 " + g.dock + " 超出夹取上限（" + reading + "）").toBeLessThanOrEqual(
        DOCK_WIDTH_MAX,
    );

    // ② 主列拿回余量（本卡中间底线；640 属 task-504）
    expect(
        g.main,
        "主列被压到 " +
            g.main +
            "（本卡底线 " +
            MAIN_INTERIM_FLOOR +
            "；640 底线属 task-504）—— " +
            reading,
    ).toBeGreaterThanOrEqual(MAIN_INTERIM_FLOOR);

    // ③ 树宽 = dock 宽（**本文件迁移后的新判据**）：树不再有自己独立的 200–320 夹取，
    //    它就是右栏 files 面板的身体 ⇒ 差超过 4 px 说明「树还是独立一列」的旧结构回来了。
    expect(g.files, "目录树身体必须存在（" + reading + "）").toBeGreaterThan(0);
    expect(
        Math.abs(g.files - g.dock),
        "树宽应 = 右栏宽（树不再有独立列宽；" + reading + "）",
    ).toBeLessThanOrEqual(4);

    // ④ 两栏吃掉整行（行宽没被第三方面板吃掉）
    expect(
        Math.abs(g.main + g.dock - g.row),
        "主列 + 右栏应 ≈ 行宽 ±2 px（" + reading + "）",
    ).toBeLessThanOrEqual(2);
});

test("② 键盘 End：dock 夹到上限并落盘（夹取/写盘通道不是装饰）", async ({ page }) => {
    await openWorkbench(page);
    const resizer = page.locator('[data-testid="dock-resizer"]');
    await resizer.focus();
    await page.keyboard.press("End");
    await expect
        .poll(() => storedDockWidth(page), { timeout: EXPECT_TIMEOUT_MS })
        .toBe(DOCK_WIDTH_MAX);
    await expect
        .poll(() => geometry(page).then((g) => g.dock), { timeout: EXPECT_TIMEOUT_MS })
        .toBe(DOCK_WIDTH_MAX);
    const g = await geometry(page);
    const reading = "row=" + g.row + " main=" + g.main + " dock=" + g.dock + " files=" + g.files;
    console.log("[task497/migrated] keyboard-end", JSON.stringify(g));
    // 树宽跟着 dock 宽走（同一份几何），主列仍不被吃穿。
    expect(
        Math.abs(g.files - g.dock),
        "树宽应随 dock 宽一起变（" + reading + "）",
    ).toBeLessThanOrEqual(4);
    expect(
        g.main,
        "dock 取最大宽后主列仍需 ≥ " + MAIN_INTERIM_FLOOR + "（实际 " + g.main + "）",
    ).toBeGreaterThanOrEqual(MAIN_INTERIM_FLOOR);
    // 键盘步长常量仍归产品所有：本卡只确认「End 到上限」，方向键步长的判据在 dock 手柄自己的用例里。
    expect(DOCK_WIDTH_KEYBOARD_STEP, "键盘步长常量必须仍被产品导出（防删）").toBeGreaterThan(0);
});

/**
 * ── 墓碑：浮动态（1440 / 1024）两条用例**被推翻**（不是前提退场）────────────────────────
 *
 * 原判据（Lead 裁定①的负向那一半）：窄视口派生 `dockMode: floating` ⇒ 右栏**不在 dockview 实例内**、
 * 全页 `.dv-sash` 仅 1 条。它断的是「浮动态存在且可识别」。
 *
 * **推翻依据**：`D-1754 ④` 判据 3（用户 2026-11-17 原话「我们现在没有设计浮窗的」）要求
 * 「右栏**不得是浮窗/overlay**」⇒ 「浮动态存在」不再是特性，而是待消灭的形态。
 * 于是这两条不是「对象没了」，是**判据方向被推翻**：它们越绿，说明我们离用户要的越远。
 * （Lead 明确否定过「保留 floating 仅作兜底、隐藏 toggle」的读法：`D-1754 ④` 原文是「不得是浮窗」，
 * 不能读成「偷偷留着用」。）
 *
 * 接手（task-162 后已落地）：`D-1754 ④` 判据 3 退场已实施——`deriveDockMode` / `dockModeManual`
 * 已删、`DockMode` 收窄为 `"pinned"` 单值；届时窄视口应断「右栏仍是正常列」
 * 而不是「右栏不在实例内」。本墓碑保留作历史判据记录，不随退场删除。
 */
test.describe.skip("已退场：浮动态（被 D-1754 ④ 判据 3 推翻，等用户裁定退场方案）", () => {
    for (const viewport of [
        { width: 1440, height: 900 },
        { width: 1024, height: 768 },
    ]) {
        test.skip(
            viewport.width + "（floating）：右栏不在实例内 + 两栏几何仍成立【被推翻】",
            () => {
                // 旧判据：`dockPanel`（data-dockview-panel="monitor" 的计数）=== 0、`.dv-sash` === 1、
                // 主列 ≥ 480、树宽 ∈ {40} ∪ [200,320]。
                // 退场依据：它断的是 floating 形态**存在**；而用户要的是 floating **不存在**。
            },
        );
    }
});
