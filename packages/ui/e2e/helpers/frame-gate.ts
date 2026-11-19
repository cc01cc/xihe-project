/**
 * frame-gate.ts —— 布局读数/采样的共用前置条件（task-127：从 one/.tmp/xh/ui-gates/splitter-transition/frame-gate.mjs 迁入）。
 *
 * 为什么要门（[实测] task-82 / task-93 / task-117）：
 * - 后台标签页或不可见窗口里 rAF 不推进，reka Splitter 的 flex-grow 过渡会冻结在起始帧，
 *   于是 [data-testid="sidebar"] 读成 1585px、workspace-main / chat-composer 读成 0；
 *   直接读数的结果在 0 / 中间态 / 稳态之间随机（1440 的 ③a 曾读到 0.0 / 16.7 这类假值）。
 * - 先 page.screenshot() 强制合成一帧，再轮询 document.getAnimations() 的 running 数，
 *   8s 不收敛就用 a.finish() 强制定格，并把「已强制定格」返回给调用方写进证据（不许静默）。
 *
 * 另提供逐帧采样器（task-127 用）：installFrameSampler 在文档启动前挂 rAF 循环，
 * 记录每帧 sidebar / main 宽与 running 动画数 —— 首帧闪光只有逐帧采样才能看见（收尾后读数永远一致）。
 */
import type { Page } from "@playwright/test";

export interface FrameGateResult {
    /** false = 超时后强制定格，读数必须在证据里标注，不得当自然稳态。 */
    settled: boolean;
    forcedShots: number;
    finishedByForce: number;
}

export interface LayoutWidths {
    sidebar: number | null;
    main: number | null;
    composer: number | null;
    panel1FlexGrow: string | null;
    panel2FlexGrow: string | null;
    runningAnimations: number;
    visibility: string;
}

export interface FrameSample {
    /** performance.now()，只在同一 document 内可比。 */
    t: number;
    sidebar: number | null;
    main: number | null;
    sidebarFlexGrow: string | null;
    runningAnimations: number;
}

/** 等一帧被真正合成 + 所有动画收敛。 */
export async function waitForSettledLayout(
    page: Page,
    { timeoutMs = 8000, pollMs = 50 }: { timeoutMs?: number; pollMs?: number } = {},
): Promise<FrameGateResult> {
    const deadline = Date.now() + timeoutMs;
    let forcedShots = 0;
    while (Date.now() < deadline) {
        const running = await page.evaluate(
            () => document.getAnimations().filter((a) => a.playState === "running").length,
        );
        if (running === 0) return { settled: true, forcedShots, finishedByForce: 0 };
        if (forcedShots < 3) {
            // 强制一帧：不可见窗口里只有截图/录屏会推进合成
            await page.screenshot();
            forcedShots += 1;
        }
        await page.waitForTimeout(pollMs);
    }
    const finishedByForce = await page.evaluate(() => {
        const anims = document.getAnimations().filter((a) => a.playState === "running");
        anims.forEach((a) => a.finish());
        return anims.length;
    });
    return { settled: false, forcedShots, finishedByForce };
}

/** 读关键节点宽度（含 reka 面板的 computed flex-grow，便于判断「px 首帧」还是「已收敛」）。 */
export async function readLayoutWidths(page: Page): Promise<LayoutWidths> {
    return page.evaluate(() => {
        const q = (sel: string): Element | null => document.querySelector(sel);
        const side = q('[data-testid="sidebar"]');
        const main = q('[data-testid="workspace-main"]');
        const composer = q('[data-testid="chat-composer"]');
        const panel2 = main ? main.closest('[id^="reka-splitter-panel-"]') : null;
        const w = (el: Element | null): number | null =>
            el ? Number(el.getBoundingClientRect().width.toFixed(1)) : null;
        return {
            sidebar: w(side),
            main: w(main),
            composer: w(composer),
            panel1FlexGrow: side ? getComputedStyle(side).flexGrow : null,
            panel2FlexGrow: panel2 ? getComputedStyle(panel2).flexGrow : null,
            runningAnimations: document.getAnimations().filter((a) => a.playState === "running")
                .length,
            visibility: document.visibilityState,
        };
    });
}

/** 一步到位：gate → 读数。读数里带 settled 标记，超时定格必须写进证据。 */
export async function measureSettled(
    page: Page,
): Promise<{ gate: FrameGateResult; widths: LayoutWidths }> {
    const gate = await waitForSettledLayout(page);
    const widths = await readLayoutWidths(page);
    return { gate, widths };
}

/** 采样器写进 window 的键（evaluate 里也按这个键读）。 */
export const FRAME_SAMPLES_KEY = "__splitterFrameSamples";

/**
 * 在文档启动前挂 rAF 逐帧采样器。每次导航（新 document）都会重置样本数组，
 * 所以「登录 → goto 工作区」后读到的样本只属于工作区那次装载。
 */
export async function installFrameSampler(page: Page, maxSamples = 900): Promise<void> {
    await page.addInitScript(
        ({ key, max }) => {
            const store = window as unknown as Record<string, unknown>;
            const samples: unknown[] = [];
            store[key] = samples;
            const round = (value: number): number => Math.round(value * 100) / 100;
            const sampleOnce = (): boolean => {
                if (samples.length >= max) return false;
                const sidebar = document.querySelector('[data-testid="sidebar"]');
                const main = document.querySelector('[data-testid="workspace-main"]');
                if (sidebar || main) {
                    samples.push({
                        t: round(performance.now()),
                        sidebar: sidebar ? round(sidebar.getBoundingClientRect().width) : null,
                        main: main ? round(main.getBoundingClientRect().width) : null,
                        sidebarFlexGrow: sidebar ? getComputedStyle(sidebar).flexGrow : null,
                        runningAnimations: document
                            .getAnimations()
                            .filter((a) => a.playState === "running").length,
                    });
                }
                return true;
            };
            const loop = (): void => {
                if (sampleOnce()) requestAnimationFrame(loop);
            };
            requestAnimationFrame(loop);
        },
        { key: FRAME_SAMPLES_KEY, max: maxSamples },
    );
}

/** 读样本（快照拷贝，不持有页面引用）。 */
export async function readFrameSamples(page: Page): Promise<FrameSample[]> {
    return (await page.evaluate((key: string) => {
        const store = window as unknown as Record<string, unknown>;
        const raw = store[key];
        return Array.isArray(raw) ? (raw as unknown[]) : [];
    }, FRAME_SAMPLES_KEY)) as FrameSample[];
}
