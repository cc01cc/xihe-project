/**
 * mock 车道的"会话侧投影"最小 fixture（PLAN-0660 T5.6 / BL-311 挂载 ChatPanel 时必需）。
 *
 * 为什么需要：`setupMockSessions` 对 `/sessions/{id}/{未知后缀}` 回答 **404**，而聊天列挂载后会主动
 * 拉 `derived-state`、`follow-ups`、`commands` 三个投影 —— 不桩就是真 404 + 「Failed to load …」的
 * console error。那是**夹具缺口**，不是产品缺陷；一旦把 "0 console error" 当判据，它会伪装成回归。
 *
 * 形状照抄既有用例（`e2e/mock/plan-0631-variants.spec.ts` 的 `mockSessionProjections`，
 * 同一份 fixture 已在多个 mock spec 里用过），改契约时以 API parser 为准同步这里。
 */
import type { Page } from "@playwright/test";

export async function stubSessionProjections(page: Page, sessionId: string): Promise<void> {
    await page.route(`**/api/v1/sessions/${sessionId}/derived-state`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ sessionId, activeChildren: [], terminalNotices: [] }),
        });
    });
    await page.route(`**/api/v1/sessions/${sessionId}/follow-ups`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                sessionId,
                queueState: "empty",
                outstandingCount: 0,
                capacityLimit: 5,
                pauseReason: null,
                items: [],
            }),
        });
    });
    await page.route(`**/api/v1/sessions/${sessionId}/commands`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ commands: [] }),
        });
    });
}

/**
 * 外部字体请求的失败信号：`src/styles/main.css` 用 `@import` 拉 Google Fonts，离线/受限网络下
 * 浏览器会报 `net::ERR_CONNECTION_CLOSED`。既有的 "0 console error" 用法也用同一条放行
 * （`e2e/real/plan-0508-transport-telemetry.spec.ts:105`、`e2e/real/run-trace.spec.ts:348`）。
 * 它是**环境**信号，与本 lane 的判据无关；放行只针对这一个来源。
 */
export const FONT_ORIGIN_FAILURE = /fonts\.(googleapis|gstatic)\.com/;
