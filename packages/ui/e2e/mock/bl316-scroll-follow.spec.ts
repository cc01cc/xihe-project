/**
 * BL-340 判 2 · 滚动跟随语义（两条独立不变量，各自独立断言）。
 *
 * 1. **贴底跟随**：在底部时新内容到达 ⇒ 仍贴底（`scrollHeight - clientHeight - scrollTop < 40`）；
 * 2. **上滚不拽回**：离底超过一屏（上滚 2 屏）后新内容到达 ⇒ `scrollTop` 保持不变（±2px）。
 *
 * 为什么单独成文件（不并入 `bl316-virtual-window.spec.ts`）：那个文件钉的是**窗口化/锚定不变量**，
 * 这里钉的是**跟随语义**；混在一起红时无法一眼区分坏在哪一层（一个用例只钉一个不变量）。
 *
 * 为什么用"服务端推帧"而不是 `sendMessage`：自己发消息在多数聊天 UI 里会**强制回底**，
 * 拿它代理"新内容到达"会把判 2#2 的语义写歪（看着像验了，其实验的是另一条路径）。
 *
 * 采样口径（BL-340 §18.1）：50ms 轮询 `scrollTop`，**连续两次相同**才视为稳定点再断言；
 * 不使用固定 `waitForTimeout`。
 *
 * 踩坑提示（下一个人会踩）：`token` 帧的正文在 **`content`**；`content` 为空串/空数组的帧会被
 * 消费侧**静默忽略**。若"推了帧但界面没变"，先查 payload，不要先去怀疑 scroller。
 */
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { stubSessionProjections } from "./helpers/session-projections";
import type { Page } from "@playwright/test";
import { ChatPage } from "../page-objects/ChatPage";

const SESSION_ID = "bl340-follow-session";
const TOTAL = 120;
const PUSHED_TEXT = "bl340-follow-pushed-row";

/** 覆写 fetch：把 `/api/v1/events` 变成可逐帧推入的 SSE 流，并暴露 `window.__pushToken`。 */
async function installChatSsePush(page: Page): Promise<void> {
    await page.addInitScript(() => {
        type Controller = ReadableStreamDefaultController<Uint8Array>;
        const w = window as unknown as Record<string, unknown>;
        let controllerRef: Controller | null = null;
        const pending: string[] = [];
        const encode = (value: string) => new TextEncoder().encode(value);
        const drain = () => {
            if (!controllerRef) return;
            while (pending.length > 0) {
                const frame = pending.shift();
                if (frame) controllerRef.enqueue(encode(frame));
            }
        };
        // 最小 token 帧：正文在 `content`，`hint: "text"`；帧尾必须有 `\n\n`。
        w.__pushToken = (text: string) => {
            pending.push(
                `event: token\ndata: ${JSON.stringify({ content: text, hint: "text" })}\n\n`,
            );
            drain();
        };
        const originalFetch = window.fetch.bind(window);
        window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
            const url =
                typeof input === "string"
                    ? input
                    : input instanceof Request
                      ? input.url
                      : input.href;
            if (url.includes("/api/v1/events")) {
                const body = new ReadableStream<Uint8Array>({
                    start(controller) {
                        controllerRef = controller;
                        controller.enqueue(encode("retry: 1000\n\n"));
                        queueMicrotask(drain);
                    },
                });
                return new Response(body, {
                    status: 200,
                    headers: { "Content-Type": "text/event-stream" },
                });
            }
            return originalFetch(input, init);
        };
    });
}

interface ScrollSample {
    scrollTop: number;
    distanceToBottom: number;
    series: number[];
}

/** §18.1：50ms 轮询到"连续两次相同"取稳定点；返回序列便于失败时定位。 */
async function readStableScroll(page: Page, timeoutMs = 5_000): Promise<ScrollSample> {
    const startedAt = Date.now();
    const series: number[] = [];
    let previous: number | null = null;
    for (;;) {
        const metrics = await page.evaluate(() => {
            const viewport =
                document.querySelector('[data-testid="message-scroller-viewport"]') ??
                document.querySelector('[data-testid="message-list"]');
            return {
                scrollTop: viewport?.scrollTop ?? 0,
                distanceToBottom: viewport
                    ? viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop
                    : Number.POSITIVE_INFINITY,
            };
        });
        series.push(Math.round(metrics.scrollTop));
        if (previous !== null && Math.abs(metrics.scrollTop - previous) < 0.5) {
            return {
                scrollTop: metrics.scrollTop,
                distanceToBottom: metrics.distanceToBottom,
                series,
            };
        }
        if (Date.now() - startedAt > timeoutMs) {
            throw new Error(
                `[BL-340] scrollTop 在 ${timeoutMs}ms 内未稳定，序列=${series.join(" → ")}`,
            );
        }
        previous = metrics.scrollTop;
        await page.waitForTimeout(50);
    }
}

