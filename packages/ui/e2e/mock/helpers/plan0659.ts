import { expect, type Page } from "@playwright/test";

/**
 * PLAN-0659 浏览器证据（mock 车道）的共用夹具。只做两件与**判据无关**的页面收拾：
 *
 * 1. 桩 `derived-state` 空投影：mock 车道不造委派数据时该面板诚实报「暂不可用」——那是
 *    **没桩**，不是被测行为；截图留证时不能把红字当产品缺陷看。
 * 2. 关掉右栏监控 dock tab：mock 车道没有真实监控数据，同理。
 *
 * 任何断言都不依赖这两个函数；它们只让证据截图只讲本判据那一件事。
 */
export async function stubDerivedState(page: Page, sessionId: string): Promise<void> {
    await page.route(`**/api/v1/sessions/${sessionId}/derived-state`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ sessionId, activeChildren: [], terminalNotices: [] }),
        });
    });
}

export async function closeMonitorDockTab(page: Page): Promise<void> {
    const close = page.getByTestId("dock-tab-close-monitor");
    if ((await close.count()) > 0) await close.click();
    await expect(page.getByTestId("dock-tab-monitor")).toHaveCount(0);
}

/** 打开会话并等 composer 就绪（readiness，不是时钟）。 */
export async function openMockSession(page: Page, sessionId: string): Promise<void> {
    await page.goto(`/workspace/workspace-1/chat/${sessionId}`);
    await expect(page.getByTestId("chat-input"), "composer mounts").toBeVisible({
        timeout: 15_000,
    });
}
