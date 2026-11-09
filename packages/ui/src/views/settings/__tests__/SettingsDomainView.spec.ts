import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { ref } from "vue";

/**
 * PLAN-0752 M1 的域页三分支（verify.md「入口分层」）与 V26 拦截：
 *
 * - 矩阵里没有的组合（user + logging）⇒ 404 视图，且**不挂载**面板；
 * - 层存在但无 cap:instance:admin ⇒ 403 视图，且**不发**配置请求（V4）；
 * - 实例独占域给「切到用户层」入口，点击只出提示、不跳转（V26）。
 */
const state = {
    capability: true,
    /** task-112：store 的 `layerLoading` 是 pending 的唯一事实源，测试按 ref 可控地驱动它。 */
    layerLoading: ref(false),
    loadLayerDomains: vi.fn<(layer: string) => Promise<void>>(() => Promise.resolve()),
    routeQuery: {} as Record<string, string | undefined>,
    replace: vi.fn<(arg: { query: Record<string, unknown> }) => Promise<void>>(() =>
        Promise.resolve(),
    ),
};

// 域页要读 ?tab=（approval-policy 的域内页签，T3.3）⇒ 组件测试需要 router 的两个入口。
vi.mock("vue-router", () => ({
    useRoute: () => ({ query: state.routeQuery }),
    useRouter: () => ({ replace: state.replace }),
}));

vi.mock("../../../stores/auth", () => ({
    useAuthStore: () => ({
        get hasInstanceAdminCapability() {
            return state.capability;
        },
    }),
}));

vi.mock("../../../stores/config", async () => {
    const actual =
        await vi.importActual<typeof import("../../../stores/config")>("../../../stores/config");
    return {
        ...actual,
        useConfigStore: () => ({
            layerConfig: { instance: { logging: { level: "INFO" } }, user: { rag: { k: "v" } } },
            loadLayerDomains: state.loadLayerDomains,
            get layerLoading() {
                return state.layerLoading.value;
            },
        }),
    };
});

import SettingsDomainView from "../SettingsDomainView.vue";

const messages = {
    "zh-CN": {
        settings: {
            domainLogging: "日志",
            domainRag: "检索增强（RAG）",
            domainApprovalPolicy: "审批策略",
            saveFailed: "保存失败",
            ia: {
                domainKeysCount: "本域 {count} 项配置",
                switchToUserLayer: "切到用户层",
                layerOnlyInstance: "该域仅在实例层可配置",
                layerOnlyInstanceDetail: "{domain} 不在用户层的可写域清单里",
                dismiss: "知道了",
                approvalTabPolicy: "审批策略",
                navToolFaces: "工具分类",
                forbiddenTitle: "这一层需要实例管理员能力",
                forbiddenBody: "不加载配置",
                backToUserLayer: "去用户层",
                notFoundTitle: "这个页面不存在",
                notFoundBody: "该层没有这个配置域",
                backToDefault: "回到默认页",
            },
        },
        common: { loading: "加载中…" },
    },
};

function mountView(layer: "instance" | "user", domain: string) {
    const i18n = createI18n({ legacy: false, locale: "zh-CN", messages });
    return mount(SettingsDomainView, {
        props: { layer, domain },
        global: {
            plugins: [i18n],
            stubs: {
                ConfigLayerPanels: { template: '<div data-testid="panels-stub" />' },
                ToolFacesView: { template: '<div data-testid="tool-faces-stub" />' },
                RouterLink: { template: "<a><slot /></a>" },
            },
        },
    });
}

