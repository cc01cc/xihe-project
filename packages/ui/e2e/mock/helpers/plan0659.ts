// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
import { expect, type Page } from "@playwright/test";
import { closeDockPanel, dockTab, openDockPanel } from "../../helpers/dock";
import { LONG_TIMEOUT_MS } from "../../timeouts";

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
    if ((await dockTab(page, "monitor").count()) === 0) {
        await expect(page.getByTestId("dock-tab-monitor")).toHaveCount(0);
        return;
    }
    // 关闭键只在**活动**页签上渲染（`close-active-only`）⇒ 非活动页签先激活再关。
    // 旧写法直接找 `dock-tab-close-monitor`，monitor 不是活动页签时 count=0 ⇒ 一次都没点，
    // 断言收到 1（task-137 实测）。这里改走共用帮助器，顺序 = 展开 → 激活 → 关。
    await openDockPanel(page, "monitor");
    await closeDockPanel(page, "monitor");
}

/** 打开会话并等 composer 就绪（readiness，不是时钟）。 */
export async function openMockSession(page: Page, sessionId: string): Promise<void> {
    await page.goto(`/workspace/11111111-1111-4111-8111-111111111111/chat/${sessionId}`);
    await expect(page.getByTestId("chat-input"), "composer mounts").toBeVisible({
        timeout: LONG_TIMEOUT_MS,
    });
}
