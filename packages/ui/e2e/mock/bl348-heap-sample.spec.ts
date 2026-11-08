// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
/**
 * BL-348 heap 口径通道的**采样夹具**（由 `scripts/l2/heap-sample.mjs` 驱动，也可单独跑）。
 *
 * 与 `bl329-long-session-budget.spec.ts` 的分工：
 * - 那个用例是**预算门**（断言预算，跑在 dev server 上，heap 只做量级 sanity）；
 * - 本夹具是**通道**（不做断言，只**如实采样**并写 JSON）：用 **CDP** 取堆/DOM 计数，
 *   因为 `performance.memory.usedJSHeapSize` 在 dev 构建下含运行时与 sourcemap，不可比。
 *
 * 采样协议（与 `scripts/l2/heap-sample.mjs` 的 PROTOCOL 一致，改一处必须改另一处）：
 *   `HeapProfiler.collectGarbage` ×2 → 等 rAF → 连采 5 次（间隔 100ms）→ 取中位 + min/max。
 */
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { stubSessionProjections } from "./helpers/session-projections";
import type { CDPSession, Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { LONG_TIMEOUT_MS, TEST_TIMEOUT_MS } from "../timeouts";

const SESSION_ID = "bl348-heap-sample";
const PROTOCOL = (() => {
    try {
        const raw = process.env.BL348_PROTOCOL;
        if (raw)
            return JSON.parse(raw) as {
                gcRounds: number;
                samples: number;
                sampleIntervalMs: number;
                settleBeforeSampleMs: number;
            };
    } catch {
        // 忽略：回落到默认协议
    }
    return { gcRounds: 2, samples: 5, sampleIntervalMs: 100, settleBeforeSampleMs: 1000 };
})();

const FIXTURE = process.env.BL348_FIXTURE === "5k" ? 5_000 : 2_000;

async function stubLongSession(page: Page): Promise<void> {
    const messages = Array.from({ length: FIXTURE }, (_, index) => ({
        id: `msg-${index}`,
        sessionId: SESSION_ID,
        role: index % 2 === 0 ? "USER" : "ASSISTANT",
        content: `第 ${index} 条消息 —— BL-348 heap 口径通道的填充文本（长度稳定以保可比性）。`,
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

type RawSample = {
    renderedRows: number;
    domNodes: number;
    jsEventListeners: number;
    documents: number;
    heapMb: number;
};

async function sampleOnce(page: Page, cdp: CDPSession): Promise<RawSample> {
    for (let round = 0; round < PROTOCOL.gcRounds; round += 1) {
        await cdp.send("HeapProfiler.collectGarbage");
    }
    await page.evaluate(
        () =>
            new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
    );
    const used = (await cdp.send("Runtime.getHeapUsage")) as { usedSize: number };
    const counters = (await cdp.send("Memory.getDOMCounters")) as {
        documents: number;
        nodes: number;
        jsEventListeners: number;
    };
    const renderedRows = await page.evaluate(
        () => document.querySelectorAll('[data-testid="message-item"]').length,
    );
    return {
        renderedRows,
        domNodes: counters.nodes,
        jsEventListeners: counters.jsEventListeners,
        documents: counters.documents,
        heapMb: Math.round((used.usedSize / 1024 / 1024) * 10) / 10,
    };
}

function summarize(values: number[]) {
    const sorted = [...values].sort((left, right) => left - right);
    return {
        median: sorted[Math.floor(sorted.length / 2)] ?? 0,
        min: sorted[0] ?? 0,
        max: sorted[sorted.length - 1] ?? 0,
    };
}

test.describe("BL-348 heap 口径通道", () => {
    test.use({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });

    test("2k/5k 消息：CDP 采样 5 次并写 JSON", async ({ page }) => {
        test.setTimeout(TEST_TIMEOUT_MS);
        await setupMockAuth(page);
        await setupMockSessions(page, {
            sessions: [{ id: SESSION_ID, title: "BL-348 heap sample" }],
        });
        await stubSessionProjections(page, SESSION_ID);
        await stubLongSession(page);

        await page.goto(`/workspace/workspace-1/chat/${SESSION_ID}`);
        await expect(page.locator('[data-testid="message-item"]').first()).toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
        // 采样窗口前静置（禁止采样期间有滚动/输入产生的临时对象）
        await page.waitForTimeout(PROTOCOL.settleBeforeSampleMs);

        const cdp = await page.context().newCDPSession(page);
        await cdp.send("HeapProfiler.enable");
        await cdp.send("Runtime.enable");

        const raw: RawSample[] = [];
        for (let index = 0; index < PROTOCOL.samples; index += 1) {
            raw.push(await sampleOnce(page, cdp));
            await page.waitForTimeout(PROTOCOL.sampleIntervalMs);
        }

        const metrics = {
            renderedRows: summarize(raw.map((item) => item.renderedRows)),
            domNodes: summarize(raw.map((item) => item.domNodes)),
            jsHeapMb: summarize(raw.map((item) => item.heapMb)),
            jsEventListeners: summarize(raw.map((item) => item.jsEventListeners)),
            documents: summarize(raw.map((item) => item.documents)),
        };

        const chromium = await page.evaluate(() => navigator.userAgent);
        const payload = {
            generatedAt: new Date().toISOString(),
            fixture: String(FIXTURE),
            chromium,
            viewport: { width: 1920, height: 1080 },
            dpr: 2,
            samples: PROTOCOL.samples,
            raw,
            metrics,
        };
        const outPath = process.env.BL348_OUT;
        if (outPath) writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
        console.log(`[BL-348 SAMPLE] ${JSON.stringify(metrics)}`);
        // 通道**不做断言**：预算断言属于 BL-329 的门，本夹具只负责"如实、可比地采样"。
        expect(metrics.renderedRows.median).toBeGreaterThan(0);
    });
});
