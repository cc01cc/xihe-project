/**
 * task-2（原 task-613）：**指针拖拽 SplitterPanel 不回退**的回归判据（mock lane，L0 单 spec）。
 *
 * ── 前提退场（2026-11-17 · task-65 收尾段 · D-1777 / D-1778）────────────────────────────
 * 本文件原本 8 条判据的被测对象是**工作台内层的 reka SplitterGroup**：WorkspaceWorkbench.vue
 * 的第一道 SplitterPanel = 文件树列（[data-testid="workspace-file-rail"] + tree-resizer）。
 * 用户 2026-11-17 两句裁定把树从中栏的一列改成**右栏的 files 面板**：
 *   · D-1777「右侧容器显示目录树组件」⇒ 树归右栏容器；
 *   · D-1778「两栏等价 ⇒ 树必须先是普通面板」⇒ 树不再占容器级特例。
 * 结果：**内层 SplitterGroup 整个退场**（工作台今天只剩 flex 列），树的宽度语义从 reka 百分比
 * splitter 改成**右栏 dock 宽（px）**。⇒ 这不是「断言写错」，是**判据对、对象没了**
 * （**前提退场**；与 task353-center-container.spec.ts 的「判据被推翻」是两回事，别合并成一句）。
 *
 * ── 为什么本文件**没有**整条 skip（Lead 裁定要求先回答的问题）──────────────────────────
 * 问：Splitter 指针拖拽这条契约今天还有对象吗？**有。**
 *   · **外层** reka SplitterGroup（AppLayout.vue:402：「导航 | 内容」两道 panel，手柄
 *     [data-testid="sidebar-resizer"]）不但还在，而且走的是**同一个** useSplitterPanelBridge
 *     —— task-2 修的那个失效机制（函数 ref 每 patch 回调 ⇒ 每帧 bootstrap ⇒ 把 reka 刚应用的
 *     增量撤回去）在这条路径上**依然存在**；
 *   · ⇒ 通用判据（拖拽每点生效 + 每点恰 1 次 layout 写入 + release 落盘 + 键盘步长不是 reka 的
 *     百分比默认值）**改断对象后仍可判**，因此它**迁移保留**；只有「树作为 splitter panel」的
 *     专属判据走墓碑（文件末 test.describe.skip）。
 *   · 原 ④ 判的就是 nav 手柄，随迁移并入新 ①/② —— 同一条契约不在两处量。
 *
 * ── 判据对象迁移对照 ────────────────────────────────────────────────────────────────
 * 原 ① 树拖拽（rail 240 → ≠240，每点 1 次写入）→ 新 ① 导航分隔条（336 → 更宽，5 点单调 + 每点 1 次写入）
 * 原 ② reload 后宽度保持                      → 新 ② xihe-layout-global.navWidth 落盘 + reload 保持
 * 原 ③ 键盘 240→201（方向不反）                → 新 ③ ArrowRight×3 = +48；End = clamp 到 NAV_WIDTH_MAX
 * 原 ④ 外层 nav 手柄有效                       → 并入新 ①/②（同一对象）
 * 原 ⑤⑥⑦⑧ 树作为 splitter panel 的专属判据     → 墓碑（逐条理由见文件末）
 *
 * 跑法：$env:XIHE_UI_PORT='12788'; pnpm exec playwright test --config e2e/playwright.config.ts
 * e2e/mock/task2-splitter-pointer-drag.spec.ts
 */
import { expect, test } from "./helpers/mock-test";
import type { Page } from "@playwright/test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { EXPECT_TIMEOUT_MS } from "../timeouts";
import {
    GLOBAL_LAYOUT_STORAGE_KEY,
    NAV_WIDTH_DEFAULT,
    NAV_WIDTH_KEYBOARD_STEP,
    NAV_WIDTH_MAX,
    RAIL_WIDTH,
} from "../../src/composables/useWorkspaceLayout";

const WORKSPACE_PATH = "/workspace/11111111-1111-4111-8111-111111111111";

