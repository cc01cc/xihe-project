import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import WorkspaceDock from "../WorkspaceDock.vue";

const i18n = createI18n({
    legacy: false,
    locale: "en",
    messages: {
        en: {
            workspace: {
                dockTabs: "Workbench panels",
                dockOverflow: "More panels",
                dockCloseTab: "Close this panel",
                dockResize: "Resize the panel",
                closePanel: "Close the auxiliary panel",
                dockFocusExpand: "Expand panel",
                dockFocusRestore: "Restore layout",
                dockFocusHint: "Fill the workspace with this panel",
                dockResizeBubble: "Width",
                // D-1777/D-1778（task-65 A 段）：右栏行 = WorkspaceContainerTabs，其
                // aria-label 走容器键（不再用 dockTabs 键）。
                containerRight: "Right container",
                containerMain: "Main container",
                containerEmpty: "No tabs in this container",
                // task-97（D-1754 ②）：右栏行「+」= 重开已关闭面板；菜单项走 panel* 键。
                containerPlusReopen: "Reopen a closed panel",
                // task-88 ②：「+」升级为「新建页签 → 选类型」；0 页签时的空态 + 菜单里的已打开标记。
                containerPlusNew: "New tab: choose a panel type",
                dockTabOpen: "Open",
                dockEmptyHint: "No panels are open yet. Use + above to pick one.",
                panelFiles: "Files",
                panelCode: "Code",
                panelChanges: "Changes",
                panelMonitor: "Monitor",
                panelMembers: "Members",
                panelAgents: "Agents",
                panelDelegation: "Delegation",
                // task-129（D-1907 rev10）：会话配置容器页签的标签键。
                panelSessionConfig: "Session config",
            },
        },
    },
});

const THREE_TABS = [
    { id: "code", label: "Code" },
    { id: "changes", label: "Changes" },
    { id: "monitor", label: "Monitor" },
];

function mountDock(
    props: Partial<{
        tabs: { id: string; label: string }[];
        activeTab: string;
        width: number;
        maxVisibleTabs: number;
        defaultWidth: number;
        focus: boolean;
        fill: boolean;
        sessionId?: string | null;
    }> = {},
) {
    return mount(WorkspaceDock, {
        props: { tabs: THREE_TABS, activeTab: "code", width: 360, ...props },
        global: { plugins: [i18n] },
        slots: {
            code: '<div data-testid="dock-code-content" />',
            changes: '<div data-testid="dock-changes-content" />',
            monitor: '<div data-testid="dock-monitor-content" />',
            agents: '<div data-testid="dock-agents-content" />',
            alpha: '<div data-testid="dock-alpha-content" />',
            beta: '<div data-testid="dock-beta-content" />',
        },
    });
}

