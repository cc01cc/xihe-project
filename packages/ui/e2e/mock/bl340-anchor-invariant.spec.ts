// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
/**
 * BL-340 —— 上滚时窗口换页**不得**把滚动位置往下拽（闭环自激回归判据）。
 *
 * 缺陷链（修复前）：`messageScroller.ts` 的窗口换页分支（`projectionOnly`）在"贴底跟随"时调用
 * `scrollToEnd()`，而 `scrollToEnd()` 会无条件把 `modeRef` 写回 `following-bottom`
 * ⇒ 换页 ↔ 贴底 闭环自激：用户在底部附近上滚（wheel 已发出、scroll 处理尚未改模式）会被
 * 立刻拽回底部。真实浏览器实测 8×500px 上滚（240 条会话）第 3 步 **+842px** 回跳，
 * 40×2000px 判据首跳 **+9743px**、共 10 次回跳。
 *
 * 判据（两条，互不替代）：
 * 1. 8×500px（最小复现）：`scrollTop` 序列**单调不增**（每步 ≤ 上一步 + 8px）；
 * 2. 40×2000px（BL-316 原判据）：单调不增**且能到顶**（末值 ≤ 8px）。
 *
 * 反证：把换页分支的 `scrollToEnd()` 加回去 ⇒ 本 spec 必须变红（否则说明用例没覆盖换页路径）。
 */
import { test, expect, type Page } from "@playwright/test";
import { ChatPage } from "../page-objects/ChatPage";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { collectPageFailures, expectNoPageFailures } from "./helpers/page-failures";
import type { PageFailures } from "./helpers/page-failures";
import { FONT_ORIGIN_FAILURE, stubSessionProjections } from "./helpers/session-projections";
import { ACTION_TIMEOUT_MS, LONG_TIMEOUT_MS } from "../timeouts";

const SESSION_ID = "bl340-anchor-session";
const TOTAL = 240;
// task-37：End 跳到底的阈值取自 **1200 条消息**的读数（`.tmp/xh/task31b/jump1200-summary.json`，187 样本），
// 因此必须跑在同规模夹具上。240 条夹具上同一协议实测库写尾部到 21 次（36 样本，`.tmp/xh/task31b/quiet12.log`）
// 且在 20 次上限上直接假红 —— 规模不同，读数不可互换。
const JUMP_SESSION_ID = "bl340-anchor-jump";
const JUMP_TOTAL = 1200;
/** 容差：锚定/亚像素抖动允许 8px，超过即视为"被拽回底部"。 */
const TOLERANCE_PX = 8;

/** task-37 / D-1689：「End 跳到底」的三项判据阈值（来源见对应测试注释）。 */
const JUMP_SETTLE_MAX_MS = 300;
const JUMP_LIBRARY_WRITES_MAX = 30;
const JUMP_SAMPLES = 3;
const JUMP_POST_SETTLE_WRITES_MAX = 0;
const JUMP_STABLE_FRAMES = 10;
const JUMP_SAMPLE_MS = 2000;
const JUMP_START_RATIO = 0.4;
const JUMP_VIEWPORT_SELECTOR = '[data-testid="message-scroller-viewport"]';

type JumpFrame = { t: number; top: number };
type JumpWrite = { kind: string; target: number; library: boolean; at: number };
type JumpSample = {
    settleMs: number;
    writes: JumpWrite[];
    /** 收敛之后仍发生的库写次数 —— 「追尾」的确定性判据（一条都不该有）。 */
    postSettleWrites: number;
    maxSingleCompensation: number;
    targets: number[];
};

/**
 * 写桩：只记录视口上的 `scrollTo`/`scrollBy`/`scrollTop=` 写入，并用栈区分「库的补偿写」（virtual-core
 * `scrollWithAdjustments`）与产品写。必须在首次导航前 `addInitScript` 安装。
 */
