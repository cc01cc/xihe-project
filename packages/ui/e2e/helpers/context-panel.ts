import { expect, type Locator, type Page } from "@playwright/test";

/**
 * PLAN-0626 M2：会话设置（审批模式 / 上下文模板 / 上下文源 / 分支）不再在聊天列里就地展开，
 * 而是迁进右侧 dock 的 `context` 标签（`SessionContextPanel.vue`）。聊天列的摘要行降级为
 * **入口**：桌面点它发 `open-context-panel`，由 `WorkspaceView` 调 `workbenchRef.openDockTab("context")`。
 *
 * 这个帮助器把"打开面板"收敛成一步，返回时**面板已可见且目标标签被选中**，调用方不必再自己断言，
 * 也不再需要"点摘要行 + 等一会儿"这类固定等待。
 *
 * 三种形态都要能开（`deriveDockMode`，断点见 `DOCK_PINNED_MIN_VIEWPORT`）：
 * - `pinned`（viewport ≥ 1800）：dock 常驻最后一列，开标签只切换活动标签；
 * - `floating`（< 1800）：dock 浮在中列之上，**不是模态、没有遮罩**，`Esc`/点主列才关闭。
 *   本帮助器只做"点开 + 断言可见"，不会触发这两种关闭手势；调用方也不要在之后点面板外部。
 *   需要 `pinned` 的用例请**显式** `test.use({ viewport: { width: 1920, ... } })`，不要依赖机器默认。
 * - **rail / 收起**（`dockCollapsed`，`WorkspaceWorkbench` 的 `dockOpen` 为 false）：`WorkspaceDock`
 *   是 `v-if` 渲染的，收起时**连标签条都不在 DOM 里**（`dock-tab-*` 计数为 0），所以本帮助器落到
 *   聊天列摘要行这条规范入口（`openDockTab` 会同时展开 dock 并激活目标标签）。
 *
 * 幂等：面板已可见时**只做校验、不再点任何东西**。这点是硬要求 —— dock 上的
 * `workspace-toolbar-members` / `workspace-toolbar-agents` 是**toggle**（点第二次会把面板收起），
 * 所以本帮助器一律不用工具栏入口；标签芯片（`dock-tab-*`）只会"选中"，重复点无副作用。
 *
 * 移动端（< 768，无 dock）不走这里：`SessionSettingsPanel` 在 `isMobile` 时仍在聊天 sheet 内就地展开。
 */

/** `useWorkspaceLayout.ts` 的 `DOCK_INLINE_MIN_VIEWPORT`：≥ 该宽度 dock 才 inline（pinned）。 */
export const DOCK_PINNED_MIN_VIEWPORT = 1800;

/** dock 根节点（`WorkspaceDock.vue` 的 `<aside>`）；`data-dock-mode` 是 `pinned|floating|focus` 的投影。 */
export function dockRoot(page: Page): Locator {
    return page.getByTestId("workspace-aux-panel");
}

/**
 * 面板本体（`SessionContextPanel.vue`，四个分区与既有 testid 都在里面）。
 *
 * **必须只取可见的那个**：`session-context-panel` 这个 testid 在页面上可能出现
 * 两份（dock 内的面板 + 移动端 sheet 里就地展开的同一份组件），直接用
 * `getByTestId` 会触发 strict mode violation（"resolved to 2 elements"）。
 * 2026-11-03 真机 e2e 实测：`approval-policy` / `context-sources` 三例因此误报
 * "面板不可见"，实际是被隐藏副本卡住解析 —— 不是面板没打开。
 */
