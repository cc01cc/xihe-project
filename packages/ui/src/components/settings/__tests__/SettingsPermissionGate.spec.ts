import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import SettingsPermissionGate from "../SettingsPermissionGate.vue";

/**
 * PLAN-0752 T4.4：两个权限面必须长得不一样（用户裁定「不许把无 atom 当成 403」）。
 * 这里用 **不同的 testid + 不同的组件形态** 把两者钉死，避免以后有人把它们合成一个「提示」。
 */
const messages = {
    "zh-CN": {
        settings: {
            ia: {
                noAtomTitle: "本页没有权限原子：",
                noAtomBody: "内容按你的归属自动收窄，这里不会出现 403。",
                atomDeniedTitle: "权限不足",
                atomDeniedBody: "缺少「{atom}」权限（{code}）。这是授权问题，不是功能缺失。",
                atomDeniedNotGap: "本页不是后端缺口。",
            },
            permissionAtom: {
                credentialManage: "凭据管理",
                createOwnAgent: "创建个人智能体",
                writeInstanceContent: "写入实例内容",
            },
        },
    },
};

function i18n() {
    return createI18n({ legacy: false, locale: "zh-CN", messages });
}

describe("SettingsPermissionGate (PLAN-0752 T4.4)", () => {
    it("renders a non-blocking info bar for pages without any atom", () => {
        const wrapper = mount(SettingsPermissionGate, {
            props: { variant: "no-atom" },
            global: { plugins: [i18n()] },
        });

        const notice = wrapper.find('[data-testid="settings-no-atom-notice"]');
        expect(notice.exists()).toBe(true);
        expect(notice.text()).toContain("不会出现 403");
        // 关键：无 atom 的页**不能**出现 403 视图的任何痕迹
        expect(wrapper.find('[data-testid="settings-atom-denied"]').exists()).toBe(false);
        expect(wrapper.text()).not.toContain("权限不足");
    });

    it("renders a 403 card that names the missing atom and says it is not a backend gap", () => {
        const wrapper = mount(SettingsPermissionGate, {
            props: { variant: "atom-denied", atom: "credential_manage" },
            global: { plugins: [i18n()] },
        });

        const card = wrapper.find('[data-testid="settings-atom-denied"]');
        expect(card.exists()).toBe(true);
        expect(card.text()).toContain("credential_manage");
        expect(wrapper.find('[data-testid="settings-atom-denied-not-gap"]').text()).toContain(
            "不是后端缺口",
        );
        expect(wrapper.find('[data-testid="settings-no-atom-notice"]').exists()).toBe(false);
    });

    it("task-22 / P2-4：正文同时给中文权限名与机器码，未登记原子回退原码", () => {
        const wrapper = mount(SettingsPermissionGate, {
            props: { variant: "atom-denied", atom: "credential_manage" },
            global: { plugins: [i18n()] },
        });
        const card = wrapper.find('[data-testid="settings-atom-denied"]');
        // 中文名给用户读
        expect(card.text()).toContain("缺少「凭据管理」权限");
        // 机器码给支持排查，不许吞掉
        expect(card.text()).toContain("（credential_manage）");

        const unknown = mount(SettingsPermissionGate, {
            props: { variant: "atom-denied", atom: "SOME_NEW_ATOM" },
            global: { plugins: [i18n()] },
        });
        expect(unknown.find('[data-testid="settings-atom-denied"]').text()).toContain(
            "缺少「SOME_NEW_ATOM」权限（SOME_NEW_ATOM）",
        );
    });

    // PLAN-0762 T1.3：两块改由 vendor `components/ui/alert` 渲染（`data-slot="alert"`），
    // 但**语义分层不许合并**：信息条是 `role="status"`（非紧急播报），403 卡片是 `role="alert"`。
    it("T1.3: both blocks come from the Alert component family, with distinct a11y roles", () => {
        const info = mount(SettingsPermissionGate, {
            props: { variant: "no-atom" },
            global: { plugins: [i18n()] },
        });
        const notice = info.find('[data-testid="settings-no-atom-notice"]');
        expect(notice.attributes("data-slot")).toBe("alert");
        expect(notice.attributes("role")).toBe("status");

        const denied = mount(SettingsPermissionGate, {
            props: { variant: "atom-denied", atom: "credential_manage" },
            global: { plugins: [i18n()] },
        });
        const card = denied.find('[data-testid="settings-atom-denied"]');
        expect(card.attributes("data-slot")).toBe("alert");
        expect(card.attributes("role")).toBe("alert");
        // 标题语义不许降级：换组件族前是 h2，换后仍是 h2。
        expect(card.find("h2").text()).toBe("权限不足");
    });
});
