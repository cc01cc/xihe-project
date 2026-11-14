import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import SettingsForbiddenView from "../SettingsForbiddenView.vue";

/**
 * task-227 ⑨ 类 H-11：403 视图从手搓 `<section class="mx-auto max-w-xl rounded-lg border p-6">`
 * 换成 vendor `Alert` 族。判据是**行为**不是外形 —— 修前那块 section 没有 role/aria-live，
 * 权限拒绝不会被屏幕阅读器播报；换件后 `Alert` 自带 `role="alert"`。
 *
 * 与 `SettingsPermissionGate` 的 `no-atom` 那条不许混：那边是 `role="status"`（非紧急信息条），
 * 这里是 `role="alert"`（阻断态）。两个 testid 也各自独立（settings-forbidden / settings-no-atom-notice）。
 */
const messages = {
    "zh-CN": {
        settings: {
            ia: {
                forbiddenTitle: "无权访问实例层设置",
                // task-18（源 = task-6 候选 C-4）：正文不印内部能力位标识，且要说清"去哪授予"。
                forbiddenBody:
                    "你的账号没有「实例管理员」能力，因此不加载配置。可以改用个人层，或请管理员在「设置 → 角色与绑定」为你的账号授予该能力。",
                backToUserLayer: "去个人层",
            },
        },
    },
};

function mountView() {
    const i18n = createI18n({ legacy: false, locale: "zh-CN", messages });
    return mount(SettingsForbiddenView, {
        global: {
            plugins: [i18n],
            stubs: { RouterLink: { template: "<a data-router-link><slot /></a>" } },
        },
    });
}

describe("SettingsForbiddenView（task-227 ⑨ 类 H-11）", () => {
    it("是 vendor Alert（data-slot=alert）且带 role=alert —— 403 必须被读屏播报", () => {
        const wrapper = mountView();
        const card = wrapper.get('[data-testid="settings-forbidden"]');
        expect(card.attributes("data-slot")).toBe("alert");
        expect(card.attributes("role")).toBe("alert");
        // 手搓痕迹清零：修前是 section + rounded-lg border（Alert 的 variant 自带 border，但元素不是 section）
        expect(card.element.tagName).not.toBe("SECTION");
        expect(card.text()).toContain("无权访问实例层设置");
        expect(card.text()).toContain("不加载配置");
        // task-18（C-4）：① 不把内部能力位标识印给用户 ② 必须给出"下一步去哪授予"。
        expect(card.text()).not.toContain("cap:");
        expect(card.text()).toContain("角色与绑定");
        wrapper.unmount();
    });

    it("标题语义不降级（h2 保留），出口按钮仍是可导航的链接", () => {
        const wrapper = mountView();
        const card = wrapper.get('[data-testid="settings-forbidden"]');
        expect(card.find("h2").text()).toBe("无权访问实例层设置");
        // AlertTitle 只渲染 div ⇒ 标题必须由里层 h2 承担（同 SettingsPermissionGate 的写法）
        expect(card.find('[data-slot="alert-title"] h2').exists()).toBe(true);
        const link = card.get("[data-router-link]");
        expect(link.text()).toBe("去个人层");
        wrapper.unmount();
    });

    it("预警图标用 @lucide/vue 的 ShieldAlert，并标 aria-hidden（语义由标题承担）", () => {
        const wrapper = mountView();
        const card = wrapper.get('[data-testid="settings-forbidden"]');
        const icon = card.get("svg");
        expect(icon.attributes("aria-hidden")).toBe("true");
        wrapper.unmount();
    });
});