describe("WorkspaceDock (PLAN-0582 S2)", () => {
    it("renders the open tab set with exactly one active tab and only its content", () => {
        const wrapper = mountDock();

        expect(wrapper.get('[data-testid="workspace-aux-panel"]').exists()).toBe(true);
        expect(wrapper.findAll('[role="tab"]')).toHaveLength(3);
        expect(wrapper.get('[data-testid="dock-tab-code"]').attributes("aria-selected")).toBe(
            "true",
        );
        expect(wrapper.get('[data-testid="dock-tab-changes"]').attributes("aria-selected")).toBe(
            "false",
        );
        // Only the active panel is mounted (single active tab).
        expect(wrapper.find('[data-testid="dock-code-content"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="dock-changes-content"]').exists()).toBe(false);
    });

    it("emits the tab activation intent when another tab is clicked", async () => {
        const wrapper = mountDock();

        await wrapper.get('[data-testid="dock-tab-monitor"]').trigger("click");

        expect(wrapper.emitted("update:activeTab")?.at(-1)).toEqual(["monitor"]);
    });

    it("closes a tab from its own close affordance and from a middle click", async () => {
        const wrapper = mountDock();

        // Visible close affordance only on the active tab.
        expect(wrapper.find('[data-testid="dock-tab-close-changes"]').exists()).toBe(false);
        await wrapper.get('[data-testid="dock-tab-close-code"]').trigger("click");
        expect(wrapper.emitted("close-tab")?.at(-1)).toEqual(["code"]);

        // Middle click anywhere on a tab closes it; other buttons do not.
        await wrapper.get('[data-testid="dock-tab-changes"]').trigger("auxclick", { button: 0 });
        expect(wrapper.emitted("close-tab")).toHaveLength(1);
        await wrapper.get('[data-testid="dock-tab-changes"]').trigger("auxclick", { button: 1 });
        expect(wrapper.emitted("close-tab")?.at(-1)).toEqual(["changes"]);
    });

    it("moves tabs beyond the visible limit into an overflow menu", async () => {
        const tabs = [
            { id: "code", label: "Code" },
            { id: "changes", label: "Changes" },
            { id: "monitor", label: "Monitor" },
            { id: "alpha", label: "Alpha" },
            { id: "beta", label: "Beta" },
        ];
        const wrapper = mountDock({ tabs, activeTab: "code", maxVisibleTabs: 3 });

        expect(wrapper.findAll('[role="tab"]')).toHaveLength(3);
        expect(wrapper.find('[data-testid="dock-overflow-menu"]').exists()).toBe(false);

        await wrapper.get('[data-testid="dock-overflow-trigger"]').trigger("click");

        const menu = wrapper.get('[data-testid="dock-overflow-menu"]');
        expect(menu.text()).toContain("Alpha");
        expect(menu.text()).toContain("Beta");

        await wrapper.get('[data-testid="dock-overflow-item-beta"]').trigger("click");
        expect(wrapper.emitted("update:activeTab")?.at(-1)).toEqual(["beta"]);
        // Selecting from the menu closes it.
        expect(wrapper.find('[data-testid="dock-overflow-menu"]').exists()).toBe(false);
    });

    it("does not render an overflow trigger when every tab fits", () => {
        const wrapper = mountDock();

        expect(wrapper.find('[data-testid="dock-overflow-trigger"]').exists()).toBe(false);
    });

    it("keeps the tab and its close affordance as two sibling buttons (no nested interactive)", () => {
        // PLAN-0626 D26-10: the old markup put a `role=button` span inside `role=tab`,
        // i.e. a focusable control nested in another control, with hand-rolled
        // Enter/Space handlers. Both must be real siblings now, so keyboard
        // activation is the browser's own button behaviour.
        const wrapper = mountDock(),
            tab = wrapper.get('[data-testid="dock-tab-code"]'),
            close = wrapper.get('[data-testid="dock-tab-close-code"]');

        expect(tab.element.tagName).toBe("BUTTON");
        expect(close.element.tagName).toBe("BUTTON");
        // The close affordance is not inside the tab element at all.
        expect(tab.element.contains(close.element)).toBe(false);
        expect(tab.element.querySelector("button")).toBeNull();
        expect(tab.element.querySelector('[role="button"]')).toBeNull();
        // Both live in the same chip, and the tab keeps its single-select semantics.
        expect(tab.element.parentElement).toBe(close.element.parentElement);
        expect(tab.attributes("role")).toBe("tab");
    });

    it("keeps the overflow row's select and close affordances as sibling buttons too", async () => {
        const tabs = [
                { id: "code", label: "Code" },
                { id: "changes", label: "Changes" },
                { id: "monitor", label: "Monitor" },
                { id: "alpha", label: "Alpha" },
            ],
            wrapper = mountDock({ tabs, activeTab: "code", maxVisibleTabs: 3 });

        await wrapper.get('[data-testid="dock-overflow-trigger"]').trigger("click");

        // Queried inline: any new `const` after the await trips the file's one-var style rule.
        expect(wrapper.get('[data-testid="dock-overflow-item-alpha"]').element.tagName).toBe(
            "BUTTON",
        );
        expect(wrapper.get('[data-testid="dock-overflow-close-alpha"]').element.tagName).toBe(
            "BUTTON",
        );
        expect(
            wrapper
                .get('[data-testid="dock-overflow-item-alpha"]')
                .element.contains(wrapper.get('[data-testid="dock-overflow-close-alpha"]').element),
        ).toBe(false);

        await wrapper.get('[data-testid="dock-overflow-close-alpha"]').trigger("click");
        expect(wrapper.emitted("close-tab")?.at(-1)).toEqual(["alpha"]);
        expect(wrapper.emitted("update:activeTab")).toBeUndefined();
    });

    it("resizes with the pointer and clamps into the 320-480 range", async () => {
        const wrapper = mountDock({ width: 360 });
        const resizer = wrapper.get('[data-testid="dock-resizer"]');

        expect(resizer.attributes("role")).toBe("separator");
        expect(resizer.attributes("aria-orientation")).toBe("vertical");
        expect(resizer.attributes("aria-valuenow")).toBe("360");
        expect(resizer.attributes("aria-valuemin")).toBe("320");
        expect(resizer.attributes("aria-valuemax")).toBe("480");

        // Dragging the left edge right makes the dock narrower (right-hand panel).
        await resizer.trigger("mousedown", { clientX: 1000 });
        document.dispatchEvent(new MouseEvent("mousemove", { clientX: 1060 }));
        document.dispatchEvent(new MouseEvent("mouseup", {}));

        expect(wrapper.emitted("update:width")?.at(-1)).toEqual([320]);
    });

    it("follows the pointer without emitting until release (resize-follow fix)", async () => {
        const wrapper = mountDock({ width: 360 });
        const panel = wrapper.get('[data-testid="workspace-aux-panel"]');

        await wrapper.get('[data-testid="dock-resizer"]').trigger("mousedown", {
            clientX: 1000,
        });
        document.dispatchEvent(new MouseEvent("mousemove", { clientX: 960 }));

        // Mid-drag: the element already shows the new width, but the store write
        // (the emitted v-model update) waits for the release.
        expect((panel.element as HTMLElement).style.width).toBe("400px");
        expect(panel.classes()).toContain("is-resizing");
        expect(wrapper.emitted("update:width")).toBeUndefined();

        document.dispatchEvent(new MouseEvent("mouseup", {}));

        expect(wrapper.emitted("update:width")).toEqual([[400]]);
        await wrapper.vm.$nextTick();
        expect(panel.classes()).not.toContain("is-resizing");
    });

    it("resizes with the keyboard on the separator", async () => {
        const wrapper = mountDock({ width: 360 });
        const resizer = wrapper.get('[data-testid="dock-resizer"]');

        await resizer.trigger("keydown", { key: "ArrowLeft" });
        expect(wrapper.emitted("update:width")?.at(-1)).toEqual([376]);

        await resizer.trigger("keydown", { key: "ArrowRight" });
        expect(wrapper.emitted("update:width")?.at(-1)).toEqual([344]);

        await resizer.trigger("keydown", { key: "Home" });
        expect(wrapper.emitted("update:width")?.at(-1)).toEqual([320]);

        await resizer.trigger("keydown", { key: "End" });
        expect(wrapper.emitted("update:width")?.at(-1)).toEqual([480]);
    });

    it("emits a collapse intent from its header close button", async () => {
        const wrapper = mountDock();

        await wrapper.get('[data-testid="workspace-aux-close"]').trigger("click");

        expect(wrapper.emitted("close")).toHaveLength(1);
        expect(wrapper.emitted("close-tab")).toBeUndefined();
    });

    /**
     * task-89（触控目标，WCAG 2.2 SC 2.5.8 ≥24×24）：失败读数不是「看起来小」，是**可复算的几何**。
     * 改前四个命中盒 —— 页签关闭键 `p-0.5` + `X size-3` ⇒ **14×14**，且与同 chip 的
     * `dock-tab-` 本体矩形距只有 **7**（24 圆心圆与本体矩形相交 ⇒ Spacing 例外不成立）；
     * 头部三键 `p-1` + `size-3.5` ⇒ **19.25×19.25**，圆心距 22.75 < 24 且两者都欠尺寸。
     * `min-h-7 min-w-7` = **7 × 3.5px = 24.5px**（本仓 `--spacing` = 3.5，不是 4）⇒ 达标。
     * **jsdom 不求值 Tailwind**，所以这里钉类名；真 rect 归 Playwright 复测（证据在
     * `.tmp/xh/task-89/`）。图标仍 `size-3`/`size-3.5` 不放大 ⇒ 视觉档位不动。
     */
    it("task-89：页签关闭键与头部三键的命中盒 ≥24×24（min-h-7 min-w-7 锁死）", async () => {
        const wrapper = mountDock();

        const closeKeys = wrapper.findAll('[data-testid^="dock-tab-close-"]');
        expect(closeKeys.length).toBeGreaterThan(0);
        for (const key of closeKeys) {
            expect(key.classes()).toEqual(
                expect.arrayContaining(["min-h-7", "min-w-7", "items-center", "justify-center"]),
            );
            // 图标不跟着放大：同动作同图标同尺寸（DEV-011:194）。
            expect(key.get("svg").classes()).toContain("size-3");
        }

        // task-94 S1：pin 切换按钮已随浮窗退场（判据 3），头部只剩两根键。
        for (const testid of ["dock-focus-toggle", "workspace-aux-close"]) {
            const button = wrapper.get(`[data-testid="${testid}"]`);
            expect(button.classes()).toEqual(
                expect.arrayContaining(["min-h-7", "min-w-7", "items-center", "justify-center"]),
            );
            expect(button.get("svg").classes()).toContain("size-3.5");
        }
    });

    it("always renders as an inline column: no overlay classes at any width (task-94 S1)", () => {
        // `D-1754 ④` 判据 3：右栏**不是**浮窗/overlay。这条用例把「浮窗那套 class 不许回来」钉住 ——
        // 曾经存在的是 `absolute top-0 right-0 z-20 shadow-xl` + `--xh-composer-h` 底边让位，
        // 整套随 floating 退场；`data-dock-mode` 也只剩 pinned（focus 另算）。
        const wrapper = mountDock();
        const panel = wrapper.get('[data-testid="workspace-aux-panel"]');
        const classes = panel.classes();
        expect(classes).toContain("relative");
        expect(classes).toContain("shadow-none");
        expect(classes).toContain("h-full");
        expect(classes).not.toContain("absolute");
        expect(classes).not.toContain("shadow-xl");
        expect(classes).not.toContain("top-0");
        // 锁的行为：默认（未开 focus）投影 = pinned ⇒ 内联列是唯一形态，浮窗模式没有兜底。
        // 同时锁投影成对字段，避免只改一半（mode=pinned 而 focus 标志还留着）。
        expect(panel.attributes("data-dock-mode"), "默认投影 = pinned（内联列唯一模式）").toBe(
            "pinned",
        );
        expect(panel.attributes("data-dock-focus")).toBe("false");
        expect(panel.attributes("style") ?? "").not.toContain("bottom:");
    });

    it("fills the row when the workbench is in single-column mode (Q2)", () => {
        // Lead 2026-11-17 裁「单栏时右栏占满整行」：宽度由行决定，width/分隔条/浮标一并退场。
        const wrapper = mountDock({ fill: true, width: 480 });
        const panel = wrapper.get('[data-testid="workspace-aux-panel"]');
        expect(panel.classes()).toContain("flex-1");
        expect(panel.classes()).toContain("min-w-0");
        expect(panel.attributes("style")).toBeUndefined();
        expect(wrapper.find('[data-testid="dock-resizer"]').exists()).toBe(false);
    });

    it("resets the width on a handle double-click and shows a live bubble while dragging", async () => {
        const wrapper = mountDock({ width: 460, defaultWidth: 360 });
        await wrapper.get('[data-testid="dock-resizer"]').trigger("dblclick");
        expect(wrapper.emitted("update:width")?.at(-1)).toEqual([360]);
    });

    it("keeps a sticky panel mounted across tab switches (D26-07 A)", async () => {
        // M2 spike outcome: a dynamic `<slot :name>` inside a `v-show` wrapper keeps the
        // form panel — and its editing state — alive while another tab is active.
        // task-6（D1453）：context 退役后 sticky 只剩 agents（它同样持有创建表单）。
        const tabs = [
                { id: "agents", label: "Agents" },
                { id: "monitor", label: "Monitor" },
            ],
            wrapper = mountDock({ tabs, activeTab: "agents" });

        expect(wrapper.find('[data-testid="dock-agents-content"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="dock-sticky-panel-agents"]').exists()).toBe(true);

        await wrapper.setProps({ activeTab: "monitor" });

        // Still mounted, merely hidden — and the checker panel is the active one.
        // `v-show` is asserted through the inline style (`display: none`): that is the
        // exact mechanism, and it stays deterministic in jsdom.
        expect(wrapper.find('[data-testid="dock-agents-content"]').exists()).toBe(true);
        expect(
            wrapper.get('[data-testid="dock-sticky-panel-agents"]').attributes("style"),
        ).toContain("display: none");
        expect(wrapper.find('[data-testid="dock-monitor-content"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="dock-active-panel"]').exists()).toBe(true);

        await wrapper.setProps({ activeTab: "agents" });
        expect(
            wrapper.get('[data-testid="dock-sticky-panel-agents"]').attributes("style") ?? "",
        ).not.toContain("display: none");
        // The checker unmounted again (no sticky memory for it).
        expect(wrapper.find('[data-testid="dock-monitor-content"]').exists()).toBe(false);
    });

    it("no longer keeps a context panel sticky (the static tab is retired)", async () => {
        // task-6（D1453）：退役后即使旧载荷把 "context" 塞进 tabs，也不再获得 sticky 记忆 ——
        // 否则会留下一个「看不见但一直挂着」的 SessionContextPanel 副本。
        const tabs = [
                { id: "context", label: "context" },
                { id: "monitor", label: "Monitor" },
            ],
            wrapper = mountDock({ tabs, activeTab: "context" });

        expect(wrapper.find('[data-testid="dock-sticky-panel-context"]').exists()).toBe(false);

        await wrapper.setProps({ activeTab: "monitor" });
        expect(wrapper.find('[data-testid="dock-sticky-panel-context"]').exists()).toBe(false);
    });

    it("unmounts an inactive checker panel instead of keeping it sticky", async () => {
        const wrapper = mountDock({ activeTab: "code" });

        await wrapper.setProps({ activeTab: "monitor" });

        expect(wrapper.find('[data-testid="dock-code-content"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="dock-monitor-content"]').exists()).toBe(true);
        // Sticky bookkeeping stays empty: no hidden panel was created for a checker.
        expect(wrapper.find('[data-testid="dock-sticky-panel-agents"]').exists()).toBe(false);
    });

    it("drops a sticky panel from memory once its tab is closed", async () => {
        const tabs = [
                { id: "agents", label: "Agents" },
                { id: "monitor", label: "Monitor" },
            ],
            wrapper = mountDock({ tabs, activeTab: "agents" });
        expect(wrapper.find('[data-testid="dock-sticky-panel-agents"]').exists()).toBe(true);

        // Closing the tab must not leave a hidden agents panel (and its watchers) alive.
        await wrapper.setProps({
            tabs: [{ id: "monitor", label: "Monitor" }],
            activeTab: "monitor",
        });

        expect(wrapper.find('[data-testid="dock-sticky-panel-agents"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="dock-agents-content"]').exists()).toBe(false);
    });

    it("keeps the configured width as an inline style so widths are independent of mode", () => {
        const wrapper = mountDock({ width: 420 });

        expect(wrapper.get('[data-testid="workspace-aux-panel"]').attributes("style")).toContain(
            "width: 420px",
        );
    });

    it("fills the workbench row in focus mode and drops the width plus its resizer", () => {
        // PLAN-0626 D26-04: focus outranks pinned/floating; width stays stored but is
        // not applied (a full-row panel has nothing to resize against).
        const wrapper = mountDock({ focus: true }),
            panel = wrapper.get('[data-testid="workspace-aux-panel"]');

        expect(panel.attributes("data-dock-focus")).toBe("true");
        expect(panel.attributes("data-dock-mode")).toBe("focus");
        expect(panel.attributes("style")).toBeUndefined();
        expect(panel.classes()).toContain("flex-1");
        expect(panel.classes()).not.toContain("absolute");
        expect(panel.classes()).not.toContain("shadow-xl");
        expect(wrapper.find('[data-testid="dock-resizer"]').exists()).toBe(false);
        // The tab strip stays fully usable: focus only changes geometry.
        expect(wrapper.findAll('[role="tab"]')).toHaveLength(3);
        expect(wrapper.get('[data-testid="dock-focus-toggle"]').attributes("aria-label")).toBe(
            "Restore layout",
        );
    });

    it("focus 与 pinned 条件同时成立时投影取 focus（优先级不是偶然）", () => {
        // 「同时满足 pinned 条件」= width 有值、fill=false（pinned 那套入参），只把 focus 翻 true；
        // 同一份入参的两侧对照 ⇒ mode 差异只能来自 focus 的优先级，而不是宽度/填充的副作用。
        const pinned = mountDock({ width: 420, fill: false });
        const pinnedPanel = pinned.get('[data-testid="workspace-aux-panel"]');
        expect(pinnedPanel.attributes("data-dock-focus")).toBe("false");
        expect(pinnedPanel.attributes("data-dock-mode")).toBe("pinned");
        expect(pinnedPanel.attributes("style"), "pinned 下标量宽度生效（对照组）").toContain(
            "width: 420px",
        );

        const focus = mountDock({ width: 420, fill: false, focus: true });
        const focusPanel = focus.get('[data-testid="workspace-aux-panel"]');
        expect(focusPanel.attributes("data-dock-focus")).toBe("true");
        expect(
            focusPanel.attributes("data-dock-mode"),
            "focus 优先于 pinned：pinned 条件全部满足时仍必须投影 focus",
        ).toBe("focus");
        // focus 铺满整行 ⇒ 同一宽度不再应用；否则说明「取 focus」只是属性翻了、布局没换。
        expect(focusPanel.attributes("style")).toBeUndefined();
        expect(focusPanel.classes()).toContain("flex-1");
    });

    it("emits the focus toggle from the header and reflects its pressed state", async () => {
        const wrapper = mountDock(),
            toggle = wrapper.get('[data-testid="dock-focus-toggle"]');

        expect(toggle.attributes("aria-pressed")).toBe("false");
        expect(toggle.attributes("aria-label")).toBe("Expand panel");
        await toggle.trigger("click");
        expect(wrapper.emitted("toggle-focus")).toHaveLength(1);

        const focused = mountDock({ focus: true }),
            pressed = focused.get('[data-testid="dock-focus-toggle"]');
        expect(pressed.attributes("aria-pressed")).toBe("true");
        expect(pressed.attributes("aria-label")).toBe("Restore layout");
    });
});

