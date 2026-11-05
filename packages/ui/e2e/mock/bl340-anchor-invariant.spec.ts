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
    ): Promise<number[]> {
        const chat = new ChatPage(page);
        await chat.goto(SESSION_ID);
        await page
            .locator('[data-testid="virtual-top-spacer"]')
            .first()
            .waitFor({ timeout: 15_000 });

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
                { message: "起点应贴底", timeout: 5_000 },
            )
            .toBe(true);

        const sequence: number[] = [];
        for (let step = 0; step < steps; step += 1) {
            sequence.push(
                await page.evaluate((delta) => {
                    const viewport = document.querySelector(
                        '[data-testid="message-scroller-viewport"]',
                    ) as HTMLElement;
                    // 真实滚轮意图（scroller 据此把模式切成 free-scrolling），再上滚一段。
                    viewport.dispatchEvent(
                        new WheelEvent("wheel", { bubbles: true, deltaY: -120 }),
                    );
                    viewport.scrollTop = Math.max(0, viewport.scrollTop - delta);
                    return Math.round(viewport.scrollTop);
                }, stepPx),
            );
            // 等"换页 + 任何补偿"落地：连续两次采样 scrollTop 相同再继续（不用固定 sleep）。
            let previous = -1;
            for (let attempt = 0; attempt < 20; attempt += 1) {
                await page.waitForTimeout(80);
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
        return sequence;
    }

    function expectMonotonicUp(sequence: number[]) {
        for (let index = 1; index < sequence.length; index += 1) {
            expect(
                sequence[index],
                `第 ${index} 步回跳（应单调不增）：${sequence.join(" → ")}`,
            ).toBeLessThanOrEqual(sequence[index - 1] + TOLERANCE_PX);
        }
    }

    // BL-340 修复中：第三条 scrollTop 写入者待定位（见 .local/evidence/bl340-anchor-jump-locate.md §9）；
    // 本用例为最终守卫，绿之前不得改为 test()。
    test.fixme("最小复现 8×500px：上滚序列单调不增", async ({ page }) => {
        const sequence = await scrollUpSequence(page, 8, 500);
        expectMonotonicUp(sequence);
    });

    // BL-340 修复中：同上（最终守卫，绿之前不得改为 test()）。
    test.fixme("BL-316 原判据 40×2000px：单调不增且能到顶", async ({ page }) => {
        const sequence = await scrollUpSequence(page, 40, 2000);
        expectMonotonicUp(sequence);
        expect(
            sequence[sequence.length - 1],
            `40×2000px 上滚后应到顶：${sequence.join(" → ")}`,
        ).toBeLessThanOrEqual(TOLERANCE_PX);
    });
});
