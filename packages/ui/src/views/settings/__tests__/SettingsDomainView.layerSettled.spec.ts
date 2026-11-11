import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createPinia, setActivePinia } from "pinia";

/**
 * task-122：把 task-121 的**推理**变成测试。
 *
 * `SettingsDomainView` 的单调判据是「`layerConfig[layer]` 是否有**域键**」，不是「域里有没有值」。
 * 依据 `stores/config.ts:292-299`：`loadLayerDomains` 对每个域无条件
 * `nextLayer[domain] = body.entries ?? {}` ⇒ 9 个域即使值全空，域键仍在 ⇒ 该层已落定。
 * 所以「空配置」不能被画成「永远加载中」，而「一个域键都没有」（首屏未取数）必须还是加载中。
 *
 * 这个 spec 用**真实 store**（只 mock 传输层 `request`），否则测到的只是我自己写的桩。
 */
// vi.mock 会被提升到文件顶部 ⇒ 工厂里只能引用 hoisted 的变量（否则 TDZ 报 "Cannot access before initialization"）。
const { requestMock } = vi.hoisted(() => ({
    requestMock: vi.fn<(input: string) => Promise<unknown>>(),
}));

vi.mock("../../../composables/api", async () => {
    const actual = await vi.importActual<typeof import("../../../composables/api")>(
        "../../../composables/api",
    );
    return { ...actual, request: requestMock };
});
vi.mock("vue-router", () => ({
    useRoute: () => ({ query: {} }),
    useRouter: () => ({ replace: vi.fn<() => Promise<void>>(() => Promise.resolve()) }),
}));
vi.mock("../../../stores/auth", () => ({
    useAuthStore: () => ({ hasInstanceAdminCapability: true }),
}));

import SettingsDomainView from "../SettingsDomainView.vue";
import { LAYER_DOMAINS, useConfigStore } from "../../../stores/config";

const messages = {
    "zh-CN": {
        settings: {
            domainRag: "检索增强（RAG）",
            saveFailed: "保存失败",
            ia: {
                domainKeysCount: "本域 {count} 个配置键",
                domainEditableCount: "当前页可编辑 {count} 项",
            },
        },
        common: { loading: "加载中…" },
    },
};

function mountView() {
    const i18n = createI18n({ legacy: false, locale: "zh-CN", messages });
    return mount(SettingsDomainView, {
        props: { layer: "user", domain: "rag" },
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

/** 传输层：9 个域全部返回**空 entries**，meta 也空 —— 域键仍会建起来。 */
function respondWithEmptyDomains(): void {
    requestMock.mockImplementation((input: string) => {
        const url = new URL(input, "http://localhost");
        if (url.pathname.endsWith("/meta")) return Promise.resolve({ keys: [] });
        if (url.pathname.includes("/config/")) {
            return Promise.resolve({ domain: "rag", entries: {}, envOverridden: {} });
        }
        return Promise.resolve({});
    });
}

beforeEach(() => {
    setActivePinia(createPinia());
    requestMock.mockReset();
});

describe("SettingsDomainView 层落定判据（task-122）", () => {
    it("空值层也算落定：9 个域全空 ⇒ 不显示加载面，也不显示「0 个配置键」（C-01）", async () => {
        respondWithEmptyDomains();
        const wrapper = mountView();
        await flushPromises();

        const store = useConfigStore();
        // 前提：store 确实为**每个域**建了键（这是本次判据成立的基础，不是巧合）。
        expect(Object.keys(store.layerConfig.user)).toHaveLength(LAYER_DOMAINS.user.length);
        expect(store.layerConfig.user["rag"]).toEqual({});

        expect(wrapper.find('[data-testid="settings-domain-loading"]').exists()).toBe(false);
        // task-157 / DEV-011 §1 P0-C-01：没有键就不写「本域 0 个配置键」，更不写旧口径「0 项配置」。
        expect(wrapper.find('[data-testid="settings-domain-summary"]').exists()).toBe(false);
        expect(wrapper.text()).not.toContain("本域 0 个配置键");
        expect(wrapper.text()).not.toContain("本域 0 项配置");
        expect(wrapper.find('[data-testid="panels-stub"]').isVisible()).toBe(true);
    });

    it("首屏未取数（一个域键都没有）⇒ 仍是加载中，且面板 inert/aria-busy", async () => {
        // 永不 resolve：等价于「首屏取数还没回来」。
        requestMock.mockImplementation(() => new Promise(() => {}));
        const wrapper = mountView();
        await flushPromises();

        expect(useConfigStore().layerConfig.user).toEqual({});
        expect(wrapper.find('[data-testid="settings-domain-loading"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="settings-domain-summary"]').exists()).toBe(false);

        const panels = wrapper.find('[data-testid="settings-domain-panels"]');
        expect(panels.attributes("aria-busy")).toBe("true");
        // 加载期间面板仍在 DOM（v-show）⇒ 必须 inert：读屏与 Tab 都不该进未落定的空表单。
        expect(panels.attributes("inert")).toBeDefined();
        expect(wrapper.find('[data-testid="panels-stub"]').isVisible()).toBe(false);
    });

    it("落定后解除 inert / aria-busy，面板恢复可见", async () => {
        respondWithEmptyDomains();
        const wrapper = mountView();
        await flushPromises();

        const panels = wrapper.find('[data-testid="settings-domain-panels"]');
        expect(panels.attributes("aria-busy")).toBe("false");
        expect(panels.attributes("inert")).toBeUndefined();
        expect(wrapper.find('[data-testid="panels-stub"]').isVisible()).toBe(true);
    });
});
