import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ConfigLayerPanels from "../ConfigLayerPanels.vue";
import { i18n } from "../../../i18n";
import { useConfigStore } from "../../../stores/config";
import { useSettingsStore } from "../../../stores/settings";

/**
 * task-125（D-899，方案 B）ConfigLayerPanels 的三处拦截：
 *   1. handleSave 把 user-preference.language 从 CP payload 剥离，走 settings.setLanguage；
 *   2. 剥离后 payload 为空 ⇒ 跳过 putLayerConfig（空 PUT 有清库语义风险）；
 *   3. handleReset("language") = setLanguage(DEFAULT_LOCALE)，不写 CP；
 *   以及 entriesFor 薄皮肤：面板显示的 language = settings.language（不从 CP 读）。
 *
 * ConfigDomainPanel 用桩替代：reka Select 的下拉交互 jsdom 覆盖不了
 * （AGENTS：交互行为用 Playwright 验证），本 spec 只锁父组件的拦截逻辑，
 * 桩的 props/emits 与真组件同契约（save/reset 事件 + entries 入参）。
 */

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

/** provider catalog / models / layer 域装载的最小应答。 */
function mockFetch() {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.includes("provider-catalog")) {
            return Promise.resolve(
                new Response(JSON.stringify({ providers: [] }), { status: 200 }),
            );
        }
        return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    });
}

async function mountPanels() {
    const pinia = createPinia();
    setActivePinia(pinia);
    const config = useConfigStore(),
        settings = useSettingsStore();
    const putSpy = vi.spyOn(config, "putLayerConfig").mockResolvedValue(undefined);
    vi.spyOn(config, "loadLayerDomains").mockResolvedValue(undefined);
    const wrapper = mount(ConfigLayerPanels, {
        props: { layer: "user", domain: "user-preference" },
        global: {
            plugins: [pinia, i18n],
            stubs: {
                ConfigDomainPanel: DomainPanelStub,
                ConfigSourceSummary: true,
            },
        },
    });
    await flushPromises();
    return { wrapper, config, settings, putSpy };
}

describe("ConfigLayerPanels user-preference.language（task-125 方案 B）", () => {
    beforeEach(() => {
        localStorage.clear();
        mockFetch();
    });

    it("save：language 从 CP payload 剥离并走 setLanguage，其余键照常 PUT", async () => {
        const { wrapper, settings, putSpy } = await mountPanels();
        expect(settings.language).toBe("zh-CN");

        wrapper.findComponent(DomainPanelStub).vm.$emit("save", {
            language: "en-US",
            theme: "dark",
        });
        await flushPromises();

        expect(settings.language).toBe("en-US");
        expect(i18n.global.locale.value).toBe("en-US");
        expect(localStorage.getItem("xihe-language")).toBe("en-US");
        expect(putSpy).toHaveBeenCalledTimes(1);
        const [, , body] = putSpy.mock.calls[0]!;
        expect(body).toEqual({ theme: "dark" });
        expect("language" in body).toBe(false);
    });

    it("save：剥离后 payload 为空 ⇒ 跳过 putLayerConfig（空 PUT 有清库语义风险）", async () => {
        const { wrapper, settings, putSpy } = await mountPanels();

        wrapper.findComponent(DomainPanelStub).vm.$emit("save", { language: "en-US" });
        await flushPromises();

        expect(settings.language).toBe("en-US");
        expect(putSpy).not.toHaveBeenCalled();
    });

    it("reset：language 重置 = setLanguage(DEFAULT_LOCALE)，不写 CP", async () => {
        const { wrapper, settings, putSpy } = await mountPanels();
        settings.setLanguage("en-US");

        wrapper.findComponent(DomainPanelStub).vm.$emit("reset", "language");
        await flushPromises();

        expect(settings.language).toBe("zh-CN");
        expect(putSpy).not.toHaveBeenCalled();
    });

    it("entriesFor 薄皮肤：面板显示的 language 取 settings.language，不从 CP entries", async () => {
        const { wrapper, settings } = await mountPanels();
        settings.setLanguage("en-US");
        await flushPromises();
        await wrapper.vm.$nextTick();

        const { entries } = wrapper.findComponent(DomainPanelStub).props();
        expect((entries as Record<string, string>).language).toBe("en-US");
    });
});
