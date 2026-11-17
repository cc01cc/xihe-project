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
            // task-69：403 卡片点名缺的**动作原子** ⇒ 视图现在要两个参数：{atom} 中文名 + {code} 机器码。
            // 词表与产品同一份（`lib/permissionAtomLabels`），夹具这里也照实给，别绕开。
            permissionAtom: { readInstanceContent: "读取实例内容" },
            ia: {
                forbiddenTitle: "无权访问实例层设置",
                // task-18（源 = task-6 候选 C-4）：正文不印内部能力位标识，且要说清"去哪授予"。
                forbiddenBody:
                    "你的账号缺少「{atom}」权限（{code}），因此不加载配置。这是授权问题，不是功能缺失：可以改用个人层，或请管理员在「设置 → 角色与绑定」为你的账号授予该权限。",
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
        // task-69：判据是**动作原子**，文案就必须点名缺的是哪个原子 —— 中文名 + 机器码同时在屏
        // （与 SettingsPermissionGate 的 atom-denied 同一口径，不另造第二套）。
        expect(card.text()).toContain("READ_INSTANCE_CONTENT");
        expect(card.text()).toContain("读取实例内容");
        // 能力位措辞已清走：它是「持能力位、缺原子」这一格里的假陈述（D-1521 M-1 反面②）。
        expect(card.text()).not.toContain("实例管理员");
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

    /**
     * task-69：`atom` 是 prop 而不是写死的常量 —— 视图壳只负责"把缺的原子说清楚"，
     * 判据归调用方（`SettingsDomainView:87-93` 的原子口径是 D-1521 M-1=B 的裁定结果，本卡不动）。
     * 这条同时钉住「机器码原样输出」：未登记词表的原子**回退原码**，不许拿中文名吞掉它。
     */
    it("atom prop 可换，且机器码原样输出（未登记词表时回退原码，不吞）", () => {
        const i18n = createI18n({ legacy: false, locale: "zh-CN", messages });
        const wrapper = mount(
            {
                components: { SettingsForbiddenView },
                template: '<SettingsForbiddenView atom="FAKE_ATOM_FOR_SHAPE_PROBE" />',
            },
            {
                global: {
                    plugins: [i18n],
                    stubs: { RouterLink: { template: "<a data-router-link><slot /></a>" } },
                },
            },
        );
        const card = wrapper.get('[data-testid="settings-forbidden"]');
        // 未登记 ⇒ 中文名侧回退原码（诚实优先），机器码侧照旧 —— 两处都是原码，且不出现占位残留。
        expect(card.text()).toContain("FAKE_ATOM_FOR_SHAPE_PROBE");
        expect(card.text()).not.toContain("{atom}");
        expect(card.text()).not.toContain("{code}");
        wrapper.unmount();
    });
});