async function scrollTo(page: Page, target: "bottom" | "up-two-screens"): Promise<void> {
    if (target === "up-two-screens") {
        // **必须用真实手势**：程序化 `scrollTop=` 不会让跟随状态机认为"用户离开了底部"，
        // 于是视口会被锚回底部（首轮实测：set scrollTop 后稳定点仍是底部，distance=0）。
        const box = await page
            .locator('[data-testid="message-scroller-viewport"]')
            .first()
            .boundingBox();
        if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.wheel(0, -720 * 2);
        return;
    }
    await page.evaluate(() => {
        const viewport =
            document.querySelector('[data-testid="message-scroller-viewport"]') ??
            document.querySelector('[data-testid="message-list"]');
        if (viewport) viewport.scrollTop = viewport.scrollHeight;
    });
}

test.describe("BL-340 判 2：滚动跟随语义", () => {
    test.use({ viewport: { width: 1280, height: 720 } });

    test.beforeEach(async ({ page }) => {
        await setupMockAuth(page);
        await setupMockSessions(page, {
            sessions: [{ id: SESSION_ID, title: "BL-340 判 2 跟随" }],
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
        await installChatSsePush(page);
        await page.goto(`/workspace/workspace-1/chat/${SESSION_ID}`);
        await expect(page.locator('[data-testid="message-scroller-viewport"]').first()).toBeVisible(
            { timeout: 20_000 },
        );
    });

    test("判 2#1：贴底时新内容到达后仍贴底（距离 < 40px）", async ({ page }) => {
        await scrollTo(page, "bottom");
        const before = await readStableScroll(page);
        expect(
            before.distanceToBottom,
            `贴底前置：实测 distanceToBottom=${Math.round(before.distanceToBottom)}，期望 < 40`,
        ).toBeLessThan(40);

        await page.evaluate(
            (text) => (window as unknown as { __pushToken: (t: string) => void }).__pushToken(text),
            PUSHED_TEXT,
        );
        // 推帧真的落地了吗（否则可能是 payload 被静默忽略，而不是 scroller 的问题）。
        await expect(page.getByText(PUSHED_TEXT).first()).toBeVisible({ timeout: 10_000 });

        const after = await readStableScroll(page);
        expect(
            after.distanceToBottom,
            `判 2#1 失败：实测 distanceToBottom=${Math.round(after.distanceToBottom)}，期望 < 40` +
                `（序列 ${before.series.join(" → ")} | ${after.series.join(" → ")}）`,
        ).toBeLessThan(40);
    });

    test("判 2#2：上滚 2 屏后新内容到达不把用户拽回（scrollTop 保持 ±2px）", async ({ page }) => {
        await scrollTo(page, "bottom");
        await readStableScroll(page);
        await scrollTo(page, "up-two-screens");
        const before = await readStableScroll(page);
        const startTop = Math.round(before.scrollTop);
        // 前置：必须真的离底（否则本条无意义）。失败信息带上稳定点序列，便于判断是"上滚没生效"
        // 还是"上滚后又被拽回底部"（后者本身就是判 2#2 的缺陷现象）。
        expect(
            before.distanceToBottom,
            `上滚 2 屏后离底=${Math.round(before.distanceToBottom)}px（期望 > 200），` +
                `startTop=${startTop}，稳定点序列=${before.series.join(" → ")}`,
        ).toBeGreaterThan(200);

        await page.evaluate(
            (text) => (window as unknown as { __pushToken: (t: string) => void }).__pushToken(text),
            PUSHED_TEXT,
        );
        await expect(page.getByText(PUSHED_TEXT).first()).toBeVisible({ timeout: 10_000 });

        const after = await readStableScroll(page);
        const drifted = Math.abs(Math.round(after.scrollTop) - startTop);
        expect(
            drifted,
            `判 2#2 失败：S=${startTop}，推帧后稳定点=${Math.round(after.scrollTop)}，漂移=${drifted}px（期望 ≤2）` +
                `（序列 ${after.series.join(" → ")}）`,
        ).toBeLessThanOrEqual(2);
    });
    test("判 2#3：走产品自带滚动入口离开底部后，新内容到达也不拽回", async ({ page }) => {
        const chat = new ChatPage(page);
        await scrollTo(page, "bottom");
        await readStableScroll(page);
        // 产品侧入口（page-object 按"用户发起"语义实现：dispatch wheel + 置 scrollTop）。
        await chat.scrollToTop();
        const before = await readStableScroll(page);
        expect(
            before.scrollTop,
            `离开底部失败：scrollTop=${Math.round(before.scrollTop)}，序列=${before.series.join(" → ")}`,
        ).toBeLessThan(1);
        await page.evaluate(
            (text) => (window as unknown as { __pushToken: (t: string) => void }).__pushToken(text),
            PUSHED_TEXT,
        );
        await expect(page.getByText(PUSHED_TEXT).first()).toBeVisible({ timeout: 10_000 });
        const after = await readStableScroll(page);
        expect(
            Math.round(after.scrollTop),
            `判 2#3 被拽回：S=0，推帧后稳定点=${Math.round(after.scrollTop)}，序列=${after.series.join(" → ")}`,
        ).toBeLessThan(40);
    });
});