interface Reading {
    /** nav 面板（splitter panel #1）的真实几何宽度（小数，别取整：取整会把 0.5px 的差别抹掉）。 */
    panel: number;
    /** 持久化的 navWidth（**不含** 56px 折叠条：panel = RAIL_WIDTH + navWidth）。 */
    stored: number | null;
}

async function read(page: Page): Promise<Reading> {
    return page.evaluate((key) => {
        const handle = document.querySelector('[data-testid="sidebar-resizer"]');
        const group = handle?.closest("[data-panel-group]") ?? null;
        const children = group ? [...group.children] : [];
        const panel =
            (children.find((el) => el.hasAttribute("data-panel")) as HTMLElement | undefined) ??
            null;
        let stored: number | null = null;
        try {
            const parsed = JSON.parse(localStorage.getItem(key) ?? "{}") as { navWidth?: unknown };
            if (typeof parsed.navWidth === "number") stored = parsed.navWidth;
        } catch {
            /* 忽略解析失败：判据会以 null 报出来 */
        }
        return { panel: panel ? panel.getBoundingClientRect().width : -1, stored };
    }, GLOBAL_LAYOUT_STORAGE_KEY);
}

/** 一帧渲染（两个 rAF：布局+绘制都落定），不是 sleep 占位。 */
async function frame(page: Page): Promise<void> {
    await page.evaluate(
        () =>
            new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
    );
}

/** 等几何与 store 都稳定（连续两次一致），不裸读中间帧。 */
async function settle(page: Page): Promise<Reading> {
    // 稳定窗口 350ms：宿主链有 transition-[flex-grow] duration-300（AppLayout / Sidebar 两处），
    // 两帧相同不足以排除过渡中间态（task-497 的 waitForStableGeometry 是同一口径，不另造一套）。
    let previous = await read(page);
    let stableSince = Date.now();
    for (let i = 0; i < 120; i += 1) {
        await frame(page);
        const current = await read(page);
        if (Math.abs(current.panel - previous.panel) >= 0.01) stableSince = Date.now();
        else if (Date.now() - stableSince >= 350) return current;
        previous = current;
    }
    throw new Error("几何未稳定：" + JSON.stringify(previous));
}

/** 等去抖写盘（useWorkspaceLayout 的 writer 是合并写），返回落盘值。 */
async function waitForStored(page: Page, expected: number | null): Promise<number> {
    for (let i = 0; i < 80; i += 1) {
        const current = await read(page);
        if (current.stored !== null && (expected === null || current.stored === expected)) {
            return current.stored;
        }
        await page.waitForTimeout(50);
    }
    const last = await read(page);
    throw new Error(
        "写盘后仍未命中：期望 " +
            (expected === null ? "(非空)" : expected) +
            "，实际 " +
            JSON.stringify(last),
    );
}

/** 在 nav 面板上装 style 写入探针（数次数，不看最终值）。 */
async function installStyleProbe(page: Page): Promise<void> {
    await page.evaluate(() => {
        const box = globalThis as unknown as {
            __xhStyleWrites: string[];
            __xhStyleObs?: MutationObserver;
        };
        const handle = document.querySelector('[data-testid="sidebar-resizer"]');
        const group = handle?.closest("[data-panel-group]") ?? null;
        const children = group ? [...group.children] : [];
        const panel =
            (children.find((el) => el.hasAttribute("data-panel")) as HTMLElement | undefined) ??
            null;
        if (!panel) throw new Error("style 探针找不到 nav 面板（splitter panel #1）");
        box.__xhStyleObs?.disconnect();
        box.__xhStyleWrites = [];
        const obs = new MutationObserver((records) => {
            for (let i = 0; i < records.length; i += 1) {
                box.__xhStyleWrites.push(panel.style.flexGrow);
            }
        });
        obs.observe(panel, { attributes: true, attributeFilter: ["style"] });
        box.__xhStyleObs = obs;
    });
}

async function styleWriteCount(page: Page): Promise<number> {
    return page.evaluate(
        () =>
            (globalThis as unknown as { __xhStyleWrites?: string[] }).__xhStyleWrites?.length ?? -1,
    );
}

