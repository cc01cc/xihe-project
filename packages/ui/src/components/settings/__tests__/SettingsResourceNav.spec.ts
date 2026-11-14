import { mount } from "@vue/test-utils";
import { computed, defineComponent, h, ref } from "vue";
import { createI18n } from "vue-i18n";
import { provideSidebarContext } from "@/components/ui/sidebar/utils";

/**
 * PLAN-0772 M2：资源模块左栏（`/resources/*`，5 资源条目）。
 *
 * <p>原用例（PLAN-0752 T4.0/T4.1）锁的是「设置区左栏的两层资源组」；资源搬家后同一份组件
 * 被 `ResourcesLayout` 复用、数据源换成 `resourceGroups()`，锁的三件事不变：</p>
 * ①后端缺口项**必须留在列表里**（D7：留位标缺口，不隐藏）
 * ②缺口项**不可点**（task-156 / P0-N-09：不是 button），说明走组级 hint + title
 * ③有后端承载的项是真链接，且路径一律 `/resources/<id>`（层进 `?layer=`，不进路径段）
 */
const messages = {
    "zh-CN": {
        resources: { navGroup: "资源", nameAgents: "智能体" },
        settings: {
            ia: {
                resourceCredentials: "凭据",
                resourceMcp: "MCP 服务器",
                resourceSkills: "技能",
                resourceAgents: "平台智能体",
                resourceKnowledge: "知识库",
                // task-509（T-02）：徽标只说「暂不可用」，缺口编号不进用户可见文本。
                backendGapBadgeGeneric: "暂不可用",
                backendGapHint: "灰显条目暂不可用，悬停查看原因。",
                gapNoteKnowledge: "知识库目前只能按工作区访问：控制面没有可管理的知识库实体。",
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

import { resourceGroups } from "../../../lib/settingsIa";
import SettingsResourceNav from "../SettingsResourceNav.vue";

function mountNav() {
    // PLAN-0762 T3.1：资源组现在用 `SidebarMenuButton`（setup 里就 `useSidebar()`，
    // reka `createContext` 无 fallback）⇒ 单独挂载必须自带 context。产品里由
    // `ResourcesLayout` / `SettingsLayout` 的 vendored SidebarProvider 提供，这里复刻最小壳。
    const Host = defineComponent({
        setup() {
            const open = ref(true);
            provideSidebarContext({
                state: computed(() => (open.value ? "expanded" : "collapsed")),
                open,
                setOpen: (value: boolean) => {
                    open.value = value;
                },
                isMobile: ref(false),
                openMobile: ref(false),
                setOpenMobile: () => {},
                toggleSidebar: () => {
                    open.value = !open.value;
                },
            });
            return () =>
                h(SettingsResourceNav, {
                    groupLabelKey: "resources.navGroup",
                    items: resourceGroups(),
                });
        },
    });
    return mount(Host, {
        global: { plugins: [i18n] },
        attachTo: document.body,
    });
}

describe("SettingsResourceNav（资源模块左栏）", () => {
    it("keeps the surviving gap entry visible and badges it (D7: no hiding)", () => {
        const wrapper = mountNav();
        const gap = wrapper.find('[data-testid="settings-nav-resource-gap-knowledge"]');
        expect(gap.exists()).toBe(true);
        expect(gap.attributes("data-gap-codes")).toBe("G3");
        expect(gap.text()).toContain("知识库");
        // task-509（T-02）：徽标文案不再带缺口编号 —— 编号只留在 `data-gap-codes`（上行已钉）。
        expect(gap.text()).toContain("暂不可用");
        expect(gap.text()).not.toMatch(/\bG\d\b/);
        // 缺口项**不渲染**成真链接（`settings-nav-resource-knowledge` 必须不存在）。
        expect(wrapper.find('[data-testid="settings-nav-resource-knowledge"]').exists()).toBe(
            false,
        );
        wrapper.unmount();
    });

    it("routes the four real resources and never links the gap", () => {
        const wrapper = mountNav();
        const real = wrapper.findAll('[data-testid^="settings-nav-resource-"]').filter((node) => {
            const id = node.attributes("data-testid") ?? "";
            return (
                id !== "settings-nav-resource-group" && !id.startsWith("settings-nav-resource-gap-")
            );
        });
        expect(real.map((node) => node.attributes("data-testid"))).toEqual([
            "settings-nav-resource-credentials",
            "settings-nav-resource-mcp",
            "settings-nav-resource-skills",
            "settings-nav-resource-agents",
        ]);
        // 路径形态的判据在 `settingsIa.spec` 里（`resourceGroups()` 的 path 与 `resourcePath()` 同源）：
        // 这里只锁「哪几条是真链接」，不复制第二份路径字面量（复制就会漂）。
        expect(real.map((node) => node.text())).toEqual(["凭据", "MCP 服务器", "技能", "智能体"]);
        // task-293：组标签的条目计数与 `resourceGroups()` 实际条数一致（5 = 4 真 + 1 缺口）。
        // 稿面 S1 一直画着「资源 5」，代码此前没渲染 ⇒ 这一行钉住「稿面画的读数在页面上真的有」。
        expect(wrapper.get('[data-testid="resources-nav-count"]').text()).toBe("5");
        wrapper.unmount();
    });

    it("does not navigate or open anything for a gap entry; explains via title + group hint", async () => {
        const wrapper = mountNav();
        pushed.mockClear();
        const gap = wrapper.find('[data-testid="settings-nav-resource-gap-knowledge"]');
        await gap.trigger("click");

        // task-156 / P0-N-09：不可点 —— 既没有弹窗，也没有 push，更没有链接。
        expect(document.querySelector('[data-testid="settings-gap-dialog-knowledge"]')).toBeNull();
        expect(pushed).not.toHaveBeenCalled();
        expect(gap.element.tagName).toBe("DIV");
        expect(gap.attributes("aria-disabled")).toBe("true");
        // 说明不再依赖点击：组级可见 hint + 条目 title 带缺口细节。
        expect(wrapper.find('[data-testid="settings-nav-gap-hint"]').text()).toContain(
            "灰显条目暂不可用",
        );
        const title = gap.attributes("title") ?? "";
        // task-509（T-07）：title 是悬停可见文本 ⇒ 同样不许带内部编号与表名列名。
        expect(title).toContain("暂不可用");
        expect(title).toContain("知识库目前只能按工作区访问");
        expect(title).not.toMatch(/\bG\d\b/);
        expect(title).not.toMatch(/[a-z][a-z0-9]*_[a-z0-9_]+/);
        wrapper.unmount();
    });
});
