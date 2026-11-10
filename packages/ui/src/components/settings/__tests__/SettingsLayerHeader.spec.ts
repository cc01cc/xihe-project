import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import SettingsLayerHeader from "../SettingsLayerHeader.vue";

// PLAN-0752 T1.1b（task-179）：层标题 + 面包屑模板是三处归一的单点实现，这里按
// design.md §6「面包屑」V10 判据断言（模板 /^设置 › (实例|用户|工作区)层( › .+)?$/、
// 末段 aria-current="page"、父级「设置」可点）。未挂 router 插件时 router-link 渲染
// 为未解析元素，to 以原生属性断言。
const messages = {
    "zh-CN": {
        settings: {
            ia: {
                breadcrumbRoot: "设置",
                breadcrumbLabel: "面包屑",
                layerInstance: "实例配置",
                layerUser: "用户配置",
                layerWorkspace: "工作区设置",
                layerInstanceShort: "实例层",
                layerUserShort: "用户层",
                layerWorkspaceShort: "工作区层",
            },
        },
    },
};

function mountHeader(props: Record<string, unknown>, slot = "") {
    const i18n = createI18n({ legacy: false, locale: "zh-CN", messages });
    return mount(SettingsLayerHeader, {
        global: { plugins: [i18n] },
        props,
        slots: slot ? { default: slot } : {},
    });
}

describe("SettingsLayerHeader (PLAN-0752 T1.1b)", () => {
    it("renders layer title + two-segment breadcrumb; the layer segment is current without a domain", () => {
        const wrapper = mountHeader({ layer: "instance" });
        expect(wrapper.find('[data-testid="settings-layer-title"]').text()).toBe("实例配置");
        const nav = wrapper.find('[data-testid="settings-breadcrumb"]');
        expect(nav.text()).toMatch(/设置\s*›\s*实例层$/);
        expect(nav.attributes("aria-label")).toBe("面包屑");
        const currents = wrapper.findAll('[aria-current="page"]');
        expect(currents).toHaveLength(1);
        expect(currents[0]!.text()).toBe("实例层");
        expect(wrapper.find("router-link").attributes("to")).toBe("/settings");
    });

    it("appends the domain as the final aria-current segment for the workspace layer", () => {
        const wrapper = mountHeader({ layer: "workspace", domain: "智能体绑定" });
        const nav = wrapper.find('[data-testid="settings-breadcrumb"]');
        expect(nav.text()).toMatch(/^设置\s*›\s*工作区层\s*›\s*智能体绑定$/);
        const currents = wrapper.findAll('[aria-current="page"]');
        expect(currents).toHaveLength(1);
        expect(currents[0]!.text()).toBe("智能体绑定");
        expect(wrapper.find('[data-testid="settings-layer-title"]').text()).toBe("工作区设置");
    });

    it("covers the user layer, stays sticky with a border and renders summary + slot", () => {
        const wrapper = mountHeader({ layer: "user", summary: "3 个域" }, "<p>slot 内容</p>");
        expect(wrapper.find("header").classes()).toContain("sticky");
        expect(wrapper.find("header").classes()).toContain("border-b");
        expect(wrapper.find('[data-testid="settings-layer-title"]').text()).toBe("用户配置");
        expect(navText(wrapper)).toMatch(/设置\s*›\s*用户层$/);
        expect(wrapper.text()).toContain("3 个域");
        expect(wrapper.text()).toContain("slot 内容");
    });
});

function navText(wrapper: ReturnType<typeof mount>): string {
    return wrapper.find('[data-testid="settings-breadcrumb"]').text();
}
