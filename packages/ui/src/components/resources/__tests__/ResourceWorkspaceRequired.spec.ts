import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { defineComponent } from "vue";
import ResourceWorkspaceRequired from "../ResourceWorkspaceRequired.vue";
import { i18n } from "../../../i18n";

/**
 * task-41（D-1239 裁 A）：工作区层「无上下文」诚实态组件的 focused 单测。
 *
 * <p>此前 ResourceWorkspaceRequired 无单测。它是一条判据不是提示语（verify.md V11：
 * 各层数据来自各自契约，禁拿实例层冒充）——没有 workspaceId 时工作区层没有任何合法数据，
 * 只能给「先选工作区」出口，不许静默回落别的层。承重性：删出口 / 漏翻必红。</p>
 */
const RouterLinkStub = defineComponent({
    props: ["to"],
    template: '<a :href="to" v-bind="$attrs"><slot /></a>',
});
function mountGate() {
    return mount(ResourceWorkspaceRequired, {
        global: { plugins: [i18n], stubs: { "router-link": RouterLinkStub } },
    });
}
describe("ResourceWorkspaceRequired — 无工作区上下文的诚实态", () => {
    it("渲染诚实态容器（testid），不是静默空列表", () => {
        expect(mountGate().find('[data-testid="resources-workspace-required"]').exists()).toBe(
            true,
        );
    });
    it("标题/正文/出口三段都有实文案，不出现裸 i18n 键", () => {
        const text = mountGate().text();
        expect(text.length).toBeGreaterThan(10);
        expect(text).not.toContain("resources.");
    });
    it("给「先选工作区」出口：router-link 指向 /workspace（承重：删出口必红）", () => {
        const w = mountGate();
        const link = w.find("a");
        expect(link.exists()).toBe(true);
        expect(link.attributes("href")).toBe("/workspace");
    });
    it("只渲染这一个诚实态 section，不冒充任何资源面板", () => {
        const w = mountGate();
        expect(w.findAll("section")).toHaveLength(1);
    });
});