describe("SettingsDomainView", () => {
    beforeEach(() => {
        state.capability = true;
        state.routeQuery = {};
        state.layerLoading.value = false;
        state.loadLayerDomains.mockClear();
        state.loadLayerDomains.mockImplementation(() => Promise.resolve());
        state.replace.mockClear();
    });

    // ---- T3.3：工具分类并入 approval-policy 域页签（design 决策 #7 / D2） ----
    it("offers the domain-internal tabs only on instance/approval-policy", async () => {
        const plain = mountView("instance", "rag");
        await flushPromises();
        expect(plain.find('[data-testid="settings-domain-tabs"]').exists()).toBe(false);

        const approval = mountView("instance", "approval-policy");
        await flushPromises();
        expect(approval.find('[data-testid="settings-domain-tabs"]').exists()).toBe(true);
        expect(approval.find('[data-testid="settings-domain-tab-policy"]').exists()).toBe(true);
        expect(approval.find('[data-testid="settings-domain-tab-tool-faces"]').exists()).toBe(true);
        // 默认落在策略页签：面板在、工具分类面不在
        expect(approval.find('[data-testid="panels-stub"]').exists()).toBe(true);
        expect(approval.find('[data-testid="tool-faces-stub"]').exists()).toBe(false);
    });

    it("switches to the tool-faces view and mirrors it into ?tab=", async () => {
        const wrapper = mountView("instance", "approval-policy");
        await flushPromises();
        await wrapper.find('[data-testid="settings-domain-tab-tool-faces"]').trigger("click");
        expect(wrapper.find('[data-testid="tool-faces-stub"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="panels-stub"]').exists()).toBe(false);
        expect(state.replace).toHaveBeenCalledWith({ query: { tab: "tool-faces" } });
    });

    it("opens the tool-faces tab directly when the URL carries ?tab=tool-faces (old bookmark)", async () => {
        state.routeQuery = { tab: "tool-faces" };
        const wrapper = mountView("instance", "approval-policy");
        await flushPromises();
        expect(wrapper.find('[data-testid="tool-faces-stub"]').exists()).toBe(true);
    });

    it("renders the domain panel for a valid combination", async () => {
        const wrapper = mountView("user", "rag");
        await flushPromises();
        expect(wrapper.find('[data-testid="settings-domain-view"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="settings-domain-title"]').text()).toBe(
            "检索增强（RAG）",
        );
        expect(wrapper.find('[data-testid="panels-stub"]').exists()).toBe(true);
        expect(state.loadLayerDomains).toHaveBeenCalledWith("user");
    });

    it("renders 404 for a combination the matrix does not have (user + logging)", async () => {
        const wrapper = mountView("user", "logging");
        await flushPromises();
        expect(wrapper.find('[data-testid="settings-not-found"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="panels-stub"]').exists()).toBe(false);
        expect(state.loadLayerDomains).not.toHaveBeenCalled();
    });

    it("renders 403 and loads nothing without the instance-admin capability (V4)", async () => {
        state.capability = false;
        const wrapper = mountView("instance", "logging");
        await flushPromises();
        expect(wrapper.find('[data-testid="settings-forbidden"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="panels-stub"]').exists()).toBe(false);
        expect(state.loadLayerDomains).not.toHaveBeenCalled();
    });

    it("blocks the cross-layer switch instead of navigating (V26)", async () => {
        const wrapper = mountView("instance", "logging");
        await flushPromises();
        const button = wrapper.find('[data-testid="settings-switch-layer"]');
        expect(button.exists()).toBe(true);
        expect(wrapper.find('[data-testid="settings-layer-block-notice"]').exists()).toBe(false);
        await button.trigger("click");
        const notice = wrapper.find('[data-testid="settings-layer-block-notice"]');
        expect(notice.exists()).toBe(true);
        expect(notice.text()).toContain("该域仅在实例层可配置");
    });

    it("offers no cross-layer switch for a domain the user layer can write", async () => {
        const wrapper = mountView("instance", "rag");
        await flushPromises();
        expect(wrapper.find('[data-testid="settings-switch-layer"]').exists()).toBe(false);
    });
});

/**
 * task-112：pending（还没回来）**不是**空（本域 0 项）。旧行为在 `loadLayerDomains` 挂起期间
 * 照常渲染「本域 0 项配置」+ 空表单 ⇒ 把 unknown 折成结论。三条用例分别锁：
 * ① pending ⇒ 有 loading 面、无「0 项配置」、无面板；② resolve ⇒ 正常渲染；③ 再次进入 pending（切层/重载）
 * ⇒ loading 面回来（证明消费的是 store 的 `layerLoading`，不是挂载时的一次性标志）。
 */
describe("SettingsDomainView pending state (task-112)", () => {
    it("shows the loading surface instead of 「0 项配置」 while the layer is pending", async () => {
        state.layerLoading.value = true;
        const wrapper = mountView("instance", "logging");
        await flushPromises();

        expect(wrapper.find('[data-testid="settings-domain-loading"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="settings-domain-summary"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="panels-stub"]').exists()).toBe(false);
        expect(wrapper.text()).not.toContain("本域 0 项配置");
    });

    it("renders the summary and the panel once the layer resolves", async () => {
        state.layerLoading.value = true;
        const wrapper = mountView("instance", "logging");
        await flushPromises();
        expect(wrapper.find('[data-testid="settings-domain-loading"]').exists()).toBe(true);

        state.layerLoading.value = false;
        await flushPromises();

        expect(wrapper.find('[data-testid="settings-domain-loading"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="settings-domain-summary"]').text()).toContain(
            "本域 1 项配置",
        );
        expect(wrapper.find('[data-testid="panels-stub"]').exists()).toBe(true);
    });

    it("re-enters the pending surface when the layer is reloaded (switch-layer path)", async () => {
        const wrapper = mountView("instance", "logging");
        await flushPromises();
        expect(wrapper.find('[data-testid="panels-stub"]').exists()).toBe(true);

        state.layerLoading.value = true;
        await flushPromises();

        expect(wrapper.find('[data-testid="settings-domain-loading"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="panels-stub"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="settings-domain-summary"]').exists()).toBe(false);
    });
});