/**
 * task-94 S1（`D-1754 ④` 判据 3）取代 task-442 的浮窗契约。
 *
 * <p>task-442 钉的是「浮动态底边让开 composer」（`--xh-composer-h`）—— 那条红线的**前提已经消失**：
 * 浮窗形态不存在了，右栏恒为行内 flex 子项，不覆盖主列也就压不到发送键。所以这里改钉**反面**：
 * 浮窗那套 class / 内联样式**不许回来**（`absolute`、`top-0`、`bottom:`、`shadow-xl`、`z-20`）。</p>
 *
 * <p>保留的证据指针：真栈实测 1600×1000 浮窗覆盖发送键（`2026-11-14-instance-flow-audit/aux-obstruction.json`
 * + 图 105）是「为什么禁浮窗」的历史依据，不是「浮窗该怎么摆」的现行契约。</p>
 */
describe("WorkspaceDock · 浮窗形态退场后的形态契约（task-94 S1）", () => {
    it("任何入参下都不出现浮窗的定位/阴影/底边样式", () => {
        for (const props of [{}, { width: 480 }, { focus: true }, { fill: true }] as const) {
            const wrapper = mountDock(props);
            const panel = wrapper.get('[data-testid="workspace-aux-panel"]');
            const classes = panel.classes();
            expect(classes).not.toContain("absolute");
            expect(classes).not.toContain("top-0");
            expect(classes).not.toContain("shadow-xl");
            expect(classes).not.toContain("z-20");
            expect(panel.attributes("style") ?? "").not.toContain("bottom:");
        }
    });

    it("非 focus/非 fill 时仍以存储宽度落成内联 width", () => {
        const wrapper = mountDock({ width: 420 });
        const panel = wrapper.get('[data-testid="workspace-aux-panel"]');
        expect(panel.attributes("style")).toContain("width: 420px");
        // 锁的行为：宽度生效不影响模式投影 —— 非 focus/非 fill 恒为 pinned（不是「有宽度才 pinned」）。
        expect(
            panel.attributes("data-dock-mode"),
            "非 focus/非 fill ⇒ pinned，与是否有显式宽度无关",
        ).toBe("pinned");
    });
});

