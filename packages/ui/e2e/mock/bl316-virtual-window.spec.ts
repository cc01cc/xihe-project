// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
/**
 * BL-316 —— 窗口化渲染（PLAN-0670 M2d.2）**在产品浏览器里真的生效**。
 *
 * 缺陷链（修复前）：`MessageList.vue` 用 `inject(MessageScrollerContextKey, null)` 取滚动视口，而
 * 提供该 context 的 `MessageScrollerProvider` 是它**自己的子节点** ⇒ inject 恒 null ⇒
 * `attach(null)` ⇒ `viewportHeight` 恒 0 ⇒ `active` 恒 false ⇒ 长会话全量渲染（窗口化从未生效）。
 *
 * 本 spec 是**真实浏览器**判据（mock 车道，headless）：jsdom 没有布局、`clientHeight` 恒 0，
 * 单测只能伪造高度；只有真实浏览器能证明"产品里窗口真的在切"。
 *
 * 同时守住 BL-315：窗口化一旦生效，`measure()` 会被渲染 effect 真实读到，自触发循环（Vue
 * `Maximum recursive updates exceeded`）会立刻回到 dev 构建的 pageError 里 —— 所以这里
 * 用 `expectNoPageFailures` 把 pageError / console error / >=400 响应一并判零。
 */
import { test, expect } from "@playwright/test";
import { ChatPage } from "../page-objects/ChatPage";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { collectPageFailures, expectNoPageFailures } from "./helpers/page-failures";
import type { PageFailures } from "./helpers/page-failures";
import { FONT_ORIGIN_FAILURE, stubSessionProjections } from "./helpers/session-projections";
import { ACTION_TIMEOUT_MS, LONG_TIMEOUT_MS } from "../timeouts";

const SESSION_ID = "bl316-virtual-session";
/** `DEFAULT_VIRTUAL_MIN_ROWS` = 150，必须显著越过阈值才谈得上"窗口化生效"。 */
const TOTAL = 240;