async function dragHandle(page: Page, testid: string, deltas: number[]): Promise<void> {
    const handle = page.locator('[data-testid="' + testid + '"]');
    const box = await handle.boundingBox();
    if (!box) throw new Error(testid + " 没有 boundingBox");
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await frame(page);
    await page.mouse.down();
    await frame(page);
    for (const dx of deltas) {
        await page.mouse.move(cx + dx, cy, { steps: 1 });
        await frame(page);
    }
    await page.mouse.up();
    await frame(page);
}

async function openWorkbench(page: Page): Promise<void> {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(WORKSPACE_PATH);
    await page.waitForSelector('[data-testid="workspace-workbench"]', {
        state: "attached",
        timeout: EXPECT_TIMEOUT_MS,
    });
    // 1920 视口 nav 不 yield ⇒ 手柄必在（导航收起时它才 v-if 掉）。
    await page.waitForSelector('[data-testid="sidebar-resizer"]', {
        state: "visible",
        timeout: EXPECT_TIMEOUT_MS,
    });
    await frame(page);
}

test.beforeEach(async ({ page }) => {
    await setupMockAuth(page);
    await setupMockSessions(page, { sessions: [{ id: "session-1", title: "Session 1" }] });
});

test("① 指针拖拽 5 点（导航分隔条）：panel 变宽，每点恰 1 次 style 写入", async ({ page }) => {
    await openWorkbench(page);
    const before = await settle(page);
    expect(
        Math.abs(before.panel - (RAIL_WIDTH + NAV_WIDTH_DEFAULT)),
        "起点应是默认 nav 宽（panel = RAIL_WIDTH(" + RAIL_WIDTH + ") + " + NAV_WIDTH_DEFAULT + "）",
    ).toBeLessThanOrEqual(2);

    await installStyleProbe(page);
    const handle = page.locator('[data-testid="sidebar-resizer"]');
    const box = await handle.boundingBox();
    if (!box) throw new Error("sidebar-resizer 没有 boundingBox");
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await frame(page);
    await page.mouse.down();
    await frame(page);
    // 按下之后再装探针：只数「拖拽期」的写入，按下那一帧的 re-init 不算。
    await installStyleProbe(page);

    const samples: Reading[] = [];
    // 向右拖 ⇒ 导航（左面板）变宽；+8 +16 +24 +32 +40 五点全在 220–360 的 nav 夹取区间内。
    for (const dx of [8, 16, 24, 32, 40]) {
        await page.mouse.move(cx + dx, cy, { steps: 1 });
        await frame(page);
        samples.push(await read(page));
    }
    const writesDuringDrag = await styleWriteCount(page);
    await page.mouse.up();
    await frame(page);

    console.log(
        "[task2/migrated] drag-samples",
        JSON.stringify(samples.map((s) => ({ panel: +s.panel.toFixed(2), stored: s.stored }))),
        "styleWrites=",
        writesDuringDrag,
    );

    // ①-a 每点都变，且单调递增（方向：向右拖 ⇒ nav 变宽）。
    for (const sample of samples) {
        expect(sample.panel, "拖拽中 nav 面板不得停在起点宽").toBeGreaterThan(before.panel - 1);
    }
    for (let i = 1; i < samples.length; i += 1) {
        expect(samples[i]!.panel, "nav 面板应随拖拽单调递增（每点都真的生效）").toBeGreaterThan(
            samples[i - 1]!.panel,
        );
    }

    // ①-b 拖拽期 style 写入次数 = 拖拽点数。
    //     旧形态（每次 patch 都 bootstrap）= reka 一次 + 回写一次 = 2× ⇒ 这条必然红；
    //     task-2 修的就是这一条。对象从树面板换成 nav 面板，**判别力不变**。
    expect(writesDuringDrag, "拖拽期每点只该有 1 次 layout 写入（回写会变成 2×）").toBe(
        samples.length,
    );

    // ①-c release 落盘：panel − RAIL_WIDTH 就是 navWidth，且比默认值大。
    const after = await settle(page);
    const storedAfter = await waitForStored(page, after.stored);
    console.log(
        "[task2/migrated] after-release",
        JSON.stringify({ ...after, stored: storedAfter }),
    );
    expect(after.panel, "release 后应明显变宽").toBeGreaterThan(before.panel + 30);
    expect(
        Math.abs(after.panel - (RAIL_WIDTH + storedAfter)),
        "panel(" +
            after.panel +
            ") 应 = RAIL_WIDTH(" +
            RAIL_WIDTH +
            ") + 落盘 navWidth(" +
            storedAfter +
            ")",
    ).toBeLessThanOrEqual(2);
    expect(storedAfter, "落盘值应大于默认 nav 宽").toBeGreaterThan(NAV_WIDTH_DEFAULT);
});

