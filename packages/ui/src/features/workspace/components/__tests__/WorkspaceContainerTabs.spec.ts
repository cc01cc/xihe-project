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
                containerMain: "内容",
                containerEmpty: "此容器暂无页签",
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

    it("只读面板（closable=false）没有关闭按钮", () => {
        const wrapper = mountRow({
            containerId: "tree",
            tabs: [{ id: "tree", label: "文件树", closable: false }],
            activeId: "tree",
        });
        expect(wrapper.find('[data-testid^="workspace-container-tab-close-"]').exists()).toBe(
            false,
        );
    });

    it("task-17 W-1：单 tab 与容器同名 ⇒ 去掉容器标签只留 tab（aria-label 保住可访问名）", () => {
        const wrapper = mountRow({
            containerId: "tree",
            tabs: [{ id: "tree", label: "文件树", closable: false }],
            activeId: "tree",
        });
        expect(wrapper.find('[data-testid="workspace-container-label"]').exists()).toBe(false);
        expect(wrapper.get('[data-testid="workspace-container-tab-tree-tree"]').text()).toBe(
            "文件树",
        );
        expect(
            wrapper.get('[data-testid="workspace-container-tabs"]').attributes("aria-label"),
        ).toBe("文件树");
    });

    it("task-17 W-1 反向：单 tab 但与容器不同名 ⇒ 容器标签保留（主容器标识不丢）", () => {
        const wrapper = mountRow({
            containerId: "main",
            tabs: [{ id: "session:s1", label: "S1", closable: true }],
            activeId: "session:s1",
        });
        expect(wrapper.get('[data-testid="workspace-container-label"]').text()).toBe("内容");
    });

    it("task-17 W-1 反向：多 tab ⇒ 容器标签保留", () => {
        const wrapper = mountRow({ containerId: "main", tabs: TABS, activeId: "session:s1" });
        expect(wrapper.get('[data-testid="workspace-container-label"]').text()).toBe("内容");
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
