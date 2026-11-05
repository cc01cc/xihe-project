/**
 * BL-329 · 长会话窗口化预算（把"人工测量过的数字"变成可回归的门）。
 *
 * 背景数字（2026-11-05 人工实测，2k vs 5k 消息）：渲染行 50、DOM ~1,336→1,345、
 * heap 54.3→54.5 MB、60 fps；5 次往返后回基线（DOM 1,363、heap 51.0→47.9 MB）。
 *
 * 阈值为什么是这些数（预算 = 实测基线的 2–3 倍，留出正常波动但能抓住"窗口化失效"）：
 * - **渲染行 ≤120**（>200 失败）：窗口化正常时只挂 ~50 行；一旦失效会挂到消息总数（2k），
 *   120 给出 2 倍余量 —— **>200 判失败**是因为 200 已明显不是"窗口化在起作用"。
 * - **DOM ≤3000**（>5000 失败）：基线 ~1,340 节点；窗口化失效时每条消息 ~8–15 节点 ⇒ 2k 条
 *   就是 2 万+。3000 是"正常布局 + 若干面板"的上限，5000 是明确异常。
 * - **heap ≤80MB**（>120 或 30min 内 +50% 失败）：基线 54 MB；80 留 50% 余量，120 是"明显泄漏"。
 * - **long task ≤2 per 4s**：60fps 要求单帧 <16.7ms，连续滚动期间不该反复出现 >50ms 的任务。
 *
 * 纪律：**不依赖 `__xhVirtualDebug`**（DEV hook 不进生产构建）；heap 取不到就**跳过并注明**，
 * 不 fake、不估算。失败信息给**实测值 + 阈值**两个数。
 *
 * 方法学（2026-11-06 首版教训 + Lead 裁定）：
 * - **首版把 120MB 当断言直接红 ⇒ 那才是拿错误口径造假红**；**判据宁可不写，也不要写假红**。
 * - 反之**宽阈值也是"绿了但没证明任何事"**：所以断言贴在基线上一档（120 行 / 3000 节点），
 *   而不是灾难线（200 / 5000）。实测 7 行 / 471 节点，二者仍有一个数量级余量。
 */
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { stubSessionProjections } from "./helpers/session-projections";
import type { Page } from "@playwright/test";

const SESSION_ID = "bl329-long-session";
const MESSAGE_COUNT = 2_000;

const BUDGET = {
    renderedRows: 120,
    renderedRowsHardFail: 200,
    domNodes: 3_000,
    domNodesHardFail: 5_000,
    heapMb: 80,
    heapMbHardFail: 120,
    longTasksPer4s: 2,
} as const;

interface Metrics {
    renderedRows: number;
    domNodes: number;
    heapMb: number | null;
    scrollHeight: number;
    scrollTop: number;
}

/** 一次性灌 N 条消息（`GET /api/v1/sessions/{id}/messages` 支持裸数组返回）。 */
async function stubLongSession(page: Page): Promise<void> {
    const messages = Array.from({ length: MESSAGE_COUNT }, (_, index) => ({
        id: `msg-${index}`,
        sessionId: SESSION_ID,
        role: index % 2 === 0 ? "USER" : "ASSISTANT",
        content: `第 ${index} 条消息 —— 长会话窗口化预算用例的填充文本。`,
        createdAt: new Date(Date.UTC(2026, 10, 5, 12, 0, 0) + index * 1000).toISOString(),
        sequence: index + 1,
        runId: null,
    }));
    await page.route("**/api/v1/sessions/*/messages*", async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(messages),
        });
    });
}

async function measure(page: Page): Promise<Metrics> {
    return page.evaluate(() => {
        const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
        const scroller =
            document.querySelector('[data-testid="message-scroller-viewport"]') ??
            document.querySelector('[data-testid="message-list"]');
        return {
            renderedRows: document.querySelectorAll('[data-testid="message-item"]').length,
            domNodes: document.querySelectorAll("*").length,
            heapMb: heap ? Math.round((heap.usedJSHeapSize / 1024 / 1024) * 10) / 10 : null,
            scrollHeight: scroller?.scrollHeight ?? 0,
            scrollTop: scroller?.scrollTop ?? 0,
        };
    });
}

/** 失败时给实测值 + 阈值两个数。 */
function expectWithinBudget(label: string, actual: number, threshold: number) {
    expect(actual, `${label}：实测 ${actual}，阈值 ≤${threshold}`).toBeLessThanOrEqual(threshold);
}

