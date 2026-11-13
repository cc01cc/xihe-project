import { type Page } from "@playwright/test";
import { ACTION_TIMEOUT_MS } from "../../timeouts";

/**
 * Workspace-first landing never auto-creates a Session (PLAN-0328 M3 T3.7).
 * Tests that need a live composer must create one through the visible affordance:
 * - desktop: the no-session empty-state CTA, or the sidebar button
 * - mobile (conversation column unmounted): the MobileChatSheet FAB, which only
 *   exists once a Session is selected — seed one via the API in beforeAll
 *
 * All waits are event-driven; race losers resolve (not reject) to avoid
 * unhandled rejections after the race settles.
 */
export async function ensureWorkspaceChat(page: Page): Promise<void> {
    const textarea = page.locator("textarea"),
        emptyStateCta = page.getByTestId("workspace-create-session");
    const chatFab = page.getByTestId("mobile-chat-open"),
        sidebarNew = page.getByTestId("sidebar-new-chat");

    const pick = (locator: typeof textarea, tag: string) =>
        locator
            .waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS })
            .then(() => tag)
            .catch(() => null);
    const ready = await Promise.race([
        pick(textarea, "chat"),
        pick(emptyStateCta, "cta"),
        pick(chatFab, "fab"),
    ]);

    if (ready === "chat") return;
    if (ready === "cta") {
        await emptyStateCta.click();
    } else if (ready === "fab") {
        await chatFab.click();
    } else {
        await sidebarNew.waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
        await sidebarNew.click();
        // task-373 / `D-1236`：搜索行 icon 现在是两项菜单（工作区新建 / 独立会话新建），
        // 触发器 testid 不变 ⇒ 这里补一次菜单项点击，语义仍是「在此工作区新建会话」。
        await page.getByTestId("sidebar-new-chat-workspace").click();
    }
    await textarea.waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
}

export async function gotoWorkspaceWithChat(page: Page): Promise<void> {
    await page.goto("/workspace", { waitUntil: "load" });
    await ensureWorkspaceChat(page);
}
