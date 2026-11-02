import { expect, type Locator, type Page } from "@playwright/test";

/**
 * PLAN-0626 M2：会话设置（审批模式 / 上下文模板 / 上下文源 / 分支）不再在聊天列里就地展开，
 * 而是迁进右侧 dock 的 `context` 标签（`SessionContextPanel.vue`）。聊天列的摘要行降级为
 * **入口**：桌面点它发 `open-context-panel`，由 `WorkspaceView` 调 `workbenchRef.openDockTab("context")`。
 *
 * 这个帮助器把"打开面板"收敛成一步，返回时**面板已可见且目标标签被选中**，调用方不必再自己断言，
 * 也不再需要"点摘要行 + 等一会儿"这类固定等待。
 *
 * 两种 `dockMode` 都要能开（`deriveDockMode`，断点见 `DOCK_PINNED_MIN_VIEWPORT`）：
 * - `pinned`（viewport ≥ 1800）：dock 常驻最后一列，开标签只切换活动标签；
 * - `floating`（< 1800）：dock 浮在中列之上，**不是模态、没有遮罩**，`Esc`/点主列才关闭。
 *   本帮助器只做"点开 + 断言可见"，不会触发这两种关闭手势；调用方也不要在之后点面板外部。
 * 需要 `pinned` 的用例请**显式** `test.use({ viewport: { width: 1920, ... } })`，不要依赖机器默认。
 *
 * 移动端（< 768，无 dock）不走这里：`SessionSettingsPanel` 在 `isMobile` 时仍在聊天 sheet 内就地展开。
 */

/** `useWorkspaceLayout.ts` 的 `DOCK_INLINE_MIN_VIEWPORT`：≥ 该宽度 dock 才 inline（pinned）。 */
export const DOCK_PINNED_MIN_VIEWPORT = 1800;

/** 面板本体（`SessionContextPanel.vue`，四个分区与既有 testid 都在里面）。 */
export function contextPanel(page: Page): Locator {
    return page.getByTestId("session-context-panel");
}

/** dock 标签芯片（`WorkspaceDock.vue` 的 `dock-tab-${tab.id}` 通用规则）。 */
export function dockTab(page: Page, tab = "context"): Locator {
    return page.getByTestId(`dock-tab-${tab}`);
}

export interface OpenContextPanelOptions {
    /** dock 标签 id，默认 `context`（其余可取 `code`/`changes`/`monitor`/`members`）。 */
    tab?: string;
    /** 可见性/选中态断言超时，默认 15000。 */
    timeout?: number;
    /**
     * 允许经聊天列摘要行（`session-settings-summary`）打开面板，默认 true。
     * 置 false 时只点 dock 标签芯片 —— 用于"dock 已开但要显式验证芯片路径"的用例。
     */
    viaSummaryRow?: boolean;
}

/**
 * 打开右侧 dock 的目标标签（默认 `context`，即会话设置面板），返回时面板已可见。
 *
 * 幂等：面板已可见时只校验目标标签处于选中态。
 */
export async function openContextPanel(
    page: Page,
    options: OpenContextPanelOptions = {},
): Promise<void> {
    const tab = options.tab ?? "context",
        timeout = options.timeout ?? 15000,
        panel = contextPanel(page),
        chip = dockTab(page, tab);

    // 已经是目标面板：只补一个选中态校验（防止"面板残留但标签已切走"）。
    if (await panel.isVisible().catch(() => false)) {
        await expect(chip).toHaveAttribute("aria-selected", "true", { timeout });
        return;
    }

    if (await chip.count()) {
        // dock 已打开（其它标签）→ 切成目标标签。
        await chip.click();
    } else if (options.viaSummaryRow === false) {
        throw new Error(
            `dock 未打开且 viaSummaryRow=false：无法在不经摘要行的情况下打开 "${tab}" 标签`,
        );
    } else {
        // dock 未打开 → 走聊天列的规范入口：点摘要行（桌面发 open-context-panel）。
        const summary = page.getByTestId("session-settings-summary");
        await summary.waitFor({ state: "visible", timeout });
        await summary.click();
    }

    await expect(
        panel,
        `openContextPanel("${tab}")：面板不可见。桌面宽度 ≥${DOCK_PINNED_MIN_VIEWPORT} 为 pinned、` +
            `以下为 floating；移动端（无 dock）走 SessionSettingsPanel 的就地展开，不能调用本帮助器。`,
    ).toBeVisible({ timeout });
    await expect(chip).toHaveAttribute("aria-selected", "true", { timeout });
}
