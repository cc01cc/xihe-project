import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ConfigLayerPanels from "../ConfigLayerPanels.vue";
import { i18n } from "../../../i18n";
import { useConfigStore } from "../../../stores/config";

/**
 * PLAN-0764 T1.5：embedding 域的层分派。
 * 旧实现：实例层走通用 ConfigDomainPanel（model/dimensions 两键）⇒ CP 拒收（必 400）；
 * 新实现：实例层/用户层都走 EmbeddingSettingsPanel（profile 单元）。本 spec 只锁分派，
 * panel 自身行为由 EmbeddingSettingsPanel.spec.ts 与 services/__tests__/embeddingProfile.spec.ts 覆盖。
 */
const EmbeddingPanelStub = defineComponent({
    name: "EmbeddingSettingsPanel",
    props: {
        layer: { type: String, required: true },
        saving: { type: Boolean, default: false },
        readonly: { type: Boolean, default: false },
    },
    emits: ["saved"],
    template: '<div data-testid="embedding-panel-stub" />',
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

async function mountEmbedding(layer: "instance" | "user") {
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
        props: { layer, domain: "embedding" },
        global: {
            plugins: [pinia, i18n],
            stubs: {
                EmbeddingSettingsPanel: EmbeddingPanelStub,
                ConfigDomainPanel: DomainPanelStub,
                ConfigSourceSummary: true,
            },
        },
    });
    await flushPromises();
    return wrapper;
}

describe("ConfigLayerPanels embedding 域分派（PLAN-0764 T1.5）", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it("instance 层渲染 EmbeddingSettingsPanel(layer=instance)，不再是通用表单", async () => {
        const wrapper = await mountEmbedding("instance");
        const panel = wrapper.findComponent(EmbeddingPanelStub);
        expect(panel.exists()).toBe(true);
        expect(panel.props("layer")).toBe("instance");
        expect(wrapper.findComponent(DomainPanelStub).exists()).toBe(false);
    });

    it("user 层仍渲染 EmbeddingSettingsPanel(layer=user)", async () => {
        const wrapper = await mountEmbedding("user");
        const panel = wrapper.findComponent(EmbeddingPanelStub);
        expect(panel.exists()).toBe(true);
        expect(panel.props("layer")).toBe("user");
        expect(wrapper.findComponent(DomainPanelStub).exists()).toBe(false);
    });
});
