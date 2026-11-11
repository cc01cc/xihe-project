import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ConfigLayerPanels from "../ConfigLayerPanels.vue";
import { i18n } from "../../../i18n";
import { useConfigStore } from "../../../stores/config";

/**
 * PLAN-0764 T1.6（task-150）：llm-provider 域的层分派。
 * 旧实现：实例层只有引导块（无编辑入口）；新实现：实例层渲染 LlmDefaultProfilePanel
 * （provider+model 偏好，连接留在个人/工作区层），用户层仍走 ProviderHub 连接管理。
 * 本 spec 只锁分派；面板自身行为见 LlmDefaultProfilePanel.spec.ts。
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

describe("ConfigLayerPanels llm-provider 域分派（PLAN-0764 T1.6）", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it("instance 层渲染默认偏好面板，不再是引导块/ProviderHub", async () => {
        const wrapper = await mountLlm("instance");
        expect(wrapper.findComponent(LlmDefaultPanelStub).exists()).toBe(true);
        expect(wrapper.findComponent(LlmDefaultPanelStub).props("layer")).toBe("instance");
        expect(wrapper.findComponent(ProviderHubStub).exists()).toBe(false);
        expect(wrapper.findComponent(DomainPanelStub).exists()).toBe(false);
        // 引导块及其跳转按钮仍在（连接管理入口），但不再是唯一内容。
        expect(wrapper.find("[data-testid='provider-instance-go-user']").exists()).toBe(true);
        // task-157：实例 llm-provider 页的「可编辑字段数」= 3（provider/model/连接槽位）。
        expect(wrapper.emitted("editable-count")?.at(-1)).toEqual([3]);
    });

    it("user 层仍渲染 ProviderHub(scope=USER) 连接管理，不动", async () => {
        const wrapper = await mountLlm("user");
        expect(wrapper.findComponent(ProviderHubStub).exists()).toBe(true);
        expect(wrapper.findComponent(ProviderHubStub).props("scope")).toBe("USER");
        expect(wrapper.findComponent(LlmDefaultPanelStub).exists()).toBe(false);
        // task-157：连接管理页没有行内字段 ⇒ 次量纲 M=0（不显示），不与「字段」口径混。
        expect(wrapper.emitted("editable-count")?.at(-1)).toEqual([0]);
    });
});