async function installJumpWriteStub(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const w = window as unknown as { __jumpWrites?: unknown[] };
        const writes: unknown[] = [];
        w.__jumpWrites = writes;
        const isViewport = (element: Element): boolean =>
            element.getAttribute?.("data-testid") === "message-scroller-viewport";
        const record = (kind: string, target: number, element: Element) => {
            if (!isViewport(element)) return;
            const stack = new Error().stack || "";
            writes.push({
                kind,
                target,
                library: stack.includes("scrollWithAdjustments"),
                at: performance.now(),
            });
        };
        const proto = Element.prototype as unknown as Record<string, unknown>;
        const originalScrollTo = proto.scrollTo as (...args: unknown[]) => void;
        proto.scrollTo = function (this: HTMLElement, ...args: unknown[]) {
            const first = args[0];
            const target =
                typeof first === "object" && first !== null
                    ? Number((first as ScrollToOptions).top)
                    : Number(args[1]);
            record("scrollTo", Number.isFinite(target) ? target : this.scrollTop, this);
            return originalScrollTo.apply(this, args);
        };
        const originalScrollBy = proto.scrollBy as (...args: unknown[]) => void;
        proto.scrollBy = function (this: HTMLElement, ...args: unknown[]) {
            const first = args[0];
            const delta =
                typeof first === "object" && first !== null
                    ? Number((first as ScrollToOptions).top)
                    : Number(args[1]);
            record("scrollBy", this.scrollTop + (Number.isFinite(delta) ? delta : 0), this);
            return originalScrollBy.apply(this, args);
        };
        const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
        if (descriptor?.get && descriptor.set) {
            const originalGet = descriptor.get;
            const originalSet = descriptor.set;
            Object.defineProperty(Element.prototype, "scrollTop", {
                configurable: true,
                enumerable: descriptor.enumerable,
                get(this: Element) {
                    return originalGet.call(this);
                },
                set(this: Element, value: number) {
                    record("scrollTop=", Number(value), this);
                    originalSet.call(this, value);
                },
            });
        }
    });
}

