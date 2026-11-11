import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import SettingsLayerHeader from "../SettingsLayerHeader.vue";

// PLAN-0752 T1.1b（task-179）：层标题 + 面包屑模板是两层归一的单点实现，这里按
// design.md §6「面包屑」V10 判据断言（模板 /^设置 (实例|用户)层( .+)?$/、
// 末段 aria-current="page"、父级「设置」可点）。未挂 router 插件时 router-link 渲染
// 为未解析元素，to 以原生属性断言。
//
// PLAN-0762 T1.2 + T3.3（2026-11-11）：面包屑改由 vendor `Breadcrumb` 组件族渲染，
// 分隔符从 `" › "` 文本换成 `BreadcrumbSeparator` 的 `ChevronRight` 图标 ⇒ 断言不再盯着
// 那个字符，改为盯**可寻址性 + 段序 + aria 语义**（`settings-breadcrumb` testid /
// `aria-label` / 唯一 `aria-current="page"` / 根链接目标），文字与段序一字不改。
const messages = {
    "zh-CN": {
        settings: {
            ia: {
                breadcrumbRoot: "设置",
                breadcrumbLabel: "面包屑",
                layerInstance: "实例配置",
                layerUser: "用户配置",
                layerWorkspaceDefault: "工作区默认配置",
                layerInstanceShort: "实例层",
                layerUserShort: "用户层",
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
        // 段序与文字不变；分隔符由组件渲染成图标（无文本）。
        expect(nav.text()).toMatch(/设置\s*实例层$/);
        expect(nav.attributes("aria-label")).toBe("面包屑");
        const currents = wrapper.findAll('[aria-current="page"]');
        expect(currents).toHaveLength(1);
        expect(currents[0]!.text()).toBe("实例层");
        expect(wrapper.find("router-link").attributes("to")).toBe("/settings");
    });

    it("appends the domain as the final aria-current segment", () => {
        const wrapper = mountHeader({ layer: "user", domain: "智能体绑定" });
        const nav = wrapper.find('[data-testid="settings-breadcrumb"]');
        expect(nav.text()).toMatch(/^设置\s*用户层\s*智能体绑定$/);
        const currents = wrapper.findAll('[aria-current="page"]');
        expect(currents).toHaveLength(1);
        expect(currents[0]!.text()).toBe("智能体绑定");
        expect(wrapper.find('[data-testid="settings-layer-title"]').text()).toBe("用户配置");
    });

    it("covers the user layer, stays sticky with a border and renders summary + slot", () => {
        const wrapper = mountHeader({ layer: "user", summary: "3 个域" }, "<p>slot 内容</p>");
        expect(wrapper.find("header").classes()).toContain("sticky");
        expect(wrapper.find("header").classes()).toContain("border-b");
        expect(wrapper.find('[data-testid="settings-layer-title"]').text()).toBe("用户配置");
        expect(navText(wrapper)).toMatch(/设置\s*用户层$/);
        expect(wrapper.text()).toContain("3 个域");
        expect(wrapper.text()).toContain("slot 内容");
    });

    // PLAN-0762 T3.3：三层都要能在面包屑里成段（workspace-default 是 PLAN-0766 引入的第三层，
    // 上一版三元链漏过它 ⇒ 本次用映射表 + 这条断言把它钉住）。
    it.each([
        ["instance", "实例层"],
        ["user", "用户层"],
        ["workspace-default", "工作区默认配置"],
    ] as const)("T3.3: layer %s appears as its own crumb segment", (layer, crumb) => {
        const wrapper = mountHeader({ layer, domain: "日志与追踪" });
        expect(wrapper.find('[data-testid="settings-breadcrumb"]').text()).toMatch(
            new RegExp(`^设置\\s*${crumb}\\s*日志与追踪$`),
        );
    });

    // PLAN-0762 T1.2：分隔符来自 `BreadcrumbSeparator`（vendor 组件族），不再是手写字符串；
    // 有域 2 段分隔、无域 1 段。这条断言同时防止「组件族 + 文本分隔」两套并存。
    it("T1.2: separators come from BreadcrumbSeparator, never from a text glyph", () => {
        const layerOnly = mountHeader({ layer: "instance" });
        expect(layerOnly.findAll('[data-slot="breadcrumb-separator"]')).toHaveLength(1);
        expect(layerOnly.text()).not.toContain("›");

        const withDomain = mountHeader({ layer: "instance", domain: "RAG" });
        expect(withDomain.findAll('[data-slot="breadcrumb-separator"]')).toHaveLength(2);
        expect(withDomain.text()).not.toContain("›");
    });
});

function navText(wrapper: ReturnType<typeof mount>): string {
    return wrapper.find('[data-testid="settings-breadcrumb"]').text();
}