test("② reload 后 nav 宽保持（与落盘值同值，±2px 渲染容差）", async ({ page }) => {
    await openWorkbench(page);
    await settle(page);
    await dragHandle(page, "sidebar-resizer", [8, 16, 24, 32, 40]);
    const afterDrag = await settle(page);
    // 非空前提：读者若读不到真实面板（-1），下面「reload 前后 ±2」会在 -1 与 -1 之间**空过**
    // （本文件改读者指向已退场对象时实测过这条假绿）⇒ 先把「读到了东西」本身钉住。
    expect(afterDrag.panel, "读者必须读到真实 nav 面板（-1 = 对象不存在）").toBeGreaterThan(0);
    const stored = await waitForStored(page, afterDrag.stored);
    console.log("[task2/migrated] stored", stored, "panel", afterDrag.panel);

    await page.reload();
    await page.waitForSelector('[data-testid="sidebar-resizer"]', {
        state: "visible",
        timeout: EXPECT_TIMEOUT_MS,
    });
    const afterReload = await settle(page);
    console.log("[task2/migrated] after-reload", JSON.stringify(afterReload));
    expect(
        Math.abs(afterReload.panel - afterDrag.panel),
        "reload 后 panel(" + afterReload.panel + ") 应与 reload 前(" + afterDrag.panel + ") 一致",
    ).toBeLessThanOrEqual(2);
    expect(afterReload.stored, "reload 后落盘值不变").toBe(stored);
});

test("③ 键盘路径走产品步长（不是 reka 的百分比默认值）：ArrowRight×3 = +48，End 夹到上限", async ({
    page,
}) => {
    await openWorkbench(page);
    const before = await settle(page);
    const handle = page.locator('[data-testid="sidebar-resizer"]');
    await handle.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    const afterArrows = await settle(page);
    console.log(
        "[task2/migrated] keyboard",
        JSON.stringify({ before: before.panel, afterArrows: afterArrows.panel }),
    );
    // 产品步长 NAV_WIDTH_KEYBOARD_STEP = 16px（useSplitterPanelBridge 的 capture 监听 +
    // preventDefault 挡掉 reka 自己的百分比步进）。reka 默认 keyboardResizeBy=10 且组宽≈1920
    // ⇒ 若我们的路由失效，一次按键就是 ~192px 的跳变 —— 这条判据正是为它设的。
    expect(
        Math.abs(afterArrows.panel - (before.panel + 3 * NAV_WIDTH_KEYBOARD_STEP)),
        "ArrowRight×3 应恰好宽 " + 3 * NAV_WIDTH_KEYBOARD_STEP + "px（产品步长，不是 reka 百分比）",
    ).toBeLessThanOrEqual(2);

    await page.keyboard.press("End");
    const atMax = await settle(page);
    const stored = await waitForStored(page, NAV_WIDTH_MAX);
    console.log("[task2/migrated] keyboard-end", JSON.stringify({ panel: atMax.panel, stored }));
    expect(stored, "End 应把 navWidth 夹到上限").toBe(NAV_WIDTH_MAX);
    expect(
        Math.abs(atMax.panel - (RAIL_WIDTH + NAV_WIDTH_MAX)),
        "End 后 panel 应 = RAIL_WIDTH + " + NAV_WIDTH_MAX,
    ).toBeLessThanOrEqual(2);
});

