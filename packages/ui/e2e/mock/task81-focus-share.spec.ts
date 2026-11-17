/**
 * task-81 守卫（真实布局）：focus 态「**主列份额是否释放**」。
 *
 * ── 判据为什么是比值 —— 这条判据被 240px 骗过一次 ───────────────────────────────────────
 * 卡面原本的判据是像素：「1920 残留 519px 空白 / 1440 残留 278px」。实测（2026-11-17，ui-41）
 * 当天真实空白是 **758.3 / 517.8**：`519 + 240 = 759.0`、`278 + 240 = 518.0`，**恰好各多
 * 一个 TREE_WIDTH_DEFAULT(240)**。原因是卡面是在「文件树还住在中栏」时量的，而 `D-1777`/`D-1778`
 * 把树搬进了右栏 files 面板 ⇒ 中栏整块都成了空白，**旧缺陷被动扩大了整整一个树宽**。
 * ⇒ 像素式判据会随布局改动静默过期；改用比值，与视口、与树住址都无关。
 *
 * ── 为什么必须是 e2e 而不是 jsdom 单测 ──────────────────────────────────────────────────
 * jsdom 无布局引擎，`getBoundingClientRect().width` 恒 0 ⇒ 比值这条**根本量不出来**
 * （本仓同款先例：`src/layouts/__tests__/AppLayout.spec.ts:191-197` 明写「jsdom 无布局引擎，
 * 用『不参与 flex 流』的等效判据，浏览器侧 `width===0` 由 e2e 轮取证」）。
 * ⇒ 分工固定：**单测断机制**（focus 时 `workspace-center` 的 `style.display === "none"`），
 * **本文件断份额**。只写单测会假绿（class 在 ≠ 份额释放，这正是缺陷长期存在的原因）。
 *
 * ── 缺陷本体（2026-11-17 实测，供红了的人读懂）────────────────────────────────────────────
 * `workspace-center` 在 focus 时仍是 `display:flex; flex-grow:1`，而它唯一的孩子
 * `workspace-main` 已被 `v-show` 设成 `display:none` ⇒ **一个没有内容的盒子照样跟右栏各拿 50%**。
 * 只把 center 设成 `display:none`（DOM 实验，不改代码）⇒ 右栏立刻吃满 **100.0%**（三档视口全中）。
 *
 * ── 空判据防护（纪律：别把「没出现」读成「已经是 0」）──────────────────────────────────
 * 「center 宽 = 0」既能是**修好了**，也能是**页面根本没渲染**。两者在读数上不可分辨 ⇒
 * 本文件先钉「进 focus 前 center.width > 0」，再钉 focus 后的 0。少了前半条，一个白屏就能让
 * 整条判据变绿（真实事故形态：dev server 对某文件返 500 ⇒ 动态 import ERR_ABORTED ⇒
 * workspace-workbench 永不出现）。
 *
 * ── 与 task-158 的边界（别把两张卡的判据混在一起）──────────────────────────────────────
 * 1440 档上「进 focus 让工作台**变窄** 280.36px」（导航面板回涨）是**另一个根因**（跨容器：
 * `dockFocus` 时 `demand` return null ⇒ 防挤压整段释放），已单独立 `task-158`。
 * 本文件**只断比值**，不断绝对宽度；那一侧修好后本文件照样绿。
 */
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import type { Page } from "@playwright/test";
import { EXPECT_TIMEOUT_MS } from "../timeouts";

const WORKSPACE_PATH = "/workspace/11111111-1111-4111-8111-111111111111";

/** 判据常量 —— 改这里 = 改判据，别在断言里散写数字。 */
const MIN_SHARE = 0.999;
/** 像素容差：右栏那 1px 的 border-l 与 subpixel 舍入。 */
const TOL_PX = 1;