export function contextPanel(page: Page): Locator {
    return page.locator('[data-testid="session-context-panel"]').filter({ visible: true });
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

/** 失败诊断用的 dock 快照；只读，判据全部来自 DOM，不看 localStorage。 */
export interface DockState {
    /** dock 是否渲染（`dockCollapsed` 收起或未打开时为 false）。 */
    rendered: boolean;
    /** `data-dock-mode`：`pinned` / `floating` / `focus`。 */
    mode: string | null;
    /** 标签条上的标签 id（渲染顺序）。 */
    stripTabs: string[];
    /** `aria-selected="true"` 的标签 id；dock 已开却读不到选中态时为 null。 */
    activeTab: string | null;
    /** `session-context-panel` 的 DOM 副本数。 */
    panelCopies: number;
    /** 其中可见的份数（>1 说明移动端 sheet 与 dock 同时挂载）。 */
    visiblePanelCopies: number;
    /** 聊天列摘要行副本数；dock 收起时只有它能开面板。 */
    summaryCopies: number;
}

/** 读 dock 的 `data-dock-mode`（`pinned` / `floating` / `focus`）；未渲染或读失败时为 null。 */
async function readDockMode(page: Page): Promise<string | null> {
    const dock = dockRoot(page).first();
    if ((await dock.count().catch(() => 0)) === 0) return null;
    return await dock.getAttribute("data-dock-mode").catch(() => null);
}

/** 读一份 dock 快照；每一步都吞掉自身异常，**诊断本身不能把用例失败原因换成它自己的**。 */
export async function readDockState(page: Page): Promise<DockState> {
    const dock = dockRoot(page),
        rendered = (await dock.count().catch(() => 0)) > 0,
        // 只用 `role="tab"`：`dock-tab-close-*` 是兄弟按钮，标签条的 `[data-testid^="dock-tab-"]`
        // 子串选择器会把它们一并捞进来。
        chips = dock.locator('[role="tab"]'),
        chipCount = rendered ? await chips.count().catch(() => 0) : 0,
        stripTabs: string[] = [],
        // 面板本体按 DOM 副本数读：两份是"dock + 移动 sheet 同时挂载"这个已知形态。
        panels = page.locator('[data-testid="session-context-panel"]');

    let activeTab: string | null = null;
    for (let index = 0; index < chipCount; index += 1) {
        const chip = chips.nth(index),
            testId = await chip.getAttribute("data-testid").catch(() => null),
            id = testId?.replace("dock-tab-", "") ?? `#${index}`;
        stripTabs.push(id);
        if ((await chip.getAttribute("aria-selected").catch(() => null)) === "true") {
            activeTab = id;
        }
    }

    return {
        rendered,
        mode: rendered ? await readDockMode(page) : null,
        stripTabs,
        activeTab,
        panelCopies: await panels.count().catch(() => 0),
        visiblePanelCopies: await panels
            .filter({ visible: true })
            .count()
            .catch(() => 0),
        summaryCopies: await page
            .getByTestId("session-settings-summary")
            .count()
            .catch(() => 0),
    };
}

/** 把 `DockState` 拼成一行人读得懂的诊断串。 */
export function formatDockState(state: DockState): string {
    return [
        state.rendered
            ? `dock 已渲染（data-dock-mode=${state.mode ?? "?"}）`
            : "dock 未渲染（dockCollapsed 收起 / 未打开，标签条读不到）",
        `activeDockTab=${state.activeTab ?? "无（标签条上没有 aria-selected=true）"}`,
        `标签条=[${state.stripTabs.join(", ")}]`,
        `session-context-panel=${state.panelCopies} 份（可见 ${state.visiblePanelCopies}）`,
        `session-settings-summary=${state.summaryCopies} 份`,
    ].join("；");
}

/**
 * 打开右侧 dock 的目标标签（默认 `context`，即会话设置面板），返回时面板已可见。
 *
 * 失败时抛出的错误带一份 **当前 dock 快照**（渲染与否、`data-dock-mode`、活动标签、
 * 标签条内容、面板副本数）—— "面板没开"和"开在别的标签上"和"面板有两份导致 strict
 * mode" 是三种完全不同的故障，没有这份快照只能靠复跑猜。
 */
export async function openContextPanel(
    page: Page,
    options: OpenContextPanelOptions = {},
): Promise<void> {
    try {
        await openTargetDockTab(page, options);
    } catch (error) {
        const state = await readDockState(page);
        throw new Error(
            `openContextPanel("${options.tab ?? "context"}") 失败：${formatDockState(state)}`,
            { cause: error },
        );
    }
}

async function openTargetDockTab(page: Page, options: OpenContextPanelOptions): Promise<void> {
    const tab = options.tab ?? "context",
        timeout = options.timeout ?? 15000,
        panel = contextPanel(page),
        chip = dockTab(page, tab);

    // 已经是目标面板：只补一个选中态校验（防止"面板残留但标签已切走"）。
    if (await panel.isVisible().catch(() => false)) {
        await expectActiveChip(page, tab, timeout);
        return;
    }

    if (await chip.count()) {
        // dock 已打开（其它标签）→ 切成目标标签。芯片只"选中"、不 toggle，重复点安全。
        await chip.click();
    } else if (options.viaSummaryRow === false) {
        throw new Error(
            `dock 未打开且 viaSummaryRow=false：无法在不经摘要行的情况下打开 "${tab}" 标签`,
        );
    } else {
        // dock 未打开 / 已收起（rail）→ 走聊天列的规范入口：点摘要行（桌面发 open-context-panel）。
        const summary = page.getByTestId("session-settings-summary");
        await summary.waitFor({ state: "visible", timeout });
        await summary.click();
    }

    await expect(
        panel,
        `openContextPanel("${tab}")：面板不可见。桌面宽度 ≥${DOCK_PINNED_MIN_VIEWPORT} 为 pinned、` +
            `以下为 floating；移动端（无 dock）走 SessionSettingsPanel 的就地展开，不能调用本帮助器。`,
    ).toBeVisible({ timeout });
    await expectActiveChip(page, tab, timeout);
}

/**
 * 目标标签处于选中态。
 *
 * 芯片**不在标签条上**时不做断言：`WorkspaceDock` 的 `maxVisibleTabs` 默认 3，第 4 个起的标签
 * 只活在 overflow 菜单里（菜单展开才有 `dock-overflow-item-*`）。这种情况下"面板可见"已经等价于
 * "context 是活动标签"—— sticky 面板（`context`/`agents`）只挂载一次、用 `v-show="id === activeTab"`
 * 隐藏而非卸载，所以**可见的那份** `SessionContextPanel` 就只在 `activeTab === "context"` 时出现。
 * 为读一个选中态去展开 overflow 菜单会留下一个浮层，得不偿失。
 */
async function expectActiveChip(page: Page, tab: string, timeout: number): Promise<void> {
    const chip = dockTab(page, tab);
    if (await chip.count()) {
        await expect(chip).toHaveAttribute("aria-selected", "true", { timeout });
    }
}