/**
 * ── 墓碑：树作为「splitter panel」的四条判据已退场（**前提退场**，不是判据被推翻）──────
 *
 * 共同前提：文件树曾是中栏容器里的一道 reka SplitterPanel（百分比布局 + tree-resizer 手柄 +
 * data-state/collapse 语义）。D-1777 / D-1778 之后树是**右栏的 files dock 面板**，宽度语义 =
 * 右栏 dock 宽（px，DOCK_WIDTH_* 夹取）。⇒ 下列四条断的**机制**不存在了：
 *   · 判据本身没写错；写在它成立的时代是真的（task-2 修好时它们全绿）；
 *   · 但「对象没了」⇒ 保留它们只会变成永久红，且红点落点会伪装成回归。
 * 接手（不给承接口就是「忘掉」，不是「退场」）：
 *   · ⑤（bootstrap 落盘宽 ⇒ 挂载即该宽）→ task497-layout-widths.spec.ts 迁移后断 dockWidth；
 *   · ⑦（组宽变化后仍是存储 px，% 缩水即红）→ bl576-workbench-panel-widths.spec.ts 迁移后的
 *     dock 宽判据（右栏宽是 px 常量/持久值，不再有 % 换算这条轴）；
 *   · ⑧（release 取整通道）→ WorkspaceDock 手写手柄的 clampDockWidth，判据在
 *     task497-layout-widths.spec.ts 迁移后的键盘 End + 落盘一致；
 *   · ⑥（窄视口首帧折叠 40px rail）→ 折叠本体仍在（treeRailVisible），但「reka 侧
 *     data-state=collapsed + 手柄消失」这半条判据的对象随 splitter 一起没了；右栏收起/窄屏
 *     sheet 的新判据属 task-65 后续卡（用户裁定的「可关闭/可折叠两态」面），不在本文件复活。
 */
test.describe.skip("已退场：树作为 splitter panel 的判据（D-1777 / D-1778）", () => {
    test.skip("⑤ 首帧 bootstrap：落盘 treeWidth 280 ⇒ 挂载即 280【前提退场】", () => {
        // 旧判据：种 {treeCollapsed:false, treeWidth:280} 到 xihe-layout-ws:<id>，挂载后 rail 宽
        // ≈ 280（不得退回默认 240）。
        // 退场依据：treeWidth 键仍在（布局 writer 保留），但**不再是树的渲染来源** —— 树宽 =
        // 右栏 dock 宽。⇒「挂载即存储宽」这条读法要换成 dock 宽，归 task497 迁移。
    });

    test.skip("⑥ task-551 语义：窄视口首帧即折叠成 40px rail【前提退场】", () => {
        // 旧判据：1180 视口首帧 rail = 40±2，且 reka 侧 data-state="collapsed"、tree-resizer 数为 0。
        // 退场依据：40px 折叠 rail 本体仍在（treeRailVisible），但「reka 的 collapsed 态 + 手柄消失」
        // 这半条判据的对象没了（树不再是 splitter panel）⇒ 剩下的折叠语义由 task-65 后续卡重写。
    });

    test.skip("⑦ 组宽变化后仍是存储 px（新通道非装饰）【前提退场】", () => {
        // 旧判据：视口 1920→1600，树仍 ≈240（% 布局会缩到 ~194）。
        // 退场依据：这条判据的判别力来自「splitter 是百分比布局 + 显式 store→面板通道」这对机制；
        // 右栏宽是 px 常量/持久值，**没有 % 换算这条轴** ⇒ 判据失去被测机制。归 bl576 迁移。
    });

    test.skip("⑧ release 取整：落盘整数 + 面板同步到该整数【前提退场】", () => {
        // 旧判据：拖到 238.6 ⇒ clampTreeWidth 取整 239 ⇒ 面板跟到 239（旧形态停在 238.6）。
        // 退场依据：取整通道 clampTreeWidth 随「树列」退场；右栏宽的取整在 clampDockWidth
        // （手写 dock 手柄），判据归 task497 迁移的键盘 End + 落盘一致。
    });
});