const SEL = {
    workbench: '[data-testid="workspace-workbench"]',
    center: '[data-testid="workspace-center"]',
    dock: '[data-testid="workspace-aux-panel"]',
    main: '[data-testid="workspace-main"]',
    focusToggle: '[data-testid="dock-focus-toggle"]',
    openCode: '[data-testid="workspace-toolbar-code"]',
    resizer: '[data-testid="dock-resizer"]',
};

interface Box {
    width: number;
    left: number;
    right: number;
    display: string;
    flexGrow: string;
}

interface Frame {
    /** 出现性：数出来，不靠"看起来没渲染"。 */
    counts: { workbench: number; center: number; dock: number };
    workbench: Box | null;
    center: Box | null;
    dock: Box | null;
    mainVisible: boolean;
    mainHiddenAttr: string | null;
    resizerCount: number;
}

/** 读一帧几何（纯读，不改 DOM）。 */
async function readFrame(page: Page): Promise<Frame> {
    return page.evaluate((sel) => {
        const q = (s: string) => document.querySelector(s);
        const box = (el: Element | null) => {
            if (!el) return null;
            const r = el.getBoundingClientRect(),
                cs = getComputedStyle(el);
            return {
                width: +r.width.toFixed(2),
                left: +r.left.toFixed(2),
                right: +r.right.toFixed(2),
                display: cs.display,
                flexGrow: cs.flexGrow,
            };
        };
        const main = q(sel.main);
        return {
            counts: {
                workbench: document.querySelectorAll(sel.workbench).length,
                center: document.querySelectorAll(sel.center).length,
                dock: document.querySelectorAll(sel.dock).length,
            },
            workbench: box(q(sel.workbench)),
            center: box(q(sel.center)),
            dock: box(q(sel.dock)),
            // getClientRects().length 对 display:none 恒 0；比 offsetParent 稳
            // （后者对 position:fixed 元素也返回 null，会误判成不可见）。
            mainVisible: main ? main.getClientRects().length > 0 : false,
            mainHiddenAttr: main ? main.getAttribute("data-main-hidden") : null,
            resizerCount: document.querySelectorAll(sel.resizer).length,
        };
    }, SEL);
}

/** 轮询到「连续两次测量相同」再返回（等价稳定点；不引入固定 sleep）。 */
async function measureStable(page: Page): Promise<Frame> {
    let previous: string | null = null;
    const deadline = Date.now() + EXPECT_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const frame = await readFrame(page);
        const key = JSON.stringify(frame);
        if (key === previous) return frame;
        previous = key;
        await page.waitForTimeout(120);
    }
    throw new Error("几何在 EXPECT_TIMEOUT_MS 内没有稳定下来（读数抖动或过渡动画未结束）");
}

/** 打开右栏（未进 focus）—— 先钉「对象在」再钉数。 */
async function openDock(page: Page): Promise<void> {
    await page.waitForSelector(SEL.workbench, { state: "attached", timeout: EXPECT_TIMEOUT_MS });
    if (!(await page.$(SEL.focusToggle))) {
        await page.click(SEL.openCode);
    }
    await page.waitForSelector(SEL.dock, { state: "visible", timeout: EXPECT_TIMEOUT_MS });
    await page.waitForSelector(SEL.focusToggle, { state: "visible", timeout: EXPECT_TIMEOUT_MS });
}

/** 等 focus 标志落到期望值（属性驱动，不用固定等待）。 */
async function waitDockFocus(page: Page, expected: "true" | "false"): Promise<void> {
    await page.waitForFunction(
        ({ selector, value }) =>
            document.querySelector(selector)?.getAttribute("data-dock-focus") === value,
        { selector: SEL.dock, value: expected },
        { timeout: EXPECT_TIMEOUT_MS },
    );
}

async function enterFocus(page: Page): Promise<void> {
    await page.click(SEL.focusToggle);
    await waitDockFocus(page, "true");
}

async function exitFocus(page: Page): Promise<void> {
    await page.keyboard.press("Escape");
    await waitDockFocus(page, "false");
}
const round = (value: number) => value.toFixed(2);