test.describe("BL-329 长会话窗口化预算", () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test("2k 消息：渲染行 / DOM / heap / long task 都在预算内，往返后回收", async ({ page }) => {
        test.setTimeout(120_000);
        await setupMockAuth(page);
        await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "BL-329 长会话" }] });
        await stubSessionProjections(page, SESSION_ID);
        await stubLongSession(page);

        await page.goto(`/workspace/workspace-1/chat/${SESSION_ID}`);
        await expect(page.locator('[data-testid="message-item"]').first()).toBeVisible({
            timeout: 30_000,
        });

        const atBottom = await measure(page);
        // 判据贴在**基线上一档**（实测 7 行 / 471 节点 ⇒ ≤120 / ≤3000 仍有一个数量级余量），
        // 灾难线（200 行 / 5000 节点）只作为注释里的"再往上就是彻底失效"说明，不作断言。
        expectWithinBudget("渲染行数（滚到底）", atBottom.renderedRows, BUDGET.renderedRows);
        expectWithinBudget("DOM 节点数（滚到底）", atBottom.domNodes, BUDGET.domNodes);
        // heap：**故意不做绝对阈值**。本车道跑的是 Vite dev server + Playwright，
        // `performance.memory.usedJSHeapSize` 含 dev 运行时与源码映射，实测 359–413MB，
        // 与 BL-329 人工基线（54MB）不是同一口径 ⇒ 绝对值不可比（记为"未验证"）。
        // 这里只做**量级 sanity**（>900MB 视为异常泄漏），并把实测值打进控制台供对照。
        if (atBottom.heapMb !== null) {
            expect(
                atBottom.heapMb,
                `heap 量级 sanity：实测 ${atBottom.heapMb}MB，阈值 ≤900MB（绝对阈值见注释，未与 54MB 基线对比）`,
            ).toBeLessThanOrEqual(900);
        }

        // 滚到中部再采一次：窗口化在中段也要保持行数恒定（不是"只有底部被裁"）。
        await page.evaluate(() => {
            const scroller =
                document.querySelector('[data-testid="message-scroller-viewport"]') ??
                document.querySelector('[data-testid="message-list"]');
            if (scroller) scroller.scrollTop = Math.floor(scroller.scrollHeight / 2);
        });
        await page.waitForTimeout(500);
        const atMiddle = await measure(page);
        expectWithinBudget("渲染行数（滚到中部）", atMiddle.renderedRows, BUDGET.renderedRows);

        // 连续滚动 4s 内的 long task 数（FPS 的廉价代理）。
        const longTasks = await page.evaluate(async () => {
            const scroller =
                document.querySelector('[data-testid="message-scroller-viewport"]') ??
                document.querySelector('[data-testid="message-list"]');
            let count = 0;
            const observer = new PerformanceObserver((list) => {
                count += list.getEntries().length;
            });
            try {
                observer.observe({ entryTypes: ["longtask"] });
            } catch {
                return -1;
            }
            const deadline = performance.now() + 4000;
            while (performance.now() < deadline) {
                if (scroller) scroller.scrollTop = Math.max(0, scroller.scrollTop - 400);
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            observer.disconnect();
            return count;
        });
        if (longTasks >= 0) {
            expect(
                longTasks,
                `连续滚动 4s 内 long task 数：实测 ${longTasks}，阈值 ≤${BUDGET.longTasksPer4s}`,
            ).toBeLessThanOrEqual(BUDGET.longTasksPer4s);
        }

        // 往返回收：回到顶部再回底部，渲染行与 DOM 应回到首轮 ±10%。
        await page.evaluate(() => {
            const scroller =
                document.querySelector('[data-testid="message-scroller-viewport"]') ??
                document.querySelector('[data-testid="message-list"]');
            if (scroller) scroller.scrollTop = 0;
        });
        await page.waitForTimeout(500);
        await page.evaluate(() => {
            const scroller =
                document.querySelector('[data-testid="message-scroller-viewport"]') ??
                document.querySelector('[data-testid="message-list"]');
            if (scroller) scroller.scrollTop = scroller.scrollHeight;
        });
        await page.waitForTimeout(800);
        const afterRoundTrip = await measure(page);

        const rowDelta = Math.abs(afterRoundTrip.renderedRows - atBottom.renderedRows);
        expect(
            rowDelta,
            `往返后渲染行数回收：首轮 ${atBottom.renderedRows} → 往返后 ${afterRoundTrip.renderedRows}（允许 ±10%）`,
        ).toBeLessThanOrEqual(Math.ceil(atBottom.renderedRows * 0.1) + 2);
        const domGrowth = afterRoundTrip.domNodes - atBottom.domNodes;
        expect(
            domGrowth,
            `往返后 DOM 增长：首轮 ${atBottom.domNodes} → 往返后 ${afterRoundTrip.domNodes}（允许 +10%）`,
        ).toBeLessThanOrEqual(Math.ceil(atBottom.domNodes * 0.1));

        // 报告用：把实测数字打出来（不含断言，便于粘进证据）。
        console.log(
            `[BL-329] messages=${MESSAGE_COUNT} bottom(rows=${atBottom.renderedRows}, dom=${atBottom.domNodes}, heap=${atBottom.heapMb ?? "n/a"}MB) ` +
                `middle(rows=${atMiddle.renderedRows}) roundTrip(rows=${afterRoundTrip.renderedRows}, dom=${afterRoundTrip.domNodes}, heap=${afterRoundTrip.heapMb ?? "n/a"}MB) ` +
                `longTasks=${longTasks < 0 ? "n/a" : longTasks}/4s`,
        );
    });
});