/** 从 40% 处按一次真实 End，逐帧采 `scrollTop`，返回收敛时间/库写/最大单次补偿。 */
async function measureEndJump(page: Page, chat: ChatPage): Promise<JumpSample> {
    await chat.goto(JUMP_SESSION_ID);
    await page
        .locator('[data-testid="virtual-top-spacer"]')
        .first()
        .waitFor({ timeout: LONG_TIMEOUT_MS });
    // 起点 40%：先派真实滚轮意图（否则 following-bottom 会把程序性写回弹到底部），再写位置。
    // 落位必须**验证再开测**：布局尚未稳定时写 40% 可能落到别的偏移（实测出现 28k vs 49k 两种起点，
    // 后者的一次性补差高达 21299px ⇒ 会把「最大单次补偿」判据拖成重尾/假红）。
    const placed = await page.evaluate(
        async (args: { ratio: number; selector: string }) => {
            const viewport = document.querySelector(args.selector) as HTMLElement;
            const frame = async (): Promise<void> =>
                await new Promise<void>((done) => requestAnimationFrame(() => done()));
            // 落位判据按**当时的**滚动范围算，不能拿一开始算出的 target 当绝对值：
            // 虚拟窗口在等待期间持续实测行高、`scrollHeight` 会变，用旧 target 复写会把位置
            // 拽到窗口预期之外 ⇒ 触发跨页补偿（实测 240 条夹具上 maxComp 从 ≤502 px 涨到 10k+）。
            for (let attempt = 0; attempt < 3; attempt += 1) {
                const max = viewport.scrollHeight - viewport.clientHeight;
                const target = Math.round(max * args.ratio);
                viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1200 }));
                viewport.scrollTop = target;
                viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
                let previous = Number.NaN;
                let same = 0;
                for (let tick = 0; tick < 90; tick += 1) {
                    await frame();
                    const now = Math.round(viewport.scrollTop);
                    same = now === previous ? same + 1 : 0;
                    previous = now;
                    if (same >= 3) break;
                }
                const landed = Math.round(viewport.scrollTop);
                const currentMax = viewport.scrollHeight - viewport.clientHeight;
                const inBand = landed >= currentMax * 0.25 && landed <= currentMax * 0.6;
                if (inBand) return { landed, max: currentMax };
            }
            return {
                landed: Math.round(viewport.scrollTop),
                max: viewport.scrollHeight - viewport.clientHeight,
            };
        },
        { ratio: JUMP_START_RATIO, selector: JUMP_VIEWPORT_SELECTOR },
    );
    if (!(placed.landed >= placed.max * 0.25 && placed.landed <= placed.max * 0.6)) {
        throw new Error(
            `起点落位失败：${placed.landed} 不在当前范围 ${placed.max} 的 25%-60%（D-1689）`,
        );
    }
    // 落位本身会触发窗口换页，换页的**库补偿写可能落在采样窗口内** —— 那是「落位」的尾巴，
    // 不是 End 的行为。实测（240 条夹具、93 样本）不静默时库写尾部到 19 次（阈值 20 只剩 1 次余量）；
    // 静默后再开测，才能让读数只属于 End。判据：连续 6 帧没有新的库写，最多等 60 帧（≈1 s）。
    await page.evaluate(async () => {
        const wWindow = window as unknown as { __jumpWrites?: { library: boolean }[] };
        const frame = async (): Promise<void> =>
            await new Promise<void>((done) => requestAnimationFrame(() => done()));
        let quiet = 0;
        let previous = (wWindow.__jumpWrites ?? []).filter((write) => write.library).length;
        for (let tick = 0; tick < 60; tick += 1) {
            await frame();
            const current = (wWindow.__jumpWrites ?? []).filter((write) => write.library).length;
            quiet = current === previous ? quiet + 1 : 0;
            previous = current;
            if (quiet >= 6) return;
        }
    });
    const inputAt = await page.evaluate((sampleMs: number) => {
        const w = window as unknown as {
            __jumpFrames?: JumpFrame[];
            __jumpSamplerDone?: boolean;
        };
        const frames: JumpFrame[] = [];
        w.__jumpFrames = frames;
        w.__jumpSamplerDone = false;
        const viewport = document.querySelector(
            '[data-testid="message-scroller-viewport"]',
        ) as HTMLElement;
        const startedAt = performance.now();
        const tick = () => {
            const now = performance.now();
            frames.push({ t: now, top: viewport.scrollTop });
            if (now - startedAt >= sampleMs) {
                w.__jumpSamplerDone = true;
                return;
            }
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        return performance.now();
    }, JUMP_SAMPLE_MS);
    await page.locator(JUMP_VIEWPORT_SELECTOR).focus();
    await page.keyboard.press("End");
    await expect
        .poll(
            async () =>
                await page.evaluate(
                    () =>
                        (window as unknown as { __jumpSamplerDone?: boolean }).__jumpSamplerDone ===
                        true,
                ),
            { message: "End 跳到底的采样窗口应结束", timeout: ACTION_TIMEOUT_MS, intervals: [100] },
        )
        .toBe(true);
    const raw = await page.evaluate(() => {
        const w = window as unknown as { __jumpFrames?: JumpFrame[]; __jumpWrites?: JumpWrite[] };
        return { frames: w.__jumpFrames ?? [], writes: w.__jumpWrites ?? [] };
    });
    const frames = raw.frames;
    const writes = raw.writes.filter((write) => write.at >= inputAt);
    let firstMoveIndex = -1;
    for (let index = 1; index < frames.length; index += 1) {
        if (Math.abs(frames[index].top - frames[0].top) > 0.5) {
            firstMoveIndex = index;
            break;
        }
    }
    if (firstMoveIndex < 0) {
        throw new Error(`End 未产生任何滚动（${JUMP_SAMPLE_MS}ms 内 top 恒为 ${frames[0]?.top}）`);
    }
    // 收敛 = 动了之后连续 JUMP_STABLE_FRAMES 帧同值（task-31 同口径，约 166ms 分辨率）。
    let settleMs = -1;
    for (let index = firstMoveIndex + 1; index + JUMP_STABLE_FRAMES <= frames.length; index += 1) {
        let stable = true;
        for (let offset = 1; offset <= JUMP_STABLE_FRAMES; offset += 1) {
            if (Math.abs(frames[index + offset - 1].top - frames[index - 1].top) > 0.5) {
                stable = false;
                break;
            }
        }
        if (stable) {
            settleMs = Math.round(frames[index].t - inputAt);
            break;
        }
    }
    if (settleMs < 0) {
        throw new Error(`End 跳到底在 ${JUMP_SAMPLE_MS}ms 采样窗口内未收敛（D-1689 判据不成立）`);
    }
    // 只统计**库**的补偿写（栈里带 `scrollWithAdjustments`）：产品的 prepend/贴底写不属于这条判据。
    const libraryWrites = writes.filter((write) => write.library);
    // 「追尾」的确定性形态 = 已经收敛（连续 10 帧不动）之后**又**有库写。
    // 这一条是 0/1 判据，不依赖分布尾部（单次补偿是重尾量，见测试注释）。
    const settledAt = inputAt + settleMs;
    const postSettleWrites = libraryWrites.filter((write) => write.at > settledAt + 16).length;

    const targets = libraryWrites.map((write) => Math.round(write.target));
    let maxSingleCompensation = 0;
    for (let index = 1; index < targets.length; index += 1) {
        maxSingleCompensation = Math.max(
            maxSingleCompensation,
            Math.abs(targets[index] - targets[index - 1]),
        );
    }
    return {
        settleMs,
        writes: libraryWrites,
        postSettleWrites,
        maxSingleCompensation,
        targets,
    };
}
test.describe("BL-340：上滚时窗口换页不得回跳", () => {
    let failures: PageFailures;

    test.beforeEach(async ({ page }) => {
        failures = collectPageFailures(page);
        await setupMockAuth(page);
        await setupMockSessions(page, {
            sessions: [
                { id: SESSION_ID, title: "BL-340 Anchor Invariant" },
                { id: JUMP_SESSION_ID, title: "BL-340 End Jump" },
            ],
            messages: {
                [SESSION_ID]: Array.from({ length: TOTAL }, (_, index) => ({
                    id: `bl340-msg-${index}`,
                    sessionId: SESSION_ID,
                    role: index % 2 === 0 ? "USER" : "ASSISTANT",
                    content: `bl340-row-${index}`,
                    createdAt: new Date(Date.now() - (TOTAL - index) * 60_000).toISOString(),
                })),
                [JUMP_SESSION_ID]: Array.from({ length: JUMP_TOTAL }, (_, index) => ({
                    id: `bl340-jump-msg-${index}`,
                    sessionId: JUMP_SESSION_ID,
                    role: index % 2 === 0 ? "USER" : "ASSISTANT",
                    content: `bl340-jump-row-${index}`,
                    createdAt: new Date(Date.now() - (JUMP_TOTAL - index) * 60_000).toISOString(),
                })),
            },
        });
        for (const sessionId of [SESSION_ID, JUMP_SESSION_ID]) {
            await stubSessionProjections(page, sessionId);
            await page.route(`**/api/v1/sessions/${sessionId}/participants`, async (route) => {
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({
                        participants: [],
                        capabilities: {
                            view: false,
                            manage: false,
                            mention: false,
                            speakAs: false,
                        },
                    }),
                });
            });
        }
    });

    test.afterEach(() => {
        expectNoPageFailures(failures, [FONT_ORIGIN_FAILURE]);
    });

    async function scrollUpSequence(
        page: Page,
        steps: number,
        stepPx: number,
    ): Promise<{ sequence: number[]; heights: number[]; firstRows: string[] }> {
        const chat = new ChatPage(page);
        await chat.goto(SESSION_ID);
        await page
            .locator('[data-testid="virtual-top-spacer"]')
            .first()
            .waitFor({ timeout: LONG_TIMEOUT_MS });

        // 起点：贴底（与 BL-316 / BL-340 探针一致）。
        await page.evaluate(() => {
            const viewport = document.querySelector(
                '[data-testid="message-scroller-viewport"]',
            ) as HTMLElement;
            viewport.scrollTop = viewport.scrollHeight;
        });
        await expect
            .poll(
                async () =>
                    await page.evaluate(() => {
                        const viewport = document.querySelector(
                            '[data-testid="message-scroller-viewport"]',
                        ) as HTMLElement;
                        return (
                            Math.abs(
                                viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
                            ) <= 8
                        );
                    }),
                { message: "起点应贴底", timeout: ACTION_TIMEOUT_MS },
            )
            .toBe(true);

        const sequence: number[] = [];
        const heights: number[] = [];
        const firstRows: string[] = [];
        for (let step = 0; step < steps; step += 1) {
            const sample = await page.evaluate((delta) => {
                const viewport = document.querySelector(
                    '[data-testid="message-scroller-viewport"]',
                ) as HTMLElement;
                // 真实滚轮意图（scroller 据此把模式切成 free-scrolling），再上滚一段。
                viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
                viewport.scrollTop = Math.max(0, viewport.scrollTop - delta);
                const firstRow =
                    (viewport.querySelector("[data-message-id]") as HTMLElement | null)?.dataset
                        .messageId ?? "";
                return {
                    scrollTop: Math.round(viewport.scrollTop),
                    scrollHeight: viewport.scrollHeight,
                    firstRow,
                };
            }, stepPx);
            sequence.push(sample.scrollTop);
            heights.push(sample.scrollHeight);
            firstRows.push(sample.firstRow);
            // ── BL-340 §18：**唯一采样口径**（探针 `bl340-protocol-experiment.spec.ts` 同口径）──
            // 每步滚动后轮询 `scrollTop`：**间隔固定 50ms、上限 1s，直到连续两次读数相同**；
            // 该稳定点即本步的采样点，**换页（swap）判定也用稳定点**（相邻稳定点 firstRow 不同 = 1 次换页）。
            // 为什么钉死：§15 与 §17 用不同轮询间隔时，同一代码的 swaps 在 5 与 6–7 之间漂移，ratio 给出
            // 1.40 与 1.00 的相反结论。改口径前，判 3 不能当验收判据（详见证据 §18）。
            const STABLE_POLL_MS = 50;
            const STABLE_TIMEOUT_MS = 1_000;
            let previous = Number.NaN;
            let stabilized = false;
            const polls: number[] = [];
            const stableStartedAt = Date.now();
            while (Date.now() - stableStartedAt < STABLE_TIMEOUT_MS) {
                await page.waitForTimeout(STABLE_POLL_MS);
                const current = await page.evaluate(() =>
                    Math.round(
                        (
                            document.querySelector(
                                '[data-testid="message-scroller-viewport"]',
                            ) as HTMLElement
                        ).scrollTop,
                    ),
                );
                polls.push(current);
                if (current === previous) {
                    stabilized = true;
                    break;
                }
                previous = current;
            }
            // D-1643（task-259 同批扫出）：等待器**超时即红**。原写法循环走完直接继续采样，
            // 于是"没稳定"被静默当成"稳定点"——机器越慢越容易拿到运动中的读数，且红不起来。
            if (!stabilized) {
                throw new Error(
                    `第 ${sequence.length} 步在 ${STABLE_TIMEOUT_MS}ms 内未稳定（D-1643）：` +
                        `已轮询 ${polls.join(",")}（间隔 ${STABLE_POLL_MS}ms）`,
                );
            }
        }
        return { sequence, heights, firstRows };
    }

    function expectMonotonicUp(sequence: number[]) {
        for (let index = 1; index < sequence.length; index += 1) {
            expect(
                sequence[index],
                `第 ${index} 步回跳（应单调不增）：${sequence.join(" → ")}`,
            ).toBeLessThanOrEqual(sequence[index - 1] + TOLERANCE_PX);
        }
    }

    /**
     * BL-340 **观测项**（不 assert）：上滚期 `scrollHeight` 抖动比与单调违例数。
     *
     * 为什么降级（证据 §18）：固定 §18.1 口径后，同一代码三次测得
     * `swaps=7 / heightChanges=7 / ratio=1.00`（**方差 0**）且判 3 恒 PASS ⇒
     * `scrollHeight` 变化次数对"抖动"不敏感（稳定点采样把换页与高度变化同步吸收），
     * 不能作验收判据。保留为观测：数值异常时（ratio 明显 >1）仍能从日志看出来。
     */
    test("观测：scrollHeight 抖动比与单调违例（不 assert）", async ({ page }) => {
        const { sequence, heights, firstRows } = await scrollUpSequence(page, 8, 500);
        const countChanges = (values: Array<string | number>): number =>
            values.reduce<number>(
                (acc, value, index) => (index > 0 && value !== values[index - 1] ? acc + 1 : acc),
                0,
            );
        const swapCount = countChanges(firstRows);
        const heightChangeCount = countChanges(heights);
        const ratio = heightChangeCount / Math.max(1, swapCount);
        const violations = sequence.reduce<number>(
            (acc, value, index) =>
                index > 0 && value > sequence[index - 1] + TOLERANCE_PX ? acc + 1 : acc,
            0,
        );
        console.log(
            `[BL-340 观测] swaps=${swapCount} heightChanges=${heightChangeCount} ` +
                `ratio=${ratio.toFixed(2)} violations=${violations} heights=${heights.join(",")}`,
        );
    });

    /**
     * 判 1（单调不增）：**task-259 已修，fixme 解除**（2026-11-15 23:38）。
     * 历史：task-116 审计 3 次 violations=1/0/0（一次 31125→31240，+115px 回跳）⇒ 当时恢复必红。
     * 修法 = 视口 `[overflow-anchor:none]` + 库钩子把「上滚不补偿」扩展到首次测量（见 bl316 同批注释）。
     * 解除后实测：`--repeat-each=6` 6/6 绿；四条全解除后 `--repeat-each=3` 12 passed / 0 skipped。
     * 小步长（500px）下库的 `scrollDirection` 会退回 null，故钩子另加 250ms 上滚意图窗
     * （只读 scroll 事件的方向，不新增滚动写路径）——去掉该窗时本条第 5 步 +422 回跳转红。
     */
    test("判 1：8×500px 上滚序列单调不增", async ({ page }) => {
        const { sequence } = await scrollUpSequence(page, 8, 500);
        expectMonotonicUp(sequence);
    });

    /**
     * BL-340 主判据：`8×500px` 上滚 3 次，
     * **首跳（单步最大回跳 px）中位 ≤ 600px**。
     *
     * 为什么是 fixme（task-116 审计改写，原措辞「修复中」已过期）：
     *  - `internal/A03-xihe/docs/backlog/registry.md` 对 BL-340 的登记是
     *    「【P1｜已定位未修】…**验收判据已重定义（判 3 不可用）**」，台账并记
     *    「判 3 与**首跳**两项判据实测不可用」——即**这条判据本身被判为不可用**。
     *  - 依据（证据 §17/§18）：首跳是唯一对"抖动"敏感的指标，但**跨会话不可比** ——
     *    baseline 三次中位 1488px（645/1911/1488），`freeze` 三次中位 525px（161/525/525），
     *    同一份代码在另一会话曾测得 2055（§17 与 §18 存在系统差异）。
     *  ⇒ **BL-340 修好也不会自动让这条变绿**：恢复前必须先重定义判据（同栈同构建 +
     *    固定采样口径），而不是等 bug 修完。
     *
     * **task-30 解除（2026-11-16）—— 收 task-259 遗留的待裁定项**：task-259 修法落地后本条
     * 已 3/3 绿（首跳三次均 0 ⇒ 中位 0），task-30 复核 `--repeat-each=3` 仍
     * **`首跳三次=0,0,0 中位=0px` 3/3 绿**。解除的依据是**「跨会话不可比」已不成立**：
     * 修法（视口 `[overflow-anchor:none]` + 库钩子上滚不补偿）让首跳成为**结构性 0** ——
     * 序列不存在正增量 ⇒ 该指标不再依赖会话/构建，不再是 §17/§18 那组经验读数。
     * 同批双向变异复核：去掉钩子 ⇒ 探针 finalTop=5084；去掉 anchor ⇒ 22473；
     * 两者都在 ⇒ 0（本判据与判 1 同构，判 1 断言更强）。**判据原文（≤600px）未放宽**。
     */
    test("主判据：8×500px 上滚 3 次首跳中位 ≤ 600px", async ({ page }) => {
        const chat = new ChatPage(page);
        const firstJumps: number[] = [];
        for (let run = 0; run < 3; run += 1) {
            await chat.goto(SESSION_ID);
            const { sequence } = await scrollUpSequence(page, 8, 500);
            let firstJump = 0;
            for (let index = 1; index < sequence.length; index += 1) {
                const delta = sequence[index] - sequence[index - 1];
                if (delta > TOLERANCE_PX) {
                    firstJump = delta;
                    break;
                }
            }
            firstJumps.push(firstJump);
        }
        const sorted = [...firstJumps].sort((left, right) => left - right);
        const median = sorted[1] ?? sorted[0] ?? 0;
        console.log(`[BL-340 主判据] 首跳三次=${firstJumps.join(",")} 中位=${median}px`);
        expect(median, `首跳中位应 ≤600px：${firstJumps.join(",")}`).toBeLessThanOrEqual(600);
    });

    /**
     * BL-316 原判据：40×2000px 上滚后单调不增且能到顶 —— **task-259 已修，fixme 解除**。
     * 说明：task-116 审计判为「不可用」的是**判 3（scrollHeight 抖动比）与首跳中位**两项
     * （前者对抖动不敏感、后者跨会话不可比），本条不属于那两项；采样口径已按 §18 钉死
     * （50ms 间隔 / 1s 上限 / 连续两次相同），且本批为同栈同构建（pin 61e916def + 本卡修法）。
     * 解除后实测：`--repeat-each=3` 全绿（四条 12 passed / 0 failed / 0 skipped）；
     * 同口径探针 `xh255-upscroll` finalTop=0、回跳 0 步。断言原文（≤8px、单调不增）未放宽。
     */
    test("BL-316 原判据 40×2000px：单调不增且能到顶", async ({ page }) => {
        const { sequence } = await scrollUpSequence(page, 40, 2000);
        expectMonotonicUp(sequence);
        expect(
            sequence[sequence.length - 1],
            `40×2000px 上滚后应到顶：${sequence.join(" → ")}`,
        ).toBeLessThanOrEqual(TOLERANCE_PX);
    });
    /**
     * task-37 / D-1689 —— **End 跳到底**不得产生「追尾」式多次补偿写（判据增补，2026-11-16）。
     *
     * 背景（task-31 / D-1684 自查更正）：task-31 报的「大跳跃 0.5s 内 32-37 次库写」来自探针里
     * **合成滚动条拖拽**（mousedown 落点 + 16 步 mouse.move）的干扰，不是 End 的真实行为。
     * 真 End 实测（HEAD 4d7296c8a、1200 条消息、40% 处起跳、5 样本）：settle 184-240ms、
     * 库写 0-9 次、最大单次补偿 0-2104px；产品自己的 `scrollToEnd()`（「回到最新」按钮）
     * 同样 210-220ms / 9 次 / 2316px ⇒ D（End 改走 scrollToEnd）与 B（scrollToIndex(last)）**均无收益**。
     * 本卡交付 = 把三项读数钉成判据，防止将来退化回「逐批首测」的追尾形态。
     *
     * 判据（只增不减，不放宽本文件任何既有断言）：
     *  1. `settleMs ≤ 300ms`（39 样本实测 187-272ms，留 10% 余量）；
     *  2. 窗口内库写次数 `≤ 30`（187 样本实测：p50=9 / p90=15 / p99=19 / **上界 22**）。
     *     上限的作用是**区分「换页有界」与「追尾失控」**：D-1684 假设的追尾形态是 32-37 次，
     *     30 这条线把它挡住（实测 22 ⇒ 留 36% 余量，同时不留到 32）。
     *  3. **收敛之后不得再有库写**（`postSettleWrites === 0`）—— 这才是「追尾」的可判定形态：
     *     追尾 = 已经停住了又被补偿写推动。它是 0/1 判据，不受分布尾部影响。
     *
     * 关于「最大单次补偿」：**不作为阈值**，只作为读数打印。实测（`.tmp/xh/task31b/final-dist12.log`
     * 39 样本）它是重尾量 —— 常规样本 502/579/805px，但换页那一步会一次写跨一页（3847 / 5127 /
     * 8253 / 8458px），出现频率约 10%，且**哪个样本撞上取决于当次窗口换页落在哪里**；
     * 3 样本中位实测上界 5127px（13 组里 2 组中位 >2400）⇒ 任何固定阈值都会周期性假红。
     * 拿它当门 = 造一个会假红的判据，而假红的判据一定会被绕过。因此只用它报读数（便于比对
     * 历史值），断言留给前两条 + postSettleWrites。
     * 阈值来源：`.tmp/xh/task31b/{end-final.log,end-base5.log,button-final.log,final-dist12.log}`。
     */
    test("task-37：End 跳到底的收敛时间/库写次数/追尾判定", async ({ page }) => {
        test.setTimeout(LONG_TIMEOUT_MS);
        await installJumpWriteStub(page);
        const chat = new ChatPage(page);
        const samples: JumpSample[] = [];
        for (let index = 0; index < JUMP_SAMPLES; index += 1) {
            samples.push(await measureEndJump(page, chat));
        }
        for (const [index, sample] of samples.entries()) {
            console.log(
                `[task-37] #${index + 1} settle=${sample.settleMs}ms writes=${sample.writes.length} ` +
                    `postSettle=${sample.postSettleWrites} maxComp=${sample.maxSingleCompensation}px ` +
                    `libTargets=${sample.targets.slice(0, 10).join(",")}`,
            );
            expect(
                sample.settleMs,
                `第 ${index + 1} 次 End 跳到底应在 ${JUMP_SETTLE_MAX_MS}ms 内收敛（实测 ${sample.settleMs}ms）`,
            ).toBeLessThanOrEqual(JUMP_SETTLE_MAX_MS);
            expect(
                sample.writes.length,
                `第 ${index + 1} 次 End 窗口内库写应 ≤ ${JUMP_LIBRARY_WRITES_MAX} 次`,
            ).toBeLessThanOrEqual(JUMP_LIBRARY_WRITES_MAX);
            expect(
                sample.postSettleWrites,
                `第 ${index + 1} 次 End 收敛后不得再被库写推动（追尾判定）：库写=${sample.writes.length} 次、收敛=${sample.settleMs}ms、目标=${sample.targets.join(",")}`,
            ).toBeLessThanOrEqual(JUMP_POST_SETTLE_WRITES_MAX);
        }
    });
});