/** 读数无条件打出来 —— 通过时断言消息不进报告，改前/改后就没法对比数字。 */
function detailOf(before: Frame, focus: Frame): string {
    return (
        "before{center=" +
        (before.center ? round(before.center.width) : "null") +
        " dock=" +
        (before.dock ? round(before.dock.width) : "null") +
        "}" +
        " focus{center=" +
        (focus.center ? round(focus.center.width) + "/" + focus.center.display : "null") +
        " dock=" +
        (focus.dock ? round(focus.dock.width) : "null") +
        " workbench=" +
        (focus.workbench ? round(focus.workbench.width) : "null") +
        " share=" +
        (focus.workbench && focus.workbench.width > 0 && focus.dock
            ? (focus.dock.width / focus.workbench.width).toFixed(4)
            : "n/a") +
        "}"
    );
}

test.beforeEach(async ({ page }) => {
    await setupMockAuth(page);
    await setupMockSessions(page, { sessions: [{ id: "session-1", title: "Session 1" }] });
});

test("task-81：focus 时中栏把份额交给右栏（比值式判据，1920）", async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(WORKSPACE_PATH);

    // 先钉「对象在」：没有这条，页面白屏时下面的 0 也能让判据变绿。
    await page.waitForSelector(SEL.center, { state: "attached", timeout: EXPECT_TIMEOUT_MS });
    const initial = await measureStable(page);
    // 空判据防护：进 focus 前中栏必须有面积，否则「被释放」与「本来就没有」不可分辨。
    expect(
        initial.center !== null && initial.center.width > 0,
        "进 focus 前 workspace-center 必须有宽度（否则无法区分『份额已释放』与『页面没渲染』）；" +
            detailOf(initial, initial),
    ).toBe(true);

    await openDock(page);
    // 基线取在「右栏已开、尚未进 focus」：restore 判据要跟它逐项比。
    const baseline = await measureStable(page);
    expect(
        baseline.center !== null && baseline.center.width > 0,
        "开右栏后中栏仍必须有宽度；" + detailOf(baseline, baseline),
    ).toBe(true);

    await enterFocus(page);
    const focus = await measureStable(page);
    console.log("[task-81] 1920 ", detailOf(baseline, focus));

    const detail = detailOf(baseline, focus);

    // ① 机制：中栏退场（不是被压缩），且不是 v-if 卸载 —— D26-04 要求 ChatPanel 保持挂载。
    expect
        .soft(
            focus.center !== null && (focus.center.width === 0 || focus.center.display === "none"),
            "① focus 时 workspace-center 必须不占份额（width===0 或 display:none）；" + detail,
        )
        .toBe(true);
    expect
        .soft(focus.mainHiddenAttr, "① 主列必须仍挂载且标记为隐藏（v-show，D26-04）；" + detail)
        .toBe("true");
    expect.soft(focus.mainVisible, "① 主列不可见；" + detail).toBe(false);

    // ② 份额：右栏吃掉整行（±1px 容 border-l）。
    expect
        .soft(
            focus.dock !== null &&
                focus.workbench !== null &&
                Math.abs(focus.dock.width - focus.workbench.width) <= TOL_PX,
            "② 右栏宽度必须等于工作台宽度（±" + TOL_PX + "px）；" + detail,
        )
        .toBe(true);

    // ③ 比值（与视口、与树住址无关的那条）。缺陷态实测 0.5003 ⇒ 必红。
    const share =
        focus.workbench && focus.workbench.width > 0 && focus.dock
            ? focus.dock.width / focus.workbench.width
            : 0;
    expect
        .soft(share, "③ 右栏占工作台比值必须 ≥ " + MIN_SHARE + "（缺陷态实测 0.5003）；" + detail)
        .toBeGreaterThanOrEqual(MIN_SHARE);

    // ④ 边缘对齐：排除「等宽但错位」。
    expect
        .soft(
            focus.dock !== null &&
                focus.workbench !== null &&
                Math.abs(focus.dock.left - focus.workbench.left) <= TOL_PX &&
                Math.abs(focus.dock.right - focus.workbench.right) <= TOL_PX,
            "④ 右栏左右边缘必须与工作台对齐（±" + TOL_PX + "px）；" + detail,
        )
        .toBe(true);

    // ⑤ focus 态没有可拖分隔条（WorkspaceDock 的 resizer 是 v-if="!focus"）—— 设计使然，别当缺陷。
    expect.soft(focus.resizerCount, "⑤ focus 态不应有 dock-resizer；" + detail).toBe(0);
});

