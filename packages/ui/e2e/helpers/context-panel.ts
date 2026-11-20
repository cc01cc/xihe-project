import { expect, type Locator, type Page } from "@playwright/test";

/**
 * 会话设置面板（`SessionContextPanel.vue`：审批模式 / 上下文模板 / 上下文源 / 分支）
 * 的「打开并校验」封装，返回时**面板已可见且（页签在标签条上时）目标标签选中**。
 *
 * ## task-6（`D1453` / N-6 选 A）之后的入口只剩一个页签
 * 静态 `context` 页签已退役（值域、渲染分支、标题键一并删除）。会话设置面板现在**只**经右栏
 * 容器内页签 `pane:right:session-config:<sid>` 打开 —— 面板体仍是同一份 `SessionContextPanel`，
 * 所以「面板可见」这条判据**认不出页签**，要判"开的是哪个页签"必须看芯片的 `aria-selected`。
 *
 * 本帮助器因此固定开 session-config 页签，走产品面上唯一稳定的入口：**中栏「+」组件选择器**
 * （触发器 `workspace-container-plus-main` → 项 `workspace-add-item-session-config`，见
 * `WorkspaceWorkbench.mainAddEntries` 与 `WorkspaceContainerAddButton`）。它经
 * `openDockTab` 开进右栏并激活目标标签。
 *
 * **为什么不点聊天列摘要行**（task-151 的教训）：32px 摘要行 `session-settings-summary` 确实也开
 * 同一个 session-config 页签，但它是**用户快捷键**，点它会顺带验证"摘要行可用"这件事 —— 只想验证面板
 * 内容的 spec 不该依赖它；而「+」选择器在 dock 收起（rail）时同样可用，是与 dock 形态无关的那条路。
 *
 * ## dock 形态
 * `floating` 已随 `D-1754 ④` 退场（task-94 S1 / task-162），右栏恒为正常列；
 * `DOCK_PINNED_MIN_VIEWPORT`（1800）只剩**首启默认**语义（≥1800 首启展开右栏、<1800 首启收起
 * 但页签与激活项就位）。当前形态只有两种：
 * - **开**：dock 常驻最后一列，开标签只切换活动标签；
 * - **收起 / rail**：`WorkspaceDock` 是 `v-if` 渲染的，收起时连标签条都不在 DOM 里
 *   （`dock-tab-*` 计数为 0）⇒ 落到中栏「+」，「+」与 dock 是否展开无关。
 *
 * ## 幂等
 * 面板已可见时**只做校验、不再点任何东西** —— 重复点芯片只"选中"、无副作用；本帮助器不自己造
 * 第二个入口。
 *
 * ## 移动端
 * < 768 无 dock，`SessionSettingsPanel` 在 chat sheet 内就地展开，不走这里。
 */

/** `useWorkspaceLayout.ts` 的 `DOCK_INLINE_MIN_VIEWPORT`：只管**首启默认**（≥1800 首启展开右栏），
 * 不再决定 dock 形态（floating 已退场；名里 inline 是历史残留，见 task-179）。 */
export const DOCK_PINNED_MIN_VIEWPORT = 1800;

/** 会话设置页签的 testid 前缀：完整 id 是 `pane:right:session-config:<sid>`（sid 由产品带上，
 * 帮助器不猜它，按前缀定位）。这段前缀同时是 `dockTab` 的 id 形态示例。 */
const SESSION_CONFIG_TAB_SELECTOR = '[data-testid^="dock-tab-pane:right:session-config:"]';

/** 中栏「+」里会话设置项的稳定 testid（task-129：**不拼 id**，否则每个会话一个选择器）。 */
const SESSION_CONFIG_MENU_ITEM = "workspace-add-item-session-config";

/** dock 根节点（`WorkspaceDock.vue` 的 `<aside>`）；`data-dock-mode` 是 `pinned|focus` 的投影。 */
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
 *
 * **它认不出页签 id**：会话设置页签与任何未来复用该组件的入口渲染同一份组件，
 * 要判"开的是哪个页签"必须看芯片的 `aria-selected`。
 */
export function contextPanel(page: Page): Locator {
    return page.locator('[data-testid="session-context-panel"]').filter({ visible: true });
}

/** dock 标签芯片，`tab` 是**完整页签 id**（`code`/`files` 这类静态 id，或 `pane:right:...` 三元组）。 */
export function dockTab(page: Page, tab: string): Locator {
    return page.getByTestId(`dock-tab-${tab}`);
}

/** 会话设置页签的芯片（id 带 `:<sid>`，按前缀取；页签在标签条上时应恰好 1 个）。 */
export function sessionConfigTab(page: Page): Locator {
    return page.locator(SESSION_CONFIG_TAB_SELECTOR);
}

export interface OpenContextPanelOptions {
    /**
     * 目标页签的完整 dock id；默认开会话设置页签（`pane:right:session-config:<sid>`）。
     * 只有想显式验证"别的面板也能经同一入口打开"时才传静态 id（`code`/`monitor`…）。
     */
    tab?: string;
    /** 可见性/选中态断言超时，默认 15000。 */
    timeout?: number;
    /**
     * 允许经中栏「+」的组件选择器打开，默认 true。置 false 时**只点 dock 标签芯片** —— 用于
     * "dock 已开着、要显式验证芯片路径"的用例；dock 收起时该形态无从下手，会直接报错。
     */
    viaAddMenu?: boolean;
}

