import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";

/**
 * PLAN-0752 T4.0/T4.1：左栏「资源」组。
 *
 * 锁三件事：①后端缺口项**必须留在列表里**（D7：留位标缺口，不隐藏）
 * ②缺口项**不可点**（task-156 / P0-N-09：不再是 button），说明走组级 hint + title
 * ③有后端承载的项（我的凭据）是真链接。
 */
const messages = {
    "zh-CN": {
        settings: {
            ia: {
                groupMyResources: "我的资源",
                resourceAgentPrincipals: "智能体主体",
                resourceMyCredentials: "我的凭据",
                resourceKnowledgeMcp: "知识库 · MCP",
                backendGapBadge: "后端缺口 {code}",
                backendGapBadgeGeneric: "后端缺口",
                backendGapHint: "灰显条目为后端缺口，暂不可用；悬停可查看说明。",
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
        // PLAN-0750 M3 之后：智能体主体 / 我的凭据都是真入口，只剩知识库·MCP 是缺口。
        // D7 的机制本身不能因为一项转真就删掉 —— 断言就靠 knowledge-mcp 这一条。
        expect(
            wrapper.find('[data-testid="settings-nav-resource-agent-principals"]').exists(),
        ).toBe(true);
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
        expect(wrapper.find('[data-testid="settings-nav-resource-agent-principals"]').text()).toBe(
            "智能体主体",
        );
        // 真入口渲染成带 to 的链接（SettingsSidebar.spec 对 ops 项用的是同一条断言方式）。
        expect(
            wrapper.find('[data-testid="settings-nav-resource-agent-principals"]').attributes("to"),
        ).toBe("/settings/agent-principals");
        expect(wrapper.find('[data-testid="settings-nav-resource-my-credentials"]').text()).toBe(
            "我的凭据",
        );
        // 缺口项是不可点的一行（没有 href / 没有 to、aria-disabled），点击不走路由
        const gap = wrapper.find('[data-testid="settings-nav-resource-gap-knowledge-mcp"]');
        expect(gap.element.tagName).toBe("DIV");
        expect(gap.attributes("aria-disabled")).toBe("true");
        expect(wrapper.find('[data-testid="settings-nav-resource-knowledge-mcp"]').exists()).toBe(
            false,
        );
        wrapper.unmount();
    });

    it("does not navigate or open anything for a gap entry; explains via title + group hint", async () => {
        const wrapper = mountNav();
        pushed.mockClear();
        const gap = wrapper.find('[data-testid="settings-nav-resource-gap-knowledge-mcp"]');
        await gap.trigger("click");

        // task-156 / P0-N-09：不可点 —— 既没有弹窗，也没有 push，更没有链接。
        expect(
            document.querySelector('[data-testid="settings-gap-dialog-knowledge-mcp"]'),
        ).toBeNull();
        expect(pushed).not.toHaveBeenCalled();
        // 说明不再依赖点击：组级可见 hint + 条目 title 带缺口细节。
        expect(wrapper.find('[data-testid="settings-nav-gap-hint"]').text()).toContain(
            "灰显条目为后端缺口",
        );
        const title = gap.attributes("title") ?? "";
        expect(title).toContain("后端缺口 G1 / G3");
        expect(title).toContain("用户层没有知识库实体");
        wrapper.unmount();
    });
});
