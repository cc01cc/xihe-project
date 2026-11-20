import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { describe, expect, it } from "vitest";

import WorkspaceContainerTabs from "../WorkspaceContainerTabs.vue";

const i18n = createI18n({
    legacy: false,
    locale: "zh-CN",
    messages: {
        "zh-CN": {
            workspace: {
                containerTree: "文件树",
                containerMain: "主栏",
                containerEmpty: "此容器暂无页签",
                // task-155：溢出下拉触发器。
                containerOverflow: "更多页签",
                tabClose: "关闭页签",
            },
        },
    },
});

function mountRow(props: Record<string, unknown>) {
    return mount(WorkspaceContainerTabs, { props, global: { plugins: [i18n] } });
}

const TABS = [
    { id: "session:s1", label: "S1", closable: true },
    { id: "environment", label: "环境", closable: false },
];

describe("WorkspaceContainerTabs（task-174 S2b：容器内页签行）", () => {
    it("渲染一行页签，且带上容器锚点（判据①的 DOM 读数靠 data-container）", () => {
        const wrapper = mountRow({ containerId: "main", tabs: TABS, activeId: "session:s1" });
        const row = wrapper.get('[data-testid="workspace-container-tabs"]');
        expect(row.attributes("data-container")).toBe("main");
        expect(wrapper.findAll('[role="tab"]')).toHaveLength(2);
    });

    it("**没有页签时不渲染空行**（空壳行是最难查的假绿：看起来有行、其实一个 tab 都没有）", () => {
        const wrapper = mountRow({ containerId: "main", tabs: [], activeId: null });
        expect(wrapper.find('[data-testid="workspace-container-tabs"]').exists()).toBe(false);
    });

    it("allowEmpty 显式打开时才画空行（调用方明确要求时才允许）", () => {
        const wrapper = mountRow({
            containerId: "main",
            tabs: [],
            activeId: null,
            allowEmpty: true,
        });
        expect(wrapper.find('[data-testid="workspace-container-tabs"]').exists()).toBe(true);
        expect(wrapper.text()).toContain("此容器暂无页签");
    });

    it("选中与关闭都只 emit，不自己改状态（布局 writer 不在这里）", async () => {
        const wrapper = mountRow({ containerId: "main", tabs: TABS, activeId: "session:s1" });
        await wrapper
            .get('[data-testid="workspace-container-tab-main-environment"]')
            .trigger("click");
        expect(wrapper.emitted("select")?.[0]).toEqual(["environment"]);
        await wrapper
            .get('[data-testid="workspace-container-tab-close-main-session:s1"]')
            .trigger("click");
        expect(wrapper.emitted("close")?.[0]).toEqual(["session:s1"]);
    });

    /**
     * task-89（WCAG 2.2 SC 2.5.8 ≥24×24）：容器页签的关闭键改前 `p-0.5` + `size-3` ⇒
     * **14×14**，与左邻 `workspace-container-tab-` 本体矩形距 **7** ⇒ 真缺陷。
     * `min-h-7 min-w-7` = 7 × 3.5px = **24.5px**（本仓 `--spacing` = 3.5）；`X` 仍 size-3。
     * jsdom 不求值 Tailwind ⇒ 钉类名，真 rect 归 Playwright。
     */
    it("task-89：关闭键命中盒 ≥24×24（min-h-7 min-w-7），图标尺寸不变", () => {
        const wrapper = mountRow({ containerId: "main", tabs: TABS, activeId: "session:s1" });
        const closers = wrapper.findAll('[data-testid^="workspace-container-tab-close-"]');
        expect(closers).toHaveLength(1);
        expect(closers[0].classes()).toEqual(
            expect.arrayContaining(["min-h-7", "min-w-7", "items-center", "justify-center"]),
        );
        expect(closers[0].get("svg").classes()).toContain("size-3");
    });

    it("只读面板（closable=false）没有关闭按钮", () => {
        const wrapper = mountRow({
            containerId: "main",
            tabs: [{ id: "main", label: "主栏", closable: false }],
            activeId: "main",
        });
        expect(wrapper.find('[data-testid^="workspace-container-tab-close-"]').exists()).toBe(
            false,
        );
    });

    it("task-17 W-1：单 tab 与容器同名 ⇒ 去掉容器标签只留 tab（aria-label 保住可访问名）", () => {
        // D-1777/D-1778（task-65 A 段）：tree 容器已退场（两容器 = main/right），
        // 同形用例改挂 main 容器 + 与容器同名的单 tab。
        const wrapper = mountRow({
            containerId: "main",
            tabs: [{ id: "main", label: "主栏", closable: false }],
            activeId: "main",
        });
        expect(wrapper.find('[data-testid="workspace-container-label"]').exists()).toBe(false);
        expect(wrapper.get('[data-testid="workspace-container-tab-main-main"]').text()).toBe(
            "主栏",
        );
        expect(
            wrapper.get('[data-testid="workspace-container-tabs"]').attributes("aria-label"),
        ).toBe("主栏");
    });

    it("task-17 W-1 反向：单 tab 但与容器不同名 ⇒ 容器标签保留（task-100 后 = DOM 保留、视觉隐藏）", () => {
        const wrapper = mountRow({
            containerId: "main",
            tabs: [{ id: "session:s1", label: "S1", closable: true }],
            activeId: "session:s1",
        });
        expect(wrapper.get('[data-testid="workspace-container-label"]').text()).toBe("主栏");
    });

    it("task-17 W-1 反向：多 tab ⇒ 容器标签保留（task-100 后 = DOM 保留、视觉隐藏）", () => {
        const wrapper = mountRow({ containerId: "main", tabs: TABS, activeId: "session:s1" });
        expect(wrapper.get('[data-testid="workspace-container-label"]').text()).toBe("主栏");
    });

    /**
     * task-100（用户 2026-11-19）：容器名「内容」对用户没有信息量 ⇒ 改视觉隐藏。
     * 判据必须能区分「藏了」与「删了」：只断言 text() 的话 sr-only 也满足（SettingsDomainView.spec.ts:671
     * 记过同一个坑）。所以这里钉类名钩子；真机的 offsetWidth === 0 归 Playwright（jsdom 不求值布局）。
     */
    it("task-100：容器名改视觉隐藏（保留 DOM 与 testid），可访问名由 nav 的 aria-label 承担", () => {
        const wrapper = mountRow({ containerId: "main", tabs: TABS, activeId: "session:s1" });
        const label = wrapper.get('[data-testid="workspace-container-label"]');
        expect(label.classes()).toContain("sr-only");
        expect(label.classes()).not.toContain("text-xs");
        expect(label.text()).toBe("主栏");
        expect(
            wrapper.get('[data-testid="workspace-container-tabs"]').attributes("aria-label"),
        ).toBe("主栏");
    });

    /**
     * task-52 / batch-02（P1-3，D-1703）：**同名不同物**必须在视觉上分得开。
     *
     * 现象（Lead 截图 b02-10-chat-full.png）：同一个会话在侧栏是「一行会话项」、
     * 在这里是「一个页签」，两处渲染**同一个 title**，而外观要素几乎一致 ⇒ 用户点错。
     * 修法 = 给页签一个「窗口」图标（身份差异，与侧栏会话行的对话气泡相对）。
     *
     * 承重点（变异）：删掉 AppWindow 那一行 ⇒ 本用例红（找不到 workspace-tab-identity）。
     * 同时钉住「文字仍然只是标题」：图标是 aria-hidden 的装饰，不许把身份靠图标**唯一**承载 ——
     * 页签的 role="tab" 才是读屏用户的分辨手段，两条都在。
     */
    it("每个页签带身份图标（与会话行区分），且文字仍只是标题", () => {
        const wrapper = mountRow({ containerId: "main", tabs: TABS, activeId: "session:s1" });
        const triggers = wrapper.findAll('[role="tab"]');
        expect(triggers).toHaveLength(TABS.length);
        for (const trigger of triggers) {
            expect(trigger.find('[data-testid="workspace-tab-identity"]').exists()).toBe(true);
        }
        // 图标不进可见文字（text() 只有标题本身），否则可访问名会被装饰污染。
        expect(triggers[0].text()).toBe("S1");
        // 图标是装饰：不参与可访问名求值。
        expect(
            triggers[0].find('[data-testid="workspace-tab-identity"]').attributes("aria-hidden"),
        ).toBe("true");
    });
});

