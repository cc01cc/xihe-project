import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ConfigLayerPanels from "../ConfigLayerPanels.vue";
import { i18n } from "../../../i18n";
import { useConfigStore } from "../../../stores/config";

/**
 * task-284（D-1140）：llm-provider 域的层分派 —— 实例层与个人层挂**同一个** `ProviderHub`，
 * 只由 `layer`（写哪层配置）与 `scope`（连接归属）两个 prop 区分。
 *
 * 历史：task-150 起实例层挂的是 `LlmDefaultProfilePanel`（3 字段：provider / 连接槽位 / 模型），
 * 用户层挂 ProviderHub —— 那个「两份外观相似的实现」正是 D-1140 判定的缺陷原始形态。本 spec 锁两件事：
 * ① 两层都用 ProviderHub，且 layer/scope 逐层正确；② 旧 3 字段面板**不再**出现在任何一层。
 */
const LlmDefaultPanelStub = defineComponent({
    name: "LlmDefaultProfilePanel",
    props: {
        layer: { type: String, required: true },
        readonly: { type: Boolean, default: false },
    },
    emits: ["saved"],
    template: '<div data-testid="llm-default-panel-stub" />',
});

const ProviderHubStub = defineComponent({
    name: "ProviderHub",
    props: {
        scope: { type: String, required: true },
        layer: { type: String, default: "user" },
        readonly: { type: Boolean, default: false },
    },
    template: '<div data-testid="provider-hub-stub" />',
});

const DomainPanelStub = defineComponent({
    name: "ConfigDomainPanel",
    props: {
        domain: { type: String, required: true },
        title: { type: String, required: true },
        entries: { type: Object, required: true },
        summary: { type: String, default: "" },
        schema: { type: Array, required: true },
        envLocked: { type: Object, default: () => ({}) },
        meta: { type: Object, default: () => ({}) },
        layer: { type: String, required: true },
        readonly: { type: Boolean, default: false },
    },
    emits: ["save", "reset"],
    template: '<div data-testid="domain-panel-stub" />',
});

vi.mock("vue-sonner", () => ({
    toast: {
        success: vi.fn<(message?: unknown) => string | number>(),
        error: vi.fn<(message?: unknown) => string | number>(),
        warning: vi.fn<(message?: unknown) => string | number>(),
        info: vi.fn<(message?: unknown) => string | number>(),
    },
}));

async function mountLlm(layer: "instance" | "user") {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.includes("provider-catalog")) {
            return Promise.resolve(
                new Response(JSON.stringify({ providers: [] }), { status: 200 }),
            );
        }
        return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    });
    const pinia = createPinia();
    setActivePinia(pinia);
    const config = useConfigStore();
    vi.spyOn(config, "fetchModels").mockResolvedValue(undefined);
    vi.spyOn(config, "loadLayerDomains").mockResolvedValue(undefined);
    const wrapper = mount(ConfigLayerPanels, {
        props: { layer, domain: "llm-provider" },
        global: {
            plugins: [pinia, i18n],
            stubs: {
                LlmDefaultProfilePanel: LlmDefaultPanelStub,
                ProviderHub: ProviderHubStub,
                ConfigDomainPanel: DomainPanelStub,
                ConfigSourceSummary: true,
            },
        },
    });
    await flushPromises();
    return wrapper;
}

describe("ConfigLayerPanels llm-provider 域分派（task-284 / D-1140）", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it("instance 层渲染 ProviderHub(layer=instance, scope=INSTANCE)", async () => {
        const wrapper = await mountLlm("instance");
        expect(wrapper.findComponent(ProviderHubStub).exists()).toBe(true);
        expect(wrapper.findComponent(ProviderHubStub).props("layer")).toBe("instance");
        expect(wrapper.findComponent(ProviderHubStub).props("scope")).toBe("INSTANCE");
        // 旧 3 字段面板不再挂载（文件保留，删它另立步）。
        expect(wrapper.findComponent(LlmDefaultPanelStub).exists()).toBe(false);
        expect(wrapper.findComponent(DomainPanelStub).exists()).toBe(false);
        // 「前往个人层管理连接」入口随同构撤掉：实例层自己就有连接管理。
        expect(wrapper.find("[data-testid='provider-instance-go-user']").exists()).toBe(false);
        // task-157：连接管理页没有行内字段 ⇒ 次量纲 M=0（两层同一口径）。
        expect(wrapper.emitted("editable-count")?.at(-1)).toEqual([0]);
    });

    it("user 层渲染同一个 ProviderHub(layer=user, scope=USER)，行为不变", async () => {
        const wrapper = await mountLlm("user");
        expect(wrapper.findComponent(ProviderHubStub).exists()).toBe(true);
        expect(wrapper.findComponent(ProviderHubStub).props("layer")).toBe("user");
        expect(wrapper.findComponent(ProviderHubStub).props("scope")).toBe("USER");
        expect(wrapper.findComponent(LlmDefaultPanelStub).exists()).toBe(false);
        // task-157：连接管理页没有行内字段 ⇒ 次量纲 M=0（不显示），不与「字段」口径混。
        expect(wrapper.emitted("editable-count")?.at(-1)).toEqual([0]);
    });
});