test("task-81：退出 focus 后中栏与右栏逐项还原（这条本来就绿，别改坏）", async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(WORKSPACE_PATH);

    await openDock(page);
    const baseline = await measureStable(page);

    await enterFocus(page);
    await exitFocus(page);
    const restored = await measureStable(page);

    const detail = detailOf(baseline, restored);
    console.log("[task-81] restored ", detail);
    expect(baseline.center !== null && baseline.dock !== null, "基线读数缺失；" + detail).toBe(
        true,
    );

    // 还原判据：中栏与右栏逐项回到进 focus 前的值（±1px）。
    // 2026-11-17 实测缺陷态下这条**本来就绿**（Δ=0）⇒ 它是防回归尺，不是缺陷尺。
    expect
        .soft(
            restored.center !== null &&
                baseline.center !== null &&
                Math.abs(restored.center.width - baseline.center.width) <= TOL_PX,
            "中栏宽度必须还原到进 focus 前（±" + TOL_PX + "px）；" + detail,
        )
        .toBe(true);
    expect
        .soft(
            restored.dock !== null &&
                baseline.dock !== null &&
                Math.abs(restored.dock.width - baseline.dock.width) <= TOL_PX,
            "右栏宽度必须还原到进 focus 前（±" + TOL_PX + "px）；" + detail,
        )
        .toBe(true);

    // 附带三态：分隔条回到场上、主列重新可见、data-main-hidden 归 false。
    expect.soft(restored.resizerCount, "退出 focus 后 dock-resizer 应回来；" + detail).toBe(1);
    expect
        .soft(restored.mainHiddenAttr, "退出 focus 后 data-main-hidden 应为 false；" + detail)
        .toBe("false");
    expect.soft(restored.mainVisible, "退出 focus 后主列应可见；" + detail).toBe(true);
});

test("task-81：比值判据与视口无关（1440；工作台变窄属 task-158，不在本卡）", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(WORKSPACE_PATH);

    await page.waitForSelector(SEL.center, { state: "attached", timeout: EXPECT_TIMEOUT_MS });
    const initial = await measureStable(page);
    expect(
        initial.center !== null && initial.center.width > 0,
        "进 focus 前 workspace-center 必须有宽度；" + detailOf(initial, initial),
    ).toBe(true);

    await openDock(page);
    const baseline = await measureStable(page);
    await enterFocus(page);
    const focus = await measureStable(page);
    console.log("[task-81] 1440 ", detailOf(baseline, focus));
    const detail = detailOf(baseline, focus);

    const share =
        focus.workbench && focus.workbench.width > 0 && focus.dock
            ? focus.dock.width / focus.workbench.width
            : 0;
    // 1440 档只断比值。**不断** workbench 绝对宽度 —— dockFocus 时 demand return null
    // （WorkspaceWorkbench.vue:470-471）⇒ 防挤压整段释放 ⇒ 导航面板回涨 280px 是 task-158 的根因。
    expect
        .soft(share, "1440 档右栏占工作台比值必须 ≥ " + MIN_SHARE + "；" + detail)
        .toBeGreaterThanOrEqual(MIN_SHARE);
    expect
        .soft(
            focus.center !== null && (focus.center.width === 0 || focus.center.display === "none"),
            "1440 档 focus 时 workspace-center 同样必须不占份额；" + detail,
        )
        .toBe(true);
});