test.describe("BL-316：长会话只渲染窗口内的行", () => {
    let failures: PageFailures;

    test.beforeEach(async ({ page }) => {
        failures = collectPageFailures(page);
        await setupMockAuth(page);
        await setupMockSessions(page, {
            sessions: [{ id: SESSION_ID, title: "BL-316 Virtual Window" }],
            messages: {
                [SESSION_ID]: Array.from({ length: TOTAL }, (_, index) => ({
                    id: `bl316-msg-${index}`,
                    sessionId: SESSION_ID,
                    role: index % 2 === 0 ? "USER" : "ASSISTANT",
                    // 每行一句独立可定位文本：用来证明"窗口里的是哪几行"。
                    content: `bl316-row-${index}`,
                    createdAt: new Date(Date.now() - (TOTAL - index) * 60_000).toISOString(),
                })),
            },
        });
        // 聊天列挂载后会拉 derived-state / follow-ups / commands 三个投影；`setupMockSessions`
        // 对未登记后缀回 404，不桩就是夹具缺口造成的 console error（会被 afterEach 误判成回归）。
        await stubSessionProjections(page, SESSION_ID);
        // 参与者名单同理（`/sessions/{id}/participants` 也是 404）；本 spec 不看成员面板，
        // 给一个合法信封即可（与 `bl311-viewer-readonly.spec.ts` 同形）。
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
        // BL-315 回归（真实浏览器、窗口化生效的前提下）：零 pageError / 零 console error。
        expectNoPageFailures(failures, [FONT_ORIGIN_FAILURE]);
    });

    test("renders a bounded window instead of the whole transcript", async ({ page }) => {
        const chat = new ChatPage(page);
        await chat.goto(SESSION_ID);
        await expect(chat.scrollerViewport).toBeVisible({ timeout: LONG_TIMEOUT_MS });

        /**
         * 窗口化的**产品可见**标志：占位 spacer 只在 `virtualizationActive` 时渲染
         * （`MessageList.vue` 的 `v-if`）。它出现 ⇒ viewport 已挂载且窗口真的在切。
         * 用 `expect` 轮询等它，不用固定 sleep。
         */
        const topSpacer = page.locator('[data-testid="virtual-top-spacer"]');
        const bottomSpacer = page.locator('[data-testid="virtual-bottom-spacer"]');
        await expect(topSpacer).toHaveCount(1, { timeout: LONG_TIMEOUT_MS });
        await expect(bottomSpacer).toHaveCount(1, { timeout: LONG_TIMEOUT_MS });

        const rows = page.locator('[data-testid="run-group-body"]');
        // 已渲染行数：必须远小于总条数（全量渲染时这里就是 240）。
        await expect
            .poll(async () => rows.count(), { timeout: LONG_TIMEOUT_MS })
            .toBeLessThan(TOTAL / 4);

        // 会话默认贴底（`default-scroll-position="last-anchor"`）：窗口里是最后几行，
        // 最早那些行**不应**存在于 DOM 里 —— 这是"窗口真的在切"的直接证据。
        await expect(page.getByText("bl316-row-0", { exact: true })).toHaveCount(0);
        await expect(page.getByText(`bl316-row-${TOTAL - 1}`, { exact: true })).toHaveCount(1);
        // 贴底状态下顶部占位撑住已滚过的行（未渲染行靠高度撑住 scrollHeight）。
        const topSpacerHeight = await topSpacer.evaluate((element) =>
            Number.parseFloat((element as HTMLElement).style.height || "0"),
        );
        expect(topSpacerHeight, "顶部占位必须为正").toBeGreaterThan(0);
    });

    /**
     * —— 第二步：**窗口换页不得拽回滚动位置**（用户上滚意图必须赢）——
     *
     * 修复前实测（240 条）：窗口换页会改变内容 DOM 的子节点集合（首行与末行都变），
     * `MessageScrollerProvider.handleContentChange()` 把它当成"新消息到达"走
     * `getNewScrollAnchor` → `scrollToElement(align:"start")`，于是每换一页就把滚动位置往下拽一次：
     * 直接 `scrollTop = 0` 后 5 次采样 25 → 5219 → 16692 → 23710 → 31825 → 38683，最终回到底部 71967；
     * 渐进上滚 40×2000px 也只到 ~35.6k（总高 ~72k）。
     *
     * 修复后判据（本用例）：
     * 1. 40 步上滚的 `scrollTop` 序列**单调不增**（不回跳，允许 8px 锚定容差）；
     * 2. 序列末值 ≈ 0（**能到顶**），且到顶后窗口换成最早的行、末尾行退出窗口；
     * 3. 全程零 pageError / console error（`afterEach` 的 `expectNoPageFailures`）。
     */
    /**
     * BL-340 上滚补偿族 · **task-259 已修，fixme 已解除**（2026-11-15 23:35）。
     *
     * 历史（保留以免重蹈）：task-255 之前长会话首次进入**停在顶部**（初始 st=0）⇒ 第一步
     * `max(0, 0-2000)=0` ⇒ 序列全 0 ⇒「单调不增 + 能到顶」**平凡成立**（假绿，D-1634）；
     * task-255 修好落点后本条转真红，暴露的是既有缺陷。task-255 收口时临时 fixme，由本卡解除。
     *
     * **修法（两处，缺一不可；机制与逐腿读数见
     * internal/A03-xihe/evidence/2026-11-15-task259-upscroll-compensation/README.md）**：
     *   ① `MessageList.vue` 给视口加 `[overflow-anchor:none]` —— 关掉**浏览器原生滚动锚定**。
     *      实测：把库的 428 次补偿判定全部否掉后 scrollTop 仍自己涨回去（无 JS 写入）⇒ 主写者是浏览器。
     *   ② `useVirtualMessageWindow` 用库公开钩子 `shouldAdjustScrollPositionOnItemSizeChange`
     *      把「上滚不补偿」从再次测量扩展到**首次测量**（估算 160 → 实测 675/314 的 +515/+154）。
     *   只 ① 冷启动 40×2000 停在 4352；只 ② 停在 9357；① + ② 逐步 -2000、末值 0。
     *
     * **解除后实测**（pin 61e916def + 本卡两处修法，chrome-beta / mock / 独占 12650）：
     *   `xh255-upscroll`（先显式贴底再 40×2000）: finalTop=**0**、回跳步数=**0**（判据 ≤8）
     *   本文件 `--repeat-each=8`: **16 passed / 0 failed / 0 skipped**（两条都真绿，非 fixme）
     * 判据本身（≤8px、单调不增）**未放宽**，逐字保留。
     */
    test("keeps user scroll position while the window swaps pages", async ({ page }) => {
        const chat = new ChatPage(page);
        await chat.goto(SESSION_ID);
        await expect(chat.scrollerViewport).toBeVisible({ timeout: LONG_TIMEOUT_MS });
        await expect(page.locator('[data-testid="virtual-top-spacer"]')).toHaveCount(1, {
            timeout: LONG_TIMEOUT_MS,
        });

        const STEP_PX = 2_000;
        const steps = 40;
        const sequence: number[] = [];
        for (let step = 0; step < steps; step += 1) {
            sequence.push(
                await page.evaluate((delta) => {
                    const viewport = document.querySelector(
                        '[data-testid="message-scroller-viewport"]',
                    ) as HTMLElement;
                    // 真实滚轮意图（scroller 据此把模式切成 free-scrolling），再上滚一屏。
                    viewport.dispatchEvent(
                        new WheelEvent("wheel", { bubbles: true, deltaY: -120 }),
                    );
                    viewport.scrollTop = Math.max(0, viewport.scrollTop - delta);
                    return viewport.scrollTop;
                }, STEP_PX),
            );
        }

        // 1) 单调不增：任何一步回跳都说明 scroller 又在"跟随新消息"。
        for (let index = 1; index < sequence.length; index += 1) {
            expect(
                sequence[index],
                `第 ${index} 步回跳（应单调不增）：${sequence.join(" → ")}`,
            ).toBeLessThanOrEqual(sequence[index - 1] + 8);
        }
        // 2) 到顶。
        const finalTop = sequence[sequence.length - 1];
        expect(
            finalTop,
            `40×${STEP_PX}px 上滚后应到顶：${sequence.join(" → ")}`,
        ).toBeLessThanOrEqual(8);

        // 3) 到顶后窗口换成最早的行，末尾行退出窗口，且仍是有界窗口。
        await expect(page.getByText("bl316-row-0", { exact: true })).toHaveCount(1, {
            timeout: LONG_TIMEOUT_MS,
        });
        await expect(page.getByText(`bl316-row-${TOTAL - 1}`, { exact: true })).toHaveCount(0);
        const renderedRows = await page.locator('[data-testid="run-group-body"]').count();
        expect(renderedRows).toBeLessThan(TOTAL / 4);

        // 4) 停在顶部后不得被后台"回弹"回底部：轮询一段时间，位置必须一直贴在顶部。
        await expect
            .poll(
                async () =>
                    await page.evaluate(
                        () =>
                            (
                                document.querySelector(
                                    '[data-testid="message-scroller-viewport"]',
                                ) as HTMLElement
                            ).scrollTop,
                    ),
                {
                    message: "到顶后 scrollTop 不得回弹",
                    timeout: ACTION_TIMEOUT_MS,
                    intervals: [200, 200, 200, 200, 200],
                },
            )
            .toBeLessThanOrEqual(8);
    });
});
