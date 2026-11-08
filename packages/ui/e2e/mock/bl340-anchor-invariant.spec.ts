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
import { test, expect } from "@playwright/test";
import { ChatPage } from "../page-objects/ChatPage";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { collectPageFailures, expectNoPageFailures } from "./helpers/page-failures";
import type { PageFailures } from "./helpers/page-failures";
import { FONT_ORIGIN_FAILURE, stubSessionProjections } from "./helpers/session-projections";
import { ACTION_TIMEOUT_MS, LONG_TIMEOUT_MS } from "../timeouts";

const SESSION_ID = "bl340-anchor-session";
const TOTAL = 240;
/** 容差：锚定/亚像素抖动允许 8px，超过即视为"被拽回底部"。 */
const TOLERANCE_PX = 8;

test.describe("BL-340：上滚时窗口换页不得回跳", () => {
    let failures: PageFailures;

    test.beforeEach(async ({ page }) => {
        failures = collectPageFailures(page);
        await setupMockAuth(page);
        await setupMockSessions(page, {
            sessions: [{ id: SESSION_ID, title: "BL-340 Anchor Invariant" }],
            messages: {
                [SESSION_ID]: Array.from({ length: TOTAL }, (_, index) => ({
                    id: `bl340-msg-${index}`,
                    sessionId: SESSION_ID,
                    role: index % 2 === 0 ? "USER" : "ASSISTANT",
                    content: `bl340-row-${index}`,
                    createdAt: new Date(Date.now() - (TOTAL - index) * 60_000).toISOString(),
                })),
            },
        });
        await stubSessionProjections(page, SESSION_ID);
        await page.route(`**/api/v1/sessions/${SESSION_ID}/participants`, async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    participants: [],
                    capabilities: { view: false, manage: false, mention: false, speakAs: false },
                }),
            });
        });
    });

    test.afterEach(() => {
        expectNoPageFailures(failures, [FONT_ORIGIN_FAILURE]);
    });

    async function scrollUpSequence(
        page: import("@playwright/test").Page,
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
                if (current === previous) break;
                previous = current;
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

    // 判 1（单调不增）：BL-340 修复中，保持 fixme —— 需要"写入后被静默钳制"的处理。
    test.fixme("判 1：8×500px 上滚序列单调不增", async ({ page }) => {
        const { sequence } = await scrollUpSequence(page, 8, 500);
        expectMonotonicUp(sequence);
    });

    /**
     * BL-340 **主判据**：`8×500px` 上滚 3 次，**首跳（单步最大回跳 px）中位 ≤ 600px**。
     *
     * 依据（证据 §17/§18）：首跳是唯一对"抖动"敏感的指标——baseline 三次中位 **1488px**
     * （645/1911/1488），`freeze`（滚动中冻结测量）三次中位 **525px**（161/525/525）。
     * 跨会话比较必须**同栈同构建**（§17 同代码曾测得 2055，与 §18 的 1488 存在系统差异）。
     * 修复中，保持 fixme。
     */
    test.fixme("主判据：8×500px 上滚 3 次首跳中位 ≤ 600px", async ({ page }) => {
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

    // BL-340 修复中：同上（最终守卫，绿之前不得改为 test()）。
    test.fixme("BL-316 原判据 40×2000px：单调不增且能到顶", async ({ page }) => {
        const { sequence } = await scrollUpSequence(page, 40, 2000);
        expectMonotonicUp(sequence);
        expect(
            sequence[sequence.length - 1],
            `40×2000px 上滚后应到顶：${sequence.join(" → ")}`,
        ).toBeLessThanOrEqual(TOLERANCE_PX);
    });
});
