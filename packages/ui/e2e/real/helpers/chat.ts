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

    // task-916：把「有没有种子会话」的判定放到**会话列表自身落定**之后，而不是对空态 CTA
    // 做一次 `isVisible()` 猜测。侧栏分组（`WorkspaceSessionGroups.ensureGroup`）与页面自动
    // 选中（`WorkspaceView.selectSessionForWorkspace`）读的是同一个
    // `sessionStore.loadSessions()`：分组 loading 结束后要么渲染 SessionList 行，要么渲染
    // `sidebar-empty-no-session`。这两个标记**只会在列表请求落定后出现**，因此它们是
    // 「会话列表 settle」的确定性信号；空态 CTA 则可能在初始渲染后、列表回填时被卸载。
    const currentGroupBody = page.locator('[data-testid^="sidebar-workspace-group-body-"]').first();
    const groupSessionItem = currentGroupBody.getByTestId("session-item").first();
    const groupEmpty = currentGroupBody.getByTestId("sidebar-empty-no-session").first();

    const pick = (locator: typeof textarea, tag: string) =>
        locator
            .waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS })
            .then(() => tag)
            .catch(() => null);
    // 空态 CTA 刻意不参与这一轮判定：它会在列表回填前先渲染，先命中就等于把 task-49 的
    // 竞态原样请回来；只有列表落定后仍无会话（`no-sessions`）才允许点它。
    const ready = await Promise.race([
        pick(textarea, "chat"),
        pick(chatFab, "fab"),
        pick(groupSessionItem, "sessions-loaded"),
        pick(groupEmpty, "no-sessions"),
    ]);
    // SSE 仍可能在判定与点击之间新建并选中会话：点击与「composer 出现」同时等待，
    // CTA 被卸载时**不重试、不吞错**，交给末尾的 textarea 等待（真有会话就命中，
    // 真失败则照常超时暴露）。两个分支都 resolve，避免竞态落败方变成 unhandled rejection。
    const clickCtaUnlessChatAppears = () =>
        Promise.race([
            emptyStateCta.click({ timeout: ACTION_TIMEOUT_MS }).then(
                () => "clicked" as const,
                () => "unavailable" as const,
            ),
            textarea.waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS }).then(
                () => "chat" as const,
                () => null,
            ),
        ]);

    if (ready === "chat") return;
    if (ready === "fab") {
        await chatFab.click();
    } else if (ready === "sessions-loaded") {
        // 列表已落定且至少一行：`selectSessionForWorkspace` 的选择只等 store 同一批数据，
        // 唯一前置是 composer 挂载；下面的 textarea 等待即真实断言。
    } else if (ready === "no-sessions") {
        await clickCtaUnlessChatAppears();
    } else {
        // 没有落定信号（移动端侧栏未挂载、或分组未展开）：在空态 CTA 与侧栏新建之间
        // 二选一，同样不做单次可见性猜测。
        const fallback = await Promise.race([
            pick(emptyStateCta, "cta"),
            pick(sidebarNew, "sidebar-new"),
        ]);
        if (fallback === "cta") {
            await clickCtaUnlessChatAppears();
        } else if (fallback === "sidebar-new") {
            await sidebarNew.click();
            // task-373 / `D-1236`：搜索行 icon 现在是两项菜单（工作区新建 / 独立会话新建），
            // 触发器 testid 不变 ⇒ 这里补一次菜单项点击，语义仍是「在此工作区新建会话」。
            await page.getByTestId("sidebar-new-chat-workspace").click();
        }
    }
    await textarea.waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
}

export async function gotoWorkspaceWithChat(page: Page): Promise<void> {
    await page.goto("/workspace", { waitUntil: "load" });
    await ensureWorkspaceChat(page);
}
