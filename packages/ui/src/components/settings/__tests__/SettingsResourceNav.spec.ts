import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";

/**
 * PLAN-0752 T4.0/T4.1：左栏「资源」组。
 *
 * 锁三件事：①后端缺口项**必须留在列表里**（D7：留位标缺口，不隐藏）
 * ②缺口项点击**不跳转**、给说明（不是 404、也不是没反应）
 * ③有后端承载的项（我的凭据）是真链接。
 */
const messages = {
    "zh-CN": {
        settings: {
            ia: {
                groupMyResources: "我的资源",
                resourceMyAgents: "我的智能体",
                resourceMyCredentials: "我的凭据",
                resourceKnowledgeMcp: "知识库 · MCP",
                backendGapBadge: "后端缺口 {code}",
                backendGapBadgeGeneric: "后端缺口",
                gapDialogTitle: "{item}：暂无后端承载",
                gapDialogDismiss: "知道了",
                gapNoteKnowledgeMcp: "用户层没有知识库实体，也没有用户级 MCP 服务器",
            },
        },
    },
};

const i18n = createI18n({ legacy: false, locale: "zh-CN", messages });

const pushed = vi.fn<(to: unknown) => void>();
vi.mock("vue-router", () => ({
    useRouter: () => ({ push: pushed }),
    RouterLink: {
        props: { to: { type: [String, Object], required: false, default: "" } },
        template: "<a :data-to='String(to)'><slot /></a>",
    },
}));

import { userResourceGroup } from "../../../lib/settingsIa";
import SettingsResourceNav from "../SettingsResourceNav.vue";

function mountNav() {
    return mount(SettingsResourceNav, {
        props: { groupLabelKey: "settings.ia.groupMyResources", items: userResourceGroup() },
        global: { plugins: [i18n] },
        attachTo: document.body,
    });
}

describe("SettingsResourceNav (PLAN-0752 T4.0)", () => {
    it("keeps the surviving gap entry visible and badges it (D7: no hiding)", () => {
        const wrapper = mountNav();
        // PLAN-0750 M3 之后：我的智能体 / 我的凭据都是真入口，只剩知识库·MCP 是缺口。
        // D7 的机制本身不能因为一项转真就删掉 —— 断言就靠 knowledge-mcp 这一条。
        expect(wrapper.find('[data-testid="settings-nav-resource-my-agents"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="settings-nav-resource-my-credentials"]').exists()).toBe(
            true,
        );
        const gap = wrapper.find('[data-testid="settings-nav-resource-gap-knowledge-mcp"]');
        expect(gap.exists()).toBe(true);
        expect(gap.text()).toContain("后端缺口 G1 / G3");
        wrapper.unmount();
    });

    it("routes real entries and never links gap entries", () => {
        const wrapper = mountNav();
        // 两个真入口都是链接，且指向已实现的页面
        expect(wrapper.find('[data-testid="settings-nav-resource-my-agents"]').text()).toBe(
            "我的智能体",
        );
        // 真入口渲染成带 to 的链接（SettingsSidebar.spec 对 ops 项用的是同一条断言方式）。
        expect(
            wrapper.find('[data-testid="settings-nav-resource-my-agents"]').attributes("to"),
        ).toBe("/settings/my-agents");
        expect(wrapper.find('[data-testid="settings-nav-resource-my-credentials"]').text()).toBe(
            "我的凭据",
        );
        // 缺口项是 button（没有 href / 没有 to），点击不走路由
        const gap = wrapper.find('[data-testid="settings-nav-resource-gap-knowledge-mcp"]');
        expect(gap.element.tagName).toBe("BUTTON");
        expect(wrapper.find('[data-testid="settings-nav-resource-knowledge-mcp"]').exists()).toBe(
            false,
        );
        wrapper.unmount();
    });

    it("opens an explanation instead of navigating when a gap entry is clicked", async () => {
        const wrapper = mountNav();
        pushed.mockClear();
        await wrapper
            .find('[data-testid="settings-nav-resource-gap-knowledge-mcp"]')
            .trigger("click");

        const dialog = document.querySelector('[data-testid="settings-gap-dialog-knowledge-mcp"]');
        expect(dialog).not.toBeNull();
        expect(dialog?.textContent ?? "").toContain("知识库 · MCP：暂无后端承载");
        expect(dialog?.textContent ?? "").toContain("后端缺口 G1 / G3");
        expect(dialog?.textContent ?? "").toContain("用户层没有知识库实体");
        // 不跳转：既没 push，也没渲染成链接
        expect(pushed).not.toHaveBeenCalled();
        wrapper.unmount();
    });
});
