/**
 * BL-348 段 2（**临时探针，不提交**）：90 秒连续滚动下的 heap 时间序列。
 *
 * 目的：回答"长时间滚动时 heap 是否单调上升"，**不是**跑 30 分钟长跑。
 * 采样：每 15 秒用 CDP 取一次 `HeapProfiler.collectGarbage` ×2 后的 `Runtime.getHeapUsage`。
 */
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { stubSessionProjections } from "./helpers/session-projections";
import type { CDPSession, Page } from "@playwright/test";
import { writeFileSync } from "node:fs";

const SESSION_ID = "bl348-longrun";
const MESSAGE_COUNT = 2_000;
const DURATION_MS = 90_000;
const STEP_MS = 15_000;

async function stubLongSession(page: Page): Promise<void> {
    const messages = Array.from({ length: MESSAGE_COUNT }, (_, index) => ({
        id: `msg-${index}`,
        sessionId: SESSION_ID,
        role: index % 2 === 0 ? "USER" : "ASSISTANT",
        content: `第 ${index} 条消息 —— 长跑探针填充文本（长度稳定）。`,
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

async function sampleHeap(page: Page, cdp: CDPSession) {
    for (let round = 0; round < 2; round += 1) await cdp.send("HeapProfiler.collectGarbage");
    await page.evaluate(
        () =>
            new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
    );
    const used = (await cdp.send("Runtime.getHeapUsage")) as { usedSize: number };
    const counters = (await cdp.send("Memory.getDOMCounters")) as {
        nodes: number;
        jsEventListeners: number;
    };
    return {
        heapMb: Math.round((used.usedSize / 1024 / 1024) * 10) / 10,
        domNodes: counters.nodes,
        listeners: counters.jsEventListeners,
        renderedRows: await page.evaluate(
            () => document.querySelectorAll('[data-testid="message-item"]').length,
        ),
    };
}

test.describe("BL-348 长跑探针", () => {
    test.use({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });

    // 90s 长跑会拖慢常规 e2e：默认 skip，需要时 `BL348_LONGRUN=1 pnpm exec playwright test …`。
    test.skip(!process.env.BL348_LONGRUN, "长跑探针默认跳过（设 BL348_LONGRUN=1 启用）");
    test("90s 连续滚动：每 15s 采 heap", async ({ page }) => {
        test.setTimeout(240_000);
        await setupMockAuth(page);
        await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "BL-348 longrun" }] });
        await stubSessionProjections(page, SESSION_ID);
        await stubLongSession(page);
        await page.goto(`/workspace/workspace-1/chat/${SESSION_ID}`);
        await expect(page.locator('[data-testid="message-item"]').first()).toBeVisible({
            timeout: 30_000,
        });
        await page.waitForTimeout(1000);

        const cdp = await page.context().newCDPSession(page);
        await cdp.send("HeapProfiler.enable");
        await cdp.send("Runtime.enable");

        const series: Array<{
            tSec: number;
            heapMb: number;
            domNodes: number;
            listeners: number;
            renderedRows: number;
        }> = [];
        series.push({ tSec: 0, ...(await sampleHeap(page, cdp)) });

        const startedAt = Date.now();
        for (let step = 1; step * STEP_MS <= DURATION_MS; step += 1) {
            const targetAt = startedAt + step * STEP_MS;
            // 连续滚动：脚本驱动上下往复（每 100ms 一次），模拟持续滚动负载。
            while (Date.now() < targetAt) {
                await page.evaluate(
                    (tick) => {
                        const viewport = document.querySelector(
                            '[data-testid="message-scroller-viewport"]',
                        ) as HTMLElement;
                        const span = Math.max(1, viewport.scrollHeight - viewport.clientHeight);
                        const progress = (tick % 20) / 20;
                        viewport.scrollTop = Math.floor(
                            span * (progress < 0.5 ? progress * 2 : (1 - progress) * 2),
                        );
                    },
                    step * 10 + Math.floor((Date.now() % 1000) / 100),
                );
                await page.waitForTimeout(100);
            }
            series.push({ tSec: step * 15, ...(await sampleHeap(page, cdp)) });
        }

        const outPath = process.env.BL348_OUT;
        if (outPath)
            writeFileSync(
                outPath,
                `${JSON.stringify({ series, durationMs: DURATION_MS }, null, 2)}\n`,
                "utf8",
            );
        console.log(`[BL-348 LONGRUN] ${JSON.stringify(series)}`);
        expect(series.length).toBeGreaterThan(3);
    });
});
