import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";

/**
 * task-227「合页，不合域」的**页面级**判据：
 *
 * ① **进入页面零点击就能看到全部段落** —— 断言的是"面板子组件收到的 `domains` 清单"与
 *    "页内导航条存在"，不是"点了 tab 之后哪段可见"（用 tab 会被判据②反噬：必须额外证明切 tab
 *    不产生路由变化、不重载数据，而本页连"切"都没有）；
 * ② **页内锚点只跳位置**（原生 `#hash` 链接）⇒ 不触发路由；
 * ③ 页面**没有**"保存全部"：保存按域，由每段自己的面板发起（组页只组装，不聚合并发 PUT）；
 * ④ 段清单来自 `modelConfigDomainsForLayer` 派生（矩阵变了页面自动跟着变）。
 *
 * <p>子面板用替身：真 `ConfigLayerPanels` 会拉起 ProviderHub/模板面板等重组件与网络；本用例只要
 * 证明"组页把**这份清单**交给面板、且清单是派生的"。真面板的锚点 id 由
 * `ConfigLayerPanels.anchor.spec.ts` 钉（那里挂真组件）。</p>
 */
const state = { capability: true, atom: true },
    PanelsStub = defineComponent({
        name: "ConfigLayerPanels",
        props: {
            layer: { type: String, required: true },
            readonly: { type: Boolean, default: false },
            domain: { type: String, default: undefined },
            domains: { type: Array, default: undefined },
        },
        setup(props) {
            return { props };
        },
        template: `<div data-testid="panels-stub">
        <div v-for="d in (props.domains || [])" :key="d" :id="'settings-domain-' + d" :data-testid="'stub-domain-' + d" />
    </div>`,
    }),
    i18n = createI18n({
        legacy: false,
        locale: "zh-CN",
        messages: {
            "zh-CN": {
                settings: {
                    groupModelConfig: "模型配置",
                    groupModelConfigDesc: "三段同页",
                    groupModelConfigJump: "跳到",
                    domainLlmProvider: "LLM 提供商",
                    domainContextPolicy: "上下文策略",
                    domainContextTemplates: "请求模板",
                    // LayerPrecedenceBadges 用的四层徽标文案（夹具必须给全，否则裸 key 守卫会红）。
                    ia: {
                        fourLayerOrderLabel: "覆盖顺序",
                        fourLayerWorkspace: "工作区",
                        fourLayerWorkspaceDefault: "工作区默认",
                        fourLayerUser: "用户",
                        fourLayerInstance: "实例",
                        fourLayerLowToHigh: "低 → 高",
                        fourLayerDetail: "低层默认值被高层覆盖",
                        forbiddenTitle: "没有访问权限",
                        forbiddenBody: "当前账号不能查看这一层",
                        backToUserLayer: "回到用户层",
                    },
                },
            },
        },
    });

vi.mock("../../../components/settings/ConfigLayerPanels.vue", () => ({
    default: PanelsStub,
}));

vi.mock("../../../stores/auth", () => ({
    useAuthStore: () => ({
        get hasInstanceAdminCapability() {
            return state.capability;
        },
        hasInstanceAtom: () => state.atom,
    }),
}));

async function mountView(layer: "instance" | "user" | "workspace-default") {
    const ModelConfigView = (await import("../ModelConfigView.vue")).default;
    return mount(ModelConfigView, {
        props: { layer },
        global: { plugins: [i18n] },
    });
}

beforeEach(() => {
    state.capability = true;
    state.atom = true;
});

describe("ModelConfigView（task-227 合页不合域）", () => {
    it("实例层：零点击三段同时挂载 + 页内锚点导航", async () => {
        const wrapper = await mountView("instance");
        await flushPromises();

        expect(wrapper.find('[data-testid="settings-model-config-title"]').text()).toBe("模型配置");
        // 三段同时在 DOM 里（不是"点了才出现"）
        expect(wrapper.findAll('[data-testid^="stub-domain-"]')).toHaveLength(3);
        expect(wrapper.find("#settings-domain-llm-provider").exists()).toBe(true);
        expect(wrapper.find("#settings-domain-context-policy").exists()).toBe(true);
        expect(wrapper.find("#settings-domain-api-request-templates").exists()).toBe(true);

        // 页内锚点：三条链接，href 是纯 hash（不产生路由跳转）
        expect(wrapper.findAll('[data-testid^="settings-model-config-nav-"]')).toHaveLength(3);
        expect(
            wrapper
                .findAll('[data-testid^="settings-model-config-nav-"]')
                .map((link) => link.attributes("href")),
        ).toEqual([
            "#settings-domain-llm-provider",
            "#settings-domain-context-policy",
            "#settings-domain-api-request-templates",
        ]);

        // 没有"保存全部"（保存按域）：判据是**负数**
        expect(wrapper.find('[data-testid="settings-model-config-save-all"]').exists()).toBe(false);
    });

    it("user 层同样是三段；workspace-default 层只有矩阵里的两段（派生）", async () => {
        const user = await mountView("user"),
            wsDefault = await mountView("workspace-default");
        await flushPromises();
        expect(user.findAll('[data-testid^="stub-domain-"]')).toHaveLength(3);
        await flushPromises();
        // 组件本身仍按矩阵派生（这里直连组件、绕过路由）：矩阵里有两段就画两段。
        // 「工作区层不该有组」是**路由/导航层**政策（MODEL_CONFIG_LAYERS），在 settingsIaGroup.spec 断。
        expect(
            wsDefault
                .findAll('[data-testid^="stub-domain-"]')
                .map((node) => node.attributes("data-testid")),
        ).toEqual(["stub-domain-llm-provider", "stub-domain-context-policy"]);
    });

    it("无 cap:instance:admin ⇒ 403 视图，且不挂载面板（不请求数据）", async () => {
        state.capability = false;
        const wrapper = await mountView("instance");
        await flushPromises();
        expect(wrapper.find('[data-testid="settings-model-config-view"]').exists()).toBe(false);
        expect(wrapper.findAll('[data-testid^="stub-domain-"]')).toHaveLength(0);
    });
});
