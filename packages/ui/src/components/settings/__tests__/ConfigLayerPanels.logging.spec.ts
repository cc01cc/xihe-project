import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ConfigLayerPanels from "../ConfigLayerPanels.vue";
import { i18n } from "../../../i18n";
import { useConfigStore } from "../../../stores/config";

/**
 * task-170 / F-11：logging 折叠态原先唯一可见内容就是 `level: INFO`（裸 key:value 转储）。
 * 摘要必须给人话（「日志级别：信息」），选择器选项也要中文名、值仍是 CP 原值。
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

async function mountLogging(level: string) {
    const pinia = createPinia();
    setActivePinia(pinia);
    const config = useConfigStore();
    config.layerConfig.instance = { logging: { logLevel: level } };
    vi.spyOn(config, "loadLayerDomains").mockResolvedValue(undefined);
    const wrapper = mount(ConfigLayerPanels, {
        props: { layer: "instance", domain: "logging" },
        global: {
            plugins: [pinia, i18n],
            stubs: { ConfigDomainPanel: DomainPanelStub, ConfigSourceSummary: true },
        },
    });
    await flushPromises();
    return wrapper;
}

describe("ConfigLayerPanels logging（F-11 折叠摘要）", () => {
    beforeEach(() => {
        localStorage.clear();
        mockFetch();
    });

    it("折叠摘要 = 中文级别名，不出现 level: INFO 这类裸转储", async () => {
        const wrapper = await mountLogging("INFO");
        const { summary } = wrapper.findComponent(DomainPanelStub).props();
        expect(summary).toBe("日志级别：信息");
        expect(wrapper.text()).not.toContain("level: INFO");
    });

    it("未知级别值原样显示（词表外的值不吞、不猜）", async () => {
        const wrapper = await mountLogging("VERBOSE");
        const { summary } = wrapper.findComponent(DomainPanelStub).props();
        expect(summary).toBe("日志级别：VERBOSE");
    });

    it("级别选择器：标签中文化，value 仍是 CP 原值", async () => {
        const wrapper = await mountLogging("INFO");
        const { schema } = wrapper.findComponent(DomainPanelStub).props();
        const field = (
            schema as Array<{ key: string; options?: Array<{ label: string; value: string }> }>
        ).find((item) => item.key === "logLevel");
        expect(field?.options?.map((option) => option.label)).toEqual([
            "跟踪",
            "调试",
            "信息",
            "警告",
            "错误",
        ]);
        expect(field?.options?.map((option) => option.value)).toEqual([
            "TRACE",
            "DEBUG",
            "INFO",
            "WARN",
            "ERROR",
        ]);
    });
});
