import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { defineComponent } from "vue";
import ResourceDetailLink from "../ResourceDetailLink.vue";
import { i18n } from "../../../i18n";

/**
 * task-41（D-1239 裁 A：按真实缺口补，不凑文件数）：资源详情入口组件的 focused 单测。
 *
 * <p>此前 ResourceDetailLink 无单测（资源区 7 个单测文件之一缺口）。它只做一件事——
 * 用 resourceDetailPath 拼「pk + 层 ⇒ 详情 URL」，三条交互约束（纯增量 / 不吞行点击 / 键盘可达）
 * 是 Lead 2026-11-12 裁定 (a)。这里逐条钉住，承重性：去掉 @click.stop / 改 pk 拼法必红。</p>
 */
const RouterLinkStub = defineComponent({
    props: ["to"],
    template: '<a :href="to" v-bind="$attrs"><slot /></a>',
});
function mountLink(props: Record<string, unknown>) {
    return mount(ResourceDetailLink, {
        props: { resourceId: "credentials", layer: "USER", pk: "abc", ...props },
        global: { plugins: [i18n], stubs: { "router-link": RouterLinkStub } },
    });
}
describe("ResourceDetailLink — 详情 URL 与交互约束", () => {
    it("testid 按 pk 命名，URL = 资源/层/pk（层进 URL，pk 编码）", () => {
        const w = mountLink({ pk: "abc" });
        expect(w.find('[data-testid="resource-detail-link-abc"]').exists()).toBe(true);
        expect(w.find("a").attributes("href")).toBe("/resources/credentials/abc?layer=USER");
    });
    it("pk 含特殊字符时 encodeURIComponent（不许裸拼破坏 URL）", () => {
        const w = mountLink({ pk: "a b/c" });
        expect(w.find("a").attributes("href")).toBe("/resources/credentials/a%20b%2Fc?layer=USER");
    });
    it("层由调用方传，不同层进不同 URL（同 pk 在两层是两条行）", () => {
        const w = mountLink({ layer: "WORKSPACE", pk: "abc" });
        expect(w.find("a").attributes("href")).toBe("/resources/credentials/abc?layer=WORKSPACE");
    });
    it("aria-label 用人类可读名；缺省回落 pk（键盘可达读屏有意义）", () => {
        const named = mountLink({ name: "部署令牌", pk: "abc" });
        expect(named.find("a").attributes("aria-label")).toContain("部署令牌");
        const unnamed = mountLink({ pk: "abc" });
        expect(unnamed.find("a").attributes("aria-label")).toContain("abc");
    });
    it("键盘可达：渲染原生 <a>（router-link），不是 div+click 仿链接", () => {
        expect(mountLink({}).find("a").exists()).toBe(true);
        expect(mountLink({}).find("div").exists()).toBe(false);
    });
    it("不吞行点击：@click.stop —— 点详情入口不触发父行 click（承重：去掉 .stop 必红）", async () => {
        const onParent = vi.fn<() => void>();
        const Parent = defineComponent({
            components: { ResourceDetailLink },
            template:
                '<div @click="onParent"><ResourceDetailLink resource-id="credentials" layer="USER" pk="abc" /></div>',
            setup() {
                return { onParent };
            },
        });
        const w = mount(Parent, {
            global: { plugins: [i18n], stubs: { "router-link": RouterLinkStub } },
        });
        await w.find("a").trigger("click");
        expect(onParent).not.toHaveBeenCalled();
    });
});
