/**
 * BL-341 · 三宽（1920/1440/1080）"无横向溢出"回归。
 *
 * 为什么要有这条：对外截图与验收口径都要求三宽，而此前 UI 的溢出覆盖只有 390×844 与
 * 1280×720 两档 ⇒ "三宽无横向溢出"只能靠人眼看图、进不了回归。本 spec 把它变成门。
 *
 * 判据（三处，每处都看**滚动容器自身**，因为很多溢出发生在内部容器而不是页面根）：
 * 1. 页面根 `<html>`；2. 消息列表的内部滚动容器；3. 成员面板（内部列表）。
 *
 * 纪律：**不断言具体像素/颜色**（A″ token 可能再调），只看 `scrollWidth <= clientWidth + 1`。
 * 失败信息带 `scrollWidth/clientWidth` 两个数与最宽子元素的 `tagName + class`，便于定位。
 */
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { stubSessionProjections } from "./helpers/session-projections";
import type { Page } from "@playwright/test";

const SESSION_ID = "bl341-session";
const WIDTHS = [
    { width: 1920, height: 1080 },
    { width: 1440, height: 900 },
    { width: 1080, height: 720 },
] as const;

/** 内联在 spec 里（不进 `helpers/**`）：失败时给数 + 最宽子元素，不只报 true/false。 */
async function expectNoHorizontalOverflow(
    page: Page,
    selector: string,
    label: string,
): Promise<void> {
    // 用 `page.evaluate(selector)` 而不是 `locator.evaluate`：后者会等 locator 可见/唯一，
    // 面板还没挂载时会一直等到测试超时（首版就是这么红的）。
    const metrics = await page.evaluate((sel) => {
        const el = sel === "html" ? document.documentElement : document.querySelector(sel);
        if (!el) return null;
        let widest = { tag: "", cls: "", width: 0 };
        for (const child of Array.from(el.querySelectorAll("*"))) {
            const box = child.getBoundingClientRect();
            if (box.width > widest.width) {
                widest = {
                    tag: child.tagName.toLowerCase(),
                    cls: (child.getAttribute("class") ?? "").slice(0, 80),
                    width: Math.round(box.width),
                };
            }
        }
        return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, widest };
    }, selector);

    expect(metrics, `${label}：找不到 ${selector}`).not.toBeNull();
    if (!metrics) return;
    // 报告用：三宽 × 三处的实测数字（scrollWidth/clientWidth）。
    console.log(`[BL-341] ${label}: ${metrics.scrollWidth}/${metrics.clientWidth}`);
    expect
        .soft(
            metrics.scrollWidth,
            `${label} 横向溢出：scrollWidth=${metrics.scrollWidth} clientWidth=${metrics.clientWidth}` +
                `；最宽子元素 <${metrics.widest.tag} class="${metrics.widest.cls}"> ${metrics.widest.width}px`,
        )
        .toBeLessThanOrEqual(metrics.clientWidth + 1);
}

async function openChat(page: Page): Promise<void> {
    await setupMockAuth(page);
    await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "BL-341" }] });
    await stubSessionProjections(page, SESSION_ID);
    await page.route("**/api/v1/sessions/*/participants*", async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                participants: [
                    {
                        participantId: "part-owner",
                        principalKind: "HUMAN",
                        principalId: "user-1",
                        displayName: "Owner One",
                        role: "MEMBER",
                        orderIndex: 1,
                        wakePolicy: "ALL_MESSAGES",
                        respondPolicy: "ALWAYS",
                        readCursor: { lastReadSequence: 3, mentionCount: 1 },
                    },
                    {
                        participantId: "part-agent",
                        principalKind: "AGENT",
                        principalId: "00000000-0000-4000-8000-0000000000a1",
                        displayName: "Mock Agent",
                        role: "PRIMARY",
                        orderIndex: 10,
                        wakePolicy: "ALL_MESSAGES",
                        respondPolicy: "ALWAYS",
                    },
                ],
                capabilities: { view: true, manage: true, mention: true, speakAs: true },
            }),
        });
    });
    await page.goto(`/workspace/workspace-1/chat/${SESSION_ID}`);
    await expect(page.locator("body")).toBeVisible({ timeout: 15000 });
}

for (const size of WIDTHS) {
    test.describe(`BL-341 ${size.width}×${size.height} 无横向溢出`, () => {
        test.use({ viewport: { width: size.width, height: size.height } });

        test("页面根 / 消息滚动容器 / 成员面板 三处都不溢出", async ({ page }) => {
            await openChat(page);

            await expectNoHorizontalOverflow(page, "html", "页面根 <html>");

            // 消息区：优先内部滚动容器，其次消息列表，最后会话列（三者按实际挂载取其一）。
            // 1920 下默认 dock 是文件面板，聊天要等它挂载后才存在，所以用轮询而不是硬等。
            const messageArea = await page.evaluate(() => {
                const candidates = [
                    '[data-testid="message-scroller-viewport"]',
                    '[data-testid="message-list"]',
                    '[data-testid="workspace-conversation"]',
                ];
                return candidates.find((sel) => document.querySelector(sel) !== null) ?? null;
            });
            expect(messageArea, "消息区容器都不存在（聊天列没挂载？）").not.toBeNull();
            await expectNoHorizontalOverflow(page, messageArea as string, "消息区容器");

            // 成员面板：桌面由 dock 的 members 标签承担（打开 → 断言 → 关闭）。
            const membersTab = page.locator('[data-testid="workspace-toolbar-members"]');
            await expect(membersTab).toBeVisible({ timeout: 15000 });
            await membersTab.click();
            const panel = page.locator('[data-testid="session-participants-panel"]');
            await expect(panel).toBeVisible({ timeout: 15000 });
            await expectNoHorizontalOverflow(
                page,
                '[data-testid="session-participants-panel"]',
                "成员面板",
            );
            await expectNoHorizontalOverflow(
                page,
                '[data-testid="participants-list"]',
                "成员名单列表",
            );
            await membersTab.click();

            await page.screenshot({
                path: `H:/zeotmp/t56-bl318/bl341-${size.width}.png`,
                fullPage: false,
            });
        });
    });
}
