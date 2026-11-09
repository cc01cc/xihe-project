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
                gapNoteAgentUser: "用户级创建入口尚未实施（PLAN-0750）",
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
    it("keeps the gap entries visible and badges them (D7: no hiding)", () => {
        const wrapper = mountNav();
        // 三条都在：我的智能体（缺口）、我的凭据（真）、知识库·MCP（缺口）
        expect(wrapper.find('[data-testid="settings-nav-resource-gap-my-agents"]').exists()).toBe(
            true,
        );
        expect(wrapper.find('[data-testid="settings-nav-resource-my-credentials"]').exists()).toBe(
            true,
        );
        expect(
            wrapper.find('[data-testid="settings-nav-resource-gap-knowledge-mcp"]').exists(),
        ).toBe(true);
        expect(
            wrapper.find('[data-testid="settings-nav-resource-gap-knowledge-mcp"]').text(),
        ).toContain("后端缺口 G1 / G3");
        wrapper.unmount();
    });

    it("routes real entries and never links gap entries", () => {
        const wrapper = mountNav();
        expect(wrapper.find('[data-testid="settings-nav-resource-my-credentials"]').text()).toBe(
            "我的凭据",
        );
        // 缺口项是 button（没有 href / 没有 to），点击不走路由
        const gap = wrapper.find('[data-testid="settings-nav-resource-gap-my-agents"]');
        expect(gap.element.tagName).toBe("BUTTON");
        expect(wrapper.find('[data-testid="settings-nav-resource-my-agents"]').exists()).toBe(
            false,
        );
        wrapper.unmount();
    });

    it("opens an explanation instead of navigating when a gap entry is clicked", async () => {
        const wrapper = mountNav();
        pushed.mockClear();
        await wrapper.find('[data-testid="settings-nav-resource-gap-my-agents"]').trigger("click");

        const dialog = document.querySelector('[data-testid="settings-gap-dialog-my-agents"]');
        expect(dialog).not.toBeNull();
        expect(dialog?.textContent ?? "").toContain("我的智能体：暂无后端承载");
        expect(dialog?.textContent ?? "").toContain("后端缺口 G4");
        expect(dialog?.textContent ?? "").toContain("PLAN-0750");
        // 不跳转：既没 push，也没渲染成链接
        expect(pushed).not.toHaveBeenCalled();
        wrapper.unmount();
    });
});
