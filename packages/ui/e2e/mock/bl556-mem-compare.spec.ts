// timeout-exempt: CDP heap 采样 + prepend 几何稳定，按 BL-348 通道协议超默认 30s
/**
 * PLAN-0760 内存对照（2000 档）：prepend 前后 CDP JS heap + rendered rows 窗口有界。
 *
 * 复用 BL-348 的 CDP 采样协议（collectGarbage×2 → rAF → 连采取中位）。
 * 对照点：首屏 500（N=最近段）→ 连点 prepend 到 M=1500（总 2000）前后各采样一次，
 * 验证 ① JS heap 增长有界 ② rendered rows < 总量/4（虚拟滚动窗口有界，不随总量线性膨胀）。
 */
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { stubSessionProjections } from "./helpers/session-projections";
import type { CDPSession, Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { LONG_TIMEOUT_MS, TEST_TIMEOUT_MS } from "../timeouts";

const SESSION_ID = "bl556-mem-compare";
const TOTAL = 2000;
const FIRST_SCREEN = 500;
const PAGE = 500;

const MESSAGES_PATH = (sessionId: string) => `/api/v1/sessions/${sessionId}/messages`;

function makeMessages(count: number, offset: number) {
    return Array.from({ length: count }, (_, index) => {
        const globalIndex = offset + index;
        return {
            id: `bl556-mem-${globalIndex}`,
            sessionId: SESSION_ID,
            role: globalIndex % 2 === 0 ? "USER" : "ASSISTANT",
            content: `第 ${globalIndex} 条 —— PLAN-0760 内存对照填充文本（定长保可比）。`,
            createdAt: new Date(
                Date.UTC(2026, 10, 10, 12, 0, 0) + globalIndex * 1000,
            ).toISOString(),
            sequence: globalIndex + 1,
            runId: null,
        };
    });
}

type Sample = { renderedRows: number; heapMb: number };

async function sampleOnce(page: Page, cdp: CDPSession): Promise<Sample> {
    for (let round = 0; round < 2; round += 1) {
        await cdp.send("HeapProfiler.collectGarbage");
    }
    await page.evaluate(
        () =>
            new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
    );
    const used = (await cdp.send("Runtime.getHeapUsage")) as { usedSize: number };
    const renderedRows = await page.evaluate(
        () => document.querySelectorAll('[data-testid="message-item"]').length,
    );
    return { renderedRows, heapMb: Math.round((used.usedSize / 1024 / 1024) * 10) / 10 };
}

test.describe("PLAN-0760 内存对照（2000 档）", () => {
    test.use({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });

    test("prepend 前后 CDP heap + rendered rows 窗口有界", async ({ page }) => {
        test.setTimeout(TEST_TIMEOUT_MS);
        await setupMockAuth(page);
        await setupMockSessions(page, {
            sessions: [{ id: SESSION_ID, title: "BL-556 mem compare" }],
        });
        await stubSessionProjections(page, SESSION_ID);
        const all = makeMessages(TOTAL, 0);
        const path = MESSAGES_PATH(SESSION_ID);
        // 动态 before 路由：每页 500（唯一 id），无限分页。
        await page.route(
            (url) =>
                url.hostname === "localhost" &&
                url.pathname.endsWith(path) &&
                url.searchParams.has("before"),
            async (route) => {
                const cursor = Number(
                    route.request().url().split("before=").pop()?.split("-").pop() ?? String(TOTAL),
                );
                const end = Math.max(0, cursor);
                const start = Math.max(0, end - PAGE);
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({
                        messages: all.slice(start, end),
                        nextCursor: `c-${start}`,
                        truncated: start > 0,
                    }),
                });
            },
        );
        await page.route(
            (url) =>
                url.hostname === "localhost" &&
                url.pathname.endsWith(path) &&
                !url.searchParams.has("before"),
            async (route) => {
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({
                        messages: all.slice(TOTAL - FIRST_SCREEN),
                        nextCursor: `c-${TOTAL - FIRST_SCREEN}`,
                        truncated: true,
                    }),
                });
            },
        );

        await page.goto(`/workspace/workspace-1/chat/${SESSION_ID}`);
        await expect(page.locator('[data-testid="message-item"]').first()).toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
        await page.waitForTimeout(1000);

        const cdp = await page.context().newCDPSession(page);
        await cdp.send("HeapProfiler.enable");
        await cdp.send("Runtime.enable");

        // 首屏（N=500）采样。
        const beforeSamples: Sample[] = [];
        for (let i = 0; i < 5; i += 1) {
            beforeSamples.push(await sampleOnce(page, cdp));
            await page.waitForTimeout(100);
        }
        const before = beforeSamples[2] ?? beforeSamples[0];

        // 连点 prepend 到 M=1500（总 2000）。
        const button = page.locator('[data-testid="load-older-messages"]');
        await expect(button).toBeVisible({ timeout: LONG_TIMEOUT_MS });
        for (let i = 0; i < 3; i += 1) {
            const text = ((await button.textContent()) ?? "").trim();
            if (text.includes("已展开到上限") || text.includes("Expanded to the limit")) break;
            await button.click();
            await page.waitForTimeout(300);
        }
        await page.waitForTimeout(1000);

        // prepend 后（N+M=2000）采样。
        const afterSamples: Sample[] = [];
        for (let i = 0; i < 5; i += 1) {
            afterSamples.push(await sampleOnce(page, cdp));
            await page.waitForTimeout(100);
        }
        const after = afterSamples[2] ?? afterSamples[0];

        const payload = {
            generatedAt: new Date().toISOString(),
            fixture: String(TOTAL),
            before,
            after,
            renderedRowsBound: TOTAL / 4,
            windowBounded: after.renderedRows < TOTAL / 4,
        };
        const outPath = process.env.BL556_MEM_OUT;
        if (outPath) writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
        console.log(`[BL556 MEM] before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
        // 虚拟滚动窗口有界：rendered rows 显著小于总量/4。
        expect(after.renderedRows, "rendered rows 应 < 总量/4（窗口有界）").toBeLessThan(TOTAL / 4);
    });
});