const FOUR_TABS = [
    { id: "session:s1", label: "S1", closable: true },
    { id: "session:s2", label: "S2", closable: true },
    { id: "session:s3", label: "S3", closable: true },
    { id: "session:s4", label: "S4", closable: true },
];

describe("WorkspaceContainerTabs（task-155：maxVisibleTabs 溢出策略）", () => {
    it("不传上限 = 全部渲染、无溢出触发器（右栏/树行既有行为不变）", () => {
        const wrapper = mountRow({ containerId: "main", tabs: FOUR_TABS, activeId: "session:s1" });
        expect(wrapper.findAll('[role="tab"]')).toHaveLength(4);
        expect(wrapper.find('[data-testid="workspace-container-overflow-main"]').exists()).toBe(
            false,
        );
    });

    it("传上限 = 只渲染前 N 个，触发器计数 = 溢出数，菜单列出溢出页签", async () => {
        const wrapper = mountRow({
            containerId: "main",
            tabs: FOUR_TABS,
            activeId: "session:s1",
            maxVisibleTabs: 2,
        });
        expect(wrapper.findAll('[role="tab"]')).toHaveLength(2);
        const trigger = wrapper.get('[data-testid="workspace-container-overflow-main"]');
        expect(trigger.text()).toContain("2");
        expect(
            wrapper.find('[data-testid="workspace-container-overflow-main-menu"]').exists(),
        ).toBe(false);
        await trigger.trigger("click");
        const menu = wrapper.get('[data-testid="workspace-container-overflow-main-menu"]');
        expect(
            menu.findAll('[data-testid^="workspace-container-overflow-main-item-"]'),
        ).toHaveLength(2);
        // 溢出项的 close 与行内页签同门槛（closable），testid 带容器段。
        expect(
            menu
                .find('[data-testid="workspace-container-overflow-main-close-session:s3"]')
                .exists(),
        ).toBe(true);
    });

    it("溢出项的选中与关闭只 emit，不自己改状态（与行内页签同一纪律）", async () => {
        const wrapper = mountRow({
            containerId: "main",
            tabs: FOUR_TABS,
            activeId: "session:s1",
            maxVisibleTabs: 1,
        });
        await wrapper.get('[data-testid="workspace-container-overflow-main"]').trigger("click");
        await wrapper
            .get('[data-testid="workspace-container-overflow-main-item-session:s4"]')
            .trigger("click");
        expect(wrapper.emitted("select")?.[0]).toEqual(["session:s4"]);
        await wrapper
            .get('[data-testid="workspace-container-overflow-main-close-session:s2"]')
            .trigger("click");
        expect(wrapper.emitted("close")?.[0]).toEqual(["session:s2"]);
    });
});