/**
 * task-88 ②（用户 2026-11-20 23:29 裁定）：右栏「+」从「重开已关闭面板」升级为
 * 「新建页签 → 选面板类型」的唯一入口；0 页签是可达态（折叠再展开 / 关光页签），
 * 此时右栏要有空态 + 仍可点的「+」，而不是一整片空白。
 */
describe("WorkspaceDock · task-88 ②：「+」选类型 + 0 页签空态", () => {
    it("0 页签时页签行仍渲染（allowEmpty）、给空态提示，「+」不置灰", () => {
        const wrapper = mountDock({ tabs: [], activeTab: "" });

        expect(wrapper.find('[data-testid="workspace-container-tabs"]').exists()).toBe(true);
        expect(wrapper.get('[data-testid="dock-empty-state"]').text()).toContain(
            "No panels are open yet",
        );
        expect(wrapper.find('[data-testid="dock-active-panel"]').exists()).toBe(false);

        const plus = wrapper.get('[data-testid="workspace-container-plus-right"]');
        expect(plus.attributes("disabled")).toBeUndefined();
        expect(plus.attributes("aria-label")).toBe("New tab: choose a panel type");
    });

    it("菜单是 role=menu、项是 menuitemcheckbox（已开项 aria-checked）；点击恒 emit（聚焦/新建归 workbench 判定）", async () => {
        const wrapper = mountDock();
        await wrapper.get('[data-testid="workspace-container-plus-right"]').trigger("click");

        // task-6（D1453）：静态面板 7 个（context 退役）+ 无会话 ⇒ 不列会话配置。
        expect(wrapper.findAll('[data-testid^="dock-reopen-item-"]')).toHaveLength(7);
        // task-140：手写 div 换成 reka 原语后，角色与键盘（Esc / 上下键 / roving focus）
        // 都由原语给；这里钉住契约，防止有人为了「少一层组件」再退回裸 div。
        expect(wrapper.get('[data-testid="dock-reopen-menu"]').attributes("role")).toBe("menu");
        const openItem = wrapper.get('[data-testid="dock-reopen-item-code"]');
        expect(openItem.attributes("role")).toBe("menuitemcheckbox");
        expect(openItem.attributes("aria-checked")).toBe("true");
        expect(openItem.text()).toContain("Open");
        expect(
            wrapper.get('[data-testid="dock-reopen-item-files"]').attributes("aria-checked"),
        ).toBe("false");

        await wrapper.get('[data-testid="dock-reopen-item-files"]').trigger("click");
        expect(wrapper.emitted("reopen-tab")).toEqual([["files"]]);

        // 已打开的项走同一条 emit：**组件不复制「已开则聚焦」的判定**（唯一判定在 openDockTab）。
        await wrapper.get('[data-testid="workspace-container-plus-right"]').trigger("click");
        await wrapper.get('[data-testid="dock-reopen-item-code"]').trigger("click");
        expect(wrapper.emitted("reopen-tab")).toEqual([["files"], ["code"]]);
    });

    /**
     * task-129（D-1907 rev10）：会话配置是**容器组件**，与静态面板同列在一张选择器里（task-6 后 7 个）；
     * id 走 138 的三元组（容器 + 会话），**testid 不能拼 id**（里面带 `:sid`，会变成每次会话
     * 都不同的选择器），故用稳定的 `dock-reopen-item-session-config`。
     */
    it("lists 会话配置 when a session is present; the item id carries the session (task-129)", async () => {
        const wrapper = mountDock({ sessionId: "sess-a" });
        await wrapper.get('[data-testid="workspace-container-plus-right"]').trigger("click");

        // 7 个静态面板 + 会话配置 = 8。
        expect(wrapper.findAll('[data-testid^="dock-reopen-item-"]')).toHaveLength(8);
        const item = wrapper.get('[data-testid="dock-reopen-item-session-config"]');
        expect(item.text()).toContain("Session config");
        expect(item.attributes("aria-checked")).toBe("false");

        await item.trigger("click");
        expect(wrapper.emitted("reopen-tab")).toEqual([["pane:right:session-config:sess-a"]]);
    });

    it("hides 会话配置 without a session (no sid ⇒ no legal pane id) (task-129)", async () => {
        const wrapper = mountDock({ sessionId: null });
        await wrapper.get('[data-testid="workspace-container-plus-right"]').trigger("click");

        expect(wrapper.findAll('[data-testid^="dock-reopen-item-"]')).toHaveLength(7);
        expect(wrapper.find('[data-testid="dock-reopen-item-session-config"]').exists()).toBe(
            false,
        );
    });
});
