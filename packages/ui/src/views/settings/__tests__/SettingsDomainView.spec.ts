import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";

/**
 * PLAN-0752 M1 的域页三分支（verify.md「入口分层」）与 V26 拦截：
 *
 * - 矩阵里没有的组合（user + logging）⇒ 404 视图，且**不挂载**面板；
 * - 层存在但无 cap:instance:admin ⇒ 403 视图，且**不发**配置请求（V4）；
 * - 实例独占域给「切到用户层」入口，点击只出提示、不跳转（V26）。
 */
const state = {
    capability: true,
    loadLayerDomains: vi.fn<(layer: string) => Promise<void>>(() => Promise.resolve()),
};

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
        }),
    };
});

import SettingsDomainView from "../SettingsDomainView.vue";

const messages = {
    "zh-CN": {
        settings: {
            domainLogging: "日志",
            domainRag: "检索增强（RAG）",
            saveFailed: "保存失败",
            ia: {
                domainKeysCount: "本域 {count} 项配置",
                switchToUserLayer: "切到用户层",
                layerOnlyInstance: "该域仅在实例层可配置",
                layerOnlyInstanceDetail: "{domain} 不在用户层的可写域清单里",
                dismiss: "知道了",
                forbiddenTitle: "这一层需要实例管理员能力",
                forbiddenBody: "不加载配置",
                backToUserLayer: "去用户层",
                notFoundTitle: "这个页面不存在",
                notFoundBody: "该层没有这个配置域",
                backToDefault: "回到默认页",
            },
        },
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
                RouterLink: { template: "<a><slot /></a>" },
            },
        },
    });
}

describe("SettingsDomainView", () => {
    beforeEach(() => {
        state.capability = true;
        state.loadLayerDomains.mockClear();
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