/** 失败诊断用的 dock 快照；只读，判据全部来自 DOM，不看 localStorage。 */
export interface DockState {
    /** dock 是否渲染（`dockCollapsed` 收起或未打开时为 false）。 */
    rendered: boolean;
    /** `data-dock-mode`：`pinned` / `focus`。 */
    mode: string | null;
    /** 标签条上的标签 id（渲染顺序）。 */
    stripTabs: string[];
    /** `aria-selected="true"` 的标签 id；dock 已开却读不到选中态时为 null。 */
    activeTab: string | null;
    /** `session-context-panel` 的 DOM 副本数。 */
    panelCopies: number;
    /** 其中可见的份数（>1 说明移动端 sheet 与 dock 同时挂载）。 */
    visiblePanelCopies: number;
    /** 聊天列摘要行副本数；本帮助器**不用**它开面板，只作为诊断读数保留。 */
    summaryCopies: number;
}

/** 读 dock 的 `data-dock-mode`（`pinned` / `focus`）；未渲染或读失败时为 null。 */
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
 * 打开右侧 dock 的会话设置页签（默认目标），返回时面板已可见**且目标页签选中**。
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
            `openContextPanel("${targetLabel(options)}") 失败：${formatDockState(state)}`,
            { cause: error },
        );
    }
}

/** 诊断/错误消息里用的目标名：会话设置页签按语义叫 `session-config`，其余直接回显 id。 */
function targetLabel(options: OpenContextPanelOptions): string {
    return options.tab ?? "session-config";
}

async function openTargetDockTab(page: Page, options: OpenContextPanelOptions): Promise<void> {
    const label = targetLabel(options),
        timeout = options.timeout ?? 15000,
        panel = contextPanel(page),
        // 会话设置页签的 id 带 `:sid`（帮助器不知道 sid）⇒ 按前缀取；静态 id 直接拼 testid。
        chip = options.tab === undefined ? sessionConfigTab(page) : dockTab(page, options.tab);

    // 已经是目标面板：只补一个选中态校验（防止"面板残留但标签已切走"）。
    if (await panel.isVisible().catch(() => false)) {
        await expectActiveChip(chip, label, timeout);
        return;
    }

    if (await chip.count()) {
        // 目标页签已存在（dock 开着但在别的标签上）→ 切成目标标签；芯片只"选中"、不 toggle。
        await chip.first().click();
    } else if (options.viaAddMenu === false) {
        throw new Error(
            `dock 未打开且 viaAddMenu=false：无法在不经中栏「+」组件选择器的情况下打开 "${label}" 标签`,
        );
    } else {
        // dock 未打开 / 已收起（rail）→ 中栏「+」是产品面上唯一稳定的面板入口。
        await openViaAddMenu(page, options.tab, label, timeout);
    }

    await expect(
        panel,
        `openContextPanel("${label}")：面板不可见。桌面宽度 ≥${DOCK_PINNED_MIN_VIEWPORT} 首启展开右栏，` +
            `更窄的首启收起、右栏靠中栏「+」展开；移动端（无 dock）走 SessionSettingsPanel 的就地展开，` +
            `不能调用本帮助器。`,
    ).toBeVisible({ timeout });
    await expectActiveChip(chip, label, timeout);
}

/**
 * 经中栏「+」的组件选择器开页签。
 *
 * 为什么是这条：中栏「+」自 task-140 起就是**组件选择器**（`WorkspaceContainerAddButton`），
 * 选中项一律经 `openDockTab` 进右栏 dock 并激活对应页签 —— 这是产品上"把某个面板开出来"的
 * 正规路径，且在 dock 收起（rail）时同样可用。
 *
 * 菜单项是 reka 的 `DropdownMenuCheckboxItem`（`role=menuitemcheckbox`，只受控不开
 * `update:model-value`）：点完由浮层自身关闭，这里显式等它消失再返回 —— 残留浮层会盖住调用方
 * 接下来的点击，表现为"面板开了但下一个断言超时"，比"没开"更难查。
 */
async function openViaAddMenu(
    page: Page,
    tab: string | undefined,
    label: string,
    timeout: number,
): Promise<void> {
    await page.getByTestId("workspace-container-plus-main").click({ timeout });
    const item = page.getByTestId(
        tab === undefined ? SESSION_CONFIG_MENU_ITEM : `workspace-add-item-${tab}`,
    );
    await item.waitFor({ state: "visible", timeout });
    await item.click({ timeout });
    await expect(item, `中栏「+」选中 "${label}" 后浮层应关闭`).toBeHidden({ timeout });
}

/**
 * 目标标签处于选中态（芯片在标签条上时才断言）。
 *
 * 芯片**不在标签条上**时不做断言：`WorkspaceDock` 的 `maxVisibleTabs` 默认 3，第 4 个起的标签
 * 只活在 overflow 菜单里。此时"面板可见"已经等价于"目标是活动标签"—— 会话设置页签是
 * `pane:*` 页签，**不是 sticky**（`stickyTabIds` 只有 `agents`）：切走即卸载，所以可见的那份
 * `SessionContextPanel` 只会在它就是活动标签时出现。为读一个选中态去展开 overflow 菜单会留下
 * 一个浮层，得不偿失。
 */
async function expectActiveChip(chip: Locator, label: string, timeout: number): Promise<void> {
    if (await chip.count()) {
        // 一栏里同一页签 id 只该有一份；用 first() 只是防止 id 带 sid 的极端重复把断言卡在 strict mode。
        await expect(chip.first(), `目标页签 "${label}" 应为活动标签`).toHaveAttribute(
            "aria-selected",
            "true",
            { timeout },
        );
    }
}
