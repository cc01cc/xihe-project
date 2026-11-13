// task-442（F-14 / D-1276 C1）：浮动辅助面板不得压住主操作区（发送键）。
// 红线来自真栈实测（internal/A03-xihe/evidence/2026-11-14-instance-flow-audit/aux-obstruction.json
// + 图 105）：1600×1000 浮动面板覆盖发送键，elementFromPoint 返回面板 div，Playwright 19 次重试超时。
// 修后同口径复测：dock 底边 = composer 顶（793.16），命中测试落在发送键内（图 129）。
// 两个真 bug 的防回归（D-1289「代码改了≠行为变了」）：
//   ① 浮动态带 h-full ⇒ 绝对定位过约束，bottom 被丢弃；② useElementSize 量成 content-box ⇒ 少算内距。
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { setupMockParticipants, setupMockProviderBinding } from "./helpers/session-matrix";
import { installContextEventStream } from "./helpers/context-events";
import { ACTION_TIMEOUT_MS, LONG_TIMEOUT_MS } from "../timeouts";

const SESSION_ID = "test-session-442",
    RUN_ID = "run-442";

/** 与 bl229 同一套会话夹具：202 回已知 runId + 参与者 + provider 绑定 + 上下文事件流。 */
async function prepare(page: Page, expectComposer = true): Promise<void> {
    await setupMockAuth(page);
    await page.route("**/api/v1/chat", async (route) => {
        const body = route.request().postDataJSON() as { sessionId?: string } | null;
        await route.fulfill({
            status: 202,
            contentType: "application/json",
            body: JSON.stringify({
                origin: "user_submission",
                status: "accepted",
                sessionId: body?.sessionId ?? SESSION_ID,
                runId: RUN_ID,
                messageId: randomUUID(),
            }),
        });
    });
    await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "task-442 dock" }] });
    await setupMockParticipants(page, SESSION_ID);
    await setupMockProviderBinding(page, SESSION_ID);
    await installContextEventStream(page);
    await page.goto(`/workspace/workspace-1/chat/${SESSION_ID}`);
    // 移动端 composer 在 Sheet 里，路由落地时不挂载 ⇒ 由调用方先开 Sheet 再等
    if (expectComposer) {
        await expect(page.getByTestId("chat-input"), "composer mounts").toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
    }
}

async function openDock(page: Page): Promise<void> {
    const toggle = page.getByTestId("workspace-toolbar-code");
    if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
    await expect(page.getByTestId("workspace-aux-panel")).toBeVisible();
}

test.describe("task-442 浮动 dock 不压 composer", () => {
    test("1600×1000 浮动态：发送键命中测试通过且能真发送", async ({ page }) => {
        await page.setViewportSize({ width: 1600, height: 1000 });
        await prepare(page);
        await openDock(page);
        const aux = page.getByTestId("workspace-aux-panel");
        await expect(aux).toHaveAttribute("data-dock-mode", "floating");
        const send = page.getByTestId("chat-send-button");
        await expect(send).toBeVisible();
        // 轮询而非一次性取数：composer 高度由 ResizeObserver 异步发布，开面板瞬间可能还没量到。
        // 两条判据都钉算法不钉派生像素：① 发送键中心命中自身或后代 ② 面板底边 ≤ composer 顶。
        await expect
            .poll(async () =>
                send.evaluate((el) => {
                    const b = el.getBoundingClientRect();
                    const target = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
                    const dock = document.querySelector('[data-testid="workspace-aux-panel"]')!;
                    const composer = document.querySelector('[data-testid="chat-composer"]')!;
                    return {
                        hit: !!target && (target === el || el.contains(target)),
                        clear:
                            dock.getBoundingClientRect().bottom <=
                            composer.getBoundingClientRect().top + 1,
                    };
                }),
            )
            .toEqual({ hit: true, clear: true });
        await page.getByTestId("chat-input").fill("task-442 浮动态发送");
        await send.click({ timeout: ACTION_TIMEOUT_MS });
        await expect(page.getByText("task-442 浮动态发送"), "user bubble rendered").toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
    });

    test("1920×1080 pinned 对照：不写 inline bottom（flex 子项本来就不覆盖主列）", async ({
        page,
    }) => {
        await page.setViewportSize({ width: 1920, height: 1080 });
        await prepare(page);
        await openDock(page);
        const aux = page.getByTestId("workspace-aux-panel");
        await expect(aux).toHaveAttribute("data-dock-mode", "pinned");
        // 判 inline style 而非 computed：relative 元素未设 bottom 时 computed 是 used value 0px，不是 auto
        expect(await aux.evaluate((el) => (el as HTMLElement).style.bottom)).toBe("");
        await expect(page.getByTestId("chat-send-button")).toBeVisible();
    });

    test("390×844 移动端对照：composer 仍可发送", async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await prepare(page, false);
        // 移动端 composer 在 Sheet 里，先点浮动按钮打开（`MobileChatSheet.vue` 的 mobile-chat-open）
        const openChat = page.getByTestId("mobile-chat-open");
        await expect(openChat).toBeVisible({ timeout: LONG_TIMEOUT_MS });
        await openChat.click({ timeout: ACTION_TIMEOUT_MS });
        await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: LONG_TIMEOUT_MS });
        await page.getByTestId("chat-input").fill("task-442 移动端发送");
        await page.getByTestId("chat-send-button").click({ timeout: ACTION_TIMEOUT_MS });
        await expect(page.getByText("task-442 移动端发送"), "user bubble rendered").toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
    });
});
